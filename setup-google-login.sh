#!/usr/bin/env sh
set -eu

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example"
fi

npm install
npm run install-browser
npm run login
npm run verify-login

echo "LoreMotion MCP Google-login setup is complete."
echo "Start with: npm start"
