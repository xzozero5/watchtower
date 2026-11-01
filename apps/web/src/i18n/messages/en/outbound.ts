/**
 * English copy of sending a reply (T-109): the undo window the server holds, the channel a reply
 * goes through and the LINE push allowance. ../th/outbound.ts must have the same keys.
 */
export const outboundEn = {
  sendingIn: 'Sending in {seconds} s',
  undo: 'Undo',
  undone: 'Send undone. Nothing reached the customer.',
  tooLate: 'Too late: the reply is already being sent.',
  undoFailed: 'Could not undo. Check the conversation before trying again.',
  bar: 'Reply waiting to be sent',
  via: 'Via {channel}',
  viaTip: 'The reply goes out through the channel the customer wrote on.',
  delivery: {
    scheduled: 'Waiting to send',
    cancelled: 'Undone, not sent',
    failed: 'Not delivered',
  },
  quota: {
    label: 'LINE messages this month',
    used: '{used} of {limit} used',
    usedNoLimit: '{used} used',
    warn: 'LINE allowance is nearly used up. Prefer email if the customer has one.',
    exhausted: 'LINE allowance is used up. A push message will be refused; use email.',
    unknown: 'LINE allowance not known',
  },
} as const;
