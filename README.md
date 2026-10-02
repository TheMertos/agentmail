# AgentMail

A headless, open-source MCP mail operations server for AI agents.

> Early implementation. Not production-ready and not a replacement for a mail provider.

AgentMail talks to IMAP and SMTP directly for interactive mail operations. Hermes or another MCP client performs account setup, mailbox listing, search, reading, drafting, approval, sending, and Sent read-back through narrow MCP tools. There is no local message mirror for those reads and writes, no background sync worker, and no IMAP IDLE session. A UI is optional and not part of the core product.

Calendar is not part of AgentMail. Remote CalDAV is handled by the separate [AgentCalendar](https://github.com/TheMertos/agentcalendar) project. AgentMail does not mirror events and does not read or write calendars.

## Goal

Make email operations reliable instead of improvisational:

- read and search mail on the live IMAP server;
- draft replies while preserving the original message exactly, including nested quotes;
- classify, summarize, and extract action items from explicitly fetched content;
- attach files and render HTML safely;
- require explicit human approval for sending, deleting, forwarding, and external side effects;
- keep a complete, inspectable audit trail;
- work with normal IMAP/SMTP and provider OAuth where available.

## Product principles

1. **Human-in-the-loop by default** — AI may inspect and draft; it cannot send or destroy mail without approval.
2. **Provider-neutral** — IMAP/SMTP first, Gmail and Microsoft OAuth adapters next.
3. **No prompt execution from mail** — message content is untrusted data. Links, attachments, and instructions never become tool commands automatically.
4. **Exact preservation** — replies include the complete original message and preserve its greeting style unless the user changes it.
5. **Least privilege** — separate read, draft, send, attachment, and account-management permissions.
6. **Local-first privacy** — credentials stay in SecretFabric; AI providers receive only the minimum selected content. Message bodies are not kept as a local interactive mirror.
7. **Open source** — self-hostable, documented, and auditable.

## Current architecture

Interactive mail is remote-only:

- **Reads, searches, flag changes, and sends** open a short-lived IMAP or SMTP connection, run that one operation, and close it. Results are not filled from a local message cache when the provider fails.
- **No local message or event mirror** for interactive reads and writes. Message bodies, MIME, flags, and sync checkpoints are not written for those operations. Account metadata and opaque SecretFabric references may remain in the named data volume.
- **No background sync worker.** `syncAccount` throws `remote_only_sync_disabled` and does not acquire a credential lease. The worker entrypoint does not open SQLite, SecretFabric, IMAP, or IDLE.
- **No IMAP IDLE.** `openIdleWatch` throws `remote_only_idle_disabled`. `sync_status` and `sync_status_all` report `mode: remote-only` and do not read checkpoints or message rows.
- **Search scope.** `message_search` searches **INBOX** when `mailboxId` and `mailboxIds` are omitted. It does not discover or scan other folders. Explicit `mailboxId` or `mailboxIds` search only those paths. `mailbox_list` is the folder discovery operation.
- **Page size.** The default sort is descending (`sortBy: date`, `sortOrder: desc`). The page size defaults to 50 and is bounded from 1 to 200. After IMAP SEARCH, FETCH loads only that UID window: descending keeps the highest UIDs, ascending keeps the lowest. A stalled connect, mailbox lock, or search returns `remote_timeout`.
- **SecretFabric and principal scope.** The Hermes MCP wrapper derives `AGENTMAIL_PRINCIPAL` from trusted `HERMES_HOME` and injects it. Tool arguments cannot choose or impersonate a principal. Each IMAP or SMTP call leases credentials from SecretFabric with the account's opaque `secretRef`, a purpose, and field paths such as `incoming.username` and `incoming.password`. The lease stays in process memory, is released after the operation, and is never returned to the model, chat, or logs.
- **Approval-gated sending.** `message_send` accepts only an `approvalId`. The server sends the exact preview stored for that principal and account. Callers cannot supply body, MIME, recipients, or attachment bytes on the send call.
- **Signatures.** Account-scoped HTML and plain-text signature profiles are sanitized before storage. Preview and approval bind the selected or default signature version. A changed signature invalidates the approval.
- **Nested blockquotes.** Reply composition wraps the quoted source in one canonical `<blockquote class="gmail_quote">`. Outer blockquotes that wrap the entire source fragment are removed so quotes are not double-wrapped. Nested blockquotes inside the message content are kept. `quoteDepth` is an integer from 1 to 10 and sets the plain-text `>` depth.
- **Attachments.** `attachment_upload` accepts only a `filePath` inside `AGENTMAIL_ATTACHMENT_ROOTS`. The path must resolve to a regular file whose realpath stays inside an approved root. Arbitrary paths and paths taken from mail content are rejected and never read. Draft, preview, and send bind filename, content type, size, and sha256. A changed attachment invalidates the approval. Source-message attachments are not copied into a reply.
- **Sent read-back.** After SMTP accepts the message, AgentMail appends the same MIME to the Sent mailbox and reads that UID back. The send fails with `sent_copy_failed`, `sent_copy_unverified`, or `sent_copy_verification_failed` when the stored copy is missing or does not match the reviewed MIME.
- **`remote_timeout`.** A stalled IMAP connect, lock, or search is reported as `remote_timeout`. The tool does not fall back to cached messages.

Runtime shape:

- **Runtime:** headless Node.js MCP server (`node src/mcp/server.mjs`).
- **Transport:** stdio for local Hermes integration (`tools/hermes-agentmail-mcp.sh` runs `node src/mcp/server.mjs`); Streamable HTTP only on authenticated private interfaces.
- **Mail engine:** live IMAP/SMTP providers behind `MailService`.
- **Calendar:** remote CalDAV stays in AgentCalendar. This repository does not sync or store events.
- **Credential control plane:** Hermes/SecretFabric handles account onboarding and short-lived credential leases. AgentMail stores opaque references, not secrets.
- **Deployment:** the supported host service is a systemd user unit plus the Hermes wrapper, both running Node directly. Background sync and IMAP IDLE are not started.

## Mail operations

The MCP server exposes interactive tools for:

- account registration and listing, scoped to the runtime principal;
- live mailbox listing;
- live search on INBOX or explicit mailboxes, with a bounded descending page;
- reading one message and explicit read/unread flag writes on the provider;
- drafts, account-scoped signatures, and reply preview with nested blockquotes;
- staged outgoing attachments;
- approval creation and SMTP send with Sent read-back;
- remote-only sync status that does not start a worker.

Summaries, classification, and rewriting stay in the MCP client. AgentMail returns mail content and does not run a model.

## Safety and operations

- preview before send, bound to the exact body, signature, and attachment metadata;
- credentials only through short-lived SecretFabric leases;
- structured logs with message bodies and secrets excluded;
- a native systemd user service for the MCP server.

## Development status

AgentMail is a real email client first and an AI assistant second. The mail-client parity requirements are tracked in [`docs/MAIL-CLIENT-PARITY.md`](docs/MAIL-CLIENT-PARITY.md). Interactive search, read, flag changes, and send query IMAP or SMTP directly. Background sync and IMAP IDLE are disabled. `sync_status` and `sync_status_all` report `mode: remote-only` and do not read a local message mirror. The headless MCP server also supports drafts, signatures, nested blockquotes, staged outgoing attachments, approval-gated send, and Sent read-back. `attachment_upload` accepts base64 content or an allowlisted `filePath`; draft, preview, and send bind filename, content type, size, and sha256, and a changed attachment invalidates the approval. Source attachments are not inherited by reply.

See [`docs/PRODUCT.md`](docs/PRODUCT.md) for scope, threat model, and acceptance criteria. Deployment and live-search notes are in [`docs/HEADLESS-MCP.md`](docs/HEADLESS-MCP.md), [`docs/CONFIG.md`](docs/CONFIG.md), and [`docs/AUTO-SYNC.md`](docs/AUTO-SYNC.md).

Credentials are brokered through the existing SecretFabric installation. AgentMail can create a one-time claim, let the human enter the sensitive values, and request only short-lived, purpose- and field-scoped in-memory leases for IMAP/SMTP operations. It never exposes credentials to the AI model, chat, logs, or normal application storage. HTML signatures are separate account-scoped profiles with plain-text fallbacks and preview-bound approval. See [`docs/SECRETS.md`](docs/SECRETS.md) and [`docs/SIGNATURES.md`](docs/SIGNATURES.md).

## Runtime and SecretFabric flow

The deployed runtime is one MCP server process:

- The native host service and the Hermes wrapper run `node src/mcp/server.mjs`. Background IMAP synchronization and Inbox IDLE are disabled.
- Hermes starts interactive tool calls against that server. The wrapper derives `AGENTMAIL_PRINCIPAL` from the trusted `HERMES_HOME`; callers cannot select a different principal through tool arguments.
- For every IMAP or SMTP operation, the service reconciles the account's opaque `secretRef` from SecretFabric into the service-owned encrypted credential cache, then decrypts the lease only inside the process.
- `CREDENTIAL_CACHE_KEY` is a required external runtime secret. It is not stored in SQLite, MCP inputs or results, logs, or source. There is no direct SecretFabric resolver fallback.
- The provider connection is created from the lease and closed after the operation. AgentMail stores account metadata and opaque secret references, not credential values and not an interactive message mirror.

## Read-state behavior

AgentMail follows IMAP flag semantics on the live server:

- Search and header-oriented fetches use non-mutating IMAP fetches and do not write `\Seen`.
- ImapFlow uses `BODY.PEEK[]` for incoming MIME fetches, so downloading a message does not mark it read.
- `message_read` is an explicit content-read operation. After the exact message is resolved on the provider, it writes `UID STORE +FLAGS \Seen`. If that fails, the read fails closed.
- `message_mark_read` explicitly writes `\Seen` without returning the message body.
- `message_mark_unread` explicitly writes `UID STORE -FLAGS \Seen`.
- All read-state writes require exact account, mailbox, UID, and UIDVALIDITY identity checks.
- Flag changes are not copied into a local message mirror.

## MCP security contract

The Hermes MCP wrapper derives the runtime principal only from inherited `HERMES_HOME` and injects it as `AGENTMAIL_PRINCIPAL`. MCP tool arguments cannot choose or impersonate that principal. Host paths are rejected by `attachment_upload` unless `filePath` is a regular file inside an approved root; arbitrary paths and paths from mail content are never read. The tool returns metadata only (id, filename, content type, size, sha256). Approval is required before `message_send`. mail_account_register does not overwrite an existing account, `secretRef`, or connection; there is no silent migration of those fields.

Native install is in [`docs/COMPOSE-TRANSITION.md`](docs/COMPOSE-TRANSITION.md).

## Non-goals

- autonomous sending;
- a local message or calendar-event mirror for interactive use;
- background mailbox sync or IMAP IDLE;
- CalDAV inside this repository (that is AgentCalendar);
- scraping webmail UIs;
- training models on user mail;
- silently rewriting or shortening quoted content;
- pretending that an AI draft was sent successfully without SMTP acceptance and Sent read-back.

## License

Apache-2.0. See [`LICENSE`](LICENSE).
