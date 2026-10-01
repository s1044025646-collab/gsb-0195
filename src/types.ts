// 公共类型定义。
// 单位约定（全部为 SI 单位，单体电池或等效器件级别）：
// 电流 I：安培 A（正常发电象限 I >= 0，方向取流出器件为正）
// 电压 V：伏特 V（正常发电象限 V >= 0）
// 功率 P：瓦特 W（P = V * I，发电时 P >= 0）
// 电阻：欧姆 Ω；电压尺度 nVt：伏特 V

/** 五参数：各工况直接给定，不做拟合、不做温度外推。 */
export interface DiodeParams {
  /** 光生电流 Iph，单位 A，范围 [0, +∞) */
  iPh: number;
  /** 反向饱和电流 I0，单位 A，范围 (0, +∞) */
  i0: number;
  /** 串联电阻 Rs，单位 Ω，范围 [0, +∞)（允许为零） */
  rs: number;
  /** 并联（漏电流）电阻 Rsh，单位 Ω，范围 (0, +∞) */
  rSh: number;
  /** 等效二极管电压尺度 nVt = n*k*T/q（理想因子×热电压），单位 V，范围 (0, +∞) */
  nVt: number;
}

export interface SolveTolerances {
  /** 根求解电流残差容差，单位 A */
  rootAbsTol: number;
  /** 根求解相对容差 */
  rootRelTol: number;
  /** 最大二分迭代次数（预算） */
  rootMaxIter: number;
  /** MPP 优化区间相对宽度停止阈值 */
  mppXtol: number;
  /** MPP 最大黄金分割迭代次数 */
  mppMaxIter: number;
  /** 指数参数上限，超过则判溢出，不裁剪 */
  expArgMax: number;
  /** Voc 括号搜索最大倍增次数 */
  bracketMaxExpansion: number;
}

/** 容差（算法）版本：任何变更都会冻结到数据库记录中。 */
export const TOLERANCE_VERSION = 'tol-1.0.0';

export const DEFAULT_TOLERANCES: SolveTolerances = {
  rootAbsTol: 1e-11,
  rootRelTol: 1e-12,
  rootMaxIter: 200,
  mppXtol: 1e-9,
  mppMaxIter: 200,
  expArgMax: 700,
  bracketMaxExpansion: 200,
};

/** 单点求解状态码。 */
export type PointStatus =
  | 'converged' // 收敛且残差达标
  | 'rs_zero_direct' // Rs=0 解析直算
  | 'nonfinite' // 出现非有限值
  | 'exp_overflow' // 指数上溢
  | 'no_bracket' // 无法建立含根区间
  | 'budget_exhausted' // 迭代预算耗尽仍未达容差
  | 'out_of_valid_range'; // 电压超出 [0, Voc] 有效范围

export interface CurvePoint {
  /** 索引 */
  index: number;
  /** 电压 V */
  v: number;
  /** 电流 I（A），失败时为 null */
  i: number | null;
  /** 功率 P = V*I（W），失败时为 null */
  p: number | null;
  /** 独立代入核对方程残差 f(I;V)，单位 A，失败时为 null */
  residual: number | null;
  /** 求解状态 */
  status: PointStatus;
  /** 实际迭代次数 */
  iterations: number;
}

export interface SinglePointResult {
  v: number;
  i: number | null;
  p: number | null;
  residual: number | null;
  status: PointStatus;
  iterations: number;
}

export interface MppResult {
  vMpp: number;
  iMpp: number;
  pMpp: number;
  /** 最优点功率附近的驻点最优性残差 |dP/dV| = |I + V*dI/dV|，单位 W/V=A */
  optimalityResidual: number;
  iterations: number;
  /** 停止原因 */
  stopReason: 'xtol_reached' | 'budget_exhausted' | 'degenerate_interval';
  /** 端点检查 */
  endpoints: {
    v0: { v: number; i: number; p: number };
    vOc: { v: number; i: number; p: number };
  };
}

export interface CurveResult {
  /** 有效电压范围 [0, Voc]，单位 V */
  validRange: { vMin: number; vOc: number };
  /** 短路电流，单位 A（在 V=0 处隐式求解，不等于直接取 Iph） */
  iShortCircuit: number;
  /** 开路电压，单位 V */
  vOpenCircuit: number;
  points: CurvePoint[];
  mpp: MppResult;
  /** 填充因子 FF = Pmpp / (Isc*Voc) */
  fillFactor: number;
  /** 采样点数 */
  sampleCount: number;
  /** 是否所有点均收敛 */
  allConverged: boolean;
}

export interface ValidationIssue {
  field: string;
  message: string;
}
