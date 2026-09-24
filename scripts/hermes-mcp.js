#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { BrowserManager } from '../src/browser.js';
import { LoreMotionClient } from '../src/loremotion.js';
import { config } from '../src/config.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const log = (message) => process.stderr.write(`[loremotion-hermes] ${message}\n`);

async function checkAuth() {
  const browser = new BrowserManager();
  const client = new LoreMotionClient(browser);
  try {
    return await client.authStatus();
  } finally {
    await browser.close().catch(() => {});
  }
}

if (config.sessionMode !== 'persistent') {
  log('Hermes bootstrap requires LOREMOTION_SESSION_MODE=persistent.');
  process.exit(2);
}

let status = null;
try {
  status = await checkAuth();
} catch (err) {
  log(`Initial auth check failed: ${err instanceof Error ? err.message : String(err)}`);
}

if (!status?.signedIn && config.profileImportPath) {
  log(`LoreMotion is not signed in; importing the externally authenticated profile from ${config.profileImportPath}.`);
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'import-profile.js'), config.profileImportPath], {
    cwd: root,
    env: process.env,
    stdio: ['ignore', 'ignore', 'inherit']
  });
  if (result.status !== 0) {
    log('Profile import failed; MCP server will not start.');
    process.exit(result.status || 1);
  }
  status = await checkAuth().catch((err) => {
    log(`Post-import auth check failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  });
}

if (!status?.signedIn) {
  log('No valid signed-in LoreMotion profile is available.');
  log('Authenticate once on a desktop, transfer the profile directory/archive to this server, and set LOREMOTION_PROFILE_IMPORT_PATH or run `npm run import-profile -- <path>`.');
  if (config.sessionCookiesPath) {
    log('LOREMOTION_SESSION_COOKIES_PATH is set but still did not produce a signed-in session. The cookies may be for the wrong domain, or they may have expired. Note: only loremotion.com session cookies can sign you into LoreMotion.');
  }
  process.exit(3);
}

log(`Authenticated persistent profile verified at ${config.profileDir}. Starting MCP stdio server.`);
await import('../src/server.js');
