import { DEFAULT_TOLERANCES, DiodeParams, SolveTolerances } from './types.js';
import { validateParams, solveCurrent, solvePoint } from './model.js';
import { generateCurve, solveOpenCircuitVoltage, solveMpp } from './curve.js';
import { compareCurves, ComparisonResult, CaseCurveRecord } from './compare.js';
import { Store } from './db.js';

export class ServiceError extends Error {
  constructor(
    public code: string,
    message: string,
    public details?: unknown
  ) {
    super(message);
    this.name = 'ServiceError';
  }
}

export class AnalysisService {
  constructor(private store: Store) {}

  /** 校验参数，非法时抛出带字段明细的错误。tolerances 与默认值浅合并。 */
  resolveParams(raw: unknown): DiodeParams {
    if (typeof raw !== 'object' || raw === null) {
      throw new ServiceError('INVALID_PARAMS', '请求体必须是包含五参数的对象');
    }
    const o = raw as Record<string, unknown>;
    const params: DiodeParams = {
      iPh: Number(o.iPh),
      i0: Number(o.i0),
      rs: Number(o.rs),
      rSh: Number(o.rSh),
      nVt: Number(o.nVt),
    };
    const issues = validateParams(params);
    if (issues.length > 0) {
      throw new ServiceError('INVALID_PARAMS', '参数不满足物理范围', issues);
    }
    return params;
  }

  resolveTolerances(raw?: unknown): SolveTolerances {
    if (raw === undefined || raw === null) return { ...DEFAULT_TOLERANCES };
    const o = raw as Record<string, unknown>;
    return {
      rootAbsTol: numOr(o.rootAbsTol, DEFAULT_TOLERANCES.rootAbsTol),
      rootRelTol: numOr(o.rootRelTol, DEFAULT_TOLERANCES.rootRelTol),
      rootMaxIter: intOr(o.rootMaxIter, DEFAULT_TOLERANCES.rootMaxIter),
      mppXtol: numOr(o.mppXtol, DEFAULT_TOLERANCES.mppXtol),
      mppMaxIter: intOr(o.mppMaxIter, DEFAULT_TOLERANCES.mppMaxIter),
      expArgMax: numOr(o.expArgMax, DEFAULT_TOLERANCES.expArgMax),
      bracketMaxExpansion: intOr(
        o.bracketMaxExpansion,
        DEFAULT_TOLERANCES.bracketMaxExpansion
      ),
    };
  }

  upsertCase(name: string, params: DiodeParams, tol: SolveTolerances) {
    const existing = this.store.getCaseByName(name);
    if (existing) {
      throw new ServiceError(
        'CASE_EXISTS',
        `工况 '${name}' 已存在（id=${existing.id}）；旧工况不可被覆盖，请使用新名称`,
        { existingId: existing.id }
      );
    }
    return this.store.insertCase(name, params, tol);
  }

  getCaseOrThrow(name: string) {
    const c = this.store.getCaseByName(name);
    if (!c) throw new ServiceError('CASE_NOT_FOUND', `工况 '${name}' 不存在`);
    return c;
  }

  /** 生成并冻结曲线。参数可显式传入（未命名）或引用已存工况。 */
  generateAndStore(args: {
    name?: string;
    params?: DiodeParams;
    tolerances?: SolveTolerances;
    sampleCount: number;
    idempotencyKey?: string;
  }) {
    let caseId: number;
    let caseName: string;
    let params: DiodeParams;
    let tol: SolveTolerances;

    if (args.name) {
      const c = this.getCaseOrThrow(args.name);
      caseId = c.id;
      caseName = c.name;
      // 始终使用冻结在工况上的参数与容差，避免新参数覆盖旧曲线。
      params = c.params;
      tol = c.tolerances;
    } else {
      if (!args.params) throw new ServiceError('INVALID_PARAMS', '未提供工况名时必须给出参数');
      params = args.params;
      tol = args.tolerances ?? { ...DEFAULT_TOLERANCES };
      const adhoc = this.upsertCase(`__adhoc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, params, tol);
      caseId = adhoc.id;
      caseName = adhoc.name;
    }

    const curve = generateCurve(params, args.sampleCount, tol);
    if ('status' in curve) {
      throw new ServiceError('SOLVE_FAILED', `曲线求解失败：${curve.status}`, {
        status: curve.status,
      });
    }
    const saved = this.store.insertCurve(
      caseId,
      caseName,
      args.sampleCount,
      params,
      tol,
      curve,
      args.idempotencyKey ?? null
    );
    return { curveId: saved.row.id, reused: saved.reused, curve, caseId, caseName };
  }

  /** 单点校核（不落库）。 */
  checkPoint(args: { name?: string; params?: DiodeParams; v: number }) {
    let params: DiodeParams;
    let tol: SolveTolerances;
    if (args.name) {
      const c = this.getCaseOrThrow(args.name);
      params = c.params;
      tol = c.tolerances;
    } else {
      if (!args.params) throw new ServiceError('INVALID_PARAMS', '未提供工况名时必须给出参数');
      params = args.params;
      tol = { ...DEFAULT_TOLERANCES };
    }
    const voc = solveOpenCircuitVoltage(params, tol);
    if ('status' in voc) {
      throw new ServiceError('SOLVE_FAILED', `Voc 求解失败：${voc.status}`, { status: voc.status });
    }
    const point = solvePoint(params, args.v, voc.vOc, tol);
    return { validRange: { vMin: 0, vOc: voc.vOc }, point };
  }

  /** 连续区间 MPP 搜索（不落库）。 */
  findMpp(args: { name?: string; params?: DiodeParams }) {
    let params: DiodeParams;
    let tol: SolveTolerances;
    if (args.name) {
      const c = this.getCaseOrThrow(args.name);
      params = c.params;
      tol = c.tolerances;
    } else {
      if (!args.params) throw new ServiceError('INVALID_PARAMS', '未提供工况名时必须给出参数');
      params = args.params;
      tol = { ...DEFAULT_TOLERANCES };
    }
    const voc = solveOpenCircuitVoltage(params, tol);
    if ('status' in voc) {
      throw new ServiceError('SOLVE_FAILED', `Voc 求解失败：${voc.status}`, { status: voc.status });
    }
    const mpp = solveMpp(params, voc.vOc, tol);
    if ('status' in mpp) {
      throw new ServiceError('SOLVE_FAILED', `MPP 求解失败：${mpp.status}`, { status: mpp.status });
    }
    return { vOc: voc.vOc, mpp };
  }

  compare(names: string[]): ComparisonResult {
    if (names.length < 2) throw new ServiceError('INVALID_REQUEST', '比较至少需要两个工况名');
    const records: CaseCurveRecord[] = [];
    for (const name of names) {
      const c = this.getCaseOrThrow(name);
      const voc = solveOpenCircuitVoltage(c.params, c.tolerances);
      if ('status' in voc) {
        throw new ServiceError('SOLVE_FAILED', `工况 '${name}' Voc 求解失败`, {
          status: voc.status,
        });
      }
      const mpp = solveMpp(c.params, voc.vOc, c.tolerances);
      if ('status' in mpp) {
        throw new ServiceError('SOLVE_FAILED', `工况 '${name}' MPP 求解失败`, {
          status: mpp.status,
        });
      }
      const isc = solveCurrent(c.params, 0, c.tolerances);
      if (isc.i === null) {
        throw new ServiceError('SOLVE_FAILED', `工况 '${name}' 短路电流求解失败`, {
          status: isc.status,
        });
      }
      records.push({
        caseName: name,
        curve: {
          validRange: { vMin: 0, vOc: voc.vOc },
          iShortCircuit: isc.i,
          vOpenCircuit: voc.vOc,
          points: [],
          mpp,
          fillFactor: isc.i * voc.vOc > 0 ? mpp.pMpp / (isc.i * voc.vOc) : 0,
          sampleCount: 0,
          allConverged: true,
        },
      });
    }
    return compareCurves(records);
  }
}

function numOr(x: unknown, d: number): number {
  const n = Number(x);
  return x === undefined || !Number.isFinite(n) ? d : n;
}
function intOr(x: unknown, d: number): number {
  const n = Number(x);
  return x === undefined || !Number.isInteger(n) || n <= 0 ? d : n;
}
