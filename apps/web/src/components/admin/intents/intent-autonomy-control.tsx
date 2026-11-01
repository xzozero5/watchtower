'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { AutonomyIntent, SetIntentAutonomy } from '@watchtower/shared';
import {
  AUTONOMY_STAGES,
  type AutonomyStage,
  Button,
  SegmentedControl,
  StageBadge,
  Textarea,
  toast,
} from '@watchtower/ui';
import { CircleX, Lock } from 'lucide-react';
import { useId, useState } from 'react';

import { useI18n } from '@/i18n/provider';
import { describeError } from '@/lib/admin/errors';
import { adminKeys } from '@/lib/admin/queries';
import { asStage, STAGE_HINT_KEYS, STAGE_LABEL_KEYS } from '@/lib/admin/stages';
import { isApiError } from '@/lib/api/errors';
import { useApi } from '@/lib/api/api-context';
import { useUserId } from '@/lib/auth/session';
import { formatDateTime } from '@/lib/format';

const REASON_MIN = 3;
const REASON_MAX = 500;

export interface PinnedBy {
  name: string | null;
  at: string;
}

/**
 * Stage and pin of one intent (docs/06-UI-SPEC.md section 18.3.1). Exactly three stages are
 * offered; stage 3 and above is never drawn, not even disabled (N3). Nothing is saved until a
 * reason of 3 to 500 characters is given and the button is pressed. A pinned intent, or a stage
 * limit that only allows going down, shows why as text.
 */
export function IntentAutonomyControl({
  intent,
  capOn,
  canChange,
  canPin,
  pinnedBy,
}: {
  intent: AutonomyIntent;
  capOn: boolean;
  /** `ai.autonomy.set`: lead and head. */
  canChange: boolean;
  /** `ai.autonomy.set.any`: the head. */
  canPin: boolean;
  pinnedBy?: PinnedBy | null;
}) {
  const { t, locale } = useI18n();
  const api = useApi();
  const userId = useUserId();
  const queryClient = useQueryClient();
  const baseId = useId();
  const current = asStage(intent.stage);
  const [selected, setSelected] = useState<AutonomyStage>(current);
  const [stageReason, setStageReason] = useState('');
  const [pinWanted, setPinWanted] = useState(intent.pinned);
  const [pinReason, setPinReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [ownerOnly, setOwnerOnly] = useState(false);

  const stageChanged = selected !== current;
  const pinChanged = pinWanted !== intent.pinned;
  const locked = !canChange || intent.pinned;

  const save = useMutation({
    mutationFn: (body: SetIntentAutonomy) => api.setIntentAutonomy(intent.id, body),
    onSuccess: (result, body) => {
      void queryClient.invalidateQueries({ queryKey: adminKeys(userId).autonomy });
      void queryClient.invalidateQueries({ queryKey: adminKeys(userId).intentHistory(intent.id) });
      void queryClient.invalidateQueries({ queryKey: adminKeys(userId).auditAll });
      setStageReason('');
      setPinReason('');
      setError(null);
      setOwnerOnly(false);
      if (!result.changed) {
        toast(t('admin.intents.noChange'));
      } else if (body.stage !== undefined) {
        toast(
          t('admin.intents.stageChanged', {
            stage: t(STAGE_LABEL_KEYS[asStage(result.intent.stage)]),
          }),
        );
      } else {
        toast(t(body.pinned ? 'admin.intents.pinnedToast' : 'admin.intents.unpinnedToast'));
      }
      setSelected(asStage(result.intent.stage));
      setPinWanted(result.intent.pinned);
    },
    onError: (failure) => {
      setOwnerOnly(isApiError(failure) && failure.code === 'autonomy_stage_requires_owner');
      setError(describeError(failure, t).message);
    },
  });

  const valid = (reason: string) =>
    reason.trim().length >= REASON_MIN && reason.trim().length <= REASON_MAX;
  const stageId = `${baseId}-stage-reason`;
  const pinId = `${baseId}-pin-reason`;

  const options = AUTONOMY_STAGES.map((stage) => ({
    value: String(stage),
    label: t(STAGE_LABEL_KEYS[stage]),
    // The limit switch only lets a stage go down.
    disabled: locked || (capOn && stage > current),
  }));

  return (
    <div className="flex max-w-xl flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <StageBadge
          stage={current}
          label={t(STAGE_LABEL_KEYS[current])}
          title={t(STAGE_HINT_KEYS[current])}
        />
        {intent.pinned ? (
          <span className="inline-flex items-center gap-1 text-sm">
            <Lock aria-hidden className="size-3.5" />
            {t('admin.intents.pinned')}
          </span>
        ) : null}
      </div>

      <div className="flex flex-col gap-2">
        <SegmentedControl
          aria-label={t('admin.intents.stage')}
          value={String(selected)}
          options={options}
          onValueChange={(value) => {
            setSelected(asStage(Number(value)));
            setError(null);
          }}
        />
        {intent.pinned ? (
          <p className="text-sm text-muted-foreground">
            {pinnedBy
              ? t('admin.intents.pinnedBy', {
                  name: pinnedBy.name ?? '—',
                  date: formatDateTime(pinnedBy.at, locale),
                })
              : t('admin.intents.pinnedNote')}
          </p>
        ) : capOn ? (
          <p className="text-sm text-muted-foreground">{t('admin.intents.capOn')}</p>
        ) : null}
      </div>

      {stageChanged && !locked ? (
        <div className="flex flex-col gap-1">
          <label htmlFor={stageId} className="text-sm font-medium">
            {t('admin.intents.stageReason')}
          </label>
          <Textarea
            id={stageId}
            rows={2}
            value={stageReason}
            onChange={(event) => {
              setStageReason(event.target.value);
            }}
            className="w-full"
          />
          <div>
            <Button
              variant="primary"
              disabled={save.isPending || !valid(stageReason)}
              onClick={() => {
                setError(null);
                save.mutate({ stage: selected, reason: stageReason.trim() });
              }}
            >
              {save.isPending ? t('admin.form.saving') : t('admin.intents.changeStage')}
            </Button>
          </div>
        </div>
      ) : null}

      <div className="flex flex-col gap-2 border-t border-border pt-3">
        {canPin ? (
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={pinWanted}
              onChange={(event) => {
                setPinWanted(event.target.checked);
                setError(null);
              }}
              className="mt-0.5 size-4"
            />
            <span>{t('admin.intents.pin')}</span>
          </label>
        ) : (
          <p className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
            <Lock aria-hidden className="size-3.5" />
            {intent.pinned ? t('admin.intents.pinned') : t('admin.intents.notPinned')}
          </p>
        )}
        {canPin && pinChanged ? (
          <div className="flex flex-col gap-1">
            <label htmlFor={pinId} className="text-sm font-medium">
              {t('admin.intents.stageReason')}
            </label>
            <Textarea
              id={pinId}
              rows={2}
              value={pinReason}
              onChange={(event) => {
                setPinReason(event.target.value);
              }}
              className="w-full"
            />
            <div>
              <Button
                variant="primary"
                disabled={save.isPending || !valid(pinReason)}
                onClick={() => {
                  setError(null);
                  save.mutate({ pinned: pinWanted, reason: pinReason.trim() });
                }}
              >
                {save.isPending
                  ? t('admin.form.saving')
                  : pinWanted
                    ? t('admin.intents.pinApply')
                    : t('admin.intents.unpinApply')}
              </Button>
            </div>
          </div>
        ) : null}
      </div>

      {error ? (
        <p role="alert" className="flex items-start gap-1.5 text-sm font-medium text-danger">
          <CircleX aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>{ownerOnly ? t('admin.intents.ownerOnly') : error}</span>
        </p>
      ) : null}

      <p className="text-sm text-muted-foreground">{t('admin.intents.ownerOnly')}</p>
    </div>
  );
}
