# Configuration boundary

AgentMail separates required runtime configuration from in-app account data.

## Required environment configuration

The MCP server refuses to start when these values are missing or invalid:

```text
AGENTMAIL_DB_PATH=/data/agentmail.db
AGENTMAIL_SYNC_INTERVAL_SECONDS=300
AGENTMAIL_LOG_LEVEL=info
AGENTMAIL_TRANSPORT=stdio
AGENTMAIL_PRINCIPAL=<derived at MCP attach time>
SECRET_FABRIC_PRINCIPAL=<same as AGENTMAIL_PRINCIPAL>
SECRET_FABRIC_URL=https://secretfabric.example
SECRET_FABRIC_API_TOKEN=...
```

`AGENTMAIL_PRINCIPAL` identifies the single authorized operator for this AgentMail instance. The MCP server refuses to start without it. Mail accounts, messages, drafts, signatures, sync jobs, and send operations are scoped to that principal; MCP tool arguments cannot override or impersonate it.

`SECRET_FABRIC_PRINCIPAL` must be set to the same value as `AGENTMAIL_PRINCIPAL`. It is sent on every SecretFabric resolve request as the trusted `x-hermes-principal` header (never in the JSON body and never from MCP tool arguments).

The native launcher and systemd user unit set `AGENTMAIL_PROFILE` to the Hermes profile name and set `AGENTMAIL_PRINCIPAL` and `SECRET_FABRIC_PRINCIPAL` to that same value. Those principals are not taken from MCP tool arguments.

Hermes attaches MCP through the stdio wrapper, which injects `AGENTMAIL_PRINCIPAL` and `SECRET_FABRIC_PRINCIPAL` from inherited `HERMES_HOME` and runs `node src/mcp/server.mjs` directly. The MCP server refuses to start when either principal is missing, empty, or mismatched, or when `AGENTMAIL_SERVICE_MODE` is not `native`, or when the matching profile and absolute attachment roots are missing.

## Hermes MCP stdio wrapper

Hermes should start AgentMail MCP through `tools/hermes-agentmail-mcp.sh`. The wrapper is the supported MCP entrypoint. It requires inherited `HERMES_HOME` (non-empty after trim) and derives the canonical principal:

| `HERMES_HOME` | Canonical principal |
| --- | --- |
| `.../.hermes/profiles/<name>` (single path segment) | `<name>` |
| `.../.hermes` (default Hermes home) | `default` |
| Anything else, missing, or ambiguous | Fail closed (non-zero exit) |

Derived names must match `^[A-Za-z0-9][A-Za-z0-9._-]*$`. There is no fallback to OS usernames, `HERMES_INSTANCE_NAME`, or MCP tool arguments.

MCP security contract: the principal comes from `HERMES_HOME`. `attachment_upload` accepts only a `filePath` inside `AGENTMAIL_ATTACHMENT_ROOTS`; the resolved path must remain inside an approved root. `attachment_upload` returns metadata only. Approval is required before `message_send`. mail_account_register does not overwrite an existing account, secretRef, or connection.

On success the wrapper runs Node in the repository with `AGENTMAIL_SERVICE_MODE=native`, the derived principal, and a profile data directory under `$XDG_DATA_HOME/agentmail/<principal>` or `$HOME/.local/share/agentmail/<principal>`. `SECRET_FABRIC_URL` and `SECRET_FABRIC_API_TOKEN` come from the inherited environment. Empty values are filled from `~/.config/agentmail/<principal>.env` (or `$XDG_CONFIG_HOME/agentmail/<principal>.env`) without replacing values that are already set and without printing them. Startup still fails closed when either value is missing.

```text
AGENTMAIL_PRINCIPAL=<derived> \
SECRET_FABRIC_PRINCIPAL=<derived> \
AGENTMAIL_SERVICE_MODE=native \
node src/mcp/server.mjs
```

## Profile-isolated data

Each Hermes profile gets its own native data directory. Operators who use the same Hermes profile name share `$XDG_DATA_HOME/agentmail/<profile>` or `$HOME/.local/share/agentmail/<profile>`. A different Hermes profile (or the default `.../.hermes` home, principal `default`) uses a separate directory so mail metadata stays isolated.

| Hermes context | Principal | Data directory |
| --- | --- | --- |
| `.../.hermes/profiles/mert` | `mert` | `~/.local/share/agentmail/mert/` |
| `.../.hermes` (default) | `default` | `~/.local/share/agentmail/default/` |

Install the user service once per profile. The steps are in [`COMPOSE-TRANSITION.md`](COMPOSE-TRANSITION.md). The profile name must match `^[A-Za-z0-9][A-Za-z0-9._-]*$`. `SECRET_FABRIC_URL` and `SECRET_FABRIC_API_TOKEN` come from the operator environment or `~/.config/agentmail/<profile>.env`. The unit runs `node src/mcp/server.mjs`. Background sync and IMAP IDLE are not started. The directory stores non-sensitive account metadata and opaque SecretFabric references.

## Transport and infrastructure trust

AgentMail currently exposes MCP over **stdio only** (`AGENTMAIL_TRANSPORT=stdio`). Anyone who can attach to the process stdio or read/write the SQLite database file with host privileges is treated as trusted infrastructure—not as a separate application principal.

On the host, operators with access to a profile’s data directory can read or modify that profile’s account metadata database. Principal identity follows the active Hermes profile; restrict that directory accordingly.

## In-app / SQLite configuration

These are not environment variables and are managed through MCP tools:

- active account list;
- account email/provider/connection metadata;
- opaque SecretFabric resource reference;
- mailbox sync policies;
- signatures and account identity settings;
- sync checkpoints and local mail mirror.

The native process never receives account passwords or OAuth tokens through environment variables.

## Account activation

The agent uses `mail_account_register` only after a SecretFabric claim has been completed and an opaque resource reference is available. Accounts not registered through that tool are outside the active list and are never contacted.
