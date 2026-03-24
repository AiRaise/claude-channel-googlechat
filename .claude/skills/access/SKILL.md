# Google Chat Access Control

Manage who can send messages to Claude Code through Google Chat.

## Commands

### Show current access settings
Show the current access policy and allowed users.

Read the access configuration from `~/.claude/channels/googlechat/access.json` and display:
- Current policy (allowlist, pairing, or open)
- List of allowed users
- Any pending pairing requests

### Allow a user: `/googlechat:access allow <email>`
Add a user's email address to the allowlist.

1. Read `~/.claude/channels/googlechat/access.json`
2. Add the email to the `allowFrom` array (if not already present)
3. Save the updated config
4. Confirm: "Added <email> to the allowlist."

### Remove a user: `/googlechat:access deny <email>`
Remove a user's email address from the allowlist.

1. Read `~/.claude/channels/googlechat/access.json`
2. Remove the email from the `allowFrom` array
3. Also remove from `pendingPairings` if present
4. Save the updated config
5. Confirm: "Removed <email> from the allowlist."

### Complete pairing: `/googlechat:access pair <code>`
Approve a pending pairing request by entering the code shown in Google Chat.

1. Read `~/.claude/channels/googlechat/access.json`
2. Search `pendingPairings` for an entry matching the provided code
3. If found and not expired:
   - Add the email to `allowFrom`
   - Remove from `pendingPairings`
   - Save the config
   - Confirm: "Paired successfully! <email> is now authorized."
4. If not found or expired:
   - Report: "Invalid or expired pairing code."

### Set policy: `/googlechat:access policy <allowlist|pairing|open>`
Change the access control policy.

- **allowlist** (default): Only emails in `allowFrom` can send messages. Unknown senders are silently rejected.
- **pairing**: Unknown senders receive a pairing code in Google Chat. The code must be entered in Claude Code to authorize them.
- **open**: All senders are allowed. **Not recommended for production use.**

1. Read `~/.claude/channels/googlechat/access.json`
2. Update the `policy` field
3. Save the config
4. Confirm the change and explain the implications

## Access Config File

Location: `~/.claude/channels/googlechat/access.json`

```json
{
  "policy": "allowlist",
  "allowFrom": ["user@example.com"],
  "pendingPairings": {}
}
```

## Security Notes

- The default policy is `allowlist` with an empty list, meaning all messages are rejected until users are explicitly added.
- An ungated channel is a prompt injection vector. Always use `allowlist` or `pairing` policy in production.
- The `open` policy should only be used for testing in controlled environments.
