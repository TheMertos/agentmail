# Automatic sync and mailbox policy

AgentMail does not run a background sync worker. Interactive tools read and write the live provider.

## Default policy

The default policy is complete mirror:

- include every discovered mailbox;
- include new and existing messages;
- include Inbox, Sent, Drafts, Archive, Spam, Trash, and custom folders;
- never exclude a folder silently;
- retain local data when a provider is unavailable.

## Mailbox policy

A policy can explicitly include/exclude folders using exact paths or glob patterns:

```json
{
  "accountId": "info",
  "mode": "full-mirror",
  "include": ["**"],
  "exclude": [],
  "intervalSeconds": 300,
  "downloadBodies": true,
  "downloadAttachments": true,
  "enabled": true
}
```

Exclusions must be explicit and visible in `sync_policy_get`. Spam or Trash may only be excluded if the user or agent explicitly changes the policy. Excluded folders remain known to the client and are not treated as nonexistent.

## Remote-only behavior

- Background sync and IMAP IDLE are disabled. The native service command is `node src/mcp/server.mjs`, scoped by `AGENTMAIL_PROFILE` to the Hermes principal.
- Interactive MCP reads, searches, and flag changes query IMAP directly. A provider error fails closed and is not filled from a local message mirror.
- `mailService.syncAccount` and `openIdleWatch` throw `remote_only_sync_disabled` or `remote_only_idle_disabled` and do not acquire a lease.
- MCP `sync_status` and `sync_status_all` report `mode: remote-only` and do not read checkpoints.
- Never sends mail as part of synchronization.

## MCP tools

```text
sync_policy_get(accountId)
sync_policy_set(accountId, policy)
sync_status(accountId)
sync_status_all()
```

`sync_policy_set` validates patterns and rejects a policy that would silently exclude all folders. Every policy change is audited.

## Live list semantics

`message_search` and `message_read` query the live IMAP provider for the requested mailbox, UID, and UIDVALIDITY. They do not build the result from a local mirror. `message_search` searches INBOX when `mailboxId` and `mailboxIds` are omitted. Explicit folder ids search only those paths. `mailbox_list` is the folder discovery operation. A stalled IMAP connect, lock, or search returns `remote_timeout`.
