import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { Store } from './db.js';
import { AnalysisService, ServiceError } from './service.js';
import { curveToCsv, comparisonToCsv } from './exporters.js';

const PORT = Number(process.env.PV_PORT ?? process.env.PORT ?? 5173);
const DATA_DIR = process.env.PV_DATA_DIR ?? join(process.cwd(), 'data');
const DB_PATH = join(DATA_DIR, 'pv.sqlite');

const store = new Store(DB_PATH);
const service = new AnalysisService(store);

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(json);
}

function sendCsv(res: ServerResponse, status: number, csv: string, filename: string): void {
  res.writeHead(status, {
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': `attachment; filename="${filename}"`,
  });
  res.end(csv);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf-8');
  if (raw.trim() === '') return {};
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw new ServiceError('INVALID_JSON', '请求体不是合法 JSON');
  }
}

function errorBody(code: string, message: string, details?: unknown) {
  return { ok: false, error: { code, message, details: details ?? null } };
}

async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = req.method ?? 'GET';
  const wantCsv = url.searchParams.get('format') === 'csv';

  try {
    // 健康检查与单位说明
    if (method === 'GET' && path === '/health') {
      return send(res, 200, { ok: true, service: 'pv-single-diode', toleranceVersion: 'tol-1.0.0' });
    }
    if (method === 'GET' && path === '/units') {
      return send(res, 200, {
        current: { symbol: 'I', unit: 'A', signConvention: '流出器件为正，正常发电象限 I>=0' },
        voltage: { symbol: 'V', unit: 'V', signConvention: '正常发电象限 0<=V<=Voc' },
        power: { symbol: 'P', unit: 'W', relation: 'P=V*I，发电 P>=0' },
        resistance: { unit: 'ohm' },
        diodeVoltageScale: { symbol: 'nVt', unit: 'V' },
        validQuadrant: '仅第一象限（V>=0, I>=0）',
      });
    }

    // 工况导入
    if (method === 'POST' && path === '/cases') {
      const body = await readJson(req);
      const name = String(body.name ?? '');
      if (!name) throw new ServiceError('INVALID_REQUEST', 'name 为必填');
      const params = service.resolveParams(body.params ?? body);
      const tol = service.resolveTolerances(body.tolerances);
      const row = service.upsertCase(name, params, tol);
      return send(res, 201, { ok: true, case: row });
    }
    if (method === 'GET' && path === '/cases') {
      return send(res, 200, { ok: true, cases: store.listCases() });
    }
    if (method === 'GET' && path.startsWith('/cases/')) {
      const name = decodeURIComponent(path.slice('/cases/'.length));
      return send(res, 200, { ok: true, case: service.getCaseOrThrow(name) });
    }

    // 生成曲线（冻结到 SQLite），支持幂等键
    if (method === 'POST' && path === '/curves') {
      const body = await readJson(req);
      const sampleCount = Number(body.sampleCount ?? 201);
      if (!Number.isInteger(sampleCount) || sampleCount < 2) {
        throw new ServiceError('INVALID_REQUEST', 'sampleCount 必须为 >=2 的整数');
      }
      const params = body.name ? undefined : service.resolveParams(body.params ?? body);
      const tolerances = body.name ? undefined : service.resolveTolerances(body.tolerances);
      const result = service.generateAndStore({
        name: body.name ? String(body.name) : undefined,
        params,
        tolerances,
        sampleCount,
        idempotencyKey: body.idempotencyKey ? String(body.idempotencyKey) : undefined,
      });
      if (wantCsv) return sendCsv(res, 200, curveToCsv(result.curve), 'curve.csv');
      return send(res, result.reused ? 200 : 201, {
        ok: true,
        reused: result.reused,
        curveId: result.curveId,
        caseName: result.caseName,
        curve: result.curve,
      });
    }
    if (method === 'GET' && path === '/curves') {
      const caseName = url.searchParams.get('caseName') ?? undefined;
      const caseId = caseName ? service.getCaseOrThrow(caseName).id : undefined;
      return send(res, 200, { ok: true, curves: store.listCurves(caseId) });
    }
    if (method === 'GET' && path.startsWith('/curves/')) {
      const id = Number(path.slice('/curves/'.length));
      const row = store.getCurve(id);
      if (!row) throw new ServiceError('CURVE_NOT_FOUND', `曲线 id=${id} 不存在`);
      if (wantCsv) {
        return sendCsv(res, 200, curveToCsv(row.result as never), `curve_${id}.csv`);
      }
      return send(res, 200, { ok: true, curve: row });
    }

    // 单点校核
    if (method === 'POST' && path === '/check') {
      const body = await readJson(req);
      const v = Number(body.v);
      if (!Number.isFinite(v)) throw new ServiceError('INVALID_REQUEST', 'v 必须为有限数值');
      const params = body.name ? undefined : service.resolveParams(body.params ?? body);
      return send(res, 200, {
        ok: true,
        result: service.checkPoint({
          name: body.name ? String(body.name) : undefined,
          params,
          v,
        }),
      });
    }

    // 连续区间最大功率搜索
    if (method === 'POST' && path === '/mpp') {
      const body = await readJson(req);
      const params = body.name ? undefined : service.resolveParams(body.params ?? body);
      return send(res, 200, {
        ok: true,
        result: service.findMpp({ name: body.name ? String(body.name) : undefined, params }),
      });
    }

    // 工况比较
    if (method === 'POST' && path === '/compare') {
      const body = await readJson(req);
      const names = Array.isArray(body.names)
        ? (body.names as unknown[]).map((n) => String(n))
        : [];
      const result = service.compare(names);
      if (wantCsv) {
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
        return sendCsv(res, 200, comparisonToCsv(rows), 'comparison.csv');
      }
      return send(res, 200, { ok: true, comparison: result });
    }

    return send(res, 404, errorBody('NOT_FOUND', `无此路由：${method} ${path}`));
  } catch (err) {
    if (err instanceof ServiceError) {
      const status =
        err.code === 'CASE_NOT_FOUND' || err.code === 'CURVE_NOT_FOUND'
          ? 404
          : err.code === 'CASE_EXISTS'
            ? 409
            : 400;
      return send(res, status, errorBody(err.code, err.message, err.details));
    }
    const message = err instanceof Error ? err.message : String(err);
    return send(res, 500, errorBody('INTERNAL', message));
  }
}

const server = createServer((req, res) => {
  handler(req, res).catch((err) => {
    send(res, 500, errorBody('INTERNAL', err instanceof Error ? err.message : String(err)));
  });
});

server.listen(PORT, () => {
  console.log(`[pv] 单二极管分析服务已启动: http://localhost:${PORT}`);
  console.log(`[pv] 数据目录: ${DATA_DIR}`);
  console.log(`[pv] 数据库: ${DB_PATH}`);
});
