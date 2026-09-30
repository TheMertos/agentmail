/** Principal used in unit tests that exercise owned account storage. */
export const TEST_PRINCIPAL = 'test-principal';

/**
 * @param {import('../src/storage/sqlite-store.mjs').SqliteMailStore} store
 * @param {object} account
 */
export function activateTestAccount(store, account) {
  return store.activateAccountForPrincipal(account, TEST_PRINCIPAL);
}
