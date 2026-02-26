#!/usr/bin/env node
// SECURITY MANIFEST:
//   Environment variables accessed: MARKETPLACE_BASE_URL (only)
//   External endpoints called: {BASE}/upload/image, {BASE}/jobs/:jobId/bids
//   Local files read: ~/.openclaw/marketplace-config.json, /tmp/marketplace_pending.json
//   Local files written: /tmp/job_spec_*.json, /tmp/result_* (auto-deleted)

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { spawnSync } = require('child_process');

const CONFIG_PATH  = path.join(os.homedir(), '.openclaw/marketplace-config.json');
const PENDING_PATH = '/tmp/marketplace_pending.json';
const SKILL_DIR    = path.resolve(__dirname, '..');
const BASE_URL     = process.env.MARKETPLACE_BASE_URL || 'http://localhost:3000';

const jobId = process.argv[2];
if (!jobId) {
  console.error('Usage: approve.js <jobId>');
  process.exit(1);
}

// ─── Notify helper ────────────────────────────────────────────────────────
function notify(type, payload = {}) {
  process.stdout.write(JSON.stringify({ type, ts: new Date().toISOString(), ...payload }) + '\n');
  process.stderr.write(`[${type}] ${payload.message || ''}\n`);
}

// ─── Load config + pending ────────────────────────────────────────────────
let config;
try {
  config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
} catch (err) {
  notify('MARKETPLACE_ERROR', { message: `Failed to read config: ${err.message}` });
  process.exit(1);
}

let pending;
try {
  pending = JSON.parse(fs.readFileSync(PENDING_PATH, 'utf-8'));
} catch (err) {
  notify('MARKETPLACE_ERROR', { message: `Failed to read pending jobs: ${err.message}` });
  process.exit(1);
}

const entry = pending[jobId];
if (!entry) {
  notify('MARKETPLACE_ERROR', { jobId, message: `❌ No pending job found for ID: ${jobId}` });
  process.exit(1);
}

const job      = entry.job;
const budget   = job.spec?.budget ?? 0;
const category = job.spec?.style || job.spec?.purpose || 'unknown';

const specPath   = `/tmp/job_spec_${jobId}.json`;
const resultPath = `/tmp/result_${jobId}`;

notify('MARKETPLACE_PROCESS_START', {
  jobId, category, budget,
  message: `⚙️ Starting bid process — Job #${jobId} (${category} / ${budget})`
});

function cleanup() {
  if (fs.existsSync(specPath))   fs.unlinkSync(specPath);
  // result file may have unknown extension — glob-style cleanup
  const dir   = '/tmp';
  const files = fs.readdirSync(dir);
  files.filter(f => f.startsWith(`result_${jobId}`)).forEach(f => {
    fs.unlinkSync(path.join(dir, f));
  });
}

try {
  // ── Step 1: Write job spec ───────────────────────────────────────────
  notify('MARKETPLACE_PROCESS_STEP', {
    jobId, step: 1, total: 3,
    message: `⚙️ [1/3] Preparing job spec...`
  });

  const jobSpec = {
    jobId,
    category,
    description: job.spec?.description || '',
    budget,
    referenceUrls: job.spec?.referenceUrls || []
  };
  fs.writeFileSync(specPath, JSON.stringify(jobSpec, null, 2));

  // ── Step 2: Run executor ─────────────────────────────────────────────
  notify('MARKETPLACE_PROCESS_STEP', {
    jobId, step: 2, total: 3,
    message: `⚙️ [2/3] Running executor — ${config.executorPath || '(not set)'}`
  });

  if (!config.executorPath) {
    notify('MARKETPLACE_ERROR', {
      jobId,
      message: `❌ executorPath not set in config. Please run onboarding again and set your executor.`
    });
    cleanup();
    process.exit(1);
  }

  const executorPath = config.executorPath.replace(/^~/, os.homedir());

  if (!fs.existsSync(executorPath)) {
    notify('MARKETPLACE_ERROR', {
      jobId,
      message: `❌ Executor not found: ${executorPath}`
    });
    cleanup();
    process.exit(1);
  }

  const execResult = spawnSync(executorPath, [specPath, resultPath], {
    encoding: 'utf-8',
    timeout: 5 * 60 * 1000  // 5 minute timeout
  });

  if (execResult.error || execResult.status !== 0) {
    const errMsg = execResult.stderr || execResult.error?.message || 'Unknown error';
    notify('MARKETPLACE_ERROR', {
      jobId,
      message: `❌ Executor failed (exit ${execResult.status}): ${errMsg.slice(0, 200)}`
    });
    cleanup();
    process.exit(1);
  }

  // Find result file (executor may add extension: result_<jobId>.png, .txt, etc.)
  const tmpFiles    = fs.readdirSync('/tmp');
  const resultFile  = tmpFiles.find(f => f.startsWith(`result_${jobId}`));

  if (!resultFile) {
    notify('MARKETPLACE_ERROR', {
      jobId,
      message: `❌ Executor succeeded but no result file found at /tmp/result_${jobId}*`
    });
    cleanup();
    process.exit(1);
  }

  const resultFullPath = `/tmp/${resultFile}`;
  notify('MARKETPLACE_PROCESS_STEP', {
    jobId, step: 2, total: 3,
    message: `✅ [2/3] Executor finished — result: ${resultFile}`
  });

  // ── Step 3: Upload + Bid ─────────────────────────────────────────────
  notify('MARKETPLACE_PROCESS_STEP', {
    jobId, step: 3, total: 3,
    message: `📤 [3/3] Uploading result and submitting bid...`
  });

  const introduction =
    `Hi, I'm ${config.agentName}. I specialize in ${config.specialties.join(', ')}.`;

  const { execFileSync } = require('child_process');
  execFileSync('node', [
    `${SKILL_DIR}/scripts/bid.js`,
    '--job-id', jobId,
    '--preview', resultFullPath,
    '--price', String(budget),
    '--introduction', introduction
  ], { env: { ...process.env, MARKETPLACE_BASE_URL: BASE_URL } });

  // ── Cleanup + done ───────────────────────────────────────────────────
  cleanup();

  delete pending[jobId];
  fs.writeFileSync(PENDING_PATH, JSON.stringify(pending, null, 2));

  notify('MARKETPLACE_BID_DONE', {
    jobId, category, price: budget,
    message: `🎉 Bid submitted! Job #${jobId} (${category}) @ ${budget}`
  });

} catch (err) {
  cleanup();
  notify('MARKETPLACE_ERROR', {
    jobId,
    message: `❌ Error on Job #${jobId}: ${err.message}`
  });
  process.exit(1);
}
