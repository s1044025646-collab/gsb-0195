// CLI：参数导入、曲线、单点校核、MPP、比较、导出。
// 用法：
//   npm run cli -- import '<params-json>' [--name 名称] [--samples 200]
//   npm run cli -- import-file params.json [--name 名称]
//   npm run cli -- list
//   npm run cli -- curve <id> [--format json|csv]
//   npm run cli -- point <id> <voltage>
//   npm run cli -- mpp <id>
//   npm run cli -- compare <id1> <id2> [id3...]
//   npm run cli -- export <id> --format csv --out curve.csv
import * as fs from "node:fs";
import * as path from "node:path";
import { AnalysisStore } from "./db";
import { PvService } from "./service";

function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function main(): void {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const dataDir = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
  const dbPath = process.env.DB_PATH ?? path.join(dataDir, "pv.sqlite");
  const store = new AnalysisStore(dbPath);
  const service = new PvService(store);
  const print = (x: unknown) => console.log(JSON.stringify(x, null, 2));

  try {
    switch (cmd) {
      case "import": {
        const params = JSON.parse(args[1]);
        const name = argValue(args, "--name");
        const samples = argValue(args, "--samples");
        print(service.createAnalysis({ name, params, samples: samples ? Number(samples) : undefined }));
        break;
      }
      case "import-file": {
        const body = JSON.parse(fs.readFileSync(args[1], "utf8"));
        print(service.createAnalysis(body.params ? body : { params: body }));
        break;
      }
      case "list":
        print(service.listAnalyses());
        break;
      case "curve": {
        const a = service.getAnalysis(Number(args[1]));
        if (!a) { console.error("分析不存在"); process.exitCode = 1; break; }
        const format = argValue(args, "--format") ?? "json";
        if (format === "csv") {
          const out = service.exportCurve(a.id, "csv");
          if (out.ok) process.stdout.write(out.content);
        } else {
          print(a);
        }
        break;
      }
      case "point":
        print(service.pointCheck(Number(args[1]), Number(args[2])));
        break;
      case "mpp":
        print(service.mpp(Number(args[1])));
        break;
      case "compare":
        print(service.compare(args.slice(1).map(Number)));
        break;
      case "export": {
        const format = (argValue(args, "--format") ?? "json") as "json" | "csv";
        const out = service.exportCurve(Number(args[1]), format);
        if (!out.ok) { console.error(out.error); process.exitCode = 1; break; }
        const outFile = argValue(args, "--out");
        if (outFile) {
          fs.writeFileSync(outFile, out.content, "utf8");
          console.log(`已写出 ${outFile}`);
        } else {
          process.stdout.write(out.content + "\n");
        }
        break;
      }
      default:
        console.error("未知命令。可用: import | import-file | list | curve | point | mpp | compare | export");
        process.exitCode = 1;
    }
  } finally {
    store.close();
  }
}

main();
