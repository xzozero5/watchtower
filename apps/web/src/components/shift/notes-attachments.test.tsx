import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderConsole } from '@/test/render-console';
import { shiftApi } from '@/test/shift-api';
import { shiftNote } from '@/test/shift-fixtures';

import { NotesPage } from './notes-page';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/shift/notes',
}));

const UPLOAD_ID = '00000000-0000-4000-8000-0000000000aa';
const attachment = { id: UPLOAD_ID, filename: 'chart.png', contentType: 'image/png', size: 3 };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('shift notes with images', () => {
  it('uploads a pasted screenshot and saves the note with its id', async () => {
    const user = userEvent.setup();
    const api = shiftApi({
      overrides: {
        'POST /v1/uploads': { status: 201, json: attachment },
        'POST /v1/shift-notes': { status: 201, json: shiftNote(2) },
      },
    });
    renderConsole(<NotesPage />);
    await screen.findByText('Note number 1');
    await user.type(screen.getByRole('textbox', { name: 'Note' }), 'Look at the chart');
    const shot = new File([new Uint8Array([1, 2, 3])], 'image.png', { type: 'image/png' });
    fireEvent.paste(screen.getByRole('textbox', { name: 'Note' }), {
      clipboardData: { files: [shot], types: ['Files'] },
    });
    await waitFor(() => {
      expect(screen.getByRole('img', { name: 'Attached' })).toBeVisible();
    });
    await user.click(screen.getByRole('button', { name: 'Send note' }));
    await waitFor(() => {
      expect(api.callsTo('/v1/shift-notes', 'POST')[0]?.body).toEqual({
        audience: 'next_shift',
        body: 'Look at the chart',
        attachmentIds: [UPLOAD_ID],
      });
    });
  });

  it('lists the files of a note it shows', async () => {
    shiftApi({
      overrides: {
        'GET /v1/shift-notes': {
          json: {
            items: [shiftNote(1, { attachments: [attachment] })],
            nextCursor: null,
            unreadCount: 0,
          },
        },
      },
    });
    renderConsole(<NotesPage />);
    expect(await screen.findByRole('button', { name: 'Open chart.png' })).toBeVisible();
  });
});
