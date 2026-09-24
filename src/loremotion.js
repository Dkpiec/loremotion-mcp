import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function settlePage(page) {
  await page.locator('body').waitFor({ state: 'visible' }).catch(() => {});
  await page.waitForLoadState('load').catch(() => {});
  // Give the React generator a short hydration window without waiting for ad/network idleness.
  await page.waitForTimeout(1200);
}

const defaults = {
  prompt: [
    'textarea[placeholder*="prompt" i]',
    'textarea[aria-label*="prompt" i]',
    'textarea',
    '[contenteditable="true"][role="textbox"]'
  ],
  file: ['input[type="file"]'],
  generate: ['button:has-text("Generate")', '[role="button"]:has-text("Generate")'],
  model: ['select[name*="model" i]', '[aria-label*="model" i]', '[data-testid*="model" i]'],
  aspect: ['select[name*="aspect" i]', '[aria-label*="aspect" i]', '[data-testid*="aspect" i]'],
  duration: ['input[type="range"]', 'select[name*="duration" i]', '[aria-label*="duration" i]', '[data-testid*="duration" i]'],
  video: ['video[src]', 'video source[src]'],
  download: ['a[download]', 'a[href*=".mp4"]', 'button:has-text("Download")', 'a:has-text("Download")']
};

function selectors(name) {
  const extra = Array.isArray(config.selectorOverrides?.[name]) ? config.selectorOverrides[name] : [];
  return [...extra, ...(defaults[name] || [])];
}

async function firstVisible(page, list) {
  for (const sel of list) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.count() && await loc.isVisible()) return loc;
    } catch {}
  }
  return null;
}

async function clickTextChoice(page, labels) {
  for (const label of labels) {
    const rx = label instanceof RegExp ? label : new RegExp(String(label).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    for (const role of ['button', 'radio', 'option', 'tab']) {
      try {
        const loc = page.getByRole(role, { name: rx }).first();
        if (await loc.count() && await loc.isVisible()) {
          await loc.click();
          return true;
        }
      } catch {}
    }
    // Avoid arbitrary page text: LoreMotion's SEO/FAQ copy repeats model and duration names.
    // Only click elements that are plausibly interactive.
    for (const sel of ['button', '[role="button"]', '[role="option"]', '[role="radio"]', 'label']) {
      try {
        const loc = page.locator(sel).filter({ hasText: rx }).first();
        if (await loc.count() && await loc.isVisible()) {
          await loc.click();
          return true;
        }
      } catch {}
    }
  }
  return false;
}

async function selectByLabel(page, labelRegex, values) {
  try {
    const select = page.getByLabel(labelRegex).first();
    if (await select.count()) {
      const opts = await select.locator('option').allTextContents();
      for (const value of values) {
        const rx = value instanceof RegExp ? value : new RegExp(String(value), 'i');
        const match = opts.find((x) => rx.test(x));
        if (match) {
          await select.selectOption({ label: match });
          return true;
        }
      }
    }
  } catch {}
  return false;
}

async function selectNativeByOptionText(page, values) {
  const selects = page.locator('select');
  for (let i = 0; i < await selects.count(); i++) {
    const select = selects.nth(i);
    try {
      const opts = await select.locator('option').allTextContents();
      for (const value of values) {
        const rx = value instanceof RegExp ? value : new RegExp(String(value), 'i');
        const match = opts.find((x) => rx.test(x));
        if (match) {
          await select.selectOption({ label: match });
          return true;
        }
      }
    } catch {}
  }
  return false;
}

async function clickOverrideControl(page, name, optionLabels) {
  const control = await firstVisible(page, selectors(name));
  if (!control) return false;
  try {
    if ((await control.evaluate((el) => el.tagName.toLowerCase())) === 'select') {
      const opts = await control.locator('option').allTextContents();
      for (const value of optionLabels) {
        const rx = value instanceof RegExp ? value : new RegExp(String(value), 'i');
        const match = opts.find((x) => rx.test(x));
        if (match) {
          await control.selectOption({ label: match });
          return true;
        }
      }
    }
    await control.click();
    return await clickTextChoice(page, optionLabels);
  } catch {
    return false;
  }
}

function modelLabels(model) {
  return model === 'minimax-h3'
    ? [/MiniMax\s*H3/i, /H3/i]
    : [/LTX(?:-Video)?\s*2\.5/i, /LTX\s*2\.5/i, /LTX/i];
}

function durationLabels(seconds) {
  return [new RegExp(`^\\s*${seconds}\\s*(s|sec|seconds?)?\\s*$`, 'i'), new RegExp(`${seconds}\\s*(s|sec|seconds?)`, 'i')];
}

function aspectLabels(aspect) {
  return [new RegExp(`^\\s*${aspect.replace(':', '\\s*:\\s*')}\\s*$`, 'i'), new RegExp(aspect.replace(':', '.*'), 'i')];
}

async function chooseModel(page, model) {
  if (await selectByLabel(page, /model/i, modelLabels(model))) return;
  if (await selectNativeByOptionText(page, modelLabels(model))) return;
  if (await clickOverrideControl(page, 'model', modelLabels(model))) return;
  if (await clickTextChoice(page, modelLabels(model))) return;
  const control = await firstVisible(page, ['button:has-text("Model")', '[role="combobox"]']);
  if (control) {
    await control.click();
    if (await clickTextChoice(page, modelLabels(model))) return;
  }
  throw new Error(`Could not select model ${model}. Run npm run probe and set LOREMOTION_SELECTORS_JSON if the UI changed.`);
}

async function chooseAspect(page, aspect) {
  if (await selectByLabel(page, /aspect|ratio/i, aspectLabels(aspect))) return;
  if (await selectNativeByOptionText(page, aspectLabels(aspect))) return;
  if (await clickOverrideControl(page, 'aspect', aspectLabels(aspect))) return;
  if (await clickTextChoice(page, aspectLabels(aspect))) return;
  // Some revisions use a combobox without an accessible label.
  const combos = page.locator('select, [role="combobox"]');
  for (let i = 0; i < await combos.count(); i++) {
    const c = combos.nth(i);
    try {
      const text = await c.innerText();
      if (/16:9|9:16|1:1|4:3/.test(text)) {
        await c.click();
        if (await clickTextChoice(page, aspectLabels(aspect))) return;
      }
    } catch {}
  }
  throw new Error(`Could not select aspect ratio ${aspect}.`);
}

async function findDurationRange(page) {
  const ranges = page.locator('input[type="range"]');
  let best = null;
  let bestScore = -1;

  for (let i = 0; i < await ranges.count(); i++) {
    const range = ranges.nth(i);
    if (!await range.isVisible().catch(() => false)) continue;
    const meta = await range.evaluate((el) => {
      const parent = el.closest('label,[role="group"],div') || el.parentElement;
      return {
        min: el.min || null,
        max: el.max || null,
        step: el.step || null,
        value: el.value || null,
        name: el.getAttribute('name'),
        ariaLabel: el.getAttribute('aria-label'),
        contextText: (parent?.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 240)
      };
    });
    let score = 0;
    const hint = `${meta.name || ''} ${meta.ariaLabel || ''} ${meta.contextText || ''}`;
    if (/duration|length|seconds?|\bsec\b/i.test(hint)) score += 10;
    const max = Number(meta.max);
    const min = Number(meta.min);
    if (Number.isFinite(max) && max > 0 && max <= 60) score += 3;
    if (Number.isFinite(min) && min >= 0) score += 1;
    if (score > bestScore) { best = range; bestScore = score; }
  }
  return best;
}

async function setRangeDuration(page, seconds) {
  const range = await findDurationRange(page);
  if (!range) return false;

  const attrs = await range.evaluate((el) => ({ min: el.min, max: el.max, step: el.step, value: el.value }));
  const min = attrs.min === '' ? 0 : Number(attrs.min);
  const max = attrs.max === '' ? 100 : Number(attrs.max);
  if (Number.isFinite(max) && seconds > max) {
    throw new Error(`Requested ${seconds}s exceeds the LoreMotion duration slider maximum of ${max}s for the selected model/account tier.`);
  }
  if (Number.isFinite(min) && seconds < min) {
    throw new Error(`Requested ${seconds}s is below the LoreMotion duration slider minimum of ${min}s for the selected model/account tier.`);
  }

  await range.evaluate((el, desired) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (!setter) throw new Error('HTMLInputElement value setter is unavailable.');
    setter.call(el, String(desired));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, seconds);

  const actual = Number(await range.inputValue());
  if (!Number.isFinite(actual) || actual !== Number(seconds)) {
    throw new Error(`LoreMotion duration slider did not accept ${seconds}s (actual value: ${await range.inputValue()}).`);
  }
  return true;
}

async function chooseDuration(page, seconds) {
  // Current LoreMotion uses input[type=range]. Handle it first so React sees the
  // native value setter plus input/change events, then retain legacy fallbacks.
  if (await setRangeDuration(page, seconds)) return;
  if (await selectByLabel(page, /duration|length/i, durationLabels(seconds))) return;
  if (await selectNativeByOptionText(page, durationLabels(seconds))) return;
  if (await clickOverrideControl(page, 'duration', durationLabels(seconds))) return;
  if (await clickTextChoice(page, durationLabels(seconds))) return;
  throw new Error(`Could not select ${seconds}s. LoreMotion may not expose that duration for the selected model/account tier.`);
}

async function fillPrompt(page, prompt) {
  // The live prompt textarea currently has a placeholder but no accessible name.
  // Prefer placeholder matching and only then fall back to generic configured selectors.
  const preferred = await firstVisible(page, [
    'textarea[placeholder*="prompt" i]',
    'textarea[placeholder*="describe" i]',
    'textarea[placeholder*="scene" i]',
    'textarea[placeholder*="video" i]',
    'textarea[placeholder]'
  ]);
  const loc = preferred || await firstVisible(page, selectors('prompt'));
  if (!loc) throw new Error('Could not find the prompt field.');
  if ((await loc.getAttribute('contenteditable')) === 'true') {
    await loc.click();
    await loc.fill(prompt);
  } else {
    await loc.fill(prompt);
  }
}

async function uploadImage(page, imagePath) {
  const resolved = path.resolve(imagePath);
  await fs.access(resolved);
  let input = await firstVisible(page, selectors('file'));
  if (!input) {
    await clickTextChoice(page, [/image.?to.?video/i, /upload/i, /reference image/i]);
    input = await firstVisible(page, selectors('file'));
  }
  if (!input) throw new Error('Could not find the image upload input.');
  await input.setInputFiles(resolved);
}


const TURNSTILE_ERROR = 'Cloudflare challenge present; a signed-in profile or different egress is required';

async function hasBlockingTurnstile(page) {
  const state = await page.evaluate(() => {
    const responses = [...document.querySelectorAll('input[type="hidden"][name="cf-turnstile-response"]')];
    if (!responses.length) return { present: false, solved: false, visible: false, textHint: false };
    const solved = responses.some((el) => Boolean((el.value || '').trim()));
    const candidates = [
      ...document.querySelectorAll('iframe[src*="challenges.cloudflare.com"]'),
      ...document.querySelectorAll('.cf-turnstile,[data-sitekey]')
    ];
    const visible = candidates.some((el) => {
      const r = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity || 1) !== 0;
    });
    const text = (document.body?.innerText || '').toLowerCase();
    const textHint = /verify you are human|checking your browser|cloudflare|security verification|challenge/.test(text);
    return { present: true, solved, visible, textHint };
  }).catch(() => ({ present: false, solved: false, visible: false, textHint: false }));
  return state.present && !state.solved && (state.visible || state.textHint);
}

async function assertNoBlockingTurnstile(page) {
  if (await hasBlockingTurnstile(page)) throw new Error(TURNSTILE_ERROR);
}

async function clickGenerate(page) {
  await assertNoBlockingTurnstile(page);

  let btn = null;
  try {
    const semantic = page.getByRole('button', { name: /generate/i }).first();
    if (await semantic.count() && await semantic.isVisible()) btn = semantic;
  } catch {}
  if (!btn) btn = await firstVisible(page, selectors('generate'));
  if (!btn) throw new Error('Could not find the Generate button.');

  await btn.waitFor({ state: 'visible' });
  for (let i = 0; i < 20 && await btn.isDisabled().catch(() => false); i++) await sleep(250);
  if (await btn.isDisabled().catch(() => false)) throw new Error('Generate button stayed disabled after filling the form.');
  await btn.click();
  await page.waitForTimeout(750).catch(() => {});
  await assertNoBlockingTurnstile(page);
}

async function snapshotMedia(page) {
  return await page.evaluate(() => {
    const absolute = (u) => { try { return new URL(u, location.href).href; } catch { return u; } };
    const videoUrls = [...document.querySelectorAll('video')]
      .flatMap(v => [v.currentSrc, v.src, v.querySelector('source')?.src])
      .filter(Boolean).map(absolute);
    const links = [...document.querySelectorAll('a[href]')].map(a => absolute(a.getAttribute('href')));
    const shareUrls = links.filter(x => /\/v\/[A-Za-z0-9_-]+/.test(x));
    const mp4Urls = [...videoUrls, ...links.filter(x => /\.mp4(?:\?|$)/i.test(x))];
    return { videoUrls: [...new Set(videoUrls)], mp4Urls: [...new Set(mp4Urls)], shareUrls: [...new Set(shareUrls)] };
  });
}

async function waitForNewResult(page, before, timeoutMs, historyProbe) {
  const deadline = Date.now() + timeoutMs;
  let nextHistoryProbeAt = Date.now() + 15000;
  let last = { videoUrls: [], mp4Urls: [], shareUrls: [] };
  while (Date.now() < deadline) {
    last = await snapshotMedia(page);
    const currentUrl = page.url();
    if (/\/v\/[A-Za-z0-9_-]+/.test(currentUrl) && !before.shareUrls.includes(currentUrl)) {
      return { ...last, videoUrl: last.mp4Urls[0] || last.videoUrls[0] || null, shareUrl: currentUrl };
    }
    const newMp4 = last.mp4Urls.find(x => !before.mp4Urls.includes(x));
    const newVideo = last.videoUrls.find(x => !before.videoUrls.includes(x));
    const newShare = last.shareUrls.find(x => !before.shareUrls.includes(x));
    if (newMp4 || newVideo || newShare) return { ...last, videoUrl: newMp4 || newVideo || null, shareUrl: newShare || null };

    if (historyProbe && Date.now() >= nextHistoryProbeAt) {
      nextHistoryProbeAt = Date.now() + 30000;
      try {
        const fromHistory = await historyProbe();
        if (fromHistory) return { ...last, ...fromHistory, detectedVia: 'history' };
      } catch {}
    }

    await assertNoBlockingTurnstile(page);
    const body = (await page.locator('body').innerText().catch(() => '')).toLowerCase();
    if (/generation failed|render failed|something went wrong|error generating/.test(body)) {
      throw new Error('LoreMotion reported a generation failure.');
    }
    await sleep(2000);
  }
  return { ...last, videoUrl: last.mp4Urls[0] || last.videoUrls[0] || null, shareUrl: last.shareUrls[0] || null, timedOut: true };
}

export class LoreMotionClient {
  constructor(browserManager) {
    this.browser = browserManager;
  }

  async authStatus() {
    const page = await this.browser.newPage('/generate/');
    let dashboardPage = null;
    try {
      await settlePage(page);
      const text = await page.locator('body').innerText().catch(() => '');
      const hasAccountUi = /sign out|log out|my account|account settings|profile/i.test(text);
      const hasSignIn = /sign in|sign up|continue with google|sign in with google|log in/i.test(text);
      const hasDashboardLink = await page.locator('a[href*="dashboard"]').count() > 0;

      let dashboardUrl = null;
      let dashboardLooksAuthenticated = false;
      if (config.sessionMode === 'persistent') {
        dashboardPage = await this.browser.newPage('/dashboard');
        await settlePage(dashboardPage);
        dashboardUrl = dashboardPage.url();
        const dashboardText = await dashboardPage.locator('body').innerText().catch(() => '');
        const dashboardSignIn = /sign in|sign up|continue with google|sign in with google|log in/i.test(dashboardText);
        const dashboardAccountUi = /sign out|log out|my account|account settings|profile/i.test(dashboardText);
        const dashboardContent = /history|generations|my videos|recent|dashboard/i.test(dashboardText);
        dashboardLooksAuthenticated = !dashboardSignIn && (dashboardAccountUi || dashboardContent || /\/dashboard(?:[/?#]|$)/i.test(dashboardUrl));
      }

      return {
        signedIn: Boolean(hasAccountUi || (hasDashboardLink && !hasSignIn) || dashboardLooksAuthenticated),
        signInPromptVisible: hasSignIn,
        url: page.url(),
        dashboardUrl,
        sessionMode: config.sessionMode,
        profileDir: config.sessionMode === 'persistent' ? config.profileDir : null
      };
    } finally {
      if (dashboardPage) await dashboardPage.close().catch(() => {});
      await page.close();
    }
  }

  async generate({ prompt, model = 'ltx-2.5', aspectRatio = '16:9', durationSeconds, imagePath, wait = true, timeoutMs }) {
    const page = await this.browser.newPage('/generate/');
    try {
      await settlePage(page);
      const before = await snapshotMedia(page);
      let historyBaseline = null;
      if (config.sessionMode === 'persistent') {
        try {
          const h = await this.listHistory({ limit: 100 });
          historyBaseline = new Set((h.items || []).map((x) => x.shareUrl).filter(Boolean));
        } catch {}
      }
      await chooseModel(page, model);
      await fillPrompt(page, prompt);
      if (imagePath) await uploadImage(page, imagePath);
      await chooseAspect(page, aspectRatio);
      const duration = durationSeconds ?? (model === 'minimax-h3' ? config.h3DefaultDuration : config.ltxDefaultDuration);
      await chooseDuration(page, duration);
      await clickGenerate(page);

      if (!wait) return { submitted: true, model, aspectRatio, durationSeconds: duration, pageUrl: page.url() };
      const historyProbe = historyBaseline ? async () => {
        const h = await this.listHistory({ limit: 100 });
        const item = (h.items || []).find((x) => x.shareUrl && !historyBaseline.has(x.shareUrl));
        return item ? { videoUrl: item.videoUrl || null, shareUrl: item.shareUrl, historyItem: item } : null;
      } : null;
      const result = await waitForNewResult(page, before, timeoutMs || config.generationTimeoutMs, historyProbe);
      return { submitted: true, model, aspectRatio, durationSeconds: duration, pageUrl: page.url(), ...result };
    } catch (err) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const shot = path.join(config.downloadDir, `error-${stamp}.png`);
      await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
      err.message += ` Screenshot: ${shot}`;
      throw err;
    } finally {
      if (wait) await page.close();
    }
  }

  async listHistory({ limit = 20 } = {}) {
    if (config.sessionMode === 'anonymous') {
      throw new Error('LoreMotion history is unavailable in anonymous session mode. Use LOREMOTION_SESSION_MODE=persistent and sign in to access the dashboard.');
    }
    const page = await this.browser.newPage('/dashboard');
    try {
      await settlePage(page);
      const items = await page.evaluate((max) => {
        const absolute = (u) => { try { return new URL(u, location.href).href; } catch { return u; } };
        const links = [...document.querySelectorAll('a[href]')].filter(a => /\/v\/[A-Za-z0-9_-]+/.test(a.getAttribute('href') || ''));
        const seen = new Set();
        const out = [];
        for (const a of links) {
          const href = absolute(a.getAttribute('href'));
          if (seen.has(href)) continue;
          seen.add(href);
          const card = a.closest('article,li,[class*="card"],[class*="item"]') || a.parentElement;
          const video = card?.querySelector?.('video');
          const text = (card?.innerText || a.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 500);
          out.push({ shareUrl: href, videoUrl: video?.currentSrc || video?.src || null, text });
          if (out.length >= max) break;
        }
        return out;
      }, limit);
      return { pageUrl: page.url(), count: items.length, items };
    } finally { await page.close(); }
  }

  async download({ videoUrl, shareUrl, filename }) {
    const context = await this.browser.getContext();
    let resolvedVideoUrl = videoUrl || null;
    let page = null;
    try {
      if (!resolvedVideoUrl && shareUrl) {
        page = await context.newPage();
        await page.goto(shareUrl, { waitUntil: 'domcontentloaded' });
        await settlePage(page);
        const media = await snapshotMedia(page);
        resolvedVideoUrl = media.mp4Urls[0] || media.videoUrls.find(x => /^https?:/i.test(x)) || null;
      }

      const safe = (filename || `loremotion-${Date.now()}.mp4`).replace(/[^A-Za-z0-9._-]/g, '_');
      const out = path.resolve(config.downloadDir, safe.endsWith('.mp4') ? safe : `${safe}.mp4`);

      if (resolvedVideoUrl && /^https?:/i.test(resolvedVideoUrl)) {
        const response = await context.request.get(resolvedVideoUrl);
        if (!response.ok()) throw new Error(`Download failed: HTTP ${response.status()}`);
        await fs.writeFile(out, await response.body());
        return { path: out, videoUrl: resolvedVideoUrl };
      }

      if (page) {
        const btn = page.getByRole('button', { name: /download/i }).first();
        const link = page.getByRole('link', { name: /download/i }).first();
        const clickable = (await btn.count()) ? btn : link;
        if (await clickable.count()) {
          const dl = await Promise.all([page.waitForEvent('download'), clickable.click()]).then(([d]) => d);
          await dl.saveAs(out);
          return { path: out, videoUrl: resolvedVideoUrl };
        }
      }
      throw new Error('Could not resolve a downloadable MP4. Supply videoUrl or shareUrl from generate/history.');
    } finally { if (page) await page.close(); }
  }

  async probe({ pathname = '/generate/' } = {}) {
    const page = await this.browser.newPage(pathname.startsWith('/') ? pathname : `/${pathname}`);
    try {
      await settlePage(page);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const screenshot = path.join(config.downloadDir, `probe-${stamp}.png`);
      await page.screenshot({ path: screenshot, fullPage: true });
      const ui = await page.evaluate(() => ({
        url: location.href,
        title: document.title,
        buttons: [...document.querySelectorAll('button')].map(x => (x.innerText || x.getAttribute('aria-label') || '').trim()).filter(Boolean).slice(0, 80),
        inputs: [...document.querySelectorAll('input,textarea,select,[contenteditable=true]')].map(x => ({
          tag: x.tagName.toLowerCase(), type: x.getAttribute('type'), name: x.getAttribute('name'), placeholder: x.getAttribute('placeholder'), ariaLabel: x.getAttribute('aria-label'),
          min: x.getAttribute('min'), max: x.getAttribute('max'), step: x.getAttribute('step'), value: 'value' in x ? x.value : null
        })).slice(0, 80),
        durationSliders: [...document.querySelectorAll('input[type="range"]')].map(x => ({
          min: x.min || null, max: x.max || null, step: x.step || null, value: x.value || null,
          name: x.getAttribute('name'), ariaLabel: x.getAttribute('aria-label'),
          contextText: ((x.closest('label,[role="group"],div') || x.parentElement)?.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 240)
        })),
        durationSliderMax: (() => {
          const ranges = [...document.querySelectorAll('input[type="range"]')];
          let best = null;
          let bestScore = -1;
          for (const x of ranges) {
            const parent = x.closest('label,[role="group"],div') || x.parentElement;
            const hint = `${x.getAttribute('name') || ''} ${x.getAttribute('aria-label') || ''} ${(parent?.innerText || '')}`;
            let score = /duration|length|seconds?|\bsec\b/i.test(hint) ? 10 : 0;
            const max = Number(x.max);
            const min = Number(x.min);
            if (Number.isFinite(max) && max > 0 && max <= 60) score += 3;
            if (Number.isFinite(min) && min >= 0) score += 1;
            if (score > bestScore) { best = x; bestScore = score; }
          }
          return best && Number.isFinite(Number(best.max)) ? Number(best.max) : null;
        })(),
        turnstile: {
          present: Boolean(document.querySelector('input[type="hidden"][name="cf-turnstile-response"]')),
          solved: [...document.querySelectorAll('input[type="hidden"][name="cf-turnstile-response"]')].some(x => Boolean((x.value || '').trim()))
        },
        links: [...document.querySelectorAll('a[href]')].map(x => ({ text: (x.innerText || '').trim(), href: x.getAttribute('href') })).slice(0, 80)
      }));
      return { ...ui, screenshot };
    } finally { await page.close(); }
  }
}
