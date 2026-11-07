#!/bin/sh
# Qwen Image 2.1 (25 steps) against Lightning v2 RL (4) and Turbo (8) on the Qwen
# qualification cases (qwen_fast_bench.py). Run from the repository, stack up:
#   sh tools/qualify/qwen_fast_bench.sh [base lightning turbo]
# First run: renders 4 Krea 2 inputs on the server, downloads 43 GB (Lightning 28.5 GB,
# Turbo 14.2 GB) into data/bench/qwen-fast/, about 45 min in all. Images in the gallery,
# folder bench/qwen-fast. Remove the weights afterwards:
#   docker exec studio rm -rf /data/bench/qwen-fast
set -e
dir=/data/bench/qwen-fast
docker exec studio mkdir -p $dir
docker cp "$(dirname "$0")/image_cases.json" studio:$dir/
docker cp "$(dirname "$0")/run_image_cases.py" studio:$dir/
docker cp "$(dirname "$0")/qwen_fast_bench.py" studio:$dir/
if ! docker exec studio test -f $dir/inputs.json; then
  docker exec studio python $dir/run_image_cases.py --report $dir/inputs.json \
    --only sheet-human sheet-lion sheet-setting campaign-thumbnail
fi
for variant in ${*:-base lightning turbo}; do
  docker restart studio >/dev/null   # nothing resident, all memory free
  sleep 15
  docker exec studio python $dir/qwen_fast_bench.py "$variant"
done
docker exec studio python $dir/qwen_fast_bench.py compare
