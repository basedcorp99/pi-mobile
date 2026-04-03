#!/usr/bin/env bash
set -euo pipefail

# pi-mobile setup
# Installs: pi-mobile launcher to ~/.bin, optional voice model (Parakeet)
# Usage: ./setup.sh          (interactive)
#        ./setup.sh --all    (install everything including voice)
#        ./setup.sh --no-voice  (skip voice setup)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BIN_DIR="$HOME/.bin"
VOICE_FLAG=""

for arg in "$@"; do
  case "$arg" in
    --all)      VOICE_FLAG="yes" ;;
    --no-voice) VOICE_FLAG="no" ;;
  esac
done

info()  { printf '\033[1;34m→\033[0m %s\n' "$*"; }
ok()    { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m!\033[0m %s\n' "$*"; }
err()   { printf '\033[1;31m✗\033[0m %s\n' "$*"; }

APT_UPDATED=""

run_privileged() {
  if [[ "$(id -u)" -eq 0 ]]; then
    "$@"
  elif command -v sudo &>/dev/null; then
    sudo "$@"
  else
    return 127
  fi
}

install_system_packages() {
  local packages=("$@")
  [[ ${#packages[@]} -eq 0 ]] && return 0

  if command -v apt-get &>/dev/null; then
    if [[ "$(id -u)" -ne 0 ]] && ! command -v sudo &>/dev/null; then
      warn "Need sudo/root to install system packages: ${packages[*]}"
      return 1
    fi
    if [[ -z "$APT_UPDATED" ]]; then
      info "Updating apt package index..."
      run_privileged apt-get update
      APT_UPDATED=1
    fi
    info "Installing system packages: ${packages[*]}"
    run_privileged apt-get install -y "${packages[@]}"
    return 0
  fi

  if command -v brew &>/dev/null; then
    info "Installing packages with Homebrew: ${packages[*]}"
    brew install "${packages[@]}"
    return 0
  fi

  warn "No supported package manager found to install: ${packages[*]}"
  return 1
}

ensure_fuzzy_search_tools() {
  local missing=()
  command -v fzf &>/dev/null || missing+=("fzf")
  command -v zoxide &>/dev/null || missing+=("zoxide")

  if [[ ${#missing[@]} -eq 0 ]]; then
    ok "fzf found: $(fzf --version 2>/dev/null | head -n1 || echo 'installed')"
    ok "zoxide found: $(zoxide --version 2>/dev/null || echo 'installed')"
    return 0
  fi

  info "Installing fuzzy directory search tools: ${missing[*]}"
  install_system_packages "${missing[@]}" || {
    warn "Couldn't automatically install ${missing[*]} — directory search will fall back without them"
    return 1
  }

  if command -v fzf &>/dev/null; then
    ok "fzf found: $(fzf --version 2>/dev/null | head -n1 || echo 'installed')"
  else
    warn "fzf is still not in PATH"
  fi

  if command -v zoxide &>/dev/null; then
    ok "zoxide found: $(zoxide --version 2>/dev/null || echo 'installed')"
  else
    warn "zoxide is still not in PATH"
  fi
}

# ── 1. Check bun ─────────────────────────────────────────────────
if ! command -v bun &>/dev/null; then
  err "bun is required but not found. Install it: https://bun.sh"
  exit 1
fi
ok "bun found: $(bun --version)"

# ── 2. Install deps ──────────────────────────────────────────────
info "Installing dependencies..."
cd "$SCRIPT_DIR"
bun install --frozen-lockfile 2>/dev/null || bun install
ok "Dependencies installed"

# ── 3. Check for pi + pi-subagents ────────────────────────────────
check_install_global() {
  local cmd="$1" pkg="$2"
  if command -v "$cmd" &>/dev/null; then
    ok "$cmd found: $("$cmd" --version 2>/dev/null || echo 'installed')"
  else
    info "$cmd not found — installing $pkg globally..."
    npm install -g "$pkg"
    if command -v "$cmd" &>/dev/null; then
      ok "$cmd installed successfully"
    else
      warn "$cmd install may have succeeded but isn't in PATH yet — restart your shell"
    fi
  fi
}

check_install_global pi @mariozechner/pi-coding-agent
check_install_global pi-subagents pi-subagents
ensure_fuzzy_search_tools || true

# Ensure pi-ask-tool-extension is available for the custom /review extension.
ASK_EXT_ROOT="$(npm root -g 2>/dev/null || true)"
if [[ -n "$ASK_EXT_ROOT" && -d "$ASK_EXT_ROOT/pi-ask-tool-extension" ]]; then
  ok "pi-ask-tool-extension found: $ASK_EXT_ROOT/pi-ask-tool-extension"
else
  info "pi-ask-tool-extension not found — installing globally..."
  npm install -g pi-ask-tool-extension
  ASK_EXT_ROOT="$(npm root -g 2>/dev/null || true)"
  if [[ -n "$ASK_EXT_ROOT" && -d "$ASK_EXT_ROOT/pi-ask-tool-extension" ]]; then
    ok "pi-ask-tool-extension installed successfully"
  else
    warn "pi-ask-tool-extension install may have succeeded but could not be verified"
  fi
fi

# ── 4. Create ~/.bin ──────────────────────────────────────────────
mkdir -p "$BIN_DIR"

# ── 5. Install custom /review Pi extension ───────────────────────
REVIEW_EXT_SRC="$SCRIPT_DIR/pi-extension/review.ts"
REVIEW_EXT_DST="$HOME/.pi/agent/extensions/review.ts"
mkdir -p "$(dirname "$REVIEW_EXT_DST")"
if [[ -f "$REVIEW_EXT_SRC" ]]; then
  sed \
    -e "s|__PI_ASK_EXT_ROOT__|$ASK_EXT_ROOT|g" \
    -e "s|from \"pi-ask-tool-extension/src/ask-inline-ui.ts\"|from \"$ASK_EXT_ROOT/pi-ask-tool-extension/src/ask-inline-ui.ts\"|g" \
    -e "s|from \"pi-ask-tool-extension/src/ask-tabs-ui.ts\"|from \"$ASK_EXT_ROOT/pi-ask-tool-extension/src/ask-tabs-ui.ts\"|g" \
    "$REVIEW_EXT_SRC" > "$REVIEW_EXT_DST"
  ok "Installed custom /review extension → $REVIEW_EXT_DST"
else
  warn "Custom /review extension source not found at $REVIEW_EXT_SRC"
fi

# ── 6. Create pi-mobile launcher ─────────────────────────────────
cat > "$BIN_DIR/pi-mobile" << 'LAUNCHER'
#!/usr/bin/env bash
set -euo pipefail

PIMOBILE_DIR="${PIMOBILE_DIR:-__SCRIPT_DIR__}"

usage() {
  echo "Usage: pi-mobile [options]"
  echo ""
  echo "Options:"
  echo "  --host <ip>      Bind address (default: 127.0.0.1)"
  echo "  --port <port>    Port (default: 4317)"
  echo "  --token <tok>    Auth token for non-loopback"
  echo "  --help           Show this help"
  echo ""
  echo "Examples:"
  echo "  pi-mobile                              # localhost:4317"
  echo "  pi-mobile --host 0.0.0.0 --port 8080   # public"
  echo "  pi-mobile --host \$(tailscale ip -4)     # tailscale"
}

if [[ "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

cd "$PIMOBILE_DIR"
exec bun src/server.ts "$@"
LAUNCHER

# Patch in the actual directory
sed -i "s|__SCRIPT_DIR__|$SCRIPT_DIR|g" "$BIN_DIR/pi-mobile"
chmod +x "$BIN_DIR/pi-mobile"
ok "Installed pi-mobile launcher → $BIN_DIR/pi-mobile"

# ── 7. Add ~/.bin to PATH + shell hooks if needed ─────────────────
ensure_shell_line() {
  local shell_rc="$1"
  local match="$2"
  local line="$3"
  local description="$4"

  if [[ -f "$shell_rc" ]] && grep -qF "$match" "$shell_rc" 2>/dev/null; then
    return 0
  fi

  if [[ -f "$shell_rc" ]] || [[ "$shell_rc" == "$HOME/.bashrc" ]] || [[ "$shell_rc" == "$HOME/.zshrc" ]] || [[ "$shell_rc" == "$HOME/.profile" ]]; then
    echo "" >> "$shell_rc"
    echo "# pi-mobile" >> "$shell_rc"
    echo "$line" >> "$shell_rc"
    ok "Added $description to $(basename "$shell_rc")"
  fi
}

add_to_path() {
  ensure_shell_line "$1" '/.bin' 'export PATH="$HOME/.bin:$PATH"' '~/.bin to PATH'
}

add_zoxide_init() {
  local shell_rc="$1"
  local shell_name="$2"
  ensure_shell_line "$shell_rc" "zoxide init $shell_name" "eval \"\$(zoxide init $shell_name)\"" "zoxide init ($shell_name)"
}

if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
  # Detect shell and add to rc
  if [[ -n "${ZSH_VERSION:-}" ]] || [[ "$SHELL" == */zsh ]]; then
    add_to_path "$HOME/.zshrc"
  fi
  if [[ -n "${BASH_VERSION:-}" ]] || [[ "$SHELL" == */bash ]]; then
    add_to_path "$HOME/.bashrc"
  fi
  # Also add to .profile for login shells
  add_to_path "$HOME/.profile"
  export PATH="$BIN_DIR:$PATH"
  warn "Restart your shell or run: export PATH=\"\$HOME/.bin:\$PATH\""
else
  ok "~/.bin already in PATH"
fi

if command -v zoxide &>/dev/null; then
  if [[ -n "${ZSH_VERSION:-}" ]] || [[ "$SHELL" == */zsh ]]; then
    add_zoxide_init "$HOME/.zshrc" "zsh"
  fi
  if [[ -n "${BASH_VERSION:-}" ]] || [[ "$SHELL" == */bash ]]; then
    add_zoxide_init "$HOME/.bashrc" "bash"
  fi
  zoxide add "$HOME" 2>/dev/null || true
  zoxide add "$SCRIPT_DIR" 2>/dev/null || true
  ok "zoxide ready"
fi

# ── 8. Voice transcription (Parakeet) ────────────────────────────
PARAKEET_BIN="$BIN_DIR/parakeet-transcribe"
PARAKEET_MODEL_DIR="$HOME/.local/share/parakeet-tdt-0.6b-v3-int8"
PARAKEET_URL="https://blob.handy.computer/parakeet-v3-int8.tar.gz"

install_voice() {
  info "Setting up voice transcription (Parakeet)..."

  # Check python3
  if ! command -v python3 &>/dev/null; then
    err "python3 not found — voice transcription requires python3"
    return 1
  fi

  # Check/install python deps
  local missing_deps=()
  python3 -c "import numpy" 2>/dev/null || missing_deps+=("numpy")
  python3 -c "import onnxruntime" 2>/dev/null || missing_deps+=("onnxruntime")
  if [[ ${#missing_deps[@]} -gt 0 ]]; then
    info "Installing Python deps: ${missing_deps[*]}"
    python3 -m pip install --quiet --upgrade "${missing_deps[@]}" || {
      err "Failed to install Python deps. Try: pip install ${missing_deps[*]}"
      return 1
    }
  fi
  ok "Python deps ready (numpy, onnxruntime)"

  # Check ffmpeg
  if ! command -v ffmpeg &>/dev/null; then
    warn "ffmpeg not found — voice transcription needs it for audio conversion"
    warn "Install with: sudo apt-get install -y ffmpeg  (or brew install ffmpeg)"
  else
    ok "ffmpeg found"
  fi

  # Install parakeet-transcribe script
  # Copy from repo and patch MODEL_DIR to use ~/.local/share
  sed "s|MODEL_DIR = .*|MODEL_DIR = \"$PARAKEET_MODEL_DIR\"|" \
    "$SCRIPT_DIR/parakeet-transcribe" > "$PARAKEET_BIN" 2>/dev/null || {
    # If not in repo, generate it
    warn "parakeet-transcribe not found in repo, skipping script install"
    return 1
  }
  chmod +x "$PARAKEET_BIN"
  ok "Installed parakeet-transcribe → $PARAKEET_BIN"

  # Download model if needed
  if [[ -d "$PARAKEET_MODEL_DIR" ]] && [[ -f "$PARAKEET_MODEL_DIR/nemo128.onnx" ]]; then
    ok "Parakeet model already exists at $PARAKEET_MODEL_DIR"
  else
    info "Downloading Parakeet model (~640MB)..."
    mkdir -p "$HOME/.local/share"
    curl -L --progress-bar "$PARAKEET_URL" -o /tmp/parakeet-v3-int8.tar.gz
    tar -xzf /tmp/parakeet-v3-int8.tar.gz -C "$HOME/.local/share"
    rm -f /tmp/parakeet-v3-int8.tar.gz
    ok "Parakeet model installed → $PARAKEET_MODEL_DIR"
  fi

  # Validate
  local all_good=true
  while IFS= read -r f; do
    if [[ ! -f "$PARAKEET_MODEL_DIR/$f" ]]; then
      err "Missing model file: $f"
      all_good=false
    fi
  done < "$SCRIPT_DIR/PARAKEET_MODEL_FILES.txt"
  $all_good && ok "All model files present"
}

if [[ "$VOICE_FLAG" == "yes" ]]; then
  install_voice || warn "Voice setup failed — pi-mobile will work without it"
elif [[ "$VOICE_FLAG" == "no" ]]; then
  info "Skipping voice setup (--no-voice)"
else
  echo ""
  printf '\033[1m?\033[0m Install voice transcription (Parakeet, ~640MB download)? [y/N] '
  read -r answer
  if [[ "$answer" =~ ^[Yy] ]]; then
    install_voice || warn "Voice setup failed — pi-mobile will work without it"
  else
    info "Skipping voice — you can run ./setup.sh --all later"
  fi
fi

# ── 9. Summary ────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
ok "Setup complete!"
echo ""
echo "  Run:  pi-mobile"
echo "  Or:   pi-mobile --host \$(tailscale ip -4) --port 4317"
echo ""
if [[ ! -f "$PARAKEET_BIN" ]]; then
  echo "  Voice: not installed (run ./setup.sh --all to add)"
fi
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
