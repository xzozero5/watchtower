import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  INSIGHT_ELEMENTS,
  makeClaim,
  type InsightElementKey,
  type InsightItem,
  type InsightState,
  type Permission,
} from '@watchtower/shared';
import { PERMISSIONS } from '@watchtower/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ElementInsight } from './element-insight';
import { makeSession, uuid } from '@/test/fixtures';
import { mockApi } from '@/test/mock-api';
import { renderApp } from '@/test-utils';
import type * as SessionModule from '@/lib/auth/session';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/dashboard',
  useSearchParams: () => new URLSearchParams(),
}));

let grants = new Set<Permission>(Object.keys(PERMISSIONS) as Permission[]);
let userRole: 'head' | 'dev' | 'client' = 'head';

vi.mock('@/lib/auth/session', async (original) => ({
  ...(await original<typeof SessionModule>()),
  useSession: () => ({
    session: makeSession(userRole),
    can: (permission: Permission) => grants.has(permission),
  }),
  useUserId: () => uuid(900),
}));

beforeEach(() => {
  userRole = 'head';
  grants = new Set(Object.keys(PERMISSIONS) as Permission[]);
});

function setupApi(overrides: Parameters<typeof mockApi>[0] = {}) {
  return mockApi({
    'GET /v1/auth/session': { json: makeSession(userRole) },
    ...overrides,
  });
}

function makeItem(
  element: InsightElementKey,
  state: InsightState,
  options: {
    narrationId?: string;
    stateLabel?: string;
    generatedAt?: string;
    claims?: InsightItem['claims'];
    narrationClaims?: InsightItem['claims'];
  } = {},
): InsightItem {
  const generatedAt = options.generatedAt ?? new Date(Date.now() - 5 * 60_000).toISOString();
  return {
    element,
    scope: 'instance',
    period: 'now',
    mode: 'N',
    state,
    stateLabel: options.stateLabel ?? state,
    asOf: new Date().toISOString(),
    facts: [
      { id: 'f1', kind: 'metric', value: 42, text: 'Fact 42' },
      { id: 'f2', kind: 'delta', value: 10, text: 'Fact 10' },
    ],
    claims: options.claims ?? [
      makeClaim('Deterministic system claim', [
        { kind: 'metric', label: 'Metric 1', href: '/ops/incidents' },
      ]),
    ],
    narration:
      state === 'fresh' || state === 'stale'
        ? {
            id: options.narrationId,
            claims: options.narrationClaims ?? [
              makeClaim('AI generated narration claim with citation', [
                { kind: 'incident', label: 'INC-1', href: '/ops/incidents' },
              ]),
            ],
            generatedAt,
            mock: false,
          }
        : null,
  };
}

function sourcesInDir(dirPath: string): { file: string; content: string }[] {
  return readdirSync(dirPath, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = join(dirPath, entry.name);
    return entry.isDirectory()
      ? sourcesInDir(fullPath)
      : entry.name.endsWith('.tsx') || entry.name.endsWith('.ts')
        ? [{ file: fullPath, content: readFileSync(fullPath, 'utf8') }]
        : [];
  });
}

function resolveLocalModule(fromFile: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith('@/')) {
    base = join(process.cwd(), 'src', specifier.slice(2));
  } else if (specifier.startsWith('./') || specifier.startsWith('../')) {
    base = resolve(dirname(fromFile), specifier);
  } else {
    return null;
  }

  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return null;
}

describe('ElementInsight component (T-419a)', () => {
  describe('AC-J17 exact copy for all 6 states in Thai', () => {
    const states: { state: InsightState; minutesAgo?: number; expectedText: string }[] = [
      { state: 'fresh', minutesAgo: 5, expectedText: 'AI · 5 นาทีที่แล้ว' },
      { state: 'fresh', minutesAgo: 120, expectedText: 'AI · 2 ชม.ที่แล้ว' },
      { state: 'system', expectedText: 'จากระบบ' },
      { state: 'stale', expectedText: 'สรุปก่อนข้อมูลล่าสุด' },
      { state: 'none', expectedText: 'ยังไม่มีสรุป AI ล่าสุด — แสดงข้อมูลจากระบบ' },
      { state: 'budget', expectedText: 'สรุป AI พักชั่วคราว (ครบงบวันนี้)' },
      { state: 'paused', expectedText: 'AI หยุดทำงาน — แสดงข้อมูลตรงจากระบบ' },
    ];

    it.each(states)(
      'renders state badge "$expectedText" for state "$state"',
      async ({ state, minutesAgo, expectedText }) => {
        const generatedAt = minutesAgo
          ? new Date(Date.now() - minutesAgo * 60_000).toISOString()
          : undefined;
        const item = makeItem('incidents.open', state, { generatedAt });
        setupApi({
          'GET /v1/insights': { json: { items: [item] } },
        });

        renderApp(<ElementInsight element="incidents.open" period="now" />, { locale: 'th' });

        const badge = await screen.findByTestId('insight-state-badge');
        expect(badge).toHaveAttribute('data-state', state);
        expect(badge).toHaveTextContent(expectedText);
      },
    );
  });

  describe('AC-J17 exact copy for all 6 states in English', () => {
    const states: { state: InsightState; minutesAgo?: number; expectedText: string }[] = [
      { state: 'fresh', minutesAgo: 5, expectedText: 'AI · 5m ago' },
      { state: 'fresh', minutesAgo: 120, expectedText: 'AI · 2h ago' },
      { state: 'system', expectedText: 'From system' },
      { state: 'stale', expectedText: 'Summary predates latest data' },
      { state: 'none', expectedText: 'No current AI summary — showing system data' },
      { state: 'budget', expectedText: 'AI summaries paused (daily budget reached)' },
      { state: 'paused', expectedText: 'AI paused — showing system data' },
    ];

    it.each(states)(
      'renders state badge "$expectedText" for state "$state"',
      async ({ state, minutesAgo, expectedText }) => {
        const generatedAt = minutesAgo
          ? new Date(Date.now() - minutesAgo * 60_000).toISOString()
          : undefined;
        const item = makeItem('incidents.open', state, { generatedAt });
        setupApi({
          'GET /v1/insights': { json: { items: [item] } },
        });

        renderApp(<ElementInsight element="incidents.open" period="now" />, { locale: 'en' });

        const badge = await screen.findByTestId('insight-state-badge');
        expect(badge).toHaveAttribute('data-state', state);
        expect(badge).toHaveTextContent(expectedText);
      },
    );
  });

  describe('Citations rendering', () => {
    it('renders citation chip with clickable link when href exists', async () => {
      const item = makeItem('incidents.open', 'fresh', {
        narrationClaims: [
          makeClaim('Incident reported in system', [
            { kind: 'incident', label: 'INC-101', href: '/ops/incidents' },
          ]),
        ],
      });
      setupApi({
        'GET /v1/insights': { json: { items: [item] } },
      });

      renderApp(<ElementInsight element="incidents.open" period="now" />);

      await screen.findByText('Incident reported in system');
      const link = screen.getByRole('link', { name: /INC-101/ });
      expect(link).toHaveAttribute('href', '/ops/incidents');
    });

    it('renders citation with uncited pill when uncited is true', async () => {
      const item = makeItem('incidents.open', 'fresh', {
        narrationClaims: [makeClaim('Uncited assertion from AI', [])],
      });
      setupApi({
        'GET /v1/insights': { json: { items: [item] } },
      });

      renderApp(<ElementInsight element="incidents.open" period="now" />);

      await screen.findByText('Uncited assertion from AI');
      expect(screen.getByText('No evidence')).toBeInTheDocument();
    });
  });

  describe('Feedback 👍 / 👎', () => {
    it('submits thumbs-up feedback using item.narration.id without insightId prop', async () => {
      const feedbackCalled = vi.fn();
      const narrationId = uuid(77);
      setupApi({
        'GET /v1/insights': {
          json: { items: [makeItem('dashboard.ops.sla', 'fresh', { narrationId })] },
        },
        'POST /v1/assistant/feedback': (req) => {
          feedbackCalled(req.body);
          return {
            json: {
              id: uuid(1),
              target: { kind: 'insight', id: narrationId },
              rating: 'up',
              reason: null,
              updatedAt: new Date().toISOString(),
            },
          };
        },
      });

      renderApp(<ElementInsight element="dashboard.ops.sla" />);

      const upButton = await screen.findByTestId('insight-feedback-up');
      await userEvent.click(upButton);

      await waitFor(() => {
        expect(feedbackCalled).toHaveBeenCalledWith(
          expect.objectContaining({
            target: { kind: 'insight', id: narrationId },
            rating: 'up',
          }),
        );
      });
      expect(screen.getByTestId('feedback-submitted')).toBeInTheDocument();
    });

    it('submits thumbs-up feedback using insightId prop when narration.id is absent', async () => {
      const feedbackCalled = vi.fn();
      setupApi({
        'GET /v1/insights': {
          json: { items: [makeItem('dashboard.ops.sla', 'fresh', { narrationId: undefined })] },
        },
        'POST /v1/assistant/feedback': (req) => {
          feedbackCalled(req.body);
          return {
            json: {
              id: uuid(1),
              target: { kind: 'insight', id: uuid(99) },
              rating: 'up',
              reason: null,
              updatedAt: new Date().toISOString(),
            },
          };
        },
      });

      renderApp(<ElementInsight element="dashboard.ops.sla" insightId={uuid(99)} />);

      const upButton = await screen.findByTestId('insight-feedback-up');
      await userEvent.click(upButton);

      await waitFor(() => {
        expect(feedbackCalled).toHaveBeenCalledWith(
          expect.objectContaining({
            target: { kind: 'insight', id: uuid(99) },
            rating: 'up',
          }),
        );
      });
      expect(screen.getByTestId('feedback-submitted')).toBeInTheDocument();
    });

    it.each(['system', 'none', 'budget', 'paused'] as const)(
      'does not render feedback buttons when state is %s (narration is null)',
      async (state) => {
        setupApi({
          'GET /v1/insights': { json: { items: [makeItem('incidents.open', state)] } },
        });

        renderApp(<ElementInsight element="incidents.open" period="now" insightId={uuid(99)} />);

        await screen.findByTestId('insight-state-badge');
        expect(screen.queryByTestId('insight-feedback-up')).not.toBeInTheDocument();
        expect(screen.queryByTestId('insight-feedback-down')).not.toBeInTheDocument();
      },
    );

    it('does not render feedback buttons when narration.id and insightId are both undefined', async () => {
      setupApi({
        'GET /v1/insights': {
          json: { items: [makeItem('incidents.open', 'fresh', { narrationId: undefined })] },
        },
      });

      renderApp(<ElementInsight element="incidents.open" period="now" />);

      await screen.findByTestId('insight-state-badge');
      expect(screen.queryByTestId('insight-feedback-up')).not.toBeInTheDocument();
      expect(screen.queryByTestId('insight-feedback-down')).not.toBeInTheDocument();
    });

    it('includes judges_person reason code for person-related element (shift.overview)', async () => {
      setupApi({
        'GET /v1/insights': {
          json: { items: [makeItem('shift.overview', 'fresh', { narrationId: uuid(99) })] },
        },
      });

      renderApp(<ElementInsight element="shift.overview" period="now" />);

      const downButton = await screen.findByTestId('insight-feedback-down');
      await userEvent.click(downButton);

      const dialog = await screen.findByTestId('insight-feedback-dialog');
      expect(dialog).toBeInTheDocument();
      // Person element MUST have judges_person
      expect(screen.getByLabelText(/Judges individual performance/)).toBeInTheDocument();
    });

    it('excludes judges_person reason code for non-person element (alerts.noise)', async () => {
      setupApi({
        'GET /v1/insights': {
          json: { items: [makeItem('alerts.noise', 'fresh', { narrationId: uuid(99) })] },
        },
      });

      renderApp(<ElementInsight element="alerts.noise" period="d7" />);

      const downButton = await screen.findByTestId('insight-feedback-down');
      await userEvent.click(downButton);

      const dialog = await screen.findByTestId('insight-feedback-dialog');
      expect(dialog).toBeInTheDocument();
      // Non-person element MUST NOT have judges_person
      expect(screen.queryByLabelText(/Judges individual performance/)).not.toBeInTheDocument();
      expect(screen.getByLabelText(/Incorrect numbers/)).toBeInTheDocument();
    });

    it('submits thumbs-down feedback with selected reason', async () => {
      const feedbackCalled = vi.fn();
      const narrationId = uuid(88);
      setupApi({
        'GET /v1/insights': {
          json: { items: [makeItem('shift.overview', 'fresh', { narrationId })] },
        },
        'POST /v1/assistant/feedback': (req) => {
          feedbackCalled(req.body);
          return {
            json: {
              id: uuid(2),
              target: { kind: 'insight', id: narrationId },
              rating: 'down',
              reason: 'judges_person',
              updatedAt: new Date().toISOString(),
            },
          };
        },
      });

      renderApp(<ElementInsight element="shift.overview" period="now" />);

      const downButton = await screen.findByTestId('insight-feedback-down');
      await userEvent.click(downButton);

      const radio = screen.getByLabelText(/Judges individual performance/);
      await userEvent.click(radio);

      const submitButton = screen.getByTestId('feedback-reason-submit');
      await userEvent.click(submitButton);

      await waitFor(() => {
        expect(feedbackCalled).toHaveBeenCalledWith(
          expect.objectContaining({
            target: { kind: 'insight', id: narrationId },
            rating: 'down',
            reason: 'judges_person',
          }),
        );
      });
      expect(screen.getByTestId('feedback-submitted')).toBeInTheDocument();
    });
  });

  describe('RBAC & Permission protection', () => {
    it('does not render when user lacks element permission', () => {
      grants.delete('ticket.read'); // incidents.open requires ticket.read
      setupApi({
        'GET /v1/insights': { json: { items: [makeItem('incidents.open', 'fresh')] } },
      });

      renderApp(<ElementInsight element="incidents.open" period="now" />);

      expect(screen.queryByTestId('element-insight')).not.toBeInTheDocument();
    });

    it('does not render when user lacks assistant.use permission', () => {
      grants.delete('assistant.use');
      setupApi({
        'GET /v1/insights': { json: { items: [makeItem('dashboard.ops.sla', 'fresh')] } },
      });

      renderApp(<ElementInsight element="dashboard.ops.sla" period="d7" />);

      expect(screen.queryByTestId('element-insight')).not.toBeInTheDocument();
    });

    it('does not render when API returns no item for this element', async () => {
      setupApi({
        'GET /v1/insights': { json: { items: [] } },
      });

      renderApp(<ElementInsight element="dashboard.ops.volume" period="d7" />);

      await waitFor(() => {
        expect(screen.queryByTestId('element-insight')).not.toBeInTheDocument();
      });
    });

    it('does not crash or show when API returns error (non-fatal)', async () => {
      setupApi({
        'GET /v1/insights': { status: 500, json: { error: 'server error' } },
      });

      renderApp(<ElementInsight element="dashboard.ops.volume" period="d7" />);

      await waitFor(() => {
        expect(screen.queryByTestId('element-insight')).not.toBeInTheDocument();
      });
    });
  });

  describe('Public route isolation check', () => {
    it('proves that public routes never import ElementInsight or insights module', () => {
      const publicDirs = [
        join(process.cwd(), 'src/app/portal'),
        join(process.cwd(), 'src/app/status'),
        join(process.cwd(), 'src/app/csat'),
        join(process.cwd(), 'src/app/start'),
        join(process.cwd(), 'src/app/login'),
        join(process.cwd(), 'src/components/portal'),
        join(process.cwd(), 'src/components/csat'),
        join(process.cwd(), 'src/components/login'),
        join(process.cwd(), 'src/components/ops/status'),
      ];

      const forbiddenImports = [
        'components/insights',
        'element-insight',
        'lib/insights',
        'use-insight',
        'useInsight',
        'ElementInsight',
        '/v1/insights',
      ];

      for (const dir of publicDirs) {
        const files = sourcesInDir(dir);
        for (const { file, content } of files) {
          // status-admin-page is the staff-only admin view, not a public page
          if (file.includes('status-admin-page')) continue;
          for (const pattern of forbiddenImports) {
            expect(
              content.includes(pattern),
              `Public file ${file} must NOT contain ${pattern}`,
            ).toBe(false);
          }
        }
      }
    });

    it('proves transitive local imports from public entrypoints never reach insights', () => {
      const publicEntrypoints = [
        join(process.cwd(), 'src/app/portal'),
        join(process.cwd(), 'src/app/status'),
      ];

      const forbiddenPathPatterns = [
        'components/insights',
        'element-insight',
        'lib/insights',
        'use-insight',
      ];

      const forbiddenContentPatterns = [
        'components/insights',
        'element-insight',
        'lib/insights',
        'use-insight',
        'useInsight',
        'ElementInsight',
      ];

      const visited = new Set<string>();
      const queue: string[] = [];

      for (const dir of publicEntrypoints) {
        if (!existsSync(dir)) continue;
        for (const { file } of sourcesInDir(dir)) {
          queue.push(file);
        }
      }

      while (queue.length > 0) {
        const current = queue.pop();
        if (!current) continue;
        const normalized = current.replace(/\\/g, '/');
        if (visited.has(normalized)) continue;
        visited.add(normalized);

        for (const pattern of forbiddenPathPatterns) {
          expect(
            normalized.includes(pattern),
            `Transitively imported file ${normalized} must not match forbidden pattern ${pattern}`,
          ).toBe(false);
        }

        const content = readFileSync(current, 'utf8');
        for (const pattern of forbiddenContentPatterns) {
          expect(
            content.includes(pattern),
            `File ${current} (transitive dependency of public route) must NOT contain ${pattern}`,
          ).toBe(false);
        }

        // Neither public page should ever contain /v1/insights
        if (!normalized.includes('src/lib/api/')) {
          expect(
            content.includes('/v1/insights'),
            `File ${current} (transitive dependency of public route) must NOT contain /v1/insights`,
          ).toBe(false);
        }

        const importRegex = /(?:from\s+['"]|import\s*\(\s*['"]|import\s+['"])([^'"]+)['"]/g;
        let match: RegExpExecArray | null;
        while ((match = importRegex.exec(content)) !== null) {
          const specifier = match[1];
          if (!specifier) continue;
          const resolved = resolveLocalModule(current, specifier);
          if (resolved) {
            queue.push(resolved);
          }
        }
      }
    });
  });

  describe('Element coverage (T-420)', () => {
    it('places <ElementInsight> for every element in INSIGHT_ELEMENTS where mode is F or N', () => {
      const componentsDir = join(process.cwd(), 'src/components');
      const allFiles = sourcesInDir(componentsDir);

      const targetElements = (Object.keys(INSIGHT_ELEMENTS) as InsightElementKey[]).filter(
        (key) => {
          const entry = INSIGHT_ELEMENTS[key];
          return entry.mode === 'F' || entry.mode === 'N';
        },
      );

      expect(targetElements.length).toBe(30);

      for (const key of targetElements) {
        const hasPlacement = allFiles.some(({ file, content }) => {
          if (file.includes('components/insights')) return false;
          const elementRegex = new RegExp(
            `<ElementInsight[\\s\\S]*?element=["']${key.replace('.', '\\.')}["']`,
          );
          return elementRegex.test(content);
        });

        expect(
          hasPlacement,
          `Expected <ElementInsight element="${key}" ... /> to be placed in src/components/**`,
        ).toBe(true);
      }
    });
  });
});
