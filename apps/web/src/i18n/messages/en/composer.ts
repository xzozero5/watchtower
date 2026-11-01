export const composerEn = {
  label: 'Write a message',
  modeGroup: 'Kind of message',
  modes: { reply: 'Reply', note: 'Internal note', noteShort: 'Note' },
  hints: {
    replyStaff: 'The customer will read this. It is sent by {channel}.',
    replyClient: 'Your message is added to this ticket and the support team is notified.',
    note: 'Only your team sees this note. It is never sent to the customer.',
  },
  template: {
    label: 'Insert a reply template',
    choose: 'Insert template',
    none: 'No templates for this intent',
  },
  unresolved: {
    title: 'Fill in the placeholders first',
    body: 'These placeholders have no value for this ticket: {names}.',
  },
  setStatus: { label: 'Then set status', keep: 'Keep current status' },
  submit: {
    reply: 'Send reply',
    replyAndSet: 'Send reply and set {status}',
    note: 'Add note',
  },
  sending: 'Sending',
  sent: { reply: 'Reply sent.', note: 'Note added.' },
  closed: {
    title: 'This ticket is closed',
    body: 'Replies are turned off for closed and merged tickets.',
  },
  errors: {
    title: 'Could not send',
    generic: 'Something went wrong. Your text is still here; try again.',
    network: 'The API could not be reached. Your text is still here; try again.',
    forbidden: 'You are not allowed to do that on this ticket.',
    invalidTransition: 'The ticket cannot move to that status from where it is now.',
    ticketNotOpen: 'The ticket is closed or merged, so it cannot take new messages.',
  },
  fields: { reply: 'Public reply', note: 'Internal note' },
  placeholders: {
    reply: 'Write a reply…',
    note: 'Write a note for your team…',
    client: 'Write a message…',
  },
  noteBanner: 'Internal note — not sent to the customer',
  toolbar: {
    label: 'Composer tools',
    attach: 'Attach a file',
    aiDraft: 'Draft with AI',
    phase1: 'Coming in Phase 1',
    templateSearch: 'Search templates',
  },
} as const;
