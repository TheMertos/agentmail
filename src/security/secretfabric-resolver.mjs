export function createSecretFabricResolver({ baseUrl, apiToken, fetchImpl = fetch }) {
  if (!baseUrl || !apiToken) throw new TypeError('baseUrl and apiToken are required');

  return async function resolveCredentials({ resourceId, purpose, fieldPaths }) {
    const response = await fetchImpl(`${baseUrl}/api/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiToken}` },
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
