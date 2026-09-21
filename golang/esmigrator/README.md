# esmigrator

DataMigrator 的 Elasticsearch JSONL 迁移引擎，使用 Go 标准库实现，用于离线大文件导出/导入。

## 构建

```bash
go build -trimpath -o bin/esmigrator .
```

Windows x64 交叉编译：

```bash
GOOS=windows GOARCH=amd64 go build -trimpath -o bin/esmigrator.exe .
```

项目内也可使用 `npm run build:go` 和 `npm run build:go:win`。

## 导出

```bash
./bin/esmigrator export \
  --url http://localhost:9200 \
  --username elastic \
  --password secret \
  --index logs \
  --output logs.jsonl \
  --batch-size 500 \
  --concurrency 4 \
  --strategy search_after \
  --progress-file logs.progress.json \
  --cancel-file logs.cancel
```

断点续传：

```bash
./bin/esmigrator export \
  --url http://localhost:9200 \
  --index logs \
  --output logs.jsonl \
  --strategy search_after \
  --resume-rows 50000 \
  --search-after '[12345,"doc#50000"]'
```

## 导入

```bash
./bin/esmigrator import \
  --url http://localhost:9200 \
  --username elastic \
  --password secret \
  --index logs \
  --input logs.jsonl \
  --batch-size 500 \
  --concurrency 4 \
  --on-conflict skip
```

## 并发模型

`--concurrency` 控制单个迁移任务同时在途的 Elasticsearch 请求数，范围为 `1` 到 `32`，默认 `1`。

- 导入：使用有界 goroutine worker pool 并发执行 `_bulk`，并按连续已提交水位更新续传游标。并发模式下 `skip` 会自动接受同一文档的 `409 version_conflict`；`overwrite` 对同一 `_id` 的最后写入顺序不保证。
- 导出：使用 scroll slice 或 `PIT + _shard_doc + slice + search_after` 并行读取。每个 slice 写独立的 `*.part.N`，完成后按 slice 顺序合并；进度文件保存每片的行数和游标，取消后可以按片续传。
- 当前桌面端任务队列仍是单任务串行，因此每个 ES 任务内的 `concurrency` 同时就是应用级在途请求上限。若以后允许同一 ES 任务并发运行，需要把该值抽成跨任务的共享 semaphore。
- 并发导出改变 JSONL 的全局文档顺序。当前格式不承诺顺序，只承诺文档完整写入。

建议从以下值开始压测：

| 环境 | 初始并发度 |
|---|---:|
| 单节点、1 分片、HDD | 1–2 |
| 单节点、5 分片、SSD | 2–4 |
| 多节点、每节点 SSD、1 GbE | 2–4 |
| 多节点、每节点 SSD、10 GbE+ | 4–8 |

```text
建议并发度 =
  min(
    配置上限,
    数据节点数 × 每节点初始 worker 数,
    当前索引可分片数,
    客户端可用 CPU 核数 × 2
  )
```

不要同时提高 `batch-size` 和 `concurrency` 直到内存失控。每个 worker 会持有一批文档、NDJSON 请求体和 bulk 响应，建议先把单请求正文控制在 5–15 MB。

## 直接影响并发上限的 ES 指标

压测或自动调参时应优先观察：

- `thread_pool.write.active`、`thread_pool.write.queue`、`thread_pool.write.rejected`：bulk 写入线程池的并行度和拒绝情况，队列持续增长时应降低并发度。
- `thread_pool.search.active`、`thread_pool.search.queue`、`thread_pool.search.rejected`：scroll/search_after 的查询压力。
- `indices.indexing_pressure.memory.limit_in_bytes` 与 current bytes：触发 indexing pressure 后会返回 `es_rejected_execution_exception`。
- JVM heap、young/old GC 次数和暂停时间，以及 `os.cpu.percent`：判断增加并发是否只是在制造 GC 和 CPU 抖动。
- `indices.merges.current`、`total_throttled_time_in_millis`、segment 数和 merge 线程池：写入并发过高时通常会先表现为 merge 挤压。
- 节点磁盘利用率、IOPS、读写延迟和 `disk.used_percent`：HDD 或共享云盘通常比 ES 线程池更早成为瓶颈。
- 网络吞吐、RTT、丢包和客户端连接复用情况：跨数据中心时，RTT 会直接限制串行批次吞吐。
- `nodes.fs.total.available_in_bytes`、分片分布和热点节点：并发只能利用健康分片的并行度，不能修复分片倾斜。

一个可操作的调优规则是：并发度翻倍后，只有在吞吐提升明显、P95 请求延迟没有接近翻倍、且 `write/search rejected` 始终为 0 时，才继续增加。出现任一 `rejected`、队列持续大于 0、GC 暂停显著增加或 merge 限流时，回退一级并降低 batch size。

## 进度与取消

导出和导入会在每个批次后原子写入 `--progress-file`，字段包括 `stage`、`rows`、`lines`、`skipped` 和 `searchAfter`。创建 `--cancel-file` 后，引擎会在下一个批次边界退出，保留 `.part` 或输入游标以便续传。

## 验证

```bash
go test ./...
go vet ./...
```
