import {
  DiodeParams,
  SolveTolerances,
  PointStatus,
  SinglePointResult,
  ValidationIssue,
} from './types.js';

/**
 * 单二极管模型（含串联压降），采用电流形式：
 *   I = Iph - I0 * (exp((V + I*Rs)/(nVt)) - 1) - (V + I*Rs)/Rsh
 * 定义待求根函数（单位 A）：
 *   f(I; V) = Iph - I0*(expm1((V+I*Rs)/nVt)) - (V+I*Rs)/Rsh - I
 * 在 V>=0、参数物理合法时 f 对 I 严格单调递减，恰有一个根，根位于正常发电象限 I>=0。
 */

export function validateParams(p: Partial<DiodeParams>): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const finite = (x: unknown): x is number =>
    typeof x === 'number' && Number.isFinite(x);

  if (!finite(p.iPh)) issues.push({ field: 'iPh', message: 'iPh 必须为有限数值' });
  else if (p.iPh < 0) issues.push({ field: 'iPh', message: 'iPh 必须 >= 0（光生电流不可为负）' });

  if (!finite(p.i0)) issues.push({ field: 'i0', message: 'i0 必须为有限数值' });
  else if (p.i0 <= 0) issues.push({ field: 'i0', message: 'i0 必须 > 0（反向饱和电流严格为正）' });

  if (!finite(p.rs)) issues.push({ field: 'rs', message: 'rs 必须为有限数值' });
  else if (p.rs < 0) issues.push({ field: 'rs', message: 'rs 必须 >= 0（串联电阻不可为负，可为零）' });

  if (!finite(p.rSh)) issues.push({ field: 'rSh', message: 'rSh 必须为有限数值' });
  else if (p.rSh <= 0) issues.push({ field: 'rSh', message: 'rSh 必须 > 0（并联电阻严格为正）' });

  if (!finite(p.nVt)) issues.push({ field: 'nVt', message: 'nVt 必须为有限数值' });
  else if (p.nVt <= 0) issues.push({ field: 'nVt', message: 'nVt 必须 > 0（二极管电压尺度严格为正）' });

  return issues;
}

/**
 * 稳定指数计算。对 expm1(x) 做显式溢出诊断：
 * 当指数参数超过阈值时返回溢出标志，绝不通过裁剪（clamp）伪造一个有限结果。
 */
function stableExpm1(
  x: number,
  tol: SolveTolerances
): { value: number } | { overflow: true } {
  if (!Number.isFinite(x)) return { overflow: true };
  if (x > tol.expArgMax) return { overflow: true };
  // x <= 0 时 expm1 天然稳定；0<x<=700 无 IEEE 上溢。
  return { value: Math.expm1(x) };
}

/**
 * 残差函数 f(I; V)。返回数值，或返回状态（溢出/非有限）。
 */
export function residual(
  p: DiodeParams,
  v: number,
  i: number,
  tol: SolveTolerances
): number | PointStatus {
  const vj = v + i * p.rs;
  if (!Number.isFinite(vj)) return 'nonfinite';
  const arg = vj / p.nVt;
  const ex = stableExpm1(arg, tol);
  if ('overflow' in ex) return 'exp_overflow';
  const f = p.iPh - p.i0 * ex.value - vj / p.rSh - i;
  return Number.isFinite(f) ? f : 'nonfinite';
}

interface SolveOut {
  i: number | null;
  residual: number | null;
  status: PointStatus;
  iterations: number;
}

/** Rs = 0 时电流可直接解析计算（基准路径）。 */
function solveDirect(p: DiodeParams, v: number, tol: SolveTolerances): SolveOut {
  const ex = stableExpm1(v / p.nVt, tol);
  if ('overflow' in ex) return { i: null, residual: null, status: 'exp_overflow', iterations: 0 };
  const i = p.iPh - p.i0 * ex.value - v / p.rSh;
  if (!Number.isFinite(i)) return { i: null, residual: null, status: 'nonfinite', iterations: 0 };
  const r = residual(p, v, i, tol);
  if (typeof r !== 'number') return { i: null, residual: null, status: r, iterations: 0 };
  return { i, residual: r, status: 'rs_zero_direct', iterations: 0 };
}

/**
 * 在给定电压下求电流。使用有区间保障的二分法：
 * f 对 I 严格单调递减，搜索区间 [lo, hi] 需满足 f(lo)>=0、f(hi)<=0。
 * 下界 lo=0（正常发电象限）；上界从 iPh 出发倍增，直到 f(hi)<=0 或预算耗尽。
 */
export function solveCurrent(
  p: DiodeParams,
  v: number,
  tol: SolveTolerances
): SolveOut {
  if (!Number.isFinite(v)) {
    return { i: null, residual: null, status: 'nonfinite', iterations: 0 };
  }
  if (p.rs === 0) return solveDirect(p, v, tol);

  const evalF = (i: number): number | PointStatus => residual(p, v, i, tol);

  const fLo = evalF(0);
  if (typeof fLo !== 'number') return { i: null, residual: null, status: fLo, iterations: 0 };
  // f(0) 是 I=0 时的供给余量。Voc 由独立二分数值求得（带容差），
  // 在 V≈Voc 处 f(0) 可能是微小负值：只要 |f(0)| 在根容差内，
  // 物理根就是 I=0（开路端点）；只有显著为负才说明电压越出有效范围。
  if (fLo <= 0) {
    // Voc 附近 I(V) 对 V 极敏感（二极管指数斜率），双精度下电压根的残差
    // 天然只能到约 1e-9 A 量级；相对光生电流 1e-8 以内即视为开路端点 I=0。
    const nearZeroTol = 1e-8 * Math.max(1, p.iPh);
    if (Math.abs(fLo) <= nearZeroTol) {
      return { i: 0, residual: fLo, status: 'converged', iterations: 0 };
    }
    return { i: null, residual: null, status: 'no_bracket', iterations: 0 };
  }

  // 建立上界：iPh 处 f 通常已经 <= 0（因二极管/漏电项非负）。
  let hi = Math.max(p.iPh, Number.MIN_VALUE);
  let fHi = evalF(hi);
  let expansions = 0;
  while (typeof fHi === 'number' && fHi > 0) {
    if (expansions >= tol.bracketMaxExpansion) {
      return { i: null, residual: null, status: 'no_bracket', iterations: expansions };
    }
    hi *= 2;
    expansions += 1;
    fHi = evalF(hi);
  }
  if (typeof fHi !== 'number') {
    return { i: null, residual: null, status: fHi, iterations: expansions };
  }

  let lo = 0;
  let fLoVal = fLo;
  let iter = 0;
  const widthTol = Math.max(tol.rootAbsTol, tol.rootRelTol * Math.max(1, p.iPh));

  while (iter < tol.rootMaxIter) {
    const mid = 0.5 * (lo + hi);
    const fMid = evalF(mid);
    if (typeof fMid !== 'number') {
      return { i: null, residual: null, status: fMid, iterations: iter };
    }
    iter += 1;
    if (fMid > 0) {
      lo = mid;
      fLoVal = fMid;
    } else {
      hi = mid;
    }
    if (hi - lo <= widthTol) {
      const iStar = 0.5 * (lo + hi);
      const r = evalF(iStar);
      if (typeof r !== 'number') {
        return { i: null, residual: null, status: r, iterations: iter };
      }
      if (Math.abs(r) <= tol.rootAbsTol) {
        return { i: iStar, residual: r, status: 'converged', iterations: iter };
      }
    }
  }

  // 预算耗尽：报告诊断，不用裁剪零电流冒充收敛。
  const iStar = 0.5 * (lo + hi);
  const r = evalF(iStar);
  return {
    i: null,
    residual: typeof r === 'number' ? r : null,
    status: 'budget_exhausted',
    iterations: iter,
  };
}

/** 单点校核的对外封装，附带功率与范围检查由调用方完成。 */
export function solvePoint(
  p: DiodeParams,
  v: number,
  vOc: number,
  tol: SolveTolerances
): SinglePointResult {
  if (v < 0 || v > vOc) {
    return { v, i: null, p: null, residual: null, status: 'out_of_valid_range', iterations: 0 };
  }
  const out = solveCurrent(p, v, tol);
  return {
    v,
    i: out.i,
    p: out.i !== null ? v * out.i : null,
    residual: out.residual,
    status: out.status,
    iterations: out.iterations,
  };
}
