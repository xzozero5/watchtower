import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  INSIGHT_ELEMENTS,
  INSIGHT_ELEMENT_KEYS,
  PERMISSIONS,
  type Permission,
} from '@watchtower/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AskAiElement } from './ask-ai-element';
import { makeSession } from '@/test/fixtures';
import { renderApp } from '@/test-utils';
import type * as SessionModule from '@/lib/auth/session';

let availabilityState: 'ok' | 'paused' | 'budget' | 'unavailable' = 'ok';
vi.mock('@/lib/assistant/use-assistant-chat', () => ({
  useAssistantStarters: () => ({ data: { state: availabilityState }, isError: false }),
}));
let grants = new Set<Permission>();
vi.mock('@/lib/auth/session', async (original) => ({
  ...(await original<typeof SessionModule>()),
  useSession: () => ({
    session: makeSession('head'),
    can: (permission: Permission) => grants.has(permission),
  }),
}));
beforeEach(() => {
  availabilityState = 'ok';
  grants = new Set(Object.keys(PERMISSIONS) as Permission[]);
});

describe('element ask controls', () => {
  it.each(INSIGHT_ELEMENT_KEYS)('%s follows registry visibility and permission rules', (key) => {
    const entry = INSIGHT_ELEMENTS[key];
    renderApp(
      <AskAiElement
        element={key}
        scope={['user', 'instance'].includes(entry.scope) ? entry.scope : `${entry.scope}:abc`}
      />,
    );
    const button = screen.queryByTestId('ask-ai-about');
    if (entry.mode === 'X') expect(button).not.toBeInTheDocument();
    else {
      expect(button).toBeInTheDocument();
      expect(button).toHaveAttribute('data-element', key);
      expect(button).toHaveAccessibleName(/^Ask AI about /);
    }
  });

  it('opens an F element with its exact scope and period without sending a message', async () => {
    const listener = vi.fn();
    window.addEventListener('wt:assistant-open', listener);
    renderApp(<AskAiElement element="dashboard.ops.ai" period="d30" />);
    await userEvent.click(screen.getByRole('button', { name: 'Ask AI about AI' }));
    expect(listener).toHaveBeenCalledOnce();
    expect((listener.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({
      element: { key: 'dashboard.ops.ai', scope: 'instance', period: 'd30' },
      label: 'AI',
    });
    window.removeEventListener('wt:assistant-open', listener);
  });

  it.each(['permission', 'assistant', 'scope', 'period', 'week'] as const)(
    'keeps a disabled control with a reason: %s',
    async (reason) => {
      if (reason === 'permission') grants.delete('performance.read.all');
      if (reason === 'assistant') grants.delete('assistant.use');
      renderApp(
        reason === 'scope' ? (
          <AskAiElement element="org.health" />
        ) : reason === 'week' ? (
          <AskAiElement element="reports.ceo.figures" />
        ) : (
          <AskAiElement element="dashboard.ops.team" period={reason === 'period' ? 'd999' : 'd7'} />
        ),
      );
      const button = screen.getByTestId('ask-ai-about');
      expect(button).toHaveAttribute('aria-disabled', 'true');
      expect(button.getAttribute('aria-description')).toBeTruthy();
      const listener = vi.fn();
      window.addEventListener('wt:assistant-open', listener);
      await userEvent.click(button);
      expect(listener).not.toHaveBeenCalled();
      window.removeEventListener('wt:assistant-open', listener);
    },
  );

  it('does not require ticket.read for a CEO-only assistant user', () => {
    grants = new Set<Permission>(['assistant.use', 'ceo.view']);
    renderApp(<AskAiElement element="reports.ceo.figures" />);
    expect(screen.getByTestId('ask-ai-about')).toHaveAttribute(
      'aria-description',
      'This period is not supported by the assistant yet.',
    );
  });

  it.each(['paused', 'budget', 'unavailable'] as const)(
    'keeps the control disabled with the %s reason',
    async (state) => {
      availabilityState = state;
      renderApp(<AskAiElement element="home.status" />);
      const button = screen.getByTestId('ask-ai-about');
      expect(button).toHaveAttribute('aria-disabled', 'true');
      expect(button.getAttribute('aria-description')).toMatch(/AI/);
      const listener = vi.fn();
      window.addEventListener('wt:assistant-open', listener);
      await userEvent.click(button);
      expect(listener).not.toHaveBeenCalled();
      window.removeEventListener('wt:assistant-open', listener);
    },
  );

  it('accepts anyOf without requiring both permissions', () => {
    grants.delete('roster.manage');
    renderApp(<AskAiElement element="shift.overview" />);
    expect(screen.getByTestId('ask-ai-about')).not.toHaveAttribute('aria-disabled');
  });
});
