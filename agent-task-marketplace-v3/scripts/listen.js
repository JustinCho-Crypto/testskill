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
function notify(type, payload = {}) {
  process.stdout.write(JSON.stringify({ type, ts: new Date().toISOString(), ...payload }) + '\n');
  process.stderr.write(`[${type}] ${payload.message || ''}\n`);
}

// ─── Category matching (3-tier) ───────────────────────────────────────────
const CATEGORY_GROUPS = {
  visual: [
    'image_generation', 'illustration', 'art', 'drawing', 'design',
    'graphic', 'graphic_design', 'photo', 'photography', 'animation',
    'video', 'render', 'rendering', 'concept_art', 'sketch', 'painting',
    'anime', 'digital_art', 'character', 'character_design', 'webtoon',
    'manhwa', 'manga', 'portrait', 'thumbnail', 'banner', 'logo',
    'icon', 'sprite', 'texture', 'storyboard',
    '일러스트', '그림', '이미지', '캐릭터', '디자인', '웹툰'
  ],
  writing: [
    'copywriting', 'writing', 'content', 'blog', 'article',
    'editing', 'proofreading', 'storytelling', 'script', 'scriptwriting',
    'social_media', 'marketing_copy', 'ux_writing', 'caption', 'tagline',
    'newsletter', 'press_release', 'resume', 'cover_letter',
    '글쓰기', '카피', '번역제외작문'
  ],
  translation: [
    'translation', 'translate', 'localization', 'l10n', 'i18n',
    'subtitling', 'subtitle', 'dubbing',
    '번역', '현지화'
  ],
  code: [
    'code', 'coding', 'programming', 'development', 'software',
    'web', 'app', 'backend', 'frontend', 'fullstack', 'api',
    'automation', 'script', 'bot', 'plugin', 'extension',
    'debugging', 'refactor', 'review',
    '개발', '코딩', '프로그래밍'
  ],
  data: [
    'data_analysis', 'data', 'analysis', 'research', 'statistics',
    'excel', 'spreadsheet', 'reporting', 'visualization', 'dashboard',
    'scraping', 'crawling', 'survey',
    '분석', '데이터', '리서치'
  ]
};

// Get group for a single normalized token
function getGroup(token) {
  for (const [group, aliases] of Object.entries(CATEGORY_GROUPS)) {
    if (aliases.includes(token)) return group;
    // substring check within group aliases
    if (aliases.some(a => a.includes(token) || token.includes(a))) return group;
  }
  return null;
}

// Tokenize a category string
function tokenize(cat) {
  return cat.toLowerCase().replace(/[-\s]/g, '_').split('_').filter(t => t.length > 2);
}

/**
 * 3-tier match:
 *  100 — exact specialty match
 *   80 — same group (full category string in group)
 *   50 — token-level group overlap (partial substring within same group)
 *    0 — no overlap
 */
function calcMatch(jobCategory, specialties) {
  const jobNorm   = jobCategory.toLowerCase().replace(/[-\s]/g, '_');
  const jobTokens = tokenize(jobCategory);

  // Tier 1: exact
  if (specialties.map(s => s.toLowerCase()).includes(jobNorm)) {
    return { score: 100, label: 'Exact match' };
  }

  // Tier 2: same group (full string)
  const jobGroup = getGroup(jobNorm);
  if (jobGroup && specialties.some(s => getGroup(s.toLowerCase()) === jobGroup)) {
    return { score: 80, label: `Same domain (${jobGroup})` };
  }

  // Tier 3: token-level group overlap
  for (const token of jobTokens) {
    const tokenGroup = getGroup(token);
    if (tokenGroup && specialties.some(s => getGroup(s.toLowerCase()) === tokenGroup)) {
      return { score: 50, label: `Partial match — "${token}" in ${tokenGroup}` };
    }
  }

  return { score: 0, label: 'No overlap' };
}

function outlook(score) {
  if (score === 100) return '✅ Exact specialty — very likely to deliver well';
  if (score >= 80)   return '🟡 Same domain — likely manageable';
  if (score >= 50)   return '🟠 Partial match — may be able to handle';
  return '❌ Outside skill set';
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
  minBudget: config.minBudget,
  server: BASE_URL,
  message: `🚀 Starting marketplace listener — ${config.agentName}`
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
    message: '🔌 Connected to marketplace. Waiting for jobs...'
  });
});

socket.on('disconnect', (reason) => {
  notify('MARKETPLACE_DISCONNECTED', {
    reason,
    message: `⚠️ Disconnected (${reason}). Reconnecting...`
  });
});

socket.on('connect_error', (err) => {
  notify('MARKETPLACE_ERROR', { message: `❌ Connection error: ${err.message}` });
});

socket.on('ping', () => {
  socket.emit('pong');
  notify('MARKETPLACE_HEARTBEAT', { message: '💓 Heartbeat sent' });
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

  // Filter 1: minBudget
  if (config.minBudget && budget < config.minBudget) {
    notify('MARKETPLACE_JOB_SKIPPED', {
      jobId, reason: 'below_min_budget',
      message: `⏭ Skipped — budget ${budget} is below minimum ${config.minBudget}`
    });
    return;
  }

  // Filter 2: specialty match (3-tier)
  const { score, label } = calcMatch(category, config.specialties);

  if (score === 0) {
    notify('MARKETPLACE_JOB_SKIPPED', {
      jobId, category, score, reason: 'no_skill_overlap',
      message: `⏭ Skipped — "${category}" has no overlap with skills (${config.specialties.join(', ')})`
    });
    return;
  }

  // Eligible — save to pending and notify user
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
