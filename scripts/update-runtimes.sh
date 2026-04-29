#!/usr/bin/env bash
# =============================================================================
# VIMS Agent Shell Runtime Updater
# -----------------------------------------------------------------------------
# Clones / pulls source for every supported agent shell, builds it, and copies
# the resulting binary into cmd/server/runtimes/binaries/{name} which is the
# canonical embedded-binary location (go:embed in embedded_runtimes.go).
#
# Supported shells (8):
#   openclaw  — Node / pnpm       github.com/openclaw/openclaw
#   zeroclaw  — Rust / cargo      github.com/zeroclaw-labs/zeroclaw
#   nanoclaw  — Node / npm        github.com/qwibitai/nanoclaw
#   nemoclaw  — Node / npm        github.com/nvidia/nemoclaw
#   mirofish  — Python / pyinst.  github.com/666ghj/MiroFish
#   picoclaw  — Go                github.com/sipeed/picoclaw
#   hermes    — Python CLI        github.com/NousResearch/hermes-agent
#   openfang  — Rust / cargo      github.com/RightNow-AI/openfang
#
# Usage:
#   scripts/update-runtimes.sh                      # update all 8
#   scripts/update-runtimes.sh --only openclaw,hermes
#   scripts/update-runtimes.sh --skip openfang
#   scripts/update-runtimes.sh --fresh              # rm -rf sources + reclone
#   scripts/update-runtimes.sh --no-build           # clone/pull only
#   scripts/update-runtimes.sh --list               # list shells and exit
#   scripts/update-runtimes.sh --dry-run            # print plan, don't execute
#
# Cross-platform targeting:
#   scripts/update-runtimes.sh --target linux-amd64         # build for one target
#   scripts/update-runtimes.sh --target darwin-arm64,darwin-amd64
#
#   Supported targets: darwin-arm64 darwin-amd64 linux-amd64 linux-arm64
#                      windows-amd64
#   Default: the build host's GOOS-GOARCH (auto-detected).
#
#   Cross-compile feasibility varies by shell:
#     - picoclaw (Go)        : cross-compiles anywhere
#     - openclaw/nemoclaw/nanoclaw (JS via bun --compile): cross-compiles
#     - zeroclaw/openfang (Rust): needs `rustup target add` + C toolchain
#     - mirofish (PyInstaller): CANNOT cross-compile; must run on target OS
#     - hermes (launcher)    : bash script on unix, .bat needed on windows
#   Script will WARN and skip shells that cannot be cross-compiled for --target;
#   use --strict to fail instead.
#
# Environment:
#   VIMS_ROOT            override repo root (default: auto-detect)
#   RUNTIME_LOG          log file (default: /tmp/vims-runtime-update.log)
#   KEEP_BAK             if set, keep *.bak-TIMESTAMP backups on --fresh
# =============================================================================
set -euo pipefail
shopt -s inherit_errexit 2>/dev/null || true

# Prevent git from blocking on interactive credential / host-key prompts.
export GIT_TERMINAL_PROMPT=0
export GIT_ASKPASS=/bin/true
export GIT_SSH_COMMAND='ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new'

# Ensure toolchain bin dirs are on PATH (cross-compile linkers, rustup/cargo,
# bun). Defensive: when invoked from non-interactive contexts (CI, other
# scripts) the shell may have a minimal PATH that omits these locations.
for p in /usr/bin /bin /usr/sbin /sbin /opt/homebrew/bin /usr/local/bin \
         "$HOME/.cargo/bin" "$HOME/.bun/bin" "$HOME/.local/bin"; do
  [[ -d "$p" && ":$PATH:" != *":$p:"* ]] && PATH="$p:$PATH"
done
export PATH

# -------- colors --------------------------------------------------------------
if [[ -t 1 ]]; then
  C_RED=$'\033[0;31m'; C_GRN=$'\033[0;32m'; C_YEL=$'\033[0;33m'
  C_BLU=$'\033[0;34m'; C_CYA=$'\033[0;36m'; C_BLD=$'\033[1m'; C_RST=$'\033[0m'
else
  C_RED=""; C_GRN=""; C_YEL=""; C_BLU=""; C_CYA=""; C_BLD=""; C_RST=""
fi

log()   { echo "${C_CYA}[$(date +%H:%M:%S)]${C_RST} $*" | tee -a "$RUNTIME_LOG"; }
info()  { echo "${C_BLU}[info]${C_RST} $*" | tee -a "$RUNTIME_LOG"; }
ok()    { echo "${C_GRN}[ ok ]${C_RST} $*" | tee -a "$RUNTIME_LOG"; }
warn()  { echo "${C_YEL}[warn]${C_RST} $*" | tee -a "$RUNTIME_LOG" >&2; }
err()   { echo "${C_RED}[FAIL]${C_RST} $*" | tee -a "$RUNTIME_LOG" >&2; }
banner(){ echo ""; echo "${C_BLD}${C_CYA}══ $* ══${C_RST}" | tee -a "$RUNTIME_LOG"; }

# -------- paths ---------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VIMS_ROOT="${VIMS_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
SRC_DIR="$VIMS_ROOT/runtimes"
# BIN_DIR_ROOT is the directory under which per-target subdirs live.
# BIN_DIR (per-target) is set once --target is resolved.
BIN_DIR_ROOT="$VIMS_ROOT/cmd/server/runtimes/binaries"
# Legacy mirror (kept in sync for tools that still read from here, host-only):
LEGACY_BIN_DIR="$VIMS_ROOT/runtimes/binaries"
RUNTIME_LOG="${RUNTIME_LOG:-/tmp/vims-runtime-update.log}"

mkdir -p "$SRC_DIR" "$BIN_DIR_ROOT" "$LEGACY_BIN_DIR"
: > "$RUNTIME_LOG"

# -------- shell registry -----------------------------------------------------
# name | repo_url | branch | build_fn | output_path_relative_to_src
REGISTRY=(
  "openclaw|https://github.com/openclaw/openclaw.git|master|build_openclaw|dist/index.js"
  "zeroclaw|https://github.com/zeroclaw-labs/zeroclaw.git|master|build_zeroclaw|target/release/zeroclaw"
  "nanoclaw|https://github.com/qwibitai/nanoclaw.git|main|build_nanoclaw|dist/index.js"
  "nemoclaw|https://github.com/nvidia/nemoclaw.git|main|build_nemoclaw|bin/nemoclaw.js"
  "mirofish|https://github.com/666ghj/MiroFish.git|main|build_mirofish|mirofish"
  "picoclaw|https://github.com/sipeed/picoclaw.git|main|build_picoclaw|picoclaw"
  "hermes|https://github.com/NousResearch/hermes-agent.git|main|build_hermes|hermes"
  "openfang|https://github.com/RightNow-AI/openfang.git|main|build_openfang|target/release/openfang"
)

ALL_NAMES=()
for entry in "${REGISTRY[@]}"; do ALL_NAMES+=("${entry%%|*}"); done

# -------- CLI flags -----------------------------------------------------------
FRESH=0
NO_BUILD=0
DRY_RUN=0
STRICT=0
ONLY=""
SKIP=""
TARGET=""

# Detect host target in GOOS-GOARCH form.
host_target() {
  local goos goarch
  case "$(uname -s)" in
    Darwin)  goos=darwin ;;
    Linux)   goos=linux ;;
    MINGW*|MSYS*|CYGWIN*) goos=windows ;;
    *)       goos="$(uname -s | tr '[:upper:]' '[:lower:]')" ;;
  esac
  case "$(uname -m)" in
    arm64|aarch64) goarch=arm64 ;;
    x86_64|amd64)  goarch=amd64 ;;
    *)             goarch="$(uname -m)" ;;
  esac
  echo "${goos}-${goarch}"
}

SUPPORTED_TARGETS=(darwin-arm64 darwin-amd64 linux-amd64 linux-arm64 windows-amd64)
is_supported_target() {
  local t="$1"
  for s in "${SUPPORTED_TARGETS[@]}"; do [[ "$s" == "$t" ]] && return 0; done
  return 1
}

usage() { sed -n '2,32p' "$0"; exit 0; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --fresh)      FRESH=1 ;;
    --no-build)   NO_BUILD=1 ;;
    --dry-run)    DRY_RUN=1 ;;
    --only)       ONLY="${2:-}"; shift ;;
    --only=*)     ONLY="${1#*=}" ;;
    --skip)       SKIP="${2:-}"; shift ;;
    --skip=*)     SKIP="${1#*=}" ;;
    --target)     TARGET="${2:-}"; shift ;;
    --target=*)   TARGET="${1#*=}" ;;
    --strict)     STRICT=1 ;;
    --list)       printf '%s\n' "${ALL_NAMES[@]}"; exit 0 ;;
    --print-shas)
      # Resolve each shell's upstream HEAD SHA via `git ls-remote` (no clone).
      # Output format: `<name>=<sha>` per line. Used by CI to build per-shell
      # cache keys so unchanged shells skip their (potentially 30+ minute)
      # rebuild on subsequent tag releases.
      for entry in "${REGISTRY[@]}"; do
        IFS='|' read -r _name _url _branch _fn _out <<< "$entry"
        # Try the configured branch; fall back to HEAD if the remote uses a
        # different default (e.g. master vs main). `awk` extracts the SHA
        # column; tail -1 picks the last match (HEAD wins over branch tip
        # only when both are listed).
        _sha="$(git ls-remote "$_url" "$_branch" 2>/dev/null | awk '{print $1}' | head -1)"
        if [[ -z "$_sha" ]]; then
          _sha="$(git ls-remote "$_url" HEAD 2>/dev/null | awk '{print $1}' | head -1)"
        fi
        if [[ -z "$_sha" ]]; then
          # Fail closed: emit a stable sentinel so the cache key changes every
          # run (forces rebuild) rather than silently caching with empty SHA.
          _sha="unresolved-$(date +%s)"
          echo "warn: could not resolve $_name@$_branch ($_url); cache will miss" >&2
        fi
        printf '%s=%s\n' "$_name" "$_sha"
      done
      exit 0
      ;;
    -h|--help)    usage ;;
    *)            err "unknown flag: $1"; usage ;;
  esac
  shift
done

# -------- tool detection ------------------------------------------------------
have() { command -v "$1" >/dev/null 2>&1; }

require_tool() {
  local tool="$1" hint="${2:-}"
  if ! have "$tool"; then
    err "missing required tool: $tool ${hint:+— $hint}"
    return 1
  fi
}

# -------- helpers -------------------------------------------------------------
should_run() {
  local name="$1"
  if [[ -n "$ONLY" ]]; then
    [[ ",${ONLY}," == *",${name},"* ]] || return 1
  fi
  if [[ -n "$SKIP" ]]; then
    [[ ",${SKIP}," == *",${name},"* ]] && return 1
  fi
  return 0
}

sync_source() {
  local name="$1" url="$2" branch="$3"
  local dir="$SRC_DIR/$name"

  if [[ "$FRESH" -eq 1 && -d "$dir" ]]; then
    local ts="$(date +%Y%m%d-%H%M%S)"
    if [[ -n "${KEEP_BAK:-}" ]]; then
      mv "$dir" "$dir.bak-$ts"
      info "backed up $dir → $dir.bak-$ts"
    else
      rm -rf "$dir"
      info "removed existing $dir (set KEEP_BAK=1 to preserve)"
    fi
  fi

  if [[ ! -d "$dir/.git" ]]; then
    if [[ -d "$dir" ]]; then
      # has files but no .git — move aside and clone fresh
      local ts="$(date +%Y%m%d-%H%M%S)"
      mv "$dir" "$dir.nogit-$ts"
      info "no .git in $dir — moved to $dir.nogit-$ts"
    fi
    info "cloning $url → $dir"
    if ! git clone --depth=50 --branch "$branch" "$url" "$dir" 2>&1 | tee -a "$RUNTIME_LOG"; then
      warn "clone with branch=$branch failed, retrying default branch"
      rm -rf "$dir"
      git clone --depth=50 "$url" "$dir" 2>&1 | tee -a "$RUNTIME_LOG"
    fi
  else
    info "updating $dir"
    # Clear stale lock files from previously-killed git operations
    rm -f "$dir/.git/index.lock" "$dir/.git"/index.stash.*.lock \
          "$dir/.git/refs/heads/*.lock" 2>/dev/null || true
    (
      cd "$dir"
      # Only stash if there are tracked+modified files (ignore untracked junk)
      if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
        warn "$name has modified tracked files — stashing"
        git stash push -m "vims-update-stash-$(date +%s)" >/dev/null || \
          warn "$name: stash failed, continuing anyway"
      fi
      # timeout prevents indefinite hangs on auth / network issues
      local git_timeout="${GIT_FETCH_TIMEOUT:-120}"
      if have timeout; then
        TIMEOUT="timeout ${git_timeout}"
      elif have gtimeout; then
        TIMEOUT="gtimeout ${git_timeout}"
      else
        TIMEOUT=""
      fi
      $TIMEOUT git fetch --depth=50 origin "$branch" 2>&1 | tee -a "$RUNTIME_LOG" || \
        warn "$name: git fetch timed out or failed"
      git checkout "$branch" 2>/dev/null || true
      $TIMEOUT git pull --ff-only origin "$branch" 2>&1 | tee -a "$RUNTIME_LOG" || \
        warn "$name: fast-forward pull failed (possible diverged history)"
    )
  fi
}

# run a command, mirror its stdout/stderr into the log, and preserve the exit
# status of the command (not the tee, which always returns 0).
run_logged() {
  # usage: run_logged <cmd> [args...]
  local status
  set -o pipefail
  { "$@" 2>&1; echo "__RC__=$?"; } | tee -a "$RUNTIME_LOG" | grep -v '^__RC__=' || true
  status="$(grep '^__RC__=' "$RUNTIME_LOG" | tail -1 | sed 's/__RC__=//')"
  [[ -n "$status" ]] && return "$status" || return 0
}

# Bundle a Node/TS entrypoint into a single self-contained binary.
# Prefers `bun build --compile` (native executable w/ embedded runtime).
# Falls back to esbuild CJS bundle + shebang if bun is unavailable.
# Args: $1=repo_dir $2=entry_file $3=output_path
bundle_node_entry() {
  local dir="$1" entry="$2" out="$3"

  if have bun; then
    local bun_target_flag=""
    # Only pass --target when cross-compiling; native bun compile picks host automatically.
    if [[ -n "${CURRENT_TARGET:-}" && "$CURRENT_TARGET" != "$HOST_TARGET" ]]; then
      local bt; bt="$(bun_target_for "$CURRENT_TARGET")" || bt=""
      [[ -n "$bt" ]] && bun_target_flag="--target=$bt"
    fi
    info "compiling $entry → $out (bun --compile ${bun_target_flag:-native})"
    (
      cd "$dir"
      # shellcheck disable=SC2086
      bun build --compile --minify --sourcemap=none $bun_target_flag \
        --outfile "$out" "$entry" 2>&1 | tee -a "$RUNTIME_LOG"
    )
    local rc="${PIPESTATUS[0]}"
    if [[ "$rc" -eq 0 && -f "$out" ]]; then
      chmod +x "$out"
      return 0
    fi
    warn "bun compile failed (rc=$rc), falling back to esbuild bundle"
  fi

  info "bundling $entry → $out (esbuild CJS)"
  (
    cd "$dir"
    npx -y esbuild "$entry" \
      --bundle \
      --platform=node \
      --target=node22 \
      --format=cjs \
      --legal-comments=none \
      --outfile="$out" 2>&1 | tee -a "$RUNTIME_LOG"
  ) || return 1
  # Strip any existing shebangs, then prepend exactly one.
  local tmp="$out.tmp.$$"
  awk 'NR==1 && /^#!/ { next } { print }' "$out" > "$tmp"
  printf '#!/usr/bin/env node\n' > "$out"
  cat "$tmp" >> "$out"
  rm -f "$tmp"
  chmod +x "$out"
}

install_binary() {
  local name="$1" src_path="$2"
  if [[ ! -f "$src_path" ]]; then
    err "$name: expected build output not found at $src_path"
    return 1
  fi
  local dest_name="$name"
  # Windows convention: .exe suffix.
  if [[ "$CURRENT_TARGET" == windows-* ]]; then
    case "$name" in
      *.exe) ;;             # already has it
      *)     dest_name="${name}.exe" ;;
    esac
  fi
  mkdir -p "$BIN_DIR"
  cp -f "$src_path" "$BIN_DIR/$dest_name"
  chmod +x "$BIN_DIR/$dest_name"
  # Mirror to legacy location ONLY when building for the host — other targets
  # would clobber host binaries the launcher expects.
  if [[ "$CURRENT_TARGET" == "$HOST_TARGET" ]]; then
    cp -f "$src_path" "$LEGACY_BIN_DIR/$name"
    chmod +x "$LEGACY_BIN_DIR/$name"
  fi
  local size; size="$(du -h "$BIN_DIR/$dest_name" | awk '{print $1}')"
  ok "$name → $BIN_DIR/$dest_name ($size)"
}

# -------- cross-compile capability matrix ------------------------------------
# Returns 0 if $shell can be built on $HOST_TARGET for $target_goos-$target_goarch.
# Returns 1 (with warn) if not supported for cross-compile.
can_build_for_target() {
  local shell="$1" target="$2"
  # Native builds are always fine.
  if [[ "$target" == "$HOST_TARGET" ]]; then return 0; fi
  case "$shell" in
    picoclaw)
      # Go cross-compiles to any target trivially.
      return 0 ;;
    nanoclaw)
      # Pure JS tsc bundle — platform-independent.
      return 0 ;;
    openclaw|nemoclaw)
      # bun --compile supports cross-targets (bun-<os>-<arch>[-musl]).
      have bun || { warn "$shell: bun required for cross-compile to $target"; return 1; }
      return 0 ;;
    hermes)
      # Launcher script is bash-only; windows needs separate .bat.
      [[ "$target" == windows-* ]] && return 1
      return 0 ;;
    zeroclaw|openfang)
      # Rust cross-compile requires `rustup target add <triple>` and a C
      # cross-linker. Check both.
      local triple; triple="$(rust_triple_for "$target")" || return 1
      local rustup_bin
      rustup_bin="$(command -v rustup || echo "$HOME/.cargo/bin/rustup")"
      if [[ ! -x "$rustup_bin" ]]; then
        warn "$shell: rustup not found (install: https://rustup.rs)"
        return 1
      fi
      if ! "$rustup_bin" target list --installed 2>/dev/null | grep -qx "$triple"; then
        warn "$shell: rust target '$triple' not installed (run: rustup target add $triple)"
        return 1
      fi
      # Check for C cross-linker per target (Apple targets don't need one).
      case "$target" in
        darwin-*) ;;  # Apple host → clang handles Apple cross targets.
        linux-amd64)
          have x86_64-linux-gnu-gcc || [[ -x /opt/homebrew/bin/x86_64-linux-gnu-gcc ]] || {
            warn "$shell: missing x86_64-linux-gnu-gcc (brew install messense/macos-cross-toolchains/x86_64-unknown-linux-gnu)"; return 1; } ;;
        linux-arm64)
          have aarch64-linux-gnu-gcc || [[ -x /opt/homebrew/bin/aarch64-linux-gnu-gcc ]] || {
            warn "$shell: missing aarch64-linux-gnu-gcc (brew install messense/macos-cross-toolchains/aarch64-unknown-linux-gnu)"; return 1; } ;;
        windows-amd64)
          have x86_64-w64-mingw32-gcc || [[ -x /opt/homebrew/bin/x86_64-w64-mingw32-gcc ]] || {
            warn "$shell: missing x86_64-w64-mingw32-gcc (brew install mingw-w64)"; return 1; } ;;
      esac
      return 0 ;;
    mirofish)
      # PyInstaller normally cannot cross-compile (it bundles the host's live
      # Python interpreter + native libs). HOWEVER, on Apple Silicon hosts we
      # can use Rosetta 2 to run an x86_64 Python under emulation, and
      # PyInstaller running under x86_64 Python produces a real darwin-amd64
      # binary. CI is responsible for installing Rosetta + x86_64 Python and
      # exporting X86_PYTHON to the path of that interpreter.
      if [[ "$HOST_TARGET" == "darwin-arm64" && "$target" == "darwin-amd64" ]]; then
        if [[ -n "${X86_PYTHON:-}" && -x "${X86_PYTHON}" ]]; then
          return 0
        fi
        warn "mirofish: darwin-arm64 → darwin-amd64 cross requires X86_PYTHON env var pointing to an x86_64 Python (install via Rosetta+x86_64 Homebrew)"
      fi
      return 1 ;;
    *)
      warn "$shell: unknown cross-compile capability"
      return 1 ;;
  esac
}

# Map GOOS-GOARCH → Rust target triple.
rust_triple_for() {
  case "$1" in
    darwin-arm64)  echo "aarch64-apple-darwin" ;;
    darwin-amd64)  echo "x86_64-apple-darwin" ;;
    linux-amd64)   echo "x86_64-unknown-linux-gnu" ;;
    linux-arm64)   echo "aarch64-unknown-linux-gnu" ;;
    windows-amd64) echo "x86_64-pc-windows-gnu" ;;
    *) return 1 ;;
  esac
}

# Map GOOS-GOARCH → bun --target flag value.
bun_target_for() {
  case "$1" in
    darwin-arm64)  echo "bun-darwin-arm64" ;;
    darwin-amd64)  echo "bun-darwin-x64" ;;
    linux-amd64)   echo "bun-linux-x64" ;;
    linux-arm64)   echo "bun-linux-arm64" ;;
    windows-amd64) echo "bun-windows-x64" ;;
    *) return 1 ;;
  esac
}

# Map GOOS-GOARCH → Go GOOS and GOARCH env vars.
go_env_for() {
  local t="$1"
  local goos="${t%-*}" goarch="${t#*-}"
  echo "GOOS=$goos GOARCH=$goarch"
}

# -------- per-shell builders --------------------------------------------------
build_openclaw() {
  local dir="$SRC_DIR/openclaw" out="$1"
  require_tool pnpm "install: npm i -g pnpm" || return 1

  # Phase 1: install. Failure here is fatal (no chance of useful output).
  ( cd "$dir" && pnpm install --frozen-lockfile=false 2>&1 ) | tee -a "$RUNTIME_LOG"
  [[ "${PIPESTATUS[0]}" -ne 0 ]] && { err "openclaw: pnpm install failed"; return 1; }

  # Phase 2: build. Tolerate non-zero exit IFF the runtime entry file exists,
  # because openclaw's `pnpm build` runs many sub-tasks (canvas:a2ui:bundle,
  # tsdown, runtime-postbuild, build-stamp, build:plugin-sdk:dts) and only the
  # first three are needed to produce dist/entry.js (the actual runtime). The
  # plugin-sdk dts emit is only used by external plugin authors and frequently
  # breaks on upstream `main` from API drift — we don't ship .d.ts so we don't
  # care. See FAIL: TS2554 on src/plugins/command-specs.ts (apr 2026).
  ( cd "$dir" && pnpm build 2>&1 ) | tee -a "$RUNTIME_LOG"
  local build_status="${PIPESTATUS[0]}"

  # dist/entry.js uses static imports of chunk-siblings — bun --compile can
  # follow these and inline into a single binary. openclaw.mjs is a thin
  # loader that uses runtime dynamic import() which bun cannot bundle.
  local entry=""
  for c in "$dir/dist/entry.js" "$dir/dist/index.js" "$dir/openclaw.mjs" "$dir/src/index.ts"; do
    [[ -f "$c" ]] && { entry="$c"; break; }
  done
  if [[ -z "$entry" ]]; then
    err "openclaw: pnpm build exited $build_status and produced no usable entry"
    return 1
  fi
  if [[ "$build_status" -ne 0 ]]; then
    warn "openclaw: pnpm build exited $build_status but $entry exists; continuing"
  fi
  bundle_node_entry "$dir" "$entry" "$dir/openclaw.bundle.mjs" || return 1
  install_binary openclaw "$dir/openclaw.bundle.mjs"
}

build_zeroclaw() {
  local dir="$SRC_DIR/zeroclaw" out="$1"
  require_tool cargo "install: https://rustup.rs" || return 1
  local target_args="" triple=""
  if [[ "$CURRENT_TARGET" != "$HOST_TARGET" ]]; then
    triple="$(rust_triple_for "$CURRENT_TARGET")" || { err "zeroclaw: unsupported target $CURRENT_TARGET"; return 1; }
    target_args="--target $triple"
  fi
  ( cd "$dir" && cargo build --release --bin zeroclaw $target_args 2>&1 ) | tee -a "$RUNTIME_LOG"
  [[ "${PIPESTATUS[0]}" -ne 0 ]] && { err "zeroclaw: cargo build failed"; return 1; }
  # Output path differs for cross targets: target/<triple>/release/zeroclaw
  local src="$dir/$out"
  if [[ -n "$triple" ]]; then
    src="$dir/target/$triple/release/zeroclaw"
    [[ "$CURRENT_TARGET" == windows-* ]] && src="$src.exe"
  fi
  install_binary zeroclaw "$src"
}

build_nanoclaw() {
  local dir="$SRC_DIR/nanoclaw" out="$1"
  require_tool npm "install: https://nodejs.org" || return 1

  # better-sqlite3 is a native Node module (.node binary). When nanoclaw
  # is compiled with `bun build --compile`, the bun virtual fs has no
  # node_modules layout, so the `bindings` package's runtime resolver
  # walks up looking for package.json and crashes:
  #   "Could not find module root given file: node_modules/bindings/bindings.js"
  # Swap to `bun:sqlite` — Bun's built-in SQLite, API-compatible with the
  # subset nanoclaw uses (Database/.prepare/.run/.get/.all/.exec/.pragma).
  # Also drop better-sqlite3 from package.json so `npm install` doesn't try
  # to compile its native binding (which is unused after the patch).
  if [[ -f "$dir/package.json" ]]; then
    info "nanoclaw: patching better-sqlite3 → bun:sqlite (native deps incompatible with bun --compile)"
    python3 - "$dir" <<'PY'
import json, os, re, sys
root = sys.argv[1]

# 1. Drop better-sqlite3 + its types from package.json so npm install doesn't
#    attempt the native compile of an unused dep.
pj_path = os.path.join(root, 'package.json')
pj = json.load(open(pj_path))
for section in ('dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'):
    if section in pj:
        for k in ('better-sqlite3', '@types/better-sqlite3'):
            pj[section].pop(k, None)
json.dump(pj, open(pj_path, 'w'), indent=2)

# 2. Walk every .ts file, rewrite the imports + namespaced types.
#    - `import Database from 'better-sqlite3'` → `import { Database } from 'bun:sqlite'`
#    - `import type Database from 'better-sqlite3'` → `import type { Database } from 'bun:sqlite'`
#    - `Database.Database` → `Database`  (better-sqlite3 used the namespace
#      pattern; bun:sqlite exports the class directly)
import_default = re.compile(r"import\s+Database\s+from\s+['\"]better-sqlite3['\"]\s*;?")
import_type    = re.compile(r"import\s+type\s+Database\s+from\s+['\"]better-sqlite3['\"]\s*;?")
ns_type        = re.compile(r"\bDatabase\.Database\b")
# .pragma('X = Y')  →  .exec('PRAGMA X = Y')
# better-sqlite3 has a typed .pragma() convenience; bun:sqlite does not.
# Match single-arg string-literal calls; multi-arg or dynamic-string calls
# are reported as warnings (none in current upstream, but future-proof).
pragma_call = re.compile(r"\.pragma\(\s*(['\"])([^'\"]+)\1\s*\)")

n_files = 0
for d, _, files in os.walk(os.path.join(root, 'src')):
    for f in files:
        if not f.endswith('.ts'):
            continue
        p = os.path.join(d, f)
        s = open(p).read()
        orig = s
        s = import_type.sub("import type { Database } from 'bun:sqlite';", s)
        s = import_default.sub("import { Database } from 'bun:sqlite';", s)
        s = ns_type.sub('Database', s)
        s = pragma_call.sub(lambda m: f".exec({m.group(1)}PRAGMA {m.group(2)}{m.group(1)})", s)
        if s != orig:
            open(p, 'w').write(s)
            n_files += 1
# Sanity-check: any unhandled .pragma( call left?
import subprocess
leftover = subprocess.run(
    ['grep', '-rn', r'\.pragma(', os.path.join(root, 'src')],
    capture_output=True, text=True,
).stdout.strip()
if leftover:
    sys.stderr.write(f"nanoclaw: WARNING — unconverted .pragma() calls remain:\n{leftover}\n")
print(f"nanoclaw: patched {n_files} TypeScript file(s)")
PY
  fi

  # Install deps (no better-sqlite3 native compile now). Skip `npm run build`
  # — we feed src/index.ts directly to bun, which handles TS natively and
  # produces a working onefile binary with bun:sqlite linked in.
  ( cd "$dir" && npm install --no-audit --no-fund --ignore-scripts 2>&1 ) \
    | tee -a "$RUNTIME_LOG"
  [[ "${PIPESTATUS[0]}" -ne 0 ]] && { err "nanoclaw: npm install failed"; return 1; }

  local entry="$dir/src/index.ts"
  [[ -f "$entry" ]] || { err "nanoclaw: src/index.ts missing"; return 1; }
  bundle_node_entry "$dir" "$entry" "$dir/nanoclaw.bundle.mjs" || return 1
  install_binary nanoclaw "$dir/nanoclaw.bundle.mjs"
}

build_nemoclaw() {
  local dir="$SRC_DIR/nemoclaw" out="$1"
  require_tool npm || return 1

  # Before tsc + bun compile, bake the package.json version into
  # src/lib/version.ts. Upstream getVersion() tries `git describe`, then
  # reads .version or package.json at runtime from `join(__dirname,'..','..')`
  # — inside a bun --compile bundle __dirname is `/$bunfs/root` which has
  # no package.json, so the fallback throws ENOENT and the CLI dies at
  # startup. Stamp the version statically so getVersion() never touches fs.
  if [[ -f "$dir/package.json" && -f "$dir/src/lib/version.ts" ]]; then
    local ver
    ver="$(python3 -c "import json,sys; print(json.load(open('$dir/package.json')).get('version','0.0.0'))" 2>/dev/null || echo 0.0.0)"
    info "nemoclaw: stamping version.ts with package.json version=$ver"
    python3 - "$dir/src/lib/version.ts" "$ver" <<'PY'
import sys, re
path, ver = sys.argv[1], sys.argv[2]
src = open(path).read()
# Replace the entire getVersion() body with a constant return. Regex matches
# `export function getVersion(opts: VersionOptions = {}): string { ... }`
pat = re.compile(
    r'export function getVersion\(opts:\s*VersionOptions\s*=\s*\{\}\):\s*string\s*\{[\s\S]*?\n\}',
    re.MULTILINE,
)
new = f'export function getVersion(_opts: VersionOptions = {{}}): string {{\n  return {ver!r};\n}}'
if not pat.search(src):
    # Not fatal — upstream may have refactored; tsc will fail noisily if so.
    sys.stderr.write('nemoclaw: getVersion() pattern not found; skipping stamp\n')
    sys.exit(0)
open(path, 'w').write(pat.sub(new, src))
PY
  fi

  # --ignore-scripts: nemoclaw's package.json `prepare` script uses bash
  # syntax (`command -v tsc`, `[ -x ... ]`) which crashes under cmd.exe on
  # Windows with `-v was unexpected at this time`. We skip lifecycle scripts
  # at install time and explicitly run build:cli ourselves below (which is
  # just `tsc -p ...` and works cross-platform).
  ( cd "$dir" && npm install --no-audit --no-fund --ignore-scripts 2>&1 && (npm run build:cli 2>&1 || npm run build 2>&1 || true) ) \
    | tee -a "$RUNTIME_LOG"
  [[ "${PIPESTATUS[0]}" -ne 0 ]] && { err "nemoclaw: npm install failed"; return 1; }
  local entry=""
  for c in "$dir/bin/nemoclaw.js" "$dir/dist/index.js" "$dir/src/index.ts"; do
    [[ -f "$c" ]] && { entry="$c"; break; }
  done
  [[ -z "$entry" ]] && { err "nemoclaw: no entry found"; return 1; }
  bundle_node_entry "$dir" "$entry" "$dir/nemoclaw.bundle.mjs" || return 1
  install_binary nemoclaw "$dir/nemoclaw.bundle.mjs"
}

build_mirofish() {
  local dir="$SRC_DIR/mirofish" out="$1"

  # Detect whether we need to run under Rosetta 2 to produce a darwin-amd64
  # binary from a darwin-arm64 host. When set, ARCH_PREFIX wraps every Python /
  # PyInstaller invocation with `arch -x86_64`, and PY_BIN points to an
  # x86_64-native Python interpreter (CI installs this; X86_PYTHON env var).
  local arch_prefix=()
  local py_bin=""
  if [[ "$HOST_TARGET" == "darwin-arm64" && "$CURRENT_TARGET" == "darwin-amd64" ]]; then
    if [[ -z "${X86_PYTHON:-}" || ! -x "${X86_PYTHON}" ]]; then
      err "mirofish: cross-build requires X86_PYTHON pointing to x86_64 python (got: '${X86_PYTHON:-unset}')"
      return 1
    fi
    arch_prefix=(arch -x86_64)
    py_bin="$X86_PYTHON"
    info "mirofish: cross-building darwin-amd64 via Rosetta 2 using $py_bin"
  else
    require_tool uv "install: curl -LsSf https://astral.sh/uv/install.sh | sh" || return 1
  fi

  # Mirofish's app/utils/locale.py loads locales/languages.json at import
  # time via the sibling `../../../locales/` directory. In a PyInstaller
  # onefile bundle, __file__ lives inside the _MEIxxxx temp extraction
  # root and the sibling path resolves outside MEIPASS — crash at startup
  # with FileNotFoundError. Patch the locale module to prefer sys._MEIPASS
  # when frozen, and pass --add-data below to bundle the locales/ tree.
  # Idempotent: only patches if the original path expression is still present.
  local locale_py="$dir/backend/app/utils/locale.py"
  if [[ -f "$locale_py" ]] && grep -q "os.path.join(os.path.dirname(__file__), '..', '..', '..', 'locales')" "$locale_py"; then
    info "mirofish: patching locale.py to use sys._MEIPASS when frozen"
    python3 - <<'PY' "$locale_py"
import sys, re
p = sys.argv[1]
s = open(p).read()
# Inject sys import + MEIPASS-aware path resolution
old = "_locales_dir = os.path.join(os.path.dirname(__file__), '..', '..', '..', 'locales')"
new = (
    "import sys as _sys  # vims-runtime: PyInstaller locales patch\n"
    "if getattr(_sys, 'frozen', False) and hasattr(_sys, '_MEIPASS'):\n"
    "    _locales_dir = os.path.join(_sys._MEIPASS, 'locales')\n"
    "else:\n"
    "    _locales_dir = os.path.join(os.path.dirname(__file__), '..', '..', '..', 'locales')"
)
assert old in s, 'locale.py original line missing — upstream changed, review patch'
open(p, 'w').write(s.replace(old, new))
PY
  fi

  # --add-data separator is ':' on POSIX, ';' on Windows. CI only runs the
  # native path on host==target, so for windows-amd64 we're on Windows Git
  # Bash where pyinstaller still prefers ';'. Detect by CURRENT_TARGET.
  local ps=":"
  [[ "$CURRENT_TARGET" == windows-* ]] && ps=";"
  local locales_data_arg=("--add-data" "../locales${ps}locales")

  (
    cd "$dir/backend"
    if [[ ${#arch_prefix[@]} -gt 0 ]]; then
      # Rosetta cross path: use plain pip + venv with the x86_64 Python so all
      # native wheel resolutions land on x86_64 darwin variants. uv has known
      # quirks under Rosetta arch-wrapping; pip is rock-solid.
      "${arch_prefix[@]}" "$py_bin" -m venv .venv-x86 2>&1 \
        || { err "mirofish: failed to create x86_64 venv"; return 1; }
      "${arch_prefix[@]}" .venv-x86/bin/pip install --upgrade pip pyinstaller 2>&1 \
        || { err "mirofish: failed to install pip+pyinstaller in x86_64 venv"; return 1; }
      if [[ -f requirements.txt ]]; then
        "${arch_prefix[@]}" .venv-x86/bin/pip install -r requirements.txt 2>&1 \
          || { err "mirofish: pip install -r requirements.txt failed (likely Python version constraint — mirofish needs <3.12 due to camel-oasis)"; return 1; }
      elif [[ -f pyproject.toml ]]; then
        "${arch_prefix[@]}" .venv-x86/bin/pip install . 2>&1 \
          || { err "mirofish: pip install . failed"; return 1; }
      fi
      if [[ -f mirofish.spec ]]; then
        "${arch_prefix[@]}" .venv-x86/bin/pyinstaller mirofish.spec --noconfirm --clean 2>&1
      else
        "${arch_prefix[@]}" .venv-x86/bin/pyinstaller run.py \
          --name mirofish \
          --onefile \
          --noconfirm \
          --clean \
          --target-arch x86_64 \
          --collect-all app \
          "${locales_data_arg[@]}" \
          --copy-metadata transformers \
          --copy-metadata torch \
          --copy-metadata tokenizers \
          --copy-metadata sentence-transformers 2>&1
      fi
    else
      # Native path (host == target): the original uv-based build.
      uv sync 2>&1
      # On linux, torch pulls in ~2-3GB of nvidia-cu12-* CUDA wheels which
      # PyInstaller's stdhooks (hook-nvidia.cublas.py, hook-nvidia.cudnn.py,
      # ...) sweep into the bundle. The resulting PKG TOC overflows the 4GB
      # 'I' struct.pack limit:
      #   struct.error: 'I' format requires 0 <= number <= 4294967295
      # mirofish is a CLI gateway shell that does not need GPU at packaging
      # time; users get GPU acceleration via their host CUDA install. Strip
      # the nvidia-* and triton wheels before bundling so the binary stays
      # under 4GB and matches the windows mirofish bundle (~350MB).
      # Install pyinstaller into the synced venv. uv 0.4+ stopped seeding
      # pip into venvs by default, so `.venv/bin/pip` no longer exists out
      # of `uv sync`. Use `uv pip install` against the active venv instead
      # (UV_PROJECT_ENVIRONMENT=.venv is the uv default for the current
      # project root). This is NOT `uv run --with pyinstaller` — that form
      # re-resolves the lockfile and reinstalls the nvidia-cu12-* wheels we
      # strip below, defeating the 4GB PKG-TOC mitigation. `uv pip install`
      # is a thin wrapper over the synced venv's site-packages.
      uv pip install --quiet pyinstaller 2>&1 \
        || { err "mirofish: uv pip install pyinstaller failed"; return 1; }
      if [[ "$CURRENT_TARGET" == linux-* ]]; then
        uv pip uninstall \
          nvidia-cublas-cu12 nvidia-cuda-cupti-cu12 nvidia-cuda-nvrtc-cu12 \
          nvidia-cuda-runtime-cu12 nvidia-cudnn-cu12 nvidia-cufft-cu12 \
          nvidia-curand-cu12 nvidia-cusolver-cu12 nvidia-cusparse-cu12 \
          nvidia-nccl-cu12 nvidia-nvjitlink-cu12 nvidia-nvtx-cu12 \
          nvidia-cusparselt-cu12 nvidia-cufile-cu12 \
          triton 2>&1 || true
        # Sanity-check: list any remaining nvidia/triton packages so the log
        # makes the cause obvious if a future torch upgrade adds new ones.
        echo "[mirofish] residual GPU wheels after strip:"
        uv pip list 2>/dev/null | grep -Ei '^(nvidia-|triton)' || echo "  (none)"
      fi
      # PyInstaller's CLI lands in the venv as `.venv/bin/pyinstaller` even
      # when installed via `uv pip` — it's a console_scripts entry that
      # always materialises to disk. Run it directly to avoid `uv run`
      # lockfile re-resolution semantics.
      local pyinst=".venv/bin/pyinstaller"
      [[ -x "$pyinst" ]] || pyinst=".venv/Scripts/pyinstaller.exe"  # windows venv layout
      [[ -x "$pyinst" ]] || { err "mirofish: pyinstaller binary missing after uv pip install"; return 1; }
      if [[ -f mirofish.spec ]]; then
        "$pyinst" mirofish.spec --noconfirm --clean 2>&1
      else
        "$pyinst" run.py \
          --name mirofish \
          --onefile \
          --noconfirm \
          --clean \
          --collect-all app \
          "${locales_data_arg[@]}" \
          --copy-metadata transformers \
          --copy-metadata torch \
          --copy-metadata tokenizers \
          --copy-metadata sentence-transformers 2>&1
      fi
    fi
    # pyinstaller --onefile puts output at dist/mirofish; --onedir at dist/mirofish/mirofish
    if [[ -f "dist/mirofish" ]]; then
      cp -f dist/mirofish "$dir/mirofish"
    elif [[ -f "dist/mirofish/mirofish" ]]; then
      cp -f dist/mirofish/mirofish "$dir/mirofish"
    fi
  ) | tee -a "$RUNTIME_LOG"
  [[ "${PIPESTATUS[0]}" -ne 0 ]] && { err "mirofish: build failed"; return 1; }
  install_binary mirofish "$dir/$out"
}

build_picoclaw() {
  local dir="$SRC_DIR/picoclaw" out="$1"
  require_tool go "install: https://go.dev/dl" || return 1
  # Cross-compile via GOOS/GOARCH; bypass Makefile in that case (Makefile uses
  # host arch only). Native builds go through Makefile for correct ldflags.
  local goos="${CURRENT_TARGET%-*}" goarch="${CURRENT_TARGET#*-}"
  local binname="picoclaw"; [[ "$CURRENT_TARGET" == windows-* ]] && binname="picoclaw.exe"
  (
    cd "$dir"
    if [[ "$CURRENT_TARGET" == "$HOST_TARGET" ]] && [[ -f Makefile ]] && grep -qE '^build:' Makefile; then
      make build 2>&1
      local produced
      produced="$(find build -maxdepth 3 -type f \( -name 'picoclaw' -o -name 'picoclaw-*' \) -perm -u+x 2>/dev/null | head -1)"
      [[ -n "$produced" ]] && cp -f "$produced" "$dir/$binname"
    else
      # Cross-compile: run `go generate` first (workspace copy) then build.
      go generate ./... 2>&1 || warn "picoclaw: go generate failed, build may fail"
      local target_dir="./cmd/picoclaw"
      [[ -d "$target_dir" ]] || target_dir="./..."
      CGO_ENABLED=0 GOOS="$goos" GOARCH="$goarch" go build \
        -tags goolm,stdjson \
        -ldflags "-s -w" \
        -o "$binname" "$target_dir" 2>&1
    fi
  ) | tee -a "$RUNTIME_LOG"
  [[ "${PIPESTATUS[0]}" -ne 0 ]] && { err "picoclaw: build failed"; return 1; }
  install_binary picoclaw "$dir/$binname"
}

build_hermes() {
  local dir="$SRC_DIR/hermes" out="$1"

  # Hermes is a Python CLI (hermes_cli.main:main entry point). We bundle it
  # into a standalone PyInstaller binary on every platform so end-users get
  # a shippable executable — no pipx or system Python required. Previously
  # this produced a bash launcher that required users to have hermes-agent
  # pipx-installed separately, which (a) nobody does post-VIMS-install,
  # and (b) doesn't run on Windows where `#!/usr/bin/env bash` is inert.

  local arch_prefix=() py_bin=""
  if [[ "$HOST_TARGET" == "darwin-arm64" && "$CURRENT_TARGET" == "darwin-amd64" ]]; then
    if [[ -z "${X86_PYTHON:-}" || ! -x "${X86_PYTHON}" ]]; then
      err "hermes: cross-build requires X86_PYTHON pointing to x86_64 python (got: '${X86_PYTHON:-unset}')"
      return 1
    fi
    arch_prefix=(arch -x86_64)
    py_bin="$X86_PYTHON"
    info "hermes: cross-building darwin-amd64 via Rosetta 2 using $py_bin"
  else
    require_tool uv "install: curl -LsSf https://astral.sh/uv/install.sh | sh" || return 1
  fi

  (
    cd "$dir"
    if [[ ${#arch_prefix[@]} -gt 0 ]]; then
      # Rosetta cross path: plain pip + venv with the x86_64 Python.
      "${arch_prefix[@]}" "$py_bin" -m venv .venv-x86 2>&1 \
        || { err "hermes: failed to create x86_64 venv"; return 1; }
      "${arch_prefix[@]}" .venv-x86/bin/pip install --upgrade pip pyinstaller 2>&1 \
        || { err "hermes: failed to install pip+pyinstaller in x86_64 venv"; return 1; }
      "${arch_prefix[@]}" .venv-x86/bin/pip install . 2>&1 \
        || { err "hermes: pip install . failed in x86_64 venv"; return 1; }
      "${arch_prefix[@]}" .venv-x86/bin/pyinstaller \
        --name hermes \
        --onefile \
        --noconfirm \
        --clean \
        --target-arch x86_64 \
        --collect-all hermes \
        --collect-all hermes_cli \
        --copy-metadata hermes-agent \
        --hidden-import hermes_cli.main \
        --paths . \
        -c hermes_cli/main.py 2>&1
    else
      # Native path: uv sync then uv pip for pyinstaller.
      uv sync 2>&1 || { err "hermes: uv sync failed"; return 1; }
      uv pip install --quiet pyinstaller 2>&1 \
        || { err "hermes: uv pip install pyinstaller failed"; return 1; }
      local pyinst=".venv/bin/pyinstaller"
      [[ -x "$pyinst" ]] || pyinst=".venv/Scripts/pyinstaller.exe"
      [[ -x "$pyinst" ]] || { err "hermes: pyinstaller binary missing after uv pip install"; return 1; }
      "$pyinst" \
        --name hermes \
        --onefile \
        --noconfirm \
        --clean \
        --collect-all hermes \
        --collect-all hermes_cli \
        --copy-metadata hermes-agent \
        --hidden-import hermes_cli.main \
        --paths . \
        -c hermes_cli/main.py 2>&1
    fi
    # onefile output: dist/hermes (or dist/hermes.exe on Windows)
    local out_name="hermes"
    [[ "$CURRENT_TARGET" == windows-* ]] && out_name="hermes.exe"
    if [[ -f "dist/$out_name" ]]; then
      cp -f "dist/$out_name" "$dir/hermes"
      chmod +x "$dir/hermes" 2>/dev/null || true
    fi
  ) | tee -a "$RUNTIME_LOG"
  [[ "${PIPESTATUS[0]}" -ne 0 ]] && { err "hermes: build failed"; return 1; }
  [[ -s "$dir/hermes" ]] || { err "hermes: no binary produced at $dir/hermes"; return 1; }
  install_binary hermes "$dir/hermes"
}

build_openfang() {
  local dir="$SRC_DIR/openfang" out="$1"
  require_tool cargo "install: https://rustup.rs" || return 1
  local target_args="" triple="" release_dir="$dir/target/release"
  if [[ "$CURRENT_TARGET" != "$HOST_TARGET" ]]; then
    triple="$(rust_triple_for "$CURRENT_TARGET")" || { err "openfang: unsupported target $CURRENT_TARGET"; return 1; }
    target_args="--target $triple"
    release_dir="$dir/target/$triple/release"
  fi
  ( cd "$dir" && cargo build --release $target_args 2>&1 ) | tee -a "$RUNTIME_LOG"
  [[ "${PIPESTATUS[0]}" -ne 0 ]] && { err "openfang: cargo build failed"; return 1; }
  local bin_name="openfang"; [[ "$CURRENT_TARGET" == windows-* ]] && bin_name="openfang.exe"
  if [[ -f "$release_dir/$bin_name" ]]; then
    install_binary openfang "$release_dir/$bin_name"
  else
    local found
    found="$(find "$release_dir" -maxdepth 1 -type f -perm -u+x \
              ! -name '*.d' ! -name '*.rlib' ! -name '*.rmeta' \
              -print 2>/dev/null | head -1)"
    if [[ -n "$found" ]]; then
      warn "openfang: no ./$bin_name — using $(basename "$found")"
      install_binary openfang "$found"
    else
      err "openfang: no release binary produced in $release_dir"
      return 1
    fi
  fi
}

# -------- orchestration -------------------------------------------------------
FAILED=()
SUCCEEDED=()
SKIPPED=()
FAILED_LOGS=()

HOST_TARGET="$(host_target)"
# Resolve target list. Default = host.
if [[ -z "$TARGET" ]]; then
  TARGETS=("$HOST_TARGET")
else
  IFS=',' read -r -a TARGETS <<< "$TARGET"
fi

# Validate all provided targets.
for t in "${TARGETS[@]}"; do
  if ! is_supported_target "$t"; then
    err "unsupported --target value: $t (supported: ${SUPPORTED_TARGETS[*]})"
    exit 2
  fi
done

banner "VIMS Runtime Update"
info "VIMS_ROOT:     $VIMS_ROOT"
info "HOST_TARGET:   $HOST_TARGET"
info "TARGETS:       ${TARGETS[*]}"
info "BIN_DIR_ROOT:  $BIN_DIR_ROOT"
info "LOG:           $RUNTIME_LOG"
info "flags:         FRESH=$FRESH NO_BUILD=$NO_BUILD DRY_RUN=$DRY_RUN STRICT=$STRICT ONLY=${ONLY:-all} SKIP=${SKIP:-none}"

for CURRENT_TARGET in "${TARGETS[@]}"; do
  banner "target: $CURRENT_TARGET"
  BIN_DIR="$BIN_DIR_ROOT/$CURRENT_TARGET"
  mkdir -p "$BIN_DIR"

  for entry in "${REGISTRY[@]}"; do
    IFS='|' read -r name url branch fn out <<< "$entry"
    if ! should_run "$name"; then
      SKIPPED+=("$name@$CURRENT_TARGET")
      continue
    fi

    if ! can_build_for_target "$name" "$CURRENT_TARGET"; then
      if [[ "$STRICT" -eq 1 ]]; then
        err "$name: cannot cross-compile for $CURRENT_TARGET (strict mode → fail)"
        FAILED+=("$name@$CURRENT_TARGET")
      else
        warn "$name: skipping (cannot cross-compile for $CURRENT_TARGET)"
        SKIPPED+=("$name@$CURRENT_TARGET")
      fi
      continue
    fi

    banner "$name → $CURRENT_TARGET"
    info "repo:   $url (branch: $branch)"
    info "build:  $fn → $out"

    if [[ "$DRY_RUN" -eq 1 ]]; then
      ok "[dry-run] would sync + build $name for $CURRENT_TARGET"
      continue
    fi

    if ! sync_source "$name" "$url" "$branch"; then
      err "$name: source sync failed"
      FAILED+=("$name@$CURRENT_TARGET")
      continue
    fi

    if [[ "$NO_BUILD" -eq 1 ]]; then
      info "$name: --no-build set, skipping build"
      continue
    fi

    # Snapshot RUNTIME_LOG line count so we can extract just THIS shell's
    # output if it fails. Without this, CI logs require scrolling through
    # hundreds of lines of every prior shell's compile output to find the
    # actual error message.
    local_log_start=$(wc -l < "$RUNTIME_LOG" 2>/dev/null || echo 0)

    if "$fn" "$out"; then
      SUCCEEDED+=("$name@$CURRENT_TARGET")
    else
      err "$name: build failed (see $RUNTIME_LOG)"
      FAILED+=("$name@$CURRENT_TARGET")

      # Persist this shell's failure tail to a per-shell file so the post-loop
      # summary section can re-emit them grouped together.
      local_fail_log="/tmp/vims-fail-${name}-${CURRENT_TARGET}.log"
      sed -n "$((local_log_start + 1)),\$p" "$RUNTIME_LOG" 2>/dev/null \
        | tail -120 > "$local_fail_log" || true
      FAILED_LOGS+=("$local_fail_log|$name|$CURRENT_TARGET")

      # Print the tail inline immediately so it lives next to the failure.
      echo ""
      echo "--- last 80 lines of $name@$CURRENT_TARGET log ---" >&2
      tail -80 "$local_fail_log" >&2
      echo "--- end of $name@$CURRENT_TARGET log ---" >&2
      echo ""
    fi
  done
done

# -------- summary -------------------------------------------------------------
banner "Summary"
[[ ${#SUCCEEDED[@]} -gt 0 ]] && ok   "succeeded: ${SUCCEEDED[*]}"
[[ ${#SKIPPED[@]}   -gt 0 ]] && info "skipped:   ${SKIPPED[*]}"
[[ ${#FAILED[@]}    -gt 0 ]] && err  "failed:    ${FAILED[*]}"

# Re-emit per-shell failure tails grouped together at the end of the run so
# CI viewers don't have to scroll through every prior shell's compile output.
if [[ ${#FAILED_LOGS[@]} -gt 0 ]]; then
  echo ""
  banner "Failure logs (last 80 lines each)"
  for entry in "${FAILED_LOGS[@]}"; do
    IFS='|' read -r logpath fname ftarget <<< "$entry"
    echo ""
    echo "═══ $fname @ $ftarget ═══"
    tail -80 "$logpath" 2>/dev/null || echo "(no log captured)"
  done
fi

echo ""
for t in "${TARGETS[@]}"; do
  info "Installed binaries for $t ($BIN_DIR_ROOT/$t):"
  ls -lh "$BIN_DIR_ROOT/$t" 2>/dev/null | tail -n +2 | awk '{printf "  %-14s %8s  %s\n", $9, $5, $6" "$7" "$8}'
done

if [[ ${#FAILED[@]} -gt 0 ]]; then
  echo ""
  err "One or more shells failed to build."
  exit 1
fi

echo ""
ok "All requested runtimes up to date."
echo ""
info "Next step: rebuild VIMS server to re-embed binaries (native host):"
echo "    cd $VIMS_ROOT && go build ./cmd/server"
echo ""
info "For cross-platform server builds:"
echo "    GOOS=linux   GOARCH=amd64 go build -o vims-server.linux-amd64   ./cmd/server"
echo "    GOOS=windows GOARCH=amd64 go build -o vims-server.windows-amd64 ./cmd/server"
