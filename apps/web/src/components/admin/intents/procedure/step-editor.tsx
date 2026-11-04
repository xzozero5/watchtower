'use client';

import {
  DISCLOSURE_RULES,
  PROCEDURE_TOOL_NAMES,
  TICKET_PRIORITIES,
  type ProcedureStep,
  type ToolParams,
  type TicketPriority,
} from '@watchtower/shared';
import { Button, Input, Pill, Select, Textarea } from '@watchtower/ui';
import { ArrowDown, ArrowUp, Trash2 } from 'lucide-react';
import { useId } from 'react';

import { FormField } from '@/components/portal/form-field';
import { useT } from '@/i18n/provider';
import type { MessageKey } from '@/i18n';
import { STAGES, type StepKind } from '@/lib/admin/procedure-edit';

import { ConditionEditor, NumberField } from './condition-editor';

const KIND_KEYS: Record<StepKind, MessageKey> = {
  tool: 'procedure.kind.tool',
  check: 'procedure.kind.check',
  reply_guideline: 'procedure.kind.reply_guideline',
  disclosure: 'procedure.kind.disclosure',
  escalate: 'procedure.kind.escalate',
  require_human: 'procedure.kind.require_human',
};
const KIND_HINT_KEYS: Record<StepKind, MessageKey> = {
  tool: 'procedure.kindHint.tool',
  check: 'procedure.kindHint.check',
  reply_guideline: 'procedure.kindHint.reply_guideline',
  disclosure: 'procedure.kindHint.disclosure',
  escalate: 'procedure.kindHint.escalate',
  require_human: 'procedure.kindHint.require_human',
};
const RULE_KEYS: Record<(typeof DISCLOSURE_RULES)[number], MessageKey> = {
  never_mention: 'procedure.rule.never_mention',
  verified_only: 'procedure.rule.verified_only',
};

export const stepKindLabelKey = (kind: StepKind): MessageKey => KIND_KEYS[kind];

/** The value of an optional text field: empty means the field is not there (the schema refuses an empty string). */
const blankToUndefined = (value: string): string | undefined =>
  value.trim() === '' ? undefined : value;

export function StepEditor({
  step,
  index,
  count,
  earlier,
  problems,
  disabled,
  onChange,
  onMove,
  onRemove,
  onRename,
}: {
  step: ProcedureStep;
  index: number;
  count: number;
  /** Steps before this one: what a check may take evidence from. */
  earlier: readonly ProcedureStep[];
  /** Plain-words problems of this step (the api's checks and the schema's). */
  problems: readonly string[];
  disabled: boolean;
  onChange: (next: ProcedureStep) => void;
  onMove: (by: -1 | 1) => void;
  onRemove: () => void;
  onRename: (to: string) => void;
}) {
  const t = useT();
  const base = useId();
  const field = (name: string) => `${base}-${name}`;
  const evidenceChoices = earlier.filter((item) => item.kind === 'tool');

  const stages = (
    <fieldset className="flex flex-col gap-1">
      <legend className="text-sm font-medium">{t('procedure.field.stages')}</legend>
      <div className="flex flex-wrap items-center gap-3">
        {STAGES.map((stage) => (
          <label key={stage} className="flex items-center gap-1.5 text-sm">
            <input
              type="checkbox"
              className="size-4"
              disabled={disabled}
              checked={step.stages?.includes(stage) ?? false}
              onChange={(event) => {
                const current = step.stages ?? [];
                const next = event.target.checked
                  ? [...current, stage].sort()
                  : current.filter((value) => value !== stage);
                onChange({ ...step, stages: next.length > 0 ? next : undefined });
              }}
            />
            {t('procedure.field.stage', { n: stage })}
          </label>
        ))}
        {step.stages === undefined ? (
          <span className="text-sm text-muted-foreground">{t('procedure.field.stagesAll')}</span>
        ) : null}
      </div>
    </fieldset>
  );

  let body;
  switch (step.kind) {
    case 'tool':
      body = (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField id={field('tool')} label={t('procedure.field.tool')}>
              <Select
                id={field('tool')}
                value={step.tool}
                disabled={disabled}
                onChange={(event) => {
                  onChange({
                    ...step,
                    tool: event.target.value as (typeof PROCEDURE_TOOL_NAMES)[number],
                  });
                }}
              >
                {PROCEDURE_TOOL_NAMES.map((tool) => (
                  <option key={tool} value={tool}>
                    {tool}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField
              id={field('template')}
              label={t('procedure.field.template')}
              hint={t('procedure.field.templateHint')}
            >
              <Input
                id={field('template')}
                className="font-mono"
                value={step.template ?? ''}
                disabled={disabled}
                onChange={(event) => {
                  onChange({ ...step, template: blankToUndefined(event.target.value) });
                }}
              />
            </FormField>
          </div>
          <div className="flex flex-wrap gap-3">
            {(
              [
                ['limit', 'procedure.field.limit', 1, 20],
                ['windowMinutes', 'procedure.field.windowMinutes', 5, 1440],
                ['windowHours', 'procedure.field.windowHours', 1, 72],
              ] as const
            ).map(([key, label, min, max]) => (
              <FormField key={key} id={field(key)} label={t(label)}>
                <NumberField
                  id={field(key)}
                  label={t(label)}
                  value={step.params?.[key]}
                  min={min}
                  max={max}
                  step={1}
                  disabled={disabled}
                  onChange={(next) => {
                    const merged: Record<string, number | undefined> = {
                      ...step.params,
                      [key]: next,
                    };
                    const params = Object.fromEntries(
                      Object.entries(merged).filter(([, item]) => item !== undefined),
                    ) as ToolParams;
                    onChange({
                      ...step,
                      params: Object.keys(params).length > 0 ? params : undefined,
                    });
                  }}
                />
              </FormField>
            ))}
          </div>
          <ConditionEditor
            idBase={field('when')}
            value={step.when}
            required={false}
            disabled={disabled}
            onChange={(when) => {
              onChange({ ...step, when });
            }}
          />
          {stages}
        </>
      );
      break;
    case 'check':
      body = (
        <>
          <FormField id={field('question')} label={t('procedure.field.question')}>
            <Textarea
              id={field('question')}
              rows={2}
              value={step.question}
              disabled={disabled}
              onChange={(event) => {
                onChange({ ...step, question: event.target.value });
              }}
            />
          </FormField>
          <fieldset className="flex flex-col gap-1">
            <legend className="text-sm font-medium">{t('procedure.field.evidenceFrom')}</legend>
            {evidenceChoices.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('procedure.field.evidenceNone')}</p>
            ) : (
              <div className="flex flex-wrap gap-3">
                {evidenceChoices.map((choice) => (
                  <label key={choice.id} className="flex items-center gap-1.5 text-sm">
                    <input
                      type="checkbox"
                      className="size-4"
                      disabled={disabled}
                      checked={step.evidenceFrom.includes(choice.id)}
                      onChange={(event) => {
                        onChange({
                          ...step,
                          evidenceFrom: event.target.checked
                            ? [...step.evidenceFrom, choice.id]
                            : step.evidenceFrom.filter((id) => id !== choice.id),
                        });
                      }}
                    />
                    <span className="font-mono">{choice.id}</span>
                  </label>
                ))}
              </div>
            )}
          </fieldset>
          {stages}
        </>
      );
      break;
    case 'reply_guideline':
      body = (
        <>
          <FormField id={field('text')} label={t('procedure.field.text')}>
            <Textarea
              id={field('text')}
              rows={3}
              value={step.text}
              disabled={disabled}
              onChange={(event) => {
                onChange({ ...step, text: event.target.value });
              }}
            />
          </FormField>
          <FormField id={field('lang')} label={t('procedure.field.lang')}>
            <Select
              id={field('lang')}
              className="w-fit"
              value={step.lang ?? ''}
              disabled={disabled}
              onChange={(event) => {
                const lang = event.target.value;
                onChange({ ...step, lang: lang === 'th' || lang === 'en' ? lang : undefined });
              }}
            >
              <option value="">{t('procedure.field.langAny')}</option>
              <option value="th">TH</option>
              <option value="en">EN</option>
            </Select>
          </FormField>
          {stages}
        </>
      );
      break;
    case 'disclosure':
      body = (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField id={field('rule')} label={t('procedure.field.rule')}>
              <Select
                id={field('rule')}
                value={step.rule}
                disabled={disabled}
                onChange={(event) => {
                  onChange({
                    ...step,
                    rule: event.target.value as (typeof DISCLOSURE_RULES)[number],
                  });
                }}
              >
                {DISCLOSURE_RULES.map((rule) => (
                  <option key={rule} value={rule}>
                    {t(RULE_KEYS[rule])}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField id={field('topic')} label={t('procedure.field.topic')}>
              <Input
                id={field('topic')}
                value={step.topic}
                disabled={disabled}
                onChange={(event) => {
                  onChange({ ...step, topic: event.target.value });
                }}
              />
            </FormField>
          </div>
          {stages}
        </>
      );
      break;
    case 'escalate':
      body = (
        <>
          <ConditionEditor
            idBase={field('when')}
            value={step.when}
            required
            disabled={disabled}
            onChange={(when) => {
              if (when) onChange({ ...step, when });
            }}
          />
          <div className="grid gap-3 sm:grid-cols-3">
            <FormField id={field('to')} label={t('procedure.field.to')}>
              <Select
                id={field('to')}
                value={'queueKey' in step.to ? 'queue' : 'role'}
                disabled={disabled}
                onChange={(event) => {
                  onChange({
                    ...step,
                    to: event.target.value === 'queue' ? { queueKey: '' } : { role: 'lead' },
                  });
                }}
              >
                <option value="role">{t('procedure.field.toRole')}</option>
                <option value="queue">{t('procedure.field.toQueue')}</option>
              </Select>
            </FormField>
            {'queueKey' in step.to ? (
              <FormField id={field('queueKey')} label={t('procedure.field.queueKey')}>
                <Input
                  id={field('queueKey')}
                  className="font-mono"
                  value={step.to.queueKey}
                  disabled={disabled}
                  onChange={(event) => {
                    onChange({ ...step, to: { queueKey: event.target.value } });
                  }}
                />
              </FormField>
            ) : (
              <FormField id={field('role')} label={t('procedure.field.role')}>
                <Select
                  id={field('role')}
                  value={step.to.role}
                  disabled={disabled}
                  onChange={(event) => {
                    onChange({
                      ...step,
                      to: { role: event.target.value === 'head' ? 'head' : 'lead' },
                    });
                  }}
                >
                  <option value="lead">{t('procedure.role.lead')}</option>
                  <option value="head">{t('procedure.role.head')}</option>
                </Select>
              </FormField>
            )}
            <FormField id={field('priority')} label={t('procedure.field.priority')}>
              <Select
                id={field('priority')}
                value={step.priority ?? ''}
                disabled={disabled}
                onChange={(event) => {
                  const value = event.target.value;
                  onChange({
                    ...step,
                    priority: (TICKET_PRIORITIES as readonly string[]).includes(value)
                      ? (value as TicketPriority)
                      : undefined,
                  });
                }}
              >
                <option value="">{t('procedure.field.priorityKeep')}</option>
                {TICKET_PRIORITIES.map((priority) => (
                  <option key={priority} value={priority}>
                    {priority}
                  </option>
                ))}
              </Select>
            </FormField>
          </div>
          <FormField id={field('note')} label={t('procedure.field.note')}>
            <Textarea
              id={field('note')}
              rows={2}
              value={step.note}
              disabled={disabled}
              onChange={(event) => {
                onChange({ ...step, note: event.target.value });
              }}
            />
          </FormField>
          {stages}
        </>
      );
      break;
    case 'require_human':
      body = (
        <>
          <ConditionEditor
            idBase={field('when')}
            value={step.when}
            required
            disabled={disabled}
            onChange={(when) => {
              if (when) onChange({ ...step, when });
            }}
          />
          <FormField id={field('reason')} label={t('procedure.field.reason')}>
            <Input
              id={field('reason')}
              value={step.reason}
              disabled={disabled}
              onChange={(event) => {
                onChange({ ...step, reason: event.target.value });
              }}
            />
          </FormField>
          {stages}
        </>
      );
      break;
  }

  const stepNumber = index + 1;
  return (
    <li
      aria-labelledby={field('title')}
      data-step-id={step.id}
      className="flex flex-col gap-3 rounded-card border border-border bg-surface p-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h4 id={field('title')} className="text-sm font-medium">
            {t('procedure.steps.position', { n: stepNumber })} · {t(KIND_KEYS[step.kind])}
          </h4>
          <Pill className="font-mono">{step.id}</Pill>
        </div>
        {disabled ? null : (
          <div className="flex items-center gap-1">
            <Button
              size="sm"
              disabled={index === 0}
              aria-label={t('procedure.steps.moveUp', { n: stepNumber })}
              onClick={() => {
                onMove(-1);
              }}
            >
              <ArrowUp aria-hidden className="size-4" />
            </Button>
            <Button
              size="sm"
              disabled={index === count - 1}
              aria-label={t('procedure.steps.moveDown', { n: stepNumber })}
              onClick={() => {
                onMove(1);
              }}
            >
              <ArrowDown aria-hidden className="size-4" />
            </Button>
            <Button
              size="sm"
              aria-label={t('procedure.steps.remove', { n: stepNumber })}
              onClick={onRemove}
            >
              <Trash2 aria-hidden className="size-4" />
            </Button>
          </div>
        )}
      </div>
      <p className="text-xs text-muted-foreground">{t(KIND_HINT_KEYS[step.kind])}</p>
      {problems.length > 0 ? (
        <div role="alert" className="flex flex-col gap-0.5 text-sm font-medium text-danger">
          <span>{t('procedure.steps.issues')}</span>
          <ul className="list-disc pl-5 font-normal">
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <FormField
        id={field('id')}
        label={t('procedure.field.id')}
        hint={t('procedure.field.idHint')}
      >
        <Input
          id={field('id')}
          className="w-64 font-mono"
          value={step.id}
          disabled={disabled}
          onChange={(event) => {
            onRename(event.target.value);
          }}
        />
      </FormField>
      {body}
    </li>
  );
}
