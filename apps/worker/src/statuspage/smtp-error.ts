/**
 * What an SMTP failure means for the status page emails (T-125a). nodemailer puts the server's reply
 * code in `responseCode` and its own class in `code` (`EAUTH`, `EENVELOPE`, ...).
 *
 *  - `auth`: the server refused OUR login or our right to send (535 bad credentials, 534, 530, EAUTH).
 *    Not about the reader: no mailbox is marked rejected and a retry with the same settings fails the
 *    same way, so the job stops and a person with the keys is told.
 *  - `permanent`: the server refuses this mailbox for good (other 5xx, or an envelope the transport
 *    refused before any server answer).
 *  - `transient`: 4xx (451 "try again later", 421, 450 ...) or no reply at all (connection reset):
 *    it may pass, so the claim is released and the job retries with backoff.
 */
export type SmtpFailure = 'auth' | 'permanent' | 'transient';

const AUTH_RESPONSE_CODES: readonly number[] = [530, 534, 535];

export function classifySmtpError(error: unknown): SmtpFailure {
  if (typeof error !== 'object' || error === null) return 'transient';
  const { responseCode, code } = error as { responseCode?: unknown; code?: unknown };
  const reply = typeof responseCode === 'number' ? responseCode : undefined;
  if (code === 'EAUTH' || (reply !== undefined && AUTH_RESPONSE_CODES.includes(reply))) {
    return 'auth';
  }
  if (reply !== undefined) {
    if (reply >= 500 && reply < 600) return 'permanent';
    // An envelope refusal that carries a 4xx reply (451 on RCPT TO) is the server asking us to wait.
    return 'transient';
  }
  return code === 'EENVELOPE' ? 'permanent' : 'transient';
}
