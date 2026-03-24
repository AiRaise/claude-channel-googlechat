# Google Chat Channel for Claude Code

A channel plugin that connects [Claude Code](https://claude.com/claude-code) to [Google Chat](https://chat.google.com/) via Cloud Pub/Sub. Send messages from Google Chat on your phone or desktop, and Claude Code responds autonomously.

## Architecture

```
Google Chat  --->  Cloud Pub/Sub  --->  Claude Code (local)
   (user)          (GCP topic)         (this plugin)
                                            |
Google Chat  <---  Chat API      <---  reply tool
   (user)          (service acct)
```

The plugin is a **communication layer only**. All business logic lives in your Claude Code session (via CLAUDE.md, skills, etc.).

## Prerequisites

- **Claude Code** installed and working
- **Google Workspace** account (Google Chat Apps require Workspace; personal Gmail is not supported)
- **GCP project** with billing enabled
- **Node.js 18+** or **Bun** runtime
- **gcloud CLI** (recommended for setup)

## Quick Start

### 1. Install the Plugin

```bash
claude plugin install googlechat
```

### 2. Run the Configuration Wizard

```
/googlechat:configure
```

This will guide you through:
1. GCP project setup
2. Enabling Google Chat API and Cloud Pub/Sub API
3. Creating a service account
4. Setting up Pub/Sub topic and subscription
5. Creating the Google Chat App
6. Configuring environment variables
7. Setting up access control

### 3. Set Environment Variables

```bash
export GCP_PROJECT_ID="your-project-id"
export PUBSUB_SUBSCRIPTION="your-subscription-name"
export GOOGLE_APPLICATION_CREDENTIALS="$HOME/.claude/channels/googlechat/service-account.json"
```

### 4. Authorize Users

```
/googlechat:access allow your-email@company.com
```

### 5. Test

Send a message in Google Chat to your bot. It should appear in Claude Code.

## Configuration

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GCP_PROJECT_ID` | Yes | Your Google Cloud project ID |
| `PUBSUB_SUBSCRIPTION` | Yes | Cloud Pub/Sub subscription name |
| `GOOGLE_APPLICATION_CREDENTIALS` | Yes | Path to service account JSON key |
| `GOOGLECHAT_CONFIG_DIR` | No | Config directory (default: `~/.claude/channels/googlechat`) |
| `DISABLE_PUBSUB` | No | Set to `1` to disable Pub/Sub listener |

### Access Control

The plugin includes built-in sender gating to prevent unauthorized access. See [ACCESS.md](ACCESS.md) for full details.

**Policies:**

| Policy | Description |
|--------|-------------|
| `allowlist` (default) | Only pre-approved email addresses can send messages |
| `pairing` | Unknown users receive a one-time code to pair with Claude Code |
| `open` | All users accepted (testing only, **not recommended**) |

**Commands:**

```
/googlechat:access              # Show current settings
/googlechat:access allow <email>  # Add user to allowlist
/googlechat:access deny <email>   # Remove user
/googlechat:access pair <code>    # Complete pairing
/googlechat:access policy <type>  # Change policy
```

## GCP Setup Guide

If you prefer manual setup over the configuration wizard:

### 1. Create a GCP Project

```bash
gcloud projects create my-claude-chat --name="Claude Chat"
gcloud config set project my-claude-chat
# Enable billing at https://console.cloud.google.com/billing
```

### 2. Enable APIs

```bash
gcloud services enable chat.googleapis.com
gcloud services enable pubsub.googleapis.com
```

### 3. Create Service Account

```bash
gcloud iam service-accounts create claude-chat-bot \
  --display-name="Claude Code Chat Bot"

gcloud iam service-accounts keys create service-account.json \
  --iam-account=claude-chat-bot@PROJECT_ID.iam.gserviceaccount.com

mkdir -p ~/.claude/channels/googlechat
mv service-account.json ~/.claude/channels/googlechat/
```

### 4. Set Up Pub/Sub

```bash
# Create topic
gcloud pubsub topics create chat-messages

# Allow Google Chat to publish
gcloud pubsub topics add-iam-policy-binding chat-messages \
  --member="serviceAccount:chat-api-push@system.gserviceaccount.com" \
  --role="roles/pubsub.publisher"

# Create subscription
gcloud pubsub subscriptions create chat-messages-sub \
  --topic=chat-messages \
  --ack-deadline=60

# Allow service account to subscribe
gcloud pubsub subscriptions add-iam-policy-binding chat-messages-sub \
  --member="serviceAccount:claude-chat-bot@PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/pubsub.subscriber"
```

### 5. Create Google Chat App

1. Go to [Chat API Configuration](https://console.cloud.google.com/apis/api/chat.googleapis.com/hangouts-chat)
2. Fill in:
   - **App name**: Your bot's name
   - **Functionality**: Enable "Receive 1:1 messages" and "Join spaces and group conversations"
   - **Connection settings**: Cloud Pub/Sub
   - **Pub/Sub topic**: `projects/PROJECT_ID/topics/chat-messages`
   - **Visibility**: Your domain or specific users
3. Save

## Message Formats

The plugin supports three Pub/Sub message formats:

| Format | Source | Description |
|--------|--------|-------------|
| Workspace Events API | CloudEvents via Pub/Sub | Recommended. Receives all messages without @mention |
| Workspace Add-ons | Cloud Function relay | Legacy. Requires @mention or 1:1 DM |
| Traditional | Direct Cloud Function | Legacy. Requires @mention or 1:1 DM |

All formats are auto-detected. You can use any of them depending on your setup.

## Tools

The plugin provides a single tool:

### `reply`

Send a message to Google Chat.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `chat_id` | Yes | Google Chat space name from `meta.chat_id` |
| `text` | Yes | Message text (auto-split if >4096 chars) |
| `thread` | No | Thread name for reply (from `meta.thread`) |
| `thread_key` | No | Client-assigned key to create/find a thread |

## Troubleshooting

### Plugin won't start

- Check all required environment variables are set
- Verify the service account key file exists at the specified path
- Run `npx tsx server.ts` directly to see error messages

### Messages not arriving

1. Check Pub/Sub has messages: `gcloud pubsub subscriptions pull YOUR_SUB --auto-ack`
2. Verify the Chat App's Pub/Sub topic matches your topic
3. Check service account permissions on the subscription
4. Look at stderr output for `[googlechat]` log messages

### "Access denied" for your messages

- Run `/googlechat:access allow your-email@company.com`
- Or set policy to `pairing`: `/googlechat:access policy pairing`

### Reply fails with 403

- The service account needs `roles/chat.bot` (auto-granted when creating Chat App)
- Ensure the bot is added to the Google Chat space

## Costs

Cloud Pub/Sub has a [free tier](https://cloud.google.com/pubsub/pricing) (10 GB/month). Typical chat usage stays well within the free tier. Google Chat API itself has no additional charges.

## License

[MIT](LICENSE)
