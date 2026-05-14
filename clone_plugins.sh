#!/bin/bash

grep -oP '(?<=\()https://github\.com/[^\)]+(?=\))' README.md | while read url; do
  # Make sure it's not the Rocksmith2024.NET repo
  if [[ "$url" == *Rocksmith2024.NET* ]]; then
    continue
  fi
  dir=$(basename "$url")
  git clone "$url" "plugins/$dir"
done
