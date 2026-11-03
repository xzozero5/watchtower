import { createMemoryObjectStore } from '@watchtower/channels';
import { describe, expect, it, vi } from 'vitest';

import { emailRecipientsOf, loadMailAttachments } from './dispatcher.js';

const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

describe('emailRecipientsOf', () => {
  it('reads the composer recipients and drops junk', () => {
    const out = emailRecipientsOf({
      to: [{ address: 'a@example.org', name: 'A' }, { address: 'nope' }, 7],
      cc: [{ address: 'c@example.org' }],
      bcc: 'x',
      subject: ' Re: Hi ',
    });
    expect(out.to).toEqual([{ address: 'a@example.org', name: 'A' }]);
    expect(out.cc).toEqual([{ address: 'c@example.org', name: null }]);
    expect(out.bcc).toEqual([]);
    expect(out.subject).toBe(' Re: Hi ');
  });

  it('falls back to defaults for a message without a header block', () => {
    expect(emailRecipientsOf(null)).toEqual({ to: [], cc: [], bcc: [], subject: null });
  });
});

describe('loadMailAttachments', () => {
  it('loads files, marks cid images inline and skips what is missing', async () => {
    const store = createMemoryObjectStore();
    await store.put('k/logo', Uint8Array.from([1, 2]), 'image/png');
    const files = await loadMailAttachments(
      store,
      [
        {
          objectKey: 'k/logo',
          filename: 'logo.png',
          contentType: 'image/png',
          contentId: '<l@wt>',
          disposition: 'inline',
        },
        { objectKey: 'k/gone', filename: 'gone.txt', contentType: 'text/plain' },
      ],
      logger,
    );
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ filename: 'logo.png', contentId: 'l@wt', inline: true });
  });

  it('sends no files without an object store', async () => {
    expect(
      await loadMailAttachments(undefined, [{ objectKey: 'k', filename: 'a' }], logger),
    ).toEqual([]);
  });
});
