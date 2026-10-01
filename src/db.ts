import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DiodeParams, SolveTolerances, TOLERANCE_VERSION } from './types.js';

export interface CaseRow {
  id: number;
  name: string;
  params: DiodeParams;
  tolerance_version: string;
  tolerances: SolveTolerances;
  created_at: string;
}

export interface CurveRow {
  id: number;
  case_id: number;
  case_name: string;
  sample_count: number;
  /** 幂等键：相同键重复请求返回同一记录，不覆盖旧曲线 */
  idempotency_key: string | null;
  params_snapshot: DiodeParams;
  tolerance_version: string;
  tolerances: SolveTolerances;
  result: unknown;
  created_at: string;
}

export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        params_json TEXT NOT NULL,
        tolerance_version TEXT NOT NULL,
        tolerances_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS curves (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        case_id INTEGER NOT NULL REFERENCES cases(id),
        case_name TEXT NOT NULL,
        sample_count INTEGER NOT NULL,
        idempotency_key TEXT,
        params_snapshot_json TEXT NOT NULL,
        tolerance_version TEXT NOT NULL,
        tolerances_json TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_curves_case ON curves(case_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_curves_idem
        ON curves(idempotency_key) WHERE idempotency_key IS NOT NULL;
    `);
  }

  /** 插入工况；同名返回冲突错误，避免静默覆盖。 */
  insertCase(name: string, params: DiodeParams, tol: SolveTolerances): CaseRow {
    const stmt = this.db.prepare(
      `INSERT INTO cases (name, params_json, tolerance_version, tolerances_json)
       VALUES (?, ?, ?, ?)`
    );
    const info = stmt.run(name, JSON.stringify(params), TOLERANCE_VERSION, JSON.stringify(tol));
    return this.getCase(Number(info.lastInsertRowid))!;
  }

  getCase(id: number): CaseRow | null {
    const row = this.db.prepare('SELECT * FROM cases WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.hydrateCase(row) : null;
  }

  getCaseByName(name: string): CaseRow | null {
    const row = this.db.prepare('SELECT * FROM cases WHERE name = ?').get(name) as
      | Record<string, unknown>
      | undefined;
    return row ? this.hydrateCase(row) : null;
  }

  listCases(): CaseRow[] {
    const rows = this.db.prepare('SELECT * FROM cases ORDER BY id').all() as Record<string, unknown>[];
    return rows.map((r) => this.hydrateCase(r));
  }

  private hydrateCase(row: Record<string, unknown>): CaseRow {
    return {
      id: Number(row.id),
      name: String(row.name),
      params: JSON.parse(String(row.params_json)) as DiodeParams,
      tolerance_version: String(row.tolerance_version),
      tolerances: JSON.parse(String(row.tolerances_json)) as SolveTolerances,
      created_at: String(row.created_at),
    };
  }

  /**
   * 冻结一次曲线分析：记录当时的参数快照与容差版本。
   * 幂等键相同则直接返回旧记录（重复请求），绝不覆盖。
   */
  insertCurve(
    caseId: number,
    caseName: string,
    sampleCount: number,
    params: DiodeParams,
    tol: SolveTolerances,
    result: unknown,
    idempotencyKey: string | null
  ): { row: CurveRow; reused: boolean } {
    if (idempotencyKey) {
      const existing = this.getCurveByIdempotencyKey(idempotencyKey);
      if (existing) return { row: existing, reused: true };
    }
    const info = this.db
      .prepare(
        `INSERT INTO curves
          (case_id, case_name, sample_count, idempotency_key,
           params_snapshot_json, tolerance_version, tolerances_json, result_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        caseId,
        caseName,
        sampleCount,
        idempotencyKey,
        JSON.stringify(params),
        TOLERANCE_VERSION,
        JSON.stringify(tol),
        JSON.stringify(result)
      );
    return { row: this.getCurve(Number(info.lastInsertRowid))!, reused: false };
  }

  getCurve(id: number): CurveRow | null {
    const row = this.db.prepare('SELECT * FROM curves WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.hydrateCurve(row) : null;
  }

  getCurveByIdempotencyKey(key: string): CurveRow | null {
    const row = this.db.prepare('SELECT * FROM curves WHERE idempotency_key = ?').get(key) as
      | Record<string, unknown>
      | undefined;
    return row ? this.hydrateCurve(row) : null;
  }

  listCurves(caseId?: number): CurveRow[] {
    const rows =
      caseId !== undefined
        ? (this.db.prepare('SELECT * FROM curves WHERE case_id = ? ORDER BY id').all(caseId) as Record<string, unknown>[])
        : (this.db.prepare('SELECT * FROM curves ORDER BY id').all() as Record<string, unknown>[]);
    return rows.map((r) => this.hydrateCurve(r));
  }

  private hydrateCurve(row: Record<string, unknown>): CurveRow {
    return {
      id: Number(row.id),
      case_id: Number(row.case_id),
      case_name: String(row.case_name),
      sample_count: Number(row.sample_count),
      idempotency_key: row.idempotency_key === null ? null : String(row.idempotency_key),
      params_snapshot: JSON.parse(String(row.params_snapshot_json)) as DiodeParams,
      tolerance_version: String(row.tolerance_version),
      tolerances: JSON.parse(String(row.tolerances_json)) as SolveTolerances,
      result: JSON.parse(String(row.result_json)),
      created_at: String(row.created_at),
    };
  }

  close(): void {
    this.db.close();
  }
}
