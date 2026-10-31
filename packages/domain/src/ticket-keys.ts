import { formatTicketKey, parseTicketKey } from '@watchtower/shared';

/**
 * How this instance writes and reads ticket numbers: `prefix-number`, where the prefix comes from
 * `TICKET_KEY_PREFIX` (default `OPS`). The number itself is the database sequence.
 */
export class TicketKeys {
  constructor(readonly prefix: string) {}

  format(number: number | bigint): string {
    return formatTicketKey(number, this.prefix);
  }

  /** The number inside a key of this instance (any case); null for anything else, including another prefix. */
  parse(value: string): number | null {
    return parseTicketKey(value, this.prefix);
  }
}
