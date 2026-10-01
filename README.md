# 太阳电池单二极管曲线与最大功率点后端（教学用）

仅包含 **API 与 CLI** 的本地后端服务。管理各工况下**直接给定**的单二极管五参数，
求解 I-V / P-V 曲线、短路电流 Isc、开路电压 Voc、最大功率点 MPP 与填充因子 FF。

- 语言/运行时：TypeScript + Node.js（要求 Node `>= 22.5`，开发验证于 Node `v25.5`）
- 存储：SQLite，使用 Node 内置 `node:sqlite`（**无需本地编译原生模块、无需 Docker/WSL**）
- 不连接仪器、电网或任何在线物性服务；不做真实组件拟合，不做温度/辐照外推

## 符号与单位（公开约定）

| 量 | 符号 | 单位 | 符号约定 |
|---|---|---|---|
| 电流 | `I` | 安培 A | 流出器件为正；仅分析正常发电象限 `I >= 0` |
| 电压 | `V` | 伏特 V | 仅分析 `0 <= V <= Voc` |
| 功率 | `P` | 瓦特 W | `P = V*I`，发电时 `P >= 0` |
| 串联电阻 | `Rs` | Ω | 允许为 `0` |
| 并联（漏电）电阻 | `Rsh` | Ω | 严格为正 |
| 二极管电压尺度 | `nVt` | V | `n*k*T/q`，严格为正 |
| 光生电流 | `Iph` | A | `>= 0` |
| 反向饱和电流 | `I0` | A | 严格为正 |

## 物理模型

单二极管、含串联压降的隐式方程（电流形式）：

```
I = Iph - I0 * (exp((V + I*Rs)/(nVt)) - 1) - (V + I*Rs)/Rsh
```

求根函数 `f(I;V) = Iph - I0*(expm1((V+I*Rs)/nVt)) - (V+I*Rs)/Rsh - I`。
在合法参数下 `f` 对 `I` 严格单调递减，区间 `[0, hi]` 内恰有一个根。

### 数值方法与诊断（不伪造收敛）

- **稳定指数**：使用 `Math.expm1`；指数参数超过 `expArgMax`（默认 700）时返回
  `exp_overflow` 诊断，**绝不裁剪（clamp）出有限值**。
- **有保障求根**：下界 `I=0`，上界从 `Iph` 起倍增直到 `f(hi)<=0`；再二分。
  无法建立含根区间返回 `no_bracket`；迭代预算耗尽返回 `budget_exhausted`，
  此时电流为 `null`，**不会用裁剪出的零电流冒充收敛解**。
- **Rs=0 基准**：电流可直接解析计算，状态标记为 `rs_zero_direct`。
- **短路点**：在 `V=0` 处隐式求解。Rs>0 时 `Isc < Iph`（不是直接取 Iph）；
  仅 Rs=0 时 `Isc = Iph`。
- **开路电压**：在 `I=0` 方程上独立倍增+二分求得。
- **有效电压范围**：`[0, Voc]`；超出返回 `out_of_valid_range` / `no_bracket`。
- 每个采样点都保留独立代入的**残差**（A）与**求解状态**、迭代次数。

### 最大功率点（连续优化，非挑离散点）

- 在连续区间 `[0, Voc]` 上用**黄金分割搜索**最大化 `P(V)=V*I(V)`。
- 输出两端点检查、中心差分的**最优性残差 `|dP/dV|`**、迭代次数与**停止原因**
  （`xtol_reached` / `budget_exhausted` / `degenerate_interval`）。
- 因为 MPP 来自连续优化，**改变采样数不会改变 Pmpp**（测试覆盖 51/401/801 点一致性）。

### 容差版本

算法参数（残差容差、预算、指数上限等）拥有版本号 `TOLERANCE_VERSION = tol-1.0.0`，
随每次分析**冻结**进 SQLite。可在导入工况时通过 `tolerances` 覆盖。

## 数据持久化

- 数据目录默认 `./data`（可用环境变量 `PV_DATA_DIR` 配置），数据库文件 `data/pv.sqlite`。
- 表 `cases`（工况：五参数 + 容差版本快照）、`curves`（每次曲线：参数快照、
  容差版本、采样数、完整结果、幂等键、时间戳）。
- **旧曲线不会被新工况覆盖**：同名工况导入返回 `409 CASE_EXISTS`；
  每条曲线是只追加快照。
- **幂等键**：相同 `idempotencyKey` 的重复生成请求返回同一曲线记录（不新增）。

## 快速开始（Windows / PowerShell）

```powershell
npm install
npm run build      # 编译 TypeScript 到 dist/
npm test           # 构建并运行 node:test（物理 + 持久化，共 19 个用例）
npm start          # 启动 HTTP 服务（默认端口 5173）
npm run demo       # 端到端演示：两组工况对比 + 失败输入
```

配置：

```powershell
$env:PV_PORT='8080'        # 或 PV_PORT，默认 5173
$env:PV_DATA_DIR='E:\pv-data'
npm start
```

## HTTP API

所有请求/响应为 JSON；曲线/比较接口加 `?format=csv` 可导出 CSV。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 健康检查 |
| GET | `/units` | 公开符号、单位与符号约定 |
| POST | `/cases` | 导入命名工况（五参数，可选 `tolerances`） |
| GET | `/cases` `/cases/:name` | 列出/读取工况 |
| POST | `/curves` | 生成并冻结曲线（`name` 或内联 `params`，`sampleCount`，可选 `idempotencyKey`） |
| GET | `/curves` `/curves/:id` | 列出/读取冻结曲线（`?caseName=` 过滤；`?format=csv`） |
| POST | `/check` | 单点校核 `{name|params, v}`，返回残差与状态 |
| POST | `/mpp` | 连续区间 MPP 搜索 |
| POST | `/compare` | 比较多个工况 `{names:[...]}`，给出功率差与相对损失（`?format=csv`） |

错误响应统一为 `{ "ok": false, "error": { "code", "message", "details" } }`，
典型 `code`：`INVALID_PARAMS`（含字段级明细）、`CASE_EXISTS`(409)、
`CASE_NOT_FOUND`/`CURVE_NOT_FOUND`(404)、`SOLVE_FAILED`（`exp_overflow` /
`no_bracket` / `budget_exhausted` / `nonfinite`）。

### curl 示例

```powershell
# 导入
curl.exe -X POST http://localhost:5173/cases -H "content-type: application/json" `
  -d '{\"name\":\"A\",\"params\":{\"iPh\":3.6,\"i0\":2e-9,\"rs\":0.01,\"rSh\":5000,\"nVt\":0.025}}'
# 比较
curl.exe -X POST http://localhost:5173/compare -H "content-type: application/json" `
  -d '{\"names\":[\"A\",\"B\"]}'
```

## CLI

```powershell
node dist/src/cli.js import  --name A --params (Get-Content A.json -Raw)
node dist/src/cli.js curve   --name A --samples 201 --idem run-1 --csv curve.csv
node dist/src/cli.js check   --name A --v 0.3
node dist/src/cli.js mpp     --name A
node dist/src/cli.js compare --names A,B --csv compare.csv
node dist/src/cli.js list-cases
node dist/src/cli.js list-curves --name A
node dist/src/cli.js get-curve --id 1 --csv c1.csv
```

`--params` 接受 JSON 字符串；PowerShell 下建议把参数放入文件再用
`--params (Get-Content A.json -Raw)` 传入以避免引号转义问题。

## 演示的典型结果

小漏电（Rsh=5000Ω, Rs=0.01Ω）对比大漏电（Rsh=2Ω, Rs=0.05Ω）：

- 小漏电：Pmpp ≈ 1.4504 W，FF ≈ 0.756
- 大漏电：Pmpp ≈ 0.9765 W，FF ≈ 0.524
- 大漏电相对功率损失约 **32.7%**
- 51 点与 801 点采样的连续 Pmpp 完全一致

明确失败示例：`i0 = -1e-9` 被拒绝（`INVALID_PARAMS`，字段 `i0` 必须 > 0）；
`V=9.9` 返回 `out_of_valid_range`。

## 范围与限制

- 仅静态、稳态、直流、正常发电第一象限；不含温度/辐照模型、动态电容、双二极管。
- 参数为教学量级的**直接给定值**，不代表对任何真实组件的辨识结果。
- 数值精度受 IEEE 双精度限制；Voc 端点附近 `I(V)` 对电压极敏感，
  端点电流在相对 `Iph` 的 `1e-8` 小尺度内判为 0（见 `src/model.ts`）。
- `node:sqlite` 在当前 Node 上带“实验特性”运行时警告，功能可用；后续 Node 版本 API 可能微调。

