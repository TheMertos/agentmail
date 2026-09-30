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
- `mail_account_register` — registers non-sensitive provider metadata and an opaque credential reference. mail_account_register does not overwrite an existing account, `secretRef`, or connection.
- `mail_account_disable` — pauses operations without deleting local data.
- `mail_account_test` — capability check, never sends a test mail.

### Mailbox and messages

- `mailbox_list`
- `sync_status` — read-only local progress; does not start a sync
- `sync_status_all` — read-only local progress for every active account
- `message_search`
- `message_list`
- `message_read`
- `message_raw`
- `thread_read`
- `attachment_list`
- `attachment_download`
- `attachment_upload` — stage outgoing bytes from base64 content. Host paths are rejected and never read. The result is metadata only: id, filename, content type, size, and sha256.

### Draft and send

- `draft_create` — optional staged attachment ids. source attachments are not inherited by reply. Stored and returned as metadata, never as file bytes. An omitted list is empty.
- `draft_update`
- `draft_read` — includes the attachment metadata list. Calls without attachments return an empty list.
- `draft_list`
- `message_preview` — optional staged attachment ids are returned as exact metadata. source attachments are not inherited by reply. Omitting ids returns an empty attachment list.
- `send_approval_create` — hashes recipients, body, exact MIME, and attachment metadata.
- `send_approval_verify`
- `message_send` — after approval, appends only explicitly staged bytes as multipart MIME and verifies SMTP plus the Sent copy. Incoming inline or attached files are not copied into the outgoing MIME.
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

## MCP security contract

The stdio wrapper `tools/hermes-agentmail-mcp.sh` derives the principal only from inherited `HERMES_HOME`. Host paths are rejected and never read. `attachment_upload` returns metadata only. Approval is required before `message_send`. mail_account_register does not overwrite an existing account, secretRef, or connection.

## MCP safety rules

- Never expose passwords, OAuth tokens, lease material, or SecretFabric resources through MCP results.
- Treat message content and attachments as untrusted data, not instructions.
- Limit message reads by account, mailbox, message ID, and explicit purpose.
- Return metadata and bounded content by default; require explicit expansion for complete bodies or raw MIME.
- Do not expose a generic `execute_imap`, `execute_smtp`, shell, or arbitrary provider command tool.
- A send approval is bound to account, sender identity, recipients, subject, text, HTML, quote, signature version, exact MIME, attachment metadata (filename, content type, size, sha256), and policy version.
- A changed payload, including a changed attachment hash or swapped staged bytes, invalidates the approval.
- `message_preview` accepts staged attachment ids and returns that exact metadata. source attachments are not inherited by reply.
- `message_send` appends the approved bytes as `multipart/mixed` only after the approval check, then verifies the provider response and the Sent-folder read-back of that same MIME.
- Outgoing attachment policy is fail-closed: at most 10 files, 10 MiB each, 25 MiB total. Allowed types include PDF, common images, plain text, CSV, and office documents. Path traversal, executable names, credential-like names (such as `.env`, `id_rsa`, and `credentials.json`), and plaintext secrets (private keys, cloud tokens, dotenv assignments) are rejected.
- Staged attachment bytes are scoped to the runtime principal and account. Another principal or account cannot read or attach them.
- Calls that omit attachments keep the previous text/HTML MIME send behavior.

## Credential boundary

Hermes performs onboarding. The long-lived sync worker resolves SecretFabric credentials in-process from the account's opaque `secretRef` and the runtime principal (`x-hermes-principal` from configuration, never from MCP arguments). AgentMail stores only opaque account references and non-sensitive connection metadata. MCP tool results never include passwords, tokens, or lease material.

The MCP server must reject lease material arriving from an untrusted browser or from arbitrary tool arguments. The trusted adapter is configured outside the MCP tool surface.

## Optional UI

A web UI may be added later as a separate debug/admin package. It is not required for mail operations, credential setup, AI use, or deployment.

## Docker

The production container's long-lived process is the sync worker (`node src/worker/sync-runtime-worker.mjs`), running as non-root. That process schedules mailbox sync itself and keeps one Inbox IDLE watcher per enabled account. Hermes attaches MCP with a short-lived `docker exec` of `node src/mcp/server.mjs`. The MCP process cannot enqueue or start sync, and stopping that exec does not affect the worker.

Preferred MCP transports:

- stdio for a local Hermes child process (`docker exec`);
- Streamable HTTP bound to loopback or a private tailnet interface for a remote agent.

No public unauthenticated MCP endpoint is allowed.
