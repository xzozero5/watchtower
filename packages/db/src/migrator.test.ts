import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadMigrations, MigrationError } from './migrator.js';

describe('shipped migrations', () => {
  it('are reversible: every up file has a down file', async () => {
    const migrations = await loadMigrations();
    expect(migrations.length).toBeGreaterThan(0);
    for (const migration of migrations) {
      expect(migration.up.trim(), migration.id).not.toBe('');
      expect(migration.down.trim(), migration.id).not.toBe('');
    }
  });

  it('start with the vector and pg_trgm extensions', async () => {
    const [first] = await loadMigrations();
    expect(first?.id).toBe('0000_extensions');
    expect(first?.up).toMatch(/CREATE EXTENSION IF NOT EXISTS vector/);
    expect(first?.up).toMatch(/CREATE EXTENSION IF NOT EXISTS pg_trgm/);
  });
});

describe('loadMigrations', () => {
  let dir = '';

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'wt-migrations-'));
    await mkdir(join(dir, 'meta'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const write = (name: string, sql = 'SELECT 1;') => writeFile(join(dir, name), sql);

  it('orders by number and ignores drizzle-kit metadata', async () => {
    await write('0002_b.sql');
    await write('0002_b.down.sql');
    await write('0001_a.sql');
    await write('0001_a.down.sql');
    await write('meta/_journal.json', '{}');
    expect((await loadMigrations(dir)).map((migration) => migration.id)).toEqual([
      '0001_a',
      '0002_b',
    ]);
  });

  it('rejects an up migration without a down migration', async () => {
    await write('0001_a.sql');
    await expect(loadMigrations(dir)).rejects.toThrow(MigrationError);
    await expect(loadMigrations(dir)).rejects.toThrow(/reversible/);
  });

  it('rejects a down migration without an up migration', async () => {
    await write('0001_a.down.sql');
    await expect(loadMigrations(dir)).rejects.toThrow(/no matching/);
  });

  it('rejects two migrations with the same number', async () => {
    await write('0001_a.sql');
    await write('0001_a.down.sql');
    await write('0001_b.sql');
    await write('0001_b.down.sql');
    await expect(loadMigrations(dir)).rejects.toThrow(/same number/);
  });

  it('changes the checksum when the up file changes', async () => {
    await write('0001_a.sql', 'SELECT 1;');
    await write('0001_a.down.sql');
    const [before] = await loadMigrations(dir);
    await write('0001_a.sql', 'SELECT 2;');
    const [after] = await loadMigrations(dir);
    expect(before?.checksum).not.toBe(after?.checksum);
  });
});
