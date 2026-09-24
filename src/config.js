import 'dotenv/config';
import path from 'node:path';

const bool = (v, d = false) => v == null ? d : /^(1|true|yes|on)$/i.test(String(v));
const int = (v, d) => Number.isFinite(Number(v)) ? Number(v) : d;
const csv = (v, d = []) => {
  const raw = v == null || String(v).trim() === '' ? d.join(',') : String(v);
  return raw.split(',').map((x) => x.trim()).filter(Boolean);
};

let selectorOverrides = {};
try {
  selectorOverrides = JSON.parse(process.env.LOREMOTION_SELECTORS_JSON || '{}');
} catch (err) {
  throw new Error(`LOREMOTION_SELECTORS_JSON is not valid JSON: ${err.message}`);
}

export const config = {
  baseUrl: (process.env.LOREMOTION_BASE_URL || 'https://loremotion.com').replace(/\/$/, ''),
  profileDir: path.resolve(process.env.LOREMOTION_PROFILE_DIR || '.loremotion-profile'),
  profileImportPath: process.env.LOREMOTION_PROFILE_IMPORT_PATH ? path.resolve(process.env.LOREMOTION_PROFILE_IMPORT_PATH) : null,
  sessionMode: (process.env.LOREMOTION_SESSION_MODE || 'persistent').toLowerCase() === 'anonymous' ? 'anonymous' : 'persistent',
  downloadDir: path.resolve(process.env.LOREMOTION_DOWNLOAD_DIR || 'downloads'),
  headless: bool(process.env.LOREMOTION_HEADLESS, false),
  browserChannel: (process.env.LOREMOTION_BROWSER_CHANNEL == null ? 'chrome' : process.env.LOREMOTION_BROWSER_CHANNEL).trim(),
  executablePath: (process.env.LOREMOTION_EXECUTABLE_PATH || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || '').trim() || null,
  launchArgs: csv(process.env.LOREMOTION_LAUNCH_ARGS, ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--single-process']),
  timeoutMs: int(process.env.LOREMOTION_TIMEOUT_MS, 30000),
  generationTimeoutMs: int(process.env.LOREMOTION_GENERATION_TIMEOUT_MS, 300000),
  slowMoMs: int(process.env.LOREMOTION_SLOW_MO_MS, 0),
  ltxDefaultDuration: int(process.env.LOREMOTION_LTX_DEFAULT_DURATION, 5),
  h3DefaultDuration: int(process.env.LOREMOTION_H3_DEFAULT_DURATION, 5),
  selectorOverrides
};
