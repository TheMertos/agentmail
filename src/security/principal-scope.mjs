/**
 * Account registry scoped to the trusted runtime principal (never from MCP arguments).
 * @param {import('../storage/sqlite-store.mjs').SqliteMailStore} store Mail store.
 * @param {string} principal Runtime principal from AGENTMAIL_PRINCIPAL.
 */
export function createPrincipalRegistry(store, principal) {
  if (!principal) throw new Error('runtime_principal_required');

  /**
   * @param {string} accountId
   */
  function assertAccountAccess(accountId) {
    const owned = store.getAccountForPrincipal(accountId, principal);
    if (!owned?.enabled) throw new Error('access_denied');
    return owned;
  }

  return {
    principal,
    get: (id) => store.getAccountForPrincipal(id, principal),
    list() {
      return store.listActiveAccountsForPrincipal(principal).map(({ secretRef, ownerPrincipal, ...account }) => ({
        ...account,
        hasCredentialReference: true
      }));
    },
    status(id) {
      const account = store.getAccountForPrincipal(id, principal);
      if (!account) return null;
      return {
        id: account.id,
        email: account.email,
        provider: account.provider,
        enabled: account.enabled,
        hasCredentialReference: true
      };
    },
    register(account) {
      return store.activateAccountForPrincipal(account, principal);
    },
    deactivate(id) {
      assertAccountAccess(id);
      store.deactivateAccount(id);
      return { accountId: id, status: 'inactive', localDataRetained: true };
    },
    assertAccountAccess
  };
}
