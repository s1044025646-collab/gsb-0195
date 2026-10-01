import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { AnalysisStore } from "../src/db";
import { PvService } from "../src/service";
import { LOW_LEAKAGE, HIGH_LEAKAGE, INVALID_SHUNT } from "../src/fixtures";

function tmpDb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pv-test-")), "test.sqlite");
}

test("创建分析并冻结参数与版本；重复请求生成独立记录", () => {
  const service = new PvService(new AnalysisStore(":memory:"));
  const a = service.createAnalysis({ name: "x", params: LOW_LEAKAGE, samples: 50 });
  assert.ok(a.ok);
  const b = service.createAnalysis({ name: "x", params: LOW_LEAKAGE, samples: 50 });
  assert.ok(b.ok);
  assert.notEqual(a.id, b.id); // 重复请求不覆盖旧记录
  const rec = service.getAnalysis(a.id);
  assert.ok(rec);
  assert.equal(rec.solverVersion, "1.0.0");
  assert.deepEqual(rec.params, LOW_LEAKAGE);
  assert.equal(rec.curve!.length, 50);
});

test("重启持久化：关闭重开后旧曲线仍在", () => {
  const dbPath = tmpDb();
  let store = new AnalysisStore(dbPath);
  let service = new PvService(store);
  const a = service.createAnalysis({ name: "persist", params: LOW_LEAKAGE, samples: 30 });
  assert.ok(a.ok);
  store.close();

  store = new AnalysisStore(dbPath);
  service = new PvService(store);
  const rec = service.getAnalysis(a.id);
  assert.ok(rec);
  assert.equal(rec.name, "persist");
  assert.equal(rec.curve!.length, 30);
  const list = service.listAnalyses();
  assert.equal(list.length, 1);
  store.close();
});

test("非法参数被拒绝且不写库", () => {
  const service = new PvService(new AnalysisStore(":memory:"));
  const bad = service.createAnalysis({ name: "bad", params: INVALID_SHUNT as any });
  assert.equal(bad.ok, false);
  assert.equal(service.listAnalyses().length, 0);
});

test("单点校核：独立代入残差一致", () => {
  const service = new PvService(new AnalysisStore(":memory:"));
  const a = service.createAnalysis({ name: "pt", params: LOW_LEAKAGE });
  assert.ok(a.ok);
  const pt = service.pointCheck(a.id, 25);
  assert.ok(pt.ok);
  assert.ok(Math.abs(pt.independentResidual) < 1e-9);
  assert.ok(Math.abs(pt.p - pt.v * pt.i) < 1e-12);
});

test("比较两工况：给出 MPP 差异与损耗估计", () => {
  const service = new PvService(new AnalysisStore(":memory:"));
  const a = service.createAnalysis({ name: "A", params: LOW_LEAKAGE });
  const b = service.createAnalysis({ name: "B", params: HIGH_LEAKAGE });
  assert.ok(a.ok && b.ok);
  const cmp = service.compare([a.id, b.id]);
  assert.ok(cmp.ok);
  const pw = cmp.result.pairwise[0];
  assert.ok(pw.deltaPmpp < 0); // B 漏电更大，功率更低
  assert.ok(pw.seriesLossW > 0);
  assert.ok(pw.shuntLossW > 0);
});

test("导出 JSON 与 CSV", () => {
  const service = new PvService(new AnalysisStore(":memory:"));
  const a = service.createAnalysis({ name: "exp", params: LOW_LEAKAGE, samples: 10 });
  assert.ok(a.ok);
  const json = service.exportCurve(a.id, "json");
  assert.ok(json.ok);
  const parsed = JSON.parse(json.content);
  assert.equal(parsed.curve.length, 10);
  const csv = service.exportCurve(a.id, "csv");
  assert.ok(csv.ok);
  const lines = csv.content.trim().split("\n");
  assert.equal(lines.length, 11);
  assert.equal(lines[0], "v_V,i_A,p_W,residual_A,status");
});

test("不存在的 ID 返回错误", () => {
  const service = new PvService(new AnalysisStore(":memory:"));
  assert.equal(service.pointCheck(999, 1).ok, false);
  assert.equal(service.mpp(999).ok, false);
  assert.equal(service.compare([1, 2]).ok, false);
});
