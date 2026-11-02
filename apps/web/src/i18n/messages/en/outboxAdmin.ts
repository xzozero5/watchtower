/** English copy of the head's outbox screen (T-121). Same keys as th/outboxAdmin.ts. */
export const outboxAdminEn = {
  title: 'Outbox',
  refresh: 'Refresh',
  help: 'The outbox hands work (messages to send, received mail to process) to the workers. A row is dead when it failed too many times and was given up on.',
  helpLabel: 'More about the outbox',
  health: {
    label: 'Outbox health',
    pending: 'Waiting',
    dead: 'Dead',
    oldest: 'Oldest waiting',
    oldestNone: 'Nothing is waiting',
    byQueue: 'By queue',
    status: {
      ok: 'On time',
      warning: 'Late',
      critical: 'Stuck',
    },
    statusHelp:
      'Late from {warning}, stuck from {critical}. The relay checks every second, so a long wait means the relay or Redis is down.',
  },
  dead: {
    title: 'Given up on',
    caption: 'Dead outbox rows',
    empty: 'No dead rows.',
    loadMore: 'Show more',
    col: {
      when: 'When',
      job: 'Job',
      effect: 'A resend would',
      tries: 'Tries',
      error: 'Last error',
    },
    noError: 'No error recorded',
    notReplayable: 'Cannot be resent: {reason}',
    resend: 'Resend',
    resendRow: 'Resend {job}',
  },
  effect: {
    customer: 'Send a message to a customer',
    customerDetail: 'Ticket {ticket} by {channel} ({account})',
    reprocess: 'Process a received message again',
    reprocessDetail: 'Received on {channel} ({account}). Nothing is sent to anyone',
  },
  confirm: {
    title: 'Resend {job}?',
    customer:
      'This can send a message to a customer: ticket {ticket}, by {channel} ({account}). The usual checks still apply (undo window, policy gate), and the message text is not shown here. Open the ticket to read it.',
    reprocess:
      'A received message on {channel} ({account}) will be processed again. Nothing is sent to anyone.',
    action: 'Resend',
    audited: 'This is recorded in the audit log.',
  },
  resent: 'Put back in the queue.',
  notFound: 'This row is no longer dead.',
} as const;
