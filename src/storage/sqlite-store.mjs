import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { sanitizeSignatureHtml } from '../core/signatures.mjs';

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
  CREATE TABLE IF NOT EXISTS signature_profiles (
    profile_id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    name TEXT NOT NULL,
    html_body TEXT NOT NULL,
    text_body TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    enabled INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS signature_profiles_account ON signature_profiles(account_id);
  CREATE TABLE IF NOT EXISTS signature_defaults (
    account_id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL
  );
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
    uid_validity TEXT,
    remote_messages INTEGER,
    uid_next INTEGER,
    local_message_count INTEGER,
    status TEXT,
    started_at TEXT,
    error_class TEXT,
    completed_at TEXT,
    PRIMARY KEY (account_id, mailbox_id)
  );
`;

const CHECKPOINT_MIGRATIONS = [
  'ALTER TABLE sync_checkpoints ADD COLUMN uid_validity TEXT',
  'ALTER TABLE sync_checkpoints ADD COLUMN remote_messages INTEGER',
  'ALTER TABLE sync_checkpoints ADD COLUMN uid_next INTEGER',
  'ALTER TABLE sync_checkpoints ADD COLUMN local_message_count INTEGER',
  'ALTER TABLE sync_checkpoints ADD COLUMN status TEXT',
  'ALTER TABLE sync_checkpoints ADD COLUMN started_at TEXT',
  'ALTER TABLE sync_checkpoints ADD COLUMN error_class TEXT',
  'ALTER TABLE sync_checkpoints ADD COLUMN completed_at TEXT'
];

export class SqliteMailStore {
  constructor(filename = ':memory:') {
    this.db = new Database(filename);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
    for (const sql of CHECKPOINT_MIGRATIONS) {
      try { this.db.exec(sql); } catch { /* column may already exist */ }
    }
    this.accountStatement = this.db.prepare(`INSERT INTO active_accounts(account_id, email, provider, secret_ref, connection_json, enabled, updated_at) VALUES (@id, @email, @provider, @secretRef, @connection, 1, @updatedAt) ON CONFLICT(account_id) DO UPDATE SET email=excluded.email, provider=excluded.provider, secret_ref=excluded.secret_ref, connection_json=excluded.connection_json, enabled=1, updated_at=excluded.updated_at`);
    this.accountDisableStatement = this.db.prepare('UPDATE active_accounts SET enabled = 0, updated_at = @updatedAt WHERE account_id = @id');
    this.upsertFolderStatement = this.db.prepare(`INSERT INTO folders(account_id, folder_id, path, metadata_json) VALUES (@accountId, @id, @path, @metadata) ON CONFLICT(account_id, folder_id) DO UPDATE SET path=excluded.path, metadata_json=excluded.metadata_json`);
    this.upsertMessageStatement = this.db.prepare(`INSERT INTO messages(message_key, account_id, mailbox_id, uid, uid_validity, internal_date, flags_json, envelope_json, raw_mime, attachments_json, updated_at) VALUES (@key, @accountId, @mailboxId, @uid, @uidValidity, @internalDate, @flags, @envelope, @raw, @attachments, @updatedAt) ON CONFLICT(message_key) DO UPDATE SET flags_json=excluded.flags_json, internal_date=excluded.internal_date, envelope_json=excluded.envelope_json, raw_mime=excluded.raw_mime, attachments_json=excluded.attachments_json, updated_at=excluded.updated_at`);
    this.checkpointStatement = this.db.prepare(`INSERT INTO sync_checkpoints(account_id, mailbox_id, mode, message_count, last_uid, updated_at, uid_validity, remote_messages, uid_next, local_message_count, status, started_at, error_class, completed_at) VALUES (@accountId, @mailboxId, @mode, @messageCount, @lastUid, @updatedAt, @uidValidity, @remoteMessages, @uidNext, @localMessageCount, @status, @startedAt, @errorClass, @completedAt) ON CONFLICT(account_id, mailbox_id) DO UPDATE SET mode=excluded.mode, message_count=excluded.message_count, last_uid=excluded.last_uid, updated_at=excluded.updated_at, uid_validity=excluded.uid_validity, remote_messages=excluded.remote_messages, uid_next=excluded.uid_next, local_message_count=excluded.local_message_count, status=excluded.status, started_at=COALESCE(sync_checkpoints.started_at, excluded.started_at), error_class=excluded.error_class, completed_at=excluded.completed_at`);
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

  createSignatureProfile({ accountId, name, html, text }) {
    if (!accountId || !name) throw new TypeError('accountId and name are required');
    const id = randomUUID();
    const safeHtml = sanitizeSignatureHtml(html ?? '');
    this.db.prepare(`INSERT INTO signature_profiles(profile_id, account_id, name, html_body, text_body, version, enabled, updated_at) VALUES (?, ?, ?, ?, ?, 1, 1, ?)`)
      .run(id, accountId, name, safeHtml, text ?? '', new Date().toISOString());
    return this.getSignatureProfile(id);
  }

  updateSignatureProfile(id, { name, html, text, enabled } = {}) {
    const current = this.getSignatureProfile(id);
    if (!current) throw new Error('signature_not_found');
    const nextVersion = current.version + 1;
    const safeHtml = html !== undefined ? sanitizeSignatureHtml(html) : current.html;
    this.db.prepare(`UPDATE signature_profiles SET name = ?, html_body = ?, text_body = ?, version = ?, enabled = ?, updated_at = ? WHERE profile_id = ?`)
      .run(name ?? current.name, safeHtml, text ?? current.text, nextVersion, enabled === undefined ? (current.enabled ? 1 : 0) : (enabled ? 1 : 0), new Date().toISOString(), id);
    return this.getSignatureProfile(id);
  }

  getSignatureProfile(id) {
    const row = this.db.prepare('SELECT * FROM signature_profiles WHERE profile_id = ?').get(id);
    return row ? { id: row.profile_id, accountId: row.account_id, name: row.name, html: row.html_body, text: row.text_body, version: row.version, enabled: Boolean(row.enabled) } : null;
  }

  listSignatureProfiles(accountId) {
    return this.db.prepare('SELECT profile_id FROM signature_profiles WHERE account_id = ? AND enabled = 1 ORDER BY name').all(accountId).map(({ profile_id: id }) => this.getSignatureProfile(id));
  }

  setDefaultSignature(accountId, profileId) {
    const profile = this.getSignatureProfile(profileId);
    if (!profile || profile.accountId !== accountId) throw new Error('signature belongs to another account');
    this.db.prepare('INSERT INTO signature_defaults(account_id, profile_id) VALUES (?, ?) ON CONFLICT(account_id) DO UPDATE SET profile_id = excluded.profile_id').run(accountId, profileId);
  }

  getDefaultSignature(accountId) {
    const row = this.db.prepare('SELECT profile_id FROM signature_defaults WHERE account_id = ?').get(accountId);
    return row ? this.getSignatureProfile(row.profile_id) : null;
  }

  resolveSignatureForSend({ accountId, explicitId }) {
    if (explicitId) {
      const profile = this.getSignatureProfile(explicitId);
      if (profile && profile.accountId !== accountId) throw new Error('signature belongs to another account');
      return profile && profile.enabled ? profile : null;
    }
    return this.getDefaultSignature(accountId);
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
    this.checkpointStatement.run({
      accountId: checkpoint.accountId,
      mailboxId: checkpoint.mailboxId,
      mode: checkpoint.mode ?? 'incremental',
      messageCount: checkpoint.messageCount ?? checkpoint.localMessageCount ?? 0,
      lastUid: checkpoint.lastUid ?? 0,
      updatedAt: checkpoint.updatedAt ?? new Date().toISOString(),
      uidValidity: checkpoint.uidValidity ?? null,
      remoteMessages: checkpoint.remoteMessages ?? null,
      uidNext: checkpoint.uidNext ?? null,
      localMessageCount: checkpoint.localMessageCount ?? checkpoint.messageCount ?? 0,
      status: checkpoint.status ?? null,
      startedAt: checkpoint.startedAt ?? null,
      errorClass: checkpoint.errorClass ?? null,
      completedAt: checkpoint.completedAt ?? null
    });
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

  countMessagesInMailbox(accountId, mailboxId) {
    return this.db.prepare('SELECT COUNT(*) AS count FROM messages WHERE account_id = ? AND mailbox_id = ?').get(accountId, mailboxId).count;
  }

  clearMailboxMessages(accountId, mailboxId) {
    this.db.prepare('DELETE FROM messages WHERE account_id = ? AND mailbox_id = ?').run(accountId, mailboxId);
  }

  listSyncCheckpoints(accountId) {
    return this.db.prepare('SELECT * FROM sync_checkpoints WHERE account_id = ? ORDER BY mailbox_id').all(accountId).map((row) => this.#mapCheckpointRow(row));
  }

  getFolderPath(accountId, folderId) {
    const row = this.db.prepare('SELECT path FROM folders WHERE account_id = ? AND folder_id = ?').get(accountId, folderId);
    return row?.path ?? folderId;
  }

  /**
   * Parsed folder metadata from the local mirror.
   * @param {string} accountId Account id.
   * @param {string} folderId Folder id.
   * @returns {object|null} Folder record or null.
   */
  getFolderMetadata(accountId, folderId) {
    const row = this.db.prepare('SELECT metadata_json FROM folders WHERE account_id = ? AND folder_id = ?').get(accountId, folderId);
    if (!row?.metadata_json) return null;
    try {
      return JSON.parse(row.metadata_json);
    } catch {
      return null;
    }
  }

  #mapCheckpointRow(row) {
    if (!row) return null;
    return {
      accountId: row.account_id,
      mailboxId: row.mailbox_id,
      mode: row.mode,
      messageCount: row.message_count,
      lastUid: row.last_uid,
      uidValidity: row.uid_validity,
      remoteMessages: row.remote_messages,
      uidNext: row.uid_next,
      localMessageCount: row.local_message_count,
      status: row.status,
      startedAt: row.started_at,
      errorClass: row.error_class,
      completedAt: row.completed_at,
      updatedAt: row.updated_at
    };
  }

  getMessage(key) {
    const row = this.db.prepare('SELECT * FROM messages WHERE message_key = ?').get(key);
    if (!row) return null;
    return { ...row, raw: row.raw_mime, flags: JSON.parse(row.flags_json), envelope: JSON.parse(row.envelope_json), attachments: JSON.parse(row.attachments_json) };
  }

  getCheckpoint(accountId, mailboxId) {
    const row = this.db.prepare('SELECT * FROM sync_checkpoints WHERE account_id = ? AND mailbox_id = ?').get(accountId, mailboxId);
    return row ? this.#mapCheckpointRow(row) : null;
  }

  close() { this.db.close(); }
}
