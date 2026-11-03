import type { Message } from '@watchtower/shared';
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const downloadAttachment = vi.fn(() => Promise.resolve(new Uint8Array([0xff, 0xd8, 0xff]).buffer));
// One client for the whole test, like the app's ApiProvider (a new object per render would re-run the effect).
const api = { downloadAttachment };
vi.mock('@/lib/api/api-context', () => ({ useApi: () => api }));

import { useCidImages } from './email-body';

function mail(id: string): Message {
  return {
    id,
    ticketKey: 'OPS-4883',
    attachments: [
      {
        filename: 'screen.jpeg',
        contentType: 'image/jpeg',
        size: 3,
        objectKey: 'k',
        contentId: '<ii_abc>',
        disposition: 'inline',
      },
    ],
  } as unknown as Message;
}

afterEach(() => {
  vi.restoreAllMocks();
  downloadAttachment.mockClear();
});

describe('useCidImages', () => {
  it('keeps an object URL alive across re-renders and revokes it only on unmount', async () => {
    let counter = 0;
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:test/${String(++counter)}`);
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);

    const first = mail('m1');
    const { result, rerender, unmount } = renderHook(
      ({ message, wanted }: { message: Message; wanted: string[] }) =>
        useCidImages(message, wanted),
      { initialProps: { message: first, wanted: ['ii_abc'] } },
    );
    await waitFor(() => {
      expect(result.current.get('ii_abc')).toBe('blob:test/1');
    });

    // A refetched timeline hands over a new object for the same mail, and the wanted list is rebuilt.
    rerender({ message: { ...first }, wanted: ['ii_abc'] });
    rerender({ message: { ...first }, wanted: [] });
    rerender({ message: { ...first }, wanted: ['ii_abc'] });
    await waitFor(() => {
      expect(result.current.get('ii_abc')).toBe('blob:test/1');
    });
    expect(revoke).not.toHaveBeenCalled();
    expect(downloadAttachment).toHaveBeenCalledTimes(1);

    unmount();
    expect(revoke).toHaveBeenCalledWith('blob:test/1');
  });
});
