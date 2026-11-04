import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { Role } from '@watchtower/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderApp } from '@/test-utils';
import { useSession } from '@/lib/auth/session';
import { makeMessage, makeSession, makeTicket } from '@/test/fixtures';
import { mockApi } from '@/test/mock-api';

import { MessageAttachments } from './message-attachments';

const ticket = makeTicket(1);
const message = makeMessage(1, ticket, {
  attachments: [
    {
      filename: 'trace.log',
      size: 2048,
      objectKey: 'private/object-key',
      url: 'https://untrusted.example/file',
    },
  ],
});
const path = `/v1/tickets/OPS-1/messages/${message.id}/attachments/0`;
let createObjectURL: ReturnType<typeof vi.fn<(blob: Blob | MediaSource) => string>>;
let revokeObjectURL: ReturnType<typeof vi.fn<(url: string) => void>>;
let clicked: { href: string; download: string }[];

beforeEach(() => {
  createObjectURL = vi.fn<(blob: Blob | MediaSource) => string>(
    () => 'blob:http://api.test/download',
  );
  revokeObjectURL = vi.fn<(url: string) => void>();
  const BaseURL = URL;
  vi.stubGlobal(
    'URL',
    class extends BaseURL {
      static override createObjectURL = createObjectURL;
      static override revokeObjectURL = revokeObjectURL;
    },
  );
  clicked = [];
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    clicked.push({ href: this.href, download: this.download });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function setup(handler: () => Promise<Response> | Response, role: Role = 'agent') {
  const mock = mockApi({ 'GET /v1/auth/session': { json: makeSession(role) } });
  const originalFetch = mock.fetchMock;
  const download = vi.fn(handler);
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) =>
    new URL(input instanceof Request ? input.url : input.toString()).pathname === path
      ? download()
      : originalFetch(input, init),
  );
  return download;
}

function SessionRole() {
  return <p>{useSession().session?.user.role}</p>;
}

describe('staff message attachments', () => {
  it('shows name and size and downloads only through the authorized API, releasing the blob on unmount', async () => {
    const download = setup(
      () => new Response('trace', { headers: { 'content-type': 'text/plain' } }),
    );
    const { container, unmount } = renderApp(<MessageAttachments message={message} />);
    const button = await screen.findByRole('button', { name: 'Download trace.log' });
    expect(screen.getByText('2.0 KB')).toBeVisible();
    expect(container.innerHTML).not.toMatch(/private\/object-key|untrusted\.example/);
    fireEvent.click(button);
    await waitFor(() => {
      expect(clicked).toEqual([{ href: 'blob:http://api.test/download', download: 'trace.log' }]);
    });
    expect(download).toHaveBeenCalledTimes(1);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(container.querySelector('a')).toBeNull();
    unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:http://api.test/download');
  });

  it('disables repeated downloads while waiting and supports retry after a network failure', async () => {
    let rejectDownload: (error: Error) => void = () => undefined;
    const download = setup(
      () =>
        new Promise<Response>((_resolve, reject) => {
          rejectDownload = reject;
        }),
    );
    renderApp(<MessageAttachments message={message} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Download trace.log' }));
    const busy = screen.getByRole('button', { name: 'Downloading trace.log' });
    expect(busy).toBeDisabled();
    fireEvent.click(busy);
    expect(download).toHaveBeenCalledTimes(1);
    rejectDownload(new Error('offline'));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not download this file. Try again.',
    );
    download.mockImplementation(() => new Response('ok'));
    fireEvent.click(screen.getByRole('button', { name: 'Download trace.log' }));
    await waitFor(() => {
      expect(clicked).toHaveLength(1);
    });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(download).toHaveBeenCalledTimes(2);
  });

  it.each([
    [403, 'You no longer have access to this file.'],
    [404, 'This file is no longer available.'],
  ] as const)('explains a %s without opening an error as a file', async (status, text) => {
    setup(() => new Response(null, { status }));
    renderApp(<MessageAttachments message={message} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Download trace.log' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(text);
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it.each([
    [409, 'scan_pending', 'This file is still being checked for malware. Try again in a moment.'],
    [410, 'file_infected', 'This file was blocked and removed because it contained malware.'],
  ] as const)('explains a %s %s answer in words', async (status, code, text) => {
    setup(
      () =>
        new Response(JSON.stringify({ statusCode: status, error: 'Error', code, message: code }), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
    );
    renderApp(<MessageAttachments message={message} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Download trace.log' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(text);
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it.each([
    ['pending', 'Checking file'],
    ['infected', 'File blocked (malware)'],
    ['error', 'Check failed, the system will retry'],
  ] as const)('shows scan state %s and offers no download', async (scanState, text) => {
    const download = setup(() => new Response('unexpected'));
    renderApp(
      <MessageAttachments
        message={{
          ...message,
          attachments: [{ ...message.attachments[0], scanState }],
        }}
      />,
    );
    expect(await screen.findByTestId('attachment-scan-state')).toHaveTextContent(text);
    expect(screen.queryByRole('button')).toBeNull();
    expect(download).not.toHaveBeenCalled();
  });

  it('keeps the download for a clean file and shows the Thai wording for pending', async () => {
    setup(() => new Response('ok'));
    const { unmount } = renderApp(
      <MessageAttachments
        message={{ ...message, attachments: [{ ...message.attachments[0], scanState: 'clean' }] }}
      />,
    );
    expect(await screen.findByRole('button', { name: 'Download trace.log' })).toBeVisible();
    unmount();
    renderApp(
      <MessageAttachments
        message={{ ...message, attachments: [{ ...message.attachments[0], scanState: 'pending' }] }}
      />,
      { locale: 'th' },
    );
    expect(await screen.findByText('กำลังตรวจไฟล์')).toBeVisible();
  });

  it('does not offer unmasked filenames or downloads to a developer', async () => {
    const download = setup(() => new Response('secret'), 'dev');
    renderApp(
      <>
        <SessionRole />
        <MessageAttachments message={message} />
      </>,
    );
    await screen.findByText('dev');
    expect(screen.queryByText('trace.log')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    expect(download).not.toHaveBeenCalled();
  });

  it('marks missing stored objects unavailable instead of trusting an external URL', async () => {
    const download = setup(() => new Response('unexpected'));
    renderApp(
      <MessageAttachments
        message={{
          ...message,
          attachments: [{ filename: 'old.png', url: 'https://untrusted.example/file' }],
        }}
      />,
    );
    expect(await screen.findByText('File unavailable')).toBeVisible();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
    expect(download).not.toHaveBeenCalled();
  });

  it('shows a blocked label and no download for an archive the worker refused (T-182)', async () => {
    const download = setup(() => new Response('unexpected'));
    const blocked = {
      ...message,
      attachments: [
        { filename: 'bomb.zip', size: 4096, objectKey: null, blocked: 'archive_member_too_large' },
        { filename: 'odd.zip', size: 10, objectKey: null, blocked: 'something_new' },
      ],
    };
    renderApp(<MessageAttachments message={blocked} />);
    expect(
      await screen.findByText('File blocked: a file inside is too large to be scanned'),
    ).toBeVisible();
    expect(screen.getByText('File blocked')).toBeVisible();
    expect(screen.queryByRole('button')).toBeNull();
    expect(download).not.toHaveBeenCalled();
  });

  it('shows the blocked label in Thai', async () => {
    setup(() => new Response('unexpected'));
    renderApp(
      <MessageAttachments
        message={{
          ...message,
          attachments: [{ filename: 'a.zip', objectKey: null, blocked: 'archive_nested' }],
        }}
      />,
      { locale: 'th' },
    );
    expect(await screen.findByText('ไฟล์ถูกบล็อก: มีไฟล์บีบอัดซ้อนอยู่ข้างใน')).toBeVisible();
  });

  it('offers a localized download control in Thai', async () => {
    setup(() => new Response('trace'));
    renderApp(<MessageAttachments message={message} />, { locale: 'th' });
    expect(await screen.findByRole('button', { name: 'ดาวน์โหลด trace.log' })).toBeVisible();
  });
});
