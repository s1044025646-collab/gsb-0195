// 教学用参数夹具。
import { DiodeParams } from "./physics";

/** 基准：串联电阻为零（电流可直接闭式计算） */
export const RS_ZERO: DiodeParams = { iph: 8.0, isat: 1e-10, rs: 0, rsh: 200, vt: 1.3 };

/** 小漏电（并联电阻大） */
export const LOW_LEAKAGE: DiodeParams = { iph: 8.0, isat: 1e-10, rs: 0.3, rsh: 500, vt: 1.3 };

/** 较大漏电（并联电阻小） */
export const HIGH_LEAKAGE: DiodeParams = { iph: 8.0, isat: 1e-10, rs: 0.3, rsh: 20, vt: 1.3 };

/** 零光照边界 */
export const ZERO_LIGHT: DiodeParams = { iph: 0, isat: 1e-10, rs: 0.3, rsh: 200, vt: 1.3 };

/** 极端但合法的参数（很小的 Vt、很大的 Is） */
export const EXTREME: DiodeParams = { iph: 12.0, isat: 1e-6, rs: 0.01, rsh: 1000, vt: 0.05 };

/** 非法示例：负的并联电阻 */
export const INVALID_SHUNT = { iph: 8.0, isat: 1e-10, rs: 0.3, rsh: -5, vt: 1.3 };
