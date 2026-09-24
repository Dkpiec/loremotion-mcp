#!/usr/bin/env node
import { BrowserManager } from '../src/browser.js';
import { LoreMotionClient } from '../src/loremotion.js';
const browser = new BrowserManager({ forceHeaded: true });
const client = new LoreMotionClient(browser);
try {
  console.log(JSON.stringify(await client.probe({ pathname: '/generate/' }), null, 2));
} finally {
  await browser.close();
}
