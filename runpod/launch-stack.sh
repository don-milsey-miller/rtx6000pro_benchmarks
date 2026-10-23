#!/usr/bin/env bash
set -Eeuo pipefail

workspace=/workspace
benchmark=$workspace/benchmark

SERVED_MODEL_NAME=Qwen/Qwen3.8-27B \
  "$benchmark/runpod/start-vllm-service.sh" qwen 0 8001 "$workspace/models/qwen" \
  --safetensors-load-strategy prefetch --language-model-only \
  --reasoning-parser qwen3 --tool-call-parser qwen3_coder \
  --speculative-config '{"method":"mtp","num_speculative_tokens":3}'

SERVED_MODEL_NAME=meta-models/Muse-Glimmer-30B \
  "$benchmark/runpod/start-vllm-service.sh" muse 1 8002 "$workspace/models/muse" \
  --safetensors-load-strategy prefetch --language-model-only \
  --reasoning-parser muse_glimmer --tool-call-parser muse_glimmer

SERVED_MODEL_NAME=google/gemma-4-31B-it \
  "$benchmark/runpod/start-vllm-service.sh" gemma 2 8003 "$workspace/models/gemma" \
  --safetensors-load-strategy prefetch --language-model-only \
  --reasoning-parser gemma4 --tool-call-parser gemma4

deadline=$((SECONDS + 1800))
while (( SECONDS < deadline )); do
  healthy=0
  for port in 8001 8002 8003; do
    curl -fsS --max-time 2 "http://127.0.0.1:$port/health" >/dev/null && healthy=$((healthy + 1))
  done
  if (( healthy == 3 )); then
    echo "all three vLLM services are healthy"
    exit 0
  fi
  sleep 5
done

tail -n 100 "$workspace/results/services"/*.log >&2 || true
exit 1
