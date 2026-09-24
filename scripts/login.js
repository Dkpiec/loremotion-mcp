#!/usr/bin/env node
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { BrowserManager } from '../src/browser.js';
import { LoreMotionClient } from '../src/loremotion.js';
import { config } from '../src/config.js';

if (config.sessionMode !== 'persistent') {
  throw new Error('Google login requires LOREMOTION_SESSION_MODE=persistent. Update .env and run npm run login again.');
}

const browser = new BrowserManager({ forceHeaded: true });
const client = new LoreMotionClient(browser);
const page = await browser.newPage('/generate/');
const rl = readline.createInterface({ input, output });

console.log(`Opened ${page.url()}`);
console.log('Complete LoreMotion\'s normal "Sign in with Google" flow in the opened browser window.');
console.log(`Persistent session directory: ${config.profileDir}`);
console.log('Do not put your Google password, cookies, or OAuth tokens in .env or Git.');

let verified = false;
try {
  while (!verified) {
    await rl.question('After LoreMotion shows you as signed in, press Enter here to verify the session... ');
    const status = await client.authStatus();
    if (status.signedIn) {
      verified = true;
      console.log('Verified: LoreMotion appears signed in.');
      console.log(`Session mode: ${status.sessionMode}`);
      console.log(`Profile saved at: ${config.profileDir}`);
      break;
    }

    console.log('LoreMotion still appears signed out in this browser profile.');
    const answer = (await rl.question('Press Enter to try again, or type q to quit without marking setup complete: ')).trim().toLowerCase();
    if (answer === 'q') break;
  }
} finally {
  rl.close();
  await page.close().catch(() => {});
  await browser.close();
}

if (!verified) {
  console.error('Google/LoreMotion login was not verified. Re-run: npm run login');
  process.exitCode = 1;
} else {
  console.log('Login setup complete. Verify any time with: npm run verify-login');
  console.log('Start the MCP server with: npm start');
}
