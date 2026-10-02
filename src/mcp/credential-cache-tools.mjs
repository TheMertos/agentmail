import { redactValue } from '../security/redact.mjs';
import { MAIL_CREDENTIAL_SCOPES } from '../runtime/mail-runtime.mjs';

/**
 * Non-sensitive credential cache status and reconcile handlers.
 * @param {{ registry: { assertAccountAccess: Function }, credentialSync: object|null, scopes?: object[] }} deps Principal registry and sync service.
 * @returns {{ credentialCacheStatus: Function, credentialCacheReconcile: Function }}
 */
export function createCredentialCacheHandlers({ registry, credentialSync, scopes = MAIL_CREDENTIAL_SCOPES }) {
  /**
   * Require an owned active account before cache access.
   * @param {string} accountId Account id.
   * @returns {object|null} Account, or null when access is denied.
   */
  function ownedAccount(accountId) {
    try {
      return registry.assertAccountAccess(accountId);
    } catch {
      return null;
    }
  }

  return {
    /**
     * Return cache status without ciphertext or credentials.
     * @param {{ accountId: string }} args Tool input.
     * @returns {Promise<object>}
     */
    async credentialCacheStatus({ accountId }) {
      if (!ownedAccount(accountId)) return { error: 'access_denied' };
      if (!credentialSync) return { error: 'credential_cache_unconfigured' };
      return redactValue({ accountId, entries: credentialSync.listStatus(accountId) });
    },

    /**
     * Refresh encrypted cache rows from SecretFabric. The result is status only.
     * @param {{ accountId: string }} args Tool input.
     * @returns {Promise<object>}
     */
    async credentialCacheReconcile({ accountId }) {
      const account = ownedAccount(accountId);
      if (!account) return { error: 'access_denied' };
      if (!credentialSync) return { error: 'credential_cache_unconfigured' };
      const entries = [];
      for (const scope of scopes) {
        entries.push(await credentialSync.reconcile({
          account,
          purpose: scope.purpose,
          fieldPaths: scope.fieldPaths
        }));
      }
      return redactValue({ accountId, entries });
    }
  };
}
