import { PORTAL_ATTACHMENT_MAX_BYTES } from '@watchtower/shared';
import { describe, expect, it } from 'vitest';

import { addAttachments, formatBytes, removeAttachment } from './attachments';

/** A file that reports a size without allocating it. */
function fileOf(name: string, size = 100, type = ''): File {
  const file = new File(['x'], name, { type, lastModified: 1 });
  Object.defineProperty(file, 'size', { value: size });
  return file;
}

describe('addAttachments', () => {
  it('adds files of an allowed type, whatever the case of the extension', () => {
    const result = addAttachments(
      [],
      [fileOf('shot.PNG'), fileOf('doc.pdf'), fileOf('app.log'), fileOf('data.csv')],
    );
    expect(result.files.map((f) => f.name)).toEqual(['shot.PNG', 'doc.pdf', 'app.log', 'data.csv']);
    expect(result.issues).toEqual([]);
  });

  it('turns away a type that is not on the list, with the name in the message', () => {
    const result = addAttachments([], [fileOf('logo.svg'), fileOf('page.html'), fileOf('ok.png')]);
    expect(result.files.map((f) => f.name)).toEqual(['ok.png']);
    expect(result.issues.map((i) => [i.key, i.values.name])).toEqual([
      ['portal.attachments.errors.typeNotAllowed', 'logo.svg'],
      ['portal.attachments.errors.typeNotAllowed', 'page.html'],
    ]);
  });

  it('turns away an empty file and one over the limit, and accepts one of exactly the limit', () => {
    const result = addAttachments(
      [],
      [
        fileOf('empty.txt', 0),
        fileOf('huge.log', PORTAL_ATTACHMENT_MAX_BYTES + 1),
        fileOf('exact.log', PORTAL_ATTACHMENT_MAX_BYTES),
      ],
    );
    expect(result.files.map((f) => f.name)).toEqual(['exact.log']);
    expect(result.issues.map((i) => i.key)).toEqual([
      'portal.attachments.errors.empty',
      'portal.attachments.errors.tooLarge',
    ]);
  });

  it('stops at five files', () => {
    const six = Array.from({ length: 6 }, (_, i) => fileOf(`f${String(i)}.png`));
    const result = addAttachments([], six);
    expect(result.files).toHaveLength(5);
    expect(result.issues.map((i) => i.key)).toEqual(['portal.attachments.errors.tooMany']);
  });

  it('keeps the total under the limit', () => {
    const nine = 9 * 1024 * 1024;
    const result = addAttachments(
      [],
      [fileOf('a.log', nine), fileOf('b.log', nine), fileOf('c.log', nine)],
    );
    expect(result.files).toHaveLength(2);
    expect(result.issues.map((i) => i.key)).toEqual(['portal.attachments.errors.totalTooLarge']);
  });

  it('does not add the same file twice', () => {
    const file = fileOf('a.png');
    const once = addAttachments([], [file]);
    const twice = addAttachments(once.files, [fileOf('a.png')]);
    expect(twice.files).toHaveLength(1);
    expect(twice.issues).toEqual([]);
  });
});

describe('removeAttachment', () => {
  it('drops the file at that position', () => {
    const files = [fileOf('a.png'), fileOf('b.png'), fileOf('c.png')];
    expect(removeAttachment(files, 1).map((f) => f.name)).toEqual(['a.png', 'c.png']);
  });
});

describe('formatBytes', () => {
  it('reads like a person would', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(150 * 1024)).toBe('150 KB');
    expect(formatBytes(3.5 * 1024 * 1024)).toBe('3.5 MB');
  });
});
