# Product contract

## Users

- one person operating several mail accounts;
- an AI assistant that can inspect selected mail and propose actions;
- an operator who must approve every consequential external action.

## Trust boundaries

Email bodies, subjects, sender names, links, attachment names, and quoted text are **untrusted input**. They may contain prompt injection or malicious instructions. The system must label them as data and never execute instructions found inside them.

The AI service is an additional trust boundary. The UI must show which content leaves the host and which model/provider processed it.

## Approval policy

The default policy is:

| Action | AI may suggest | Human approval | Provider confirmation required |
|---|---:|---:|---:|
| summarize/read | yes | no | no |
| create draft | yes | no | no |
| mark read/archive/label | yes | yes | yes |
| send/reply/forward | yes | yes | yes |
| delete/trash | yes | yes | yes |
| download/open attachment | suggest only | yes | no |
| change account/security settings | no | yes | yes |

Approval is bound to a content hash, recipient list, attachment list, and account. Any change invalidates the approval.

## Acceptance criteria for the first slice

- A new account can be configured without storing a plaintext password in the application database.
- Sync is idempotent: running it twice does not duplicate messages.
- A thread shows sender, recipients, dates, subject, body, quoted content, and attachments distinctly.
- An AI draft is visibly marked as a draft and includes model/provider metadata.
- Send preview displays From, To, Cc, Bcc, subject, rendered body, raw quoted original, and attachments.
- The send endpoint rejects requests without a valid, unexpired approval token.
- The approval token becomes invalid if recipients, body, account, or attachments change.
- A successful send is verified by provider response and a subsequent read-back/sent-folder reconciliation.
- Audit records contain action, actor, account, target message IDs, content hash, decision, timestamp, and provider result; they never contain passwords or full message bodies.

## Security baseline

- sanitize HTML and block active content;
- proxy or disable remote images by default;
- scan attachments before optional download;
- protect against SSRF in link/attachment fetching;
- use CSRF protection and secure session cookies;
- encrypt sensitive cached content at rest;
- redact secrets and message bodies from logs;
- enforce tenant/account authorization on every object access;
- provide data export and deletion.

## Delivery phases

### Phase 0 — contract and skeleton

Repository, domain model, provider interfaces, threat model, CI, and local development environment.

### Phase 1 — reliable single-account slice

IMAP sync, SMTP send, inbox/thread UI, draft generation interface, preview/approval/send/read-back, audit trail.

### Phase 2 — real-world mail operations

Multiple accounts, labels/folders, search, attachments, drafts, archive/trash/spam, scheduled send, `.eml` import/export.

### Phase 3 — provider integrations and AI quality

Gmail/Microsoft OAuth, local models, evaluation set, prompt-injection tests, configurable policies, offline mode.

### Phase 4 — release hardening

Threat-model review, migrations/backups, observability, accessibility, localization, signed releases, contributor documentation.
