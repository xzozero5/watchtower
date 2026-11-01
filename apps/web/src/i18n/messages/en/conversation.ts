export const conversationEn = {
  loading: 'Loading the ticket',
  loadingMessages: 'Loading messages',
  error: {
    title: 'The ticket could not be loaded',
    body: 'Check your connection and try again.',
  },
  notFound: {
    title: 'Ticket not found',
    body: 'It does not exist, or you do not have access to it.',
  },
  timelineError: { title: 'The messages could not be loaded' },
  noMessages: {
    title: 'No messages yet',
    body: 'Messages and replies on this ticket will appear here.',
  },
  headerActions: 'Ticket actions',
  copyKey: 'Copy ticket key',
  keyCopied: 'Copied {key}',
  resolve: 'Resolve',
} as const;
