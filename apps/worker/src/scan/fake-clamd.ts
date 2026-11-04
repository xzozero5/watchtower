import { createServer, type Server, type Socket } from 'node:net';

/**
 * The EICAR test string (a harmless, industry-standard "virus" every scanner flags). Built from two
 * halves at run time so this source file does not itself look like malware to a desktop antivirus.
 */
export function eicar(): string {
  return ['X5O!P%@AP[4\\PZX54(P^)7CC)7}$', 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'].join('');
}

/** A zip whose first local header has bit 0 of the general-purpose flags (encrypted) set. */
export function isEncryptedZip(bytes: Uint8Array): boolean {
  return (
    bytes.length > 7 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04 &&
    ((bytes[6] ?? 0) & 1) === 1
  );
}

export interface FakeClamd {
  readonly port: number;
  /** How many INSTREAM scans it served. */
  readonly scans: () => number;
  close(): Promise<void>;
}

export type FakeBehaviour = 'normal' | 'error-reply' | 'hang' | 'garbage' | 'trickle';

/**
 * A stand-in for clamd for tests: speaks the INSTREAM / PING wire format and says FOUND for any stream
 * that contains the EICAR string, OK otherwise. Never a real scanner; the real one is only used by hand.
 */
export async function startFakeClamd(behaviour: FakeBehaviour = 'normal'): Promise<FakeClamd> {
  let scans = 0;
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    let mode: 'command' | 'stream' = 'command';
    const body: Buffer[] = [];
    socket.on('error', () => undefined);
    socket.on('data', (data: Buffer) => {
      buffer = Buffer.concat([buffer, data]);
      for (;;) {
        if (mode === 'command') {
          const end = buffer.indexOf(0);
          if (end < 0) return;
          const command = buffer.subarray(0, end).toString('utf8');
          buffer = buffer.subarray(end + 1);
          if (command === 'zPING' || command === 'PING') {
            socket.end('PONG\0');
            return;
          }
          if (command === 'zINSTREAM' || command === 'INSTREAM') {
            mode = 'stream';
            continue;
          }
          socket.end('UNKNOWN COMMAND\0');
          return;
        }
        if (buffer.length < 4) return;
        const length = buffer.readUInt32BE(0);
        if (length === 0) {
          scans += 1;
          const whole = Buffer.concat(body);
          const content = whole.toString('latin1');
          if (behaviour === 'hang') return;
          if (behaviour === 'trickle') {
            // Never finishes the reply, never goes quiet: only a total deadline stops this.
            const timer = setInterval(() => {
              if (!socket.destroyed) socket.write('a');
            }, 20);
            socket.on('close', () => {
              clearInterval(timer);
            });
            return;
          }
          if (behaviour === 'error-reply') socket.end('INSTREAM size limit exceeded. ERROR\0');
          else if (behaviour === 'garbage') socket.end('what is this\0');
          else if (content.includes(eicar())) socket.end('stream: Win.Test.EICAR_HDB-1 FOUND\0');
          // Like clamd with `AlertEncrypted yes` (config/clamav/clamd.conf): a zip whose first entry has
          // the "encrypted" flag set is answered as a detection instead of OK.
          else if (isEncryptedZip(whole)) socket.end('stream: Heuristics.Encrypted.Zip FOUND\0');
          else socket.end('stream: OK\0');
          return;
        }
        if (buffer.length < 4 + length) return;
        body.push(buffer.subarray(4, 4 + length));
        buffer = buffer.subarray(4 + length);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return {
    port: address.port,
    scans: () => scans,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
        // Idle sockets would keep close() waiting (net.Server has no closeAllConnections).
        for (const socket of sockets) socket.destroy();
      }),
  };
}
