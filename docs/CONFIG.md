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

Compose sets `AGENTMAIL_PROFILE` (default `default` for plain `docker compose build`; provisioning sets it to the profile name). The long-running **sync worker** maps that profile to `AGENTMAIL_PRINCIPAL` and `SECRET_FABRIC_PRINCIPAL` internally. Compose does **not** put principal env vars on the worker process in a way MCP clients can override.

Hermes attaches MCP through the stdio wrapper, which injects `AGENTMAIL_PRINCIPAL` and `SECRET_FABRIC_PRINCIPAL` from inherited `HERMES_HOME` into a short-lived `docker exec` process running `node src/mcp/server.mjs` only. The MCP server still refuses to start when either principal is missing, empty, or mismatched.

## Hermes MCP stdio wrapper

Hermes should start AgentMail MCP through `tools/hermes-agentmail-mcp.sh`, not by calling `docker exec` directly. The wrapper is the only supported MCP entrypoint. It requires inherited `HERMES_HOME` (non-empty after trim) and derives the canonical principal:

| `HERMES_HOME` | Canonical principal |
| --- | --- |
| `.../.hermes/profiles/<name>` (single path segment) | `<name>` |
| `.../.hermes` (default Hermes home) | `default` |
| Anything else, missing, or ambiguous | Fail closed (non-zero exit) |

Derived names must match `^[A-Za-z0-9][A-Za-z0-9._-]*$`. There is no fallback to OS usernames, `HERMES_INSTANCE_NAME`, or MCP tool arguments.

MCP security contract: the principal comes from `HERMES_HOME`. Host paths are rejected and never read. `attachment_upload` returns metadata only. Approval is required before `message_send`. mail_account_register does not overwrite an existing account, secretRef, or connection.

On success it resolves the target container as `agentmail-<principal>` (for example `agentmail-mert` or `agentmail-default`). There is no shared fallback container name. If that container does not exist on the host, the wrapper exits with a clear error and does not attach MCP.

```text
docker exec -i \
  -e AGENTMAIL_PRINCIPAL=<derived> \
  -e SECRET_FABRIC_PRINCIPAL=<derived> \
  agentmail-<derived> node src/mcp/server.mjs
```

## Profile-isolated containers

Each Hermes profile gets its own long-running AgentMail container and SQLite volume. Operators who use the same Hermes profile name share one container (`agentmail-<profile>`) and one volume (`agentmail-<profile>-data`). A different Hermes profile (or the default `.../.hermes` home, principal `default`) must use a separately provisioned stack so mail data and MCP attach paths stay isolated.

| Hermes context | Principal | Container | Named volume |
| --- | --- | --- | --- |
| `.../.hermes/profiles/mert` | `mert` | `agentmail-mert` | `agentmail-mert-data` |
| `.../.hermes` (default) | `default` | `agentmail-default` | `agentmail-default-data` |

Provision a stack once per profile from the AgentMail repo root (does not modify Hermes core):

```bash
export SECRET_FABRIC_URL=https://secretfabric.example
export SECRET_FABRIC_API_TOKEN=...
tools/provision-agentmail-profile.sh mert
```

The script validates the profile name (`^[A-Za-z0-9][A-Za-z0-9._-]*$`), requires `SECRET_FABRIC_URL` and `SECRET_FABRIC_API_TOKEN` from the **operator environment only** (no CLI secrets, no copying credentials into the repo), and runs `docker compose --project-name agentmail-<profile> up -d --build` with `AGENTMAIL_CONTAINER_NAME`, `AGENTMAIL_VOLUME_NAME`, and `AGENTMAIL_PROFILE` set for that profile. Compose keeps `restart: always` and runs `node src/worker/sync-runtime-worker.mjs` as the container command so background sync continues while Hermes repeatedly attaches MCP via `docker exec`.

Plain `docker compose build` (without provisioning) uses the default compose names `agentmail-default` / `agentmail-default-data` for image builds only; Hermes MCP attach still requires the matching provisioned container for the active profile.

## Transport and infrastructure trust

AgentMail currently exposes MCP over **stdio only** (`AGENTMAIL_TRANSPORT=stdio`). Anyone who can attach to the process stdio or read/write the SQLite database file with host privileges is treated as trusted infrastructure—not as a separate application principal.

In Docker, that means operators with access to a profile’s `agentmail-<profile>-data` volume, that container’s filesystem, or the host Docker daemon can read or modify that profile’s local mail mirror and database. Principal identity follows the active Hermes profile; restrict volume and container access accordingly.

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
