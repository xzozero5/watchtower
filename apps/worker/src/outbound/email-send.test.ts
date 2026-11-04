import { createMemoryObjectStore } from '@watchtower/channels';
import { describe, expect, it, vi } from 'vitest';

import { AttachmentUnreadable, emailRecipientsOf, loadMailAttachments } from './dispatcher.js';

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
  it('loads files and marks cid images inline', async () => {
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
      ],
      logger,
    );
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ filename: 'logo.png', contentId: 'l@wt', inline: true });
  });

  it('refuses to send when a file is missing from the store (C-8: no mail without its files)', async () => {
    const store = createMemoryObjectStore();
    await store.put('k/ok', Uint8Array.from([1]), 'text/plain');
    await expect(
      loadMailAttachments(
        store,
        [
          { objectKey: 'k/ok', filename: 'ok.txt', contentType: 'text/plain' },
          { objectKey: 'k/gone', filename: 'gone.txt', contentType: 'text/plain' },
        ],
        logger,
      ),
    ).rejects.toMatchObject({
      name: 'AttachmentUnreadable',
      filename: 'gone.txt',
      transient: false,
    });
  });

  it('marks a store that fails to answer as transient, so the delivery is retried', async () => {
    const store = {
      ...createMemoryObjectStore(),
      get: () => Promise.reject(new Error('connection reset')),
    };
    await expect(
      loadMailAttachments(store, [{ objectKey: 'k', filename: 'a.txt' }], logger),
    ).rejects.toMatchObject({ name: 'AttachmentUnreadable', transient: true });
  });

  it('refuses when files are listed but no object store is configured, and has nothing to do without files', async () => {
    await expect(
      loadMailAttachments(undefined, [{ objectKey: 'k', filename: 'a' }], logger),
    ).rejects.toBeInstanceOf(AttachmentUnreadable);
    expect(await loadMailAttachments(undefined, [], logger)).toEqual([]);
    expect(await loadMailAttachments(undefined, undefined, logger)).toEqual([]);
  });
});
