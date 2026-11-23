# lx-telemetry 审计计划 v1.0 · 2026-11-20

> 对象：`luanmuc/lx-telemetry`（公开仓），`main` 分支，基线 **`d706359`**（HEAD，每日 digest 数据提交）；**代码基线 `5cdfe31`**（含 `d9eecce`「LT-01 落库失败仍宣告已入库」+ LT-02/03/04/06/07 收口）。
>
> **本文件是该仓的第一份审计计划**（此前只有 `README.md` 与 1 个测试脚本，无 `docs/` 目录）。定位：它是 App 与源仓之间唯一的**真机数据落点**，所以审计重点不是「代码多少」，而是**契约能不能被破坏、脏数据能不能混进来、证据会不会丢**。

---

## 0. 仓库定位与规模

App 每天最多投一次「音源健康聚合包」→ 开 GitHub Issue → ingest workflow 校验 → 去重 → 追加 `digests/<日期>.jsonl` → 源仓 CI 每日拉 `raw` 做双端对照日报。

| 项 | 实测（2026-11-23） |
|---|---|
| 代码规模 | `scripts/ingest-digest.js` **190 行**、`schema/digest.schema.json` **155 行**、`test/ingest.test.js` **106 行**、`README.md` **59 行**（合计 510 行）；另有压测 `test/ingest-stress.test.js` + `test/digests-integrity.test.js` |
| 数据 | `digests/2026-11-21.jsonl` 1 条、`2026-11-22.jsonl` 1 条、`2026-11-23.jsonl` 3 条（共 **3 个日文件 / 5 条**，均为真机数据） |
| 测试 | `node --test test/ingest.test.js` → **9 pass / 0 fail**（150ms）；含压测、T5 吞吐、完整性后 **41 pass / 0 fail**（862ms）；T5 1000 行 **73ms**、10000 行 **366ms**（每千行 37ms） |
| CI | ingest workflow（`concurrency: ingest-digest` 仓级串行，push 冲突 rebase 重试 3 次）；另有 `test.yml` 跑 `node --test` |
| 依赖 | 无 `package.json`，纯 Node 标准库 + `node:test` |

**契约（README 明写的硬规则，审计必须逐条对应）**：

1. `schema` 固定 `lx-health-digest/1`
2. `device.id` 为 8~32 位小写 hex，**不含机型序列号/账号**
3. body **超过 48KB 直接拒收**（Issue body 上限 65536 字符）
4. **未知字段一律拒收**（改格式必须同步改 schema 与 ingest）
5. 同一 `device.id + generated_at` 重复投递**只记一次**
6. `digests/*.jsonl` 按天分文件，**保留 60 天**（当前手工归档，不自动删）

---

## 1. 证据分级

| 级别 | 手段 | 能证明什么 |
|---|---|---|
| L0 | 静态读代码 + schema 与实现逐字段比对 | 声明与消费是否闭合 |
| L1 | `node --test` 现有 9 条 | 主路径/去重/围栏/非法/上限 + LT-03 两条/LT-04/LT-06 |
| L2 | 追加纯 Node 边界用例（本计划 §2 的 A3~A8） | 边界、脏数据、并发语义 |
| L3 | 端到端：真实 Issue body → ingest → 文件 → 源仓拉取 | 跨仓链路（需 PAT/网络） |
| L4 | 真机 App 投递 | 无设备 → `blocked` |

`blocked` 不等于通过；真机投递与 GitHub API 侧行为本轮不取证。

---

## 2. 审计维度（8 组 / 32 维）

优先级：**P0**=坏了会让脏数据入库或真数据丢失；**P1**=契约漂移、可静默失效；**P2**=可维护性。

### A. 契约与校验（8 维）

| ID | 检查点 | 判据 | 级别 |
|---|---|---|---|
| A1 | `schema/digest.schema.json` 与 `scripts/ingest-digest.js` 的字段集是否**逐键一致** | `additionalProperties:false` 的键 = 实现白名单，双向差集为空 | P0 / L0 |
| A2 | `schema` 版本串硬校验 | 传 `lx-health-digest/2` 必须 `invalid` | P0 / L1 |
| A3 | `device.id` 六边形长度与字符集 | 7 位 / 33 位 / 大写 / 非 hex 必须拒 | P1 / L2 |
| A4 | 计数语义：`total >= ok`、非负整数 | `ok > total`、负数、小数、字符串必须拒（现有用例已覆盖 `5/9`） | P0 / L1 |
| A5 | `window_hours` 取值域 | 0 / 负数 / 超大值必须拒 | P1 / L2 |
| A6 | `generated_at` 时区与格式 | 非 ISO / 非法日期必须拒；取 `slice(0,10)` 时区必须与 UTC 一致 | P1 / L2 |
| A7 | 未知字段拒收（含嵌套） | `device.imei` 已覆盖；需补 `probe.extra` / 顶层多余键 | P0 / L1+L2 |
| A8 | 空 body / 非 JSON / 数组 body | 必须 `invalid`，不能抛未捕获异常 | P1 / L2 |

### B. 入库与去重（5 维）

| ID | 检查点 | 判据 | 级别 |
|---|---|---|---|
| B1 | 去重键 = `device.id + generated_at` | 同键不同 `issue` 只写 1 行（已覆盖） | P0 / L1 |
| B2 | 同日多设备并发追加 | 两次不同 device 都入库，行数 = 2 | P0 / L2 |
| B3 | 跨日分文件 | `generated_at` 不同日期写不同 `.jsonl` | P1 / L2 |
| B4 | 写入原子性 | 追加失败不得留半行（需评估是否 `appendFileSync` 单行写） | P1 / L0 |
| B5 | 重复投递返回值语义 | `duplicate` 与 `invalid` 必须可区分（workflow 据此评论/关闭） | P1 / L1 |

### C. 体积与 DoS 面（4 维）

| ID | 检查点 | 判据 | 级别 |
|---|---|---|---|
| C1 | 48KB 上限 | `600KB` body 必须 `invalid`（已覆盖）；边界 `48KB±1B` 需补 | P0 / L1+L2 |
| C2 | 超深嵌套 / 超长数组 | 不得致栈溢出或长时间占用 | P1 / L2 |
| C3 | 巨量 issue 并发（workflow 串行假设） | `concurrency` 生效前提是同一 workflow；需确认无第二条入口 | P1 / L0 |
| C4 | 代码围栏提取 | ` ```json ` 包裹可提取（已覆盖）；多围栏取第一个、非 json 围栏忽略 | P1 / L1+L2 |

### D. 隐私（4 维）

| ID | 检查点 | 判据 | 级别 |
|---|---|---|---|
| D1 | 不存歌名 / URL / 账号 | 逐字段核对 schema，无自由文本字段 | P0 / L0 |
| D2 | `device.id` 非硬件标识 | 与 App 侧生成逻辑（随机 hex）对齐；不得出现 `android_id`/`imei` | P0 / L0 |
| D3 | issue body 原文是否被整段落盘 | 只落摘要 JSON，不落原始 body | P0 / L0 |
| D4 | 日志/评论是否回显原始 body | workflow 评论内容核对 | P1 / L0 |

### E. 数据保留与证据完整性（4 维）

| ID | 检查点 | 判据 | 级别 |
|---|---|---|---|
| E1 | 60 天保留策略与实现一致 | README 说手工归档、不自动删；代码不得有静默删除 | P0 / L0 |
| E2 | 历史提交是否被改写 | `git log` 不得出现 force-push 痕迹（digest 提交历史线性） | P1 / L0 |
| E3 | `digests/*.jsonl` 行可解析 | 每行合法 JSON，坏行即证据损坏 | P1 / L2 |
| E4 | 双端对照的口径依赖 | 源仓 `docs/device-digests.jsonl` 拉取字段与本仓一致 | P1 / L0（跨仓） |

### F. 测试与门禁（3 维）

| ID | 检查点 | 判据 | 级别 |
|---|---|---|---|
| F1 | 现有 9 条用例覆盖主路径/去重/围栏/非法/上限/LT 回归 | 实跑 **9/0** | P1 / L1 |
| F2 | 用例是否隔离（临时目录） | `DIGEST_DIR` 指向 `mkdtemp`，不污染仓库 | P1 / L0 |
| F3 | 是否有 CI 跑测试 | **已补**：新增 `.github/workflows/test.yml`（`push`/`pull_request` 触发，`paths-ignore: digests/**` 避免自激），跑 `node --test` + schema 可解析。原状态是「只有 ingest、9 条用例零执行点」 | 已修复（2026-11-20） |

### G. 文档镜像（2 维）

| ID | 检查点 | 判据 | 级别 |
|---|---|---|---|
| G1 | README 的硬规则 6 条与 schema/实现一致 | 逐条对应，无「文档说 48KB、代码判 64KB」类漂移 | P0 / L0 |
| G2 | 示例 JSON 可直接通过校验 | 用 README 示例跑 `validate` 必须 0 错 | P1 / L2 |

### H. 跨仓契约（2 维）

| ID | 检查点 | 判据 | 级别 |
|---|---|---|---|
| H1 | App `check_health_digest` 9 条与 schema 对齐 | App 产出的四顶层键（`probe`/`play`/`chain`/`schema`）schema 必须全收 | P0 / L0（跨仓） |
| H2 | 源仓 `pull-device-digests.js` 消费字段一致 | 源仓 `device-digests.jsonl` 字段 = 本仓 schema | P1 / L0（跨仓） |

---

## 3. 当前缺口（本轮建档，未修）

| ID | 缺口 | 影响 | 建议 |
|---|---|---|---|
| GAP-1 | ~~CI 不跑测试~~ **已修复**：原 `ingest.yml` 只有 4 个 step，9 条 `node --test` 零执行点 | 同左（schema 与实现漂移无人拦） | 已落地独立 `test.yml`（不改 `ingest.yml`，避免影响 issue 触发链路）；`push`/`pull_request` 触发，`paths-ignore: digests/**` |
| GAP-2 | 无 `docs/` 目录 | 契约只散在 README，改格式时无权威台账 | 本文件 + `STRESS_PLAN.md` 即补位 |
| GAP-3 | 60 天归档全靠人工 | 数据无限增长；误删风险与体积风险由人承担 | 先加「超 60 天文件列表」检查脚本，删除仍手工 |
| GAP-4 | schema 无 `$schema` 声明与自校验脚本 | 编辑器无法校验、CI 无法用 JSON Schema 校验 | 加 `scripts/validate-schema.js`（可选） |
| GAP-5 | 无压力用例 | 48KB 边界、深嵌套、巨量 issue 并发未验 | 见 `STRESS_PLAN.md` |

---

## 4. 执行清单

```bash
node --test test/ingest.test.js        # 现有 9 条，必须 9/0
node --test test/ingest-stress.test.js # T1~T4/T6，29 例
node --test test/ingest-throughput.test.js # T5，1000/10000 行长测
node --test test/digests-integrity.test.js # T7，证据完整性
node --test                            # CI 入口：自动发现 4 个 *.test.js，共 41 例
```

**退出标准**：`node --test` rc=0；schema 与实现字段差集为空；README 6 条硬规则逐条有对应断言；无新增自由文本字段。

---

## 5. 维护记录

| 日期 | 变更 | 实跑证据 |
|---|---|---|
| 2026-11-23 | **R85b 补齐 T5 并落成 41 例**：新增 `test/ingest-throughput.test.js`；`isDuplicate` 从每次重扫整文件改为按文件 `size+mtimeMs` 缓存唯一键 Set，修掉 O(n²) | `node --test` **41/0 · 862ms**；T5.1 1000 行 **73ms**、T5.2 10000 行 **366ms**（每千行 37ms），落盘 1000/10000 行且逐行 JSON 可解析；CI `node --test` 自动发现 4 个测试文件 |
| 2026-11-23 | **R85 基线刷新与实跑**：HEAD `d706359`（数据），代码基线 `5cdfe31`；规模更新为 190/155/106/59 行；数据 3 日文件 / 5 条；补压测与完整性套件后总用例 39 | `node --test test/ingest.test.js` **9/0**；`node --test test/ingest.test.js test/ingest-stress.test.js test/digests-integrity.test.js` **39/0 · 336ms**；无坏行 |
| 2026-11-20 | 首份审计计划建档（8 组 32 维 + 5 条缺口）；基线 `2cdb7f6`；同步新建 `STRESS_PLAN.md` | `node --test test/ingest.test.js` → **5 pass / 0 fail / 118ms**；`digests/2026-11-16.jsonl` 1 条真机数据 |
| 2026-11-20 | 补 CI 测试执行点 | 新增 `test.yml`（job `unit`）：`node --test` 9 条 + `schema/digest.schema.json` 可解析；`paths-ignore: digests/**` 防自激 | GAP-1 / F3 关闭 |
| 2026-11-20 | **基线前移到 `bc1901e`**（远端已有 LT-01~LT-07 修复，本轮 push 前 rebase 才看到）；改正建档时两处误判：①「无 CI」实为**有 `ingest.yml` 但只跑 ingest 不跑测试**；②用例数 5 → **9**。GAP-1 改写为「CI 不跑测试」 | `node --test` → **9 pass / 0 fail / 120ms**；`grep -c "      - name:" ingest.yml` → 4 step；`grep "node --test" ingest.yml` → 无命中 |
