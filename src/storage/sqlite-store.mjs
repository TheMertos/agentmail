import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS active_accounts (
    account_id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    provider TEXT NOT NULL,
    secret_ref TEXT NOT NULL,
    connection_json TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS drafts (
    draft_id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    source_message_key TEXT,
    headers_json TEXT NOT NULL,
    text_body TEXT NOT NULL,
    html_body TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS drafts_account ON drafts(account_id, updated_at);
  CREATE TABLE IF NOT EXISTS folders (
    account_id TEXT NOT NULL,
    folder_id TEXT NOT NULL,
    path TEXT NOT NULL,
    metadata_json TEXT NOT NULL,
    PRIMARY KEY (account_id, folder_id)
  );
  CREATE TABLE IF NOT EXISTS messages (
    message_key TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    mailbox_id TEXT NOT NULL,
    uid INTEGER NOT NULL,
    uid_validity TEXT NOT NULL,
    internal_date TEXT,
    flags_json TEXT NOT NULL,
    envelope_json TEXT,
    raw_mime TEXT,
    attachments_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS messages_account_mailbox ON messages(account_id, mailbox_id);
  CREATE TABLE IF NOT EXISTS sync_checkpoints (
    account_id TEXT NOT NULL,
    mailbox_id TEXT NOT NULL,
    mode TEXT NOT NULL,
    message_count INTEGER NOT NULL,
    last_uid INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (account_id, mailbox_id)
  );
`;

export class SqliteMailStore {
  constructor(filename = ':memory:') {
    this.db = new Database(filename);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
    this.accountStatement = this.db.prepare(`INSERT INTO active_accounts(account_id, email, provider, secret_ref, connection_json, enabled, updated_at) VALUES (@id, @email, @provider, @secretRef, @connection, 1, @updatedAt) ON CONFLICT(account_id) DO UPDATE SET email=excluded.email, provider=excluded.provider, secret_ref=excluded.secret_ref, connection_json=excluded.connection_json, enabled=1, updated_at=excluded.updated_at`);
    this.accountDisableStatement = this.db.prepare('UPDATE active_accounts SET enabled = 0, updated_at = @updatedAt WHERE account_id = @id');
    this.upsertFolderStatement = this.db.prepare(`INSERT INTO folders(account_id, folder_id, path, metadata_json) VALUES (@accountId, @id, @path, @metadata) ON CONFLICT(account_id, folder_id) DO UPDATE SET path=excluded.path, metadata_json=excluded.metadata_json`);
    this.upsertMessageStatement = this.db.prepare(`INSERT INTO messages(message_key, account_id, mailbox_id, uid, uid_validity, internal_date, flags_json, envelope_json, raw_mime, attachments_json, updated_at) VALUES (@key, @accountId, @mailboxId, @uid, @uidValidity, @internalDate, @flags, @envelope, @raw, @attachments, @updatedAt) ON CONFLICT(message_key) DO UPDATE SET flags_json=excluded.flags_json, internal_date=excluded.internal_date, envelope_json=excluded.envelope_json, raw_mime=excluded.raw_mime, attachments_json=excluded.attachments_json, updated_at=excluded.updated_at`);
    this.checkpointStatement = this.db.prepare(`INSERT INTO sync_checkpoints(account_id, mailbox_id, mode, message_count, last_uid, updated_at) VALUES (@accountId, @mailboxId, @mode, @messageCount, @lastUid, @updatedAt) ON CONFLICT(account_id, mailbox_id) DO UPDATE SET mode=excluded.mode, message_count=excluded.message_count, last_uid=excluded.last_uid, updated_at=excluded.updated_at`);
  }

  activateAccount(account) {
    if (!account?.id || !account.email || !account.provider || !account.secretRef) throw new TypeError('id, email, provider and secretRef are required');
    this.accountStatement.run({ id: account.id, email: account.email, provider: account.provider, secretRef: account.secretRef, connection: JSON.stringify(account.connection ?? {}), updatedAt: new Date().toISOString() });
    return this.getAccount(account.id);
  }

  deactivateAccount(id) {
    this.accountDisableStatement.run({ id, updatedAt: new Date().toISOString() });
  }

  getAccount(id) {
    const row = this.db.prepare('SELECT * FROM active_accounts WHERE account_id = ?').get(id);
    if (!row) return null;
    return { id: row.account_id, email: row.email, provider: row.provider, secretRef: row.secret_ref, connection: JSON.parse(row.connection_json), enabled: Boolean(row.enabled) };
  }

  listActiveAccounts() {
    return this.db.prepare('SELECT * FROM active_accounts WHERE enabled = 1 ORDER BY account_id').all().map((row) => ({ id: row.account_id, email: row.email, provider: row.provider, secretRef: row.secret_ref, connection: JSON.parse(row.connection_json), enabled: true }));
  }

  createDraft(draft) {
    const id = draft.id ?? randomUUID();
    this.db.prepare(`INSERT INTO drafts(draft_id, account_id, source_message_key, headers_json, text_body, html_body, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'draft', ?)`)
      .run(id, draft.accountId, draft.sourceMessageKey ?? null, JSON.stringify(draft.headers ?? {}), draft.text ?? '', draft.html ?? '', new Date().toISOString());
    return this.getDraft(id);
  }

  getDraft(id) {
    const row = this.db.prepare('SELECT * FROM drafts WHERE draft_id = ?').get(id);
    return row ? { id: row.draft_id, accountId: row.account_id, sourceMessageKey: row.source_message_key, headers: JSON.parse(row.headers_json), text: row.text_body, html: row.html_body, status: row.status, updatedAt: row.updated_at } : null;
  }

  listDrafts(accountId) {
    return this.db.prepare('SELECT draft_id FROM drafts WHERE account_id = ? AND status = \'draft\' ORDER BY updated_at DESC').all(accountId).map(({ draft_id: id }) => this.getDraft(id));
  }

  async upsertFolder(folder) {
    this.upsertFolderStatement.run({ ...folder, metadata: JSON.stringify(folder) });
  }

  async upsertMessage(message) {
    this.upsertMessageStatement.run({
      key: message.key,
      accountId: message.accountId,
      mailboxId: message.mailboxId,
      uid: message.uid,
      uidValidity: message.uidValidity,
      internalDate: message.internalDate ?? null,
      ...message,
      flags: JSON.stringify(message.flags ?? []),
      envelope: JSON.stringify(message.envelope ?? null),
      attachments: JSON.stringify(message.attachments ?? []),
      updatedAt: new Date().toISOString()
    });
  }

  async checkpoint(checkpoint) {
    this.checkpointStatement.run({ ...checkpoint, lastUid: checkpoint.lastUid ?? 0, updatedAt: new Date().toISOString() });
  }

  searchMessages(accountId, query, limit = 50) {
    const needle = `%${String(query ?? '').toLowerCase()}%`;
    return this.db.prepare(`SELECT message_key, account_id, mailbox_id, uid, uid_validity, internal_date, flags_json, envelope_json FROM messages WHERE account_id = ? AND (lower(raw_mime) LIKE ? OR lower(envelope_json) LIKE ?) ORDER BY internal_date DESC LIMIT ?`).all(accountId, needle, needle, Math.min(Math.max(Number(limit) || 50, 1), 200)).map((row) => ({ key: row.message_key, accountId: row.account_id, mailboxId: row.mailbox_id, uid: row.uid, uidValidity: row.uid_validity, internalDate: row.internal_date, flags: JSON.parse(row.flags_json), envelope: JSON.parse(row.envelope_json) }));
  }

  listMessages(accountId, mailboxId, limit = 50) {
    return this.searchMessages(accountId, '', limit).filter((message) => !mailboxId || message.mailboxId === mailboxId);
  }

  countMessages(accountId) {
    return this.db.prepare('SELECT COUNT(*) AS count FROM messages WHERE account_id = ?').get(accountId).count;
  }

  getMessage(key) {
    const row = this.db.prepare('SELECT * FROM messages WHERE message_key = ?').get(key);
    if (!row) return null;
    return { ...row, raw: row.raw_mime, flags: JSON.parse(row.flags_json), envelope: JSON.parse(row.envelope_json), attachments: JSON.parse(row.attachments_json) };
  }

  getCheckpoint(accountId, mailboxId) {
    return this.db.prepare('SELECT * FROM sync_checkpoints WHERE account_id = ? AND mailbox_id = ?').get(accountId, mailboxId) ?? null;
  }

  close() { this.db.close(); }
}
