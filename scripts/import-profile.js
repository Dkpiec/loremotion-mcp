#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import AdmZip from 'adm-zip';
import * as tar from 'tar';
import { BrowserManager } from '../src/browser.js';
import { LoreMotionClient } from '../src/loremotion.js';
import { config } from '../src/config.js';

const exists = async (p) => fs.access(p).then(() => true).catch(() => false);
const lockNames = new Set(['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'DevToolsActivePort']);

function fail(message) {
  console.error(`[import-profile] ${message}`);
  process.exitCode = 1;
}

async function profileStructure(dir) {
  if (!await exists(dir)) return { valid: false, reason: 'path does not exist' };
  const stat = await fs.stat(dir).catch(() => null);
  if (!stat?.isDirectory()) return { valid: false, reason: 'path is not a directory' };
  if (!await exists(path.join(dir, 'Local State'))) return { valid: false, reason: 'missing Chromium "Local State" file' };

  const entries = await fs.readdir(dir, { withFileTypes: true });
  const profileDirs = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^(Default|Profile \d+)$/i.test(entry.name)) continue;
    const profilePath = path.join(dir, entry.name);
    if (await exists(path.join(profilePath, 'Preferences'))) profileDirs.push(profilePath);
  }
  if (!profileDirs.length) return { valid: false, reason: 'missing Default/Profile N directory with Preferences' };

  const stateCandidates = [
    'Network/Cookies',
    'Cookies',
    'Local Storage',
    'IndexedDB',
    'Session Storage'
  ];
  let hasState = false;
  for (const profilePath of profileDirs) {
    for (const rel of stateCandidates) {
      if (await exists(path.join(profilePath, ...rel.split('/')))) {
        hasState = true;
        break;
      }
    }
    if (hasState) break;
  }
  if (!hasState) return { valid: false, reason: 'no cookie/local-storage/session state found in the browser profile' };

  return { valid: true, profileDirs: profileDirs.map((p) => path.basename(p)) };
}

async function findProfileRoot(root, depth = 0) {
  const check = await profileStructure(root);
  if (check.valid) return root;
  if (depth >= 4) return null;

  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === '__MACOSX' || entry.name === 'node_modules') continue;
    const found = await findProfileRoot(path.join(root, entry.name), depth + 1);
    if (found) return found;
  }
  return null;
}

async function extractArchive(source, dest) {
  const lower = source.toLowerCase();
  await fs.mkdir(dest, { recursive: true });
  if (lower.endsWith('.zip')) {
    const zip = new AdmZip(source);
    for (const entry of zip.getEntries()) {
      const normalized = entry.entryName.replaceAll('\\', '/');
      if (normalized.startsWith('/') || normalized.split('/').includes('..')) {
        throw new Error(`Unsafe path in profile zip: ${entry.entryName}`);
      }
    }
    zip.extractAllTo(dest, true);
    return;
  }
  if (lower.endsWith('.tar') || lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) {
    await tar.x({ file: source, cwd: dest, preservePaths: false, strict: true });
    return;
  }
  throw new Error('Unsupported profile archive. Use a directory, .zip, .tar, .tar.gz, or .tgz.');
}

async function copyProfile(sourceRoot, staging) {
  await fs.rm(staging, { recursive: true, force: true });
  await fs.cp(sourceRoot, staging, {
    recursive: true,
    force: true,
    errorOnExist: false,
    filter: (src) => !lockNames.has(path.basename(src))
  });
  for (const name of lockNames) await fs.rm(path.join(staging, name), { recursive: true, force: true }).catch(() => {});
}

if (config.sessionMode !== 'persistent') {
  fail('LOREMOTION_SESSION_MODE must be persistent before importing an authenticated profile.');
  process.exit();
}

const rawSource = process.argv[2] || config.profileImportPath;
if (!rawSource) {
  fail('No profile source supplied. Run `npm run import-profile -- /path/to/profile-or-archive` or set LOREMOTION_PROFILE_IMPORT_PATH.');
  process.exit();
}

const source = path.resolve(rawSource);
const target = config.profileDir;
if (source === target) {
  fail('The import source and LOREMOTION_PROFILE_DIR are the same path; nothing was imported.');
  process.exit();
}

const targetParent = path.dirname(target);
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'loremotion-profile-import-'));
const extracted = path.join(tempRoot, 'extracted');
const staging = path.join(targetParent, `.${path.basename(target)}.import-${process.pid}-${Date.now()}`);
const backup = path.join(targetParent, `.${path.basename(target)}.backup-${process.pid}-${Date.now()}`);
let backupMade = false;
let targetInstalled = false;

try {
  const stat = await fs.stat(source).catch(() => null);
  if (!stat) throw new Error(`Profile import source does not exist: ${source}`);

  let searchRoot = source;
  if (stat.isFile()) {
    await extractArchive(source, extracted);
    searchRoot = extracted;
  } else if (!stat.isDirectory()) {
    throw new Error('Profile import source must be a directory or supported archive.');
  }

  const sourceRoot = await findProfileRoot(searchRoot);
  if (!sourceRoot) {
    throw new Error('Profile copy is incomplete: could not find a Chromium user-data root containing Local State, Preferences, and session state.');
  }

  await fs.mkdir(targetParent, { recursive: true });
  await copyProfile(sourceRoot, staging);
  const stagedCheck = await profileStructure(staging);
  if (!stagedCheck.valid) throw new Error(`Profile copy is incomplete after staging: ${stagedCheck.reason}.`);

  if (await exists(target)) {
    await fs.rename(target, backup);
    backupMade = true;
  }
  await fs.rename(staging, target);
  targetInstalled = true;

  const browser = new BrowserManager();
  const client = new LoreMotionClient(browser);
  let status;
  try {
    status = await client.authStatus();
  } finally {
    await browser.close().catch(() => {});
  }

  if (!status?.signedIn) {
    throw new Error('Imported profile is structurally complete but LoreMotion is not authenticated when verified on this server. The desktop profile may have expired or may not be portable to this OS/browser build.');
  }

  if (backupMade) await fs.rm(backup, { recursive: true, force: true });
  console.log(JSON.stringify({
    imported: true,
    verified: true,
    signedIn: true,
    sourceType: stat.isFile() ? 'archive' : 'directory',
    profileDir: target,
    profileDirs: stagedCheck.profileDirs,
    sessionMode: config.sessionMode
  }, null, 2));
  console.log('\nLoreMotion profile import verified. Hermes can now start the MCP server with `npm start`.');
} catch (err) {
  if (targetInstalled) await fs.rm(target, { recursive: true, force: true }).catch(() => {});
  if (backupMade && await exists(backup)) await fs.rename(backup, target).catch(() => {});
  await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
  fail(err instanceof Error ? err.message : String(err));
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
}
