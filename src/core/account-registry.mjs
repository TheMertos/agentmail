const FORBIDDEN_KEYS = new Set(['password', 'pass', 'secret', 'token', 'accessToken', 'refreshToken', 'privateKey']);

function assertSafeMetadata(value, path = 'metadata') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${path} must be an object`);
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key) || /password|token|secret|private.?key/i.test(key)) {
      throw new Error(`${path}.${key} is not allowed; use an opaque lease/reference`);
    }
    if (nested && typeof nested === 'object') assertSafeMetadata(nested, `${path}.${key}`);
  }
}

export function createAccountRegistry(initial = []) {
  const accounts = new Map();
  for (const account of initial) register(account);

  function register(account) {
    if (!account?.id || !account?.email || !account?.provider) throw new TypeError('id, email and provider are required');
    if (!account.secretRef || typeof account.secretRef !== 'string') throw new TypeError('secretRef is required');
    assertSafeMetadata(account.connection ?? {}, 'connection');
    const stored = {
      id: account.id,
      label: account.label ?? account.email,
      email: account.email,
      provider: account.provider,
      secretRef: account.secretRef,
      connection: structuredClone(account.connection ?? {}),
      status: account.status ?? 'disconnected'
    };
    accounts.set(stored.id, stored);
    return { ...stored, connection: { ...stored.connection } };
  }

  return {
    list() { return [...accounts.values()].map(({ secretRef, ...safe }) => ({ ...safe, hasCredentialReference: Boolean(secretRef) })); },
    get(id) { return accounts.get(id) ? { ...accounts.get(id) } : null; },
    register,
    status(id) {
      const account = accounts.get(id);
      if (!account) return null;
      return { id: account.id, email: account.email, provider: account.provider, status: account.status, hasCredentialReference: Boolean(account.secretRef) };
    }
  };
}

export { assertSafeMetadata };
