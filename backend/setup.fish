#!/usr/bin/env fish

# FastTyper backend setup: model download + llama.cpp build with Vulkan.
#
# After this, install/enable the user unit:
#   systemctl --user daemon-reload
#   systemctl --user enable --now fasttyper

# 1. Download Model
echo "Downloading model..."
mkdir -p ~/.local/share/models/
# Purpose-built spelling/grammar correction model (Qwen3-4B fine-tune).
# Old fallback (kept on disk): qwen2.5-0.5b-instruct-q8_0.gguf
wget -nc -O ~/.local/share/models/dyslexic-writer-qwen3-4b-q4_k_m.gguf "https://huggingface.co/jburnford/dyslexic-writer-qwen3-4b/resolve/main/Qwen3-4B-q4_k_m.gguf"

# 2. Build llama.cpp with Vulkan (idempotent clone)
if not test -d /tmp/llama.cpp
    echo "Cloning llama.cpp..."
    git clone https://github.com/ggerganov/llama.cpp.git /tmp/llama.cpp
else
    echo "/tmp/llama.cpp already exists, skipping clone."
end
cd /tmp/llama.cpp
cmake -B build -DGGML_VULKAN=1 -DCMAKE_BUILD_TYPE=Release
cmake --build build -j (nproc)

echo "Installing llama-server..."
# Install the binary AND its shared libraries into /usr/local instead of copying
# only the thin launcher (which loads its real code from /tmp/llama.cpp/build/bin —
# an ephemeral path). Refresh the linker cache so the libs are found by soname.
sudo cmake --install build --prefix /usr/local
sudo ldconfig
echo "llama-server installed successfully to /usr/local/"
