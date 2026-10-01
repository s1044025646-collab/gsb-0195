// SQLite 持久层：冻结每次分析的参数、容差与求解器版本；记录只增不改。
import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { DiodeParams, Tolerances, SOLVER_VERSION } from "./physics";

export interface AnalysisRecord {
  id: number;
  name: string;
  params: DiodeParams;
  tolerances: Tolerances;
  solverVersion: string;
  summary: string; // JSON
  curve: string;   // JSON
  samples: number;
  createdAt: string;
}

export class AnalysisStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS analyses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        params TEXT NOT NULL,
        tolerances TEXT NOT NULL,
        solver_version TEXT NOT NULL,
        samples INTEGER NOT NULL,
        summary TEXT NOT NULL,
        curve TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS comparisons (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        analysis_ids TEXT NOT NULL,
        result TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  createAnalysis(name: string, params: DiodeParams, tolerances: Tolerances, samples: number, summary: unknown, curve: unknown): number {
    const stmt = this.db.prepare(
      `INSERT INTO analyses (name, params, tolerances, solver_version, samples, summary, curve)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    const r = stmt.run(name, JSON.stringify(params), JSON.stringify(tolerances), SOLVER_VERSION, samples, JSON.stringify(summary), JSON.stringify(curve));
    return Number(r.lastInsertRowid);
  }

  getAnalysis(id: number): AnalysisRecord | null {
    const row = this.db.prepare("SELECT * FROM analyses WHERE id = ?").get(id) as any;
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      params: JSON.parse(row.params),
      tolerances: JSON.parse(row.tolerances),
      solverVersion: row.solver_version,
      summary: row.summary,
      curve: row.curve,
      samples: row.samples,
      createdAt: row.created_at,
    };
  }

  listAnalyses(): Array<Omit<AnalysisRecord, "curve">> {
    const rows = this.db.prepare("SELECT id, name, params, tolerances, solver_version, samples, summary, created_at FROM analyses ORDER BY id").all() as any[];
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      params: JSON.parse(row.params),
      tolerances: JSON.parse(row.tolerances),
      solverVersion: row.solver_version,
      summary: row.summary,
      samples: row.samples,
      createdAt: row.created_at,
    }));
  }

  saveComparison(ids: number[], result: unknown): number {
    const r = this.db.prepare("INSERT INTO comparisons (analysis_ids, result) VALUES (?, ?)")
      .run(JSON.stringify(ids), JSON.stringify(result));
    return Number(r.lastInsertRowid);
  }

  close(): void {
    this.db.close();
  }
}
