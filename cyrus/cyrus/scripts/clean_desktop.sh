#!/bin/bash
# Registered CYRUS script. Moves loose files on the Desktop into dated
# subfolders by extension. Intentionally simple and reversible.
set -e

DESKTOP="$HOME/Desktop"
DATE=$(date +%Y-%m-%d)

cd "$DESKTOP" || exit 1
mkdir -p "_sorted_$DATE"

for f in *; do
  [ -f "$f" ] || continue
  ext="${f##*.}"
  mkdir -p "_sorted_$DATE/$ext"
  mv "$f" "_sorted_$DATE/$ext/"
done

echo "[CYRUS] Desktop sorted into _sorted_$DATE/"
