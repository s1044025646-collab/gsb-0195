// 端到端演示：导入两组工况 -> 生成曲线 -> 连续 MPP -> 比较 -> 一个明确失败的输入。
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db.js';
import { AnalysisService, ServiceError } from '../src/service.js';
import { curveToCsv } from '../src/exporters.js';
import { DiodeParams } from '../src/types.js';

const dir = mkdtempSync(join(tmpdir(), 'pv-demo-'));
const store = new Store(join(dir, 'pv.sqlite'));
const svc = new AnalysisService(store);

// 工况 A：小漏电；工况 B：较大漏电且串联电阻更高。
const A: DiodeParams = { iPh: 3.6, i0: 2e-9, rs: 0.01, rSh: 5000, nVt: 0.025 };
const B: DiodeParams = { iPh: 3.6, i0: 2e-9, rs: 0.05, rSh: 2, nVt: 0.025 };

svc.upsertCase('smallLeak', A, svc.resolveTolerances());
svc.upsertCase('largeLeak', B, svc.resolveTolerances());

const curveA = svc.generateAndStore({ name: 'smallLeak', sampleCount: 121 });
const curveB = svc.generateAndStore({ name: 'largeLeak', sampleCount: 121 });

function summarize(tag: string, r: ReturnType<AnalysisService['generateAndStore']>) {
  const c = r.curve;
  console.log(`\n[${tag}] curveId=${r.curveId}`);
  console.log(`  Isc = ${c.iShortCircuit.toExponential(6)} A`);
  console.log(`  Voc = ${c.vOpenCircuit.toFixed(6)} V`);
  console.log(`  MPP = (${c.mpp.vMpp.toFixed(6)} V, ${c.mpp.iMpp.toFixed(6)} A)`);
  console.log(`  Pmpp= ${c.mpp.pMpp.toFixed(6)} W`);
  console.log(`  FF  = ${c.fillFactor.toFixed(4)}`);
  console.log(`  最优性残差 |dP/dV| = ${c.mpp.optimalityResidual.toExponential(3)} W/V, 停止=${c.mpp.stopReason}`);
  console.log(`  端点功率 P(0)=${c.mpp.endpoints.v0.p.toExponential(2)}, P(Voc)=${c.mpp.endpoints.vOc.p.toExponential(2)}`);
}

console.log('=== 两组工况的曲线与最大功率对比 ===');
summarize('A 小漏电', curveA);
summarize('B 大漏电', curveB);

const cmp = svc.compare(['smallLeak', 'largeLeak']);
const loss = cmp.losses.find((l) => l.caseName === 'largeLeak')!;
console.log('\n[比较]');
for (const e of cmp.entries) {
  console.log(`  ${e.caseName}: Pmpp=${e.pMpp.toFixed(6)} W, Voc=${e.vOc.toFixed(4)}, Isc=${e.iSc.toFixed(4)}, FF=${e.fillFactor.toFixed(4)}`);
}
console.log(`  最佳工况: ${cmp.bestCase}`);
console.log(`  大漏电相对功率损失: ${loss.deltaPmppToBest.toFixed(4)} W (${(loss.relativeLoss * 100).toFixed(2)}%)`);

// 采样无关性演示：51 与 801 个点，连续 MPP 完全一致。
const c51 = svc.generateAndStore({ name: 'smallLeak', sampleCount: 51 });
const c801 = svc.generateAndStore({ name: 'smallLeak', sampleCount: 801 });
console.log('\n[采样无关性]');
console.log(`  Pmpp(51 点)=${c51.curve.mpp.pMpp.toFixed(10)}, Pmpp(801 点)=${c801.curve.mpp.pMpp.toFixed(10)}`);

// CSV 导出示例（前 3 行）
const csvHead = curveToCsv(curveA.curve).split('\n').slice(0, 4).join('\n');
console.log('\n[CSV 导出预览]\n' + csvHead);

// 一个明确失败的输入：i0<=0 违反物理范围。
console.log('\n=== 明确失败的输入（i0 = -1e-9）===');
try {
  svc.resolveParams({ iPh: 3.6, i0: -1e-9, rs: 0.01, rSh: 1000, nVt: 0.025 });
} catch (err) {
  if (err instanceof ServiceError) {
    console.log(`  被拒绝，code=${err.code}`);
    console.log(`  明细: ${JSON.stringify(err.details)}`);
  }
}

// 另一个运行期失败：电压超出有效范围
console.log('\n=== 运行期失败（V 超出 [0, Voc]）===');
const check = svc.checkPoint({ name: 'smallLeak', v: 9.9 });
console.log(`  status=${check.point.status}, i=${check.point.i}, 有效 Voc=${check.validRange.vOc.toFixed(4)} V`);

console.log(`\n演示数据库（临时）: ${dir}`);
store.close();
