import { CurveResult } from './types.js';

export interface CaseCurveRecord {
  caseName: string;
  curve: CurveResult;
}

export interface ComparisonEntry {
  caseName: string;
  iSc: number;
  vOc: number;
  pMpp: number;
  vMpp: number;
  iMpp: number;
  fillFactor: number;
}

export interface ComparisonResult {
  baseline: string;
  entries: ComparisonEntry[];
  /** 以最大功率最大者为基准的相对损失矩阵（分数，非百分比） */
  losses: Array<{ caseName: string; deltaPmppToBest: number; relativeLoss: number }>;
  bestCase: string;
}

/**
 * 比较两组或以上工况。差异来自连续 MPP 优化结果（而非离散采样最大值），
 * 因此改变采样数不会制造虚假的效率提升。
 */
export function compareCurves(records: CaseCurveRecord[]): ComparisonResult {
  if (records.length < 1) throw new Error('比较至少需要一个工况');
  const entries: ComparisonEntry[] = records.map((r) => ({
    caseName: r.caseName,
    iSc: r.curve.iShortCircuit,
    vOc: r.curve.vOpenCircuit,
    pMpp: r.curve.mpp.pMpp,
    vMpp: r.curve.mpp.vMpp,
    iMpp: r.curve.mpp.iMpp,
    fillFactor: r.curve.fillFactor,
  }));

  let best = entries[0]!;
  for (const e of entries) if (e.pMpp > best.pMpp) best = e;

  const losses = entries.map((e) => ({
    caseName: e.caseName,
    deltaPmppToBest: best.pMpp - e.pMpp,
    relativeLoss: best.pMpp > 0 ? (best.pMpp - e.pMpp) / best.pMpp : 0,
  }));

  return {
    baseline: records[0]!.caseName,
    entries,
    losses,
    bestCase: best.caseName,
  };
}
