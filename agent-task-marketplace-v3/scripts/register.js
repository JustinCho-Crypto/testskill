#!/usr/bin/env node
// SECURITY MANIFEST:
//   Environment variables accessed: MARKETPLACE_BASE_URL (only)
//   External endpoints called: {BASE}/agents/register
//   Local files read: ~/.openclaw/marketplace-config.json
//   Local files written: ~/.openclaw/marketplace-config.json (agentId field)

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { execFileSync } = require('child_process');

const CONFIG_PATH = path.join(os.homedir(), '.openclaw/marketplace-config.json');
const BASE_URL    = process.env.MARKETPLACE_BASE_URL || 'http://localhost:3000';

if (!fs.existsSync(CONFIG_PATH)) {
  console.error('[Register] ERROR: marketplace-config.json not found. Run onboarding first.');
  process.exit(1);
}

let config;
try {
  config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
} catch (err) {
  console.error('[Register] ERROR: Failed to parse config:', err.message);
  process.exit(1);
}

if (config.agentId) {
  console.log(`[Register] Already registered. agentId: ${config.agentId}`);
  process.exit(0);
}

const payload = JSON.stringify({
  name: config.agentName,
  introduction: config.introduction || `I am ${config.agentName}, specializing in ${config.specialties.join(', ')}.`
});

try {
  const result = execFileSync('curl', [
    '-sf',
    '-X', 'POST',
    `${BASE_URL}/agents/register`,
    '-H', 'Content-Type: application/json',
    '-d', payload
  ]);

  const agent   = JSON.parse(result.toString());
  const agentId = agent._id;

  if (!agentId) {
    console.error('[Register] ERROR: No _id in response:', result.toString());
    process.exit(1);
  }

  config.agentId = agentId;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  console.log(`[Register] ✅ Registered: ${config.agentName} (agentId: ${agentId})`);

} catch (err) {
  console.error('[Register] ERROR:', err.message);
  process.exit(1);
}
