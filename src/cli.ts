#!/usr/bin/env node
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { Store } from './db.js';
import { AnalysisService, ServiceError } from './service.js';
import { curveToCsv, comparisonToCsv } from './exporters.js';

const DATA_DIR = process.env.PV_DATA_DIR ?? join(process.cwd(), 'data');

function usage(): string {
  return [
 '用法: pv <命令> [选项]',
    '',
    '命令:',
    '  import --name <名称> --params <JSON> [--tol <JSON>]',
    '  curve  --name <名称>|--params <JSON> [--samples N] [--idem KEY] [--csv 文件]',
    '  check  --name <名称>|--params <JSON> --v <电压V>',
    '  mpp    --name <名称>|--params <JSON>',
    '  compare --names a,b [--csv 文件]',
    '  list-cases',
    '  list-curves [--name <名称>]',
    '  get-curve --id N [--csv 文件]',
    '',
    '参数 JSON 字段: iPh,i0,rs,rSh,nVt（单位见 README）。',
  ].join('\n');
}

function parseArgs(argv: string[]): Map<string, string> {
  const m = new Map<string, string>();
  for (let k = 0; k < argv.length; k++) {
    const a = argv[k]!;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[k + 1];
      if (next !== undefined && !next.startsWith('--')) {
        m.set(key, next);
        k++;
      } else {
        m.set(key, 'true');
      }
    }
  }
  return m;
}

function readParams(args: Map<string, string>, service: AnalysisService) {
  const raw = args.get('params');
  if (!raw) throw new ServiceError('INVALID_PARAMS', '需要 --params JSON（或改用 --name）');
  return service.resolveParams(JSON.parse(raw));
}

function writeCsvMaybe(path: string | undefined, csv: string): void {
  if (path) {
    writeFileSync(path, csv, 'utf-8');
    console.log(`已写入 ${path}`);
  }
}

function main(): void {
  const [, , cmd, ...rest] = process.argv;
  const args = parseArgs(rest);
  const store = new Store(join(DATA_DIR, 'pv.sqlite'));
  const service = new AnalysisService(store);

  try {
    switch (cmd) {
      case 'import': {
        const name = args.get('name');
        if (!name) throw new ServiceError('INVALID_REQUEST', '需要 --name');
        const params = readParams(args, service);
        const tol = service.resolveTolerances(args.has('tol') ? JSON.parse(args.get('tol')!) : undefined);
        const row = service.upsertCase(name, params, tol);
        console.log(JSON.stringify({ ok: true, case: row }, null, 2));
        break;
      }
      case 'curve': {
        const samples = Number(args.get('samples') ?? 201);
        const params = args.has('name') ? undefined : readParams(args, service);
        const result = service.generateAndStore({
          name: args.get('name'),
          params,
          sampleCount: samples,
          idempotencyKey: args.get('idem'),
        });
        const csv = args.get('csv');
        if (csv) writeCsvMaybe(csv, curveToCsv(result.curve));
        console.log(
          JSON.stringify(
            {
              ok: true,
              reused: result.reused,
              curveId: result.curveId,
              caseName: result.caseName,
              iSc: result.curve.iShortCircuit,
              vOc: result.curve.vOpenCircuit,
              mpp: result.curve.mpp,
              fillFactor: result.curve.fillFactor,
              allConverged: result.curve.allConverged,
              sampleCount: result.curve.sampleCount,
            },
            null,
            2
          )
        );
        break;
      }
      case 'check': {
        const v = Number(args.get('v'));
        if (!Number.isFinite(v)) throw new ServiceError('INVALID_REQUEST', '需要有限的 --v');
        const params = args.has('name') ? undefined : readParams(args, service);
        console.log(
          JSON.stringify(
            {
              ok: true,
              result: service.checkPoint({ name: args.get('name'), params, v }),
            },
            null,
            2
          )
        );
        break;
      }
      case 'mpp': {
        const params = args.has('name') ? undefined : readParams(args, service);
        console.log(
          JSON.stringify(
            { ok: true, result: service.findMpp({ name: args.get('name'), params }) },
            null,
            2
          )
        );
        break;
      }
      case 'compare': {
        const names = (args.get('names') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
        const result = service.compare(names);
        const csv = args.get('csv');
        if (csv) {
          const rows = result.entries.map((e) => ({
            caseName: e.caseName,
            iSc_A: e.iSc,
            vOc_V: e.vOc,
            pMpp_W: e.pMpp,
            vMpp_V: e.vMpp,
            iMpp_A: e.iMpp,
            fillFactor: e.fillFactor,
            deltaPmppToBest_W:
              result.losses.find((l) => l.caseName === e.caseName)!.deltaPmppToBest,
            relativeLoss: result.losses.find((l) => l.caseName === e.caseName)!.relativeLoss,
          }));
          writeCsvMaybe(csv, comparisonToCsv(rows));
        }
        console.log(JSON.stringify({ ok: true, comparison: result }, null, 2));
        break;
      }
      case 'list-cases':
        console.log(JSON.stringify({ ok: true, cases: store.listCases() }, null, 2));
        break;
      case 'list-curves': {
        const caseId = args.has('name') ? service.getCaseOrThrow(args.get('name')!).id : undefined;
        console.log(JSON.stringify({ ok: true, curves: store.listCurves(caseId) }, null, 2));
        break;
      }
      case 'get-curve': {
        const id = Number(args.get('id'));
        const row = store.getCurve(id);
        if (!row) throw new ServiceError('CURVE_NOT_FOUND', `曲线 id=${id} 不存在`);
        const csv = args.get('csv');
        if (csv) writeCsvMaybe(csv, curveToCsv(row.result as never));
        console.log(JSON.stringify({ ok: true, curve: row }, null, 2));
        break;
      }
      default:
        console.log(usage());
        if (cmd) process.exitCode = 1;
    }
  } catch (err) {
    if (err instanceof ServiceError) {
      console.error(JSON.stringify({ ok: false, error: { code: err.code, message: err.message, details: err.details ?? null } }, null, 2));
    } else if (err instanceof SyntaxError) {
      console.error(JSON.stringify({ ok: false, error: { code: 'INVALID_JSON', message: err.message } }, null, 2));
    } else {
      console.error(err);
    }
    process.exitCode = 1;
  } finally {
    store.close();
  }
}

main();
