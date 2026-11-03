import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { StaffAttachment } from '@watchtower/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mockApi } from '@/test/mock-api';
import { renderApp } from '@/test-utils';

import { AttachmentGallery, parseStaffAttachments } from './attachment-gallery';

const ID_A = '00000000-0000-4000-8000-00000000000a';
const ID_B = '00000000-0000-4000-8000-00000000000b';
const ID_C = '00000000-0000-4000-8000-00000000000c';

const files: StaffAttachment[] = [
  { id: ID_A, filename: 'first.png', contentType: 'image/png', size: 100 },
  { id: ID_B, filename: 'second.jpg', contentType: 'image/jpeg', size: 200 },
  { id: ID_C, filename: 'trace.log', contentType: 'text/plain', size: 2048 },
];

let requested: string[];
let created: Blob[];

beforeEach(() => {
  requested = [];
  created = [];
  mockApi({});
  const base = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.pathname.startsWith('/v1/uploads/')) {
      requested.push(url.pathname);
      return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } });
    }
    return base(input, init);
  });
  let n = 0;
  vi.stubGlobal(
    'URL',
    class extends URL {
      static override createObjectURL = (blob: Blob | MediaSource) => {
        created.push(blob as Blob);
        return `blob:image-${String(++n)}`;
      };
      static override revokeObjectURL = () => undefined;
    },
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AttachmentGallery', () => {
  it('shows images as thumbnails read through the api, never a storage address, and a file as a row', async () => {
    const { container } = renderApp(<AttachmentGallery attachments={files} />);
    const thumbs = await screen.findAllByRole('img');
    await waitFor(() => {
      expect(container.querySelectorAll('img')).toHaveLength(2);
    });
    expect(thumbs.length).toBeGreaterThan(0);
    expect(requested.sort()).toEqual([`/v1/uploads/${ID_A}`, `/v1/uploads/${ID_B}`]);
    expect(container.innerHTML).not.toMatch(/objectKey|attachments\/staff|https?:\/\/s3/);
    expect(screen.getByText('trace.log')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Download trace.log' })).toBeVisible();
  });

  it('opens a lightbox from the keyboard, moves with the arrows, closes with Escape and returns focus', async () => {
    renderApp(<AttachmentGallery attachments={files} />);
    const opener = await screen.findByRole('button', { name: 'Open first.png' });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAccessibleName('Image viewer: first.png');
    expect(screen.getByText('1 of 2')).toBeVisible();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
    });

    fireEvent.keyDown(dialog, { key: 'ArrowRight' });
    expect(dialog).toHaveAccessibleName('Image viewer: second.jpg');
    expect(screen.getByText('2 of 2')).toBeVisible();
    fireEvent.keyDown(dialog, { key: 'ArrowRight' });
    expect(dialog).toHaveAccessibleName('Image viewer: first.png');
    fireEvent.click(screen.getByRole('button', { name: 'Next image' }));
    expect(screen.getByText('2 of 2')).toBeVisible();

    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Open first.png' })).toHaveFocus();
    });
  });

  it('keeps Tab inside the lightbox', async () => {
    renderApp(<AttachmentGallery attachments={files} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open first.png' }));
    const dialog = screen.getByRole('dialog');
    const buttons = Array.from(dialog.querySelectorAll('button'));
    const last = buttons[buttons.length - 1];
    last?.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(buttons[0]).toHaveFocus();
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(last).toHaveFocus();
  });

  it('renders nothing for no files', () => {
    renderApp(<AttachmentGallery attachments={[]} />);
    expect(screen.queryByTestId('attachment-gallery')).toBeNull();
  });

  it('downloads a non-image file as an opaque blob', async () => {
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    renderApp(<AttachmentGallery attachments={[files[2] as StaffAttachment]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Download trace.log' }));
    await waitFor(() => {
      expect(click).toHaveBeenCalledTimes(1);
    });
    expect(created[0]?.type).toBe('application/octet-stream');
    click.mockRestore();
  });
});

describe('parseStaffAttachments', () => {
  it('keeps the valid entries of a jsonb payload and drops the rest', () => {
    expect(parseStaffAttachments([files[0], { id: 'x' }, 7])).toEqual([files[0]]);
    expect(parseStaffAttachments(undefined)).toEqual([]);
    expect(parseStaffAttachments('nope')).toEqual([]);
  });
});
