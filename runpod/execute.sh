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

network_isolation=pi-offline-and-proxy
nft delete table inet forgebench 2>/dev/null || true
if nft add table inet forgebench 2>/dev/null; then
  nft 'add chain inet forgebench output { type filter hook output priority 0; policy accept; }'
  nft add rule inet forgebench output meta skuid bench ip daddr 127.0.0.0/8 accept
  nft add rule inet forgebench output meta skuid bench ip6 daddr ::1 accept
  nft add rule inet forgebench output meta skuid bench reject
  network_isolation=uid-egress-filter
else
  echo "warning: container lacks NET_ADMIN; enforcing Pi offline mode and dead external proxy instead"
fi
printf '{"mode":"%s"}\n' "$network_isolation" > "$workspace/results/network-isolation.json"

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
HTTP_PROXY=http://127.0.0.1:9 HTTPS_PROXY=http://127.0.0.1:9 ALL_PROXY=http://127.0.0.1:9 \
NO_PROXY=127.0.0.1,localhost \
  node scripts/run-suite.mjs
