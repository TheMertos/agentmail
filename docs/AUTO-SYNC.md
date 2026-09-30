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

- Runs as the long-lived Docker container process (`src/worker/sync-runtime-worker.mjs`), scoped by `AGENTMAIL_PROFILE` to the provisioned principal.
- MCP `docker exec` sessions are short-lived stdio attachments only. They do not enqueue sync work, and exiting MCP does not stop or hand off the sync worker.
- The worker's scheduler lists accounts from its own registry, applies mailbox policy, and calls `mailService.syncAccount`.
- `mailService` resolves a SecretFabric IMAP lease for that account's `secretRef` inside the worker process and downloads mail.
- The sync interval only receives mail. It does not send.
- Runs incremental sync on the configured interval (default 300 seconds), including the first cycle at startup. That interval stays in place when IDLE is unavailable.
- For each enabled account, the worker also opens one dedicated Inbox IDLE connection. That connection is not the sync client. `EXISTS` and `EXPUNGE` schedule one incremental sync after a short debounce.
- Each account has one sync lock, so the interval cycle and an IDLE wake cannot sync that account at the same time.
- IDLE credentials come from a separate SecretFabric lease (`imap-idle`). Closing the watcher logs out the provider and releases that lease.
- A dropped or timed-out IDLE socket reconnects with exponential backoff. After the attempt budget is spent, that watcher stops and the interval scheduler continues.
- Uses the worker's in-process overlap guard so two sync cycles cannot run at once.
- Runs a full sync when a policy is created, `UIDVALIDITY` changes, or a checkpoint is invalid.
- Retries provider failures with exponential backoff.
- MCP `sync_status` and `sync_status_all` read local checkpoint progress. They do not start a sync.
- Never blocks message reading while another account is syncing.
- Never sends mail as part of synchronization.

## MCP tools

```text
sync_policy_get(accountId)
sync_policy_set(accountId, policy)
sync_status(accountId)
sync_status_all()
```

`sync_policy_set` validates patterns and rejects a policy that would silently exclude all folders. Every policy change is audited.

## Local list semantics

The client’s mail list is built from the local mirror, not from the latest Inbox request. Search and thread operations can therefore cover all folders. Results indicate whether the account is currently syncing or stale.
