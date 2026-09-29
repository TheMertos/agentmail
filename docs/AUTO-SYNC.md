# Automatic sync and mailbox policy

AgentMail runs a background sync worker independently of AI requests. The worker periodically synchronizes every enabled account according to a durable mailbox policy.

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

## Worker behavior

- Starts with the MCP server process in Docker.
- Uses a per-account lock so two syncs cannot overlap.
- Runs incremental sync on the configured interval.
- Runs a full sync when a policy is created, `UIDVALIDITY` changes, or a checkpoint is invalid.
- Retries provider failures with exponential backoff.
- Exposes status, last successful sync, current folder, counts, and errors through MCP.
- Never blocks message reading while another account is syncing.
- Never sends mail as part of synchronization.

## MCP tools

```text
sync_policy_get(accountId)
sync_policy_set(accountId, policy)
mailbox_sync(accountId, mode)
mailbox_sync_all(mode)
sync_status(accountId)
```

`sync_policy_set` validates patterns and rejects a policy that would silently exclude all folders. Every policy change is audited.

## Local list semantics

The client’s mail list is built from the local mirror, not from the latest Inbox request. Search and thread operations can therefore cover all folders. Results indicate whether the account is currently syncing or stale.
