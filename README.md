# AgentMail

A headless, open-source MCP mail operations server for AI agents.

> Early implementation. Not production-ready and not a replacement for a mail provider.

AgentMail is a real Thunderbird-like mail engine without requiring a GUI. Hermes or another MCP client performs account setup, mailbox sync, search, reading, drafting, approval, sending, and verification through narrow MCP tools. A UI is optional and not part of the core product.

## Goal

Make email operations reliable instead of improvisational:

- read and search mail across multiple accounts;
- draft replies while preserving the original message exactly;
- classify, summarize, and extract action items;
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
6. **Local-first privacy** — credentials stay in a secret manager; AI providers receive only the minimum selected content.
7. **Open source** — self-hostable, documented, and auditable.

> **Trademark notice:** Thunderbird is a Mozilla trademark. References to Thunderbird in this repository describe interoperability and UX requirements only. AgentMail is not affiliated with, sponsored by, or endorsed by Mozilla, and does not include Mozilla/Thunderbird source code.

## Planned capabilities

### Mail

- multiple accounts and folders/labels;
- IMAP sync with resumable per-batch checkpoints, per-folder progress, and offline cache;
- SMTP submission;
- Gmail and Microsoft OAuth adapters;
- threaded conversations;
- full-text search and filters;
- read/unread, archive, move, labels, star, spam, trash;
- attachments, inline images, MIME rendering;
- multiple account-scoped HTML/plain-text signature profiles;
- signature import, preview, versioning, sanitization, and account policies;
- drafts and scheduled send;
- import/export of `.eml`.

### AI assistance

- summarize a thread;
- draft a reply in the detected language and formality;
- preserve quoted originals;
- extract deadlines and action items;
- classify mail and suggest labels;
- translate and rewrite;
- configurable local or hosted model providers;
- per-action approval policies;
- prompt-injection resistance and visible provenance.

### Safety and operations

- immutable audit events for AI suggestions and approvals;
- dry-run preview before every external side effect;
- undo window where the provider supports it;
- encrypted secrets via OS keychain or SecretFabric/Vaultwarden integration;
- rate limits, retry/backoff, idempotency keys;
- structured logs with message bodies and secrets excluded;
- export and deletion controls;
- Docker Compose deployment and health checks.

## Proposed architecture

- **Runtime:** headless Node.js/TypeScript MCP server.
- **Transport:** stdio for local Hermes integration; Streamable HTTP only on authenticated private interfaces.
- **Mail engine:** provider adapters behind a stable domain API.
- **Persistence:** PostgreSQL for shared deployments; SQLite-compatible local storage for single-agent deployments.
- **Credential control plane:** Hermes/SecretFabric handles account onboarding and short-lived credential leases; AgentMail remains unaware of SecretFabric and never stores credentials.
- **Optional UI:** separate debug/admin package, never required for mail operations.
- **Deployment:** Docker Compose; the production container's long-lived process is the non-root sync worker. MCP attaches with a short-lived stdio `docker exec`.

## First vertical slice

1. Connect one IMAP/SMTP account.
2. Sync inbox headers and bodies.
3. Display a threaded inbox.
4. Generate a reply draft from a selected thread.
5. Show the exact outgoing message, recipients, attachments, and policy checks.
6. Send only after an explicit approval action.
7. Read back the sent message and append an audit event.

## Non-goals for the first release

- autonomous sending;
- scraping webmail UIs;
- training models on user mail;
- silently rewriting or shortening quoted content;
- pretending that an AI draft was sent successfully without provider confirmation.

## Development status

AgentMail is a real email client first and an AI assistant second. The Thunderbird-parity requirements are tracked in [`docs/THUNDERBIRD-PARITY.md`](docs/THUNDERBIRD-PARITY.md). Background mailbox sync runs only in the long-lived worker, on its own interval and via a dedicated Inbox IDLE watcher, through that process's account registry, mailbox policy, mail service, and SecretFabric leases. MCP does not enqueue, start, or wait for sync. `sync_status` and `sync_status_all` only read local progress. The headless MCP server also supports local search/read, drafts, signatures, staged outgoing attachments, and approval-gated send. `attachment_upload` accepts base64 content only; draft, preview, and send bind filename, content type, size, and sha256, and a changed attachment invalidates the approval. Source attachments are not inherited by reply.

Resumable sync behavior is specified in [`docs/SPEC.md`](docs/SPEC.md) and summarized in [`IMPLEMENTATION_REPORT.md`](IMPLEMENTATION_REPORT.md).

See [`docs/PRODUCT.md`](docs/PRODUCT.md) for scope, threat model, and acceptance criteria.

Credentials are brokered through the existing SecretFabric installation. AgentMail can create a one-time claim, let the human enter the sensitive values, and request only short-lived, purpose- and field-scoped in-memory leases for IMAP/SMTP operations. It never exposes credentials to the AI model, chat, logs, or normal application storage. HTML signatures are separate account-scoped profiles with plain-text fallbacks and preview-bound approval. See [`docs/SECRETS.md`](docs/SECRETS.md) and [`docs/SIGNATURES.md`](docs/SIGNATURES.md).

## Runtime and SecretFabric flow

The deployed runtime is split into two processes:

- The long-lived Docker worker owns background IMAP synchronization and the Inbox IDLE watchers.
- The short-lived stdio MCP server is started with `docker exec` by the Hermes MCP wrapper for interactive tool calls.
- The wrapper derives `AGENTMAIL_PRINCIPAL` from the trusted `HERMES_HOME`; callers cannot select a different principal through tool arguments.
- For every IMAP or SMTP operation, the worker/MCP runtime asks SecretFabric for a short-lived lease using the account's opaque `secretRef`, a purpose, and field paths such as `incoming.username` and `incoming.password`.
- SecretFabric returns credentials only in process memory. The lease is released after the operation and private fields are destroyed.
- The provider connection is then created from the lease and closed after the operation. AgentMail stores account metadata and message MIME, never the credential values.

## Read-state behavior

AgentMail follows Thunderbird-style IMAP semantics while keeping passive synchronization non-mutating:

- Passive sync, IDLE, search, flag reconciliation, attachment extraction, and local mirror reads use non-mutating fetches and do not write `\\Seen`.
- ImapFlow uses `BODY.PEEK[]` for incoming MIME fetches, so downloading a message does not mark it read.
- Provider `flags` events trigger a debounced incremental sync; external Thunderbird/Android/Gmail read/unread changes are copied into the local mirror without downloading the body.
- `message_read` is an explicit content-read operation. After the exact message is resolved, it writes provider `UID STORE +FLAGS \\Seen`; if that fails, the read fails closed and local flags are not changed.
- `message_mark_read` explicitly writes `\\Seen` without returning the message body.
- `message_mark_unread` explicitly writes `UID STORE -FLAGS \\Seen` and removes the flag from the local mirror.
- All read-state writes require exact account, mailbox, UID, and UIDVALIDITY identity checks.

## MCP security contract

The Hermes MCP wrapper derives the runtime principal only from inherited `HERMES_HOME` and injects it as `AGENTMAIL_PRINCIPAL`. MCP tool arguments cannot choose or impersonate that principal. Host paths are rejected by `attachment_upload` and are never read; the tool returns metadata only (id, filename, content type, size, sha256). Approval is required before `message_send`. mail_account_register does not overwrite an existing account, `secretRef`, or connection; there is no silent migration of those fields.

## License

Apache-2.0. See [`LICENSE`](LICENSE).
