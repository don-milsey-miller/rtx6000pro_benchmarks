#!/usr/bin/env bash
set -Eeuo pipefail

workspace=/workspace
benchmark=$workspace/benchmark
python=$workspace/venvs/vllm/bin/python
log_dir=$workspace/results/downloads
mkdir -p "$workspace/models" "$log_dir"
export HF_HOME=$workspace/cache/huggingface
export HF_HUB_ENABLE_HF_TRANSFER=1

download_one() {
  local id=$1 revision=$2 destination=$3 name=$4
  if [[ -s "$destination/.forgebench-complete" ]]; then
    echo "$name already complete"
    return
  fi
  rm -f "$destination/.forgebench-complete"
  "$python" - "$id" "$revision" "$destination" <<'PY' > "$log_dir/$name.log" 2>&1
import sys
from huggingface_hub import snapshot_download
repo_id, revision, destination = sys.argv[1:]
snapshot_download(
    repo_id=repo_id,
    revision=revision,
    local_dir=destination,
    local_dir_use_symlinks=False,
    max_workers=8,
)
PY
  printf '%s\n' "$id@$revision" > "$destination/.forgebench-complete"
}

mapfile -t rows < <(jq -r '.models[] | [.id,.model,.revision] | @tsv' "$benchmark/config/models.json")
pids=()
for row in "${rows[@]}"; do
  IFS=$'\t' read -r name id revision <<< "$row"
  download_one "$id" "$revision" "$workspace/models/$name" "$name" &
  pids+=("$!")
done

failed=0
for pid in "${pids[@]}"; do
  wait "$pid" || failed=1
done
if (( failed )); then
  tail -n 80 "$log_dir"/*.log >&2 || true
  exit 1
fi

du -sh "$workspace/models"/* | tee "$log_dir/model-sizes.txt"
