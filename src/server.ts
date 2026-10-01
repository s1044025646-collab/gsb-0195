// API 服务器入口。端口与数据目录均可配置。
import * as path from "node:path";
import { AnalysisStore } from "./db";
import { PvService } from "./service";
import { createServer } from "./api";

const port = Number(process.env.PORT ?? 8787);
const dataDir = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
const dbPath = process.env.DB_PATH ?? path.join(dataDir, "pv.sqlite");

const store = new AnalysisStore(dbPath);
const service = new PvService(store);
const server = createServer(service);

server.listen(port, () => {
  console.log(`PV 单二极管分析服务已启动: http://localhost:${port}`);
  console.log(`数据库: ${dbPath}`);
});

process.on("SIGINT", () => {
  server.close();
  store.close();
  process.exit(0);
});
