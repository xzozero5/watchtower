import { DEFAULT_ROLE_PERMISSIONS, type Permission, type Role } from '@watchtower/shared';
import { describe, expect, it } from 'vitest';

import { getMessages, translate } from '@/i18n';

import { KEYMAP, keymapFor } from './keymap';

const idsFor = (role: Role) => {
  const held = new Set<Permission>(DEFAULT_ROLE_PERMISSIONS[role]);
  return keymapFor((permission) => held.has(permission)).map((entry) => entry.id);
};

describe('keymapFor', () => {
  it('shows an agent every shortcut except the head console ones', () => {
    expect(idsFor('agent')).toEqual(
      KEYMAP.filter((entry) => !['goHome', 'goAdmin'].includes(entry.id)).map((entry) => entry.id),
    );
  });

  it('shows Home and Admin keys to a lead and a head, not to an agent or a customer', () => {
    for (const role of ['lead', 'head'] as const) {
      expect(idsFor(role)).toEqual(expect.arrayContaining(['goHome', 'goAdmin']));
    }
    for (const role of ['agent', 'client'] as const) {
      expect(idsFor(role)).not.toContain('goHome');
      expect(idsFor(role)).not.toContain('goAdmin');
    }
  });

  it('hides note, status and AI keys from a customer but keeps reply and navigation', () => {
    const ids = idsFor('client');
    for (const hidden of ['note', 'details', 'approve', 'edit', 'reject', 'collapseAssistant']) {
      expect(ids).not.toContain(hidden);
    }
    for (const shown of ['next', 'prev', 'open', 'search', 'reply', 'send', 'palette', 'help']) {
      expect(ids).toContain(shown);
    }
  });

  it('shows nothing that needs a permission to a user with none', () => {
    const ids = keymapFor(() => false).map((entry) => entry.id);
    expect(ids).not.toContain('reply');
    expect(ids).toContain('palette');
  });

  it('only marks single printable characters (or sequences of them) as single-key', () => {
    for (const entry of KEYMAP.filter((e) => e.singleKey)) {
      expect(entry.keys.every((key) => key.length === 1)).toBe(true);
    }
    for (const entry of KEYMAP.filter((e) => !e.singleKey)) {
      expect(entry.keys.some((key) => key.length > 1)).toBe(true);
    }
  });

  it('lists Ctrl+B for the navigation rail to everyone, and it is not a single-key shortcut', () => {
    const rail = KEYMAP.find((entry) => entry.id === 'rail');
    expect(rail?.keys).toEqual(['Ctrl', 'B']);
    expect(rail?.singleKey).toBe(false);
    expect(idsFor('client')).toContain('rail');
  });

  it('has a Thai and an English label for every entry', () => {
    for (const locale of ['en', 'th'] as const) {
      for (const entry of KEYMAP) {
        expect(translate(getMessages(locale), entry.labelKey), `${locale} ${entry.id}`).not.toBe(
          entry.labelKey,
        );
      }
    }
  });
});
