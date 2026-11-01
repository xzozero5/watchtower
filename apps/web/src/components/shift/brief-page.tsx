'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { HandoffItem, ShiftBrief, ShiftNote } from '@watchtower/shared';
import { Button, TintChip, toast } from '@watchtower/ui';
import {
  AlarmClockOff,
  Bot,
  CircleAlert,
  ClipboardList,
  Eye,
  Hourglass,
  ListChecks,
  Repeat,
  Rocket,
  RefreshCw,
  Siren,
  StickyNote,
  Ticket,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import type { ReactNode } from 'react';

import { LoadError, RequirePermission } from '@/components/admin/admin-page';
import { AckList } from '@/components/shift/ack-list';
import {
  EmptyLine,
  PriorityBadge,
  ShiftSection,
  ShiftSkeleton,
  TicketLink,
  useShiftFormat,
} from '@/components/shift/shift-bits';
import { useI18n } from '@/i18n/provider';
import { useApi } from '@/lib/api/api-context';
import { useUserId } from '@/lib/auth/session';
import { describeShiftError, slaLeftText } from '@/lib/shifts/model';
import { shiftKeys, useShiftBrief } from '@/lib/shifts/queries';

export function BriefPage() {
  return (
    <RequirePermission permission="shift.clock" role="lead">
      <BriefBody />
    </RequirePermission>
  );
}

function BriefBody() {
  const { t } = useI18n();
  const brief = useShiftBrief();
  if (brief.isPending) return <ShiftSkeleton rows={6} />;
  if (brief.isError) {
    return <LoadError message={t('shift.common.loadError')} onRetry={() => void brief.refetch()} />;
  }
  return <BriefView brief={brief.data} onRefresh={() => void brief.refetch()} />;
}

function BriefView({ brief, onRefresh }: { brief: ShiftBrief; onRefresh: () => void }) {
  const { t } = useI18n();
  const api = useApi();
  const router = useRouter();
  const userId = useUserId();
  const queryClient = useQueryClient();
  const format = useShiftFormat(brief.timezone);
  const session = brief.session;
  const open = session !== null && session.clockedOutAt === null;

  const markRead = useMutation({
    mutationFn: () => api.markBriefRead(),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: shiftKeys(userId).all });
      toast(t('shift.brief.markedRead'));
      router.push('/');
    },
    onError: (error) => {
      toast(describeShiftError(error, t).message);
    },
  });

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold">{t('shift.brief.title')}</h2>
          <p className="text-xs text-muted-foreground">
            {t('shift.brief.generated', { time: format.time(brief.generatedAt) })}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={onRefresh}>
            <RefreshCw aria-hidden className="size-4" />
            {t('shift.brief.refresh')}
          </Button>
          {open && session.briefReadAt === null ? (
            <Button
              variant="primary"
              disabled={markRead.isPending}
              onClick={() => {
                markRead.mutate();
              }}
            >
              {markRead.isPending ? t('shift.common.saving') : t('shift.brief.markRead')}
            </Button>
          ) : null}
        </div>
      </div>
      {!open ? (
        <p className="text-sm text-muted-foreground">{t('shift.brief.needClockIn')}</p>
      ) : session.briefReadAt !== null ? (
        <p className="text-sm text-muted-foreground">
          {t('shift.brief.alreadyRead', { time: format.time(session.briefReadAt) })}
        </p>
      ) : null}

      {brief.aiSummary ? (
        <section aria-labelledby="brief-ai-heading" className="flex flex-col gap-1">
          <h2 id="brief-ai-heading" className="flex items-center gap-2 text-sm font-semibold">
            <TintChip tone="violet" icon={Bot}>
              {t('shift.brief.aiChip')}
            </TintChip>
            {t('shift.brief.aiHeading')}
          </h2>
          <p className="text-sm">{brief.aiSummary.text}</p>
          <p className="text-xs text-muted-foreground">
            {t('shift.brief.aiMeta', {
              at: format.time(brief.aiSummary.generatedAt),
              dataAsOf: format.time(brief.aiSummary.dataAsOf),
            })}
          </p>
        </section>
      ) : null}

      <ShiftSection
        id="brief-handoff"
        title={t('shift.brief.sections.handoff')}
        count={brief.handoff.total - brief.handoff.acknowledged}
        tone="indigo"
        icon={ClipboardList}
      >
        <AckList data={brief.handoff} timezone={brief.timezone} />
      </ShiftSection>

      <ItemSection
        id="brief-incidents"
        title={t('shift.brief.sections.incidents')}
        empty={t('shift.brief.emptyLine.incidents')}
        items={brief.incidents}
        tone="red"
        icon={Siren}
        format={format.dateTime}
      />

      <ShiftSection
        id="brief-my-tickets"
        title={t('shift.brief.sections.myTickets')}
        count={brief.myTickets.length}
        tone="sky"
        icon={Ticket}
      >
        {brief.myTickets.length === 0 ? (
          <EmptyLine>{t('shift.brief.emptyLine.myTickets')}</EmptyLine>
        ) : (
          <TicketList tickets={brief.myTickets} />
        )}
      </ShiftSection>

      <ShiftSection
        id="brief-carried"
        title={t('shift.brief.sections.carried')}
        count={brief.carriedOver.length}
        tone="amber"
        icon={Repeat}
      >
        {brief.carriedOver.length === 0 ? (
          <EmptyLine>{t('shift.brief.emptyLine.carried')}</EmptyLine>
        ) : (
          <TicketList tickets={brief.carriedOver} />
        )}
      </ShiftSection>

      <ItemSection
        id="brief-snoozed"
        title={t('shift.brief.sections.snoozed')}
        empty={t('shift.brief.emptyLine.snoozed')}
        items={brief.snoozedAlerts}
        tone="slate"
        icon={AlarmClockOff}
        format={format.dateTime}
        expiry
      />
      <ItemSection
        id="brief-deploys"
        title={t('shift.brief.sections.deploys')}
        empty={t('shift.brief.emptyLine.deploys')}
        items={brief.deploys}
        tone="teal"
        icon={Rocket}
        format={format.dateTime}
      />
      <ItemSection
        id="brief-watch"
        title={t('shift.brief.sections.watch')}
        empty={t('shift.brief.emptyLine.watch')}
        items={brief.watchItems}
        tone="pink"
        icon={Eye}
        format={format.dateTime}
      />

      <ShiftSection
        id="brief-kb"
        title={t('shift.brief.sections.kb')}
        tone="violet"
        icon={ListChecks}
      >
        <EmptyLine>{t('shift.brief.emptyLine.kb')}</EmptyLine>
      </ShiftSection>

      <ShiftSection
        id="brief-notes"
        title={t('shift.brief.sections.notes')}
        count={brief.notes.length}
        tone="green"
        icon={StickyNote}
      >
        {brief.notes.length === 0 ? (
          <EmptyLine>{t('shift.brief.emptyLine.notes')}</EmptyLine>
        ) : (
          <ul className="flex flex-col gap-2">
            {brief.notes.map((note) => (
              <NoteRow key={note.id} note={note} />
            ))}
          </ul>
        )}
      </ShiftSection>
    </>
  );
}

function ItemSection({
  id,
  title,
  empty,
  items,
  tone,
  icon,
  format,
  expiry = false,
}: {
  id: string;
  title: string;
  empty: string;
  items: readonly HandoffItem[];
  tone: Parameters<typeof ShiftSection>[0]['tone'];
  icon: Parameters<typeof ShiftSection>[0]['icon'];
  format: (iso: string) => string;
  /** The due time is an expiry ("until 17:00"), as for a snoozed alert. */
  expiry?: boolean;
}) {
  const { t } = useI18n();
  return (
    <ShiftSection id={id} title={title} count={items.length} tone={tone} icon={icon}>
      {items.length === 0 ? (
        <EmptyLine>{empty}</EmptyLine>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((item) => (
            <li key={item.id} className="rounded-lg border border-border px-3 py-2 text-sm">
              <p className="font-medium">
                {item.severity ? <span className="mr-2 text-xs">{item.severity}</span> : null}
                {item.title}
              </p>
              {item.nextAction ? (
                <p className="text-muted-foreground">
                  {t('shift.brief.next', { action: item.nextAction })}
                </p>
              ) : null}
              {item.dueAt ? (
                <p className="text-muted-foreground">
                  {expiry
                    ? t('shift.brief.expires', { at: format(item.dueAt) })
                    : t('shift.brief.due', { at: format(item.dueAt) })}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </ShiftSection>
  );
}

type BriefTicket = ShiftBrief['myTickets'][number] & { crossedShifts?: number };

/** SLA state in words and an icon, with the minutes the server counted on the policy's calendar. */
function SlaText({ ticket }: { ticket: BriefTicket }) {
  const { t } = useI18n();
  if (ticket.slaState === null) {
    return <span className="text-muted-foreground">{t('shift.brief.slaNone')}</span>;
  }
  const left = slaLeftText(ticket.slaMinutesLeft);
  const label =
    ticket.slaState === 'breached'
      ? t('shift.brief.slaBreached')
      : ticket.slaState === 'paused'
        ? t('shift.brief.slaPaused')
        : ticket.slaState === 'at_risk'
          ? t('shift.brief.slaAtRisk')
          : t('shift.brief.slaOk');
  const Icon = ticket.slaState === 'breached' ? CircleAlert : Hourglass;
  return (
    <span data-sla={ticket.slaState} className="inline-flex items-center gap-1">
      <Icon aria-hidden className="size-3.5" />
      {label}
      {left !== null && ticket.slaState !== 'breached' ? (
        <span className="tabular text-muted-foreground">
          · {t('shift.brief.slaLeft', { time: left })}
        </span>
      ) : null}
    </span>
  );
}

function TicketList({ tickets }: { tickets: readonly BriefTicket[] }) {
  const { t } = useI18n();
  return (
    <ul className="flex flex-col gap-2">
      {tickets.map((ticket) => (
        <li
          key={ticket.id}
          className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border px-3 py-2 text-sm"
        >
          <TicketLink ticketKey={ticket.key} />
          <PriorityBadge priority={ticket.priority} />
          <span className="min-w-0 flex-1 truncate">{ticket.subject}</span>
          {ticket.crossedShifts !== undefined ? (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <Repeat aria-hidden className="size-3.5" />
              {ticket.crossedShifts === 1
                ? t('shift.brief.crossedOne')
                : t('shift.brief.crossed', { count: ticket.crossedShifts })}
            </span>
          ) : null}
          <SlaText ticket={ticket} />
        </li>
      ))}
    </ul>
  );
}

function NoteRow({ note }: { note: ShiftNote }): ReactNode {
  const { t } = useI18n();
  const api = useApi();
  const userId = useUserId();
  const queryClient = useQueryClient();
  const format = useShiftFormat(undefined);
  const read = useMutation({
    mutationFn: () => api.markShiftNoteRead(note.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: shiftKeys(userId).all });
    },
    onError: () => {
      toast(t('shift.notes.markFailed'));
    },
  });
  return (
    <li className="flex flex-wrap items-start justify-between gap-2 rounded-lg border border-border px-3 py-2 text-sm">
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground">
          {t('shift.notes.from', { name: note.author.name })} · {format.dateTime(note.createdAt)}
        </p>
        <p className="whitespace-pre-wrap">{note.body}</p>
      </div>
      <Button
        size="sm"
        disabled={read.isPending}
        onClick={() => {
          read.mutate();
        }}
      >
        {t('shift.notes.markRead')}
      </Button>
    </li>
  );
}
