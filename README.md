# lx-telemetry

真机「音源健康聚合包」的公开信箱。App 每天最多投一次，仓库只存**去重后的 JSON 摘要**，不存音频、不存歌名、不存账号信息。

## 为什么公开

- 公开仓的 `raw` 内容源仓可以直接读，不需要再给源仓配第二个 token。
- 写入不是匿名开放的：只有持有 fine-grained PAT（仅 `Issues: Read and write`）的人能开 issue。

## 数据流

```
App（真机） --POST issue([digest] ...)--> lx-telemetry
                                          └─ ingest workflow：校验 → 去重 → 追加 digests/<日期>.jsonl → 评论并关闭 issue
源仓 CI（每日） --public raw 拉取--> digests/*.jsonl → docs/device-digests.jsonl → 双端对照日报
```

## 摘要格式

`lx-health-digest/1`，完整约束见 `schema/digest.schema.json`。最小可用示例：

```json
{
  "schema": "lx-health-digest/1",
  "device": { "id": "a1b2c3d4e5f6", "model": "K80 Pro", "android": "15" },
  "app": { "version": "1.9.2", "build": 305 },
  "generated_at": "2026-11-17T02:10:00.000Z",
  "window_hours": 24,
  "probe": { "total": 38, "ok": 15 },
  "play": { "total": 24, "ok": 0 }
}
```

硬规则：

- `device.id` 是安装时随机生成的 8~32 位小写 hex，**不含机型序列号/账号**。
- body 超过 48KB 直接拒收（GitHub Issue body 上限 65536 字符）。
- 未知字段一律拒收（改格式要同步改 `schema/digest.schema.json` 和 `scripts/ingest-digest.js`）。
- 同一 `device.id + generated_at` 重复投递只记一次。
- 并发：workflow 按**仓**串行（`concurrency: ingest-digest`），push 冲突自动 rebase 重试 3 次；App 侧另有 inFlight 单飞，双击不会发两条。
- **落库才算成功**：校验通过（`result=ingested`）不等于数据已进仓库。push 若三次重试全部被拒，workflow 会判红、写 `pushed=false`、回执「校验通过但落库失败」并**保持 Issue 打开**——原来这条路径会照常关闭 Issue，导致「唯一证据被销毁」。
- **排队上限**：`concurrency` 按仓串行且 `cancel-in-progress: false`，同一 group 的待执行队列有上限（GitHub 侧限制），密集投递超出上限的运行会被丢弃，表现为「Issue 一直开着没人回执」。遇到这种情况重新投递同一份摘要即可（去重会挡住重复写入）。
- `generated_at` 只接受**过去 30 天内**，正向仅容忍 5 分钟设备时钟漂移——避免产出未来日期的 `digests/<未来日>.jsonl` 污染按天分文件与 60 天裁剪。
- `device.android`（≤40 字符）与 `breaker` 子结构（`state` ≤20 字符、`fail` 0~9999）现在**脚本与 schema 双向校验**，不再只靠 schema 声明。
- **音质维度（App b195 起）**：`probe`/`play` 各多一个 `by_quality`（档位 → `{total, ok}`，档位名 ≤12 字符：`128k`/`320k`/`flac`/`flac24bit`/`unknown`），顶层多一个 `source: { version }`（≤32 字符），`recent_events` 每条多一个 `q`（档位，≤12）。三者都是**可选**：缺省的老包照常通过，聚合侧按「无音质信息」处理，不补零、不折算成失败。
- **为什么必须加 `by_quality`**：只有 `by_source` 时，云端能看出「某源挂了」，看不出「只在 flac 档挂」。128k 通、flac 实返 mp3 这种降档虚标，在源维度是 100% 成功，在档位维度才是 0%——两者混在一起，等于把最该被抓的问题藏起来。

## 本地验证

```bash
node --test                                    # 41 条：审计 9 + 压测 29 + T5 2 + 完整性 1
node --test test/ingest-throughput.test.js     # T5 长测：1000 / 10000 行，每千行 <200ms
ISSUE_BODY='{"schema":"lx-health-digest/1",...}' ISSUE_NUMBER=1 node scripts/ingest-digest.js
```

workflow 层（push 重试耗尽、失败回执）无法在本地覆盖，改动后需在真实投递里验证：故意让 `git push` 失败（或临时去掉写权限）应看到 job 判红 + Issue 保持打开 + 「落库失败」评论。

## 保留策略

`digests/<日期>.jsonl` 按天分文件，保留 60 天后由源仓/本仓维护者手动归档（当前不做自动删除，避免误删唯一证据）。
