import { makeTicket } from './backend';

/** The AI-first workspace (T-128). The AI data is mocked here: the api does not serve it yet. */
export const boardTickets = () => [
  makeTicket(1, {
    subject: 'Re: Re: login',
    priority: 'P2',
    ai: { state: 'draft_ready', summary: 'Locked out after a reset; reply is ready' },
  }),
  makeTicket(2, {
    subject: 'Webhook deliveries',
    ai: { state: 'investigating', summary: 'Webhook deliveries failing since this morning' },
  }),
  makeTicket(3, { subject: 'Invoice question', priority: 'P4', status: 'waiting_on_customer' }),
  makeTicket(4, {
    subject: 'Export is slow',
    priority: 'P1',
    ai: { state: 'classified', summary: 'Export timing out for one customer' },
    firstResponseDueAt: '2026-01-01T00:00:00.000Z',
  }),
  makeTicket(5, { subject: 'Plain old subject' }),
];
