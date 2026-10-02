/**
 * Map SecretFabric email fields to the in-memory lease shape.
 * @param {object} fields Resolve field projection.
 * @returns {{ username: string, password: string }|null}
 */
export function mapMailCredentials(fields) {
  const username = fields?.['incoming.username'] ?? fields?.['outgoing.username'] ?? fields?.['identity.email'];
  const password = fields?.['incoming.password'] ?? fields?.['outgoing.password'];
  if (!username || !password) return null;
  return { username, password };
}

/**
 * Synchronize one opaque SecretFabric resource into the encrypted cache.
 * Uses the existing resolve contract. Resolved fields are not returned.
 * @param {{ cache: object, resolveResource: Function, mapFields?: Function, clock?: () => number }} deps Sync dependencies.
 * @returns {{ reconcile: Function, readForProvider: Function }}
 */
export function createCredentialSync({ cache, resolveResource, mapFields = mapMailCredentials, clock = () => Date.now() }) {
  /**
   * Public status plus a non-sensitive reconcile reason.
   * @param {string} accountId Account id.
   * @param {string} purpose Lease purpose.
   * @param {string} reason Stable reason code.
   * @returns {object}
   */
  function withReason(accountId, purpose, reason) {
    return { ...cache.status(accountId, purpose), reason };
  }

  return {
    /**
     * Resolve the resource, then update or invalidate the encrypted row.
     * @param {{ account: { id: string, secretRef: string }, purpose: string, fieldPaths: string[] }} input Account and resolve scope.
     * @returns {Promise<object>} Non-sensitive status.
     */
    async reconcile({ account, purpose, fieldPaths }) {
      if (!account?.id || !account.secretRef) throw new Error('account_not_found');
      let payload;
      try {
        payload = await resolveResource({ resourceId: account.secretRef, purpose, fieldPaths });
      } catch (error) {
        cache.invalidate(account.id, purpose, account.secretRef);
        const code = error?.code || error?.message;
        return withReason(account.id, purpose, code === 'resource_not_found' ? 'deleted' : 'resolve_failed');
      }
      const credentials = mapFields(payload?.fields ?? {});
      const version = payload?.version;
      const ttlSeconds = payload?.expiresInSeconds;
      if (!credentials || !Number.isInteger(version) || !Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
        cache.invalidate(account.id, purpose, payload?.resourceId ?? account.secretRef);
        return withReason(account.id, purpose, 'resolve_incomplete');
      }
      const previous = cache.status(account.id, purpose);
      cache.put({
        accountId: account.id,
        purpose,
        resourceId: payload.resourceId ?? account.secretRef,
        version,
        credentials,
        freshUntil: new Date(clock() + ttlSeconds * 1000).toISOString()
      });
      const reason = previous.status === 'current' && previous.version === version ? 'unchanged' : 'updated';
      return withReason(account.id, purpose, reason);
    },

    /**
     * Read decrypted credentials for a provider inside the service.
     * @param {string} accountId Account id.
     * @param {string} purpose Lease purpose.
     * @returns {{ username: string, password: string }}
     */
    readForProvider(accountId, purpose) {
      return cache.read(accountId, purpose, clock());
    },

    /**
     * List non-sensitive cache rows for one account.
     * @param {string} accountId Account id.
     * @returns {object[]}
     */
    listStatus(accountId) {
      return cache.listStatus(accountId);
    }
  };
}
