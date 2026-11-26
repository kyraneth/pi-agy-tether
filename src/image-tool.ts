import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { decode } from "jpeg-js";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { CliProcess } from "./cli-process.js";
import { appDataDir, tetherHome } from "./data-dir.js";
import { acpUsage, PROVIDER_ID, type AcpPromptResult } from "./event-bridge.js";
import { runtimeDir } from "./runtime-dir.js";

const TOOL = "generate_image";
const IMAGE_MODEL_UNVERIFIED = "Native image backend not reported by agy ACP.";
const DEFAULT_ORCHESTRATOR = "gemini-4-hydrogen";
const parameters = Type.Object({
  prompt: Type.String({ minLength: 1, description: "Describe the image or the edit to make." }),
  aspectRatio: Type.Optional(Type.Enum(["1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9"], { type: "string" })),
  // The vendor's generate_image schema accepts at most three references.
  inputImages: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 3,
    description: "Paths in this Pi session's image artifact directory (use the path returned by an earlier image call)." })),
});

type ImageParams = Static<typeof parameters>;
type FailureCode = "invalid_input" | "auth_or_consent" | "refusal" | "quota" | "no_image" | "ambiguous" | "aborted" | "transport";
class ImageFailure extends Error {
  constructor(readonly code: FailureCode, message: string) { super(message); }
}

function classify(text: string): ImageFailure | undefined {
  if (/UNAUTHENTICATED|not signed in|sign[ -]in required|requires sign[ -]in|please sign in|authentication required|agy login (not found|is not readable)|consent (?:is )?required|(?:accept|agree to).{0,90}(?:terms of (?:service|use)|user terms)/is.test(text))
    return new ImageFailure("auth_or_consent", "agy requires sign-in or consent. Complete it in the official client; the tether did not accept anything.");
  if (/quota (?:has been )?(?:exceeded|exhausted|reached)|(?:exceeded|exhausted|out of) (?:your )?(?:image |generation )?quota|rate[ -]limit (?:exceeded|reached)|too many requests/i.test(text))
    return new ImageFailure("quota", "agy reported an exhausted quota or rate limit; no retry was sent.");
  if (/refus(?:ed|al)|safety (?:policy|filter)|blocked (?:by|for) (?:the )?(?:content|safety)|\b(?:cannot|can't|unable to) (?:generate|create|edit) (?:that|this|the requested) image/i.test(text))
    return new ImageFailure("refusal", "agy refused the image request; no retry was sent.");
}

export async function imageArtifactRoot(sessionId: string): Promise<string> {
  const home = resolve(tetherHome());
  await mkdir(home, { recursive: true, mode: 0o700 });
  const parent = join(await realpath(home), "artifacts");
  const root = join(parent, createHash("sha256").update(sessionId).digest("hex"));
  for (const dir of [parent, root]) {
    try { await mkdir(dir, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (!(await lstat(dir)).isDirectory() || await realpath(dir) !== dir)
      throw new ImageFailure("invalid_input", "The image artifact directory must not traverse a symlink.");
  }
  return root;
}

/** Read one regular file without following a leaf symlink (or blocking on a FIFO). */
async function readRegular(path: string): Promise<Buffer> {
  if (!(await lstat(path)).isFile()) throw new Error("not a regular file");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile()) throw new Error("not a regular file");
    const bytes = await file.readFile();
    const after = await file.stat();
    if (before.size !== bytes.length || after.size !== before.size || after.mtimeMs !== before.mtimeMs)
      throw new Error("file changed while being read");
    return bytes;
  } finally { await file.close(); }
}

async function stageInput(root: string, work: string, input: string, index: number): Promise<string> {
  const path = resolve(root, input);
  const extension = extname(path).toLowerCase();
  if (path !== join(root, basename(path)) || ![".jpg", ".jpeg", ".png", ".webp"].includes(extension))
    throw new ImageFailure("invalid_input", "Each reference must be a JPEG, PNG or WebP directly in this Pi session's image artifact directory.");
  const target = join(work, `reference-${index}${extension}`);
  try { await writeFile(target, await readRegular(path), { flag: "wx", mode: 0o600 }); }
  catch { throw new ImageFailure("invalid_input", "An image reference was missing, unreadable, not regular, or a symlink."); }
  return target;
}

async function verifiedOutput(sessionId: string, imageName: string, root: string) {
  const parent = join(await realpath(appDataDir()), "brain");
  if (!sessionId || basename(sessionId) !== sessionId || sessionId === "." || sessionId === ".." || sessionId.includes("\\"))
    throw new Error("unsafe ACP session identifier");
  const brain = join(parent, sessionId);
  if (await realpath(brain) !== brain) throw new Error("unsafe image directory");
  const matches = (await readdir(brain)).filter(name => new RegExp(`^${imageName}_[0-9]+\\.jpe?g$`, "i").test(name));
  if (matches.length !== 1) throw new Error("expected one matching native JPEG");
  const bytes = await readRegular(join(brain, matches[0]));
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9)
    throw new Error("incomplete JPEG");
  // Decode, not just inspect headers. The decoder applies its own memory guard.
  const { width, height } = decode(bytes, { useTArray: true, tolerantDecoding: false });
  if (!(width > 0 && height > 0)) throw new Error("invalid JPEG dimensions");
  if (await realpath(root) !== root || !(await lstat(root)).isDirectory()) throw new Error("unsafe image artifact directory");
  const path = join(root, `${imageName}.jpg`);
  await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
  if (!(await readFile(path)).equals(bytes)) throw new Error("image artifact bytes failed readback");
  return { path, bytes, width, height, mimeType: "image/jpeg" as const };
}

export async function generateImage(params: ImageParams, sessionId: string, modelId: string, signal?: AbortSignal) {
  let cli: CliProcess | undefined;
  let dispatched = false;
  try {
    signal?.throwIfAborted();
    if (!params.prompt.trim()) throw new ImageFailure("invalid_input", "Image prompt must not be blank.");
    const root = await imageArtifactRoot(sessionId);
    const work = await mkdtemp(join(runtimeDir(), "image-"));
    const images = await Promise.all((params.inputImages ?? []).map((path, i) => stageInput(root, work, path, i)));
    const imageName = `pi_${randomUUID().replaceAll("-", "")}`;
    const args = { Prompt: params.prompt, ImageName: imageName,
      ...(params.aspectRatio ? { AspectRatio: params.aspectRatio } : {}),
      ...(images.length ? { ImagePaths: images } : {}) };
    const argsMatch = (tool: any): boolean => {
      const input = tool?.rawInput ?? tool?.args;
      return input?.ImageName === imageName &&
        JSON.stringify(input.ImagePaths ?? []) === JSON.stringify(images) &&
        (!params.aspectRatio || input.AspectRatio === params.aspectRatio);
    };
    cli = await CliProcess.open({
      cwd: work, modelId, tools: [], signature: "image", handoffSocket: "", signal,
      oneShot: true, nativeTool: TOOL, allowNativeArgs: argsMatch,
      preflightProblem: text => classify(text)?.message,
      systemPrompt: "You are an image-tool adapter. When given generate_image arguments, make one generate_image call using the supplied ImageName, ImagePaths and AspectRatio exactly. Do not use unlisted paths or any other tool. Do not call it again on failure. Then report briefly whether it succeeded.",
    });
    const live = cli;
    let text = "";
    let nativeFailure = "";
    let callId: string | undefined;
    let status: unknown;
    const result = await new Promise<AcpPromptResult>((done, fail) => {
      const failAndCancel = (error: Error) => { fail(error); live.cancel(); };
      const abort = () => failAndCancel(new ImageFailure("aborted", "Image request aborted; no retry was sent."));
      signal?.addEventListener("abort", abort, { once: true });
      const settle = () => signal?.removeEventListener("abort", abort);
      live.attach({
        onUpdate(update) {
          if (update?.sessionUpdate === "agent_message_chunk" && typeof update.content?.text === "string") {
            text += update.content.text;
            const problem = classify(text);
            if (problem && status !== "completed") failAndCancel(problem);
            return;
          }
          if (update?.sessionUpdate !== "tool_call" && update?.sessionUpdate !== "tool_call_update") return;
          if (update.name !== TOOL && !(callId && update.toolCallId === callId)) return;
          if ((callId && callId !== update.toolCallId) ||
            ((update.rawInput || update.args || !callId) && !argsMatch(update)) ||
            typeof update.toolCallId !== "string" || !update.toolCallId) {
            failAndCancel(new ImageFailure("ambiguous", "agy changed the image path, name, ratio or call identity. No retry was sent."));
            return;
          }
          callId = update.toolCallId;
          status = update.status ?? status;
          if (status === "failed") {
            nativeFailure = JSON.stringify(update.rawOutput ?? update.content ?? "");
            const problem = classify(nativeFailure);
            if (problem) failAndCancel(problem);
          }
        },
        onPromptResult(result) { settle(); done(result); },
        onFatal(message) { settle(); fail(new Error(message)); },
        onClose() { settle(); fail(new Error("agy exited without a terminal ACP response")); },
        onHandoffCall(call) { call.respond({ content: [{ type: "text", text: "Pi tools are disabled in this image session." }], isError: true }); },
      });
      if (signal?.aborted) { settle(); abort(); return; }
      try {
        live.sendPrompt([{ type: "text", text: `Call generate_image with these arguments: ${JSON.stringify(args)}` }]);
        dispatched = true;
      } catch (error) { settle(); fail(error); }
      // The execution closes the one-shot connection even when the promise is rejected by an update.
      live.proc.once("exit", settle);
    });
    signal?.throwIfAborted();
    if (result.stopReason !== "end_turn")
      throw classify(result.stopReason ?? "") ??
        new ImageFailure("ambiguous", "agy did not confirm completion. An image may already have been written; no retry was sent.");
    if (status !== "completed" || !callId)
      throw classify(nativeFailure || text) ?? new ImageFailure("no_image", "agy completed without a successful native image call; no retry was sent.");
    let output: Awaited<ReturnType<typeof verifiedOutput>>;
    try { output = await verifiedOutput(cli.sessionId, imageName, root); }
    catch { throw new ImageFailure("no_image", "agy reported success but no unique verified JPEG could be retained; no retry was sent."); }
    const { path, bytes, width, height, mimeType } = output;
    const info = { path, mimeType, width, height, size: bytes.length, model: cli.modelId, imageModel: null };
    return { info, image: { type: "image" as const, data: bytes.toString("base64"), mimeType }, usage: acpUsage(result.usage) };
  } catch (error) {
    if (signal?.aborted) throw new ImageFailure("aborted", "Image request aborted; no retry was sent.");
    if (error instanceof ImageFailure) throw error;
    throw classify(error instanceof Error ? error.message : String(error)) ??
      (dispatched ? new ImageFailure("ambiguous", "agy stopped without confirming the image result. It may have written a file; no retry was sent.")
        : new ImageFailure("transport", "Could not open the private agy image session; no image prompt was sent."));
  } finally {
    await cli?.retire(["image_tool_complete"]);
  }
}

export function registerImageTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "agy_generate_image",
    label: "agy image generation",
    description: "Generate an image, or edit an existing image in this session's artifact directory, with agy's native image tool. Returns a verified image and its artifact path. Do not auto-retry failed or ambiguous image calls.",
    parameters,
    async execute(_id, params, signal, _onUpdate, ctx) {
      try {
        const modelId = ctx.model?.provider === PROVIDER_ID ? ctx.model.id : DEFAULT_ORCHESTRATOR;
        const { info, image, usage } = await generateImage(params, ctx.sessionManager.getSessionId(), modelId, signal);
        const { present, ...counts } = usage;
        return {
          content: [{ type: "text" as const, text: `${JSON.stringify(info)}\n${IMAGE_MODEL_UNVERIFIED}` }, image],
          details: info,
          ...(present ? { usage: { ...counts, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } : {}),
        };
      } catch (error) {
        if (!(error instanceof ImageFailure)) throw error;
        return { isError: true, content: [{ type: "text" as const, text: `[${error.code}] ${error.message}` }], details: { code: error.code } };
      }
    },
  });
}
