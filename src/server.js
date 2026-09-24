#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import { BrowserManager } from './browser.js';
import { LoreMotionClient } from './loremotion.js';

const browser = new BrowserManager();
const client = new LoreMotionClient(browser);

const ok = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });
const fail = (err) => ({ isError: true, content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }] });
const wrap = (fn) => async (args) => { try { return ok(await fn(args)); } catch (e) { return fail(e); } };

serveStdio(() => {
  const server = new McpServer({
    name: 'loremotion-browser',
    version: '1.0.0'
  });

  server.registerTool('loremotion_auth_status', {
    description: 'Check whether the current LoreMotion browser session appears signed in and report whether it is persistent or anonymous.',
    inputSchema: z.object({})
  }, wrap(() => client.authStatus()));

  server.registerTool('loremotion_generate_video', {
    description: 'Generate a LoreMotion video through the website. Supports a persistent signed-in session or an explicit anonymous ephemeral session. The free ad-supported flow is allowed to run normally; this tool does not bypass ads or site limits.',
    inputSchema: z.object({
      prompt: z.string().min(1),
      model: z.enum(['ltx-2.5', 'minimax-h3']).default('ltx-2.5'),
      aspectRatio: z.enum(['16:9', '9:16', '1:1', '4:3']).default('16:9'),
      durationSeconds: z.number().int().min(1).max(30).optional(),
      imagePath: z.string().optional().describe('Optional local image path on the MCP server machine for image-to-video.'),
      wait: z.boolean().default(true),
      timeoutMs: z.number().int().min(10000).max(900000).optional()
    })
  }, wrap((args) => client.generate(args)));

  server.registerTool('loremotion_list_history', {
    description: 'List recent signed-in LoreMotion history/dashboard items, which are normally retained for 48 hours on the free account.',
    inputSchema: z.object({ limit: z.number().int().min(1).max(100).default(20) })
  }, wrap((args) => client.listHistory(args)));

  server.registerTool('loremotion_download_video', {
    description: 'Download a generated MP4 using a video URL or LoreMotion share URL and return the local file path.',
    inputSchema: z.object({
      videoUrl: z.string().url().optional(),
      shareUrl: z.string().url().optional(),
      filename: z.string().optional()
    }).refine(v => Boolean(v.videoUrl || v.shareUrl), { message: 'videoUrl or shareUrl is required' })
  }, wrap((args) => client.download(args)));

  server.registerTool('loremotion_probe_ui', {
    description: 'Inspect the current LoreMotion UI labels/fields and save a screenshot. Useful when the website changes and selectors need adjustment.',
    inputSchema: z.object({ pathname: z.string().default('/generate/') })
  }, wrap((args) => client.probe(args)));

  return server;
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await browser.close().catch(() => {});
    process.exit(0);
  });
}
