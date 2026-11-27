#!/usr/bin/env bash
# Run from the source checkout. Optionally pass an existing .tgz to qualify those exact bytes.
set -euo pipefail

# npm run prepends checkout-local bins, including the pinned dev copy of Pi.
IFS=: read -ra dirs <<< "$PATH"
host_path=()
for dir in "${dirs[@]}"; do
  case "$dir" in
    */node_modules/.bin|*/node_modules/.bin/) ;;
    /*) host_path+=("$dir") ;;
  esac
done
PATH=$(IFS=:; printf '%s' "${host_path[*]}")
pi=$(command -v pi) || { printf 'Install Pi on PATH before running this smoke.\n' >&2; exit 1; }

smoke_dir=$(mktemp -d "${TMPDIR:-/tmp}/pi-smoke.XXXXXX")
smoke_dir=$(cd "$smoke_dir" && pwd -P)
printf 'Installed Pi: %s\nSmoke evidence: %s\n' "$pi" "$smoke_dir"
mkdir -p "$smoke_dir"/{user-home,config,data,cache,state,runtime,tmp,agent/npm,cwd,bin}
chmod 700 "$smoke_dir/runtime"
fixture=$(cd "$(dirname "$0")/../tests/fixtures" && pwd)/installed-acp.cjs
cp "$fixture" "$smoke_dir/bin/agy"
chmod +x "$smoke_dir/bin/agy"
mkdir -p "$smoke_dir/user-home/.gemini/antigravity-cli"
: > "$smoke_dir/user-home/.gemini/antigravity-cli/antigravity-oauth-token"
cat > "$smoke_dir/probe.ts" <<'EOF'
import { writeFileSync } from "node:fs";
export default function(pi) {
  pi.on("session_start", () => {
    writeFileSync(process.env.SMOKE_TOOLS, JSON.stringify(pi.getAllTools().map(t => t.name)));
    pi.setActiveTools([]);
  });
}
EOF
clean=(env -i "PATH=$smoke_dir/bin:$PATH" "HOME=$smoke_dir/user-home" "TMPDIR=$smoke_dir/tmp"
  "XDG_CONFIG_HOME=$smoke_dir/config" "XDG_CONFIG_DIRS=$smoke_dir/config"
  "XDG_DATA_HOME=$smoke_dir/data" "XDG_DATA_DIRS=$smoke_dir/data"
  "XDG_CACHE_HOME=$smoke_dir/cache" "XDG_STATE_HOME=$smoke_dir/state" "XDG_RUNTIME_DIR=$smoke_dir/runtime"
  "PI_CODING_AGENT_DIR=$smoke_dir/agent" "PI_CODING_AGENT_SESSION_DIR=$smoke_dir/agent/sessions"
  "npm_config_cache=${npm_config_cache:-$smoke_dir/cache}" "PI_AGY_TETHER_CLI=$smoke_dir/bin/agy"
  "SMOKE_PI_WORKSPACE=$smoke_dir/cwd" PI_OFFLINE=1 PI_TELEMETRY=0 PI_SKIP_VERSION_CHECK=1 CI=1)

if (( $# > 1 )); then
  printf 'Usage: %s [package.tgz]\n' "$0" >&2
  exit 1
elif (( $# == 1 )); then
  archive=$(cd "$(dirname "$1")" && printf '%s/%s' "$PWD" "$(basename "$1")")
else
  "${clean[@]}" npm pack --ignore-scripts --json --pack-destination "$smoke_dir" > "$smoke_dir/pack.json"
  archive="$smoke_dir/$(node -p 'require(process.argv[1])[0].filename' "$smoke_dir/pack.json")"
fi
name=$(tar -xOzf "$archive" package/package.json |
  node -p 'JSON.parse(require("node:fs").readFileSync(0, "utf8")).name')
node -p 'JSON.stringify({packages: [`npm:${process.argv[1]}`]})' "$name" > "$smoke_dir/agent/settings.json"

cd "$smoke_dir/cwd"
printf 'Pi workspace sentinel\n' > workspace.txt
# Match Pi's managed npm layout and leave Pi peer dependencies to the host loader.
"${clean[@]}" npm install --prefix "$smoke_dir/agent/npm" --omit=dev --legacy-peer-deps \
  --ignore-scripts --no-audit --no-fund "$archive"
if [[ -e "$smoke_dir/agent/npm/node_modules/@earendil-works/pi-ai" || -e "$smoke_dir/agent/npm/node_modules/typebox" ]]; then
  printf 'A local pi-ai or typebox install would hide host-loader failures.\n' >&2
  exit 1
fi
"${clean[@]}" "$pi" --version | tee "$smoke_dir/pi.version"
status=0
"${clean[@]}" "$pi" -ns -np -nc --no-mcp --no-session --list-models "$name" \
  </dev/null > "$smoke_dir/load.stdout" 2> "$smoke_dir/load.stderr" || status=$?
printf '%s\n' "$status" > "$smoke_dir/pi.exit"
tee < "$smoke_dir/load.stderr" >&2
# --list-models can exit successfully even when the requested extension failed to load.
if (( status != 0 )) || grep -q '^Error:' "$smoke_dir/load.stderr" ||
  ! awk -v name="$name" '$1 == name { found = 1; print } END { exit !found }' "$smoke_dir/load.stdout"; then
  printf 'Installed extension smoke failed for %s\n' "$name" >&2
  exit 1
fi

turn() {
  local label=$1 image=$2 native_search=$3 strict=${4:-0}
  mkdir -p "$smoke_dir/$label"
  local status=0
  "${clean[@]}" "SMOKE_TOOLS=$smoke_dir/$label/registered.json" "PI_AGY_TETHER_DUMP=$smoke_dir/$label" \
    "PI_AGY_TETHER_IMAGE_TOOL=$image" "PI_AGY_TETHER_NATIVE_SEARCH=$native_search" "PI_AGY_TETHER_STRICT=$strict" \
    "$pi" -ns -np -nc --no-mcp --no-session -e "$smoke_dir/probe.ts" \
    --model "$name/gemini-4-hydrogen" --mode json 'Installed layout smoke.' \
    </dev/null > "$smoke_dir/$label/events.jsonl" 2> "$smoke_dir/$label/stderr" || status=$?
  if [[ $strict == 0 && $status != 0 ]]; then
    tee < "$smoke_dir/$label/stderr" >&2
    return "$status"
  fi
}

turn off 0 0
turn image 1 0
turn search 0 1
turn strict 0 1 1
node - "$smoke_dir" <<'EOF'
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const base = process.argv[2];
const read = (arm, file) => readFileSync(`${base}/${arm}/${file}`, 'utf8');
const entries = (arm) => read(arm, 'events.jsonl').trim().split('\n').map(JSON.parse);
assert.deepEqual(JSON.parse(read('off', 'registered.json')).filter(name => /^agy_/.test(name)), []);
assert.deepEqual(JSON.parse(read('image', 'registered.json')).filter(name => /^agy_/.test(name)), ['agy_generate_image']);
const custom = (arm, type) => entries(arm).filter(e => e.type === 'entry_appended' && e.entry?.customType === 'pi-agy-tether:' + type);
for (const arm of ['off', 'image', 'strict']) {
  assert.equal(custom(arm, 'native-search-notice').length, 0);
  assert.equal(custom(arm, 'native-search').length, 0);
}
for (const arm of ['off', 'image']) {
  const recipe = read(arm, 'agent.md');
  assert.match(recipe, /^tools: \[\]$/m);
  assert.doesNotMatch(recipe, /search_web|read_url_content|generate_image/);
  assert(entries(arm).some(e => e.type === 'message_end' &&
    e.message?.role === 'assistant' && e.message.content.some(x => x.text === 'ACP smoke OK')));
}
assert.match(read('search', 'agent.md'), /^tools: \[search_web\]$/m);
assert.doesNotMatch(read('search', 'agent.md'), /read_url_content|generate_image/);
assert.deepEqual(custom('search', 'native-search').map(e => e.entry.data.query), ['smoke query']);
assert.equal(custom('search', 'native-search-notice').length, 1);
assert.doesNotMatch(read('search', 'events.jsonl'), /must not leak/);
assert(entries('strict').some(e => e.type === 'message_end' && e.message?.stopReason === 'error' && /strict.*native search/i.test(e.message.errorMessage)));
assert(!require('node:fs').existsSync(`${base}/strict/agent.md`));
console.log('Installed provider, private ACP workspace, image/search opt-ins and strict refusal verified.');
EOF
