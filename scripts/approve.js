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
const { execFileSync } = require('child_process');

const CONFIG_PATH  = path.join(os.homedir(), '.openclaw/marketplace-config.json');
const PENDING_PATH = '/tmp/marketplace_pending.json';
const SKILL_DIR    = path.resolve(__dirname, '..');
const BASE_URL     = process.env.MARKETPLACE_BASE_URL || 'http://localhost:3000';
const CONFIG_VERSION = '4.0';

const jobId = process.argv[2];
if (!jobId) {
  console.error('Usage: approve.js <jobId>');
  process.exit(1);
}

// ─── Notify ───────────────────────────────────────────────────────────────
function notify(type, payload = {}) {
  process.stdout.write(JSON.stringify({ type, ts: new Date().toISOString(), ...payload }) + '\n');
  process.stderr.write(`[${type}] ${payload.message || ''}\n`);
}

// ─── Load + validate config ───────────────────────────────────────────────
let config;
try {
  config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
} catch (err) {
  notify('MARKETPLACE_ERROR', { message: `Failed to read config: ${err.message}` });
  process.exit(1);
}

if (!config.configVersion || config.configVersion < CONFIG_VERSION) {
  notify('MARKETPLACE_CONFIG_OUTDATED', {
    message: `⚠️ Config outdated (v${config.configVersion || '?'}). Run onboarding again.`
  });
  process.exit(1);
}

// ─── Load pending ─────────────────────────────────────────────────────────
let pending;
try {
  pending = JSON.parse(fs.readFileSync(PENDING_PATH, 'utf-8'));
} catch (err) {
  notify('MARKETPLACE_ERROR', { message: `Failed to read pending: ${err.message}` });
  process.exit(1);
}

const entry = pending[jobId];
if (!entry) {
  notify('MARKETPLACE_ERROR', { jobId, message: `❌ No pending job: ${jobId}` });
  process.exit(1);
}

const job        = entry.job;
const matchGroup = entry.matchGroup;
const budget     = job.spec?.budget ?? 0;
const category   = job.spec?.style || job.spec?.purpose || 'unknown';
const desc       = job.spec?.description || '';

// Resolve capability for this job
const capability = config.capabilities?.[matchGroup] || config.capabilities?.default;

if (!capability) {
  notify('MARKETPLACE_ERROR', {
    jobId,
    message: `❌ No capability configured for group "${matchGroup}" and no default set.`
  });
  process.exit(1);
}

const specPath   = `/tmp/job_spec_${jobId}.json`;
const resultBase = `/tmp/result_${jobId}`;

notify('MARKETPLACE_PROCESS_START', {
  jobId, category, budget, matchGroup,
  capability: typeof capability === 'string' ? capability : capability.api,
  message: `⚙️ Starting — Job #${jobId} (${category} / ${budget}) via ${typeof capability === 'string' ? capability : capability.api}`
});

function cleanup() {
  if (fs.existsSync(specPath)) fs.unlinkSync(specPath);
  fs.readdirSync('/tmp')
    .filter(f => f.startsWith(`result_${jobId}`))
    .forEach(f => fs.unlinkSync(`/tmp/${f}`));
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
    description: desc,
    budget,
    referenceUrls: job.spec?.referenceUrls || [],
    matchGroup,
    capability: typeof capability === 'string'
      ? { type: 'script', value: capability }
      : capability
  };
  fs.writeFileSync(specPath, JSON.stringify(jobSpec, null, 2));

  // ── Step 2: Execute ──────────────────────────────────────────────────
  notify('MARKETPLACE_PROCESS_STEP', {
    jobId, step: 2, total: 3,
    message: `⚙️ [2/3] Executing job via ${jobSpec.capability.type === 'script' ? 'script' : jobSpec.capability.api}...`
  });

  // Resolve executor:
  // capability can be:
  //   string → local script path
  //   { api, envKey } → LLM-guided via stdout signal
  if (typeof capability === 'string') {
    // Local script executor
    const executorPath = capability.replace(/^~/, os.homedir());

    if (!fs.existsSync(executorPath)) {
      notify('MARKETPLACE_ERROR', { jobId, message: `❌ Executor not found: ${executorPath}` });
      cleanup();
      process.exit(1);
    }

    const { spawnSync } = require('child_process');
    const result = spawnSync(executorPath, [specPath, resultBase], {
      encoding: 'utf-8',
      timeout: 5 * 60 * 1000
    });

    if (result.error || result.status !== 0) {
      notify('MARKETPLACE_ERROR', {
        jobId,
        message: `❌ Executor failed (exit ${result.status}): ${(result.stderr || result.error?.message || '').slice(0, 200)}`
      });
      cleanup();
      process.exit(1);
    }

  } else {
    // LLM-guided executor — signal OpenClaw to perform the job
    // OpenClaw reads this event and uses the connected LLM to:
    //   1. Call the specified API (capability.api) using capability.envKey
    //   2. Write result to resultBase (with appropriate extension)
    //   3. Emit MARKETPLACE_EXECUTION_DONE when complete
    notify('MARKETPLACE_EXECUTION_REQUEST', {
      jobId,
      specPath,
      resultBase,
      capability,
      instruction: [
        `Perform this job using the ${capability.api} API.`,
        `Job spec is at: ${specPath}`,
        `Write the result file to: ${resultBase} (add appropriate extension, e.g. .png .txt .js)`,
        `API key env variable: ${capability.envKey}`,
        `When done, emit: MARKETPLACE_EXECUTION_DONE ${jobId}`
      ].join('\n'),
      message: `🤖 [2/3] Handing off to LLM — ${capability.api} (key: ${capability.envKey})`
    });

    // Wait for result file (poll up to 5 minutes)
    const deadline = Date.now() + 5 * 60 * 1000;
    while (Date.now() < deadline) {
      const found = fs.readdirSync('/tmp').find(f => f.startsWith(`result_${jobId}`));
      if (found) break;
      require('child_process').execSync('sleep 2');
    }
  }

  // ── Verify result file exists ────────────────────────────────────────
  const resultFile = fs.readdirSync('/tmp').find(f => f.startsWith(`result_${jobId}`));
  if (!resultFile) {
    notify('MARKETPLACE_ERROR', {
      jobId,
      message: `❌ No result file found at /tmp/result_${jobId}* — execution may have failed`
    });
    cleanup();
    process.exit(1);
  }

  const resultFullPath = `/tmp/${resultFile}`;
  notify('MARKETPLACE_PROCESS_STEP', {
    jobId, step: 2, total: 3,
    message: `✅ [2/3] Result ready — ${resultFile}`
  });

  // ── Step 3: Upload + Bid ─────────────────────────────────────────────
  notify('MARKETPLACE_PROCESS_STEP', {
    jobId, step: 3, total: 3,
    message: `📤 [3/3] Uploading and submitting bid...`
  });

  const introduction =
    `Hi, I'm ${config.agentName}. I specialize in ${Object.keys(config.capabilities).filter(k => k !== 'default').join(', ')}.`;

  execFileSync('node', [
    `${SKILL_DIR}/scripts/bid.js`,
    '--job-id', jobId,
    '--preview', resultFullPath,
    '--price', String(budget),
    '--introduction', introduction
  ], { env: { ...process.env, MARKETPLACE_BASE_URL: BASE_URL } });

  cleanup();

  delete pending[jobId];
  fs.writeFileSync(PENDING_PATH, JSON.stringify(pending, null, 2));

  notify('MARKETPLACE_BID_DONE', {
    jobId, category, price: budget,
    message: `🎉 Bid submitted! Job #${jobId} (${category}) @ ${budget}`
  });

} catch (err) {
  cleanup();
  notify('MARKETPLACE_ERROR', { jobId, message: `❌ Error: ${err.message}` });
  process.exit(1);
}
