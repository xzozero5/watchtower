import { createConnection, type Socket } from 'node:net';

/**
 * A minimal clamd client over TCP (ADR-022). Only `INSTREAM` (scan bytes we hold) and `PING`; the
 * protocol is a few lines, so there is no dependency to add. `clamd` is reached inside the compose
 * network (`clamav:3310`), never published.
 *
 * Wire format (clamd(8), "z" = NUL-delimited commands and replies):
 *   -> `zINSTREAM\0`, then chunks of `<4-byte big-endian length><bytes>`, then a zero length;
 *   <- `stream: OK\0` | `stream: <Signature> FOUND\0` | `<reason> ERROR\0`.
 */

export type ScanVerdict =
  { readonly kind: 'clean' } | { readonly kind: 'infected'; readonly signature: string };

/** The scanner could not give a verdict (down, timed out, refused the stream). Never means "clean". */
export class ScanUnavailable extends Error {
  constructor(reason: string) {
    super(`clamd: ${reason}`);
    this.name = 'ScanUnavailable';
  }
}

export interface ClamdOptions {
  readonly host: string;
  readonly port: number;
  /** Whole-scan deadline. `[ASSUMED]` 60 s: a 25 MB file scans in seconds; a cold clamd needs time to answer. */
  readonly timeoutMs?: number;
  /** Bytes per chunk. clamd's `StreamMaxLength` (default 25 MB) caps the total, not the chunk. */
  readonly chunkBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_CHUNK_BYTES = 64 * 1024;
/** A reply is one short line; anything bigger is not clamd. */
const MAX_REPLY_BYTES = 4096;

/** Parses one clamd reply line (without the NUL). Exported for tests. */
export function parseClamdReply(reply: string): ScanVerdict {
  const text = reply.trim();
  if (/^stream:\s*OK$/i.test(text)) return { kind: 'clean' };
  const found = /^stream:\s*(.+?)\s+FOUND$/i.exec(text);
  if (found?.[1] !== undefined) {
    // The signature name goes into an audit row and a ticket note: keep only name-like characters.
    return { kind: 'infected', signature: found[1].replace(/[^\w.\-/]/g, '_').slice(0, 120) };
  }
  // `... ERROR` (for example "INSTREAM size limit exceeded.") or something unrecognised: no verdict.
  throw new ScanUnavailable(
    /ERROR$/i.test(text) ? 'scanner reported an error' : 'unexpected reply',
  );
}

export interface Clamd {
  scan(bytes: Uint8Array): Promise<ScanVerdict>;
  /** True when clamd answers `PONG`. */
  ping(): Promise<boolean>;
}

export function createClamd(options: ClamdOptions): Clamd {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const chunkBytes = options.chunkBytes ?? DEFAULT_CHUNK_BYTES;

  /** Opens a connection, hands it to `send`, and resolves with the first NUL-terminated reply. */
  function exchange(send: (socket: Socket) => void): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const socket = createConnection({ host: options.host, port: options.port });
      let received = Buffer.alloc(0);
      let done = false;
      const finish = (error: Error | null, reply?: string): void => {
        if (done) return;
        done = true;
        socket.destroy();
        if (error !== null) reject(error);
        else resolve(reply ?? '');
      };
      socket.setTimeout(timeoutMs, () => {
        finish(new ScanUnavailable('timed out'));
      });
      socket.on('error', () => {
        finish(new ScanUnavailable('connection failed'));
      });
      socket.on('close', () => {
        // clamd closes after its reply; a close with a partial reply is still an answer we can read.
        if (received.length > 0) finish(null, received.toString('utf8'));
        else finish(new ScanUnavailable('connection closed without a reply'));
      });
      socket.on('data', (data: Buffer) => {
        received = Buffer.concat([received, data]);
        if (received.length > MAX_REPLY_BYTES) {
          finish(new ScanUnavailable('reply too long'));
          return;
        }
        const end = received.indexOf(0);
        if (end >= 0) finish(null, received.subarray(0, end).toString('utf8'));
      });
      socket.on('connect', () => {
        send(socket);
      });
    });
  }

  return {
    async scan(bytes) {
      const reply = await exchange((socket) => {
        socket.write('zINSTREAM\0');
        for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
          const chunk = bytes.subarray(offset, Math.min(offset + chunkBytes, bytes.length));
          const length = Buffer.alloc(4);
          length.writeUInt32BE(chunk.length, 0);
          socket.write(length);
          socket.write(chunk);
        }
        socket.write(Buffer.alloc(4)); // zero length: end of stream
      });
      return parseClamdReply(reply);
    },
    async ping() {
      try {
        const reply = await exchange((socket) => {
          socket.write('zPING\0');
        });
        return reply.trim() === 'PONG';
      } catch {
        return false;
      }
    },
  };
}
