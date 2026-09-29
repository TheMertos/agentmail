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
    const result = await this.transporter.sendMail({ raw: mime });
    return { accepted: result.accepted ?? [], messageId: result.messageId ?? null };
  }

  close() { this.transporter.close(); }
}
