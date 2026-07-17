#!/usr/bin/env bash
# Daily productivity brief launcher (macOS / Linux).
# Scheduled by launchd — see setup-macmini.sh. Logs to brief.log.
cd "$(dirname "$0")" || exit 1

# launchd runs with a minimal PATH, so make sure Homebrew's node is findable.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

echo "---- $(date) ----" >> brief.log
node --env-file=.env brief.js >> brief.log 2>&1
