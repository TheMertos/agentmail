import test from 'node:test';
import assert from 'node:assert/strict';
import { createSecretFabricResolver } from '../src/security/secretfabric-resolver.mjs';

test('resolver posts scoped request and extracts only username/password', async () => {
  let seenRequest;
  const fetchImpl = async (url, options) => {
    seenRequest = { url, body: JSON.parse(options.body), headers: options.headers };
    return { ok: true, json: async () => ({ fields: { 'incoming.username': 'user@example.test', 'incoming.password': 'secret', 'incoming.host': 'imap.example.test' } }) };
  };
  const resolver = createSecretFabricResolver({ baseUrl: 'http://127.0.0.1:3000', apiToken: 'tok', fetchImpl });
  const result = await resolver({ resourceId: 'r1', purpose: 'imap-sync', fieldPaths: ['incoming.username', 'incoming.password'] });
  assert.deepEqual(result, { username: 'user@example.test', password: 'secret' });
  assert.equal(seenRequest.url, 'http://127.0.0.1:3000/api/resolve');
  assert.equal(seenRequest.headers.authorization, 'Bearer tok');
  assert.deepEqual(seenRequest.body, { resourceId: 'r1', purpose: 'imap-sync', fieldPaths: ['incoming.username', 'incoming.password'] });
});

test('resolver rejects when required fields are missing', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ fields: {} }) });
  const resolver = createSecretFabricResolver({ baseUrl: 'http://x', apiToken: 't', fetchImpl });
  await assert.rejects(() => resolver({ resourceId: 'r1', purpose: 'imap-sync', fieldPaths: ['incoming.password'] }), /resolved_credential_incomplete/);
});

test('resolver surfaces a non-ok HTTP response as an error', async () => {
  const fetchImpl = async () => ({ ok: false, status: 403, json: async () => ({ error: 'field_path_not_allowed' }) });
  const resolver = createSecretFabricResolver({ baseUrl: 'http://x', apiToken: 't', fetchImpl });
  await assert.rejects(() => resolver({ resourceId: 'r1', purpose: 'imap-sync', fieldPaths: ['bad'] }), /field_path_not_allowed/);
});
