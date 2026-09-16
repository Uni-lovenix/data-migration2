package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

func runImport(opts importOptions) error {
	if opts.batchSize <= 0 {
		opts.batchSize = 500
	}
	client, err := newElasticsearchClient(opts.url, opts.username, opts.password, opts.insecureTLS)
	if err != nil {
		return err
	}
	if err := checkCancel(opts.cancelFile); err != nil {
		return err
	}

	indexCreated, mappingSource, err := ensureIndex(client, opts)
	if err != nil {
		return err
	}

	input, err := os.Open(opts.inputFile)
	if err != nil {
		return err
	}
	defer input.Close()

	reader := bufio.NewReaderSize(input, 1<<20)
	startedAt := time.Now()
	var rows, lines, skipped int64
	var pending []map[string]any

	for {
		line, readErr := reader.ReadString('\n')
		if readErr != nil && readErr != io.EOF {
			return readErr
		}
		if readErr == io.EOF && len(line) == 0 {
			break
		}

		lines++
		if lines <= opts.resumeLines {
			if readErr == io.EOF {
				break
			}
			continue
		}
		if strings.TrimSpace(line) == "" {
			if readErr == io.EOF {
				break
			}
			continue
		}

		row, err := parseImportRow(line, lines, opts.selectedCols, opts.fieldTransforms)
		if err != nil {
			return err
		}
		pending = append(pending, row)
		if len(pending) >= opts.batchSize {
			skippedBatch, err := flushBulk(client, opts, pending)
			if err != nil {
				return err
			}
			skipped += skippedBatch
			rows += int64(len(pending))
			pending = pending[:0]
			if err := writeProgress(opts.progressFile, "import", rows, lines, skipped, nil); err != nil {
				return err
			}
			if err := checkCancel(opts.cancelFile); err != nil {
				return err
			}
		}
		if readErr == io.EOF {
			break
		}
	}

	if len(pending) > 0 {
		skippedBatch, err := flushBulk(client, opts, pending)
		if err != nil {
			return err
		}
		skipped += skippedBatch
		rows += int64(len(pending))
		if err := writeProgress(opts.progressFile, "import", rows, lines, skipped, nil); err != nil {
			return err
		}
	}

	result := map[string]any{
		"rows":         rows,
		"skipped":      skipped,
		"durationMs":   time.Since(startedAt).Milliseconds(),
		"index":        opts.index,
		"indexCreated": indexCreated,
	}
	if mappingSource != "" {
		result["mappingSource"] = mappingSource
	}
	data, _ := json.Marshal(result)
	fmt.Println(string(data))
	return nil
}

func parseImportRow(
	line string,
	lineNumber int64,
	selectedColumns []string,
	fieldTransforms []fieldTransform,
) (map[string]any, error) {
	var value map[string]any
	if err := json.Unmarshal([]byte(line), &value); err != nil {
		return nil, fmt.Errorf("第 %d 行不是有效 JSON", lineNumber)
	}
	if source, ok := value["_source"]; ok {
		sourceMap, ok := source.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("第 %d 行的 _source 必须是 JSON 对象", lineNumber)
		}
		source, err := projectSource(sourceMap, selectedColumns, lineNumber)
		if err != nil {
			return nil, err
		}
		source, err = applyFieldTransforms(source, fieldTransforms, lineNumber)
		if err != nil {
			return nil, err
		}
		row := map[string]any{"_source": source}
		if id, ok := value["_id"].(string); ok && id != "" {
			row["_id"] = id
		}
		if routing, ok := value["_routing"].(string); ok && routing != "" {
			row["_routing"] = routing
		}
		return row, nil
	}

	delete(value, "_id")
	delete(value, "_index")
	delete(value, "_type")
	delete(value, "_routing")
	source, err := projectSource(value, selectedColumns, lineNumber)
	if err != nil {
		return nil, err
	}
	source, err = applyFieldTransforms(source, fieldTransforms, lineNumber)
	if err != nil {
		return nil, err
	}
	return map[string]any{"_source": source}, nil
}

func applyFieldTransforms(
	source map[string]any,
	transforms []fieldTransform,
	lineNumber int64,
) (map[string]any, error) {
	if len(transforms) == 0 {
		return source, nil
	}
	bySource := make(map[string]fieldTransform, len(transforms))
	for _, transform := range transforms {
		if _, ok := source[transform.SourceColumn]; !ok {
			return nil, fmt.Errorf(
				"第 %d 行缺少 fieldTransforms.sourceColumn：%s",
				lineNumber,
				transform.SourceColumn,
			)
		}
		bySource[transform.SourceColumn] = transform
	}
	output := make(map[string]any, len(source))
	for column, value := range source {
		transform, ok := bySource[column]
		if !ok {
			output[column] = value
			continue
		}
		if transform.Strategy == "skip" {
			continue
		}
		targetColumn := transform.TargetColumn
		if targetColumn == "" {
			targetColumn = column
		}
		converted, err := convertFieldValue(value, transform)
		if err != nil {
			return nil, fmt.Errorf("第 %d 行列 %s 转换失败：%w", lineNumber, column, err)
		}
		output[targetColumn] = converted
	}
	return output, nil
}

func convertFieldValue(value any, transform fieldTransform) (any, error) {
	if value == nil {
		return nil, nil
	}
	switch transform.Strategy {
	case "json":
		data, err := json.Marshal(value)
		if err != nil {
			return nil, err
		}
		return string(data), nil
	case "stringify":
		return fmt.Sprint(value), nil
	case "cast":
		sourceType := strings.ToLower(strings.TrimSpace(transform.SourceType))
		targetType := strings.ToLower(strings.TrimSpace(transform.TargetType))
		if strings.HasPrefix(sourceType, "array<") &&
			(targetType == "text" || targetType == "string" || strings.HasPrefix(targetType, "varchar")) {
			delimiter := ","
			if configured, ok := transform.Options["arrayDelimiter"].(string); ok {
				delimiter = configured
			}
			values, ok := value.([]any)
			if !ok {
				values = []any{value}
			}
			parts := make([]string, len(values))
			for index, item := range values {
				parts[index] = fmt.Sprint(item)
			}
			return strings.Join(parts, delimiter), nil
		}
		if strings.HasPrefix(sourceType, "map<") &&
			(targetType == "text" || targetType == "string" || strings.HasPrefix(targetType, "varchar")) {
			data, err := json.Marshal(value)
			if err != nil {
				return nil, err
			}
			return string(data), nil
		}
		if strings.Contains(sourceType, "int") &&
			(targetType == "boolean" || targetType == "bool") {
			number, err := strconv.ParseFloat(fmt.Sprint(value), 64)
			if err != nil {
				return nil, err
			}
			return number != 0, nil
		}
		if strings.Contains(targetType, "timestamp") ||
			strings.Contains(targetType, "datetime") ||
			strings.Contains(sourceType, "timestamp") ||
			strings.Contains(sourceType, "iso") {
			text := fmt.Sprint(value)
			parsed, err := time.Parse(time.RFC3339, text)
			if err != nil {
				return nil, err
			}
			return parsed.UTC().Format(time.RFC3339), nil
		}
		return value, nil
	default:
		return nil, fmt.Errorf("unsupported strategy: %s", transform.Strategy)
	}
}

func projectSource(
	source map[string]any,
	selectedColumns []string,
	lineNumber int64,
) (map[string]any, error) {
	if len(selectedColumns) == 0 {
		return source, nil
	}
	missing := make([]string, 0)
	for _, column := range selectedColumns {
		if _, ok := source[column]; !ok {
			missing = append(missing, column)
		}
	}
	if len(missing) > 0 {
		return nil, fmt.Errorf(
			"第 %d 行缺少 selectedColumns：%s",
			lineNumber,
			strings.Join(missing, ", "),
		)
	}
	projected := make(map[string]any, len(selectedColumns))
	for _, column := range selectedColumns {
		projected[column] = source[column]
	}
	return projected, nil
}

func flushBulk(
	client *elasticsearchClient,
	opts importOptions,
	rows []map[string]any,
) (int64, error) {
	action := "index"
	if opts.onConflict == "skip" {
		action = "create"
	}

	var buffer bytes.Buffer
	for _, row := range rows {
		meta := map[string]any{"_index": opts.index}
		if id, ok := row["_id"].(string); ok && id != "" {
			meta["_id"] = id
		}
		if routing, ok := row["_routing"].(string); ok && routing != "" {
			meta["routing"] = routing
		}
		actionData, _ := json.Marshal(map[string]any{action: meta})
		buffer.Write(actionData)
		buffer.WriteByte('\n')
		sourceData, _ := json.Marshal(row["_source"])
		buffer.Write(sourceData)
		buffer.WriteByte('\n')
	}

	responseData, err := client.request("POST", "/_bulk", "application/x-ndjson", buffer.Bytes())
	if err != nil {
		return 0, err
	}
	var response struct {
		Items []map[string]any `json:"items"`
	}
	if err := json.Unmarshal(responseData, &response); err != nil {
		return 0, fmt.Errorf("bulk 响应不是有效 JSON：%w", err)
	}

	var skipped int64
	for _, item := range response.Items {
		actionResult, ok := item[action].(map[string]any)
		if !ok {
			continue
		}
		if _, hasError := actionResult["error"]; !hasError {
			continue
		}
		if opts.onConflict == "skip" && statusAsInt(actionResult["status"]) == 409 {
			skipped++
			continue
		}
		return skipped, fmt.Errorf("%s 操作失败：%s", action, bulkReason(actionResult))
	}
	return skipped, nil
}

func statusAsInt(value any) int {
	switch number := value.(type) {
	case float64:
		return int(number)
	case int:
		return number
	case int64:
		return int(number)
	default:
		return 0
	}
}

func bulkReason(actionResult map[string]any) string {
	errorValue, ok := actionResult["error"].(map[string]any)
	if !ok {
		return "bulk 写入失败"
	}
	if reason, ok := errorValue["reason"].(string); ok && reason != "" {
		return reason
	}
	if errorType, ok := errorValue["type"].(string); ok && errorType != "" {
		return errorType
	}
	return "bulk 写入失败"
}

func loadMappingBody(opts importOptions) (map[string]any, string, error) {
	if opts.inlineMapping != "" {
		var body map[string]any
		if err := json.Unmarshal([]byte(opts.inlineMapping), &body); err != nil {
			return nil, "", fmt.Errorf("--inline-mapping 不是合法 JSON：%w", err)
		}
		return body, "inline", nil
	}
	if opts.mappingFile != "" {
		data, err := os.ReadFile(opts.mappingFile)
		if err != nil {
			return nil, "", fmt.Errorf("读取 mapping 文件失败：%w", err)
		}
		var body map[string]any
		if err := json.Unmarshal(data, &body); err != nil {
			return nil, "", fmt.Errorf("mapping 文件不是合法 JSON：%w", err)
		}
		return body, "sidecar", nil
	}
	return nil, "", nil
}

func ensureIndex(client *elasticsearchClient, opts importOptions) (bool, string, error) {
	_, err := client.request("HEAD", "/"+url.PathEscape(opts.index), "", nil)
	if err == nil {
		// 索引已存在；忽略 mapping 来源，按当前 mapping 直接 bulk。
		return false, "", nil
	}
	var httpErr *httpError
	if !errors.As(err, &httpErr) || httpErr.Status != 404 {
		// HEAD 出错但不是 404：保守按"已存在"处理，让 bulk 自己报错。
		return false, "", nil
	}
	if !opts.createIndex {
		return false, "", fmt.Errorf("目标索引 %q 不存在，且未启用 create-index", opts.index)
	}
	body, source, err := loadMappingBody(opts)
	if err != nil {
		return false, "", err
	}
	delete(body, "index") // sidecar 顶层有 "index" 字段，不属于 PUT body
	if len(body) == 0 {
		if source == "" {
			source = "auto"
		}
		return false, "", fmt.Errorf("mapping 来源（%s）不包含 settings/mappings/aliases", source)
	}
	payload, err := json.Marshal(body)
	if err != nil {
		return false, "", err
	}
	if _, err := client.request("PUT", "/"+url.PathEscape(opts.index), "application/json", payload); err != nil {
		return false, "", fmt.Errorf("创建索引 %q 失败：%w", opts.index, err)
	}
	return true, source, nil
}
