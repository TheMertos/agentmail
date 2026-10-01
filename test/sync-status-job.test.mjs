import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteMailStore } from '../src/storage/sqlite-store.mjs';
import { buildSyncStatus, buildSyncStatusAll } from '../src/mail/sync-status.mjs';
import { createSyncStatusHandlers } from '../src/mcp/sync-status-tools.mjs';
import { createPrincipalRegistry } from '../src/security/principal-scope.mjs';
import { activateTestAccount, TEST_PRINCIPAL } from './test-principal.mjs';

test('buildSyncStatus merges background job metadata when provided', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentmail-status-job-'));
  const store = new SqliteMailStore(join(dir, 'mail.db'));
  activateTestAccount(store, { id: 'a', email: 'a@example.test', provider: 'imap', secretRef: 'ref' });
  const job = {
    jobId: '11111111-1111-4111-8111-111111111111',
    accountId: 'a',
    mode: 'incremental',
    state: 'running',
    startedAt: '2026-01-02T00:00:00.000Z',
    completedAt: null,
    error: null
  };
  const status = buildSyncStatus(store, 'a', job);
  assert.deepEqual(status.job, {
    jobId: job.jobId,
    state: 'running',
    mode: 'incremental',
    startedAt: job.startedAt,
    completedAt: null,
    error: null
  });
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('sync_status MCP handler does not report local sync jobs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentmail-mcp-job-'));
  const store = new SqliteMailStore(join(dir, 'mail.db'));
  activateTestAccount(store, { id: 'acct', email: 'u@example.test', provider: 'imap', secretRef: 'opaque-ref' });
  const registry = createPrincipalRegistry(store, TEST_PRINCIPAL);
  const { syncStatus, syncStatusAll } = createSyncStatusHandlers({ registry });
  const payload = JSON.parse(syncStatus({ accountId: 'acct' }).content[0].text);
  assert.equal(payload.mode, 'remote-only');
  assert.equal(payload.syncEnabled, false);
  assert.equal(payload.job, undefined);

  const allPayload = JSON.parse(syncStatusAll().content[0].text);
  assert.equal(allPayload.accounts[0].job, undefined);
  assert.equal(allPayload.syncEnabled, false);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
