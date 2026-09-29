import { createHash, randomUUID } from 'node:crypto';

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function payloadDigest(payload) {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(payload)))
    .digest('hex');
}

export function createApproval(payload, { ttlSeconds = 300, now = Math.floor(Date.now() / 1000) } = {}) {
  if (!payload || typeof payload !== 'object') throw new TypeError('approval payload must be an object');
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) throw new RangeError('ttlSeconds must be positive');
  return {
    id: randomUUID(),
    payloadDigest: payloadDigest(payload),
    issuedAt: now,
    expiresAt: now + ttlSeconds
  };
}

export function verifyApproval(approval, payload, now = Math.floor(Date.now() / 1000)) {
  if (!approval || typeof approval !== 'object') return false;
  if (!Number.isInteger(now) || now > approval.expiresAt) return false;
  return approval.payloadDigest === payloadDigest(payload);
}

export { canonicalize, payloadDigest };
