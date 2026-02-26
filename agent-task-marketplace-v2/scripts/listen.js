#!/usr/bin/env node
// SECURITY MANIFEST:
//   Environment variables accessed: MARKETPLACE_BASE_URL (only)
//   External endpoints called: {BASE}/ws (Socket.IO)
//   Local files read: ~/.openclaw/marketplace-config.json
//   Local files written: /tmp/marketplace_pending.json

'use strict';

const { io } = require('socket.io-client');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const CONFIG_PATH  = path.join(os.homedir(), '.openclaw/marketplace-config.json');
const PENDING_PATH = '/tmp/marketplace_pending.json';
const BASE_URL     = process.env.MARKETPLACE_BASE_URL || 'http://localhost:3000';

// ─── Notify helper ────────────────────────────────────────────────────────
// All status updates go through this single function.
// OpenClaw reads stdout line-by-line and relays each JSON event to Telegram.
function notify(type, payload = {}) {
  const line = JSON.stringify({ type, ts: new Date().toISOString(), ...payload });
  process.stdout.write(line + '\n');
  process.stderr.write(`[${type}] ${JSON.stringify(payload)}\n`);
}

// ─── Category fuzzy matching ──────────────────────────────────────────────
const CATEGORY_GROUPS = {
  visual: [
    'image_generation','illustration','art','drawing','design',
    'graphic','graphic_design','photo','photography','animation',
    'video','render','rendering','concept_art','sketch','painting'
  ],
  writing: [
    'copywriting','writing','content','blog','article',
    'editing','proofreading','storytelling','script','scriptwriting',
    'social_media','marketing_copy','ux_writing'
  ],
  translation: ['translation','translate','localization','l10n','i18n','subtitling'],
  code: [
    'code','coding','programming','development','software',
    'web','app','backend','frontend','fullstack','api','automation'
  ],
  data: [
    'data_analysis','data','analysis','research','statistics',
    'excel','spreadsheet','reporting','visualization','dashboard'
  ]
};

function getGroup(cat) {
  const n = cat.toLowerCase().replace(/[-\s]/g, '_');
  for (const [g, aliases] of Object.entries(CATEGORY_GROUPS)) {
    if (aliases.includes(n)) return g;
  }
  return null;
}

function calcMatch(jobCategory, specialties) {
  const n = jobCategory.toLowerCase().replace(/[-\s]/g, '_');
  const jobGroup = getGroup(n);
  if (specialties.map(s => s.toLowerCase()).includes(n)) {
    return { score: 100, label: 'Exact match' };
  }
  if (jobGroup && specialties.some(s => getGroup(s) === jobGroup)) {
    return { score: 80, label: `Related domain (${jobGroup})` };
  }
  return { score: 0, label: 'No overlap' };
}

function outlook(score) {
  if (score === 100) return '✅ Very likely to deliver well';
  if (score >= 80)   return '🟡 Related skill — likely manageable';
  return '❌ Outside my skill set';
}

// ─── Pending jobs ─────────────────────────────────────────────────────────
function loadPending() {
  try {
    return fs.existsSync(PENDING_PATH)
      ? JSON.parse(fs.readFileSync(PENDING_PATH, 'utf-8'))
      : {};
  } catch { return {}; }
}

function savePending(p) { fs.writeFileSync(PENDING_PATH, JSON.stringify(p, null, 2)); }

function addPending(job) {
  const p = loadPending();
  p[job._id] = { job, receivedAt: new Date().toISOString() };
  savePending(p);
}

// ─── Validate config ──────────────────────────────────────────────────────
if (!fs.existsSync(CONFIG_PATH)) {
  notify('MARKETPLACE_ERROR', { message: 'marketplace-config.json not found. Run onboarding first.' });
  process.exit(1);
}

let config;
try {
  config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
} catch (err) {
  notify('MARKETPLACE_ERROR', { message: `Failed to parse config: ${err.message}` });
  process.exit(1);
}

if (!config.agentId) {
  notify('MARKETPLACE_ERROR', { message: 'agentId not found. Run register.js first.' });
  process.exit(1);
}

// ─── Socket.IO daemon ─────────────────────────────────────────────────────
notify('MARKETPLACE_STARTING', {
  agent: config.agentName,
  agentId: config.agentId,
  specialties: config.specialties,
  maxBudget: config.maxBudget,
  server: BASE_URL,
  message: `🚀 Starting marketplace listener for ${config.agentName}...`
});

const socket = io(BASE_URL, {
  path: '/ws',
  auth: { agentId: config.agentId },
  reconnection: true,
  reconnectionDelay: 3000,
  reconnectionDelayMax: 30000
});

socket.on('connect', () => {
  notify('MARKETPLACE_CONNECTED', {
    message: `🔌 Connected to marketplace. Waiting for jobs...`
  });
});

socket.on('disconnect', (reason) => {
  notify('MARKETPLACE_DISCONNECTED', {
    reason,
    message: `⚠️ Disconnected (${reason}). Reconnecting...`
  });
});

socket.on('connect_error', (err) => {
  notify('MARKETPLACE_ERROR', {
    message: `❌ Connection error: ${err.message}`
  });
});

socket.on('ping', () => {
  socket.emit('pong');
  notify('MARKETPLACE_HEARTBEAT', { message: `💓 Heartbeat sent` });
});

socket.on('new-job', (job) => {
  const jobId    = job._id;
  const category = job.spec?.style || job.spec?.purpose || 'unknown';
  const budget   = job.spec?.budget ?? 0;
  const desc     = job.spec?.description || '(no description)';

  notify('MARKETPLACE_JOB_RECEIVED', {
    jobId, category, budget,
    message: `📨 New job received — ${category} / budget: ${budget}`
  });

  // Hard skip: budget exceeded
  if (budget > config.maxBudget) {
    notify('MARKETPLACE_JOB_SKIPPED', {
      jobId, reason: 'budget_exceeded',
      message: `⏭ Skipped — budget ${budget} exceeds my max ${config.maxBudget}`
    });
    return;
  }

  const { score, label } = calcMatch(category, config.specialties);

  // Hard skip: no overlap
  if (score === 0) {
    notify('MARKETPLACE_JOB_SKIPPED', {
      jobId, category, score, reason: 'no_skill_overlap',
      message: `⏭ Skipped — "${category}" doesn't match my skills (${config.specialties.join(', ')})`
    });
    return;
  }

  // Eligible — save to pending, ask user
  addPending(job);

  notify('MARKETPLACE_JOB_PENDING', {
    jobId, category, budget, description: desc,
    matchScore: score, matchLabel: label,
    assessment: outlook(score),
    message: [
      `📋 New job — awaiting your decision`,
      ``,
      `  Job ID   : ${jobId}`,
      `  Category : ${category}`,
      `  Budget   : ${budget}`,
      `  Desc     : ${desc}`,
      ``,
      `  Match    : ${score}% — ${label}`,
      `  My skills: ${config.specialties.join(', ')}`,
      `  Outlook  : ${outlook(score)}`,
      ``,
      `Should I bid?`,
      `  ✅ Yes → bid ${jobId}`,
      `  ❌ No  → skip ${jobId}`
    ].join('\n')
  });
});

process.on('SIGINT', () => {
  notify('MARKETPLACE_STOPPED', { message: '🛑 Marketplace listener stopped.' });
  socket.disconnect();
  process.exit(0);
});
