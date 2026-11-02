import { PORTAL_ATTACHMENT_MAX_BYTES } from '@watchtower/shared';
import { describe, expect, it } from 'vitest';

import {
  AttachmentRefused,
  checkAttachments,
  detectKind,
  repairFileNameEncoding,
  sanitizeFileName,
} from './portal-attachment-check.js';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const GIF = new TextEncoder().encode('GIF89a\u0001\u0000');
const WEBP = new TextEncoder().encode('RIFF\u0000\u0000\u0000\u0000WEBPVP8 ');
const PDF = new TextEncoder().encode('%PDF-1.7\n%%EOF');
const text = (value: string) => new TextEncoder().encode(value);

function refusal(files: Parameters<typeof checkAttachments>[0]) {
  try {
    checkAttachments(files);
  } catch (error) {
    if (error instanceof AttachmentRefused) return { reason: error.reason, index: error.index };
    throw error;
  }
  return null;
}

describe('detectKind', () => {
  it('knows each allowed format by its signature', () => {
    expect(detectKind(PNG)).toBe('png');
    expect(detectKind(JPEG)).toBe('jpeg');
    expect(detectKind(GIF)).toBe('gif');
    expect(detectKind(WEBP)).toBe('webp');
    expect(detectKind(PDF)).toBe('pdf');
    expect(detectKind(text('2026-11-02 error: timeout\n'))).toBe('text');
  });

  it('does not take a binary file for text', () => {
    expect(detectKind(Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0, 0]))).toBeNull(); // zip
    expect(detectKind(Uint8Array.from([0x4d, 0x5a, 0x90, 0]))).toBeNull(); // exe
    expect(detectKind(Uint8Array.from([0xff, 0xfe, 0x41, 0x00]))).toBeNull(); // utf-16, not utf-8
  });
});

describe('checkAttachments', () => {
  it('accepts allowed files whose content matches their name, and picks the content type itself', () => {
    const checked = [
      ...checkAttachments([
        { originalName: 'Screen Shot.PNG', bytes: PNG },
        { originalName: 'photo.jpeg', bytes: JPEG },
        { originalName: 'anim.gif', bytes: GIF },
        { originalName: 'x.webp', bytes: WEBP },
        { originalName: 'statement.pdf', bytes: PDF },
      ]),
      ...checkAttachments([
        { originalName: 'export.csv', bytes: text('a,b\n1,2\n') },
        { originalName: 'app.log', bytes: text('\u001b[31mERROR\u001b[0m boom\n') },
        { originalName: 'notes.txt', bytes: text('สวัสดี') },
      ]),
    ];
    expect(checked.map((file) => file.contentType)).toEqual([
      'image/png',
      'image/jpeg',
      'image/gif',
      'image/webp',
      'application/pdf',
      'text/csv',
      'text/plain',
      'text/plain',
    ]);
  });

  it('refuses a name whose extension is not on the list', () => {
    for (const name of [
      'evil.svg',
      'page.html',
      'a.exe',
      'a.zip',
      'a.docx',
      'noextension',
      'a.png.exe',
    ]) {
      expect(refusal([{ originalName: name, bytes: PNG }]), name).toEqual({
        reason: 'extension_not_allowed',
        index: 0,
      });
    }
  });

  it('refuses content that is not what the name says', () => {
    expect(refusal([{ originalName: 'a.png', bytes: PDF }])?.reason).toBe('content_mismatch');
    expect(refusal([{ originalName: 'a.pdf', bytes: PNG }])?.reason).toBe('content_mismatch');
    // SVG with a picture's name: valid text, so it is "text" and a picture's name does not fit.
    expect(
      refusal([{ originalName: 'a.png', bytes: text('<svg xmlns="http://www.w3.org/2000/svg"/>') }])
        ?.reason,
    ).toBe('content_mismatch');
    expect(refusal([{ originalName: 'a.png', bytes: text('not an image') }])?.reason).toBe(
      'content_mismatch',
    );
  });

  it('refuses binary content under a text name', () => {
    expect(
      refusal([{ originalName: 'a.txt', bytes: Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0, 1]) }])
        ?.reason,
    ).toBe('content_not_allowed');
  });

  it('refuses web page and SVG content even with a text name', () => {
    for (const body of [
      '<!DOCTYPE html><html></html>',
      '  \n<html><body>x</body></html>',
      '<svg onload=alert(1)>',
      '<?xml version="1.0"?><svg/>',
      'hello <script>alert(1)</script>',
      '<SCRIPT SRC=x>',
    ]) {
      expect(refusal([{ originalName: 'a.txt', bytes: text(body) }]), body).toEqual({
        reason: 'active_content',
        index: 0,
      });
    }
  });

  it('refuses an empty file and a file over the size limit', () => {
    expect(refusal([{ originalName: 'a.txt', bytes: new Uint8Array(0) }])).toEqual({
      reason: 'empty_file',
      index: 0,
    });
    expect(
      refusal([
        { originalName: 'a.txt', bytes: new Uint8Array(PORTAL_ATTACHMENT_MAX_BYTES + 1).fill(97) },
      ]),
    ).toEqual({ reason: 'file_too_large', index: 0 });
  });

  it('accepts a file of exactly the limit', () => {
    const exactly = new Uint8Array(PORTAL_ATTACHMENT_MAX_BYTES).fill(97);
    expect(refusal([{ originalName: 'a.txt', bytes: exactly }])).toBeNull();
  });

  it('refuses more than five files, and files that are too large together', () => {
    const six = Array.from({ length: 6 }, () => ({ originalName: 'a.png', bytes: PNG }));
    expect(refusal(six)).toEqual({ reason: 'too_many_files', index: null });
    const big = new Uint8Array(9 * 1024 * 1024).fill(97);
    const three = Array.from({ length: 3 }, () => ({ originalName: 'a.txt', bytes: big }));
    expect(refusal(three)).toEqual({ reason: 'total_too_large', index: null });
  });
});

describe('sanitizeFileName', () => {
  it('keeps only the last path segment', () => {
    expect(sanitizeFileName('../../etc/passwd.txt')).toBe('passwd.txt');
    expect(sanitizeFileName('C:\\Users\\x\\shot.png')).toBe('shot.png');
  });

  it('drops control and bidirectional override characters, which can disguise an extension', () => {
    expect(sanitizeFileName('invoice\u202egpj.exe')).toBe('invoicegpj.exe');
    expect(sanitizeFileName('a\u0000b\nc.txt')).toBe('abc.txt');
  });

  it('gives an empty name a default and shortens a long one but keeps its extension', () => {
    expect(sanitizeFileName('   ')).toBe('file');
    expect(sanitizeFileName('...')).toBe('file');
    const long = sanitizeFileName(`${'a'.repeat(300)}.png`);
    expect(long.length).toBe(120);
    expect(long.endsWith('.png')).toBe(true);
  });
});

describe('repairFileNameEncoding', () => {
  it('turns UTF-8 read as latin1 back into the name', () => {
    const mojibake = Buffer.from('รูปหน้าจอ.png', 'utf8').toString('latin1');
    expect(repairFileNameEncoding(mojibake)).toBe('รูปหน้าจอ.png');
  });

  it('leaves ASCII and already-correct names alone', () => {
    expect(repairFileNameEncoding('shot.png')).toBe('shot.png');
    expect(repairFileNameEncoding('รูป.png')).toBe('รูป.png');
  });
});
