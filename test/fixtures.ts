import { DiodeParams, DEFAULT_TOLERANCES, SolveTolerances } from '../src/types.js';

export const tol: SolveTolerances = { ...DEFAULT_TOLERANCES };

// 典型单体/等效器件量级（教学用，非真实组件拟合值）。
export const base: DiodeParams = {
  iPh: 3.6,
  i0: 2.0e-9,
  rs: 0.02,
  rSh: 1000,
  nVt: 0.025,
};

// Rs=0 解析基准
export const rsZero: DiodeParams = { ...base, rs: 0 };

// 小漏电（Rsh 很大）
export const smallLeak: DiodeParams = { ...base, rs: 0.01, rSh: 5000 };

// 较大漏电（Rsh 较小）
export const largeLeak: DiodeParams = { ...base, rs: 0.05, rSh: 2 };

// 零光照边界
export const zeroLight: DiodeParams = { ...base, iPh: 0 };

// 极端参数：饱和电流极大，导致正常区间内指数极易触发溢出诊断
export const extreme: DiodeParams = { iPh: 1e-6, i0: 1e3, rs: 0, rSh: 1e9, nVt: 1e-9 };

// 强串联损耗
export const highRs: DiodeParams = { ...base, rs: 0.15 };
