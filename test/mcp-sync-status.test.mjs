import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteMailStore } from '../src/storage/sqlite-store.mjs';
import { createSyncStatusHandlers } from '../src/mcp/sync-status-tools.mjs';
import { createPrincipalRegistry } from '../src/security/principal-scope.mjs';
import { activateTestAccount, TEST_PRINCIPAL } from './test-principal.mjs';

test('sync_status MCP handler returns structured folder progress without credentials', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentmail-mcp-status-'));
  const store = new SqliteMailStore(join(dir, 'mail.db'));
  activateTestAccount(store, { id: 'acct', email: 'u@example.test', provider: 'imap', secretRef: 'opaque-ref' });
  store.checkpoint({
    accountId: 'acct',
    mailboxId: 'INBOX',
    mode: 'incremental',
    lastUid: 10,
    uidValidity: '9',
    remoteMessages: null,
    uidNext: null,
    localMessageCount: 10,
    status: 'syncing',
    messageCount: 10
  });
  const registry = createPrincipalRegistry(store, TEST_PRINCIPAL);
  const { syncStatus, syncStatusAll } = createSyncStatusHandlers({ store, registry });
  const payload = JSON.parse(syncStatus({ accountId: 'acct' }).content[0].text);
  assert.equal(payload.accountId, 'acct');
  assert.equal(payload.mode, 'remote-only');
  assert.equal(payload.syncEnabled, false);
  assert.equal(payload.idleEnabled, false);
  assert.deepEqual(payload.folders, []);
  assert.equal(payload.percentage, null);
  assert.equal(JSON.stringify(payload).includes('INBOX'), false);
  assert.equal(payload.secretRef, undefined);
  assert.equal(payload.password, undefined);

  const allPayload = JSON.parse(syncStatusAll().content[0].text);
  assert.equal(allPayload.accounts.length, 1);
  assert.equal(allPayload.syncEnabled, false);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
