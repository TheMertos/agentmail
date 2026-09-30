import { ImapFlow } from 'imapflow';

/**
 * Inbox IDLE connection that is never shared with mailbox sync.
 * Sync keeps its own ImapFlow client so IDLE and FETCH cannot collide.
 */
export class ImapIdleConnection {
  /**
   * @param {object} options connection, credentials, optional createClient for tests.
   */
  constructor({ connection, credentials, createClient }) {
    if (!connection?.host || !connection?.port || !credentials?.username) {
      throw new TypeError('IMAP connection and trusted credentials are required');
    }
    this.client = typeof createClient === 'function'
      ? createClient({ connection, credentials })
      : new ImapFlow({
        host: connection.host,
        port: connection.port,
        secure: connection.security !== 'starttls',
        auth: { user: credentials.username, pass: credentials.password },
        disableAutoIdle: true
      });
  }

  /**
   * Open the IMAP socket.
   * @returns {Promise<unknown>} Connected client.
   */
  connect() {
    return this.client.connect();
  }

  /**
   * Select one mailbox before IDLE.
   * @param {string} path Mailbox path.
   * @returns {Promise<unknown>} Selected mailbox.
   */
  mailboxOpen(path) {
    return this.client.mailboxOpen(path);
  }

  /**
   * Enter IDLE until the server ends it or the socket closes.
   * @returns {Promise<unknown>} IDLE result.
   */
  idle() {
    return this.client.idle();
  }

  /**
   * Subscribe to client events such as exists and expunge.
   * @param {string} event Event name.
   * @param {(...args: unknown[]) => void} listener Event listener.
   * @returns {void}
   */
  on(event, listener) {
    this.client.on(event, listener);
  }

  /**
   * Log out this IDLE client. A stuck logout is abandoned and the socket is closed.
   * @returns {Promise<void>}
   */
  async close() {
    const logout = Promise.resolve().then(() => this.client.logout?.());
    logout.catch(() => {});
    let loggedOut = false;
    let timer;
    try {
      await Promise.race([
        logout.then(() => { loggedOut = true; }, () => { loggedOut = false; }),
        new Promise((resolve) => { timer = setTimeout(resolve, 5_000); })
      ]);
    } finally {
      clearTimeout(timer);
    }
    if (!loggedOut) {
      try {
        this.client.close?.();
      } catch {
        // The socket may already be gone.
      }
    }
  }
}
