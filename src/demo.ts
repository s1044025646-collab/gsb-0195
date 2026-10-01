// 演示脚本：比较两组工况（不同 Rs / Rsh / Iph）的曲线与 MPP，再展示一个明确失败的输入。
import * as path from "node:path";
import * as fs from "node:fs";
import { AnalysisStore } from "./db";
import { PvService } from "./service";
import { LOW_LEAKAGE, HIGH_LEAKAGE, INVALID_SHUNT } from "./fixtures";

const dataDir = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
fs.mkdirSync(dataDir, { recursive: true });
const store = new AnalysisStore(path.join(dataDir, "pv.sqlite"));
const service = new PvService(store);

console.log("=== 1. 创建工况 A（小漏电，Rs=0.3, Rsh=500） ===");
const a = service.createAnalysis({ name: "demo-A-低损耗", params: LOW_LEAKAGE, samples: 200 });
if (!a.ok) throw new Error(a.error);
console.log(`id=${a.id} Isc=${a.summary.isc.toFixed(4)} A, Voc=${a.summary.voc.toFixed(4)} V, ` +
  `Pmpp=${a.summary.mpp.pmpp.toFixed(3)} W, FF=${a.summary.fillFactor.toFixed(4)}`);

console.log("\n=== 2. 创建工况 B（较大漏电，Rs=0.3, Rsh=20） ===");
const b = service.createAnalysis({ name: "demo-B-高漏电", params: HIGH_LEAKAGE, samples: 200 });
if (!b.ok) throw new Error(b.error);
console.log(`id=${b.id} Isc=${b.summary.isc.toFixed(4)} A, Voc=${b.summary.voc.toFixed(4)} V, ` +
  `Pmpp=${b.summary.mpp.pmpp.toFixed(3)} W, FF=${b.summary.fillFactor.toFixed(4)}`);

console.log("\n=== 3. 比较两组工况 ===");
const cmp = service.compare([a.id, b.id]);
if (cmp.ok) {
  const pw = cmp.result.pairwise[0];
  console.log(`ΔPmpp = ${pwDelta(pw.deltaPmpp)} W (${pw.deltaPmppPct.toFixed(2)}%)`);
  console.log(`工况 A 串联损耗估计 ≈ ${pw.seriesLossW.toFixed(3)} W，并联漏电损耗估计 ≈ ${pw.shuntLossW.toFixed(3)} W`);
  console.log(cmp.result.note);
}
function pwDelta(x: number): string { return x.toFixed(3); }

console.log("\n=== 4. 单点校核（工况 A，V = 30 V） ===");
const pt = service.pointCheck(a.id, 30);
if (pt.ok) {
  console.log(`V=30 V -> I=${pt.i.toFixed(5)} A, P=${pt.p.toFixed(3)} W, 残差=${pt.residual.toExponential(2)}, 独立代入残差=${pt.independentResidual.toExponential(2)}`);
}

console.log("\n=== 5. 明确失败的输入（Rsh = -5） ===");
const bad = service.createAnalysis({ name: "demo-非法", params: INVALID_SHUNT as any });
console.log(JSON.stringify(bad, null, 2));

store.close();
console.log("\n演示完成。");
