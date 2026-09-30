import { startInboxIdleWatcher } from '../mail/inbox-idle-watcher.mjs';

/**
 * Start at most one Inbox IDLE watcher per enabled account.
 * A second watch() for an account that already has a watcher does nothing.
 * @param {object} options Account list, session opener, sync callback, and watcher timing.
 * @returns {{ watch: (accountId: string) => void, stop: () => Promise<void> }} Coordinator handle.
 */
export function startInboxIdleCoordinator({
  accounts,
  isEnabled = () => true,
  openSession,
  requestSync,
  ...watcherOptions
}) {
  /** @type {Map<string, { stop: () => Promise<void> }>} */
  const watchers = new Map();

  /**
   * Open the account watcher when it is enabled and not already running.
   * @param {string} accountId Account id.
   * @returns {void}
   */
  function watch(accountId) {
    if (!accountId || watchers.has(accountId) || !isEnabled(accountId)) return;
    watchers.set(accountId, startInboxIdleWatcher({
      ...watcherOptions,
      accountId,
      openSession: () => openSession(accountId),
      onChange: requestSync
    }));
  }

  for (const account of accounts ?? []) watch(account.id);

  return {
    watch,
    /**
     * Stop every watcher and wait until each session is released.
     * @returns {Promise<void>}
     */
    async stop() {
      const running = [...watchers.values()];
      watchers.clear();
      await Promise.all(running.map((watcher) => watcher.stop()));
    }
  };
}
