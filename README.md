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

## 本地验证

```bash
node --test test/ingest.test.js
ISSUE_BODY='{"schema":"lx-health-digest/1",...}' ISSUE_NUMBER=1 node scripts/ingest-digest.js
```

## 保留策略

`digests/<日期>.jsonl` 按天分文件，保留 60 天后由源仓/本仓维护者手动归档（当前不做自动删除，避免误删唯一证据）。
