import { schema, type Database } from '@watchtower/db';
import { eq } from 'drizzle-orm';

/**
 * Where a stored file stands with the malware scan, for code that is about to pass it on (ADR-022).
 * Anything that is not a recorded `clean` or `infected` is `pending`, including a file with no row and
 * one whose scan ended in `error`: fail closed.
 */
export async function readScanVerdict(
  database: Pick<Database, 'db'>,
  objectKey: string,
): Promise<'clean' | 'pending' | 'infected'> {
  const [row] = await database.db
    .select({ status: schema.objectScan.scanStatus })
    .from(schema.objectScan)
    .where(eq(schema.objectScan.objectKey, objectKey))
    .limit(1);
  if (row?.status === 'clean') return 'clean';
  if (row?.status === 'infected') return 'infected';
  return 'pending';
}
