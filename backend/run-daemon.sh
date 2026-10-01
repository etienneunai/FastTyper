#!/usr/bin/env bash
set -euo pipefail

# FastTyper Standalone Daemon Runner
# Loads configuration from ~/.config/fasttyper/config and /etc/fasttyper/config

PORT="${PORT:-8808}"
HOST="${HOST:-127.0.0.1}"
MODEL="${MODEL:-$HOME/.local/share/models/dyslexic-writer-qwen3-4b-q4_k_m.gguf}"
N_GPU_LAYERS="${N_GPU_LAYERS:-99}"
CTX_SIZE="${CTX_SIZE:-2048}"
THREADS="${THREADS:-4}"
EXTRA_ARGS="${EXTRA_ARGS:--cb --reasoning off}"
LLAMA_SERVER_BIN="${LLAMA_SERVER_BIN:-$HOME/.local/bin/llama-server}"

# Source system and user configuration files if present
if [ -f "/etc/fasttyper/config" ]; then
    # shellcheck disable=SC1091
    source "/etc/fasttyper/config"
fi

if [ -f "$HOME/.config/fasttyper/config" ]; then
    # shellcheck disable=SC1091
    source "$HOME/.config/fasttyper/config"
fi

# Locate llama-server binary if default or specified path is not executable
if [ ! -x "$LLAMA_SERVER_BIN" ]; then
    if [ -x "$HOME/.local/bin/llama-server" ]; then
        LLAMA_SERVER_BIN="$HOME/.local/bin/llama-server"
    elif [ -x "/usr/local/bin/llama-server" ]; then
        LLAMA_SERVER_BIN="/usr/local/bin/llama-server"
    elif command -v llama-server >/dev/null 2>&1; then
        LLAMA_SERVER_BIN="$(command -v llama-server)"
    else
        echo "Error: llama-server binary not found at $LLAMA_SERVER_BIN or in PATH." >&2
        echo "Run backend/setup.sh first to build and install llama-server." >&2
        exit 1
    fi
fi

if [ ! -f "$MODEL" ]; then
    echo "Warning: Model file not found at $MODEL" >&2
    echo "Run backend/setup.sh to download the model." >&2
fi

echo "Starting FastTyper daemon via $LLAMA_SERVER_BIN..."
echo "Model: $MODEL"
echo "Listening on http://$HOST:$PORT"

# shellcheck disable=SC2086
exec "$LLAMA_SERVER_BIN" \
    -m "$MODEL" \
    --port "$PORT" \
    --host "$HOST" \
    -ngl "$N_GPU_LAYERS" \
    -c "$CTX_SIZE" \
    --threads "$THREADS" \
    $EXTRA_ARGS
