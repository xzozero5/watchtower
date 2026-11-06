'use client';

import type { EmailAddress } from '@watchtower/shared';
import { X } from 'lucide-react';
import { type ClipboardEvent, type KeyboardEvent, useId, useState } from 'react';

import { useI18n } from '@/i18n/provider';

import { addRecipients, parseRecipients } from './recipients';

/**
 * A To / Cc / Bcc row: the addresses as chips, and a box to type or paste more. Enter, comma,
 * semicolon or leaving the box turns the text into chips; Backspace on an empty box removes the
 * last chip. A bad address is said so, in words, and is not added.
 */
export function RecipientField({
  label,
  value,
  onChange,
  required = false,
}: {
  label: string;
  value: readonly EmailAddress[];
  onChange: (next: EmailAddress[]) => void;
  required?: boolean;
}) {
  const { t } = useI18n();
  const id = useId();
  const [draft, setDraft] = useState('');
  const [invalid, setInvalid] = useState<string | null>(null);

  const commit = (text: string): boolean => {
    if (text.trim() === '') return true;
    const parsed = parseRecipients(text);
    if (parsed.valid.length > 0) onChange(addRecipients(value, parsed.valid));
    if (parsed.invalid.length > 0) {
      setInvalid(parsed.invalid[0] ?? null);
      setDraft(parsed.invalid.join(', '));
      return false;
    }
    setInvalid(null);
    setDraft('');
    return true;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' || event.key === ',' || event.key === ';') {
      if (draft.trim() === '' && event.key === 'Enter') return; // let the form decide
      event.preventDefault();
      commit(draft);
    } else if (event.key === 'Backspace' && draft === '' && value.length > 0) {
      onChange(value.slice(0, -1));
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLInputElement>) => {
    const text = event.clipboardData.getData('text');
    if (/[,;\n<]/.test(text)) {
      event.preventDefault();
      commit(`${draft}${text}`);
    }
  };

  return (
    <div className="flex items-start gap-2 px-3 py-1 text-sm">
      <label htmlFor={id} className="w-12 shrink-0 pt-1 text-xs text-muted-foreground">
        {label}
      </label>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
        {value.map((entry) => (
          <span
            key={entry.address}
            className="inline-flex max-w-full items-center gap-1 rounded-full bg-surface px-2 py-0.5 text-xs ring-1 ring-border ring-inset"
            title={entry.name ? `${entry.name} <${entry.address}>` : entry.address}
          >
            <span className="truncate">{entry.name?.trim() || entry.address}</span>
            <button
              type="button"
              aria-label={t('email.compose.remove', { address: entry.address })}
              onClick={() => {
                onChange(value.filter((item) => item.address !== entry.address));
              }}
              className="inline-flex size-4 items-center justify-center rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-ring"
            >
              <X aria-hidden className="size-3" />
            </button>
          </span>
        ))}
        <input
          id={id}
          type="email"
          inputMode="email"
          autoComplete="off"
          value={draft}
          required={required && value.length === 0}
          aria-invalid={invalid !== null}
          aria-describedby={invalid !== null ? `${id}-error` : undefined}
          placeholder={value.length === 0 ? t('email.compose.recipientHint') : ''}
          onChange={(event) => {
            setDraft(event.target.value);
            if (invalid !== null) setInvalid(null);
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onBlur={() => {
            commit(draft);
          }}
          className="min-w-[10ch] flex-1 bg-transparent py-0.5 text-sm outline-hidden placeholder:text-muted-foreground"
        />
      </div>
      {invalid !== null ? (
        <p id={`${id}-error`} role="alert" className="shrink-0 pt-1 text-xs text-danger">
          {t('email.compose.invalid', { value: invalid })}
        </p>
      ) : null}
    </div>
  );
}
