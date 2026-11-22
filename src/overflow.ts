/**
 * Context-overflow error normalization.
 *
 * Pi recovers from an overflow only when it recognizes the failure. agy's
 * provider error text is not one of Pi's patterns, so a real context-limit
 * failure would otherwise end the session instead of compacting and retrying.
 * This rewrites ONLY provider-scoped, clearly overflow-shaped errors; rate
 * limits and transient failures are never touched, because rewriting those
 * would trigger compaction instead of Pi's retry/backoff.
 */

const OVERFLOW_PATTERNS: RegExp[] = [
  /prompt is too long/i,
  /input length and .?max_tokens.? exceed context limit/i,
  /context (?:window|length) (?:exceeded|exhausted)/i,
  /request exceeds the maximum (?:context|token)/i,
];

export const OVERFLOW_PREFIX = "context_length_exceeded";

export function isOverflowError(errorMessage: string): boolean {
  if (errorMessage.includes(OVERFLOW_PREFIX)) return false;
  return OVERFLOW_PATTERNS.some((pattern) => pattern.test(errorMessage));
}

export function rewriteOverflowMessage(
  message: {
    role?: string;
    provider?: string;
    stopReason?: string;
    errorMessage?: string;
  },
  providerId: string,
  ctxProvider?: string,
): { message: Record<string, unknown> } | undefined {
  if (message.role !== "assistant") return undefined;
  if (message.stopReason !== "error") return undefined;
  if (message.provider !== providerId && ctxProvider !== providerId) return undefined;
  const errorMessage = message.errorMessage ?? "";
  if (!isOverflowError(errorMessage)) return undefined;
  return {
    message: { ...message, errorMessage: `${OVERFLOW_PREFIX}: ${errorMessage}` },
  };
}
