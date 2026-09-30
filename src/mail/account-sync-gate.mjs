/**
 * Serializes sync work for one account.
 * A later call waits until the current run finishes, so IDLE and the interval
 * scheduler cannot overlap on that account. Other accounts stay independent.
 */
export class AccountSyncGate {
  constructor() {
    /** @type {Map<string, Promise<void>>} */
    this.tails = new Map();
  }

  /**
   * Run fn after any in-flight sync for the same account.
   * @param {string} accountId Account id.
   * @param {() => Promise<unknown>} fn Sync work.
   * @returns {Promise<unknown>} Result of this call.
   */
  run(accountId, fn) {
    const previous = this.tails.get(accountId) ?? Promise.resolve();
    const result = previous.then(() => fn(), () => fn());
    this.tails.set(accountId, result.then(() => {}, () => {}));
    return result;
  }
}
