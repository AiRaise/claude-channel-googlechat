# Google Chat Plugin Configuration

Interactive setup wizard for the Google Chat channel plugin.

## When to use

Run this skill when setting up the Google Chat plugin for the first time, or when reconfiguring the connection.

## Setup Steps

### Step 1: Check Prerequisites

Verify the following are available:
- Google Cloud SDK (`gcloud`) is installed: run `gcloud version`
- A GCP project with billing enabled
- Node.js 18+ installed

If gcloud is not installed, provide instructions:
```bash
# macOS (Homebrew)
brew install google-cloud-sdk

# Then initialize
gcloud init
```

### Step 2: GCP Project Configuration

Ask the user for their GCP Project ID, or detect it:
```bash
gcloud config get project
```

### Step 3: Enable Required APIs

Run these commands to enable the necessary APIs:
```bash
gcloud services enable chat.googleapis.com --project=PROJECT_ID
gcloud services enable pubsub.googleapis.com --project=PROJECT_ID
```

### Step 4: Create Service Account

```bash
# Create service account
gcloud iam service-accounts create claude-chat-bot \
  --display-name="Claude Code Chat Bot" \
  --project=PROJECT_ID

# Generate key file
gcloud iam service-accounts keys create service-account.json \
  --iam-account=claude-chat-bot@PROJECT_ID.iam.gserviceaccount.com

# Move to config directory
mkdir -p ~/.claude/channels/googlechat
mv service-account.json ~/.claude/channels/googlechat/
```

### Step 5: Set Up Pub/Sub

```bash
# Create topic
gcloud pubsub topics create chat-messages --project=PROJECT_ID

# Grant Chat API permission to publish to the topic
gcloud pubsub topics add-iam-policy-binding chat-messages \
  --member="serviceAccount:chat-api-push@system.gserviceaccount.com" \
  --role="roles/pubsub.publisher" \
  --project=PROJECT_ID

# Create subscription
gcloud pubsub subscriptions create chat-messages-sub \
  --topic=chat-messages \
  --ack-deadline=60 \
  --project=PROJECT_ID

# Grant the service account permission to subscribe
gcloud pubsub subscriptions add-iam-policy-binding chat-messages-sub \
  --member="serviceAccount:claude-chat-bot@PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/pubsub.subscriber" \
  --project=PROJECT_ID
```

### Step 6: Create Google Chat App

Direct the user to the GCP Console:

1. Go to: https://console.cloud.google.com/apis/api/chat.googleapis.com/hangouts-chat?project=PROJECT_ID
2. Configure the Chat App:
   - **App name**: Choose a name (e.g., "Claude Assistant")
   - **Avatar URL**: Optional
   - **Description**: "Claude Code assistant"
   - **Functionality**: Check "Receive 1:1 messages" and "Join spaces and group conversations"
   - **Connection settings**: Select "Cloud Pub/Sub"
   - **Pub/Sub topic name**: `projects/PROJECT_ID/topics/chat-messages`
   - **Visibility**: Make available to specific people or your domain
3. Save the configuration

### Step 7: Configure Environment Variables

Create or update the plugin environment. Write the config file:

```bash
mkdir -p ~/.claude/channels/googlechat
```

Write `~/.claude/channels/googlechat/config.json`:
```json
{
  "gcpProjectId": "PROJECT_ID",
  "pubsubSubscription": "chat-messages-sub",
  "serviceAccountKey": "~/.claude/channels/googlechat/service-account.json"
}
```

Tell the user to set environment variables (e.g., in their shell profile or `.claude/.env`):
```bash
export GCP_PROJECT_ID="PROJECT_ID"
export PUBSUB_SUBSCRIPTION="chat-messages-sub"
export GOOGLE_APPLICATION_CREDENTIALS="$HOME/.claude/channels/googlechat/service-account.json"
```

### Step 8: Configure Access Control

Run `/googlechat:access allow <your-email>` to authorize yourself, or set the policy to "pairing":
```bash
# The access.json file will be created at:
# ~/.claude/channels/googlechat/access.json
```

### Step 9: Test the Connection

1. Open Google Chat and find the Chat App you created
2. Send a test message
3. Verify it appears in Claude Code

If the message doesn't arrive, check:
- Pub/Sub subscription has pending messages: `gcloud pubsub subscriptions pull chat-messages-sub --auto-ack --project=PROJECT_ID`
- Service account has the correct permissions
- The Chat App is configured with the correct Pub/Sub topic

## Troubleshooting

### "GOOGLE_APPLICATION_CREDENTIALS is not set"
Set the environment variable to point to your service account key file:
```bash
export GOOGLE_APPLICATION_CREDENTIALS="$HOME/.claude/channels/googlechat/service-account.json"
```

### "Permission denied" errors
Ensure the service account has:
- `roles/pubsub.subscriber` on the subscription
- `roles/chat.bot` (automatically granted when creating a Chat App)

### Messages not arriving
1. Check if the Chat App is properly configured with the Pub/Sub topic
2. Verify the subscription name matches `PUBSUB_SUBSCRIPTION`
3. Try pulling messages manually: `gcloud pubsub subscriptions pull SUBSCRIPTION_NAME --auto-ack`
