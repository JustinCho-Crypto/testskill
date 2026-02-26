#!/usr/bin/env node
// SECURITY MANIFEST:
//   Environment variables accessed: MARKETPLACE_BASE_URL (only)
//   External endpoints called: {BASE}/upload/image, {BASE}/jobs/:jobId/bids
//   Local files read: --preview path (must be under /tmp/)
//   Local files written: none

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const BASE_URL = process.env.MARKETPLACE_BASE_URL || 'http://localhost:3000';
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
  console.error('[Bid] Usage: bid.js --job-id <id> --preview <path> --price <amount> --introduction <text>');
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
  console.error('[Bid] ERROR: agentId not found in config. Run register.js first.');
  process.exit(1);
}

// Step 1. Upload preview image — multipart/form-data
let previewUrl;
try {
  const uploadResult = execFileSync('curl', [
    '-sf',
    '-X', 'POST',
    `${BASE_URL}/upload/image?purpose=bid_preview`,
    '-F', `file=@${previewPath};type=image/png`
  ]);
  const uploaded = JSON.parse(uploadResult.toString());
  previewUrl = uploaded.url;
  console.log(`[Bid] 📤 Preview uploaded: ${previewUrl}`);
} catch (err) {
  console.error('[Bid] ERROR uploading preview:', err.message);
  process.exit(1);
}

// Step 2. Submit bid — JSON.stringify prevents injection
const bidPayload = JSON.stringify({
  agentId: config.agentId,
  introduction: args.introduction,
  preview: previewUrl,
  price: Number(args.price)
});

try {
  execFileSync('curl', [
    '-sf',
    '-X', 'POST',
    `${BASE_URL}/jobs/${args['job-id']}/bids`,
    '-H', 'Content-Type: application/json',
    '-d', bidPayload
  ]);
  console.log(`[Bid] ✅ Bid submitted — Job #${args['job-id']} @ ${args.price}`);
} catch (err) {
  const stderr = err.stderr ? err.stderr.toString() : err.message;
  if (stderr.includes('409')) {
    console.log(`[Bid] SKIP — Already bid on Job #${args['job-id']}`);
  } else if (stderr.includes('400')) {
    console.log(`[Bid] SKIP — Job #${args['job-id']} is no longer open`);
  } else {
    console.error('[Bid] ERROR submitting bid:', stderr);
    process.exit(1);
  }
}
