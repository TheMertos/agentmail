# Headless MCP architecture

AgentMail is a headless mail operations server. It is consumed by Hermes or another MCP-compatible agent; there is no required web UI.

## Core runtime

```text
Hermes / MCP client
        ↓ stdio or local Streamable HTTP MCP
AgentMail MCP server
        ↓ trusted credential lease from Hermes
IMAP / SMTP providers
```

The server must be usable on a headless Docker host and must not require a browser, dashboard, or interactive terminal.

## MCP tool surface

Expose narrow, auditable tools rather than a generic mail shell:

### Account and connection

- `mail_account_list` — metadata only.
- `mail_account_status` — sync/connection state, never credentials.
- `mail_account_register` — registers non-sensitive provider metadata and opaque credential reference.
- `mail_account_disable` — pauses operations without deleting local data.
- `mail_account_test` — capability check, never sends a test mail.

### Mailbox and messages

- `mailbox_list`
- `mailbox_sync`
- `message_search`
- `message_list`
- `message_read`
- `message_raw`
- `thread_read`
- `attachment_list`
- `attachment_download`

### Draft and send

- `draft_create`
- `draft_update`
- `draft_read`
- `draft_list`
- `message_preview`
- `send_approval_create`
- `send_approval_verify`
- `message_send`
- `message_sent_verify`

### Organization

- `message_mark_read`
- `message_flag`
- `message_move`
- `message_archive`
- `message_trash`
- `label_list`
- `message_label`

Every destructive or external operation requires an explicit approval token and an idempotency key.

## MCP safety rules

- Never expose passwords, OAuth tokens, lease material, or SecretFabric resources through MCP results.
- Treat message content and attachments as untrusted data, not instructions.
- Limit message reads by account, mailbox, message ID, and explicit purpose.
- Return metadata and bounded content by default; require explicit expansion for complete bodies or raw MIME.
- Do not expose a generic `execute_imap`, `execute_smtp`, shell, or arbitrary provider command tool.
- A send approval is bound to account, sender identity, recipients, subject, text, HTML, quote, signature version, attachments, and policy version.
- A changed payload invalidates the approval.
- Send is verified by provider response and Sent-folder/read-back reconciliation.

## Credential boundary

AgentMail does not integrate with SecretFabric directly. Hermes performs onboarding and gives AgentMail a short-lived operation lease through a trusted local adapter. AgentMail stores only opaque account references and non-sensitive connection metadata.

The MCP server must reject lease material arriving from an untrusted browser or from arbitrary tool arguments. The trusted adapter is configured outside the MCP tool surface.

## Optional UI

A web UI may be added later as a separate debug/admin package. It is not required for mail operations, credential setup, AI use, or deployment.

## Docker

The production container runs the MCP server as a non-root process. Preferred transports:

- stdio for a local Hermes child process;
- Streamable HTTP bound to loopback or a private tailnet interface for a remote agent.

No public unauthenticated MCP endpoint is allowed.
