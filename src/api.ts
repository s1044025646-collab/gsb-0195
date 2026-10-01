// 纯 Node http 实现的 JSON API（无外部依赖）。
import * as http from "node:http";
import { PvService } from "./service";

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(payload);
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("请求体不是合法 JSON");
  }
}

export function createServer(service: PvService): http.Server {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);
    try {
      // POST /api/analyses  {name?, params, samples?, tolerances?}
      if (req.method === "POST" && url.pathname === "/api/analyses") {
        const body = await readBody(req);
        const result = service.createAnalysis(body);
        return sendJson(res, result.ok ? 201 : 400, result);
      }
      // GET /api/analyses
      if (req.method === "GET" && url.pathname === "/api/analyses") {
        return sendJson(res, 200, { analyses: service.listAnalyses() });
      }
      // POST /api/compare {ids:[...]}
      if (req.method === "POST" && url.pathname === "/api/compare") {
        const body = await readBody(req);
        const result = service.compare(body.ids);
        return sendJson(res, result.ok ? 200 : 400, result);
      }
      if (parts[0] === "api" && parts[1] === "analyses" && parts[2]) {
        const id = Number(parts[2]);
        if (!Number.isInteger(id)) return sendJson(res, 400, { error: "无效 ID" });
        // GET /api/analyses/:id
        if (req.method === "GET" && parts.length === 3) {
          const a = service.getAnalysis(id);
          return a ? sendJson(res, 200, a) : sendJson(res, 404, { error: "分析不存在" });
        }
        // POST /api/analyses/:id/point {v}
        if (req.method === "POST" && parts[3] === "point") {
          const body = await readBody(req);
          const result = service.pointCheck(id, Number(body.v));
          return sendJson(res, result.ok ? 200 : 400, result);
        }
        // POST /api/analyses/:id/mpp
        if (req.method === "POST" && parts[3] === "mpp") {
          const result = service.mpp(id);
          return sendJson(res, result.ok ? 200 : 400, result);
        }
        // GET /api/analyses/:id/export?format=json|csv
        if (req.method === "GET" && parts[3] === "export") {
          const format = (url.searchParams.get("format") ?? "json") as "json" | "csv";
          if (format !== "json" && format !== "csv") return sendJson(res, 400, { error: "format 仅支持 json|csv" });
          const result = service.exportCurve(id, format);
          if (!result.ok) return sendJson(res, 404, result);
          res.writeHead(200, { "Content-Type": result.contentType + "; charset=utf-8" });
          return res.end(result.content);
        }
      }
      return sendJson(res, 404, { error: "未知路由" });
    } catch (err: any) {
      return sendJson(res, 500, { error: err?.message ?? String(err) });
    }
  });
}
