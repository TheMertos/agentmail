/** Trusted SecretFabric principal header (never JSON body or MCP args). */
export const HERMES_PRINCIPAL_HEADER = 'x-hermes-principal';

/**
 * Creates a SecretFabric client for the existing POST /api/resolve contract.
 * @param {{ baseUrl: string, apiToken: string, principal: string, fetchImpl?: typeof fetch }} options Runtime client options.
 * @returns {(request: { resourceId: string, purpose: string, fieldPaths: string[] }) => Promise<object>} Resolve function.
 */
export function createSecretFabricClient({ baseUrl, apiToken, principal, fetchImpl = fetch }) {
  if (!baseUrl || !apiToken || !principal) throw new TypeError('baseUrl, apiToken, and principal are required');

  /**
   * Resolve one resource version. Callers must not log the returned fields.
   * @param {{ resourceId: string, purpose: string, fieldPaths: string[] }} request Resolve request.
   * @returns {Promise<{ requestId?: string, resourceId?: string, version?: number, expiresInSeconds?: number, fields?: object }>}
   */
  return async function resolveResource({ resourceId, purpose, fieldPaths }) {
    const response = await fetchImpl(`${baseUrl}/api/resolve`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiToken}`,
        [HERMES_PRINCIPAL_HEADER]: principal
      },
      body: JSON.stringify({ resourceId, purpose, fieldPaths })
    });
    const payload = await response.json();
    if (!response.ok) {
      const code = payload.error ?? `secretfabric_http_${response.status}`;
      const error = new Error(code);
      error.code = code;
      error.status = response.status;
      throw error;
    }
    return payload;
  };
}

/**
 * Maps one resolve response to username and password for resolver tests.
 * Runtime provider access does not use this. It reconciles into the encrypted cache.
 * @param {{ baseUrl: string, apiToken: string, principal: string, fetchImpl?: typeof fetch }} options
 * @returns {(request: { resourceId: string, purpose: string, fieldPaths: string[] }) => Promise<{ username: string, password: string }>}
 */
export function createSecretFabricResolver(options) {
  const resolveResource = createSecretFabricClient(options);

  return async function resolveCredentials(request) {
    const payload = await resolveResource(request);
    const fields = payload.fields ?? {};
    const username = fields['incoming.username'] ?? fields['outgoing.username'] ?? fields['identity.email'];
    const password = fields['incoming.password'] ?? fields['outgoing.password'];
    if (!username || !password) throw new Error('resolved_credential_incomplete');
    return { username, password };
  };
}
