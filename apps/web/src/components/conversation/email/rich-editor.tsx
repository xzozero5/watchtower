'use client';

import { IconButton, cn } from '@watchtower/ui';
import {
  Bold,
  Image as ImageIcon,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  Quote,
  RemoveFormatting,
  Underline,
} from 'lucide-react';
import {
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type Ref,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
} from 'react';

import { useI18n } from '@/i18n/provider';

import { escapeHtml, sanitizeEmailHtml } from './html';

export interface RichEditorHandle {
  focus: () => void;
  /** Inserts HTML at the caret (sanitised first). */
  insertHtml: (html: string) => void;
  /** Puts an uploaded picture at the caret. `src` is a local object URL; `uploadId` ties it to the file. */
  insertImage: (src: string, uploadId: string, alt: string) => void;
}

/**
 * Where image files go when they are pasted or dropped into the editor, or the button is pressed.
 * The upload component fills this in; with none given the editor stays text and the button says so.
 */
export type ImageFilesHandler = (files: File[]) => void;

const SAFE_URL = /^(https?:\/\/|mailto:)/i;

function command(name: string, value?: string): void {
  // `execCommand` is deprecated but is still the one editing API every browser ships; the result is
  // sanitised again before it is sent, so nothing here is trusted.
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- the only editing API all browsers ship
  if (typeof document.execCommand === 'function') document.execCommand(name, false, value);
}

/**
 * A small contenteditable editor: bold, italic, underline, bullet and numbered lists, quote, link.
 * Pasted HTML is rebuilt through the same allow-list as incoming mail, so no styles or scripts come
 * in with it. The content is owned by the DOM (no React children), so the caret never jumps.
 */
export function RichEditor({
  label,
  placeholder,
  initialHtml,
  onChange,
  onKeyDown,
  onImageFiles,
  handleRef,
  describedBy,
}: {
  label: string;
  placeholder: string;
  initialHtml: string;
  onChange: (html: string) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
  onImageFiles?: ImageFilesHandler;
  handleRef?: Ref<RichEditorHandle>;
  describedBy?: string;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (ref.current) ref.current.innerHTML = initialHtml;
    // Initial content only: later edits belong to the DOM.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const emit = () => {
    const html = ref.current?.innerHTML ?? '';
    // An emptied editor leaves "<br>" behind in some browsers.
    onChange(html === '<br>' ? '' : html);
  };

  const insertHtml = (html: string) => {
    ref.current?.focus();
    command('insertHTML', sanitizeEmailHtml(html, { styles: false }).html);
    emit();
  };

  useImperativeHandle(handleRef, () => ({
    focus: () => {
      ref.current?.focus();
    },
    insertHtml,
    insertImage: (src, uploadId, alt) => {
      ref.current?.focus();
      command(
        'insertHTML',
        `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" data-wt-upload="${escapeHtml(uploadId)}" style="max-width:100%">`,
      );
      emit();
    },
  }));

  const run = (name: string, value?: string) => {
    ref.current?.focus();
    command(name, value);
    emit();
  };

  const onPaste = (event: ClipboardEvent<HTMLDivElement>) => {
    const files = Array.from(event.clipboardData.files).filter((file) =>
      file.type.startsWith('image/'),
    );
    if (files.length > 0 && onImageFiles) {
      event.preventDefault();
      onImageFiles(files);
      return;
    }
    const html = event.clipboardData.getData('text/html');
    event.preventDefault();
    if (html) insertHtml(html);
    else insertHtml(escapeHtml(event.clipboardData.getData('text/plain')).replace(/\n/g, '<br>'));
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    const files = Array.from(event.dataTransfer.files).filter((file) =>
      file.type.startsWith('image/'),
    );
    if (files.length > 0 && onImageFiles) {
      event.preventDefault();
      onImageFiles(files);
    }
  };

  const link = () => {
    const url = window.prompt(t('email.compose.linkPrompt'), 'https://');
    if (url && SAFE_URL.test(url.trim())) run('createLink', url.trim());
  };

  const tools = [
    { cmd: 'bold', label: t('email.compose.bold'), icon: <Bold aria-hidden className="size-4" /> },
    {
      cmd: 'italic',
      label: t('email.compose.italic'),
      icon: <Italic aria-hidden className="size-4" />,
    },
    {
      cmd: 'underline',
      label: t('email.compose.underline'),
      icon: <Underline aria-hidden className="size-4" />,
    },
    {
      cmd: 'insertUnorderedList',
      label: t('email.compose.bulletList'),
      icon: <List aria-hidden className="size-4" />,
    },
    {
      cmd: 'insertOrderedList',
      label: t('email.compose.numberedList'),
      icon: <ListOrdered aria-hidden className="size-4" />,
    },
    {
      cmd: 'blockquote',
      label: t('email.compose.quote'),
      icon: <Quote aria-hidden className="size-4" />,
    },
    {
      cmd: 'link',
      label: t('email.compose.link'),
      icon: <LinkIcon aria-hidden className="size-4" />,
    },
    {
      cmd: 'removeFormat',
      label: t('email.compose.clearFormat'),
      icon: <RemoveFormatting aria-hidden className="size-4" />,
    },
  ];

  return (
    <div>
      <div
        ref={ref}
        role="textbox"
        aria-multiline="true"
        aria-label={label}
        aria-describedby={describedBy}
        aria-keyshortcuts="Control+Enter Meta+Enter"
        contentEditable
        suppressContentEditableWarning
        spellCheck
        data-placeholder={placeholder}
        onInput={emit}
        onBlur={emit}
        onPaste={onPaste}
        onDrop={onDrop}
        onKeyDown={onKeyDown}
        className={cn(
          'min-h-24 max-h-72 overflow-y-auto px-3 py-2 text-sm leading-normal break-words text-foreground outline-hidden',
          'empty:before:text-muted-foreground empty:before:content-[attr(data-placeholder)]',
          '[&_a]:text-link [&_a]:underline [&_blockquote]:ml-1 [&_blockquote]:border-l-2 [&_blockquote]:border-border-strong [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground',
          '[&_ol]:ml-5 [&_ol]:list-decimal [&_ul]:ml-5 [&_ul]:list-disc',
        )}
      />
      <div
        role="toolbar"
        aria-label={t('email.compose.toolbar')}
        aria-orientation="horizontal"
        className="flex flex-wrap items-center gap-0.5 px-2 pb-1"
      >
        {tools.map((tool) => (
          <IconButton
            key={tool.cmd}
            type="button"
            label={tool.label}
            icon={tool.icon}
            className="text-muted-foreground"
            onMouseDown={(event) => {
              event.preventDefault(); // keep the selection in the editor
            }}
            onClick={() => {
              if (tool.cmd === 'link') link();
              else if (tool.cmd === 'blockquote') run('formatBlock', 'blockquote');
              else run(tool.cmd);
            }}
          />
        ))}
        <IconButton
          type="button"
          label={t('email.compose.insertImage')}
          tooltip={onImageFiles ? undefined : t('email.compose.imageSoon')}
          icon={<ImageIcon aria-hidden className="size-4" />}
          aria-disabled={onImageFiles ? undefined : true}
          className="text-muted-foreground"
          onClick={() => {
            if (!onImageFiles) return;
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = 'image/png,image/jpeg,image/gif,image/webp';
            input.multiple = true;
            input.onchange = () => {
              const files = Array.from(input.files ?? []);
              if (files.length > 0) onImageFiles(files);
            };
            input.click();
          }}
        />
      </div>
    </div>
  );
}
