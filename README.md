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

## Planned capabilities

### Mail

- multiple accounts and folders/labels;
- IMAP sync with incremental state and offline cache;
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
- **Deployment:** Docker Compose; production image runs as a non-root MCP process.

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

AgentMail is a real email client first and an AI assistant second. The Thunderbird-parity requirements are tracked in [`docs/THUNDERBIRD-PARITY.md`](docs/THUNDERBIRD-PARITY.md). The current UI is an early prototype; IMAP/SMTP synchronization, persistence, and composition are implementation work still ahead.

See [`docs/PRODUCT.md`](docs/PRODUCT.md) for scope, threat model, and acceptance criteria.

Credentials are brokered through the existing SecretFabric installation. AgentMail can create a one-time claim, let the human enter the sensitive values, and request only short-lived, purpose- and field-scoped in-memory leases for IMAP/SMTP operations. It never exposes credentials to the AI model, chat, logs, or normal application storage. HTML signatures are separate account-scoped profiles with plain-text fallbacks and preview-bound approval. See [`docs/SECRETS.md`](docs/SECRETS.md) and [`docs/SIGNATURES.md`](docs/SIGNATURES.md).

## License

Apache-2.0. See [`LICENSE`](LICENSE).
