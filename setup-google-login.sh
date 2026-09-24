#!/usr/bin/env sh
set -eu

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example"
fi

npm install

IMPORT_PATH="${1:-${LOREMOTION_PROFILE_IMPORT_PATH:-}}"
if [ -z "$IMPORT_PATH" ]; then
  IMPORT_PATH="$(node --input-type=module -e "import 'dotenv/config'; process.stdout.write(process.env.LOREMOTION_PROFILE_IMPORT_PATH || '')")"
fi

if [ -n "$IMPORT_PATH" ]; then
  echo "Importing externally authenticated LoreMotion profile..."
  npm run import-profile -- "$IMPORT_PATH"
  npm run verify-login
  echo "LoreMotion MCP headless profile setup is complete."
  echo "Start with: npm start"
  exit 0
fi

if [ ! -t 0 ] || [ ! -t 1 ]; then
  echo "Interactive Google login cannot run because stdin/stdout is not a TTY." >&2
  echo "Authenticate once on a desktop, transfer the profile directory/archive to this server, then run:" >&2
  echo "  ./setup-google-login.sh /path/to/profile-or-archive" >&2
  echo "or set LOREMOTION_PROFILE_IMPORT_PATH and rerun this script." >&2
  exit 2
fi

npm run install-browser
npm run login
npm run verify-login

echo "LoreMotion MCP Google-login setup is complete."
echo "Start with: npm start"
