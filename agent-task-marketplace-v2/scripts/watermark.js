#!/usr/bin/env node
// SECURITY MANIFEST:
//   Environment variables accessed: none
//   External endpoints called: none
//   Local files read: --input path (must be under /tmp/)
//   Local files written: --output path (must be under /tmp/)

'use strict';

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 2) {
    args[argv[i].replace('--', '')] = argv[i + 1];
  }
  return args;
}

const args = parseArgs(process.argv);

if (!args['job-id'] || !args.input || !args.output) {
  console.error('[Watermark] Usage: watermark.js --job-id <id> --input <path> --output <path>');
  process.exit(1);
}

// Path traversal defense
function safeTemp(p) {
  const resolved = path.resolve(p);
  if (!resolved.startsWith('/tmp/')) {
    console.error(`[Watermark] ERROR: Path must be under /tmp/: ${p}`);
    process.exit(1);
  }
  return resolved;
}

const inputPath = safeTemp(args.input);
const outputPath = safeTemp(args.output);

if (!fs.existsSync(inputPath)) {
  console.error(`[Watermark] ERROR: Input file not found: ${inputPath}`);
  process.exit(1);
}

const content = fs.readFileSync(inputPath, 'utf-8');
const lines = content.split('\n');

// Show only 30% of content + watermark notice
const previewLines = Math.max(1, Math.floor(lines.length * 0.3));
const preview = lines.slice(0, previewLines).join('\n');

const watermarked = `${preview}

---
⚠️  WATERMARKED PREVIEW (30%)
    Full result delivered after payment.
    Job ID: ${args['job-id']}
---`;

// Write as .txt — caller uploads this as image via /upload/image
fs.writeFileSync(outputPath, watermarked);
console.log(`[Watermark] ✅ Preview written: ${outputPath}`);
