# Implementation report: resumable sync and progress

## Summary

AgentMail now checkpoints IMAP sync after every bounded message batch, persists rich per-mailbox sync metadata in SQLite, and exposes `sync_status` / `sync_status_all` MCP tools with honest progress (including `percentage: null` when remote totals are unavailable).

## Sync engine

- `src/mail/sync-engine.mjs` loops per folder in batches (`batchSize`, default 100), writing a checkpoint after each non-empty batch and on completion.
- Full and incremental modes load the last persisted UID checkpoint so crash, MCP timeout, service restart, or provider disconnect resume without restarting at UID 1.
- UIDVALIDITY changes clear only the affected mailbox’s local messages and rebuild from UID 1 for that folder.
- Incremental sync skips folders that are already `completed` when `uidNext` and `uidValidity` match the lightweight remote status (no unnecessary full re-fetch).

## IMAP provider

- `listMailboxes()` issues a lightweight IMAP `STATUS` per folder (`messages`, `uidNext`, `uidValidity`) for progress calculation without downloading bodies.
- `fetchMessages()` continues to honor checkpoints and batch size.

## Persistence

- `sync_checkpoints` extended with `uid_validity`, `remote_messages`, `uid_next`, `local_message_count`, `status`, `started_at`, `error_class`, and `completed_at` (with safe `ALTER TABLE` migration for existing databases).
- `getCheckpoint()` returns normalized camelCase records; `listSyncCheckpoints`, `countMessagesInMailbox`, and `clearMailboxMessages` support status and UIDVALIDITY recovery.

## Progress and MCP

- `src/mail/sync-progress.mjs` — per-folder and account aggregation; never invents a percentage when any folder lacks a reliable remote total.
- `src/mail/sync-status.mjs` — builds account-level status payloads from the store.
- `src/mcp/sync-status-tools.mjs` — handlers wired in `src/mcp/server.mjs` as `sync_status` and `sync_status_all` (no credentials).

## Tests (TDD)

- `test/sync-progress.test.mjs` — accurate vs unknown percentage.
- `test/resumable-sync.test.mjs` — batch checkpoints, crash resume, UIDVALIDITY reset, incremental skip.
- `test/sync-status.test.mjs` — status builder and all-accounts view.
- `test/mcp-sync-status.test.mjs` — MCP-shaped output without secrets.

Existing account, SecretFabric lease, signature, approval, Sent-folder, and MCP mail tools are unchanged aside from the new status tools.

## Verification

```bash
yarn lint
node --test --test-concurrency=1 test/**/*.test.mjs
git diff --check
systemctl --user is-active agentmail@default.service
```
