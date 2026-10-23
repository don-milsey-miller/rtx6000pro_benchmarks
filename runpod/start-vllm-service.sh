#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $# -lt 4 ]]; then
  echo "usage: $0 NAME GPU PORT MODEL [extra vllm args...]" >&2
  exit 2
fi

name=$1 gpu=$2 port=$3 model=$4
shift 4
served_model_name=${SERVED_MODEL_NAME:-$model}
workspace=/workspace
runtime_dir=$workspace/runtime
log_dir=$workspace/results/services
mkdir -p "$runtime_dir" "$log_dir" "$workspace/cache/vllm/$name" "$workspace/cache/xdg/$name"

export HF_HOME=$workspace/cache/huggingface
export VLLM_CACHE_ROOT=$workspace/cache/vllm/$name
export XDG_CACHE_HOME=$workspace/cache/xdg/$name
export TORCHINDUCTOR_CACHE_DIR=$workspace/cache/vllm/$name/torchinductor
export TRITON_CACHE_DIR=$workspace/cache/vllm/$name/triton
export CUDA_VISIBLE_DEVICES=$gpu
export PYTHONUNBUFFERED=1
export CUDA_HOME=/usr/local/cuda
export PATH=$CUDA_HOME/bin:$PATH

pid_file=$runtime_dir/$name.pid
if [[ -s "$pid_file" ]] && kill -0 "$(cat "$pid_file")" 2>/dev/null; then
  echo "$name is already running" >&2
  exit 0
fi

nohup setsid "$workspace/venvs/vllm/bin/vllm" serve "$model" \
  --served-model-name "$served_model_name" \
  --host 127.0.0.1 --port "$port" --tensor-parallel-size 1 \
  --dtype bfloat16 --gpu-memory-utilization 0.92 \
  --max-model-len 65536 --max-num-seqs 16 --max-num-batched-tokens 16384 \
  --kv-cache-dtype fp8 --enable-prefix-caching --enable-auto-tool-choice \
  "$@" > "$log_dir/$name.log" 2>&1 &

echo $! > "$pid_file"
echo "started $name pid=$(cat "$pid_file") gpu=$gpu port=$port"
