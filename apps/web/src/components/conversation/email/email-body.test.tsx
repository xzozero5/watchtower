import type { Message } from '@watchtower/shared';
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const downloadAttachment = vi.fn(() => Promise.resolve(new Uint8Array([0xff, 0xd8, 0xff]).buffer));
// One client for the whole test, like the app's ApiProvider (a new object per render would re-run the effect).
const downloadRemoteImage = vi.fn(() =>
  Promise.resolve(new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2])])),
);
const api = { downloadAttachment, downloadRemoteImage };
vi.mock('@/lib/api/api-context', () => ({ useApi: () => api }));

import { useCidImages, useRemoteImages } from './email-body';

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
  downloadRemoteImage.mockClear();
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

describe('useRemoteImages (T-175)', () => {
  it('asks the api for no picture until the reader allows images, then once per picture', async () => {
    let counter = 0;
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:test/${String(++counter)}`);
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const message = mail('m9');
    const { result, rerender, unmount } = renderHook(
      ({ enabled }: { enabled: boolean }) => useRemoteImages(message, 2, enabled),
      { initialProps: { enabled: false } },
    );
    expect(downloadRemoteImage).not.toHaveBeenCalled();
    rerender({ enabled: true });
    await waitFor(() => {
      expect(result.current.size).toBe(2);
    });
    expect(downloadRemoteImage).toHaveBeenCalledWith('OPS-4883', 'm9', 0, expect.anything());
    expect(downloadRemoteImage).toHaveBeenCalledWith('OPS-4883', 'm9', 1, expect.anything());
    rerender({ enabled: false });
    rerender({ enabled: true });
    expect(downloadRemoteImage).toHaveBeenCalledTimes(2);
    expect(revoke).not.toHaveBeenCalled();
    unmount();
    expect(revoke).toHaveBeenCalledTimes(2);
  });

  it('leaves a picture the api refused as a placeholder and does not show bytes that are not an image', async () => {
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:test/ok');
    downloadRemoteImage
      .mockImplementationOnce(() => Promise.reject(new Error('502')))
      .mockImplementationOnce(() =>
        Promise.resolve(new Blob([new TextEncoder().encode('<html>')])),
      );
    const { result } = renderHook(() => useRemoteImages(mail('m10'), 3, true));
    await waitFor(() => {
      expect(downloadRemoteImage).toHaveBeenCalledTimes(3);
    });
    await waitFor(() => {
      expect(result.current.size).toBe(1);
    });
    expect(result.current.has(2)).toBe(true);
  });
});
