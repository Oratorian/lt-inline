#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Oratorian. See LICENSE.
#
# LanguageTool + LLM self-hosted stack installer (Linux/server).
#
# Sets up a privacy-first grammar + AI-rephrase backend. EVERYTHING is fetched
# from the official upstream servers at install time on THIS machine — nothing
# is re-hosted or redistributed. LanguageTool is LGPL (see attribution below);
# the n-gram data, fastText model, llamafile runner and the LLM weights are
# downloaded from their own official sources under their own licenses.
#
# It does NOT and CANNOT enable LanguageTool's premium-only rules: those rely on
# proprietary data that is not publicly downloadable. The companion clients use
# a local LLM proofread pass to cover the confusions the free engine misses.
#
# Modes:
#   --mode docker   Run via the meyay/languagetool image using YOUR tested
#                   docker-compose.yml placed next to this script.
#   --mode native   Download the free LanguageTool build + optional n-grams +
#                   fastText and run it directly.
# Common:
#   --with-llm      Also fetch the llamafile runner + GGUF model and launch it.
#   --with-nginx    Emit an nginx reverse-proxy snippet for the stack.
#
set -euo pipefail

# ============================================================================
# CONFIG — edit these. Defaults point at official sources; pin versions here.
# ============================================================================
LT_VERSION="6.6"                 # free LanguageTool release to fetch (native mode)
LT_ZIP_URL="https://internal1.languagetool.org/snapshots/LanguageTool-latest-snapshot.zip"

# Official n-gram data index. Pick languages you actually use (each is large).
NGRAM_BASE_URL="https://languagetool.org/download/ngram-data"
NGRAM_LANGS=("en" "de")          # languages to offer for download
declare -A NGRAM_FILES=(         # official archive names per language
  [en]="ngrams-en-20150817.zip"
  [de]="ngrams-de-20150819.zip"
)

# fastText: LanguageTool needs BOTH the language-id model (lid.176.bin) AND the
# compiled `fasttext` binary. The model is an official download; the binary comes
# from a system package or, failing that, is built from the (archived but stable,
# C++11) upstream source.
FASTTEXT_MODEL_URL="https://dl.fbaipublicfiles.com/fasttext/supervised-models/lid.176.bin"
FASTTEXT_SRC_REPO="https://github.com/facebookresearch/fastText.git"

# Self-contained Mozilla llamafiles (model + runner in one executable). Both fit
# a 6 GB GPU (tested ~55 t/s on a GTX 1660 Ti); the 2B also runs acceptably on
# CPU only. Pick 4B for best quality, 2B for low-/no-GPU machines.
declare -A LLAMAFILES=(
  ["4B (Q5_K_S) - best quality, fits a 6GB GPU"]="https://huggingface.co/mozilla-ai/llamafile_0.10/resolve/main/Qwen3.5-4B-Q5_K_S.llamafile"
  ["2B (Q8_0) - smaller, runs even on CPU only"]="https://huggingface.co/mozilla-ai/llamafile_0.10/resolve/main/Qwen3.5-2B-Q8_0.llamafile"
)
LLM_PORT="6181"
# A bundled .llamafile IS the runner — no -m needed (the model is baked in).
LLM_FLAGS="--server --nobrowser --port ${LLM_PORT} -ngl 999 --temp 0.1 --top-p 0.9 --top-k 20"

# Where to install the native stack.
INSTALL_DIR="${INSTALL_DIR:-$HOME/lt-stack}"
# ============================================================================

MODE=""
WITH_LLM=0
WITH_NGINX=0
for arg in "$@"; do
  case "$arg" in
    --mode=*) MODE="${arg#*=}" ;;
    --mode) shift; MODE="${1:-}" ;;
    --with-llm) WITH_LLM=1 ;;
    --with-nginx) WITH_NGINX=1 ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \?//'; exit 0 ;;
  esac
done

say()  { printf '\033[36m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m  ✓\033[0m %s\n' "$*"; }
warn() { printf '\033[33m  ! \033[0m%s\n' "$*"; }
die()  { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

ask_yn() { # ask_yn "prompt" -> 0 if yes
  read -r -p "$1 [y/N] " a; [[ "$a" =~ ^[Yy]$ ]]
}

need() { command -v "$1" >/dev/null 2>&1 || die "missing required tool: $1"; }
have() { command -v "$1" >/dev/null 2>&1; }

# Obtain the `fasttext` BINARY (not the model): existing on PATH, else the distro
# package manager, else build from source. Echoes the resolved binary path on
# success; returns non-zero if it could not be obtained.
setup_fasttext_binary() {
  if have fasttext; then
    command -v fasttext
    return 0
  fi

  # Try the system package manager (package is called "fasttext" on the common ones).
  if have apt-get; then
    say "Installing fasttext via apt" >&2
    sudo apt-get update -qq && sudo apt-get install -y fasttext >&2 && have fasttext && { command -v fasttext; return 0; }
  elif have pacman; then
    say "Installing fasttext via pacman" >&2
    sudo pacman -Sy --noconfirm fasttext >&2 && have fasttext && { command -v fasttext; return 0; }
  elif have dnf; then
    say "Installing fasttext via dnf" >&2
    sudo dnf install -y fasttext >&2 && have fasttext && { command -v fasttext; return 0; }
  elif have zypper; then
    say "Installing fasttext via zypper" >&2
    sudo zypper install -y fasttext >&2 && have fasttext && { command -v fasttext; return 0; }
  fi

  # Build from source (archived but stable; needs git + a C++11 compiler + make).
  if have git && have make && { have g++ || have clang++; }; then
    say "Building fasttext from source ($FASTTEXT_SRC_REPO)" >&2
    local build="$INSTALL_DIR/fasttext-src"
    rm -rf "$build"
    git clone --depth 1 "$FASTTEXT_SRC_REPO" "$build" >&2 || return 1
    ( cd "$build" && make ) >&2 || return 1
    if [[ -x "$build/fasttext" ]]; then
      cp "$build/fasttext" "$INSTALL_DIR/fasttext"
      echo "$INSTALL_DIR/fasttext"
      return 0
    fi
  fi
  return 1
}

# --- mode selection ---------------------------------------------------------
if [[ -z "$MODE" ]]; then
  echo "Choose how to run LanguageTool:"
  echo "  1) docker  — meyay/languagetool image (uses your docker-compose.yml)"
  echo "  2) native  — download the free build and run it directly"
  read -r -p "Mode [1/2]: " m
  case "$m" in 1) MODE=docker ;; 2) MODE=native ;; *) die "invalid choice" ;; esac
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# --- docker mode ------------------------------------------------------------
install_docker() {
  need docker
  local compose="$SCRIPT_DIR/docker-compose.yml"
  [[ -f "$compose" ]] || die "docker-compose.yml not found next to this script ($compose). Drop your tested compose file there."
  say "Starting LanguageTool via your docker-compose.yml"
  ( cd "$SCRIPT_DIR" && docker compose up -d )
  ok "docker compose up -d completed"
}

# --- native mode ------------------------------------------------------------
install_native() {
  need curl; need unzip; need java
  mkdir -p "$INSTALL_DIR"
  cd "$INSTALL_DIR"

  say "Downloading LanguageTool ${LT_VERSION} (LGPL) from the official site"
  curl -L --fail -o lt.zip "$LT_ZIP_URL"
  unzip -q -o lt.zip && rm lt.zip
  ok "LanguageTool extracted to $INSTALL_DIR/LanguageTool-${LT_VERSION}"

  local ltdir="$INSTALL_DIR/LanguageTool-${LT_VERSION}"
  local ngram_dir="$INSTALL_DIR/ngrams"

  if ask_yn "Download n-gram confusion data? (large — several GB per language)"; then
    mkdir -p "$ngram_dir"
    for lang in "${NGRAM_LANGS[@]}"; do
      if ask_yn "  include $lang n-grams?"; then
        say "Fetching $lang n-grams from $NGRAM_BASE_URL"
        curl -L --fail -o "ng-$lang.zip" "$NGRAM_BASE_URL/${NGRAM_FILES[$lang]}"
        unzip -q -o "ng-$lang.zip" -d "$ngram_dir" && rm "ng-$lang.zip"
        ok "$lang n-grams -> $ngram_dir/$lang"
      fi
    done
  fi

  # fastText auto language detection needs BOTH the binary and the model.
  local fasttext_bin="" fasttext_model=""
  if ask_yn "Set up fastText auto language detection? (binary + ~130 MB model)"; then
    say "Resolving the fasttext binary (PATH / package manager / source build)"
    fasttext_bin="$(setup_fasttext_binary)" || die "could not obtain the fasttext binary (no package + source build failed). Install fasttext manually, or re-run and decline fastText to use LanguageTool's built-in detection."
    ok "fasttext binary -> $fasttext_bin"

    say "Fetching fastText lid.176 model (official)"
    curl -L --fail -o "$INSTALL_DIR/lid.176.bin" "$FASTTEXT_MODEL_URL"
    fasttext_model="$INSTALL_DIR/lid.176.bin"
    ok "fastText model -> $fasttext_model"
  fi

  # Write a server.properties with the tuned paths (only set what we fetched).
  local props="$ltdir/server.properties"
  : > "$props"
  [[ -d "$ngram_dir" ]] && echo "languageModel=$ngram_dir" >> "$props"
  if [[ -n "$fasttext_bin" && -n "$fasttext_model" ]]; then
    echo "fasttextBinary=$fasttext_bin" >> "$props"
    echo "fasttextModel=$fasttext_model" >> "$props"
  fi
  ok "wrote $props"

  cat <<EOF

To start LanguageTool (native):
  cd "$ltdir"
  java -Xmx4g -cp languagetool-server.jar org.languagetool.server.HTTPServer \\
       --port 8081 --allow-origin '*' --config server.properties

EOF
}

# --- LLM (optional, both modes) ---------------------------------------------
install_llm() {
  need curl
  local dir="$INSTALL_DIR/llm"; mkdir -p "$dir"; cd "$dir"

  # Let the user pick which self-contained llamafile to fetch.
  local labels=(); local i=1
  for k in "${!LLAMAFILES[@]}"; do labels+=("$k"); echo "  $i) $k"; ((i++)); done
  read -r -p "Which model? [1-${#labels[@]}]: " sel
  local label="${labels[$((sel-1))]:-}"
  [[ -n "$label" ]] || die "invalid choice"
  local url="${LLAMAFILES[$label]}"
  local out; out="$(basename "$url")"

  say "Downloading $label (model + runner, ~GB) from Mozilla's HuggingFace repo"
  curl -L --fail -o "$out" "$url"; chmod +x "$out"
  ok "llamafile -> $dir/$out"

  cat <<EOF

To start the LLM (the .llamafile IS the runner — no -m needed):
  cd "$dir"
  ./$out $LLM_FLAGS

EOF
}

# --- nginx snippet (optional) -----------------------------------------------
emit_nginx() {
  cat <<'EOF'

# --- nginx reverse-proxy snippet -------------------------------------------
# NOTE the TRAILING SLASH on proxy_pass for /llm/ — without it the upstream
# receives /llm/v1/... and 404s (the recurring NPM gotcha). Keep the slash, or
# use the explicit rewrite shown.

location /v2/ {
    proxy_pass http://127.0.0.1:8081/v2/;
}

location /llm/ {
    proxy_pass http://127.0.0.1:6181/;   # <-- trailing slash REQUIRED
    # equivalently: rewrite ^/llm/(.*)$ /$1 break;
    proxy_set_header Host $host;
}
EOF
}

# --- run --------------------------------------------------------------------
case "$MODE" in
  docker) install_docker ;;
  native) install_native ;;
  *) die "unknown mode: $MODE (use --mode docker|native)" ;;
esac
[[ "$WITH_LLM" == 1 ]] && install_llm
[[ "$WITH_NGINX" == 1 ]] && emit_nginx

cat <<'EOF'

Done.

Credits & licensing:
  LanguageTool is free software (LGPL 2.1) — https://languagetool.org
  This installer downloads it and the n-gram/fastText data from the OFFICIAL
  sources at install time; it does not redistribute them and does not unlock
  any premium-only rules. Please respect each component's license.
EOF
