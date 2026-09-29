export class SyncWorker {
  constructor({ accounts, policies, sync, intervalMs = 300_000 }) {
    this.accounts = accounts;
    this.policies = policies;
    this.sync = sync;
    this.intervalMs = intervalMs;
    this.running = null;
    this.timer = null;
  }

  async runOnce() {
    if (this.running) return this.running;
    this.running = (async () => {
      const results = [];
      try {
        for (const account of this.accounts.list()) {
          const policy = this.policies.get(account.id);
          if (policy?.enabled === false) continue;
          try {
            await this.sync(account.id, { mode: policy?.mode === 'full-mirror' ? 'incremental' : (policy?.mode ?? 'incremental') });
            results.push({ accountId: account.id, status: 'ok' });
          } catch (error) {
            results.push({ accountId: account.id, status: 'error', error: error.message });
          }
        }
        return results;
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.runOnce(); }, this.intervalMs);
    this.timer.unref?.();
    void this.runOnce();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
