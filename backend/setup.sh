#!/usr/bin/env bash
set -euo pipefail

# FastTyper backend setup: model download + llama.cpp build with Vulkan/CUDA/CPU.
#
# Usage:
#   ./backend/setup.sh [4b|1.7b]
#
# Environment overrides:
#   BACKEND=vulkan|cuda|cpu   (Default: auto-detect)
#   PREFIX=$HOME/.local       (Default: ~/.local, rootless)
#   LLAMA_TAG=b3800           (Default: b3800 stable tag)

PREFIX="${PREFIX:-$HOME/.local}"
LLAMA_TAG="${LLAMA_TAG:-b3800}"
MODEL_CHOICE="${1:-${MODEL_CHOICE:-4b}}"

# 1. Dependency Validation
missing_deps=()
for cmd in git cmake; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
        missing_deps+=("$cmd")
    fi
done

if ! command -v g++ >/dev/null 2>&1 && ! command -v clang++ >/dev/null 2>&1; then
    missing_deps+=("g++ or clang++")
fi

if ! command -v ninja >/dev/null 2>&1 && ! command -v make >/dev/null 2>&1; then
    missing_deps+=("ninja or make")
fi

if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
    missing_deps+=("curl or wget")
fi

if [ ${#missing_deps[@]} -gt 0 ]; then
    echo "Error: Missing required build dependencies: ${missing_deps[*]}" >&2
    echo "" >&2
    echo "To install dependencies on common Linux distributions:" >&2
    echo "  Ubuntu/Debian: sudo apt update && sudo apt install -y build-essential cmake git curl libvulkan-dev glslc" >&2
    echo "  Fedora/RHEL:   sudo dnf install -y gcc-c++ make cmake git curl vulkan-headers vulkan-loader-devel glslc" >&2
    echo "  Arch Linux:    sudo pacman -S --needed base-devel cmake git curl vulkan-headers vulkan-icd-loader shaderc" >&2
    exit 1
fi

download_file() {
    local url="$1"
    local dest="$2"
    echo "Downloading $url to $dest..."
    if command -v curl >/dev/null 2>&1; then
        curl -L -C - --fail --output "$dest" "$url"
    elif command -v wget >/dev/null 2>&1; then
        wget -c -O "$dest" "$url"
    else
        echo "Error: Neither curl nor wget found." >&2
        exit 1
    fi
}

# 2. Model Selection and Download
mkdir -p "$HOME/.local/share/models/"
case "$MODEL_CHOICE" in
    1.7b|1.7B)
        MODEL_NAME="dyslexic-writer-1.7b-q4_k_m.gguf"
        MODEL_URL="https://huggingface.co/jburnford/dyslexic-writer-1.7b/resolve/main/Qwen-1.7B-q4_k_m.gguf"
        ;;
    4b|4B|*)
        MODEL_NAME="dyslexic-writer-qwen3-4b-q4_k_m.gguf"
        MODEL_URL="https://huggingface.co/jburnford/dyslexic-writer-qwen3-4b/resolve/main/Qwen3-4B-q4_k_m.gguf"
        ;;
esac

model_path="$HOME/.local/share/models/$MODEL_NAME"
if [ -f "$model_path" ]; then
    echo "Model already present at $model_path."
else
    download_file "$MODEL_URL" "$model_path"
fi

# 3. Backend Acceleration Selection
BACKEND="${BACKEND:-auto}"
CMAKE_BACKEND_FLAGS=()
if [ "$BACKEND" = "auto" ]; then
    if command -v nvidia-smi >/dev/null 2>&1; then
        BACKEND="cuda"
    elif command -v glslc >/dev/null 2>&1 || [ -e /dev/dri ]; then
        BACKEND="vulkan"
    else
        BACKEND="cpu"
    fi
fi

echo "Selected hardware acceleration backend: $BACKEND"
case "$BACKEND" in
    cuda)
        CMAKE_BACKEND_FLAGS+=("-DGGML_CUDA=ON")
        ;;
    vulkan)
        if ! command -v glslc >/dev/null 2>&1; then
            echo "Warning: 'glslc' shader compiler not found. Vulkan build may fail." >&2
        fi
        CMAKE_BACKEND_FLAGS+=("-DGGML_VULKAN=ON")
        ;;
    cpu)
        echo "Configuring CPU-only build."
        ;;
    *)
        echo "Unknown BACKEND=$BACKEND; defaulting to CPU."
        ;;
esac

# 4. Clone or update llama.cpp (pinned tag)
src_dir="$HOME/.local/src/llama.cpp"
mkdir -p "$HOME/.local/src"
if [ ! -d "$src_dir/.git" ]; then
    echo "Cloning llama.cpp ($LLAMA_TAG)..."
    git clone --depth 1 --branch "$LLAMA_TAG" https://github.com/ggerganov/llama.cpp.git "$src_dir" 2>/dev/null || \
    git clone --depth 1 https://github.com/ggerganov/llama.cpp.git "$src_dir"
else
    echo "llama.cpp already cloned at $src_dir."
fi

cd "$src_dir"

# 5. Build strictly target llama-server with RPATH
echo "Configuring CMake build..."
cmake -B build \
    "${CMAKE_BACKEND_FLAGS[@]}" \
    -DBUILD_TESTING=OFF \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_INSTALL_PREFIX="$PREFIX" \
    -DCMAKE_INSTALL_RPATH="\$ORIGIN/../lib:\$ORIGIN/../lib64" \
    -DCMAKE_INSTALL_RPATH_USE_LINK_PATH=ON

echo "Building llama-server target..."
cmake --build build --target llama-server --parallel

# 6. Install to target prefix
echo "Installing llama-server to $PREFIX..."
mkdir -p "$PREFIX/bin" "$PREFIX/lib"
if [ -w "$PREFIX" ] || [ -w "$PREFIX/bin" ]; then
    cmake --install build --prefix "$PREFIX"
else
    echo "Installing to $PREFIX requires root privileges:"
    sudo cmake --install build --prefix "$PREFIX"
    sudo ldconfig 2>/dev/null || true
fi

echo ""
echo "=== FastTyper Backend Setup Complete ==="
echo "Binary:  $PREFIX/bin/llama-server"
echo "Model:   $model_path"
echo ""
echo "To run the daemon standalone:"
echo "  ./backend/run-daemon.sh"
echo ""
echo "To enable with systemd user service:"
echo "  mkdir -p ~/.config/systemd/user"
echo "  ln -sf \"$(cd "$(dirname "$0")/.." && pwd)/backend/fasttyper.service\" ~/.config/systemd/user/fasttyper.service"
echo "  systemctl --user daemon-reload"
echo "  systemctl --user enable --now fasttyper"
