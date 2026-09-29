export function selectSignatureProfile(profiles, { accountId, explicitId, defaultId } = {}) {
  if (!Array.isArray(profiles) || !accountId) throw new TypeError('profiles and accountId are required');
  const active = profiles.filter((profile) => profile?.enabled !== false && profile.accountId === accountId);
  if (explicitId) {
    const explicit = profiles.find((profile) => profile?.id === explicitId);
    if (explicit && explicit.accountId !== accountId) throw new Error('signature belongs to another account');
    return active.find((profile) => profile.id === explicitId) ?? null;
  }
  return active.find((profile) => profile.id === defaultId) ?? null;
}
