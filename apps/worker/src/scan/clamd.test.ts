import { afterEach, describe, expect, it } from 'vitest';

import { ScanUnavailable, createClamd, parseClamdReply } from './clamd.js';
import { eicar, startFakeClamd, type FakeClamd } from './fake-clamd.js';

const open: FakeClamd[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((server) => server.close()));
});

async function fake(behaviour?: Parameters<typeof startFakeClamd>[0]): Promise<FakeClamd> {
  const server = await startFakeClamd(behaviour);
  open.push(server);
  return server;
}

describe('parseClamdReply', () => {
  it('reads OK, FOUND and refuses everything else', () => {
    expect(parseClamdReply('stream: OK')).toEqual({ kind: 'clean' });
    expect(parseClamdReply('stream: Win.Test.EICAR_HDB-1 FOUND')).toEqual({
      kind: 'infected',
      signature: 'Win.Test.EICAR_HDB-1',
    });
    expect(() => parseClamdReply('INSTREAM size limit exceeded. ERROR')).toThrow(ScanUnavailable);
    expect(() => parseClamdReply('')).toThrow(ScanUnavailable);
  });

  it('keeps the signature name harmless to log and show', () => {
    const verdict = parseClamdReply('stream: <script>alert(1)</script> FOUND');
    expect(verdict.kind).toBe('infected');
    if (verdict.kind === 'infected') expect(verdict.signature).not.toMatch(/[<>() ]/);
  });
});

describe('clamd client (fake TCP server)', () => {
  it('says clean for ordinary bytes, in one chunk or many', async () => {
    const server = await fake();
    const clamd = createClamd({ host: '127.0.0.1', port: server.port, chunkBytes: 7 });
    expect(await clamd.scan(Buffer.from('hello world, this is a harmless text'))).toEqual({
      kind: 'clean',
    });
    expect(await clamd.scan(new Uint8Array(0))).toEqual({ kind: 'clean' });
    expect(server.scans()).toBe(2);
  });

  it('says infected for the EICAR test string, even split across chunks', async () => {
    const server = await fake();
    const clamd = createClamd({ host: '127.0.0.1', port: server.port, chunkBytes: 5 });
    const verdict = await clamd.scan(Buffer.from(`before ${eicar()} after`));
    expect(verdict).toEqual({ kind: 'infected', signature: 'Win.Test.EICAR_HDB-1' });
  });

  it('pings', async () => {
    const server = await fake();
    expect(await createClamd({ host: '127.0.0.1', port: server.port }).ping()).toBe(true);
  });

  it('never calls a file clean when the scanner is down, errors, babbles or hangs', async () => {
    const server = await fake();
    const port = server.port;
    await server.close();
    open.length = 0;
    await expect(createClamd({ host: '127.0.0.1', port }).scan(Buffer.from('x'))).rejects.toThrow(
      ScanUnavailable,
    );
    expect(await createClamd({ host: '127.0.0.1', port }).ping()).toBe(false);

    const erroring = await fake('error-reply');
    await expect(
      createClamd({ host: '127.0.0.1', port: erroring.port }).scan(Buffer.from('x')),
    ).rejects.toThrow(ScanUnavailable);
    const garbage = await fake('garbage');
    await expect(
      createClamd({ host: '127.0.0.1', port: garbage.port }).scan(Buffer.from('x')),
    ).rejects.toThrow(ScanUnavailable);
    const hanging = await fake('hang');
    await expect(
      createClamd({ host: '127.0.0.1', port: hanging.port, timeoutMs: 150 }).scan(Buffer.from('x')),
    ).rejects.toThrow(/timed out/);
  });
});

describe('clamd client: total deadline (T-155a C-10)', () => {
  it('gives up on a peer that keeps sending one byte now and then, which an idle timeout never catches', async () => {
    const server = await fake('trickle');
    const clamd = createClamd({
      host: '127.0.0.1',
      port: server.port,
      timeoutMs: 5000,
      deadlineMs: 300,
    });
    const started = Date.now();
    await expect(clamd.scan(Buffer.from('x'))).rejects.toThrow(/deadline/);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('clamd client: a file the scanner could not look into (T-155a C-2)', () => {
  it('reads `Heuristics.Encrypted.Zip FOUND` as infected, not as clean or as an error', () => {
    expect(parseClamdReply('stream: Heuristics.Encrypted.Zip FOUND')).toEqual({
      kind: 'infected',
      signature: 'Heuristics.Encrypted.Zip',
    });
    expect(parseClamdReply('stream: Heuristics.Limits.Exceeded FOUND').kind).toBe('infected');
  });

  it('is infected for a zip with the encrypted flag, through the wire format', async () => {
    const server = await fake();
    const zip = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x01, 0x00]),
      Buffer.from('rest of a password-protected zip'),
    ]);
    expect(await createClamd({ host: '127.0.0.1', port: server.port }).scan(zip)).toEqual({
      kind: 'infected',
      signature: 'Heuristics.Encrypted.Zip',
    });
    const plain = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x61]);
    expect(await createClamd({ host: '127.0.0.1', port: server.port }).scan(plain)).toEqual({
      kind: 'clean',
    });
  });
});
