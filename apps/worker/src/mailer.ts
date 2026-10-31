import { createTransport, type Transporter } from 'nodemailer';

export interface OutboundMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

/** The only way the worker sends email. Tests pass a fake; production uses SMTP. */
export interface Mailer {
  send(message: OutboundMessage): Promise<void>;
  close(): void;
}

export interface SmtpSettings {
  readonly host: string;
  readonly port: number;
  readonly from: string;
  /** In production the connection must upgrade to TLS; locally Mailpit speaks plain SMTP. */
  readonly requireTls: boolean;
}

/**
 * SMTP over `SMTP_HOST`:`SMTP_PORT`. Locally that is Mailpit in compose, which keeps every message
 * on the machine. SMTP authentication arrives with the production email adapter (T-007).
 */
export function createSmtpMailer(settings: SmtpSettings): Mailer {
  const transport: Transporter = createTransport({
    host: settings.host,
    port: settings.port,
    secure: false,
    requireTLS: settings.requireTls,
    // Fail fast: a job that cannot reach the server is retried by BullMQ with backoff.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  return {
    async send(message) {
      await transport.sendMail({
        from: settings.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
      });
    },
    close() {
      transport.close();
    },
  };
}
