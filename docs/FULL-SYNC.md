# Full mailbox synchronization

AgentMail must maintain a complete local mirror of each enabled account, not only an Inbox header cache.

## Sync scope

For every subscribed/discovered mailbox:

- folder metadata and hierarchy;
- every message envelope;
- complete raw MIME source;
- decoded text/plain and sanitized text/html projections;
- all attachments as encrypted local blobs or verified external references;
- inline CID resources;
- flags and labels;
- Message-ID, In-Reply-To, References, UID, UIDVALIDITY, internal date;
- thread/conversation keys;
- server state such as UIDNEXT and MODSEQ when available.

This includes Inbox, Sent, Drafts, Archive, Trash, Spam, custom folders, and provider-specific labels. The sync engine must not assume folder names such as `Sent`.

## Sync modes

- **Initial sync:** enumerate all folders, then fetch every message and its complete MIME content in bounded batches.
- **Incremental sync:** use CONDSTORE/QRESYNC/MODSEQ when available; otherwise fetch by UID ranges and compare flags.
- **Recovery sync:** detect UIDVALIDITY changes, invalidate only the affected folder mapping, and rebuild it safely.
- **Scheduled sync:** the long-lived worker runs per account with backoff and provider-friendly concurrency.

## Local durability

- Sync is resumable after process or Docker restart.
- Each folder has a durable checkpoint and in-progress batch marker.
- Message upserts are idempotent on `(account_id, mailbox_id, uidvalidity, uid)`.
- Raw MIME is content-addressed to avoid duplicate storage.
- Attachments are deduplicated by content hash.
- A failed batch is retried without duplicating messages or attachments.
- Local data is retained when the provider is temporarily unavailable.

## MCP behavior

- MCP does not start, enqueue, or wait for mailbox sync. The worker performs IMAP sync on its own interval.
- `sync_status(accountId)` and `sync_status_all()` return folder counts, checkpoints, errors, and last successful sync from the local mirror; never credentials. They do not download mail.
- `message_search` searches the local complete mirror and reports whether sync is still incomplete.
- `message_read` reads from local storage by default; `refresh=true` is explicit.

## Resource limits

- Batch messages and attachments; never load an entire mailbox into memory.
- Stream raw MIME and attachment blobs to encrypted storage.
- Enforce configurable per-message, per-attachment, and total-account limits.
- Preserve metadata and report skipped content explicitly if a limit is hit.
- Never silently discard a message because its body or attachment is large.

## Acceptance criteria

- A test account with messages in every folder produces a complete local mirror.
- Re-running full sync produces no duplicate message or attachment rows.
- Restarting during a batch resumes from the last checkpoint.
- Flag changes are reflected locally without redownloading unchanged MIME.
- UIDVALIDITY changes rebuild the affected folder without corrupting other folders.
- Local search finds messages outside Inbox and searches body text/attachments metadata.
- A provider outage leaves the last known local mirror readable and clearly marks it stale.
