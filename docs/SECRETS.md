# Credential boundary

AgentMail does **not** integrate directly with SecretFabric. Hermes is the credential control plane and performs all SecretFabric operations.

## Responsibilities

### Hermes / SecretFabric

- create the one-time claim for a new mail account;
- let the human enter passwords, app passwords, OAuth refresh tokens, and MFA data;
- store the values encrypted;
- resolve only the fields needed for one operation;
- keep resolved values in memory only;
- revoke and expire leases;
- audit credential access without exposing values.

### AgentMail

- stores only an opaque account reference and non-sensitive connection metadata;
- never receives a SecretFabric password or token in its database, UI, logs, or AI context;
- exposes mail operations through a local trusted adapter contract;
- receives a short-lived in-memory connection lease only while Hermes performs a mail operation;
- returns message data and send results, never credentials.

## Operation flow

```text
Mert asks Hermes to add an account
  -> Hermes creates SecretFabric email claim
  -> Mert enters sensitive values on the one-time claim page
  -> Hermes validates IMAP/SMTP capabilities
  -> Hermes registers AgentMail account with opaque credential reference
  -> Hermes invokes AgentMail mail operation with a short-lived local lease
  -> AgentMail performs IMAP/SMTP operation
  -> lease material is destroyed
```

AgentMail runs as a native host process. It must not read the SecretFabric database, encryption key, Hermes vault, or SecretFabric environment file.

## AgentMail adapter contract

The first implementation should expose a local-only, authenticated adapter endpoint or process boundary:

```text
connect_account(
  account_id,
  operation="imap-sync" | "smtp-send",
  lease_id,
  connection_metadata
)
```

The lease is supplied by Hermes through a trusted local channel. AgentMail validates:

- the account reference;
- the operation scope;
- lease expiry;
- request ID/idempotency key;
- that the connection metadata contains no plaintext secret in persisted fields.

The lease must not be accepted from a browser request or an AI-generated arbitrary HTTP request.

## Account model

AgentMail stores only:

```text
account.id
account.label
account.email
account.provider
account.imap.host
account.imap.port
account.imap.security
account.smtp.host
account.smtp.port
account.smtp.security
account.secretfabricResourceRef  # opaque reference only
account.status
```

Hermes stores or resolves:

```text
imap.username
imap.password or oauth access/refresh token
smtp.username
smtp.password or oauth access/refresh token
mfa and recovery material
```

## Failure behavior

- SecretFabric unavailable: Hermes pauses onboarding or operation; AgentMail does not fall back to plaintext environment variables.
- Expired lease: reject the operation and request a fresh Hermes lease.
- Wrong credentials: report only a provider error classification.
- Process restart: no credential survives in the AgentMail data directory.
- Browser request containing a lease: reject it; only the trusted Hermes adapter may supply leases.

## Verification requirements

- The AgentMail checkout and data directory contain no SecretFabric credentials.
- Account records contain only opaque references and connection metadata.
- Hermes can create and complete a real email claim.
- IMAP and SMTP operations work through a short-lived lease.
- Logs and API responses contain no password, token, lease secret, or private key.
- Lease expiry/revocation prevents new connections.
