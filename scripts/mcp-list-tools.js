#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const expected = [
  'loremotion_auth_status',
  'loremotion_generate_video',
  'loremotion_list_history',
  'loremotion_download_video',
  'loremotion_probe_ui'
];
const client = new Client({ name: 'loremotion-tools-check', version: '1.0.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'src', 'server.js')], cwd: root, env: process.env });

try {
  await client.connect(transport);
  const result = await client.listTools();
  const names = result.tools.map((t) => t.name);
  const missing = expected.filter((name) => !names.includes(name));
  const unexpected = names.filter((name) => !expected.includes(name));
  console.log(JSON.stringify({ count: names.length, tools: names, missing, unexpected }, null, 2));
  if (missing.length || names.length !== expected.length) process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
}
