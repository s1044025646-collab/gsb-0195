import {
  DiodeParams,
  SolveTolerances,
  CurveResult,
  CurvePoint,
  MppResult,
  PointStatus,
} from './types.js';
import { solveCurrent } from './model.js';

/**
 * 开路电压 Voc：I=0 时满足
 *   g(V) = Iph - I0*(expm1(V/nVt)) - V/Rsh = 0
 * g 对 V 严格单调递减（Iph>=0, I0>0, Rsh>0, nVt>0）。
 * 从 0 开始倍增建立含根区间，再二分。零光照时 g(0)=0，Voc=0。
 */
export function solveOpenCircuitVoltage(
  p: DiodeParams,
  tol: SolveTolerances
): { vOc: number } | { status: PointStatus } {
  const g = (v: number): number | PointStatus => {
    if (v / p.nVt > tol.expArgMax) return 'exp_overflow';
    const diode = Math.expm1(v / p.nVt);
    const val = p.iPh - p.i0 * diode - v / p.rSh;
    return Number.isFinite(val) ? val : 'nonfinite';
  };

  const g0 = g(0);
  if (typeof g0 !== 'number') return { status: g0 };
  if (g0 <= 0) {
    // 零光照边界：Iph=0 时 g(0)=0，Voc=0。
    return { vOc: 0 };
  }

  let hi = Math.max(p.nVt, Number.MIN_VALUE);
  let gh = g(hi);
  let expansions = 0;
  while (typeof gh === 'number' && gh > 0) {
    if (expansions >= tol.bracketMaxExpansion) return { status: 'no_bracket' };
    hi *= 2;
    expansions += 1;
    gh = g(hi);
  }
  if (typeof gh !== 'number') return { status: gh };

  let lo = 0;
  let iter = 0;
  while (iter < tol.rootMaxIter) {
    const mid = 0.5 * (lo + hi);
    const gm = g(mid);
    if (typeof gm !== 'number') return { status: gm };
    iter += 1;
    if (gm > 0) lo = mid;
    else hi = mid;
    // Voc 附近 g'(V) 很大，纯宽度收敛后 g 残差可达 ~1e-9 A，这在端点电流
    // 判定（model.ts 中的相对小尺度）内是可接受的。
    if (hi - lo <= tol.rootAbsTol) {
      const vOc = 0.5 * (lo + hi);
      return { vOc };
    }
  }
  return { status: 'budget_exhausted' };
}

/** 在给定电压取功率（供 MPP 优化复用），失败返回 NaN。 */
function powerAt(p: DiodeParams, v: number, tol: SolveTolerances): number {
  const out = solveCurrent(p, v, tol);
  if (out.i === null) return NaN;
  return v * out.i;
}

/**
 * 最大功率点：在连续电压区间 [0, Voc] 上最大化 P(V)=V*I(V)。
 * 使用黄金分割搜索（P(V) 在正常发电象限为单峰凹曲线）。
 * 同时检查两个端点并以中心差分估计最优性残差 |dP/dV|。
 */
export function solveMpp(
  p: DiodeParams,
  vOc: number,
  tol: SolveTolerances
): MppResult | { status: PointStatus } {
  const iScOut = solveCurrent(p, 0, tol);
  if (iScOut.i === null) return { status: iScOut.status };

  const p0 = powerAt(p, 0, tol);
  const pOc = powerAt(p, vOc, tol);
  if (!Number.isFinite(p0) || !Number.isFinite(pOc)) return { status: 'nonfinite' };

  const endpoints = {
    v0: { v: 0, i: iScOut.i, p: p0 },
    vOc: { v: vOc, i: 0, p: pOc },
  };

  // 退化区间（零光照 Voc≈0）：两端点皆为零功率。
  if (vOc <= tol.rootAbsTol) {
    return {
      vMpp: 0,
      iMpp: iScOut.i,
      pMpp: 0,
      optimalityResidual: 0,
      iterations: 0,
      stopReason: 'degenerate_interval',
      endpoints,
    };
  }

  const gr = (Math.sqrt(5) - 1) / 2; // 0.618...
  let a = 0;
  let b = vOc;
  let c = b - gr * (b - a);
  let d = a + gr * (b - a);
  let pc = powerAt(p, c, tol);
  let pd = powerAt(p, d, tol);
  if (!Number.isFinite(pc) || !Number.isFinite(pd)) return { status: 'nonfinite' };

  let iter = 0;
  let stopReason: MppResult['stopReason'] = 'budget_exhausted';
  while (iter < tol.mppMaxIter) {
    iter += 1;
    if (pc > pd) {
      b = d;
      d = c;
      pd = pc;
      c = b - gr * (b - a);
      pc = powerAt(p, c, tol);
    } else {
      a = c;
      c = d;
      pc = pd;
      d = a + gr * (b - a);
      pd = powerAt(p, d, tol);
    }
    if (!Number.isFinite(pc) || !Number.isFinite(pd)) return { status: 'nonfinite' };
    if (Math.abs(b - a) <= tol.mppXtol * Math.max(1, vOc)) {
      stopReason = 'xtol_reached';
      break;
    }
  }

  const vMpp = 0.5 * (a + b);
  const iOut = solveCurrent(p, vMpp, tol);
  if (iOut.i === null) return { status: iOut.status };
  const pMpp = vMpp * iOut.i;

  // 最优性残差 |dP/dV|，中心差分，步长取区间尺度的小量。
  const h = Math.max(1e-7, 1e-6 * vOc);
  const vL = Math.max(0, vMpp - h);
  const vR = Math.min(vOc, vMpp + h);
  const pL = powerAt(p, vL, tol);
  const pR = powerAt(p, vR, tol);
  const optimalityResidual =
    Number.isFinite(pL) && Number.isFinite(pR) && vR > vL
      ? Math.abs((pR - pL) / (vR - vL))
      : NaN;

  return {
    vMpp,
    iMpp: iOut.i,
    pMpp,
    optimalityResidual,
    iterations: iter,
    stopReason,
    endpoints,
  };
}

/** 生成 [0, Voc] 上 sampleCount 个等距（含端点）采样点的曲线。 */
export function generateCurve(
  p: DiodeParams,
  sampleCount: number,
  tol: SolveTolerances
): CurveResult | { status: PointStatus } {
  if (!Number.isInteger(sampleCount) || sampleCount < 2) {
    throw new Error('sampleCount 必须为 >=2 的整数');
  }

  const vocOut = solveOpenCircuitVoltage(p, tol);
  if ('status' in vocOut) return { status: vocOut.status };
  const vOc = vocOut.vOc;

  const iscOut = solveCurrent(p, 0, tol);
  if (iscOut.i === null) return { status: iscOut.status };

  const mppOut = solveMpp(p, vOc, tol);
  if ('status' in mppOut) return { status: mppOut.status };

  const points: CurvePoint[] = [];
  let allConverged = true;
  for (let k = 0; k < sampleCount; k++) {
    const v = sampleCount === 1 ? 0 : (vOc * k) / (sampleCount - 1);
    const out = solveCurrent(p, v, tol);
    const ok = out.i !== null && (out.status === 'converged' || out.status === 'rs_zero_direct');
    if (!ok) allConverged = false;
    points.push({
      index: k,
      v,
      i: out.i,
      p: out.i !== null ? v * out.i : null,
      residual: out.residual,
      status: out.status,
      iterations: out.iterations,
    });
  }

  // 确保端点严格落在 0 与 Voc（消除浮点等分误差）。
  points[0]!.v = 0;
  points[sampleCount - 1]!.v = vOc;

  const denom = iscOut.i * vOc;
  const fillFactor = denom > 0 ? mppOut.pMpp / denom : 0;

  return {
    validRange: { vMin: 0, vOc },
    iShortCircuit: iscOut.i,
    vOpenCircuit: vOc,
    points,
    mpp: mppOut,
    fillFactor,
    sampleCount,
    allConverged,
  };
}
