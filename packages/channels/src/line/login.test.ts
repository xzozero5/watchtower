import { disableNetConnect } from '@watchtower/shared/testing';
import { afterAll, describe, expect, it } from 'vitest';

import { FakeLineLoginProvider, LineLoginError } from './login.js';

const net = disableNetConnect();
afterAll(() => {
  expect(net.blocked()).toEqual([]);
  net.restore();
});

const REDIRECT = 'https://desk.example.test/v1/line/login/callback';
const person = { userId: 'Ufake0000000000000000000000000001', displayName: 'Somchai' };

describe('FakeLineLoginProvider', () => {
  it('trades a consented code for the identity, once', async () => {
    const idp = new FakeLineLoginProvider();
    const url = new URL(idp.authorizeUrl({ state: 's1', nonce: 'n1', redirectUri: REDIRECT }));
    expect(url.hostname).toBe('login.line.fake.example.test');
    expect(url.searchParams.get('state')).toBe('s1');
    const code = idp.consent('s1', person);
    await expect(idp.exchange({ code, nonce: 'n1', redirectUri: REDIRECT })).resolves.toEqual(
      person,
    );
    await expect(idp.exchange({ code, nonce: 'n1', redirectUri: REDIRECT })).rejects.toMatchObject({
      failure: 'invalid_code',
    });
  });

  it('refuses a code for another nonce or another redirect uri, and burns it', async () => {
    const idp = new FakeLineLoginProvider();
    idp.authorizeUrl({ state: 's2', nonce: 'n2', redirectUri: REDIRECT });
    const wrongNonce = idp.consent('s2', person);
    await expect(
      idp.exchange({ code: wrongNonce, nonce: 'other', redirectUri: REDIRECT }),
    ).rejects.toBeInstanceOf(LineLoginError);
    const wrongRedirect = idp.consent('s2', person);
    await expect(
      idp.exchange({
        code: wrongRedirect,
        nonce: 'n2',
        redirectUri: 'https://evil.example.test/cb',
      }),
    ).rejects.toMatchObject({ failure: 'redirect_uri_mismatch' });
    await expect(
      idp.exchange({ code: 'never-issued', nonce: 'n2', redirectUri: REDIRECT }),
    ).rejects.toMatchObject({ failure: 'invalid_code' });
  });

  it('can consent for the person at once in mock mode', async () => {
    const idp = new FakeLineLoginProvider({ autoConsent: person });
    const back = new URL(idp.authorizeUrl({ state: 's3', nonce: 'n3', redirectUri: REDIRECT }));
    expect(`${back.origin}${back.pathname}`).toBe(REDIRECT);
    expect(back.searchParams.get('state')).toBe('s3');
    const code = back.searchParams.get('code') ?? '';
    await expect(idp.exchange({ code, nonce: 'n3', redirectUri: REDIRECT })).resolves.toEqual(
      person,
    );
  });
});
