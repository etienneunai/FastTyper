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
# Build in a persistent location, NOT /tmp — tmpfiles cleanup and OS updates
# wipe /tmp on a rolling distro. A launcher that resolves its shared libs from
# the build dir breaks the moment that happens (it did: Aug 2026 outage after
# `cachy update` cleared /tmp/llama.cpp/build/bin and the daemon crash-looped).
set -l src_dir ~/.local/src/llama.cpp
mkdir -p ~/.local/src
if not test -d $src_dir/.git
    echo "Cloning llama.cpp into $src_dir..."
    git clone https://github.com/ggerganov/llama.cpp.git $src_dir
else
    echo "$src_dir already exists, skipping clone."
end
cd $src_dir
cmake -B build -DGGML_VULKAN=1 -DCMAKE_BUILD_TYPE=Release
cmake --build build -j (nproc)

echo "Installing llama-server..."
# Install the binary AND its shared libraries into /usr/local instead of copying
# only the thin launcher (its code lives in the .so files). With this install the
# daemon loads its libs from /usr/local by soname and never depends on the build
# directory, so /tmp cleanups and rebuilds can't break the running service.
sudo cmake --install build --prefix /usr/local
sudo ldconfig
echo "llama-server installed successfully to /usr/local/"
