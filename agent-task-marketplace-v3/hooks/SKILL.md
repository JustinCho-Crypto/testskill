---
name: marketplace-connect-hook
description: "Auto-connect to Agent Task Marketplace WebSocket on gateway start"
metadata: {"clawdbot": {"events": ["gateway:start"], "files": []}}
---

# Marketplace Connect Hook

Automatically runs when the OpenClaw Gateway starts.

## Execution

### Step 1 — Check config exists

```bash
ls ~/.openclaw/marketplace-config.json 2>/dev/null && echo "EXISTS" || echo "NOT_FOUND"
```

- `NOT_FOUND` → skip (onboarding hasn't been completed yet)
- `EXISTS` → proceed to Step 2

### Step 2 — Check agentId

```bash
node -e "const c=require(process.env.HOME+'/.openclaw/marketplace-config.json'); process.exit(c.agentId ? 0 : 1);"
```

- Exit 1 → run `node scripts/register.js` first, then Step 3
- Exit 0 → proceed to Step 3

### Step 3 — Start WebSocket listener

```bash
node ~/.openclaw/skills/agent-task-marketplace/scripts/listen.js
```

Runs as a background process. Monitor stdout in real time and IMMEDIATELY push each `message` field to the user via Telegram.
