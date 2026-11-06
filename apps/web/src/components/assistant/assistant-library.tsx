'use client';

import { ASSISTANT_MEMORY_LIMITS } from '@watchtower/shared';
import { Button } from '@watchtower/ui';
import { useState } from 'react';

import { useT } from '@/i18n/provider';
import {
  useAssistantConversations,
  useAssistantLibraryAction,
  useAssistantMemory,
} from '@/lib/assistant/library';

/** Own redacted previews only. The API has no old-message reader; rows are not chat links. */
export function AssistantLibrary({
  open,
  onDeleted,
}: {
  open: boolean;
  onDeleted: (id: string) => void;
}) {
  const t = useT();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const conversations = useAssistantConversations(open && historyOpen);
  const memory = useAssistantMemory(open && memoryOpen);
  const action = useAssistantLibraryAction();
  const execute = (input: Parameters<typeof action.mutate>[0]) => {
    action.mutate(input, {
      onSuccess: () => {
        if (input.kind === 'conversation') onDeleted(input.id);
      },
    });
  };

  return (
    <div className="flex flex-col gap-2 border-b border-border px-4 py-2 text-sm">
      <details
        onToggle={(event) => {
          setHistoryOpen(event.currentTarget.open);
        }}
      >
        <summary className="cursor-pointer rounded-sm focus-visible:outline-2 focus-visible:outline-ring">
          {t('assistant.library.history')}
        </summary>
        {historyOpen ? (
          <section
            aria-label={t('assistant.library.history')}
            className="mt-2 max-h-40 overflow-y-auto"
          >
            {conversations.isPending ? <p role="status">{t('assistant.library.loading')}</p> : null}
            {conversations.isError ? (
              <div role="alert">
                <p>{t('assistant.library.loadError')}</p>
                <Button
                  size="sm"
                  onClick={() => {
                    void conversations.refetch();
                  }}
                >
                  {t('assistant.library.retry')}
                </Button>
              </div>
            ) : null}
            {conversations.data?.items.length === 0 ? (
              <p>{t('assistant.library.noHistory')}</p>
            ) : null}
            <ul className="flex flex-col gap-2">
              {conversations.data?.items.map((item) => (
                <li key={item.id} className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="break-words">
                      {item.preview ?? t('assistant.library.noPreview')}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      <time dateTime={item.updatedAt}>{item.updatedAt.slice(0, 10)}</time> ·{' '}
                      {t('assistant.library.messages', { count: item.messageCount })}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    disabled={action.isPending}
                    onClick={() => {
                      execute({ kind: 'conversation', id: item.id });
                    }}
                  >
                    {t('assistant.library.delete')}
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </details>
      <details
        onToggle={(event) => {
          setMemoryOpen(event.currentTarget.open);
        }}
      >
        <summary className="cursor-pointer rounded-sm focus-visible:outline-2 focus-visible:outline-ring">
          {t('assistant.library.memory')}
        </summary>
        {memoryOpen ? (
          <section
            aria-label={t('assistant.library.memory')}
            className="mt-2 max-h-40 overflow-y-auto"
          >
            {memory.isPending ? <p role="status">{t('assistant.library.loading')}</p> : null}
            {memory.isError ? (
              <div role="alert">
                <p>{t('assistant.library.loadError')}</p>
                <Button
                  size="sm"
                  onClick={() => {
                    void memory.refetch();
                  }}
                >
                  {t('assistant.library.retry')}
                </Button>
              </div>
            ) : null}
            {memory.data ? (
              <>
                <p>
                  {t('assistant.library.count', {
                    count: memory.data.items.length,
                    limit: ASSISTANT_MEMORY_LIMITS.maxPerUser,
                  })}
                </p>
                {memory.data.items.length > 0 ? (
                  <Button
                    size="sm"
                    disabled={action.isPending}
                    onClick={() => {
                      execute({ kind: 'clear' });
                    }}
                  >
                    {t('assistant.library.clear')}
                  </Button>
                ) : (
                  <p>{t('assistant.library.noMemory')}</p>
                )}
                <ul className="flex flex-col gap-2">
                  {memory.data.items.map((item) => (
                    <li key={item.id} className="flex items-start justify-between gap-2">
                      <p className="min-w-0 break-words">{item.body}</p>
                      <Button
                        size="sm"
                        disabled={action.isPending}
                        onClick={() => {
                          execute({ kind: 'memory', id: item.id });
                        }}
                      >
                        {t('assistant.library.forget')}
                      </Button>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </section>
        ) : null}
      </details>
      {action.isPending ? <p role="status">{t('assistant.library.working')}</p> : null}
      {action.isError ? (
        <div role="alert">
          <p>{t('assistant.library.deleteError')}</p>
          <Button
            size="sm"
            onClick={() => {
              execute(action.variables);
            }}
          >
            {t('assistant.library.retry')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
