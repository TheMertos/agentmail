import nodemailer from 'nodemailer';

export class SmtpProvider {
  constructor({ connection, credentials }) {
    if (!connection?.host || !connection?.port || !credentials?.username || !credentials?.password) throw new TypeError('SMTP connection and trusted credentials are required');
    this.transporter = nodemailer.createTransport({
      host: connection.host,
      port: Number(connection.port),
      secure: connection.security === 'tls',
      requireTLS: connection.security === 'starttls',
      auth: { user: credentials.username, pass: credentials.password }
    });
  }

  async send(mime) {
    const header = (name) => mime.match(new RegExp(`^${name}:\\s*(.+)$`, 'mi'))?.[1]?.trim();
    const splitAddresses = (value) => (value ?? '').split(',').map((item) => item.trim()).filter(Boolean);
    const from = header('From');
    const to = splitAddresses(header('To'));
    const cc = splitAddresses(header('Cc'));
    const bcc = splitAddresses(header('Bcc'));
    if (!from || !to.length) throw new Error('mime_envelope_missing');
    const result = await this.transporter.sendMail({ raw: mime, envelope: { from, to: [...to, ...cc, ...bcc] } });
    return { accepted: result.accepted ?? [], messageId: result.messageId ?? null };
  }

  close() { this.transporter.close(); }
}
