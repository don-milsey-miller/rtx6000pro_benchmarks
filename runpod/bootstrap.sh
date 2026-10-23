#!/usr/bin/env bash
set -Eeuo pipefail

workspace=/workspace
benchmark=$workspace/benchmark
log_dir=$workspace/results/bootstrap
mkdir -p "$log_dir" "$workspace/bin" "$workspace/venvs" "$workspace/cache" \
  "$workspace/pi" "$workspace/models" "$workspace/pi-config"
exec > >(tee -a "$log_dir/bootstrap.log") 2>&1

echo "bootstrap_started=$(date --iso-8601=seconds)"

if [[ ! -x "$workspace/bin/uv" ]]; then
  curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR="$workspace/bin" sh
fi
export PATH="$workspace/bin:$PATH"
export UV_CACHE_DIR="$workspace/cache/uv"

if [[ ! -x /usr/local/bin/node ]]; then
  node_version="$(curl -fsSL https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt \
    | awk '/linux-x64.tar.xz$/ { sub(/.*node-v/, "", $2); sub(/-linux-x64.tar.xz/, "", $2); print $2; exit }')"
  curl -fsSL "https://nodejs.org/dist/v${node_version}/node-v${node_version}-linux-x64.tar.xz" -o /tmp/node.tar.xz
  tar -xJf /tmp/node.tar.xz --strip-components=1 -C /usr/local
  rm -f /tmp/node.tar.xz
fi

if [[ ! -x "$workspace/pi/node_modules/.bin/pi" ]]; then
  npm install --prefix "$workspace/pi" "@earendil-works/pi-coding-agent@1.2.0"
fi

if [[ ! -x "$workspace/venvs/vllm/bin/vllm" ]]; then
  "$workspace/bin/uv" venv "$workspace/venvs/vllm" --python 3.12 --seed
  "$workspace/bin/uv" pip install --python "$workspace/venvs/vllm/bin/python" \
    "vllm==0.31.0" "httpx[http2]>=0.28" "huggingface_hub[hf_transfer]>=0.31" \
    "numpy>=2.0" "psutil>=6.0"
fi

install -m 0644 "$benchmark/runpod/pi-models.json" "$workspace/pi-config/models.json"
install -m 0644 "$benchmark/runpod/pi-settings.json" "$workspace/pi-config/settings.json"
chmod 0777 "$workspace/pi-config"
chmod 0666 "$workspace/pi-config/models.json" "$workspace/pi-config/settings.json"

# Pi's find and grep tools lazily fetch fd and rg. Fetch them before network
# isolation, as the same unprivileged user that runs the agent; extracting as
# root fails on root-squashed RunPod volumes when tar restores archive owners.
runuser --user bench -- env -u PI_OFFLINE PI_CODING_AGENT_DIR="$workspace/pi-config" \
  node --input-type=module -e '
    const { ensureTool } = await import("file:///workspace/pi/node_modules/@earendil-works/pi-coding-agent/dist/utils/tools-manager.js");
    for (const tool of ["fd", "rg"]) {
      const path = await ensureTool(tool, ({ type, message }) => console.error(`${type}: ${message}`));
      if (!path) throw new Error(`unable to provision Pi helper: ${tool}`);
      console.log(`${tool}=${path}`);
    }
  '

{
  echo "captured_at=$(date --iso-8601=seconds)"
  echo "os_pretty_name=$(source /etc/os-release; printf '%s' "$PRETTY_NAME")"
  echo "kernel=$(uname -r)"
  echo "node=$(node --version)"
  echo "npm=$(npm --version)"
  echo "pi=$($workspace/pi/node_modules/.bin/pi --version 2>/dev/null || true)"
  echo "fd=$($workspace/pi-config/bin/fd --version | head -n 1)"
  echo "rg=$($workspace/pi-config/bin/rg --version | head -n 1)"
  echo "uv=$($workspace/bin/uv --version)"
  echo "vllm=$($workspace/venvs/vllm/bin/python -c 'import vllm; print(vllm.__version__)')"
  echo "torch=$($workspace/venvs/vllm/bin/python -c 'import torch; print(torch.__version__)')"
  echo "torch_cuda=$($workspace/venvs/vllm/bin/python -c 'import torch; print(torch.version.cuda)')"
  echo "gpu_count=$($workspace/venvs/vllm/bin/python -c 'import torch; print(torch.cuda.device_count())')"
} | tee "$log_dir/software-manifest.txt"

nvidia-smi -q > "$log_dir/nvidia-smi-q.txt"
nvidia-smi topo -m > "$log_dir/nvidia-topology.txt"
lscpu > "$log_dir/lscpu.txt"
numactl --hardware > "$log_dir/numa.txt" || true
df -h > "$log_dir/df.txt"
echo "bootstrap_completed=$(date --iso-8601=seconds)"
