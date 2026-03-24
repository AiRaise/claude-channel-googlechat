# Google Chat Channel — Access & Security

## Overview

The Google Chat channel plugin bridges Google Chat messages to your local Claude Code session via Google Cloud Pub/Sub. This document describes what the plugin accesses, how access control works, and security considerations.

## What the Server Reads

| Data | Source | Purpose |
|------|--------|---------|
| Chat messages | Cloud Pub/Sub subscription | Receive messages from Google Chat users |
| Sender email | Message metadata | Identify who sent the message for access control |
| Sender display name | Message metadata | Include in channel notifications |
| Thread information | Message metadata | Support threaded conversations |
| `access.json` | Local filesystem | Load access control configuration |
| Service account key | Local filesystem | Authenticate with Google APIs |

## What the Server Writes

| Data | Destination | Purpose |
|------|-------------|---------|
| Chat messages | Google Chat API | Send replies to users |
| `access.json` | Local filesystem | Persist access control changes (pairing, allowlist updates) |
| Diagnostic logs | stderr | Debugging and health monitoring |

## Network Access

| Endpoint | Protocol | Purpose |
|----------|----------|---------|
| `pubsub.googleapis.com` | HTTPS (gRPC) | Subscribe to Pub/Sub messages |
| `chat.googleapis.com` | HTTPS | Send messages via Google Chat API |

No other network connections are made. The server does not phone home or collect telemetry.

## Access Control (Sender Gating)

**An ungated channel is a prompt injection vector.** The plugin includes built-in sender gating to ensure only authorized users can communicate with your Claude Code session.

### Policies

| Policy | Behavior | Recommended For |
|--------|----------|-----------------|
| `allowlist` (default) | Only emails in `allowFrom` are accepted. All others are silently rejected. | Production use |
| `pairing` | Unknown senders receive a one-time code in Google Chat. The code must be entered in Claude Code to authorize them. | Shared spaces |
| `open` | All senders are accepted. | Testing only |

### Configuration

Access control is managed via `~/.claude/channels/googlechat/access.json`:

```json
{
  "policy": "allowlist",
  "allowFrom": ["alice@example.com", "bob@example.com"],
  "pendingPairings": {}
}
```

### Managing Access

Use the access skill in Claude Code:

```
/googlechat:access              # Show current settings
/googlechat:access allow <email>  # Add user to allowlist
/googlechat:access deny <email>   # Remove user from allowlist
/googlechat:access pair <code>    # Complete a pairing request
/googlechat:access policy <type>  # Change the access policy
```

### Pairing Flow

When `policy` is set to `pairing`:

1. An unknown user sends a message in Google Chat
2. The bot replies with a one-time pairing code (valid for 10 minutes)
3. The user (or an admin) runs `/googlechat:access pair <code>` in Claude Code
4. The user's email is added to the allowlist permanently
5. Subsequent messages from this user are accepted without pairing

### Default Behavior

On first install, the policy is `allowlist` with an empty list. **All messages are rejected until you explicitly add users.** This is the safest default.

## Credential Storage

| File | Location | Contains |
|------|----------|----------|
| Service account key | `~/.claude/channels/googlechat/service-account.json` | GCP service account credentials |
| Access config | `~/.claude/channels/googlechat/access.json` | Allowlist and policy settings |

These files are stored in your home directory and are not included in any repository. The plugin never logs or transmits credential contents.

## Threat Model

| Threat | Mitigation |
|--------|------------|
| Unauthorized messages (prompt injection) | Sender gating via allowlist/pairing |
| Credential leakage | Credentials stored locally, never in code |
| Message interception | All communication over HTTPS/TLS |
| Bot message loops | BOT sender type is always filtered |
| Pub/Sub message spoofing | GCP IAM controls who can publish to your topic |
