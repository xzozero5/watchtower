'use client';

import type { EvidenceCard } from '@watchtower/shared';
import {
  Button,
  cn,
  HelpHint,
  IconButton,
  Input,
  Skeleton,
  TintChip,
  Tooltip,
  toast,
} from '@watchtower/ui';
import {
  Database,
  FlaskConical,
  GitCommitHorizontal,
  Info,
  LoaderCircle,
  type LucideIcon,
  Pin,
  PinOff,
  ScrollText,
  Search,
  TrendingUp,
  Unplug,
  X,
} from 'lucide-react';
import { useId, useState } from 'react';

import { useI18n } from '@/i18n/provider';
import { isApiError } from '@/lib/api/errors';
import { useSession } from '@/lib/auth/session';
import { formatRelative } from '@/lib/format';
import { useNow } from '@/lib/use-now';
import { useRunTool, useTicketCards, useTicketTools, useUnpinCard } from '@/lib/tools/queries';

type ToolButtonData = NonNullable<ReturnType<typeof useTicketTools>['data']>['buttons'][number];

/** One icon per kind of check; the kind is also said in words in the tooltip. */
const KIND_ICONS: Record<EvidenceCard['kind'], LucideIcon> = {
  logs: ScrollText,
  data: Database,
  repo: GitCommitHorizontal,
  metrics: TrendingUp,
};

/** What came of the last press. "Not connected" is an answer, not a failure (N5). */
type Outcome = { kind: 'not_connected'; title: string } | { kind: 'error'; message: string } | null;

/**
 * The one-click investigation buttons of a ticket and the results they pinned (T-203e, ADR-016).
 * Every button runs one saved, read-only check; the answer is a card with counts and a few lines
 * with personal data already replaced. Whoever holds `investigate.run` sees it (agent, lead, head,
 * dev); the ad-hoc routes are not here: they need `investigate.adhoc` and a screen of their own.
 */
export function InvestigatePanel({
  ticketKey,
  className,
}: {
  ticketKey: string;
  /** Replaces the default edge-to-edge look of the ticket panel (the dev screen is padded already). */
  className?: string;
}) {
  const { can } = useSession();
  if (!can('investigate.run')) return null;
  return <InvestigateBody ticketKey={ticketKey} className={className} />;
}

function InvestigateBody({
  ticketKey,
  className,
}: {
  ticketKey: string;
  className: string | undefined;
}) {
  const { t } = useI18n();
  const { can } = useSession();
  // A developer may run checks but not list a ticket's pinned cards (`ticket.read`): they see what they ran here.
  const canList = can('ticket.read');
  const [ranHere, setRanHere] = useState<EvidenceCard[]>([]);
  const tools = useTicketTools(ticketKey, true);
  const run = useRunTool(ticketKey);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const [asking, setAsking] = useState<string | null>(null);
  const headingId = useId();

  const press = (button: ToolButtonData, params: Record<string, string>) => {
    setOutcome(null);
    run.mutate(
      { templateId: button.templateId, ...(Object.keys(params).length > 0 ? { params } : {}) },
      {
        onSuccess: (card) => {
          setAsking(null);
          if (!canList) setRanHere((current) => [card, ...current]);
        },
        onError: (error) => {
          // Only the api's own code means "that system is not connected"; any other 503 is a failure.
          if (isApiError(error) && error.status === 503 && error.code === 'tool_not_connected') {
            setOutcome({ kind: 'not_connected', title: button.title });
          } else if (isApiError(error) && error.status === 429) {
            setOutcome({ kind: 'error', message: t('investigate.budget') });
          } else if (isApiError(error) && error.status === 403) {
            setOutcome({ kind: 'error', message: t('investigate.forbidden') });
          } else if (isApiError(error) && error.status === 400 && error.message) {
            setOutcome({
              kind: 'error',
              message: t('investigate.invalid', { message: error.message }),
            });
          } else {
            setOutcome({ kind: 'error', message: t('investigate.failed') });
          }
        },
      },
    );
  };

  const runningId = run.isPending ? run.variables.templateId : null;

  return (
    <section
      aria-labelledby={headingId}
      className={cn('flex flex-col gap-3', className ?? 'border-t border-border px-4 py-3')}
    >
      <div className="flex items-center gap-1.5">
        <Search aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <h3 id={headingId} className="text-sm font-semibold">
          {t('investigate.title')}
        </h3>
        <HelpHint label={t('investigate.helpLabel')}>{t('investigate.help')}</HelpHint>
      </div>

      {tools.isPending ? (
        <div role="status" aria-busy="true" className="flex gap-2">
          <span className="sr-only">{t('investigate.loading')}</span>
          <Skeleton className="h-8 w-24" />
          <Skeleton className="h-8 w-24" />
        </div>
      ) : tools.isError ? (
        <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          {t('investigate.loadError')}
          <Button
            onClick={() => {
              void tools.refetch();
            }}
          >
            {t('investigate.retry')}
          </Button>
        </p>
      ) : tools.data.buttons.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('investigate.noButtons')}</p>
      ) : (
        <ul aria-label={t('investigate.buttonsLabel')} className="flex flex-wrap gap-2">
          {tools.data.buttons.map((button) => (
            <li key={button.templateId} className="flex flex-col gap-1.5">
              <ToolButton
                button={button}
                running={runningId === button.templateId}
                busy={run.isPending}
                asking={asking === button.templateId}
                onPress={() => {
                  if (button.inputParams.length > 0) setAsking(button.templateId);
                  else press(button, {});
                }}
                onCancelAsk={() => {
                  setAsking(null);
                }}
                onSubmit={(params) => {
                  press(button, params);
                }}
              />
            </li>
          ))}
        </ul>
      )}

      <div role="status" aria-live="polite">
        {outcome?.kind === 'not_connected' ? (
          <p className="flex items-start gap-1.5 text-sm text-muted-foreground">
            <Unplug aria-hidden className="mt-0.5 size-4 shrink-0" />
            {t('investigate.notConnectedAnswer', { title: outcome.title })}
          </p>
        ) : outcome?.kind === 'error' ? (
          <p className="flex items-start gap-1.5 text-sm font-medium text-danger">
            <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
            {outcome.message}
          </p>
        ) : null}
      </div>

      <PinnedCards
        ticketKey={ticketKey}
        canList={canList}
        ranHere={ranHere}
        onUnpinned={(id) => {
          setRanHere((current) => current.filter((card) => card.id !== id));
        }}
      />
    </section>
  );
}

function MockChip() {
  const { t } = useI18n();
  return (
    <TintChip tone="amber" icon={FlaskConical} title={t('investigate.mockTip')}>
      {t('investigate.mock')}
    </TintChip>
  );
}

function ToolButton({
  button,
  running,
  busy,
  asking,
  onPress,
  onCancelAsk,
  onSubmit,
}: {
  button: ToolButtonData;
  running: boolean;
  busy: boolean;
  asking: boolean;
  onPress: () => void;
  onCancelAsk: () => void;
  onSubmit: (params: Record<string, string>) => void;
}) {
  const { t } = useI18n();
  const base = useId();
  const [values, setValues] = useState<Record<string, string>>({});
  const KindIcon = KIND_ICONS[button.kind];
  const ready = button.inputParams.every((name) => (values[name] ?? '').trim() !== '');

  return (
    <>
      <Tooltip
        content={
          button.connected ? t(`investigate.kind.${button.kind}`) : t('investigate.notConnectedTip')
        }
      >
        <Button
          onClick={onPress}
          disabled={!button.connected || busy}
          aria-busy={running || undefined}
          aria-expanded={button.inputParams.length > 0 ? asking : undefined}
        >
          {running ? (
            <LoaderCircle aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />
          ) : (
            <KindIcon aria-hidden className="size-4" />
          )}
          <span>{running ? t('investigate.running', { title: button.title }) : button.title}</span>
          {/* An unconnected system answers nothing, so it is not "mock" either: one label at a time. */}
          {button.mock && button.connected ? <MockChip /> : null}
          {button.connected ? null : (
            <TintChip tone="slate" icon={Unplug} title={t('investigate.notConnectedTip')}>
              {t('investigate.notConnected')}
            </TintChip>
          )}
        </Button>
      </Tooltip>
      {asking ? (
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (ready) onSubmit(values);
          }}
          className="flex flex-wrap items-center gap-1.5"
        >
          {button.inputParams.map((name) => (
            <Input
              key={name}
              id={`${base}-${name}`}
              aria-label={t('investigate.inputFor', { name })}
              placeholder={name}
              value={values[name] ?? ''}
              onChange={(event) => {
                setValues({ ...values, [name]: event.target.value });
              }}
              className="w-32"
              autoFocus={name === button.inputParams[0]}
            />
          ))}
          <Button type="submit" variant="primary" disabled={!ready || busy}>
            {t('investigate.runWithInput')}
          </Button>
          <IconButton
            label={t('investigate.cancel')}
            icon={<X aria-hidden className="size-4" />}
            onClick={onCancelAsk}
          />
        </form>
      ) : null}
    </>
  );
}

function PinnedCards({
  ticketKey,
  canList,
  ranHere,
  onUnpinned,
}: {
  ticketKey: string;
  canList: boolean;
  ranHere: readonly EvidenceCard[];
  onUnpinned: (id: string) => void;
}) {
  const { t } = useI18n();
  const cards = useTicketCards(ticketKey, canList);
  const items = canList ? (cards.data?.items ?? []) : ranHere;

  if (canList && cards.isPending) {
    return (
      <div role="status" aria-busy="true">
        <span className="sr-only">{t('investigate.loading')}</span>
        <Skeleton className="h-12 w-full" />
      </div>
    );
  }
  if (canList && cards.isError) {
    return <p className="text-sm text-muted-foreground">{t('investigate.evidence.loadError')}</p>;
  }
  if (items.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('investigate.evidence.empty')}</p>;
  }
  return (
    <div className="flex flex-col gap-1.5">
      <h4 className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Pin aria-hidden className="size-3.5" />
        {t('investigate.evidence.title')}
      </h4>
      <ul aria-label={t('investigate.evidence.label')} className="flex flex-col gap-2">
        {items.map((card) => (
          <li key={card.id}>
            <CardView ticketKey={ticketKey} card={card} onUnpinned={onUnpinned} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function CardView({
  ticketKey,
  card,
  onUnpinned,
}: {
  ticketKey: string;
  card: EvidenceCard;
  onUnpinned: (id: string) => void;
}) {
  const { t, locale } = useI18n();
  const unpin = useUnpinCard(ticketKey);
  const now = useNow();
  const KindIcon = KIND_ICONS[card.kind];
  return (
    <article className="flex flex-col gap-1 rounded-xl border border-border/60 p-2.5">
      <div className="flex items-start gap-2">
        <Tooltip content={t(`investigate.kind.${card.kind}`)}>
          <span
            className="mt-0.5 inline-flex shrink-0"
            role="img"
            aria-label={t(`investigate.kind.${card.kind}`)}
          >
            <KindIcon aria-hidden className="size-4 text-muted-foreground" />
          </span>
        </Tooltip>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium break-words">{card.title}</p>
          <p className="text-xs text-muted-foreground">
            {card.summary} · {formatRelative(card.createdAt, now, locale)}
          </p>
        </div>
        <IconButton
          label={t('investigate.evidence.unpinCard', { title: card.title })}
          tooltip={t('investigate.evidence.unpin')}
          icon={<PinOff aria-hidden className="size-4" />}
          disabled={unpin.isPending}
          onClick={() => {
            unpin.mutate(card.id, {
              onSuccess: () => {
                onUnpinned(card.id);
                toast(t('investigate.evidence.unpinned'));
              },
              onError: () => {
                toast.error(t('investigate.evidence.unpinFailed'));
              },
            });
          }}
        />
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {card.mock ? <MockChip /> : null}
        <TintChip tone="slate">
          {card.resultCount === 0
            ? t('investigate.evidence.zero')
            : t('investigate.evidence.count', { count: card.resultCount })}
        </TintChip>
        {card.truncated ? (
          <TintChip tone="amber" title={t('investigate.evidence.truncatedTip')}>
            {t('investigate.evidence.truncated')}
          </TintChip>
        ) : null}
        {card.maskedColumns.length > 0 ? (
          <TintChip
            tone="slate"
            title={t('investigate.evidence.maskedTip', { columns: card.maskedColumns.join(', ') })}
          >
            {t('investigate.evidence.masked', { count: card.maskedColumns.length })}
          </TintChip>
        ) : null}
      </div>
      {card.excerpt !== '' ? (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">
            {t('investigate.evidence.excerpt')}
          </summary>
          <pre
            aria-label={t('investigate.evidence.excerptLabel', { title: card.title })}
            tabIndex={0}
            className="mt-1 max-h-48 overflow-auto rounded-md bg-surface-muted p-2 font-mono text-xs break-words whitespace-pre-wrap"
          >
            {card.excerpt}
          </pre>
        </details>
      ) : null}
    </article>
  );
}
