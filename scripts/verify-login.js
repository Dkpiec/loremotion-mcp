#!/usr/bin/env node
import { BrowserManager } from '../src/browser.js';
import { LoreMotionClient } from '../src/loremotion.js';
import { config } from '../src/config.js';

if (config.sessionMode !== 'persistent') {
  console.error('LOREMOTION_SESSION_MODE must be persistent to verify the Google-authenticated profile.');
  process.exit(1);
}

const browser = new BrowserManager();
const client = new LoreMotionClient(browser);

try {
  const status = await client.authStatus();
  console.log(JSON.stringify(status, null, 2));
  if (!status.signedIn) {
    console.error('\nLoreMotion is not signed in. Run: npm run login');
    process.exitCode = 1;
  } else {
    console.log('\nGoogle/LoreMotion persistent session is ready for MCP use.');
  }
} finally {
  await browser.close();
}
