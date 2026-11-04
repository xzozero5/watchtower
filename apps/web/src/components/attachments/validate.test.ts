import { describe, expect, it } from 'vitest';

import { ApiRequestError } from '@/lib/api/errors';

import {
  filesFromTransfer,
  nameClipboardFile,
  uploadErrorKey,
  validateStaffFile,
} from './validate';

const file = (name: string, size: number, type = 'image/png') =>
  new File([new Uint8Array(size)], name, { type });

describe('validateStaffFile', () => {
  it('accepts an image and a log, refuses empty, huge and unknown types in words', () => {
    expect(validateStaffFile(file('shot.png', 10))).toBeNull();
    expect(validateStaffFile(file('app.log', 10, 'text/plain'))).toBeNull();
    expect(validateStaffFile(file('empty.png', 0))?.key).toBe('attachments.errors.empty');
    expect(validateStaffFile(file('big.png', 11 * 1024 * 1024))?.key).toBe(
      'attachments.errors.tooLarge',
    );
    expect(validateStaffFile(file('logo.svg', 10, 'image/svg+xml'))?.key).toBe(
      'attachments.errors.typeNotAllowed',
    );
    expect(validateStaffFile(file('run.exe', 10, 'application/octet-stream'))?.values.name).toBe(
      'run.exe',
    );
  });
});

describe('uploadErrorKey', () => {
  it('maps the api answers to a message', () => {
    const answer = (status: number) => new ApiRequestError(status, 'unknown', 'x');
    expect(uploadErrorKey(answer(413))).toBe('attachments.errors.tooLarge');
    expect(uploadErrorKey(answer(400))).toBe('attachments.errors.rejected');
    expect(uploadErrorKey(new ApiRequestError(400, 'archive_not_accepted', 'x'))).toBe(
      'attachments.errors.archive',
    );
    expect(uploadErrorKey(answer(429))).toBe('attachments.errors.rateLimited');
    expect(uploadErrorKey(answer(503))).toBe('attachments.errors.unavailable');
    expect(uploadErrorKey(new Error('boom'))).toBe('attachments.errors.generic');
  });
});

describe('pasted files', () => {
  it('names the browser generic image.png after the time, and keeps a real name', () => {
    const when = new Date(2026, 10, 3, 9, 5, 7);
    expect(nameClipboardFile(file('image.png', 3), 'screenshot', when).name).toBe(
      'screenshot-20261103-090507.png',
    );
    expect(nameClipboardFile(file('report.png', 3), 'screenshot', when).name).toBe('report.png');
    expect(nameClipboardFile(file('notes.txt', 3, 'text/plain'), 'screenshot', when).name).toBe(
      'notes.txt',
    );
  });

  it('reads files from a transfer, and nothing from a null one', () => {
    expect(filesFromTransfer(null, 'screenshot', true)).toEqual([]);
    const transfer = { files: [file('image.jpg', 3, 'image/jpeg')] } as unknown as DataTransfer;
    expect(filesFromTransfer(transfer, 'screenshot', true)[0]?.name).toMatch(
      /^screenshot-\d{8}-\d{6}\.jpg$/,
    );
    expect(filesFromTransfer(transfer, 'screenshot', false)[0]?.name).toBe('image.jpg');
  });
});
