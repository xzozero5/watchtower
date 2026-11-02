'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { DEFAULT_ORG_TIER, type OrgTierRecord, orgTierSchema } from '@watchtower/shared';
import {
  Button,
  HelpHint,
  IconButton,
  Input,
  Pill,
  Sheet,
  SheetContent,
  Skeleton,
  toast,
} from '@watchtower/ui';
import { Check, CircleX, Pencil, Plus, Trash2, X } from 'lucide-react';
import { useId, useState } from 'react';

import { ConfirmDialog } from '@/components/admin/confirm-dialog';
import { useT } from '@/i18n/provider';
import { describeError } from '@/lib/admin/errors';
import { adminKeys, useOrgTiers } from '@/lib/admin/queries';
import { useApi } from '@/lib/api/api-context';
import { useUserId } from '@/lib/auth/session';

const DEFAULT_SORT_ORDER = 100;

/**
 * The tiers an organization or an SLA policy can name (T-121b, `sla.manage`): add, rename, reorder
 * and delete, in the right-hand sheet. The api refuses to delete a tier that is still named and to
 * rename the default one; its sentence is shown as it is.
 */
export function TiersSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const api = useApi();
  const userId = useUserId();
  const queryClient = useQueryClient();
  const base = useId();
  const tiers = useOrgTiers(open);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState({ slug: '', name: '', sortOrder: '' });
  const [toDelete, setToDelete] = useState<OrgTierRecord | null>(null);
  const [newTier, setNewTier] = useState({
    slug: '',
    name: '',
    sortOrder: String(DEFAULT_SORT_ORDER),
  });
  const [error, setError] = useState<string | null>(null);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: adminKeys(userId).orgTiers });
    // A renamed tier moves every organization that names it.
    void queryClient.invalidateQueries({ queryKey: adminKeys(userId).orgs });
    void queryClient.invalidateQueries({ queryKey: [...adminKeys(userId).all, 'org'] });
  };

  const create = useMutation({
    mutationFn: (slug: string) =>
      api.createOrgTier({
        slug,
        name: newTier.name.trim(),
        sortOrder: Number(newTier.sortOrder) || DEFAULT_SORT_ORDER,
      }),
    onSuccess: () => {
      refresh();
      setNewTier({ slug: '', name: '', sortOrder: String(DEFAULT_SORT_ORDER) });
      setError(null);
      toast(t('admin.orgs.tiers.added'));
    },
    onError: (failure) => {
      setError(describeError(failure, t).message);
    },
  });

  const update = useMutation({
    mutationFn: (tier: OrgTierRecord) => {
      const isDefault = tier.slug === DEFAULT_ORG_TIER;
      const slug = draft.slug.trim();
      return api.updateOrgTier(tier.slug, {
        name: draft.name.trim(),
        sortOrder: Number(draft.sortOrder),
        ...(!isDefault && slug !== tier.slug ? { slug } : {}),
      });
    },
    onSuccess: () => {
      refresh();
      setEditing(null);
      setError(null);
      toast(t('admin.common.saved'));
    },
    onError: (failure) => {
      setError(describeError(failure, t).message);
    },
  });

  const remove = useMutation({
    mutationFn: (tier: OrgTierRecord) => api.deleteOrgTier(tier.slug),
    onSuccess: () => {
      refresh();
      setToDelete(null);
      setError(null);
      toast(t('admin.common.deleted'));
    },
    onError: (failure) => {
      setError(describeError(failure, t).message);
    },
  });

  const startEdit = (tier: OrgTierRecord) => {
    setError(null);
    setEditing(tier.slug);
    setDraft({ slug: tier.slug, name: tier.name, sortOrder: String(tier.sortOrder) });
  };

  return (
    <>
      <Sheet
        open={open}
        onOpenChange={(next) => {
          if (!next) onClose();
        }}
      >
        <SheetContent
          title={t('admin.orgs.tiers.title')}
          description={t('admin.orgs.tiers.description')}
          closeLabel={t('admin.common.close')}
          footer={<Button onClick={onClose}>{t('admin.common.close')}</Button>}
        >
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-1">
              <HelpHint label={t('admin.orgs.tiers.helpLabel')}>
                {t('admin.orgs.tiers.help')}
              </HelpHint>
            </div>
            {error && toDelete === null ? (
              <p
                role="alert"
                className="flex items-start gap-1.5 rounded-md border border-border-strong px-3 py-2 text-sm"
              >
                <CircleX aria-hidden className="mt-0.5 size-4 shrink-0 text-danger" />
                <span>{error}</span>
              </p>
            ) : null}
            {tiers.isPending ? (
              <div role="status" aria-busy="true" className="flex flex-col gap-1.5">
                <span className="sr-only">{t('admin.common.loading')}</span>
                <Skeleton className="h-9" />
                <Skeleton className="h-9" />
              </div>
            ) : tiers.isError ? (
              <p className="text-sm text-muted-foreground">{t('admin.common.loadError')}</p>
            ) : (
              <ul aria-label={t('admin.orgs.tiers.list')} className="flex flex-col gap-1.5">
                {tiers.data.tiers.map((tier) => {
                  const isDefault = tier.slug === DEFAULT_ORG_TIER;
                  return (
                    <li
                      key={tier.slug}
                      className="flex items-center gap-2 rounded-lg border border-border/60 px-2.5 py-1.5"
                    >
                      {editing === tier.slug ? (
                        <form
                          noValidate
                          onSubmit={(event) => {
                            event.preventDefault();
                            update.mutate(tier);
                          }}
                          className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5"
                        >
                          <Input
                            aria-label={t('admin.orgs.tiers.name')}
                            value={draft.name}
                            onChange={(event) => {
                              setDraft({ ...draft, name: event.target.value });
                            }}
                            className="min-w-0 flex-1"
                          />
                          <Input
                            aria-label={t('admin.orgs.tiers.slug')}
                            value={draft.slug}
                            disabled={isDefault}
                            onChange={(event) => {
                              setDraft({ ...draft, slug: event.target.value });
                            }}
                            className="w-24 font-mono"
                          />
                          <Input
                            type="number"
                            aria-label={t('admin.orgs.tiers.order')}
                            value={draft.sortOrder}
                            onChange={(event) => {
                              setDraft({ ...draft, sortOrder: event.target.value });
                            }}
                            className="w-20"
                          />
                          <IconButton
                            type="submit"
                            label={t('admin.orgs.tiers.save', { name: tier.name })}
                            icon={<Check aria-hidden className="size-4" />}
                            disabled={update.isPending}
                          />
                          <IconButton
                            label={t('admin.orgs.tiers.cancel', { name: tier.name })}
                            icon={<X aria-hidden className="size-4" />}
                            onClick={() => {
                              setEditing(null);
                              setError(null);
                            }}
                          />
                        </form>
                      ) : (
                        <>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium">{tier.name}</span>
                            <span className="block font-mono text-xs text-muted-foreground">
                              {tier.slug} · {tier.sortOrder}
                            </span>
                          </span>
                          {isDefault ? <Pill>{t('admin.orgs.tiers.defaultTier')}</Pill> : null}
                          <IconButton
                            label={t('admin.orgs.tiers.edit', { name: tier.name })}
                            icon={<Pencil aria-hidden className="size-4" />}
                            onClick={() => {
                              startEdit(tier);
                            }}
                          />
                          {isDefault ? null : (
                            <IconButton
                              label={t('admin.orgs.tiers.delete', { name: tier.name })}
                              icon={<Trash2 aria-hidden className="size-4" />}
                              onClick={() => {
                                setError(null);
                                setToDelete(tier);
                              }}
                            />
                          )}
                        </>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            <form
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                const slug = orgTierSchema.safeParse(newTier.slug);
                if (!slug.success) {
                  setError(t('admin.orgs.tiers.slugInvalid'));
                  return;
                }
                setError(null);
                create.mutate(slug.data);
              }}
              className="flex flex-wrap items-center gap-1.5 border-t border-border pt-3"
            >
              <Input
                id={`${base}-new-name`}
                aria-label={t('admin.orgs.tiers.name')}
                placeholder={t('admin.orgs.tiers.name')}
                value={newTier.name}
                onChange={(event) => {
                  setNewTier({ ...newTier, name: event.target.value });
                }}
                className="min-w-0 flex-1"
              />
              <Input
                id={`${base}-new-slug`}
                aria-label={t('admin.orgs.tiers.slug')}
                placeholder={t('admin.orgs.tiers.slug')}
                title={t('admin.orgs.tiers.slugHint')}
                value={newTier.slug}
                onChange={(event) => {
                  setNewTier({ ...newTier, slug: event.target.value });
                }}
                className="w-24 font-mono"
              />
              <Button
                type="submit"
                disabled={
                  create.isPending || newTier.name.trim() === '' || newTier.slug.trim() === ''
                }
              >
                <Plus aria-hidden className="size-4" />
                {t('admin.orgs.tiers.add')}
              </Button>
            </form>
          </div>
        </SheetContent>
      </Sheet>
      <ConfirmDialog
        open={toDelete !== null}
        onOpenChange={(next) => {
          if (!next) setToDelete(null);
        }}
        title={t('admin.orgs.tiers.deleteTitle', { name: toDelete?.name ?? '' })}
        description={t('admin.orgs.tiers.deleteConfirm')}
        confirmLabel={t('admin.common.delete')}
        onConfirm={() => {
          if (toDelete) remove.mutate(toDelete);
        }}
        pending={remove.isPending}
        error={error}
      />
    </>
  );
}
