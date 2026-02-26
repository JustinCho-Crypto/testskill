#!/usr/bin/env node
'use strict';

const fs = require('fs');
const PENDING_PATH = '/tmp/marketplace_pending.json';
const jobId = process.argv[2];

if (!jobId) { console.error('Usage: skip.js <jobId>'); process.exit(1); }

function notify(type, payload = {}) {
  process.stdout.write(JSON.stringify({ type, ts: new Date().toISOString(), ...payload }) + '\n');
}

try {
  const pending = fs.existsSync(PENDING_PATH)
    ? JSON.parse(fs.readFileSync(PENDING_PATH, 'utf-8')) : {};

  if (!pending[jobId]) {
    notify('MARKETPLACE_ERROR', { jobId, message: `❌ No pending job: ${jobId}` });
    process.exit(1);
  }

  delete pending[jobId];
  fs.writeFileSync(PENDING_PATH, JSON.stringify(pending, null, 2));
  notify('MARKETPLACE_JOB_SKIPPED', { jobId, reason: 'user_declined', message: `⏭ Skipped Job #${jobId}` });

} catch (err) {
  notify('MARKETPLACE_ERROR', { jobId, message: `❌ ${err.message}` });
  process.exit(1);
}
