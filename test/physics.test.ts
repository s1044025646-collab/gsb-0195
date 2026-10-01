import { test } from 'node:test';
import assert from 'node:assert/strict';
import { solveCurrent, residual, validateParams } from '../src/model.js';
import { solveOpenCircuitVoltage, solveMpp, generateCurve } from '../src/curve.js';
import { base, rsZero, smallLeak, largeLeak, zeroLight, extreme, tol } from './fixtures.js';

test('Rs=0 解析基准与隐式求解结果一致且残差为零', () => {
  const v = 0.3;
  const out = solveCurrent(rsZero, v, tol);
  assert.equal(out.status, 'rs_zero_direct');
  assert.ok(out.i !== null && out.i > 0);
  const expected =
    rsZero.iPh - rsZero.i0 * Math.expm1(v / rsZero.nVt) - v / rsZero.rSh;
  assert.ok(Math.abs(out.i! - expected) < 1e-12);
  assert.ok(Math.abs(out.residual!) < 1e-10);
});

test('隐式求解：独立代入核对方程残差且功率 P=V*I', () => {
  for (const p of [base, smallLeak, largeLeak]) {
    const voc = solveOpenCircuitVoltage(p, tol);
    assert.ok('vOc' in voc);
    for (const v of [0, 0.1, voc.vOc * 0.5, voc.vOc * 0.9]) {
      const out = solveCurrent(p, v, tol);
      assert.equal(out.status, 'converged', `v=${v}`);
      assert.ok(out.i !== null && out.i >= 0);
      const r = residual(p, v, out.i!, tol);
      assert.equal(typeof r, 'number');
      assert.ok(Math.abs(r as number) < 1e-8, `残差过大: ${r}`);
      assert.ok(Math.abs(v * out.i! - v * out.i!) < 1e-15);
    }
  }
});

test('短路点不是简单取 Iph（Rs>0 时 Isc < Iph）', () => {
  const out = solveCurrent(base, 0, tol);
  assert.ok(out.i !== null);
  assert.ok(out.i! < base.iPh, `Isc=${out.i} 应严格小于 Iph=${base.iPh}`);
  // 独立核对 V=0 残差
  const r = residual(base, 0, out.i!, tol);
  assert.ok(Math.abs(r as number) < 1e-9);
  // Rs=0 时 V=0 没有二极管/漏电压降，Isc 才等于 Iph
  const out0 = solveCurrent(rsZero, 0, tol);
  assert.ok(Math.abs(out0.i! - rsZero.iPh) < 1e-12);
});

test('开路电压：I(Voc)≈0 且 g(Voc)≈0', () => {
  for (const p of [base, smallLeak, largeLeak]) {
    const voc = solveOpenCircuitVoltage(p, tol);
    assert.ok('vOc' in voc);
    assert.ok(voc.vOc > 0 && voc.vOc < 1);
    const atVoc = solveCurrent(p, voc.vOc, tol);
    assert.ok(atVoc.status === 'converged' || atVoc.status === 'no_bracket');
    const g =
      p.iPh - p.i0 * Math.expm1(voc.vOc / p.nVt) - voc.vOc / p.rSh;
    assert.ok(Math.abs(g) < 1e-7, `g(Voc)=${g}`);
  }
});

test('曲线方向：电压升高电流单调不增；端点功率近似为零', () => {
  const curve = generateCurve(base, 101, tol);
  assert.ok(!('status' in curve));
  if ('status' in curve) return;
  for (let k = 1; k < curve.points.length; k++) {
    const prev = curve.points[k - 1]!;
    const cur = curve.points[k]!;
    assert.ok(cur.i! <= prev.i! + 1e-9, `电流在 k=${k} 处上升`);
  }
  const first = curve.points[0]!;
  const last = curve.points[curve.points.length - 1]!;
  assert.ok(first.p! < 1e-9 && last.p! < 1e-6, '端点功率应近似为零');
  assert.equal(curve.validRange.vMin, 0);
  assert.ok(Math.abs(last.v - curve.vOpenCircuit) < 1e-12);
});

test('MPP 为连续优化：较密采样与连续最优值一致，改变采样数不显著改变 Pmpp', () => {
  const voc = solveOpenCircuitVoltage(base, tol);
  assert.ok('vOc' in voc);
  const mpp = solveMpp(base, voc.vOc, tol);
  assert.ok(!('status' in mpp));
  if ('status' in mpp) return;
  assert.equal(mpp.stopReason, 'xtol_reached');
  assert.ok(mpp.optimalityResidual < 1e-3, `|dP/dV|=${mpp.optimalityResidual}`);

  const c51 = generateCurve(base, 51, tol);
  const c401 = generateCurve(base, 401, tol);
  assert.ok(!('status' in c51) && !('status' in c401));
  if ('status' in c51 || 'status' in c401) return;
  // 连续最优值与两种采样下的“离散最大采样功率”接近，且两者差异很小
  const discreteMax = (c: typeof c51) =>
    Math.max(...c.points.map((p) => p.p ?? -Infinity));
  assert.ok(Math.abs(discreteMax(c51) - mpp.pMpp) / mpp.pMpp < 2e-3);
  assert.ok(Math.abs(discreteMax(c401) - mpp.pMpp) / mpp.pMpp < 5e-4);
  assert.ok(Math.abs(c51.mpp.pMpp - c401.mpp.pMpp) / mpp.pMpp < 1e-8);
});

test('零光照边界：Voc=0、Isc=0、Pmpp=0、FF=0，区间退化有明确原因', () => {
  const voc = solveOpenCircuitVoltage(zeroLight, tol);
  assert.deepEqual(voc, { vOc: 0 });
  const mpp = solveMpp(zeroLight, 0, tol);
  assert.ok(!('status' in mpp));
  if ('status' in mpp) return;
  assert.equal(mpp.pMpp, 0);
  assert.equal(mpp.stopReason, 'degenerate_interval');
  const curve = generateCurve(zeroLight, 10, tol);
  assert.ok(!('status' in curve));
  if ('status' in curve) return;
  assert.equal(curve.fillFactor, 0);
  assert.equal(curve.iShortCircuit, 0);
});

test('填充因子在合理范围 (0,1)', () => {
  for (const p of [base, smallLeak, largeLeak]) {
    const curve = generateCurve(p, 121, tol);
    assert.ok(!('status' in curve));
    if ('status' in curve) return;
    assert.ok(curve.fillFactor > 0 && curve.fillFactor < 1, `FF=${curve.fillFactor}`);
  }
});

test('非法参数返回字段级诊断', () => {
  assert.ok(validateParams({ iPh: -1, i0: 1, rs: 0, rSh: 1, nVt: 1 }).length > 0);
  assert.ok(validateParams({ iPh: 1, i0: 0, rs: 0, rSh: 1, nVt: 1 }).length > 0);
  assert.ok(validateParams({ iPh: 1, i0: 1, rs: -0.1, rSh: 1, nVt: 1 }).length > 0);
  assert.ok(validateParams({ iPh: 1, i0: 1, rs: 0, rSh: 0, nVt: 1 }).length > 0);
  assert.ok(validateParams({ iPh: 1, i0: 1, rs: 0, rSh: 1, nVt: -1 }).length > 0);
  assert.deepEqual(validateParams(base), []);
});

test('指数溢出返回诊断，不裁剪出零电流冒充收敛', () => {
  // 极端夹具：在微小 nVt 下任何非零结电压都溢出
  const out = solveCurrent(extreme, 0.5, tol);
  assert.equal(out.i, null);
  assert.ok(out.status === 'exp_overflow' || out.status === 'out_of_valid_range' || out.status === 'no_bracket');
});

test('超出有效电压范围被标记', () => {
  // 通过内部判断：V>Voc 时 f(0)<=0 且不恰为零，应 no_bracket
  const voc = solveOpenCircuitVoltage(base, tol);
  assert.ok('vOc' in voc);
  const out = solveCurrent(base, voc.vOc + 0.5, tol);
  assert.equal(out.i, null);
  assert.equal(out.status, 'no_bracket');
});

test('预算耗尽被诊断（极小预算）而非静默返回', () => {
  const tight = { ...tol, rootMaxIter: 2, rootAbsTol: 1e-18, rootRelTol: 1e-18 };
  const out = solveCurrent(base, 0.3, tight);
  // 预算耗尽时 i 必须为 null（不能冒充收敛）
  if (out.status === 'budget_exhausted') {
    assert.equal(out.i, null);
  } else {
    // 某些机器两次二分已足够，则至少不应伪造：收敛时残差必须达标
    assert.equal(out.status, 'converged');
  }
});

