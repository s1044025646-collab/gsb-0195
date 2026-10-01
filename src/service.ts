// 业务层：参数导入、曲线生成、单点校核、MPP 搜索、工况比较、导出。
import {
  DiodeParams, Tolerances, DEFAULT_TOLERANCES, validateParams, summarize,
  generateCurve, solveCurrent, solveVoc, findMpp, checkResidual, CurvePoint,
} from "./physics";
import { AnalysisStore } from "./db";

export interface CompareResult {
  analyses: Array<{ id: number; name: string; params: DiodeParams; pmpp: number; voc: number; isc: number; fillFactor: number }>;
  pairwise: Array<{
    a: number; b: number;
    deltaPmpp: number;        // Pmpp(b) - Pmpp(a) [W]
    deltaPmppPct: number;     // 相对 a 的百分比
    seriesLossW: number;      // a 的串联电阻损耗估计 Isc^2 * Rs
    shuntLossW: number;       // a 的并联漏电损耗估计 Voc^2 / Rsh
  }>;
  note: string;
}

export class PvService {
  constructor(private store: AnalysisStore) {}

  /** 参数导入 + 生成曲线 + 汇总，冻结入库。 */
  createAnalysis(input: { name?: string; params: DiodeParams; samples?: number; tolerances?: Partial<Tolerances> }) {
    const params = input.params;
    const issues = validateParams(params);
    if (issues.length > 0) {
      return { ok: false as const, error: "参数非法", issues };
    }
    const tol: Tolerances = { ...DEFAULT_TOLERANCES, ...(input.tolerances ?? {}) };
    const samples = input.samples ?? 200;
    const s = summarize(params, tol);
    if (!s.ok) {
      return { ok: false as const, error: "汇总求解失败", failure: s.failure };
    }
    const curve = generateCurve(params, samples, s.summary.voc, tol);
    if (!curve.ok) {
      return { ok: false as const, error: "曲线生成失败", failure: curve.failure };
    }
    const name = input.name ?? `analysis-${Date.now()}`;
    const id = this.store.createAnalysis(name, params, tol, samples, s.summary, curve.points);
    return { ok: true as const, id, name, summary: s.summary, points: curve.points.length };
  }

  getAnalysis(id: number, includeCurve = true) {
    const rec = this.store.getAnalysis(id);
    if (!rec) return null;
    return {
      id: rec.id,
      name: rec.name,
      params: rec.params,
      tolerances: rec.tolerances,
      solverVersion: rec.solverVersion,
      samples: rec.samples,
      createdAt: rec.createdAt,
      summary: JSON.parse(rec.summary),
      curve: includeCurve ? (JSON.parse(rec.curve) as CurvePoint[]) : undefined,
    };
  }

  listAnalyses() {
    return this.store.listAnalyses().map((r) => ({
      id: r.id, name: r.name, params: r.params, tolerances: r.tolerances,
      solverVersion: r.solverVersion, samples: r.samples, createdAt: r.createdAt,
      summary: JSON.parse(r.summary),
    }));
  }

  /** 单点校核：按冻结参数重新求解，并独立代入残差核对。 */
  pointCheck(id: number, v: number) {
    const rec = this.store.getAnalysis(id);
    if (!rec) return { ok: false as const, error: `分析 ${id} 不存在` };
    const r = solveCurrent(rec.params, v, rec.tolerances);
    if (!r.ok) return { ok: false as const, error: "求解失败", failure: r };
    const independent = checkResidual(rec.params, v, r.current);
    return {
      ok: true as const,
      v, i: r.current, p: v * r.current,
      residual: r.residual,
      independentResidual: independent,
      status: r.status,
      iterations: r.iterations,
    };
  }

  /** 连续区间 MPP 搜索（基于冻结参数重新计算）。 */
  mpp(id: number) {
    const rec = this.store.getAnalysis(id);
    if (!rec) return { ok: false as const, error: `分析 ${id} 不存在` };
    const vocR = solveVoc(rec.params, rec.tolerances);
    if (!vocR.ok) return { ok: false as const, error: "Voc 求解失败", failure: vocR };
    const m = findMpp(rec.params, vocR.current, rec.tolerances);
    if (!m.ok) return { ok: false as const, error: "MPP 搜索失败", failure: m };
    return { ok: true as const, mpp: m };
  }

  /** 工况比较：最大功率差异与串/并联损耗估计。 */
  compare(ids: number[]) {
    if (!Array.isArray(ids) || ids.length < 2) {
      return { ok: false as const, error: "至少需要两个分析 ID" };
    }
    const items = ids.map((id) => {
      const rec = this.store.getAnalysis(id);
      if (!rec) return null;
      const summary = JSON.parse(rec.summary);
      return { id: rec.id, name: rec.name, params: rec.params, pmpp: summary.mpp.pmpp, voc: summary.voc, isc: summary.isc, fillFactor: summary.fillFactor };
    });
    if (items.some((x) => x === null)) {
      return { ok: false as const, error: "存在无效的分析 ID" };
    }
    const valid = items as NonNullable<(typeof items)[number]>[];
    const pairwise: CompareResult["pairwise"] = [];
    for (let a = 0; a < valid.length; a++) {
      for (let b = a + 1; b < valid.length; b++) {
        const A = valid[a], B = valid[b];
        pairwise.push({
          a: A.id, b: B.id,
          deltaPmpp: B.pmpp - A.pmpp,
          deltaPmppPct: A.pmpp !== 0 ? (100 * (B.pmpp - A.pmpp)) / A.pmpp : NaN,
          seriesLossW: A.params.rs * A.isc * A.isc,
          shuntLossW: A.voc * A.voc / A.params.rsh,
        });
      }
    }
    const result: CompareResult = {
      analyses: valid,
      pairwise,
      note: "MPP 均在连续区间 [0, Voc] 上优化，与曲线采样步长无关；差异为真实物理差异，非采样伪影。",
    };
    const cmpId = this.store.saveComparison(ids, result);
    return { ok: true as const, comparisonId: cmpId, result };
  }

  exportCurve(id: number, format: "json" | "csv"): { ok: true; content: string; contentType: string } | { ok: false; error: string } {
    const rec = this.store.getAnalysis(id);
    if (!rec) return { ok: false, error: `分析 ${id} 不存在` };
    const points = JSON.parse(rec.curve) as CurvePoint[];
    if (format === "json") {
      return {
        ok: true,
        contentType: "application/json",
        content: JSON.stringify({
          id: rec.id, name: rec.name, params: rec.params, tolerances: rec.tolerances,
          solverVersion: rec.solverVersion, summary: JSON.parse(rec.summary), curve: points,
        }, null, 2),
      };
    }
    const header = "v_V,i_A,p_W,residual_A,status";
    const lines = points.map((pt) => `${pt.v},${pt.i},${pt.p},${pt.residual},${pt.status}`);
    return { ok: true, contentType: "text/csv", content: [header, ...lines].join("\n") + "\n" };
  }
}
