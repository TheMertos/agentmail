# Mail-client parity specification

AgentMail must work as a real mail client first and an AI assistant second. AI features are additive and must never replace standard email operations.

## Core client parity

### Account setup

- Multiple independent accounts.
- Generic IMAP/SMTP setup.
- Provider presets and autodiscovery where safe.
- Per-account identities, aliases, reply-to addresses, signatures, and folders.
- Offline account status and reconnect controls.
- Account enable/disable without deleting local mail.

### IMAP

- TLS and STARTTLS.
- Password/app-password and OAuth2 authentication through Hermes-provided leases.
- Folder discovery and subscription management.
- Incremental synchronization using UIDVALIDITY, UIDNEXT, MODSEQ/QRESYNC where supported.
- Read/unread, flagged, answered, deleted, draft, and attachment flags.
- Move, copy, archive, trash, spam, and mark operations.
- Server-side search with safe local fallback.
- IDLE/push updates with polling fallback.
- Reconnect, backoff, and duplicate-safe retries.

### SMTP

- TLS and STARTTLS.
- Authentication through a short-lived Hermes lease.
- Multipart MIME generation.
- Plain-text and HTML alternatives.
- Inline CID images and regular attachments.
- Reply, reply-all, forward, Bcc, and custom From/Reply-To.
- Draft save before send.
- Send idempotency and provider result verification.
- Sent-folder reconciliation after delivery.

### Message handling

- Conversation/thread view.
- Raw MIME inspection for debugging.
- Safe HTML rendering with remote content controls.
- Plain-text view.
- Attachment list, download, preview, and save policy.
- `.eml` import/export.
- Message source headers and Message-ID display.
- Quoted history preserved exactly by default.

### Composition

- Rich HTML composer.
- Plain-text alternative editor/preview.
- Multiple account-scoped signatures.
- Signature versioning and preview.
- Inline images, file attachments, drag/drop, and paste handling.
- Recipient autocomplete from local contacts and message history.
- Draft autosave and recovery.
- Scheduled send.
- Undo-send window where provider behavior permits.
- Spellcheck and language selection.

### Search and organization

- Full-text search by sender, recipient, subject, body, date, folder, attachment, and flag.
- Saved searches.
- Labels/tags and color markers.
- Filters and rules.
- Thread and message-level actions.
- Pagination/virtualization for large mailboxes.
- Local cache usable when offline.

## AI layer

AI must sit above the mail client engine:

- read selected messages only;
- summarize threads;
- draft replies;
- extract tasks and dates;
- translate/rewrite on request;
- suggest labels and rules;
- never silently alter the original message;
- never send without the normal client approval flow;
- show provider/model provenance and selected input scope.

## Hermes control flow

Hermes handles credential onboarding and supplies short-lived IMAP/SMTP connection leases. AgentMail owns mail synchronization, local cache, MIME processing, UI, drafts, and provider operations. No secret is persisted by AgentMail.

## Mail-client acceptance test

The first production-capable release is not complete until a user can:

1. Add two accounts independently.
2. Discover folders for each account.
3. Sync and read messages offline after the initial sync.
4. Search a mailbox and open a threaded message.
5. Reply with an HTML signature and plain-text alternative.
6. Attach a file and inline an image.
7. Save a draft and recover it after restart.
8. Move/archive/trash a message.
9. Send only after explicit approval.
10. Verify the sent message in the provider’s Sent folder.
11. Restart Docker without losing local mail metadata or drafts.
12. Continue using standard mail functions if the AI provider is unavailable.

## Non-negotiable design rule

If the AI service is down, AgentMail must remain a usable conventional email client. If IMAP/SMTP is unavailable, the UI must preserve drafts and explain the connection state without claiming delivery.
