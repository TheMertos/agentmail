# Hermes credential lease bridge

AgentMail receives credentials only through a trusted in-process/local bridge controlled by Hermes. The MCP model/tool layer never sees the username or password.

## Flow

```text
Hermes requests account operation
  -> trusted resolver asks SecretFabric/Hermes vault for scoped fields (principal via `x-hermes-principal` from runtime config, never MCP args)
  -> bridge creates a short-lived in-memory lease
  -> AgentMail provider receives credentials only in the trusted process boundary
  -> IMAP/SMTP operation runs
  -> lease is released and credential object is discarded
```

The bridge must not pass credentials as MCP tool arguments, JSON results, logs, database fields, Docker environment variables, command-line arguments, or files.

## Lease shape

The public lease metadata contains only:

```text
leaseId
accountId
purpose
expiresAt
fields
```

The private resolver result may contain the username/password internally. It is consumed directly by the trusted IMAP/SMTP provider factory and never returned by an MCP handler.

## Failure behavior

- missing resolver: `credential_lease_unavailable`;
- expired lease: reject before provider connection;
- wrong account/purpose/fields: reject;
- resolver failure: no plaintext fallback;
- provider close: release lease immediately;
- logs: lease ID only, never credential values.

The user must enter credentials through SecretFabric’s masked claim flow. They must never be pasted into Telegram or supplied as a normal chat message.
