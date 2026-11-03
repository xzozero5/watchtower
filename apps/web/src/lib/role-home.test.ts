import { ROLES } from '@watchtower/shared';
import { describe, expect, it } from 'vitest';

import { landingPath, ROLE_HOME, roleHomePath, safeNextPath, startUrl } from './role-home';

describe('roleHomePath', () => {
  it.each([
    ['agent', '/'],
    ['lead', '/home'],
    ['head', '/home'],
    ['dev', '/'],
    ['client', '/'],
  ] as const)('%s starts at %s', (role, path) => {
    expect(roleHomePath(role)).toBe(path);
  });

  it('has an entry for every role and falls back to the root without one', () => {
    for (const role of ROLES) expect(ROLE_HOME[role]).toMatch(/^\//);
    expect(roleHomePath(null)).toBe('/');
    expect(roleHomePath(undefined)).toBe('/');
  });
});

describe('safeNextPath', () => {
  it('accepts a path inside the app, with query and hash', () => {
    expect(safeNextPath('/?ticket=OPS-12')).toBe('/?ticket=OPS-12');
    expect(safeNextPath('/admin/users#top')).toBe('/admin/users#top');
  });

  it.each([
    'https://evil.example/x',
    '//evil.example/x',
    '/\\evil.example',
    'javascript:alert(1)',
    'home',
    '/a\nb',
    '/login',
    '/login?next=/x',
    '/start',
    '',
    `/${'a'.repeat(200)}`,
  ])('refuses %j', (raw) => {
    expect(safeNextPath(raw)).toBeNull();
  });

  it('refuses null and undefined', () => {
    expect(safeNextPath(null)).toBeNull();
    expect(safeNextPath(undefined)).toBeNull();
  });
});

describe('landingPath and startUrl', () => {
  it('lets a valid next win over the role home', () => {
    expect(landingPath('head', '/?ticket=OPS-3')).toBe('/?ticket=OPS-3');
  });

  it('uses the role home with no next or an unsafe one', () => {
    expect(landingPath('lead')).toBe('/home');
    expect(landingPath('agent', 'https://evil.example')).toBe('/');
    expect(landingPath('client', '//evil.example')).toBe('/');
  });

  it('builds /start with an encoded destination only when it is safe', () => {
    expect(startUrl()).toBe('/start');
    expect(startUrl('https://evil.example')).toBe('/start');
    expect(startUrl('/?ticket=OPS-3')).toBe('/start?next=%2F%3Fticket%3DOPS-3');
  });
});
