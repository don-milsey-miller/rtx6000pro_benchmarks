#!/usr/bin/env bash
set -Eeuo pipefail

mkdir -p /root/.ssh /var/run/sshd /workspace
chmod 0700 /root/.ssh

if [[ -n "${PUBLIC_KEY_B64:-}" ]]; then
  printf '%s' "$PUBLIC_KEY_B64" | base64 --decode > /root/.ssh/authorized_keys
  chmod 0600 /root/.ssh/authorized_keys
elif [[ -n "${PUBLIC_KEY:-}" ]]; then
  printf '%s\n' "${PUBLIC_KEY}" > /root/.ssh/authorized_keys
  chmod 0600 /root/.ssh/authorized_keys
fi

ssh-keygen -A
/usr/sbin/sshd

cat > /etc/profile.d/forgebench.sh <<'EOF'
export HF_HOME=/workspace/cache/huggingface
export VLLM_CACHE_ROOT=/workspace/cache/vllm
export XDG_CACHE_HOME=/workspace/cache/xdg
export UV_CACHE_DIR=/workspace/cache/uv
export PATH=/workspace/bin:/workspace/pi/node_modules/.bin:/workspace/venvs/vllm/bin:/usr/local/bin:/usr/local/sbin:$PATH
EOF

mkdir -p /workspace/bin /workspace/cache/huggingface /workspace/cache/vllm \
  /workspace/cache/xdg /workspace/cache/uv /workspace/results

echo "ForgeBench RHEL 10.2 UBI environment is ready."
exec sleep infinity
