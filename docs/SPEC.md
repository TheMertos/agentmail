# AgentMail specification v0.1

## 1. Product scope

AgentMail is a self-hosted, open-source mail client for reliable AI-assisted email operations. It supports multiple accounts, IMAP/SMTP, HTML signatures, and human approval gates.

## 2. Non-negotiable safety rules

- AI may read selected messages and create drafts, but cannot send, delete, forward, archive, or modify mail without explicit approval.
- Mail content, links, attachments, and signature HTML are untrusted data.
- Credentials are brokered by SecretFabric; plaintext secrets never enter chat, model context, logs, or the application database.
- MCP security contract: the principal is derived from `HERMES_HOME`. Host paths are rejected and never read. `attachment_upload` returns metadata only. Approval is required before `message_send`. mail_account_register does not overwrite an existing account, secretRef, or connection.
- Every external side effect is idempotent, auditable, and verified by provider read-back where possible.
- An approval is bound to account, recipients, subject, body, quote, signature, attachments, and policy version.

## 3. Functional requirements

### Accounts and credentials

- Add, edit, disable, and remove multiple mail accounts.
- Provider presets for mailbox.org, Gmail, Microsoft 365, and generic IMAP/SMTP.
- SecretFabric claim creation for new credentials.
- Short-lived purpose/field-scoped credential leases for IMAP, SMTP, and OAuth refresh.
- Connection test without sending a test message.

### Mail operations

- Incremental IMAP sync with idempotent message identity.
- Folders, labels, flags, threading, search, pagination, and offline cache.
- Read, archive, move, label, star, spam, trash, draft, reply, reply-all, forward.
- Attachment download/upload with size/type policy. Upload stages base64 content in the local store (no host-path reads) and records filename, content type, size, and sha256. Send approval binds that metadata to the exact MIME; `message_send` adds the bytes to multipart MIME only after approval and verifies the Sent copy. Source attachments are not inherited by reply: draft, preview, and send attach only explicitly selected staged ids, and incoming inline or attached files are not copied into the outgoing MIME.
- Safe HTML rendering and plain-text fallback.
- `.eml` import/export.

### AI assistance

- Summarize selected thread.
- Draft response in detected language and register.
- Preserve complete quoted original by default.
- Extract dates, deadlines, tasks, and requested documents.
- Rewrite/translate only on explicit request.
- Model/provider provenance visible in the UI.
- Prompt-injection warnings; no instructions from mail are executed.

### Signatures and MIME

- Multiple account-scoped signature profiles.
- HTML plus plain-text alternative for every HTML message.
- Import existing HTML signatures.
- Versioning, sanitization, inline CID images, preview, and account policies.
- AI footer as an independent composable component.
- Exact-once checks for new body, signature, footer, and quote.

### Approval and audit

- Final send preview with From/To/Cc/Bcc/subject/body/quote/attachments/signature.
- Explicit approval action; content changes invalidate approval.
- Send idempotency key prevents duplicate delivery on retry.
- Immutable audit events with redacted metadata.
- Provider response and Sent-folder/read-back verification.

## Resumable sync and progress (required)

- The sync engine must checkpoint after every bounded message batch, not only after an entire folder completes.
- A process crash, MCP timeout, service restart, or provider disconnect must resume from the last persisted UID/checkpoint without restarting the account from UID 1.
- Persist per-account/per-mailbox: UIDVALIDITY, last processed UID, remote message count/UIDNEXT when available, local message count, status, startedAt, updatedAt, error class, and completedAt.
- If UIDVALIDITY changes, reset only the affected mailbox checkpoint and rebuild that mailbox safely.
- Expose `sync_status(accountId)` via MCP with per-folder remote count, local count, downloaded count, remaining estimate, percentage, state, last checkpoint, and error.
- Expose `sync_status_all()` for every active account.
- Never report a guessed overall percentage. If the provider does not expose a reliable total, return `percentage: null` and explain why.
- IMAP provider mailbox listing must fetch a lightweight `messages`/`uidNext` status per selectable folder so progress can be calculated without downloading bodies.
- Full sync and incremental sync must both be resumable. Incremental sync must still refresh flags/expunges where supported and must not reset a completed mailbox unnecessarily.
- Add TDD tests for batch checkpoint persistence, crash/resume, UIDVALIDITY reset, accurate percentage, unknown percentage, and MCP status tool output.


- One account can be onboarded through SecretFabric.
- Inbox can sync and display one complete thread.
- AI draft can be generated without send capability.
- User can select an HTML signature and see both MIME alternatives.
- Send endpoint rejects missing, expired, changed, or wrong-account approvals.
- Successful send is read back and audited.
- No secret or full message body appears in logs.
- The native systemd user service starts the MCP server.

## 5. Delivery increments

1. Domain core: approval hashing, signature profiles, MIME composition contracts.
2. Account/SecretFabric adapter interfaces and fake providers.
3. IMAP sync and SMTP send adapters.
4. REST API and persistence.
5. Next.js inbox, thread, composer, preview, approval UI.
6. AI gateway and provider adapters.
7. Integration tests against the native host service.

## 6. Out of scope for v0.1

- Autonomous sending.
- Webmail UI scraping.
- Model training on user email.
- Silent quote shortening.
- Production readiness claims before security and operational review.
