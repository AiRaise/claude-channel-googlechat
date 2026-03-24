# Plugin Submission Checklist

Pre-submission checklist for the Google Chat channel plugin.

## Submission URL

- https://clau.de/plugin-directory-submission
- Or: https://claude.ai/settings/plugins/submit

## Required Files

- [x] `.claude-plugin/plugin.json` — Plugin metadata (name, version, description, keywords)
- [x] `.mcp.json` — MCP server configuration with `${CLAUDE_PLUGIN_ROOT}`
- [x] `server.ts` — MCP server implementation
- [x] `package.json` — Dependencies and metadata
- [x] `tsconfig.json` — TypeScript configuration
- [x] `LICENSE` — MIT license
- [x] `README.md` — English, with setup guide
- [x] `ACCESS.md` — Access control documentation
- [x] `.claude/skills/configure/SKILL.md` — Configuration wizard
- [x] `.claude/skills/access/SKILL.md` — Access control management

## Security Checklist

- [x] Sender gating implemented (access.json with allowlist/pairing)
- [x] Default policy is `allowlist` with empty list (reject all by default)
- [x] Pairing flow implemented for unknown senders
- [x] BOT messages are filtered (no message loops)
- [x] No hardcoded credentials or project IDs
- [x] All configuration via environment variables
- [x] Service account key stored locally, never in code
- [x] No telemetry or external data collection

## Code Quality

- [ ] `npx tsc --noEmit` passes with no errors
- [ ] No AiRaise-specific information: `grep -ri "airaise\|ai-raise\|komatsubara\|arimizu\|calm-vehicle\|meeting-bot" .`
- [ ] No hardcoded paths: `grep -ri "/Users/" .`
- [ ] No Japanese text in server.ts (messages are English)
- [ ] plugin.json matches Telegram format (name, version, description, keywords only)
- [ ] .mcp.json uses `${CLAUDE_PLUGIN_ROOT}`

## Functional Testing

- [ ] Plugin starts without errors with valid env vars
- [ ] Plugin fails gracefully with missing env vars (clear error message)
- [ ] Messages from allowed users are delivered to Claude Code
- [ ] Messages from unauthorized users are rejected
- [ ] Pairing flow works (send code, pair, subsequent messages accepted)
- [ ] Reply tool sends messages to Google Chat
- [ ] Long messages are split correctly
- [ ] Threaded replies work
- [ ] Thread key creates new threads

## Submission Form Fields

| Field | Value |
|-------|-------|
| Plugin name | `googlechat` |
| Repository URL | `https://github.com/airaise/claude-channel-googlechat` |
| Description | Google Chat channel for Claude Code — messaging bridge via Cloud Pub/Sub with built-in access control. |
| Category | Channel |
| License | MIT |
| Author | AiRaise Inc. |
| Contact | info@ai-raise.jp |

## Post-Submission

- [ ] Monitor for review feedback
- [ ] Respond to security review questions promptly
- [ ] If rejected, address all feedback and resubmit
- [ ] After approval, test installation via `claude plugin install googlechat`
