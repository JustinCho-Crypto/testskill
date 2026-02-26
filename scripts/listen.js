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
const CONFIG_VERSION = '4.0';

// ─── Notify ───────────────────────────────────────────────────────────────
function notify(type, payload = {}) {
  process.stdout.write(JSON.stringify({ type, ts: new Date().toISOString(), ...payload }) + '\n');
  process.stderr.write(`[${type}] ${payload.message || ''}\n`);
}

// ─── Category matching (3-tier) ───────────────────────────────────────────
const CATEGORY_GROUPS = {
  visual: [
    'image_generation','illustration','art','drawing','design',
    'graphic','graphic_design','photo','photography','animation',
    'video','render','rendering','concept_art','sketch','painting',
    'anime','digital_art','character','character_design','webtoon',
    'manhwa','manga','portrait','thumbnail','banner','logo',
    'icon','sprite','texture','storyboard',
    '일러스트','그림','이미지','캐릭터','디자인','웹툰'
  ],
  writing: [
    'copywriting','writing','content','blog','article',
    'editing','proofreading','storytelling','script','scriptwriting',
    'social_media','marketing_copy','ux_writing','caption','tagline',
    'newsletter','press_release','resume','cover_letter',
    '글쓰기','카피'
  ],
  translation: [
    'translation','translate','localization','l10n','i18n',
    'subtitling','subtitle','dubbing','번역','현지화'
  ],
  code: [
    'code','coding','programming','development','software',
    'web','app','backend','frontend','fullstack','api',
    'automation','script','bot','plugin','debugging','refactor',
    '개발','코딩','프로그래밍'
  ],
  data: [
    'data_analysis','data','analysis','research','statistics',
    'excel','spreadsheet','reporting','visualization','dashboard',
    'scraping','crawling','survey','분석','데이터','리서치'
  ]
};

function getGroup(token) {
  const n = token.toLowerCase().replace(/[-\s]/g, '_');
  for (const [group, aliases] of Object.entries(CATEGORY_GROUPS)) {
    if (aliases.includes(n)) return group;
    if (aliases.some(a => a.includes(n) || n.includes(a))) return group;
  }
  return null;
}

function tokenize(cat) {
  return cat.toLowerCase().replace(/[-\s]/g, '_').split('_').filter(t => t.length > 2);
}

function calcMatch(jobCategory, capabilities) {
  const groups = Object.keys(capabilities).filter(k => k !== 'default');
  const jobNorm = jobCategory.toLowerCase().replace(/[-\s]/g, '_');
  const jobTokens = tokenize(jobCategory);

  // Expand groups to all their aliases for exact check
  const allSpecialties = groups.flatMap(g => CATEGORY_GROUPS[g] || []);

  // Tier 1: exact
  if (allSpecialties.includes(jobNorm)) {
    return { score: 100, label: 'Exact match', group: getGroup(jobNorm) };
  }

  // Tier 2: full string in same group
  const jobGroup = getGroup(jobNorm);
  if (jobGroup && groups.includes(jobGroup)) {
    return { score: 80, label: `Same domain (${jobGroup})`, group: jobGroup };
  }

  // Tier 3: token-level overlap
  for (const token of jobTokens) {
    const tokenGroup = getGroup(token);
    if (tokenGroup && groups.includes(tokenGroup)) {
      return { score: 50, label: `Partial match — "${token}" in ${tokenGroup}`, group: tokenGroup };
    }
  }

  // Check default fallback
  if (capabilities.default) {
    return { score: 30, label: 'No direct match — using default executor', group: 'default' };
  }

  return { score: 0, label: 'No overlap', group: null };
}

function outlook(score) {
  if (score === 100) return '✅ Exact specialty';
  if (score >= 80)   return '🟡 Same domain';
  if (score >= 50)   return '🟠 Partial match';
  if (score >= 30)   return '⚪ Default executor';
  return '❌ Outside skill set';
}

// ─── Pending ──────────────────────────────────────────────────────────────
function loadPending() {
  try {
    return fs.existsSync(PENDING_PATH)
      ? JSON.parse(fs.readFileSync(PENDING_PATH, 'utf-8')) : {};
  } catch { return {}; }
}

function addPending(job, matchGroup) {
  const p = loadPending();
  p[job._id] = { job, matchGroup, receivedAt: new Date().toISOString() };
  fs.writeFileSync(PENDING_PATH, JSON.stringify(p, null, 2));
}

// ─── Config validation ────────────────────────────────────────────────────
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

// Config version check
if (!config.configVersion || config.configVersion < CONFIG_VERSION) {
  notify('MARKETPLACE_CONFIG_OUTDATED', {
    currentVersion: config.configVersion || 'unknown',
    requiredVersion: CONFIG_VERSION,
    message: [
      `⚠️ Config is outdated (v${config.configVersion || '?'} → v${CONFIG_VERSION} required).`,
      `Please run: marketplace reset-config`,
      `Or tell me: "run marketplace onboarding"`
    ].join('\n')
  });
  process.exit(1);
}

if (!config.agentId) {
  notify('MARKETPLACE_ERROR', { message: 'agentId not found. Run register.js first.' });
  process.exit(1);
}

if (!config.capabilities || Object.keys(config.capabilities).length === 0) {
  notify('MARKETPLACE_ERROR', { message: 'No capabilities configured. Run onboarding again.' });
  process.exit(1);
}

// ─── Socket.IO daemon ─────────────────────────────────────────────────────
notify('MARKETPLACE_STARTING', {
  agent: config.agentName,
  agentId: config.agentId,
  capabilities: Object.keys(config.capabilities),
  minBudget: config.minBudget,
  server: BASE_URL,
  message: `🚀 Starting — ${config.agentName} | groups: ${Object.keys(config.capabilities).join(', ')}`
});

const socket = io(BASE_URL, {
  path: '/ws',
  auth: { agentId: config.agentId },
  reconnection: true,
  reconnectionDelay: 3000,
  reconnectionDelayMax: 30000
});

socket.on('connect', () => {
  notify('MARKETPLACE_CONNECTED', { message: '🔌 Connected. Waiting for jobs...' });
});

socket.on('disconnect', (reason) => {
  notify('MARKETPLACE_DISCONNECTED', { reason, message: `⚠️ Disconnected (${reason}). Reconnecting...` });
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
    message: `📨 New job — ${category} / ${budget}`
  });

  // Filter 1: minBudget
  const minBudget = config.minBudget ?? 0;
  if (budget < minBudget) {
    notify('MARKETPLACE_JOB_SKIPPED', {
      jobId, reason: 'below_min_budget',
      message: `⏭ Skipped — budget ${budget} below minimum ${minBudget}`
    });
    return;
  }

  // Filter 2: 3-tier match
  const { score, label, group } = calcMatch(category, config.capabilities);

  if (score === 0) {
    notify('MARKETPLACE_JOB_SKIPPED', {
      jobId, category, score, reason: 'no_skill_overlap',
      message: `⏭ Skipped — "${category}" has no overlap with configured capabilities`
    });
    return;
  }

  addPending(job, group);

  notify('MARKETPLACE_JOB_PENDING', {
    jobId, category, budget, description: desc,
    matchScore: score, matchLabel: label, matchGroup: group,
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
      `  Executor : ${group} → ${config.capabilities[group]?.api || config.capabilities[group]}`,
      `  Outlook  : ${outlook(score)}`,
      ``,
      `  ✅ bid ${jobId}`,
      `  ❌ skip ${jobId}`
    ].join('\n')
  });
});

process.on('SIGINT', () => {
  notify('MARKETPLACE_STOPPED', { message: '🛑 Stopped.' });
  socket.disconnect();
  process.exit(0);
});
