# AgentMail specification v0.1

## 1. Product scope

AgentMail is a self-hosted, open-source mail client for reliable AI-assisted email operations. It supports multiple accounts, IMAP/SMTP, HTML signatures, and human approval gates.

## 2. Non-negotiable safety rules

- AI may read selected messages and create drafts, but cannot send, delete, forward, archive, or modify mail without explicit approval.
- Mail content, links, attachments, and signature HTML are untrusted data.
- Credentials are brokered by SecretFabric; plaintext secrets never enter chat, model context, logs, or the application database.
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
- Attachment download/upload with size/type policy.
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

## 4. First release acceptance criteria

- One account can be onboarded through SecretFabric.
- Inbox can sync and display one complete thread.
- AI draft can be generated without send capability.
- User can select an HTML signature and see both MIME alternatives.
- Send endpoint rejects missing, expired, changed, or wrong-account approvals.
- Successful send is read back and audited.
- No secret or full message body appears in logs.
- Docker Compose starts the app and health checks pass.

## 5. Delivery increments

1. Domain core: approval hashing, signature profiles, MIME composition contracts.
2. Account/SecretFabric adapter interfaces and fake providers.
3. IMAP sync and SMTP send adapters.
4. REST API and persistence.
5. Next.js inbox, thread, composer, preview, approval UI.
6. AI gateway and provider adapters.
7. PostgreSQL worker, Docker deployment, integration tests.

## 6. Out of scope for v0.1

- Autonomous sending.
- Webmail UI scraping.
- Model training on user email.
- Silent quote shortening.
- Production readiness claims before security and operational review.
