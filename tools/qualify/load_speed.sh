#!/bin/sh
# Times the load of an image engine (default Krea 2) with four loading modes, page
# cache dropped before each (sudo asks for the password once). Run from the repository,
# with the stack up: sh tools/qualify/load_speed.sh [krea2-turbo|qwen-image-2.1]
set -e
model=${1:-krea2-turbo}
docker restart studio >/dev/null   # nothing resident, all memory free
sleep 15
for mode in mmap nommap direct server; do
  sync && echo 3 | sudo tee /proc/sys/vm/drop_caches >/dev/null
  docker exec -i studio python - "$model" "$mode" < "$(dirname "$0")/load_speed.py" 2>&1 | grep -E "^$model |Error"
done
