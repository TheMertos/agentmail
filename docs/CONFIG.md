# Configuration boundary

AgentMail separates required runtime configuration from in-app account data.

## Required environment configuration

The MCP server refuses to start when these values are missing or invalid:

```text
AGENTMAIL_DB_PATH=/data/agentmail.db
AGENTMAIL_SYNC_INTERVAL_SECONDS=300
AGENTMAIL_LOG_LEVEL=info
AGENTMAIL_TRANSPORT=stdio
AGENTMAIL_PRINCIPAL=mert
```

`AGENTMAIL_PRINCIPAL` identifies the single authorized operator for this AgentMail instance. The MCP server refuses to start without it. Mail accounts, messages, drafts, signatures, sync jobs, and send operations are scoped to that principal; MCP tool arguments cannot override or impersonate it.

These are deployment/runtime settings only. Compose supplies them by default, and operators can override them with a deployment `.env` file.

## Transport and infrastructure trust

AgentMail currently exposes MCP over **stdio only** (`AGENTMAIL_TRANSPORT=stdio`). Anyone who can attach to the process stdio or read/write the SQLite database file with host privileges is treated as trusted infrastructure—not as a separate application principal.

In Docker, that means operators with access to the `agentmail-data` volume, the container root filesystem, or the host Docker daemon can read or modify the local mail mirror and database. Set `AGENTMAIL_PRINCIPAL` to your identity (for example `mert`) and restrict volume and container access accordingly.

## In-app / SQLite configuration

These are not environment variables and are managed through MCP tools:

- active account list;
- account email/provider/connection metadata;
- opaque SecretFabric resource reference;
- mailbox sync policies;
- signatures and account identity settings;
- sync checkpoints and local mail mirror.

The Docker image never receives account passwords or OAuth tokens through environment variables.

## Account activation

The agent uses `mail_account_register` only after a SecretFabric claim has been completed and an opaque resource reference is available. Accounts not registered through that tool are outside the active list and are never contacted.
