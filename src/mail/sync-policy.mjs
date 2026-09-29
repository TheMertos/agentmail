function patternToRegExp(pattern) {
  const escaped = pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${escaped}$`);
}

function matches(path, pattern) {
  return pattern === '**' || patternToRegExp(pattern).test(path);
}

export function createSyncPolicy(input = {}) {
  if (!input.accountId) throw new TypeError('accountId is required');
  const include = input.include?.length ? [...input.include] : ['**'];
  const exclude = input.exclude ? [...input.exclude] : [];
  if (!include.length || (include.includes('**') && exclude.includes('**'))) throw new Error('policy would exclude all mailboxes');
  return {
    accountId: input.accountId,
    mode: input.mode ?? 'full-mirror',
    include,
    exclude,
    intervalSeconds: Math.max(30, Number(input.intervalSeconds ?? 300)),
    downloadBodies: input.downloadBodies !== false,
    downloadAttachments: input.downloadAttachments !== false,
    enabled: input.enabled !== false
  };
}

export function mailboxIncluded(path, policy) {
  if (!policy?.enabled) return false;
  return policy.include.some((pattern) => matches(path, pattern)) && !policy.exclude.some((pattern) => matches(path, pattern));
}
