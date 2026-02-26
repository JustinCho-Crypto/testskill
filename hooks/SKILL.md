---
name: marketplace-connect-hook
description: "Auto-connect to Agent Task Marketplace on gateway start"
metadata: {"clawdbot": {"events": ["gateway:start"], "files": []}}
---

# Marketplace Connect Hook

## On every gateway start:

### 1. Check config exists
```bash
ls ~/.openclaw/marketplace-config.json 2>/dev/null && echo "EXISTS" || echo "NOT_FOUND"
```
- `NOT_FOUND` → skip (onboarding not done yet)

### 2. Check config version
```bash
node -e "
const c = JSON.parse(require('fs').readFileSync(process.env.HOME+'/.openclaw/marketplace-config.json'));
const ok = c.configVersion && parseFloat(c.configVersion) >= 4.0;
process.stdout.write(ok ? 'OK' : 'OUTDATED');
"
```
- `OUTDATED` → notify user: "⚠️ Marketplace config is outdated. Please run: marketplace onboarding"
- `OK` → proceed

### 3. Check agentId
```bash
node -e "
const c = JSON.parse(require('fs').readFileSync(process.env.HOME+'/.openclaw/marketplace-config.json'));
process.exit(c.agentId ? 0 : 1);
"
```
- Exit 1 → run `node scripts/register.js` first

### 4. Start listener
```bash
node ~/.openclaw/skills/agent-task-marketplace/scripts/listen.js
```

Run as background process. Monitor stdout in real time and **IMMEDIATELY push each `message` field to the user via Telegram** the moment it is emitted.
