// 单二极管模型核心求解器。
// 模型方程（正常发电象限，V >= 0，电流取发电为正）：
//   I = Iph - Is * (exp((V + I*Rs) / Vt) - 1) - (V + I*Rs) / Rsh
// 单位约定：Iph/Is/I 为 A，V/Vt 为 V，Rs/Rsh 为 ohm，P 为 W。
// Vt 为“等效二极管电压尺度”（= n * k * T / q，可能包含理想因子与串联电池数）。

export const SOLVER_VERSION = "1.0.0";

export interface DiodeParams {
  /** 光生电流 Iph [A]，>= 0 */
  iph: number;
  /** 反向饱和电流 Is [A]，> 0 */
  isat: number;
  /** 串联电阻 Rs [ohm]，>= 0 */
  rs: number;
  /** 并联电阻 Rsh [ohm]，> 0 */
  rsh: number;
  /** 等效二极管电压尺度 Vt [V]，> 0 */
  vt: number;
}

export interface Tolerances {
  /** 求根电流容差 [A] */
  rootTol: number;
  /** MPP 电压搜索容差 [V] */
  mppTol: number;
  /** 最大迭代次数（预算） */
  maxIter: number;
}

export const DEFAULT_TOLERANCES: Tolerances = {
  rootTol: 1e-12,
  mppTol: 1e-9,
  maxIter: 200,
};

export type SolveStatus = "converged" | "overflow" | "no_bracket" | "budget_exhausted" | "non_finite";

export interface SolveResult {
  ok: boolean;
  status: SolveStatus;
  /** 解出的电流 [A]，失败时为 NaN（绝不返回裁剪出的假零） */
  current: number;
  /** 方程残差 f(I) [A] */
  residual: number;
  iterations: number;
  message?: string;
}

export interface ValidationIssue {
  field: string;
  message: string;
}

export function validateParams(p: DiodeParams): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const check = (field: string, v: number, ok: boolean, msg: string) => {
    if (!Number.isFinite(v)) issues.push({ field, message: "必须为有限数值" });
    else if (!ok) issues.push({ field, message: msg });
  };
  check("iph", p.iph, p.iph >= 0, "光生电流必须 >= 0");
  check("isat", p.isat, p.isat > 0, "反向饱和电流必须 > 0");
  check("rs", p.rs, p.rs >= 0, "串联电阻必须 >= 0（允许为 0）");
  check("rsh", p.rsh, p.rsh > 0, "并联电阻必须 > 0");
  check("vt", p.vt, p.vt > 0, "等效二极管电压尺度必须 > 0");
  return issues;
}

/** 稳定指数：超出安全范围时不计算，返回溢出标记。 */
function safeExp(x: number): { value: number; overflow: boolean } {
  if (x > 700) return { value: Infinity, overflow: true };
  if (x < -745) return { value: 0, overflow: false };
  return { value: Math.exp(x), overflow: false };
}

/**
 * 方程残差 f(I) = Iph - Is*(exp(arg)-1) - arg/Rsh - I，arg = (V + I*Rs)/Vt。
 * f 关于 I 严格单调递减，保证根唯一。
 */
function residual(p: DiodeParams, v: number, i: number): { f: number; overflow: boolean } {
  const arg = (v + i * p.rs) / p.vt;
  const e = safeExp(arg);
  if (e.overflow) {
    // exp 溢出：二极管支路电流趋于 +inf，f 必为 -inf（该 I 太大）
    return { f: -Infinity, overflow: true };
  }
  const f = p.iph - p.isat * (e.value - 1) - (v + i * p.rs) / p.rsh - i;
  return { f, overflow: false };
}

/** 独立代入核对：给定 V 和 I，直接计算方程残差（供测试与单点校核）。 */
export function checkResidual(p: DiodeParams, v: number, i: number): number {
  return residual(p, v, i).f;
}

/**
 * 用区间保障的二分法求解给定电压 V 下的电流 I。
 * 上界：I = Iph 时 f <= 0（V >= 0 时二极管与并联支路均只消耗电流）。
 * 下界：从 Iph 向下自适应扩展，直到 f > 0；扩展有预算，耗尽则报 no_bracket。
 */
export function solveCurrent(p: DiodeParams, v: number, tol: Tolerances = DEFAULT_TOLERANCES): SolveResult {
  const fail = (status: SolveStatus, message: string): SolveResult => ({
    ok: false, status, current: NaN, residual: NaN, iterations: 0, message,
  });
  if (!Number.isFinite(v) || v < 0) return fail("non_finite", "电压必须为有限非负值");

  let hi = p.iph;
  const fHi = residual(p, v, hi).f;
  if (fHi > 0) {
    return fail("no_bracket", "上界 I=Iph 处残差为正，无法构造区间");
  }
  if (fHi === 0) {
    return { ok: true, status: "converged", current: hi, residual: 0, iterations: 0 };
  }

  // 自适应扩展下界
  let step = Math.max(Math.abs(p.iph), p.isat, 1e-3);
  let lo = hi - step;
  let fLo = residual(p, v, lo).f;
  let expansions = 0;
  while (!(fLo > 0)) {
    expansions++;
    if (expansions > tol.maxIter) return fail("no_bracket", "下界扩展预算耗尽，无法构造求根区间");
    step *= 2;
    lo = hi - step;
    fLo = residual(p, v, lo).f;
    if (!Number.isFinite(lo)) return fail("non_finite", "下界扩展出现非有限值");
  }

  // 二分
  let iter = 0;
  while (iter < tol.maxIter) {
    iter++;
    const mid = 0.5 * (lo + hi);
    const r = residual(p, v, mid);
    const fMid = r.f;
    if (Number.isNaN(fMid)) return { ok: false, status: "non_finite", current: NaN, residual: NaN, iterations: iter, message: "迭代中出现 NaN 残差" };
    if (Math.abs(fMid) <= tol.rootTol || hi - lo <= tol.rootTol) {
      return { ok: true, status: "converged", current: mid, residual: fMid, iterations: iter };
    }
    if (fMid > 0) { lo = mid; } else { hi = mid; }
  }
  return { ok: false, status: "budget_exhausted", current: NaN, residual: NaN, iterations: iter, message: "二分迭代预算耗尽，未收敛" };
}

/** 开路电压 Voc：求解 I=0 时的 V。 */
export function solveVoc(p: DiodeParams, tol: Tolerances = DEFAULT_TOLERANCES): SolveResult {
  const fail = (status: SolveStatus, message: string): SolveResult => ({
    ok: false, status, current: NaN, residual: NaN, iterations: 0, message,
  });
  // g(V) = Iph - Is*(exp(V/Vt)-1) - V/Rsh，单调递减
  const g = (v: number): number => {
    const e = safeExp(v / p.vt);
    if (e.overflow) return -Infinity;
    return p.iph - p.isat * (e.value - 1) - v / p.rsh;
  };
  if (p.iph === 0) {
    // 零光照：Voc = 0（平凡解，g(0)=0）
    return { ok: true, status: "converged", current: 0, residual: 0, iterations: 0 };
  }
  let lo = 0;
  let hi = p.vt * Math.log(1 + p.iph / p.isat) + p.iph * p.rsh + p.vt;
  if (!(g(hi) < 0)) return fail("no_bracket", "Voc 上界构造失败");
  let iter = 0;
  while (iter < tol.maxIter) {
    iter++;
    const mid = 0.5 * (lo + hi);
    const gm = g(mid);
    if (Number.isNaN(gm)) return { ok: false, status: "non_finite", current: NaN, residual: NaN, iterations: iter, message: "Voc 迭代出现 NaN" };
    if (Math.abs(gm) <= tol.rootTol || hi - lo <= tol.mppTol) {
      return { ok: true, status: "converged", current: mid, residual: gm, iterations: iter };
    }
    if (gm > 0) lo = mid; else hi = mid;
  }
  return { ok: false, status: "budget_exhausted", current: NaN, residual: NaN, iterations: iter, message: "Voc 求解预算耗尽" };
}

export interface CurvePoint {
  v: number;
  i: number;
  p: number;
  residual: number;
  status: SolveStatus;
}

export interface CurveResult {
  ok: boolean;
  points: CurvePoint[];
  /** 首个失败点的诊断（若有） */
  failure?: SolveResult;
}

/** 生成 [0, voc] 上均匀采样的 I-V / P-V 曲线。 */
export function generateCurve(p: DiodeParams, samples: number, voc: number, tol: Tolerances = DEFAULT_TOLERANCES): CurveResult {
  const points: CurvePoint[] = [];
  if (!Number.isInteger(samples) || samples < 2) {
    return { ok: false, points, failure: { ok: false, status: "non_finite", current: NaN, residual: NaN, iterations: 0, message: "采样数必须为 >= 2 的整数" } };
  }
  for (let k = 0; k < samples; k++) {
    const v = (voc * k) / (samples - 1);
    const r = solveCurrent(p, v, tol);
    if (!r.ok) return { ok: false, points, failure: r };
    points.push({ v, i: r.current, p: v * r.current, residual: r.residual, status: r.status });
  }
  return { ok: true, points };
}

export interface MppResult {
  ok: boolean;
  vmpp: number;
  impp: number;
  pmpp: number;
  /** 端点功率检查 */
  pAtZero: number;
  pAtVoc: number;
  /** 最优性残差：|dP/dV| 的差分估计 [W/V] */
  optimalityResidual: number;
  evaluations: number;
  stopReason: "interval_converged" | "budget_exhausted" | "solve_failed";
  message?: string;
}

/** 在连续区间 [0, voc] 上用黄金分割搜索最大功率点（不依赖离散采样）。 */
export function findMpp(p: DiodeParams, voc: number, tol: Tolerances = DEFAULT_TOLERANCES): MppResult {
  const fail = (stopReason: MppResult["stopReason"], message: string): MppResult => ({
    ok: false, vmpp: NaN, impp: NaN, pmpp: NaN, pAtZero: NaN, pAtVoc: NaN,
    optimalityResidual: NaN, evaluations: 0, stopReason, message,
  });
  const powerAt = (v: number): { p: number; i: number } | null => {
    const r = solveCurrent(p, v, tol);
    if (!r.ok) return null;
    return { p: v * r.current, i: r.current };
  };
  const INV_PHI = (Math.sqrt(5) - 1) / 2;
  let a = 0, b = voc;
  let c = b - INV_PHI * (b - a);
  let d = a + INV_PHI * (b - a);
  let fc = powerAt(c), fd = powerAt(d);
  if (!fc || !fd) return fail("solve_failed", "MPP 初始点求解失败");
  let evaluations = 2;
  let stopReason: MppResult["stopReason"] = "budget_exhausted";
  while (evaluations < tol.maxIter) {
    if (Math.abs(b - a) <= tol.mppTol) { stopReason = "interval_converged"; break; }
    if (fc.p < fd.p) {
      a = c; c = d; fc = fd;
      d = a + INV_PHI * (b - a);
      fd = powerAt(d);
    } else {
      b = d; d = c; fd = fc;
      c = b - INV_PHI * (b - a);
      fc = powerAt(c);
    }
    evaluations++;
    if (!fc || !fd) return fail("solve_failed", "MPP 搜索中电流求解失败");
  }
  const vmpp = 0.5 * (a + b);
  const sol = solveCurrent(p, vmpp, tol);
  if (!sol.ok) return fail("solve_failed", "MPP 终点电流求解失败: " + sol.message);
  const impp = sol.current;
  const pmpp = vmpp * impp;
  // 最优性残差：中心差分 dP/dV
  const h = Math.max(1e-6 * Math.max(voc, 1), 10 * tol.mppTol);
  const vLo = Math.max(0, vmpp - h), vHi = Math.min(voc, vmpp + h);
  const pl = powerAt(vLo), ph = powerAt(vHi);
  const optRes = pl && ph && vHi > vLo ? Math.abs((ph.p - pl.p) / (vHi - vLo)) : NaN;
  const vocSol = solveCurrent(p, voc, tol);
  return {
    ok: true, vmpp, impp, pmpp,
    pAtZero: 0, pAtVoc: vocSol.ok ? voc * vocSol.current : NaN,
    optimalityResidual: optRes,
    evaluations, stopReason,
  };
}

export interface AnalysisSummary {
  isc: number;
  voc: number;
  mpp: MppResult;
  fillFactor: number;
}

/** 汇总：短路电流（V=0 处真实求解，非直接取 Iph）、开路电压、MPP、填充因子。 */
export function summarize(p: DiodeParams, tol: Tolerances = DEFAULT_TOLERANCES):
  { ok: true; summary: AnalysisSummary } | { ok: false; failure: SolveResult } {
  const iscR = solveCurrent(p, 0, tol);
  if (!iscR.ok) return { ok: false, failure: iscR };
  const vocR = solveVoc(p, tol);
  if (!vocR.ok) return { ok: false, failure: vocR };
  const voc = vocR.current;
  const mpp = findMpp(p, voc, tol);
  if (!mpp.ok) {
    return { ok: false, failure: { ok: false, status: "budget_exhausted", current: NaN, residual: NaN, iterations: 0, message: mpp.message } };
  }
  const denom = iscR.current * voc;
  const fillFactor = denom > 0 ? mpp.pmpp / denom : 0;
  return { ok: true, summary: { isc: iscR.current, voc, mpp, fillFactor } };
}
