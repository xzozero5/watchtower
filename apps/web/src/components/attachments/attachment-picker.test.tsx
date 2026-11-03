import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { apiError, mockApi } from '@/test/mock-api';
import { renderApp } from '@/test-utils';

import { AttachmentDropZone } from './attachment-drop-zone';
import { AttachmentPicker } from './attachment-picker';
import { useAttachmentUpload } from './use-attachment-upload';

const PNG = new File([new Uint8Array([1, 2, 3])], 'chart.png', { type: 'image/png' });

function Harness({ max }: { max?: number }) {
  const upload = useAttachmentUpload(max === undefined ? {} : { max });
  return (
    <div>
      <AttachmentDropZone upload={upload}>
        <textarea aria-label="body" />
      </AttachmentDropZone>
      <AttachmentPicker upload={upload} />
      <output data-testid="ids">{upload.attachmentIds.join(',')}</output>
      <output data-testid="busy">{String(upload.busy)}</output>
      <button type="button" onClick={upload.clear}>
        clear
      </button>
    </div>
  );
}

let created = 0;
const upload = (name: string) => ({
  json: {
    id: `00000000-0000-4000-8000-00000000000${String(++created)}`,
    filename: name,
    contentType: 'image/png',
    size: 3,
  },
  status: 201,
});

beforeEach(() => {
  created = 0;
  let n = 0;
  vi.stubGlobal(
    'URL',
    class extends URL {
      static override createObjectURL = () => `blob:preview-${String(++n)}`;
      static override revokeObjectURL = () => undefined;
    },
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function choose(files: File[]) {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error('no file input');
  fireEvent.change(input, { target: { files } });
}

describe('useAttachmentUpload with the picker', () => {
  it('uploads a chosen image at once, shows a thumbnail, and hands out its id', async () => {
    const mock = mockApi({
      'POST /v1/uploads': () => upload('chart.png'),
    });
    renderApp(<Harness />);
    choose([PNG]);
    expect(screen.getByText('chart.png')).toBeVisible();
    await waitFor(() => {
      expect(screen.getByTestId('ids').textContent).toBe('00000000-0000-4000-8000-000000000001');
    });
    expect(screen.getByTestId('busy').textContent).toBe('false');
    expect(mock.callsTo('/v1/uploads', 'POST')).toHaveLength(1);
    const thumbnail = document.querySelector('li img');
    expect(thumbnail?.getAttribute('src')).toBe('blob:preview-1');
  });

  it('attaches an image pasted from the clipboard, named after the time, and ignores a text paste', async () => {
    const mock = mockApi({ 'POST /v1/uploads': () => upload('x') });
    renderApp(<Harness />);
    const zone = screen.getByTestId('attachment-drop-zone');

    fireEvent.paste(zone, { clipboardData: { files: [], types: ['text/plain'] } });
    expect(mock.callsTo('/v1/uploads')).toHaveLength(0);

    const shot = new File([new Uint8Array([9, 9])], 'image.png', { type: 'image/png' });
    fireEvent.paste(zone, { clipboardData: { files: [shot], types: ['Files'] } });
    await waitFor(() => {
      expect(mock.callsTo('/v1/uploads', 'POST')).toHaveLength(1);
    });
    const body = mock.callsTo('/v1/uploads', 'POST')[0]?.body as { files: { name: string }[] };
    expect(body.files[0]?.name).toMatch(/^screenshot-\d{8}-\d{6}\.png$/);
  });

  it('attaches files dropped on the field', async () => {
    const mock = mockApi({ 'POST /v1/uploads': () => upload('chart.png') });
    renderApp(<Harness />);
    fireEvent.drop(screen.getByTestId('attachment-drop-zone'), {
      dataTransfer: { files: [PNG], types: ['Files'] },
    });
    await waitFor(() => {
      expect(mock.callsTo('/v1/uploads', 'POST')).toHaveLength(1);
    });
  });

  it('turns away a type that cannot be attached, in words, without calling the api', () => {
    const mock = mockApi({});
    renderApp(<Harness />);
    choose([new File(['<svg/>'], 'logo.svg', { type: 'image/svg+xml' })]);
    expect(screen.getByText(/logo\.svg is not an image or a file type/)).toBeVisible();
    expect(mock.callsTo('/v1/uploads')).toHaveLength(0);
  });

  it('stops at the maximum', () => {
    mockApi({ 'POST /v1/uploads': () => upload('a') });
    renderApp(<Harness max={1} />);
    choose([PNG, new File([new Uint8Array([4])], 'two.png', { type: 'image/png' })]);
    expect(screen.getByText(/two\.png: at most 1 files/)).toBeVisible();
    expect(screen.getByRole('button', { name: /Attach/ })).toBeDisabled();
  });

  it('keeps a failed upload in the list with a retry that works', async () => {
    let attempts = 0;
    mockApi({
      'POST /v1/uploads': () => {
        attempts += 1;
        return attempts === 1 ? apiError(503, 'storage_unavailable') : upload('chart.png');
      },
    });
    renderApp(<Harness />);
    choose([PNG]);
    expect(await screen.findByText(/Files cannot be saved right now/)).toBeVisible();
    expect(screen.getByTestId('ids').textContent).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Try chart.png again' }));
    await waitFor(() => {
      expect(screen.getByTestId('ids').textContent).not.toBe('');
    });
  });

  it('removes a file and clears the list', async () => {
    mockApi({ 'POST /v1/uploads': () => upload('chart.png') });
    renderApp(<Harness />);
    choose([PNG]);
    await waitFor(() => {
      expect(screen.getByTestId('busy').textContent).toBe('false');
    });
    fireEvent.click(screen.getByRole('button', { name: 'Remove chart.png' }));
    expect(screen.queryByText('chart.png')).toBeNull();
    expect(screen.getByText('chart.png removed')).toBeInTheDocument();
    choose([PNG]);
    await waitFor(() => {
      expect(screen.getByTestId('ids').textContent).not.toBe('');
    });
    fireEvent.click(screen.getByRole('button', { name: 'clear' }));
    expect(screen.getByTestId('ids').textContent).toBe('');
  });
});
