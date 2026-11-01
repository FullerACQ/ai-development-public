#!/bin/bash
# Saves the current Warp tab name to a temp file keyed by PWD hash.
TAB=$(osascript -e 'tell application "System Events" to tell process "Warp" to get name of front window' 2>/dev/null)
if [ -n "$TAB" ]; then
  KEY=$(echo "$PWD" | md5 -q)
  echo "$TAB" > "/tmp/claude-tab-${KEY}"
fi
