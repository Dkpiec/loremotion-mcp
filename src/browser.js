import fs from 'node:fs/promises';
import { chromium } from 'playwright';
import { config } from './config.js';

export class BrowserManager {
  constructor(options = {}) {
    this.forceHeaded = Boolean(options.forceHeaded);
    this.browser = null;
    this.context = null;
  }

  launchOptions({ channel } = {}) {
    const options = {
      headless: this.forceHeaded ? false : config.headless,
      slowMo: config.slowMoMs,
      args: config.launchArgs
    };

    // A bare executable path is required on many headless/arm64 servers where
    // Playwright's chromium headless shell exists but no named Chrome channel does.
    // An explicit executablePath always wins over channel selection.
    if (config.executablePath) options.executablePath = config.executablePath;
    else if (channel) options.channel = channel;

    return options;
  }

  async launchBrowser() {
    if (config.executablePath) return chromium.launch(this.launchOptions());

    const channel = config.browserChannel || null;
    try {
      return await chromium.launch(this.launchOptions({ channel }));
    } catch (err) {
      if (!channel) throw err;
      process.stderr.write(`[loremotion-mcp] Could not launch channel ${channel}; falling back to Playwright Chromium.\n`);
      return chromium.launch(this.launchOptions());
    }
  }

  async launchPersistent() {
    if (config.executablePath) {
      return chromium.launchPersistentContext(config.profileDir, {
        ...this.launchOptions(),
        acceptDownloads: true,
        viewport: { width: 1440, height: 1000 }
      });
    }

    const channel = config.browserChannel || null;
    try {
      return await chromium.launchPersistentContext(config.profileDir, {
        ...this.launchOptions({ channel }),
        acceptDownloads: true,
        viewport: { width: 1440, height: 1000 }
      });
    } catch (err) {
      if (!channel) throw err;
      process.stderr.write(`[loremotion-mcp] Could not launch channel ${channel}; falling back to Playwright Chromium.\n`);
      return chromium.launchPersistentContext(config.profileDir, {
        ...this.launchOptions(),
        acceptDownloads: true,
        viewport: { width: 1440, height: 1000 }
      });
    }
  }

  async getContext() {
    if (this.context) return this.context;
    await fs.mkdir(config.downloadDir, { recursive: true });

    if (config.sessionMode === 'anonymous') {
      this.browser = await this.launchBrowser();
      this.context = await this.browser.newContext({
        acceptDownloads: true,
        viewport: { width: 1440, height: 1000 }
      });
    } else {
      await fs.mkdir(config.profileDir, { recursive: true });
      this.context = await this.launchPersistent();
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
