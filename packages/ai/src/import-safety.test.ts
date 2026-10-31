import dns from 'node:dns';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

describe('importing the package', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('opens no connection, resolves no host and makes no request', async () => {
    const seen: string[] = [];
    const trap = (name: string) => () => {
      seen.push(name);
      throw new Error(`${name} called while importing @watchtower/ai`);
    };
    vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(trap('net.Socket.connect'));
    vi.spyOn(net, 'connect').mockImplementation(trap('net.connect'));
    vi.spyOn(tls, 'connect').mockImplementation(trap('tls.connect'));
    vi.spyOn(dns, 'lookup').mockImplementation(trap('dns.lookup'));
    vi.stubGlobal('fetch', trap('fetch'));
    vi.stubGlobal('XMLHttpRequest', trap('XMLHttpRequest'));

    vi.resetModules();
    const ai = await import('./index.js');
    // The entries that carry the SDK and the Google libraries.
    await import('ai');
    await import('@ai-sdk/anthropic');
    await import('@ai-sdk/google-vertex/edge');
    await import('@ai-sdk/google-vertex/anthropic/edge');

    expect(ai.packageName).toBe('@watchtower/ai');
    expect(seen).toEqual([]);
  });

  it('imports only the Vertex entries that cannot probe for credentials', () => {
    // The default entry of @ai-sdk/google-vertex loads google-auth-library, which finds credentials
    // by probing (environment, well-known file, GCE metadata server). Only /edge entries are used.
    const root = fileURLToPath(new URL('.', import.meta.url));
    const sources = [
      'providers/vertex.ts',
      'providers/sdk.ts',
      'providers/anthropic.ts',
      'index.ts',
    ];
    for (const file of sources) {
      const text = readFileSync(join(root, file), 'utf8');
      expect(text, file).not.toMatch(
        /from\s+['"][^'"]*(?:google-auth-library|gcp-metadata|gaxios)/,
      );
      expect(text, file).not.toMatch(/['"]@ai-sdk\/google-vertex['"]/);
      expect(text, file).not.toMatch(/['"]@ai-sdk\/google-vertex\/anthropic['"]/);
      expect(text, file).not.toMatch(/['"]@ai-sdk\/google-vertex\/(?:maas|xai)/);
    }
    expect(readFileSync(join(root, 'providers/vertex.ts'), 'utf8')).toMatch(
      /from '@ai-sdk\/google-vertex\/edge'/,
    );
  });

  it('registers no global telemetry integration', async () => {
    const holder = globalThis as { AI_SDK_TELEMETRY_INTEGRATIONS?: unknown };
    delete holder.AI_SDK_TELEMETRY_INTEGRATIONS;
    vi.resetModules();
    await import('./index.js');
    expect(holder.AI_SDK_TELEMETRY_INTEGRATIONS).toBeUndefined();
  });
});
