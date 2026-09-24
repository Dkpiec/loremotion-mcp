import fs from 'node:fs/promises';
import { chromium } from 'playwright';
import { config } from './config.js';

export class BrowserManager {
  constructor(options = {}) {
    this.forceHeaded = Boolean(options.forceHeaded);
    this.browser = null;
    this.context = null;
  }

  async getContext() {
    if (this.context) return this.context;
    await fs.mkdir(config.downloadDir, { recursive: true });

    const common = {
      headless: this.forceHeaded ? false : config.headless,
      slowMo: config.slowMoMs
    };

    if (config.sessionMode === 'anonymous') {
      const launch = async (channel) => chromium.launch({
        channel: channel || undefined,
        ...common
      });
      try {
        this.browser = await launch(config.browserChannel);
      } catch (err) {
        if (!config.browserChannel) throw err;
        process.stderr.write(`[loremotion-mcp] Could not launch channel ${config.browserChannel}; falling back to Playwright Chromium.\n`);
        this.browser = await launch(undefined);
      }
      this.context = await this.browser.newContext({
        acceptDownloads: true,
        viewport: { width: 1440, height: 1000 }
      });
    } else {
      await fs.mkdir(config.profileDir, { recursive: true });
      const launch = async (channel) => chromium.launchPersistentContext(config.profileDir, {
        channel: channel || undefined,
        ...common,
        acceptDownloads: true,
        viewport: { width: 1440, height: 1000 }
      });
      try {
        this.context = await launch(config.browserChannel);
      } catch (err) {
        if (!config.browserChannel) throw err;
        process.stderr.write(`[loremotion-mcp] Could not launch channel ${config.browserChannel}; falling back to Playwright Chromium.\n`);
        this.context = await launch(undefined);
      }
    }

    this.context.setDefaultTimeout(config.timeoutMs);
    return this.context;
  }

  async newPage(pathname = '/generate/') {
    const context = await this.getContext();
    const page = await context.newPage();
    await page.goto(`${config.baseUrl}${pathname}`, { waitUntil: 'domcontentloaded' });
    return page;
  }

  async close() {
    if (this.context) {
      await this.context.close().catch(() => {});
      this.context = null;
    }
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
  }
}
