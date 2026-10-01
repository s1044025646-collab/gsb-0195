# 太阳电池单二极管曲线与最大功率点后端（教学用）

纯后端服务：TypeScript + Node.js + SQLite（Node 内置 `node:sqlite`，无原生编译、无外部服务）。
只提供 HTTP API 与 CLI，不含前端。Windows 本地直接运行，不依赖 Docker / WSL / 付费服务 / 在线 API。

## 模型与约定

单二极管方程（只分析正常发电象限，`V >= 0`，发电电流取正）：

```
I = Iph - Is * (exp((V + I*Rs) / Vt) - 1) - (V + I*Rs) / Rsh
```

| 符号 | 含义 | 单位 | 合法范围 |
|------|------|------|----------|
| `iph` | 光生电流 Iph | A | `>= 0` |
| `isat` | 反向饱和电流 Is | A | `> 0` |
| `rs` | 串联电阻 Rs | ohm | `>= 0`（允许为 0） |
| `rsh` | 并联电阻 Rsh | ohm | `> 0` |
| `vt` | 等效二极管电压尺度 Vt | V | `> 0` |

输出：`v`（V）、`i`（A）、`p = v * i`（W）、每个采样点的方程残差（A）与求解状态。
本服务不做真实组件拟合、不做温度外推、不连接仪器/电网/在线物性服务。

## 数值方法

- 隐式方程用**区间保障的二分法**求解（残差关于 I 严格单调，根唯一）；下界自适应扩展，扩展与迭代均有预算。
- 指数计算带溢出保护（`x > 700` 判定为溢出方向，参与区间收缩而非产生 NaN）。
- 指数溢出、区间不存在、预算耗尽、非有限值都会返回**诊断**（`status` + `message`），失败时电流为 `NaN`，绝不用裁剪出的零电流冒充收敛。
- 短路电流在 `V = 0` 处真实求解（含并联支路影响），不直接等于 Iph。
- MPP 在连续区间 `[0, Voc]` 上用**黄金分割搜索**优化，不依赖离散采样点；输出端点功率、最优性残差（`|dP/dV|` 差分估计）与停止原因。

## 快速开始

```powershell
npm install
npm run build     # TypeScript 编译到 dist/
npm test          # 运行全部测试（node:test）
npm start         # 启动 API 服务（默认端口 8787）
npm run demo      # 演示：比较两组工况 + 一个失败输入
```

可配置项（环境变量）：

- `PORT`：API 端口，默认 `8787`
- `DATA_DIR`：数据目录，默认项目内 `./data`
- `DB_PATH`：SQLite 文件完整路径，默认 `$DATA_DIR/pv.sqlite`

## HTTP API

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/analyses` | 参数导入并生成曲线，体：`{name?, params, samples?, tolerances?}` |
| GET | `/api/analyses` | 列出全部分析（不含曲线点） |
| GET | `/api/analyses/:id` | 获取单个分析（含曲线） |
| POST | `/api/analyses/:id/point` | 单点校核，体：`{v}`，返回电流、功率、残差与独立代入残差 |
| POST | `/api/analyses/:id/mpp` | 连续区间 MPP 搜索 |
| POST | `/api/compare` | 工况比较，体：`{ids:[id1,id2,...]}` |
| GET | `/api/analyses/:id/export?format=json\|csv` | 导出曲线 |

每次分析创建时把**参数、容差、求解器版本**冻结进 SQLite，记录只增不改：
重复导入同样参数会生成新记录，旧曲线不会被新工况覆盖。

## CLI

```powershell
npm run cli -- import-file examples/params-rs0.json   # 从文件导入参数
npm run cli -- list                                   # 列出分析
npm run cli -- curve 1                                # 查看曲线（--format csv 可输出 CSV）
npm run cli -- point 1 30                             # 单点校核 V=30V
npm run cli -- mpp 1                                  # 连续 MPP 搜索
npm run cli -- compare 1 2                            # 比较工况 1 与 2
npm run cli -- export 1 --format csv --out curve.csv  # 导出 CSV
```

`import` 子命令也支持直接传 JSON 字符串（注意 PowerShell 引号转义，推荐用 `import-file`）。

## 工况比较

`compare` 输出各工况的 Isc / Voc / Pmpp / FF、两两 ΔPmpp（W 与 %）、
串联损耗估计 `Isc²·Rs` 与并联漏电损耗估计 `Voc²/Rsh`。
MPP 均在连续区间优化，与曲线采样步长无关，因此差异是真实物理差异，
不会因采样步长变化制造虚假的“效率提升”。

## 测试与夹具

`src/fixtures.ts` 提供：Rs=0 基准（可与闭式解对照）、小漏电、较大漏电、零光照边界、极端参数。
`tests/` 覆盖：闭式解对照、独立代入残差、`P = V·I`、端点功率、曲线单调方向、
密采样与连续最优一致、采样数不变性、非法参数、求解未收敛诊断、重复请求、重启持久化。

## 已知限制

- 仅教学用途的静态电学分析：单二极管、单工况点，无温度/辐照模型、无拟合功能。
- `node:sqlite` 在 Node 25 仍标记为 experimental（启动时有警告），接口未来可能微调。
- MPP 最优性残差为差分估计，数量级参考用；求根与区间收敛容差见 `DEFAULT_TOLERANCES`。
- 仅分析 `V >= 0` 发电象限，不支持反向偏压与击穿区。
