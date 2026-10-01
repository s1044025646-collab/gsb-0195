import { test } from "node:test";
import assert from "node:assert/strict";
import {
  solveCurrent, solveVoc, findMpp, generateCurve, summarize, checkResidual,
  validateParams, DEFAULT_TOLERANCES,
} from "../src/physics";
import { RS_ZERO, LOW_LEAKAGE, HIGH_LEAKAGE, ZERO_LIGHT, EXTREME } from "../src/fixtures";

test("Rs=0 时与闭式解一致", () => {
  for (const v of [0, 5, 10, 20, 30, 40]) {
    const r = solveCurrent(RS_ZERO, v);
    assert.ok(r.ok);
    // Rs=0 闭式：I = Iph - Is*(exp(V/Vt)-1) - V/Rsh
    const closed = RS_ZERO.iph - RS_ZERO.isat * (Math.exp(v / RS_ZERO.vt) - 1) - v / RS_ZERO.rsh;
    assert.ok(Math.abs(r.current - closed) < 1e-9, `V=${v}: ${r.current} vs ${closed}`);
  }
});

test("独立代入核对：残差接近零，P = V * I", () => {
  for (const p of [LOW_LEAKAGE, HIGH_LEAKAGE, EXTREME]) {
    const voc = solveVoc(p).current;
    for (const v of [0, voc / 3, (2 * voc) / 3, voc]) {
      const r = solveCurrent(p, v);
      assert.ok(r.ok);
      assert.ok(Math.abs(checkResidual(p, v, r.current)) < 1e-9);
      const curve = generateCurve(p, 3, voc);
      assert.ok(curve.ok);
      for (const pt of curve.points) {
        assert.ok(Math.abs(pt.p - pt.v * pt.i) < 1e-12);
      }
    }
  }
});

test("曲线方向：电流随电压单调不增，端点功率为零", () => {
  const voc = solveVoc(LOW_LEAKAGE).current;
  const curve = generateCurve(LOW_LEAKAGE, 100, voc);
  assert.ok(curve.ok);
  for (let k = 1; k < curve.points.length; k++) {
    assert.ok(curve.points[k].i <= curve.points[k - 1].i + 1e-12);
  }
  assert.equal(curve.points[0].p, 0);
  assert.ok(Math.abs(curve.points[curve.points.length - 1].p) < 1e-6);
  // 每个点都在有效电压范围内且求解收敛
  for (const pt of curve.points) {
    assert.ok(pt.v >= 0 && pt.v <= voc + 1e-12);
    assert.equal(pt.status, "converged");
  }
});

test("短路电流不是简单等于 Iph（含并联支路影响）", () => {
  const s = summarize(HIGH_LEAKAGE);
  assert.ok(s.ok);
  assert.ok(s.summary.isc < HIGH_LEAKAGE.iph);
  assert.ok(Math.abs(s.summary.isc - HIGH_LEAKAGE.iph) > 1e-6);
});

test("零光照边界：Isc=Voc=Pmpp=0", () => {
  const s = summarize(ZERO_LIGHT);
  assert.ok(s.ok);
  assert.equal(s.summary.isc, 0);
  assert.equal(s.summary.voc, 0);
  assert.equal(s.summary.mpp.pmpp, 0);
});

test("极端参数夹具可求解", () => {
  const s = summarize(EXTREME);
  assert.ok(s.ok);
  assert.ok(s.summary.mpp.pmpp > 0);
  assert.ok(s.summary.fillFactor > 0 && s.summary.fillFactor <= 1);
});

test("MPP 连续优化：优于任意离散采样点，且与采样数无关", () => {
  const p = LOW_LEAKAGE;
  const voc = solveVoc(p).current;
  const mpp = findMpp(p, voc);
  assert.ok(mpp.ok);
  assert.equal(mpp.stopReason, "interval_converged");
  assert.ok(mpp.optimalityResidual < 1e-3, `最优性残差 ${mpp.optimalityResidual}`);
  assert.ok(mpp.pmpp >= mpp.pAtZero && mpp.pmpp >= mpp.pAtVoc);
  for (const samples of [21, 51, 201, 1001]) {
    const curve = generateCurve(p, samples, voc);
    assert.ok(curve.ok);
    const bestDiscrete = Math.max(...curve.points.map((pt) => pt.p));
    assert.ok(mpp.pmpp >= bestDiscrete - 1e-9, `samples=${samples}`);
    // 改变采样数不应显著改变连续最优值
    assert.ok(Math.abs(mpp.pmpp - bestDiscrete) / mpp.pmpp < 0.01);
  }
});

test("较密采样与连续最优一致：曲线内插逼近 MPP", () => {
  const p = HIGH_LEAKAGE;
  const voc = solveVoc(p).current;
  const mpp = findMpp(p, voc);
  const curve = generateCurve(p, 2001, voc);
  const best = curve.points.reduce((x, y) => (y.p > x.p ? y : x));
  assert.ok(Math.abs(best.p - mpp.pmpp) / mpp.pmpp < 1e-4);
});

test("非法参数校验", () => {
  assert.ok(validateParams({ ...LOW_LEAKAGE, iph: -1 }).length > 0);
  assert.ok(validateParams({ ...LOW_LEAKAGE, isat: 0 }).length > 0);
  assert.ok(validateParams({ ...LOW_LEAKAGE, rs: -0.1 }).length > 0);
  assert.ok(validateParams({ ...LOW_LEAKAGE, rsh: 0 }).length > 0);
  assert.ok(validateParams({ ...LOW_LEAKAGE, vt: -1 }).length > 0);
  assert.ok(validateParams({ ...LOW_LEAKAGE, iph: NaN }).length > 0);
  assert.equal(validateParams({ ...LOW_LEAKAGE, rs: 0 }).length, 0); // Rs=0 合法
});

test("预算耗尽返回诊断而非假收敛", () => {
  const tiny = { ...DEFAULT_TOLERANCES, maxIter: 3 };
  const r = solveCurrent(LOW_LEAKAGE, 20, tiny);
  assert.equal(r.ok, false);
  assert.equal(r.status, "budget_exhausted");
  assert.ok(Number.isNaN(r.current)); // 绝不返回裁剪出的零电流
});

test("非有限输入返回诊断", () => {
  const r = solveCurrent(LOW_LEAKAGE, NaN);
  assert.equal(r.ok, false);
  assert.equal(r.status, "non_finite");
  const r2 = solveCurrent(LOW_LEAKAGE, -5);
  assert.equal(r2.ok, false);
});

test("较大漏电降低 MPP 与填充因子", () => {
  const a = summarize(LOW_LEAKAGE);
  const b = summarize(HIGH_LEAKAGE);
  assert.ok(a.ok && b.ok);
  assert.ok(b.summary.mpp.pmpp < a.summary.mpp.pmpp);
  assert.ok(b.summary.fillFactor < a.summary.fillFactor);
});
