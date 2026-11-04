import { createTransport, type Transporter } from 'nodemailer';

export interface OutboundMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  /** Extra headers (for example `List-Unsubscribe`). Names and values are plain ASCII, no line breaks. */
  readonly headers?: Readonly<Record<string, string>> | undefined;
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
  /** Account for SMTP AUTH. Both or neither; the password is a secret and is never logged. */
  readonly user?: string | undefined;
  readonly password?: string | undefined;
  /**
   * Production only: allow a connection that is not encrypted or not authenticated (an internal
   * relay on a trusted network). Off by default (N1): without it production refuses such a send.
   */
  readonly allowInsecure?: boolean | undefined;
  /** True in a production deployment. Locally Mailpit speaks plain, unauthenticated SMTP. */
  readonly production?: boolean | undefined;
}

/** How the connection is secured, decided by port and environment. */
export type SmtpSecurity = 'implicit-tls' | 'starttls' | 'opportunistic';

export const SMTP_IMPLICIT_TLS_PORT = 465;
export const SMTP_SUBMISSION_PORT = 587;

/**
 * Port 465 is TLS from the first byte (implicit TLS). Port 587, and every port in production, must
 * upgrade with STARTTLS or the send fails rather than going out in clear. Any other port outside
 * production (Mailpit on 1025) takes whatever the server offers and needs no TLS.
 */
export function resolveSmtpSecurity(settings: SmtpSettings): SmtpSecurity {
  if (settings.port === SMTP_IMPLICIT_TLS_PORT) return 'implicit-tls';
  if (settings.port === SMTP_SUBMISSION_PORT || settings.production === true) return 'starttls';
  return 'opportunistic';
}

/**
 * What is wrong with these settings, as variable names and rules only (never a value, so a failed
 * boot cannot leak the password). Empty when the settings can be used.
 */
export function smtpSettingsIssues(
  settings: SmtpSettings,
): readonly { readonly variable: string; readonly message: string }[] {
  const issues: { variable: string; message: string }[] = [];
  const hasUser = Boolean(settings.user);
  const hasPassword = Boolean(settings.password);
  if (hasUser !== hasPassword) {
    issues.push({
      variable: hasUser ? 'SMTP_PASSWORD' : 'SMTP_USER',
      message:
        'must be set together with the other SMTP_USER / SMTP_PASSWORD variable, or both left empty',
    });
  }
  if (
    settings.production === true &&
    settings.allowInsecure !== true &&
    !(hasUser && hasPassword)
  ) {
    issues.push({
      variable: 'SMTP_USER',
      message:
        'SMTP_USER and SMTP_PASSWORD are required in production: a plain unauthenticated send is refused (set SMTP_ALLOW_INSECURE=true only for a trusted internal relay)',
    });
  }
  if (hasUser && hasPassword && resolveSmtpSecurity(settings) === 'opportunistic') {
    issues.push({
      variable: 'SMTP_PORT',
      message:
        'sending a password needs an encrypted connection: use 465 (implicit TLS) or 587 (STARTTLS)',
    });
  }
  return issues;
}

/**
 * SMTP over `SMTP_HOST`:`SMTP_PORT`. Locally that is Mailpit in compose, which keeps every message
 * on the machine. With `SMTP_USER` and `SMTP_PASSWORD` it authenticates (LOGIN/PLAIN, chosen by
 * the server); the credentials go to the transport only and are not part of any log or error.
 */
export function createSmtpMailer(settings: SmtpSettings): Mailer {
  const security = resolveSmtpSecurity(settings);
  const transport: Transporter = createTransport({
    host: settings.host,
    port: settings.port,
    secure: security === 'implicit-tls',
    requireTLS: security === 'starttls' && settings.allowInsecure !== true,
    ...(settings.user !== undefined &&
    settings.user !== '' &&
    settings.password !== undefined &&
    settings.password !== ''
      ? { auth: { user: settings.user, pass: settings.password } }
      : {}),
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
        ...(message.headers === undefined ? {} : { headers: { ...message.headers } }),
      });
    },
    close() {
      transport.close();
    },
  };
}
