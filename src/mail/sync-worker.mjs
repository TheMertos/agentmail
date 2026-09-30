import { redactSensitiveText } from '../security/redact.mjs';
import { AccountSyncGate } from './account-sync-gate.mjs';

export class SyncWorker {
  constructor({ accounts, policies, sync, intervalMs = 300_000, logger = console }) {
    this.accounts = accounts;
    this.policies = policies;
    this.sync = sync;
    this.intervalMs = intervalMs;
    this.logger = logger;
    this.gate = new AccountSyncGate();
    this.running = null;
    this.timer = null;
  }

  async runOnce() {
    if (this.running) return this.running;
    this.running = (async () => {
      const jobs = [];
      for (const account of this.accounts.list()) {
        const policy = this.policies.get(account.id);
        if (policy?.enabled === false) continue;
        jobs.push(this.runAccount(account.id, policy));
      }
      return Promise.all(jobs);
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  async runAccount(accountId, policy) {
    try {
      await this.gate.run(accountId, () => this.sync(accountId, {
        mode: policy?.mode === 'full-mirror' ? 'incremental' : (policy?.mode ?? 'incremental')
      }));
      return { accountId, status: 'ok' };
    } catch (error) {
      const safeError = redactSensitiveText(error?.message ?? String(error));
      const result = { accountId, status: 'error', error: safeError };
      this.logger?.error?.({ event: 'account_sync_failed', accountId, error: safeError });
      return result;
    }
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
