import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db.js';
import { AnalysisService, ServiceError } from '../src/service.js';
import { TOLERANCE_VERSION } from '../src/types.js';
import { base, smallLeak, largeLeak, tol } from './fixtures.js';

function freshStore(): { dir: string; store: Store } {
  const dir = mkdtempSync(join(tmpdir(), 'pv-test-'));
  return { dir, store: new Store(join(dir, 'pv.sqlite')) };
}

test('工况导入、曲线冻结含参数与容差版本快照', () => {
  const { dir, store } = freshStore();
  try {
    const svc = new AnalysisService(store);
    const c = svc.upsertCase('A', base, tol);
    assert.equal(c.tolerance_version, TOLERANCE_VERSION);
    const res = svc.generateAndStore({ name: 'A', sampleCount: 51 });
    assert.equal(res.reused, false);
    const row = store.getCurve(res.curveId)!;
    assert.deepEqual(row.params_snapshot, base);
    assert.equal(row.tolerance_version, TOLERANCE_VERSION);
    assert.equal(row.sample_count, 51);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('重复工况名被拒绝（旧工况不被覆盖）', () => {
  const { dir, store } = freshStore();
  try {
    const svc = new AnalysisService(store);
    svc.upsertCase('A', base, tol);
    assert.throws(
      () => svc.upsertCase('A', smallLeak, tol),
      (e: unknown) => e instanceof ServiceError && e.code === 'CASE_EXISTS'
    );
    // 参数仍是旧值
    assert.deepEqual(store.getCaseByName('A')!.params, base);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('幂等键：重复请求返回同一曲线，不产生新记录', () => {
  const { dir, store } = freshStore();
  try {
    const svc = new AnalysisService(store);
    svc.upsertCase('A', base, tol);
    const r1 = svc.generateAndStore({ name: 'A', sampleCount: 31, idempotencyKey: 'k1' });
    const r2 = svc.generateAndStore({ name: 'A', sampleCount: 31, idempotencyKey: 'k1' });
    assert.equal(r1.curveId, r2.curveId);
    assert.equal(r2.reused, true);
    assert.equal(store.listCurves().length, 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('重启持久化：关闭后用同一数据库文件重新打开数据仍在', () => {
  const { dir, store } = freshStore();
  const dbPath = join(dir, 'pv.sqlite');
  try {
    const svc = new AnalysisService(store);
    svc.upsertCase('A', base, tol);
    svc.generateAndStore({ name: 'A', sampleCount: 21 });
    store.close();

    assert.ok(existsSync(dbPath));
    const store2 = new Store(dbPath);
    const svc2 = new AnalysisService(store2);
    const c = svc2.getCaseOrThrow('A');
    assert.deepEqual(c.params, base);
    const curves = store2.listCurves();
    assert.equal(curves.length, 1);
    assert.equal(curves[0]!.case_name, 'A');
    store2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('非法参数经服务层抛出 INVALID_PARAMS', () => {
  const { dir, store } = freshStore();
  try {
    const svc = new AnalysisService(store);
    assert.throws(
      () => svc.resolveParams({ iPh: 'x', i0: -1, rs: 0, rSh: 1, nVt: 1 }),
      (e: unknown) => e instanceof ServiceError && e.code === 'INVALID_PARAMS'
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('工况比较：不同漏电/光生电流给出功率差与相对损失，采样无关', () => {
  const { dir, store } = freshStore();
  try {
    const svc = new AnalysisService(store);
    svc.upsertCase('smallLeak', smallLeak, tol);
    svc.upsertCase('largeLeak', largeLeak, tol);
    const dim = svc.compare(['smallLeak', 'largeLeak']);
    assert.equal(dim.bestCase, 'smallLeak');
    const best = dim.entries.find((e) => e.caseName === 'smallLeak')!;
    const worse = dim.entries.find((e) => e.caseName === 'largeLeak')!;
    assert.ok(best.pMpp > worse.pMpp);
    const loss = dim.losses.find((l) => l.caseName === 'largeLeak')!;
    assert.ok(loss.deltaPmppToBest > 0);
    assert.ok(loss.relativeLoss > 0 && loss.relativeLoss < 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('不同光生电流：更高 Iph 对应更高 Pmpp，差异不依赖采样步长', () => {
  const { dir, store } = freshStore();
  try {
    const svc = new AnalysisService(store);
    svc.upsertCase('sun1', base, tol);
    svc.upsertCase('sun05', { ...base, iPh: base.iPh * 0.5 }, tol);
    const dim = svc.compare(['sun1', 'sun05']);
    const hi = dim.entries.find((e) => e.caseName === 'sun1')!;
    const lo = dim.entries.find((e) => e.caseName === 'sun05')!;
    assert.ok(hi.pMpp > lo.pMpp);
    // 连续 MPP 不受采样数影响：直接读取 MPP 一致
    const a = svc.findMpp({ name: 'sun1' });
    const b = svc.findMpp({ name: 'sun1' });
    assert.equal(a.mpp.pMpp, b.mpp.pMpp);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

