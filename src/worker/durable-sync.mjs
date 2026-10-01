/**
 * Remote-only mode does not start mailbox sync or IMAP IDLE.
 * @returns {{ worker: null, syncEnabled: false, idleEnabled: false, stop: () => void }} Disabled worker.
 */
export function startDurableSyncWorker() {
  return {
    worker: null,
    syncEnabled: false,
    idleEnabled: false,
    /**
     * No interval or IDLE session was started.
     * @returns {void}
     */
    stop() {}
  };
}
