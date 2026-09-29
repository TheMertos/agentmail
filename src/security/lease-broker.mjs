import { randomUUID } from 'node:crypto';

const PRIVATE_FIELDS = new Set(['username', 'password', 'accessToken', 'refreshToken']);

export function createLeaseBroker({ resolver, clock = () => Date.now() }) {
  if (typeof resolver !== 'function') throw new TypeError('trusted credential resolver is required');
  const active = new Map();

  return {
    async acquire({ accountId, purpose, fields }) {
      const resolved = await resolver({ accountId, purpose, fields });
      if (!resolved?.username || (!resolved.password && !resolved.accessToken)) throw new Error('credential_lease_incomplete');
      const lease = {
        leaseId: randomUUID(),
        accountId,
        purpose,
        fields: [...fields],
        expiresAt: clock() + 300_000
      };
      const privateCredentials = { username: resolved.username, ...(resolved.password ? { password: resolved.password } : {}), ...(resolved.accessToken ? { accessToken: resolved.accessToken } : {}) };
      Object.defineProperty(lease, 'credentials', { value: privateCredentials, enumerable: false, writable: true });
      active.set(lease.leaseId, { lease, privateCredentials });
      return lease;
    },

    getPrivate(leaseId) {
      const entry = active.get(leaseId);
      if (!entry || clock() >= entry.lease.expiresAt) return null;
      return entry.privateCredentials;
    },

    async release(lease) {
      if (!lease?.leaseId) return;
      const entry = active.get(lease.leaseId);
      if (entry) {
        for (const field of PRIVATE_FIELDS) delete entry.privateCredentials[field];
        if (lease.credentials) for (const field of PRIVATE_FIELDS) delete lease.credentials[field];
        active.delete(lease.leaseId);
      }
    }
  };
}
