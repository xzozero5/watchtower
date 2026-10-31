/**
 * Throws when two of the records share a key or a value. The global `AUDIT_ACTIONS`,
 * `TICKET_EVENT_TYPES` and `QUEUE_NAMES` are object spreads of the core record and every feature
 * record, and a spread silently lets the later record win; this turns that into a loud failure
 * when `@watchtower/shared` is first imported. Messages name the label and the clashing entry.
 */
export function assertDisjoint(label: string, records: readonly Record<string, string>[]): void {
  const keys = new Set<string>();
  const values = new Map<string, string>();
  for (const record of records) {
    for (const [key, value] of Object.entries(record)) {
      if (keys.has(key))
        throw new Error(`${label}: key "${key}" is defined by more than one source`);
      keys.add(key);
      const owner = values.get(value);
      if (owner !== undefined) {
        throw new Error(`${label}: value "${value}" is used by both "${owner}" and "${key}"`);
      }
      values.set(value, key);
    }
  }
}
