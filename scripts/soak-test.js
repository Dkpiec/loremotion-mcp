#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] != null ? process.argv[i + 1] : fallback;
}
function intArg(name, fallback) {
  const n = Number(arg(name, fallback));
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}
function boolArg(name, fallback = false) {
  const raw = String(arg(name, fallback ? 'true' : 'false')).toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(raw);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

const anonymous = boolArg('anonymous', false);

const config = {
  anonymous,
  ltxRuns: intArg('ltx-runs', 10),
  h3Runs: intArg('h3-runs', 10),
  ltxDuration: intArg('ltx-duration', 10),
  h3Duration: intArg('h3-duration', 5),
  aspectRatio: arg('aspect', '16:9'),
  timeoutMs: intArg('timeout-ms', 600000),
  pauseMs: intArg('pause-ms', 3000),
  verifyHistory: anonymous ? false : boolArg('verify-history', true),
  download: boolArg('download', false),
  requireSignedIn: anonymous ? false : boolArg('require-signed-in', true),
  prompt: arg('prompt', 'A cinematic wide shot of a modern glass pavilion in a quiet landscaped plaza at golden hour, gentle tree movement, slow camera dolly forward, realistic lighting, natural ambient sound, no visible text or logos.'),
};

const reportDir = path.join(root, 'reports', `soak-${stamp()}`);
await fs.mkdir(reportDir, { recursive: true });
const jsonlPath = path.join(reportDir, 'results.jsonl');
const csvPath = path.join(reportDir, 'results.csv');
const summaryPath = path.join(reportDir, 'summary.json');

function textResult(result) {
  return (result?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}
function parseToolJson(result) {
  const text = textResult(result);
  if (result?.isError) throw new Error(text || 'MCP tool returned an error');
  try { return JSON.parse(text); } catch { return { raw: text }; }
}
function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

const client = new Client({ name: 'loremotion-soak-test', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, 'src', 'server.js')],
  cwd: root,
  env: {
    ...process.env,
    LOREMOTION_GENERATION_TIMEOUT_MS: String(config.timeoutMs),
    LOREMOTION_SESSION_MODE: config.anonymous ? 'anonymous' : (process.env.LOREMOTION_SESSION_MODE || 'persistent'),
  },
});

const rows = [];
let initialHistory = null;
let finalHistory = null;

async function call(name, args = {}) {
  return await client.callTool({ name, arguments: args }, { timeout: config.timeoutMs + 60000 });
}

async function writeRow(row) {
  rows.push(row);
  await fs.appendFile(jsonlPath, `${JSON.stringify(row)}\n`, 'utf8');
  console.log(`[${row.index}/${config.ltxRuns + config.h3Runs}] ${row.model} ${row.status.toUpperCase()} ${row.elapsedMs}ms${row.error ? ` - ${row.error}` : ''}`);
}

async function verifyHistoryContains(shareUrl) {
  if (!config.verifyHistory || !shareUrl) return null;
  try {
    const h = parseToolJson(await call('loremotion_list_history', { limit: 100 }));
    return Array.isArray(h.items) ? h.items.some((x) => x?.shareUrl === shareUrl) : null;
  } catch {
    return false;
  }
}

async function maybeDownload(shareUrl, videoUrl, index, model) {
  if (!config.download) return null;
  const filename = `${String(index).padStart(2, '0')}-${model}.mp4`;
  const d = parseToolJson(await call('loremotion_download_video', { shareUrl: shareUrl || undefined, videoUrl: videoUrl || undefined, filename }));
  return d.path || null;
}

try {
  await client.connect(transport);
  const tools = await client.listTools();
  const requiredTools = ['loremotion_auth_status', 'loremotion_generate_video', 'loremotion_list_history', 'loremotion_download_video'];
  const toolNames = new Set(tools.tools.map((t) => t.name));
  const missing = requiredTools.filter((name) => !toolNames.has(name));
  if (missing.length) throw new Error(`MCP server is missing tools: ${missing.join(', ')}`);

  const auth = parseToolJson(await call('loremotion_auth_status'));
  console.log(`LoreMotion auth status: signedIn=${Boolean(auth.signedIn)} sessionMode=${auth.sessionMode || ''} url=${auth.url || ''}`);
  if (config.anonymous && auth.signedIn) {
    throw new Error('Anonymous smoke test unexpectedly appears signed in; aborting to preserve the no-profile test condition.');
  }
  if (config.requireSignedIn && !auth.signedIn) {
    throw new Error('The persistent LoreMotion profile is not signed in. Run `npm run login` first; soak test aborted before generation.');
  }

  if (config.verifyHistory) {
    try { initialHistory = parseToolJson(await call('loremotion_list_history', { limit: 100 })); } catch {}
  }

  const cases = [
    ...Array.from({ length: config.ltxRuns }, (_, i) => ({ model: 'ltx-2.5', durationSeconds: config.ltxDuration, modelRun: i + 1 })),
    ...Array.from({ length: config.h3Runs }, (_, i) => ({ model: 'minimax-h3', durationSeconds: config.h3Duration, modelRun: i + 1 })),
  ];

  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    const startedAt = new Date();
    const started = Date.now();
    const runPrompt = `${config.prompt} Reliability test run ${c.modelRun} for ${c.model}.`;
    let row = {
      index: i + 1,
      modelRun: c.modelRun,
      model: c.model,
      durationSeconds: c.durationSeconds,
      aspectRatio: config.aspectRatio,
      startedAt: startedAt.toISOString(),
      status: 'fail',
      completed: false,
      historyVisible: null,
      downloadPath: null,
      elapsedMs: 0,
      shareUrl: null,
      videoUrl: null,
      timedOut: false,
      error: null,
    };

    try {
      const result = parseToolJson(await call('loremotion_generate_video', {
        prompt: runPrompt,
        model: c.model,
        aspectRatio: config.aspectRatio,
        durationSeconds: c.durationSeconds,
        wait: true,
        timeoutMs: config.timeoutMs,
      }));

      row.shareUrl = result.shareUrl || null;
      row.videoUrl = result.videoUrl || null;
      row.timedOut = Boolean(result.timedOut);
      row.completed = Boolean(!row.timedOut && (row.shareUrl || row.videoUrl));
      row.historyVisible = await verifyHistoryContains(row.shareUrl);

      if (row.completed && config.download) {
        row.downloadPath = await maybeDownload(row.shareUrl, row.videoUrl, i + 1, c.model);
      }

      row.status = row.completed ? 'pass' : 'fail';
      if (!row.completed) row.error = row.timedOut ? 'Generation timed out without a new completed result.' : 'No new share/video URL was detected after generation.';
    } catch (err) {
      row.error = err instanceof Error ? err.message : String(err);
    } finally {
      row.elapsedMs = Date.now() - started;
      row.finishedAt = new Date().toISOString();
      await writeRow(row);
    }

    if (i < cases.length - 1 && config.pauseMs > 0) await sleep(config.pauseMs);
  }

  if (config.verifyHistory) {
    try { finalHistory = parseToolJson(await call('loremotion_list_history', { limit: 100 })); } catch {}
  }
} finally {
  await client.close().catch(() => {});
}

const byModel = {};
for (const row of rows) {
  byModel[row.model] ||= { total: 0, passed: 0, failed: 0, durationsMs: [] };
  const b = byModel[row.model];
  b.total += 1;
  if (row.status === 'pass') b.passed += 1; else b.failed += 1;
  b.durationsMs.push(row.elapsedMs);
}
for (const b of Object.values(byModel)) {
  const ds = b.durationsMs.slice().sort((a, z) => a - z);
  b.passRate = b.total ? b.passed / b.total : 0;
  b.avgElapsedMs = ds.length ? Math.round(ds.reduce((a, z) => a + z, 0) / ds.length) : null;
  b.medianElapsedMs = ds.length ? ds[Math.floor(ds.length / 2)] : null;
  b.minElapsedMs = ds.length ? ds[0] : null;
  b.maxElapsedMs = ds.length ? ds.at(-1) : null;
  delete b.durationsMs;
}

const summary = {
  generatedAt: new Date().toISOString(),
  requested: {
    ltx: { runs: config.ltxRuns, durationSeconds: config.ltxDuration },
    minimaxH3: { runs: config.h3Runs, durationSeconds: config.h3Duration },
    aspectRatio: config.aspectRatio,
    verifyHistory: config.verifyHistory,
    download: config.download,
    anonymous: config.anonymous,
  },
  total: rows.length,
  passed: rows.filter((r) => r.status === 'pass').length,
  failed: rows.filter((r) => r.status !== 'pass').length,
  overallPassRate: rows.length ? rows.filter((r) => r.status === 'pass').length / rows.length : 0,
  byModel,
  initialHistoryCount: initialHistory?.count ?? null,
  finalHistoryCount: finalHistory?.count ?? null,
  reportDir,
};

const headers = ['index','modelRun','model','durationSeconds','aspectRatio','status','completed','historyVisible','elapsedMs','timedOut','shareUrl','videoUrl','downloadPath','startedAt','finishedAt','error'];
const csv = [headers.join(','), ...rows.map((row) => headers.map((h) => csvCell(row[h])).join(','))].join('\n') + '\n';
await fs.writeFile(csvPath, csv, 'utf8');
await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2) + '\n', 'utf8');

console.log('\n=== LoreMotion soak-test summary ===');
console.log(JSON.stringify(summary, null, 2));
console.log(`CSV: ${csvPath}`);
console.log(`JSONL: ${jsonlPath}`);
console.log(`Summary: ${summaryPath}`);

process.exitCode = summary.failed === 0 ? 0 : 1;
