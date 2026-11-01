import { describe, expect, it } from 'vitest';

import { makeIntegration } from '@/test/integrations-fixtures';

import {
  cardState,
  groupFields,
  isGrantField,
  isSafeRedirect,
  parseGmailOauthResult,
  typedFields,
} from './integrations';

describe('integrations helpers', () => {
  it('splits Gmail into the two ways to connect and leaves out the grant fields', () => {
    const groups = groupFields('gmail', makeIntegration('gmail').fields);
    expect(groups.map((group) => group.id)).toEqual(['oauth', 'service_account']);
    const names = groups.flatMap((group) => group.fields.map((entry) => entry.field));
    expect(names).toEqual([
      'oauthClientId',
      'oauthClientSecret',
      'serviceAccountJson',
      'impersonateUser',
    ]);
    expect(isGrantField('gmail', 'oauthRefreshToken')).toBe(true);
    expect(isGrantField('line', 'oauthRefreshToken')).toBe(false);
  });

  it('keeps an integration without alternatives in one group', () => {
    const groups = groupFields('line', makeIntegration('line').fields);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.id).toBeNull();
    expect(groups[0]?.fields).toHaveLength(3);
  });

  it('calls a card "env" only when everything in effect comes from the environment', () => {
    expect(cardState(makeIntegration('ai', { anthropicApiKey: 'env' }))).toBe('env');
    expect(cardState(makeIntegration('ai', { anthropicApiKey: 'db' }))).toBe('configured');
    expect(cardState(makeIntegration('ai'))).toBe('not_configured');
    expect(cardState(makeIntegration('line', { channelId: 'db' }))).toBe('partial');
    expect(
      cardState(
        makeIntegration('line', {
          channelId: 'env',
          channelSecret: 'env',
          channelAccessToken: 'db',
        }),
      ),
    ).toBe('configured');
  });

  it('sends only typed values, trimmed', () => {
    expect(typedFields({ a: '  x ', b: '   ', c: '' })).toEqual({ a: 'x' });
  });

  it('accepts only the result codes the api redirects with', () => {
    expect(parseGmailOauthResult('connected')).toBe('connected');
    expect(parseGmailOauthResult('scope_mismatch')).toBe('scope_mismatch');
    expect(parseGmailOauthResult('<script>')).toBeNull();
    expect(parseGmailOauthResult(null)).toBeNull();
  });

  it('opens only https addresses from the api', () => {
    expect(isSafeRedirect('https://accounts.google.com/o/oauth2/v2/auth?x=1')).toBe(true);
    expect(isSafeRedirect('http://accounts.google.com/')).toBe(false);
    expect(isSafeRedirect('javascript:alert(1)')).toBe(false);
    expect(isSafeRedirect('not a url')).toBe(false);
  });
});
