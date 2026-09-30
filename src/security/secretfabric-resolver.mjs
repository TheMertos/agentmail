/** Trusted SecretFabric principal header (never JSON body or MCP args). */
export const HERMES_PRINCIPAL_HEADER = 'x-hermes-principal';

/**
 * Creates a scoped SecretFabric credential resolver for one trusted runtime principal.
 * @param {{ baseUrl: string, apiToken: string, principal: string, fetchImpl?: typeof fetch }} options
 */
export function createSecretFabricResolver({ baseUrl, apiToken, principal, fetchImpl = fetch }) {
  if (!baseUrl || !apiToken || !principal) throw new TypeError('baseUrl, apiToken, and principal are required');

  return async function resolveCredentials({ resourceId, purpose, fieldPaths }) {
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
    if (!response.ok) throw new Error(payload.error ?? `secretfabric_http_${response.status}`);

    const fields = payload.fields ?? {};
    const username = fields['incoming.username'] ?? fields['outgoing.username'] ?? fields['identity.email'];
    const password = fields['incoming.password'] ?? fields['outgoing.password'];
    if (!username || !password) throw new Error('resolved_credential_incomplete');
    return { username, password };
  };
}
