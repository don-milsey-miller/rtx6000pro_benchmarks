#!/usr/bin/env bash
set -Eeuo pipefail

workspace=/workspace
benchmark=$workspace/benchmark
artifacts=$workspace/results/forgebench
mkdir -p "$artifacts"
exec > >(tee -a "$workspace/results/execute.log") 2>&1

cleanup() {
  status=$?
  printf '{"exitCode":%s,"finishedAt":"%s"}\n' "$status" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    > "$workspace/results/completion.json"
  find "$workspace/results" -type f -print0 | sort -z | xargs -0 sha256sum \
    > "$workspace/results/SHA256SUMS" || true
  exit "$status"
}
trap cleanup EXIT

"$benchmark/runpod/bootstrap.sh"
"$benchmark/runpod/download-models.sh"
"$benchmark/runpod/launch-stack.sh"

# The unprivileged agent may reach only loopback vLLM endpoints. Hidden graders
# and reference implementations remain root-only and execute after the agent exits.
chmod 0711 "$benchmark"
chmod 0700 "$benchmark/evaluators" "$benchmark/validation"
chown -R root:root "$benchmark/evaluators" "$benchmark/validation"

nft delete table inet forgebench 2>/dev/null || true
nft add table inet forgebench
nft 'add chain inet forgebench output { type filter hook output priority 0; policy accept; }'
nft add rule inet forgebench output meta skuid bench ip daddr 127.0.0.0/8 accept
nft add rule inet forgebench output meta skuid bench ip6 daddr ::1 accept
nft add rule inet forgebench output meta skuid bench reject

cd "$benchmark"
npm test
npm run build:bundles
PI_CODING_AGENT_DIR=$workspace/pi-config \
PI_PATH=$workspace/pi/node_modules/.bin/pi \
BENCH_AGENT_USER=bench \
BENCH_ARTIFACTS=$artifacts \
  node scripts/preflight.mjs

PI_CODING_AGENT_DIR=$workspace/pi-config \
PI_PATH=$workspace/pi/node_modules/.bin/pi \
BENCH_AGENT_USER=bench \
BENCH_ARTIFACTS=$artifacts \
  node scripts/run-suite.mjs
