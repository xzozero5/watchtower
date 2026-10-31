import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { SignJWT, exportJWK, generateKeyPair, type JWK, type CryptoKey } from 'jose';

/**
 * A minimal OpenID Connect provider on 127.0.0.1 for testing the real `openid-client` flow
 * without Google: discovery document, JWKS, and a token endpoint that enforces PKCE (S256), the
 * client secret, the redirect URI and one-time codes, and signs RS256 ID tokens.
 */

export interface IdentityClaims {
  readonly sub: string;
  readonly email: string;
  readonly email_verified?: boolean | undefined;
  readonly hd?: string | undefined;
  readonly name?: string | undefined;
}

export interface TokenFaults {
  /** Sign the ID token with a key that is not in the JWKS. */
  readonly wrongKey?: boolean;
  /** Put another audience in the ID token. */
  readonly audience?: string;
  /** Put another nonce in the ID token. */
  readonly nonce?: string;
  /** Issue an already expired ID token. */
  readonly expired?: boolean;
}

interface PendingCode {
  readonly claims: IdentityClaims;
  readonly nonce: string;
  readonly challenge: string;
  readonly redirectUri: string;
  readonly faults: TokenFaults;
  used: boolean;
}

export interface AuthorizeRequest {
  readonly redirectUri: string;
  readonly state: string;
  readonly nonce: string;
  readonly challenge: string;
  readonly challengeMethod: string;
  readonly scope: string;
  readonly clientId: string;
  readonly hd: string | null;
  readonly params: URLSearchParams;
}

export interface FakeIdp {
  readonly issuer: URL;
  readonly clientId: string;
  readonly clientSecret: string;
  /** Token requests that passed PKCE verification. */
  readonly pkceVerified: () => number;
  /** Reads what a browser would send to the authorization endpoint (the Location of /start). */
  parseAuthorize(location: string): AuthorizeRequest;
  /** The user signs in at the provider: returns the code the provider would redirect back with. */
  approve(request: AuthorizeRequest, claims: IdentityClaims, faults?: TokenFaults): string;
  stop(): Promise<void>;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    request.on('error', reject);
  });
}

const s256 = (verifier: string): string =>
  createHash('sha256').update(verifier).digest('base64url');

export async function startFakeIdp(): Promise<FakeIdp> {
  const clientId = 'test-client-id';
  const clientSecret = 'test-client-secret-value';
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const other = await generateKeyPair('RS256');
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: 'fake-1', alg: 'RS256', use: 'sig' };
  const codes = new Map<string, PendingCode>();
  let verified = 0;
  let issuer = new URL('http://127.0.0.1');

  const sign = (
    key: CryptoKey,
    kid: string,
    claims: Record<string, unknown>,
    audience: string,
    expired: boolean,
  ) => {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid })
      .setIssuer(issuer.origin)
      .setAudience(audience)
      .setIssuedAt(expired ? now - 7200 : now)
      .setExpirationTime(expired ? now - 3600 : now + 300)
      .sign(key);
  };

  const server: Server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', issuer);
      const json = (status: number, body: unknown) => {
        response.writeHead(status, {
          'content-type': 'application/json',
          'cache-control': 'no-store',
        });
        response.end(JSON.stringify(body));
      };

      if (request.method === 'GET' && url.pathname === '/.well-known/openid-configuration') {
        json(200, {
          issuer: issuer.origin,
          authorization_endpoint: `${issuer.origin}/authorize`,
          token_endpoint: `${issuer.origin}/token`,
          jwks_uri: `${issuer.origin}/jwks`,
          response_types_supported: ['code'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
          token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
          code_challenge_methods_supported: ['S256'],
          scopes_supported: ['openid', 'email', 'profile'],
        });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/jwks') {
        json(200, { keys: [jwk] });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/token') {
        const form = new URLSearchParams(await readBody(request));
        const basic = /^Basic (.+)$/.exec(request.headers.authorization ?? '')?.[1];
        const [basicId, basicSecret] = basic
          ? Buffer.from(basic, 'base64').toString().split(':')
          : [];
        const presentedId = form.get('client_id') ?? basicId;
        const presentedSecret = form.get('client_secret') ?? basicSecret;
        const pending = codes.get(form.get('code') ?? '');
        if (presentedId !== clientId || presentedSecret !== clientSecret) {
          json(401, { error: 'invalid_client' });
          return;
        }
        if (
          form.get('grant_type') !== 'authorization_code' ||
          !pending ||
          pending.used ||
          form.get('redirect_uri') !== pending.redirectUri ||
          s256(form.get('code_verifier') ?? '') !== pending.challenge
        ) {
          // One code, one use: a replay or a wrong PKCE verifier is invalid_grant.
          if (pending) pending.used = true;
          json(400, { error: 'invalid_grant' });
          return;
        }
        pending.used = true;
        verified += 1;
        const { faults, claims } = pending;
        const idToken = await sign(
          faults.wrongKey ? other.privateKey : privateKey,
          'fake-1',
          { ...claims, nonce: faults.nonce ?? pending.nonce },
          faults.audience ?? clientId,
          faults.expired === true,
        );
        json(200, {
          access_token: randomBytes(16).toString('hex'),
          token_type: 'Bearer',
          expires_in: 300,
          id_token: idToken,
        });
        return;
      }
      json(404, { error: 'not_found' });
    })().catch(() => {
      response.writeHead(500).end();
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  issuer = new URL(`http://127.0.0.1:${String((server.address() as AddressInfo).port)}`);

  return {
    issuer,
    clientId,
    clientSecret,
    pkceVerified: () => verified,
    parseAuthorize(location) {
      const url = new URL(location);
      expectOrigin(url, issuer);
      const get = (name: string) => url.searchParams.get(name) ?? '';
      return {
        redirectUri: get('redirect_uri'),
        state: get('state'),
        nonce: get('nonce'),
        challenge: get('code_challenge'),
        challengeMethod: get('code_challenge_method'),
        scope: get('scope'),
        clientId: get('client_id'),
        hd: url.searchParams.get('hd'),
        params: url.searchParams,
      };
    },
    approve(request, claims, faults = {}) {
      const code = randomBytes(16).toString('hex');
      codes.set(code, {
        claims,
        nonce: request.nonce,
        challenge: request.challenge,
        redirectUri: request.redirectUri,
        faults,
        used: false,
      });
      return code;
    },
    stop() {
      return new Promise((resolve) => {
        server.close(() => {
          resolve();
        });
        server.closeAllConnections();
      });
    },
  };
}

function expectOrigin(url: URL, issuer: URL): void {
  if (url.origin !== issuer.origin || url.pathname !== '/authorize') {
    throw new Error(
      `not an authorization request to the fake provider: ${url.origin}${url.pathname}`,
    );
  }
}
