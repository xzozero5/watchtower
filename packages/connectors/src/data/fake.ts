import { ConnectorQueryRejectedError } from '../common/errors.js';
import type { DataQuery, DataQueryClient, DataResult, SqlValue } from './types.js';

export interface FakeDataAnswer {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly SqlValue[])[];
}

/**
 * Answers by the `label` of the query (a saved template's name) from a table it was given. It does
 * not read the SQL, so it is no test of a statement: that is the job of the sandbox database. It
 * keeps the contract (row cap, truncation, no write) and records what it was asked.
 */
export class FakeDataQueryClient implements DataQueryClient {
  readonly source = 'fake' as const;
  readonly queries: DataQuery[] = [];
  readonly #answers = new Map<string, FakeDataAnswer>();

  constructor(answers: Readonly<Record<string, FakeDataAnswer>> = {}) {
    for (const [label, answer] of Object.entries(answers)) this.#answers.set(label, answer);
  }

  set(label: string, answer: FakeDataAnswer): void {
    this.#answers.set(label, answer);
  }

  query(query: DataQuery): Promise<DataResult> {
    this.queries.push(query);
    if (query.signal?.aborted === true) {
      return Promise.reject(new ConnectorQueryRejectedError('Aborted'));
    }
    const answer = this.#answers.get(query.label);
    if (answer === undefined) return Promise.resolve({ columns: [], rows: [], truncated: false, masked: [] });
    return Promise.resolve({
      columns: answer.columns,
      rows: answer.rows.slice(0, query.maxRows),
      truncated: answer.rows.length > query.maxRows,
      masked: [],
    });
  }
}
