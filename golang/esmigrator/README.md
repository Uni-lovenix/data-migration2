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
  --on-conflict skip
```

## 进度与取消

导出和导入会在每个批次后原子写入 `--progress-file`，字段包括 `stage`、`rows`、`lines`、`skipped` 和 `searchAfter`。创建 `--cancel-file` 后，引擎会在下一个批次边界退出，保留 `.part` 或输入游标以便续传。

## 验证

```bash
go test ./...
go vet ./...
```
