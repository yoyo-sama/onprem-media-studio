#!/bin/sh
# Times Krea 2 and Qwen Image 2.1 renders at the sheet size (1920×1088) with and without
# torch.compile (render_speed.py), one process per variant, the server's engines freed
# first. Run from the repository, with the stack up:
#   sh tools/qualify/render_speed.sh [krea2-turbo|qwen-image-2.1]
# About 10 min for both engines. The images land in data/output/bench/ (and in the gallery).
set -e
models=${1:-"krea2-turbo qwen-image-2.1"}
docker restart studio >/dev/null   # nothing resident, all memory free
sleep 15
for model in $models; do
  for variant in base compile; do
    docker exec -i studio python - "$model" "$variant" < "$(dirname "$0")/render_speed.py" 2>&1 \
      | grep -E "^$model |Error" || echo "$model $variant: failed"
  done
done
