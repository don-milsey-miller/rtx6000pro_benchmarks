#!/usr/bin/env bash
set -Eeuo pipefail

workspace=/workspace
smoke_dir=$workspace/results/pi-smoke
session_dir=$smoke_dir/session
mkdir -p "$session_dir"
chown -R bench:bench "$smoke_dir"

if ! runuser --user bench -- env \
  PI_CODING_AGENT_DIR=$workspace/pi-config \
  PI_OFFLINE=1 \
  VLLM_API_KEY=local-vllm \
  HTTP_PROXY=http://127.0.0.1:9 \
  HTTPS_PROXY=http://127.0.0.1:9 \
  ALL_PROXY=http://127.0.0.1:9 \
  NO_PROXY=127.0.0.1,localhost \
  "$workspace/pi/node_modules/.bin/pi" \
    --offline \
    --provider vllm-qwen \
    --model Qwen/Qwen3.8-27B \
    --thinking off \
    --mode json \
    --print \
    --session-dir "$session_dir" \
    --session-id forgebench-smoke \
    --no-tools \
    "Reply with exactly READY." \
    > "$smoke_dir/events.jsonl" \
    2> "$smoke_dir/stderr.log"; then
  cat "$smoke_dir/stderr.log" >&2
  exit 1
fi

if ! grep -q '"type":"message_end"' "$smoke_dir/events.jsonl"; then
  echo "Pi smoke test returned no assistant message" >&2
  cat "$smoke_dir/events.jsonl" >&2
  cat "$smoke_dir/stderr.log" >&2
  exit 1
fi

echo "Pi-to-vLLM smoke test passed"
