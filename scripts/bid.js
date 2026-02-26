#!/usr/bin/env node
// SECURITY MANIFEST:
//   Environment variables accessed: MARKETPLACE_BASE_URL (only)
//   External endpoints called: {BASE}/upload/image, {BASE}/jobs/:jobId/bids
//   Local files read: --preview path (must be under /tmp/)
//   Local files written: none

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { spawnSync } = require('child_process');

const BASE_URL    = process.env.MARKETPLACE_BASE_URL || 'http://localhost:3000';
const CONFIG_PATH = path.join(os.homedir(), '.openclaw/marketplace-config.json');

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 2) {
    args[argv[i].replace('--', '')] = argv[i + 1];
  }
  return args;
}

const args = parseArgs(process.argv);

if (!args['job-id'] || !args.preview || !args.price || !args.introduction) {
  console.error('[Bid] Usage: bid.js --job-id <id> --preview <path> --price <n> --introduction <text>');
  process.exit(1);
}

// Path traversal defense
const previewPath = path.resolve(args.preview);
if (!previewPath.startsWith('/tmp/')) {
  console.error('[Bid] ERROR: Preview path must be under /tmp/');
  process.exit(1);
}
if (!fs.existsSync(previewPath)) {
  console.error(`[Bid] ERROR: Preview file not found: ${previewPath}`);
  process.exit(1);
}

let config;
try {
  config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
} catch (err) {
  console.error('[Bid] ERROR: Failed to read config:', err.message);
  process.exit(1);
}

if (!config.agentId) {
  console.error('[Bid] ERROR: agentId not found. Run register.js first.');
  process.exit(1);
}

// Mime type from extension
const ext      = path.extname(previewPath).toLowerCase();
const mimeMap  = { '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.webp':'image/webp', '.gif':'image/gif' };
const mimeType = mimeMap[ext] || 'image/png';

// ── Step 1: Upload ─────────────────────────────────────────────────────────
console.log(`[Bid] Uploading preview (${mimeType})...`);

const upload = spawnSync('curl', [
  '-v', '-X', 'POST',
  `${BASE_URL}/upload/image?purpose=bid_preview`,
  '-F', `file=@${previewPath};type=${mimeType}`
], { encoding: 'utf-8' });

if (upload.error) {
  console.error('[Bid] ERROR: curl failed:', upload.error.message);
  process.exit(1);
}

const uploadStatus = parseInt((upload.stderr.match(/< HTTP\/[\d.]+ (\d+)/) || [])[1]);

if (!upload.stdout || (uploadStatus && uploadStatus >= 400)) {
  console.error(`[Bid] ERROR: Upload failed (HTTP ${uploadStatus})`);
  console.error('[Bid] Response:', upload.stdout);
  process.exit(1);
}

let previewUrl;
try {
  previewUrl = JSON.parse(upload.stdout.trim()).url;
  if (!previewUrl) throw new Error('No URL in response');
  console.log(`[Bid] 📤 Uploaded: ${previewUrl}`);
} catch (err) {
  console.error('[Bid] ERROR: Failed to parse upload response:', upload.stdout);
  process.exit(1);
}

// ── Step 2: Submit bid ─────────────────────────────────────────────────────
const bidPayload = JSON.stringify({
  agentId: config.agentId,
  introduction: args.introduction,
  preview: previewUrl,
  price: Number(args.price)
});

const bid = spawnSync('curl', [
  '-v', '-X', 'POST',
  `${BASE_URL}/jobs/${args['job-id']}/bids`,
  '-H', 'Content-Type: application/json',
  '-d', bidPayload
], { encoding: 'utf-8' });

const bidStatus = parseInt((bid.stderr.match(/< HTTP\/[\d.]+ (\d+)/) || [])[1]);

if (bidStatus === 409) { console.log(`[Bid] SKIP — Already bid on Job #${args['job-id']}`); process.exit(0); }
if (bidStatus === 400) { console.log(`[Bid] SKIP — Job #${args['job-id']} no longer open`); process.exit(0); }

if (bid.status !== 0 || (bidStatus && bidStatus >= 400)) {
  console.error(`[Bid] ERROR: Bid failed (HTTP ${bidStatus}):`, bid.stdout);
  process.exit(1);
}

console.log(`[Bid] ✅ Bid submitted — Job #${args['job-id']} @ ${args.price}`);
