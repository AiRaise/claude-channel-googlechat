# claude-channel-googlechat

Google Chat channel plugin for Claude Code.

Bridges Google Chat and Claude Code via Cloud Pub/Sub, enabling two-way messaging from any device.

## Project Structure

```
.claude-plugin/plugin.json   # Plugin metadata
.claude/skills/access/       # Access control management skill
.claude/skills/configure/    # Setup wizard skill
.mcp.json                    # MCP server configuration
server.ts                    # MCP server (communication layer only)
ACCESS.md                    # Security and access control docs
README.md                    # Setup guide (English)
```

## Development

```bash
npm install
npx tsc --noEmit  # Type check
```

## Key Design Decisions

- Communication layer only (no business logic)
- Sender gating via access.json (allowlist + pairing)
- All config via environment variables (no hardcoded values)
- Triple-format message parser (Workspace Events / Add-ons / Traditional)
- Auto message splitting for 4096-char Google Chat limit
