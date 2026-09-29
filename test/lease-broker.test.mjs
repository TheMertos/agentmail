import test from 'node:test';
import assert from 'node:assert/strict';
import { createLeaseBroker } from '../src/security/lease-broker.mjs';

test('lease metadata is serializable without credentials and release destroys private fields', async () => {
  const broker = createLeaseBroker({ resolver: async () => ({ username: 'user', password: 'secret' }) });
  const lease = await broker.acquire({ accountId: 'a', purpose: 'imap-sync', fields: ['imap'] });
  assert.equal(JSON.stringify(lease).includes('secret'), false);
  assert.equal(broker.getPrivate(lease.leaseId).password, 'secret');
  await broker.release(lease);
  assert.equal(broker.getPrivate(lease.leaseId), null);
});
