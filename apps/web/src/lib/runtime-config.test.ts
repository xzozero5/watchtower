import { describe, expect, it } from 'vitest';

import { DEFAULT_API_URL, readRuntimeConfig } from './runtime-config';

describe('readRuntimeConfig', () => {
  it('reads API_URL from the environment it is given', () => {
    expect(readRuntimeConfig({ API_URL: 'https://api.example.test' })).toEqual({
      apiUrl: 'https://api.example.test',
    });
  });

  it('reads the environment at call time, so one build serves any deployment', () => {
    expect(readRuntimeConfig({ API_URL: 'http://api-a.example.test' }).apiUrl).toBe(
      'http://api-a.example.test',
    );
    expect(readRuntimeConfig({ API_URL: 'http://api-b.example.test' }).apiUrl).toBe(
      'http://api-b.example.test',
    );
  });

  it('removes trailing slashes so callers can append a path', () => {
    expect(readRuntimeConfig({ API_URL: 'http://api.example.test:4000///' }).apiUrl).toBe(
      'http://api.example.test:4000',
    );
  });

  it('falls back to the local default when API_URL is missing or blank', () => {
    expect(readRuntimeConfig({}).apiUrl).toBe(DEFAULT_API_URL);
    expect(readRuntimeConfig({ API_URL: '   ' }).apiUrl).toBe(DEFAULT_API_URL);
  });

  it('fails loudly on a value that is not an http(s) URL', () => {
    expect(() => readRuntimeConfig({ API_URL: 'not a url' })).toThrow(/API_URL/);
    expect(() => readRuntimeConfig({ API_URL: 'javascript:alert(1)' })).toThrow(/http/);
    expect(() => readRuntimeConfig({ API_URL: 'ftp://files.example.test' })).toThrow(/http/);
  });

  it('does not put the value in the error message', () => {
    expect(() => readRuntimeConfig({ API_URL: 'ftp://user:pw@files.example.test' })).toThrow(
      /^(?!.*user:pw)/,
    );
  });
});
