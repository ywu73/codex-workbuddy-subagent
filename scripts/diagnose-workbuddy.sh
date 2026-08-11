#!/bin/sh
set -eu

app_cli=/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy

if command -v codebuddy >/dev/null 2>&1; then
  cli=$(command -v codebuddy)
elif command -v cbc >/dev/null 2>&1; then
  cli=$(command -v cbc)
elif [ -x "$app_cli" ]; then
  cli=$app_cli
else
  printf '%s\n' 'WorkBuddy CLI not found' >&2
  exit 1
fi

printf '%s\n' "$cli"
"$cli" --version
