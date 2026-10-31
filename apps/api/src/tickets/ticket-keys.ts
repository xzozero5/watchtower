import { TicketKeys } from '@watchtower/domain';

/** DI token for the instance's ticket key format. Inject with `@Inject(TICKET_KEYS)`. */
export const TICKET_KEYS = Symbol('TICKET_KEYS');

// The class moved to @watchtower/domain, which writes tickets in the api and the worker alike (ADR-009).
export { TicketKeys };
