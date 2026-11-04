import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { EgressError, SafeImageFetcher, sniffImage, type SafeFetchOptions } from './safe-fetch.js';

// A fake web server on 127.0.0.1 stands in for the sender's server. The fake resolver says the "public"
// names live at documentation-free public addresses; `dial` is the test seam that sends the checked
// connection to the fake server. Nothing here touches the internet or the real resolver.

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 1),
]);
const PUBLIC = '93.184.216.34';

let server: http.Server;
let port = 0;
let hits: { url: string; headers: http.IncomingHttpHeaders }[] = [];
let handler: (request: http.IncomingMessage, response: http.ServerResponse) => void;

beforeAll(async () => {
  server = http.createServer((request, response) => {
    hits.push({ url: request.url ?? '', headers: request.headers });
    handler(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) =>
    server.close(() => {
      resolve();
    }),
  );
});
beforeEach(() => {
  hits = [];
  handler = (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'image/png' });
    response.end(PNG);
  };
});

interface Setup {
  fetcher: SafeImageFetcher;
  lookups: string[];
  dialed: string[];
}
function setup(
  answers: Record<string, string[] | (() => string[])>,
  options: Partial<SafeFetchOptions> = {},
): Setup {
  const lookups: string[] = [];
  const dialed: string[] = [];
  const fetcher = new SafeImageFetcher({
    allowHttp: true,
    allowedPorts: 'any',
    resolve: (name) => {
      lookups.push(name);
      const answer = answers[name];
      if (answer === undefined) return Promise.reject(new Error('ENOTFOUND'));
      return Promise.resolve(typeof answer === 'function' ? answer() : answer);
    },
    dial: (address) => {
      dialed.push(address);
      return { address: '127.0.0.1', port };
    },
    ...options,
  });
  return { fetcher, lookups, dialed };
}

async function reason(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof EgressError) return error.reason;
    throw error;
  }
  return 'fetched';
}

describe('SafeImageFetcher: the happy path', () => {
  it('fetches an image, connects to the checked address, and sends nothing of the user', async () => {
    const { fetcher, dialed } = setup({ 'img.example.test': [PUBLIC] });
    const image = await fetcher.fetchImage('http://img.example.test/a.png?token=abc');
    expect(image.contentType).toBe('image/png');
    expect(image.bytes.equals(PNG)).toBe(true);
    expect(dialed).toEqual([PUBLIC]);
    const sent = hits[0]?.headers ?? {};
    expect(sent['user-agent']).toBe('Watchtower-ImageProxy/1.0');
    expect(sent.host?.startsWith('img.example.test')).toBe(true); // the name, not the IP (the port is the fake server's)
    for (const name of ['cookie', 'authorization', 'referer', 'origin', 'x-forwarded-for']) {
      expect(sent[name], name).toBeUndefined();
    }
    expect(sent['accept-encoding']).toBe('identity');
    expect(hits[0]?.url).toBe('/a.png?token=abc');
  });

  it('names the type from the bytes, not from what the server claimed', async () => {
    handler = (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'image/jpeg' });
      response.end(PNG);
    };
    const { fetcher } = setup({ 'img.example.test': [PUBLIC] });
    expect((await fetcher.fetchImage('http://img.example.test/x.jpg')).contentType).toBe(
      'image/png',
    );
  });

  it('follows up to three redirects, relative ones included, checking every hop', async () => {
    handler = (request, response) => {
      const step = Number(/step=(\d)/.exec(request.url ?? '')?.[1] ?? 0);
      if (step < 3) {
        response.writeHead(302, { Location: `/r?step=${String(step + 1)}` });
        response.end();
      } else {
        response.writeHead(200, { 'Content-Type': 'image/png' });
        response.end(PNG);
      }
    };
    const { fetcher, lookups } = setup({ 'img.example.test': [PUBLIC] });
    await fetcher.fetchImage('http://img.example.test/r?step=0');
    expect(lookups).toHaveLength(4); // the first request plus three redirects: each resolved and checked
  });
});

describe('SafeImageFetcher: addresses that must never be reached', () => {
  it.each([
    ['loopback', 'http://127.0.0.1/a.png'],
    ['cloud metadata', 'http://169.254.169.254/latest/meta-data/'],
    ['IPv6 loopback', 'http://[::1]/a.png'],
    ['10/8', 'http://10.1.2.3/a.png'],
    ['172.16/12', 'http://172.16.0.9/a.png'],
    ['192.168/16', 'http://192.168.0.1/a.png'],
    ['IPv4-mapped loopback', 'http://[::ffff:127.0.0.1]/a.png'],
    ['decimal loopback', 'http://2130706433/a.png'],
    ['hex loopback', 'http://0x7f.1/a.png'],
    ['IPv6 metadata', 'http://[fd00:ec2::254]/a.png'],
    ['link-local v6', 'http://[fe80::1]/a.png'],
  ])('refuses a URL that is a literal %s without any request', async (_name, url) => {
    const { fetcher, lookups } = setup({});
    expect(await reason(fetcher.fetchImage(url))).toBe('blocked_address');
    expect(hits).toHaveLength(0);
    expect(lookups).toHaveLength(0);
  });

  it.each([
    ['10/8', '10.0.0.5'],
    ['loopback', '127.0.0.1'],
    ['metadata', '169.254.169.254'],
    ['::1', '::1'],
    ['mapped metadata', '::ffff:169.254.169.254'],
  ])('refuses a name that resolves to %s', async (_name, address) => {
    const { fetcher } = setup({ 'evil.example.test': [address] });
    expect(await reason(fetcher.fetchImage('http://evil.example.test/a.png'))).toBe(
      'blocked_address',
    );
    expect(hits).toHaveLength(0);
  });

  it('refuses a mixed answer: one private address among public ones is an attack', async () => {
    const { fetcher } = setup({ 'mixed.example.test': [PUBLIC, '10.0.0.5'] });
    expect(await reason(fetcher.fetchImage('http://mixed.example.test/a.png'))).toBe(
      'blocked_address',
    );
    expect(hits).toHaveLength(0);
  });

  it('refuses localhost, .local and .internal names before resolving them', async () => {
    const { fetcher, lookups } = setup({ localhost: [PUBLIC] });
    for (const host of ['localhost', 'a.localhost', 'printer.local', 'metadata.google.internal']) {
      expect(await reason(fetcher.fetchImage(`http://${host}/a.png`)), host).toBe('blocked_host');
    }
    expect(lookups).toHaveLength(0);
  });

  it('refuses a redirect from a public host to a private one, without calling it', async () => {
    handler = (_request, response) => {
      response.writeHead(302, { Location: 'http://127.0.0.1:8080/secret.png' });
      response.end();
    };
    const { fetcher } = setup({ 'img.example.test': [PUBLIC] });
    expect(await reason(fetcher.fetchImage('http://img.example.test/a.png'))).toBe(
      'blocked_address',
    );
    expect(hits).toHaveLength(1); // only the first hop reached the fake server
  });

  it('refuses a redirect to a name that resolves to the metadata address', async () => {
    handler = (_request, response) => {
      response.writeHead(301, { Location: 'http://rebind.example.test/a.png' });
      response.end();
    };
    const { fetcher } = setup({
      'img.example.test': [PUBLIC],
      'rebind.example.test': ['169.254.169.254'],
    });
    expect(await reason(fetcher.fetchImage('http://img.example.test/a.png'))).toBe(
      'blocked_address',
    );
    expect(hits).toHaveLength(1);
  });

  it('is not fooled by DNS rebinding: one lookup per hop, and the connection goes to the address that was checked', async () => {
    let calls = 0;
    // First answer public, every later one private, as a rebinding attacker's DNS would.
    const { fetcher, lookups, dialed } = setup({
      'rebind.example.test': () => (calls++ === 0 ? [PUBLIC] : ['127.0.0.1']),
    });
    const image = await fetcher.fetchImage('http://rebind.example.test/a.png');
    expect(image.contentType).toBe('image/png');
    expect(lookups).toEqual(['rebind.example.test']);
    expect(dialed).toEqual([PUBLIC]);
    // The next hop does resolve again, sees the private answer and refuses.
    handler = (_request, response) => {
      response.writeHead(302, { Location: 'http://rebind.example.test/b.png' });
      response.end();
    };
    calls = 0;
    expect(await reason(fetcher.fetchImage('http://rebind.example.test/a.png'))).toBe(
      'blocked_address',
    );
  });

  it('gives up after three redirects', async () => {
    handler = (_request, response) => {
      response.writeHead(302, { Location: '/again' });
      response.end();
    };
    const { fetcher } = setup({ 'img.example.test': [PUBLIC] });
    expect(await reason(fetcher.fetchImage('http://img.example.test/a.png'))).toBe('redirects');
    expect(hits).toHaveLength(4);
  });
});

describe('SafeImageFetcher: what a URL may look like', () => {
  it('is https only unless http is switched on', async () => {
    const { fetcher } = setup({ 'img.example.test': [PUBLIC] }, { allowHttp: false });
    expect(await reason(fetcher.fetchImage('http://img.example.test/a.png'))).toBe('scheme');
    for (const url of [
      'ftp://img.example.test/a.png',
      'file:///etc/passwd',
      'gopher://x/',
      'javascript:alert(1)',
    ]) {
      expect(await reason(fetcher.fetchImage(url)), url).toBe('scheme');
    }
    expect(await reason(fetcher.fetchImage('not a url'))).toBe('bad_url');
    expect(hits).toHaveLength(0);
  });

  it('refuses credentials in the URL and ports other than 80 and 443', async () => {
    const strict = new SafeImageFetcher({
      allowHttp: true,
      resolve: () => Promise.resolve([PUBLIC]),
      dial: () => ({ address: '127.0.0.1', port }),
    });
    expect(await reason(strict.fetchImage('http://user:pw@img.example.test/a.png'))).toBe(
      'credentials',
    );
    expect(await reason(strict.fetchImage('http://img.example.test:6379/a.png'))).toBe('port');
    expect(await reason(strict.fetchImage('http://img.example.test:22/a.png'))).toBe('port');
    expect(hits).toHaveLength(0);
    expect((await strict.fetchImage('http://img.example.test:80/a.png')).contentType).toBe(
      'image/png',
    );
  });

  it('reports a name that does not resolve as a failure, not a crash', async () => {
    const { fetcher } = setup({});
    expect(await reason(fetcher.fetchImage('http://nowhere.example.test/a.png'))).toBe('dns');
  });
});

describe('SafeImageFetcher: what the answer may be', () => {
  it('refuses a body over the limit, whether or not the server said how long it is', async () => {
    const { fetcher } = setup({ 'img.example.test': [PUBLIC] }, { maxBytes: 100 });
    handler = (_request, response) => {
      response.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Length': String(PNG.length + 500),
      });
      response.end(Buffer.concat([PNG, Buffer.alloc(500)]));
    };
    expect(await reason(fetcher.fetchImage('http://img.example.test/a.png'))).toBe('too_large');
    handler = (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'image/png' }); // chunked, no length
      response.write(PNG);
      response.write(Buffer.alloc(500));
      response.end();
    };
    expect(await reason(fetcher.fetchImage('http://img.example.test/a.png'))).toBe('too_large');
  });

  it.each([
    ['html served as html', 'text/html', Buffer.from('<html><script>1</script>')],
    ['html served as image/png', 'image/png', Buffer.from('<html><script>1</script>')],
    [
      'svg',
      'image/svg+xml',
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'),
    ],
    [
      'svg served as image/png',
      'image/png',
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
    ],
    ['no content type', '', PNG],
    ['an empty body', 'image/png', Buffer.alloc(0)],
  ])('refuses %s', async (_name, contentType, body) => {
    handler = (_request, response) => {
      response.writeHead(200, contentType === '' ? {} : { 'Content-Type': contentType });
      response.end(body);
    };
    const { fetcher } = setup({ 'img.example.test': [PUBLIC] });
    expect(await reason(fetcher.fetchImage('http://img.example.test/a.png'))).toBe('not_image');
  });

  it('refuses an error status', async () => {
    handler = (_request, response) => {
      response.writeHead(404, { 'Content-Type': 'image/png' });
      response.end(PNG);
    };
    const { fetcher } = setup({ 'img.example.test': [PUBLIC] });
    expect(await reason(fetcher.fetchImage('http://img.example.test/a.png'))).toBe('status');
  });

  it('stops waiting for a server that never answers', async () => {
    handler = () => {
      // never respond
    };
    const { fetcher } = setup({ 'img.example.test': [PUBLIC] }, { timeoutMs: 150 });
    const started = Date.now();
    expect(await reason(fetcher.fetchImage('http://img.example.test/a.png'))).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('SafeImageFetcher: header timeout and proxies (T-175a)', () => {
  it('cuts off a server that accepts and then says nothing after the header timeout, not the whole-fetch one', async () => {
    handler = () => {
      // never respond
    };
    const { fetcher } = setup(
      { 'img.example.test': [PUBLIC] },
      { timeoutMs: 10_000, headerTimeoutMs: 150 },
    );
    const started = Date.now();
    expect(await reason(fetcher.fetchImage('http://img.example.test/a.png'))).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('does not apply the header timeout to a body that arrives slowly after the headers', async () => {
    handler = (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'image/png' });
      response.write(PNG.subarray(0, 10));
      setTimeout(() => {
        response.end(PNG.subarray(10));
      }, 300);
    };
    const { fetcher } = setup(
      { 'img.example.test': [PUBLIC] },
      { timeoutMs: 5_000, headerTimeoutMs: 150 },
    );
    expect((await fetcher.fetchImage('http://img.example.test/a.png')).bytes.equals(PNG)).toBe(
      true,
    );
  });

  it('defaults to 3 seconds for the headers', () => {
    const fetcher = new SafeImageFetcher({ allowHttp: false });
    expect(
      (fetcher as unknown as { options: { headerTimeoutMs: number } }).options.headerTimeoutMs,
    ).toBe(3000);
  });

  it('ignores proxy settings in the environment: the connection still goes to the checked address', async () => {
    const saved = { ...process.env };
    // A proxy that nobody listens on: if it were used the fetch would fail.
    for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY']) {
      process.env[name] = 'http://127.0.0.1:9';
    }
    process.env.NODE_USE_ENV_PROXY = '1';
    delete process.env.NO_PROXY;
    delete process.env.no_proxy;
    try {
      const { fetcher, dialed } = setup({ 'img.example.test': [PUBLIC] });
      const image = await fetcher.fetchImage('http://img.example.test/a.png');
      expect(image.bytes.equals(PNG)).toBe(true);
      expect(dialed).toEqual([PUBLIC]);
      expect(hits).toHaveLength(1);
    } finally {
      for (const name of Object.keys(process.env)) {
        if (!(name in saved)) Reflect.deleteProperty(process.env, name);
      }
      Object.assign(process.env, saved);
    }
  });
});

describe('sniffImage', () => {
  it('knows PNG, JPEG, GIF and WebP and nothing else', () => {
    expect(sniffImage(PNG)).toBe('image/png');
    expect(sniffImage(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImage(Buffer.from('GIF89a....'))).toBe('image/gif');
    expect(sniffImage(Buffer.from('RIFF\u0001\u0000\u0000\u0000WEBPVP8 '))).toBe('image/webp');
    expect(sniffImage(Buffer.from('RIFF\u0001\u0000\u0000\u0000WAVEfmt '))).toBeNull();
    expect(sniffImage(Buffer.from('<svg/>'))).toBeNull();
    expect(sniffImage(Buffer.alloc(0))).toBeNull();
  });
});
