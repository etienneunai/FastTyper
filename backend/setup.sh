#!/usr/bin/env bash
set -e

# FastTyper backend setup: model download + llama.cpp build with Vulkan.
#
# After this, install/enable the user unit:
#   systemctl --user daemon-reload
#   systemctl --user enable --now fasttyper

# Check dependencies
for cmd in git cmake wget; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
        echo "Error: Required command '$cmd' not found. Please install it first." >&2
        exit 1
    fi
done

# 1. Download Model
echo "Downloading model..."
mkdir -p ~/.local/share/models/
model_path="$HOME/.local/share/models/dyslexic-writer-qwen3-4b-q4_k_m.gguf"
if [ ! -f "$model_path" ]; then
    wget -c -O "$model_path" "https://huggingface.co/jburnford/dyslexic-writer-qwen3-4b/resolve/main/Qwen3-4B-q4_k_m.gguf"
fi

# 2. Build llama.cpp with Vulkan (idempotent clone)
src_dir="$HOME/.local/src/llama.cpp"
mkdir -p "$HOME/.local/src"
if [ ! -d "$src_dir/.git" ]; then
    git clone --depth 1 https://github.com/ggerganov/llama.cpp.git "$src_dir"
else
    echo "llama.cpp already cloned at $src_dir. To update, pull manually or delete it."
fi
cd "$src_dir"
cmake -B build -DGGML_VULKAN=1 -DCMAKE_BUILD_TYPE=Release
cmake --build build -j "$(nproc)"

echo "Installing llama-server..."
sudo cmake --install build --prefix /usr/local
sudo ldconfig || echo "ldconfig failed, but ignoring."
echo "llama-server installed successfully to /usr/local/"
