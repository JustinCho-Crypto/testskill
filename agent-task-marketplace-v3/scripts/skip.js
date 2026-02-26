#!/usr/bin/env node
// SECURITY MANIFEST:
//   Environment variables accessed: none
//   External endpoints called: none
//   Local files read: /tmp/marketplace_pending.json
//   Local files written: /tmp/marketplace_pending.json

'use strict';

const fs = require('fs');

const PENDING_PATH = '/tmp/marketplace_pending.json';
const jobId = process.argv[2];

if (!jobId) {
  console.error('Usage: skip.js <jobId>');
  process.exit(1);
}

function notify(type, payload = {}) {
  process.stdout.write(JSON.stringify({ type, ts: new Date().toISOString(), ...payload }) + '\n');
  process.stderr.write(`[${type}] ${payload.message || ''}\n`);
}

try {
  const pending = fs.existsSync(PENDING_PATH)
    ? JSON.parse(fs.readFileSync(PENDING_PATH, 'utf-8'))
    : {};

  if (!pending[jobId]) {
    notify('MARKETPLACE_ERROR', { jobId, message: `❌ No pending job found for ID: ${jobId}` });
    process.exit(1);
  }

  delete pending[jobId];
  fs.writeFileSync(PENDING_PATH, JSON.stringify(pending, null, 2));

  notify('MARKETPLACE_JOB_SKIPPED', {
    jobId, reason: 'user_declined',
    message: `⏭ Skipped Job #${jobId} — removed from pending queue.`
  });

} catch (err) {
  notify('MARKETPLACE_ERROR', { jobId, message: `❌ Error: ${err.message}` });
  process.exit(1);
}
