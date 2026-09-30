/** Default quiet period before an EXISTS or EXPUNGE event starts a sync. */
export const DEFAULT_IDLE_DEBOUNCE_MS = 1_000;

/** Default cap for one IDLE wait so a stuck server cannot block the worker. */
export const DEFAULT_IDLE_TIMEOUT_MS = 29 * 60 * 1000;

/** Default number of consecutive IDLE failures before the watcher stops. */
export const DEFAULT_IDLE_MAX_ATTEMPTS = 5;

/**
 * Exponential reconnect delay for one failed IDLE attempt.
 * @param {number} attempt 1-based failure count.
 * @param {number} initialMs Delay after the first failure.
 * @param {number} maxMs Upper bound.
 * @returns {number} Delay in milliseconds.
 */
export function idleBackoffMs(attempt, initialMs, maxMs) {
  const shift = Math.min(20, Math.max(0, Number(attempt) - 1));
  return Math.min(maxMs, initialMs * (2 ** shift));
}

/**
 * Whether this error is the watcher's own shutdown signal.
 * @param {unknown} error Caught value.
 * @returns {boolean} True when stop() aborted the wait.
 */
function isStop(error) {
  return error?.message === 'imap_idle_stopped';
}

/**
 * Watch Inbox on a dedicated IDLE session and report mailbox changes.
 * Connection drops use bounded exponential backoff. A hung IDLE call is closed
 * at idleTimeoutMs and opened again, so the worker never waits forever.
 * Giving up on IDLE does not stop the interval scheduler.
 * @param {object} options accountId, openSession, onChange, and timing hooks.
 * @returns {{ accountId: string, settled: Promise<void>, stop: () => Promise<void> }} Watcher handle.
 */
export function startInboxIdleWatcher({
  accountId,
  openSession,
  onChange,
  debounceMs = DEFAULT_IDLE_DEBOUNCE_MS,
  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
  maxAttempts = DEFAULT_IDLE_MAX_ATTEMPTS,
  initialBackoffMs = 1_000,
  maxBackoffMs = 60_000,
  inboxPath = 'INBOX',
  sleep: sleepImpl
}) {
  let stopped = false;
  let wakeSleep = () => {};
  const sleep = sleepImpl ?? ((ms) => new Promise((resolve) => {
    const timer = setTimeout(() => {
      wakeSleep = () => {};
      resolve();
    }, ms);
    wakeSleep = () => {
      clearTimeout(timer);
      wakeSleep = () => {};
      resolve();
    };
  }));
  let debounceTimer = null;
  let activeRelease = async () => {};
  let resolveSettled = () => {};
  const settled = new Promise((resolve) => { resolveSettled = resolve; });
  let markStopped = () => {};
  const stoppedPromise = new Promise((resolve) => { markStopped = resolve; });
  /** @type {Set<(error: Error) => void>} */
  const abortWaiters = new Set();

  /**
   * Abort in-flight connect, select, and IDLE waits.
   * @returns {void}
   */
  function abortWaits() {
    for (const fail of [...abortWaiters]) fail(new Error('imap_idle_stopped'));
  }

  /**
   * Await one step until it finishes, times out, or stop() is called.
   * @param {Promise<unknown>} promise In-flight step.
   * @param {number} timeoutMs Deadline.
   * @param {string} timeoutMessage Error message when the deadline wins.
   * @returns {Promise<unknown>} Step result.
   */
  function untilStop(promise, timeoutMs, timeoutMessage) {
    const pending = Promise.resolve(promise);
    pending.catch(() => {});
    return new Promise((resolve, reject) => {
      let settledStep = false;
      /**
       * @param {Error} error Failure or stop signal.
       * @returns {void}
       */
      const fail = (error) => {
        if (settledStep) return;
        settledStep = true;
        clearTimeout(timer);
        abortWaiters.delete(fail);
        reject(error);
      };
      const timer = setTimeout(() => fail(new Error(timeoutMessage)), timeoutMs);
      abortWaiters.add(fail);
      pending.then(
        (value) => {
          if (settledStep) return;
          settledStep = true;
          clearTimeout(timer);
          abortWaiters.delete(fail);
          resolve(value);
        },
        (error) => fail(error instanceof Error ? error : new Error(String(error)))
      );
    });
  }

  /**
   * Schedule one sync after the quiet period. Further events reset the timer.
   * @returns {void}
   */
  function scheduleChange() {
    if (stopped) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (stopped) return;
      void Promise.resolve(onChange(accountId)).catch(() => {});
    }, debounceMs);
  }

  /**
   * Release the current session once.
   * @returns {Promise<void>}
   */
  async function releaseActive() {
    const release = activeRelease;
    activeRelease = async () => {};
    await release();
  }

  /**
   * Reconnect until stop or the failure budget is spent.
   * @returns {Promise<void>}
   */
  async function loop() {
    let failures = 0;
    try {
      while (!stopped && failures < maxAttempts) {
        let recycle = false;
        let release = async () => {};
        try {
          const opening = Promise.resolve().then(() => openSession());
          opening.catch(() => {});
          let session;
          try {
            session = await untilStop(opening, idleTimeoutMs, 'imap_idle_open_timeout');
          } catch (error) {
            if (stopped || isStop(error)) {
              void opening.then((opened) => opened?.release?.()).catch(() => {});
              break;
            }
            throw error;
          }
          if (stopped || !session?.client) {
            await session?.release?.();
            break;
          }
          let released = false;
          release = async () => {
            if (released) return;
            released = true;
            await session.release?.();
          };
          activeRelease = release;
          const client = session.client;
          client.on('exists', scheduleChange);
          client.on('expunge', scheduleChange);
          await untilStop(client.connect(), idleTimeoutMs, 'imap_idle_connect_timeout');
          await untilStop(client.mailboxOpen(inboxPath), idleTimeoutMs, 'imap_idle_select_timeout');
          const idlePromise = Promise.resolve(client.idle());
          idlePromise.catch(() => {});
          try {
            await untilStop(idlePromise, idleTimeoutMs, 'imap_idle_timeout');
            if (stopped) break;
            failures += 1;
          } catch (error) {
            if (stopped || isStop(error)) break;
            if (error?.message === 'imap_idle_timeout') recycle = true;
            else failures += 1;
          }
        } catch (error) {
          if (stopped || isStop(error)) break;
          failures += 1;
        } finally {
          await release();
          if (activeRelease === release) activeRelease = async () => {};
        }
        if (stopped || failures >= maxAttempts) break;
        const wait = recycle
          ? initialBackoffMs
          : idleBackoffMs(Math.max(1, failures), initialBackoffMs, maxBackoffMs);
        await Promise.race([sleep(wait), stoppedPromise]);
      }
    } finally {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = null;
      resolveSettled();
    }
  }

  void loop();

  return {
    accountId,
    settled,
    /**
     * Close the IDLE session, release its lease, and stop reconnecting.
     * @returns {Promise<void>} Resolves when the watcher loop has finished.
     */
    async stop() {
      if (stopped) return settled;
      stopped = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = null;
      markStopped();
      wakeSleep();
      abortWaits();
      await releaseActive();
      await settled;
    }
  };
}
