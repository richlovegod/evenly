// A small D1 stand-in for route tests: the real schema (every migrations/*.sql, in name order, as
// `wrangler d1 migrations apply` runs them) in an in-memory SQLite database (node:sqlite), with the
// parts of the D1 API the Worker uses: prepare / bind / all / first / run, and batch() as one
// transaction. Not a test file itself (no .test.ts).

import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const MIGRATIONS = new URL('../../migrations/', import.meta.url);

/** The migration files in the order they apply (0001_init.sql, 0002_push.sql, ...). */
export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort();
}

type Row = Record<string, unknown>;

interface Result {
  results: Row[];
  success: true;
  meta: { changes: number; last_row_id: number; duration: number };
}

const READ_ONLY = /^\s*(SELECT|WITH|PRAGMA)\b/i;

export class TestStmt {
  constructor(
    readonly d1: TestD1,
    readonly sql: string,
    readonly params: readonly unknown[] = [],
  ) {}

  bind(...params: unknown[]): TestStmt {
    return new TestStmt(this.d1, this.sql, params);
  }

  /** Runs the statement now (also inside a batch transaction). */
  execNow(): Result {
    const values = this.params.map(v => {
      if (v === undefined) throw new Error('D1_TYPE_ERROR: Type undefined is not supported as a bound value');
      if (typeof v === 'boolean') return v ? 1 : 0;
      return v as string | number | null;
    });
    const rows = this.d1.sqlite.prepare(this.sql).all(...values) as Row[];
    const changes = READ_ONLY.test(this.sql) ? 0 : Number((this.d1.sqlite.prepare('SELECT changes() AS n').get() as Row).n);
    this.d1.log.push(this.sql);
    return { results: rows.map(r => ({ ...r })), success: true, meta: { changes, last_row_id: 0, duration: 0 } };
  }

  async all(): Promise<Result> {
    return this.execNow();
  }

  async run(): Promise<Result> {
    return this.execNow();
  }

  async first<T = Row>(column?: string): Promise<T | null> {
    const row = this.execNow().results[0];
    if (!row) return null;
    return (column ? row[column] : row) as T;
  }
}

export class TestD1 {
  readonly sqlite = new DatabaseSync(':memory:');
  /** SQL of every statement run, oldest first. */
  readonly log: string[] = [];

  constructor() {
    this.sqlite.exec('PRAGMA foreign_keys = ON');
    for (const f of migrationFiles()) this.sqlite.exec(readFileSync(new URL(f, MIGRATIONS), 'utf8'));
  }

  prepare(sql: string): TestStmt {
    return new TestStmt(this, sql);
  }

  async batch(stmts: readonly TestStmt[]): Promise<Result[]> {
    this.sqlite.exec('BEGIN');
    try {
      const out = stmts.map(s => s.execNow());
      this.sqlite.exec('COMMIT');
      return out;
    } catch (err) {
      this.sqlite.exec('ROLLBACK');
      throw err;
    }
  }

  /** Read rows directly (test assertions). */
  rows<T = Row>(sql: string, ...params: (string | number | null)[]): T[] {
    return (this.sqlite.prepare(sql).all(...params) as Row[]).map(r => ({ ...r })) as T[];
  }

  /** Write directly (test setup). */
  exec(sql: string, ...params: (string | number | null)[]): void {
    this.sqlite.prepare(sql).run(...params);
  }

  get d1(): D1Database {
    return this as unknown as D1Database;
  }
}
