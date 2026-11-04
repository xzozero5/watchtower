'use client';

import {
  CONDITION_FIELD_NAMES,
  CONDITION_FIELDS,
  TICKET_PRIORITIES,
  type Condition,
  type ConditionClause,
  type ConditionField,
} from '@watchtower/shared';
import { Button, Input, Select } from '@watchtower/ui';
import { Plus, X } from 'lucide-react';
import { useState } from 'react';

import { useT } from '@/i18n/provider';
import type { MessageKey } from '@/i18n';
import { defaultClause } from '@/lib/admin/procedure-edit';

const FIELD_KEYS: Record<ConditionField, MessageKey> = {
  'classifier.confidence': 'procedure.conditionField.classifier.confidence',
  'ticket.priority': 'procedure.conditionField.ticket.priority',
  'ticket.channel': 'procedure.conditionField.ticket.channel',
  'org.tier': 'procedure.conditionField.org.tier',
  'contact.verified': 'procedure.conditionField.contact.verified',
  'evidence.count': 'procedure.conditionField.evidence.count',
  'investigation.hasLikelyCause': 'procedure.conditionField.investigation.hasLikelyCause',
  'ticket.reopenCount': 'procedure.conditionField.ticket.reopenCount',
};
const OP_KEYS: Record<ConditionClause['op'], MessageKey> = {
  eq: 'procedure.op.eq',
  neq: 'procedure.op.neq',
  gte: 'procedure.op.gte',
  lte: 'procedure.op.lte',
  in: 'procedure.op.in',
};

type GroupKey = 'all' | 'any';

/** A number the person is typing: "0." stays "0." on screen while the value is 0. Empty means no value when optional. */
export function NumberField({
  id,
  label,
  value,
  onChange,
  min,
  max,
  step,
  disabled,
}: {
  id: string;
  label: string;
  value: number | undefined;
  onChange: (next: number | undefined) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
}) {
  const [text, setText] = useState(value === undefined ? '' : String(value));
  return (
    <Input
      id={id}
      aria-label={label}
      type="number"
      inputMode="decimal"
      value={text}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      className="w-28"
      onChange={(event) => {
        setText(event.target.value);
        const parsed = Number(event.target.value);
        onChange(event.target.value === '' || !Number.isFinite(parsed) ? undefined : parsed);
      }}
    />
  );
}

function ListField({
  id,
  label,
  value,
  onChange,
  disabled,
}: {
  id: string;
  label: string;
  value: readonly string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}) {
  const t = useT();
  const [text, setText] = useState(value.join(', '));
  return (
    <Input
      id={id}
      aria-label={label}
      placeholder={t('procedure.when.listHint')}
      value={text}
      disabled={disabled}
      onChange={(event) => {
        setText(event.target.value);
        onChange(
          event.target.value
            .split(',')
            .map((part) => part.trim())
            .filter((part) => part !== ''),
        );
      }}
    />
  );
}

function ClauseRow({
  idBase,
  number,
  clause,
  onChange,
  onRemove,
  canRemove,
  disabled,
}: {
  idBase: string;
  number: number;
  clause: ConditionClause;
  onChange: (next: ConditionClause) => void;
  onRemove: () => void;
  canRemove: boolean;
  disabled: boolean;
}) {
  const t = useT();
  const spec = CONDITION_FIELDS[clause.field];
  const isList = clause.op === 'in';
  const list = Array.isArray(clause.value) ? clause.value : [String(clause.value)];

  const setOp = (op: ConditionClause['op']) => {
    if (op === 'in' && !Array.isArray(clause.value)) onChange({ ...clause, op, value: list });
    else if (op !== 'in' && Array.isArray(clause.value)) {
      onChange({ ...clause, op, value: clause.value[0] ?? defaultClause(clause.field).value });
    } else onChange({ ...clause, op });
  };

  return (
    <li className="flex flex-wrap items-end gap-2">
      <Select
        className="min-w-48"
        aria-label={`${t('procedure.when.field')} ${String(number)}`}
        value={clause.field}
        disabled={disabled}
        onChange={(event) => {
          onChange(defaultClause(event.target.value as ConditionField));
        }}
      >
        {CONDITION_FIELD_NAMES.map((field) => (
          <option key={field} value={field}>
            {t(FIELD_KEYS[field])}
          </option>
        ))}
      </Select>
      <Select
        aria-label={`${t('procedure.when.op')} ${String(number)}`}
        value={clause.op}
        disabled={disabled}
        onChange={(event) => {
          setOp(event.target.value as ConditionClause['op']);
        }}
      >
        {(spec.ops as readonly ConditionClause['op'][]).map((op) => (
          <option key={op} value={op}>
            {t(OP_KEYS[op])}
          </option>
        ))}
      </Select>
      {isList ? (
        <ListField
          id={`${idBase}-value`}
          label={`${t('procedure.when.value')} ${String(number)}`}
          value={list}
          disabled={disabled}
          onChange={(next) => {
            onChange({ ...clause, value: next.length > 0 ? next : [''] });
          }}
        />
      ) : spec.kind === 'boolean' ? (
        <Select
          aria-label={`${t('procedure.when.value')} ${String(number)}`}
          value={clause.value === true ? 'yes' : 'no'}
          disabled={disabled}
          onChange={(event) => {
            onChange({ ...clause, value: event.target.value === 'yes' });
          }}
        >
          <option value="yes">{t('procedure.when.yes')}</option>
          <option value="no">{t('procedure.when.no')}</option>
        </Select>
      ) : spec.kind === 'priority' ? (
        <Select
          aria-label={`${t('procedure.when.value')} ${String(number)}`}
          value={String(clause.value)}
          disabled={disabled}
          onChange={(event) => {
            onChange({ ...clause, value: event.target.value });
          }}
        >
          {TICKET_PRIORITIES.map((priority) => (
            <option key={priority} value={priority}>
              {priority}
            </option>
          ))}
        </Select>
      ) : spec.kind === 'number' || spec.kind === 'integer' ? (
        <NumberField
          id={`${idBase}-value`}
          label={`${t('procedure.when.value')} ${String(number)}`}
          value={typeof clause.value === 'number' ? clause.value : 0}
          min={0}
          max={spec.kind === 'number' ? 1 : 1000}
          step={spec.kind === 'number' ? 0.05 : 1}
          disabled={disabled}
          onChange={(next) => {
            onChange({ ...clause, value: next ?? 0 });
          }}
        />
      ) : (
        <Input
          aria-label={`${t('procedure.when.value')} ${String(number)}`}
          value={typeof clause.value === 'string' ? clause.value : ''}
          disabled={disabled}
          onChange={(event) => {
            onChange({ ...clause, value: event.target.value });
          }}
        />
      )}
      <Button
        size="sm"
        onClick={onRemove}
        disabled={disabled || !canRemove}
        aria-label={t('procedure.when.remove', { n: number })}
      >
        <X aria-hidden className="size-4" />
      </Button>
    </li>
  );
}

/**
 * The `when` of a step as a form (ADR-026 section 2): groups of conditions, each a field, a comparison and a value.
 * Never an expression string. `required` steps (escalate, require a person) always keep one condition.
 */
export function ConditionEditor({
  idBase,
  value,
  onChange,
  required,
  disabled,
}: {
  idBase: string;
  value: Condition | undefined;
  onChange: (next: Condition | undefined) => void;
  required: boolean;
  disabled: boolean;
}) {
  const t = useT();
  const groups = (['all', 'any'] as const).filter((key) => value?.[key] !== undefined);
  const total = groups.reduce((sum, key) => sum + (value?.[key]?.length ?? 0), 0);

  const setGroup = (key: GroupKey, clauses: ConditionClause[]) => {
    const rest: Condition = { ...value };
    if (key === 'all') rest.all = undefined;
    else rest.any = undefined;
    const next: Condition = clauses.length > 0 ? { ...rest, [key]: clauses } : rest;
    onChange(next.all === undefined && next.any === undefined ? undefined : next);
  };

  /** One group is relabelled all/any as a whole: the clauses stay. */
  const switchGroup = (from: GroupKey, to: GroupKey) => {
    if (from === to || !value) return;
    const clauses = value[from] ?? [];
    const next: Condition = { [to]: clauses };
    onChange(next);
  };

  if (groups.length === 0) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">
          {t('procedure.when.title')}: {t('procedure.when.always')}
        </span>
        <Button
          size="sm"
          disabled={disabled}
          onClick={() => {
            onChange({ all: [defaultClause('ticket.priority')] });
          }}
        >
          <Plus aria-hidden className="size-4" />
          {t('procedure.when.add')}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {groups.map((key) => {
        const clauses = value?.[key] ?? [];
        return (
          <fieldset key={key} className="flex flex-col gap-2 rounded-md border border-border p-2">
            <legend className="px-1 text-sm font-medium">{t('procedure.when.title')}</legend>
            {groups.length === 1 ? (
              <Select
                className="w-fit"
                aria-label={t('procedure.when.group')}
                value={key}
                disabled={disabled}
                onChange={(event) => {
                  switchGroup(key, event.target.value as GroupKey);
                }}
              >
                <option value="all">{t('procedure.when.all')}</option>
                <option value="any">{t('procedure.when.any')}</option>
              </Select>
            ) : (
              <span className="text-sm text-muted-foreground">
                {key === 'all' ? t('procedure.when.all') : t('procedure.when.any')}
              </span>
            )}
            <ul className="flex flex-col gap-2">
              {clauses.map((clause, index) => (
                <ClauseRow
                  key={`${key}-${String(index)}`}
                  idBase={`${idBase}-${key}-${String(index)}`}
                  number={index + 1}
                  clause={clause}
                  disabled={disabled}
                  canRemove={!(required && total === 1)}
                  onChange={(next) => {
                    setGroup(
                      key,
                      clauses.map((item, at) => (at === index ? next : item)),
                    );
                  }}
                  onRemove={() => {
                    setGroup(
                      key,
                      clauses.filter((_, at) => at !== index),
                    );
                  }}
                />
              ))}
            </ul>
            {clauses.length < 8 ? (
              <div>
                <Button
                  size="sm"
                  disabled={disabled}
                  onClick={() => {
                    setGroup(key, [...clauses, defaultClause('ticket.priority')]);
                  }}
                >
                  <Plus aria-hidden className="size-4" />
                  {t('procedure.when.add')}
                </Button>
              </div>
            ) : null}
          </fieldset>
        );
      })}
    </div>
  );
}
