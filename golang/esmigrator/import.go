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
	targetTypes := loadTargetFieldTypes(client, opts.index)

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

		parsedRows, err := parseImportRows(
			line,
			lines,
			opts.selectedCols,
			opts.fieldTransforms,
			targetTypes,
		)
		if err != nil {
			return err
		}
		pending = append(pending, parsedRows...)
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

func parseImportRows(
	line string,
	lineNumber int64,
	selectedColumns []string,
	fieldTransforms []fieldTransform,
	targetTypes map[string]string,
) ([]map[string]any, error) {
	var value map[string]any
	if err := json.Unmarshal([]byte(line), &value); err != nil {
		return nil, fmt.Errorf("第 %d 行不是有效 JSON", lineNumber)
	}

	columnsValue, hasColumns := value["columns"]
	rowsValue, hasRows := value["rows"]
	if hasColumns || hasRows {
		columns, err := stringArray(columnsValue)
		if err != nil {
			return nil, fmt.Errorf("第 %d 行的 columns 必须是字符串数组", lineNumber)
		}
		rawRows, ok := rowsValue.([]any)
		if !ok {
			return nil, fmt.Errorf("第 %d 行的 rows 必须是数组", lineNumber)
		}
		parsedRows := make([]map[string]any, 0, len(rawRows))
		for rowIndex, rawRow := range rawRows {
			values, ok := rawRow.([]any)
			if !ok {
				return nil, fmt.Errorf(
					"第 %d 行 rows[%d] 必须是数组",
					lineNumber,
					rowIndex,
				)
			}
			if len(values) != len(columns) {
				return nil, fmt.Errorf(
					"第 %d 行 rows[%d] 的值数量（%d）与 columns（%d）不一致",
					lineNumber,
					rowIndex,
					len(values),
					len(columns),
				)
			}
			record := make(map[string]any, len(columns))
			for columnIndex, column := range columns {
				record[column] = values[columnIndex]
			}
			parsed, err := parseImportRecord(
				record,
				formatRowLocation(lineNumber, rowIndex),
				selectedColumns,
				fieldTransforms,
				targetTypes,
			)
			if err != nil {
				return nil, err
			}
			parsedRows = append(parsedRows, parsed)
		}
		return parsedRows, nil
	}

	parsed, err := parseImportRecord(
		value,
		fmt.Sprintf("第 %d 行", lineNumber),
		selectedColumns,
		fieldTransforms,
		targetTypes,
	)
	if err != nil {
		return nil, err
	}
	return []map[string]any{parsed}, nil
}

func parseImportRecord(
	value map[string]any,
	location string,
	selectedColumns []string,
	fieldTransforms []fieldTransform,
	targetTypes map[string]string,
) (map[string]any, error) {
	if source, ok := value["_source"]; ok {
		sourceMap, ok := source.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("%s 的 _source 必须是 JSON 对象", location)
		}
		source, err := projectSource(sourceMap, selectedColumns, location)
		if err != nil {
			return nil, err
		}
		source, err = applyFieldTransforms(
			source,
			fieldTransforms,
			targetTypes,
			location,
		)
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
	source, err := projectSource(value, selectedColumns, location)
	if err != nil {
		return nil, err
	}
	source, err = applyFieldTransforms(
		source,
		fieldTransforms,
		targetTypes,
		location,
	)
	if err != nil {
		return nil, err
	}
	return map[string]any{"_source": source}, nil
}

func applyFieldTransforms(
	source map[string]any,
	transforms []fieldTransform,
	targetTypes map[string]string,
	location string,
) (map[string]any, error) {
	bySource := make(map[string]fieldTransform, len(transforms))
	for _, transform := range transforms {
		if _, ok := source[transform.SourceColumn]; !ok {
			return nil, fmt.Errorf(
				"%s 缺少 fieldTransforms.sourceColumn：%s",
				location,
				transform.SourceColumn,
			)
		}
		bySource[transform.SourceColumn] = transform
	}
	output := make(map[string]any, len(source))
	for column, value := range source {
		transform, ok := bySource[column]
		if !ok {
			converted, err := defaultTargetValue(value, targetTypes[column])
			if err != nil {
				return nil, fmt.Errorf(
					"%s 字段 %s 转换为 %s 失败：%w",
					location,
					column,
					targetTypes[column],
					err,
				)
			}
			output[column] = converted
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
			return nil, fmt.Errorf(
				"%s 字段 %s 转换失败（%s -> %s）：%w",
				location,
				column,
				transform.SourceType,
				transform.TargetType,
				err,
			)
		}
		output[targetColumn] = converted
	}
	return output, nil
}

func defaultTargetValue(value any, targetType string) (any, error) {
	if value == nil || strings.TrimSpace(targetType) == "" || !isStringTarget(targetType) {
		return value, nil
	}
	switch value.(type) {
	case map[string]any, []any:
		data, err := json.Marshal(value)
		if err != nil {
			return nil, err
		}
		return string(data), nil
	default:
		return value, nil
	}
}

func isStringTarget(targetType string) bool {
	normalized := strings.ToLower(strings.TrimSpace(targetType))
	return normalized == "string" ||
		normalized == "text" ||
		normalized == "keyword" ||
		normalized == "wildcard" ||
		normalized == "character" ||
		normalized == "character varying" ||
		strings.HasPrefix(normalized, "varchar") ||
		strings.HasPrefix(normalized, "char") ||
		strings.HasPrefix(normalized, "nvarchar")
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
	location string,
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
			"%s 缺少 selectedColumns：%s",
			location,
			strings.Join(missing, ", "),
		)
	}
	projected := make(map[string]any, len(selectedColumns))
	for _, column := range selectedColumns {
		projected[column] = source[column]
	}
	return projected, nil
}

func stringArray(value any) ([]string, error) {
	raw, ok := value.([]any)
	if !ok {
		return nil, errors.New("not an array")
	}
	values := make([]string, len(raw))
	for index, item := range raw {
		text, ok := item.(string)
		if !ok {
			return nil, errors.New("array item is not a string")
		}
		values[index] = text
	}
	return values, nil
}

func formatRowLocation(lineNumber int64, rowIndex int) string {
	return fmt.Sprintf("第 %d 行 rows[%d]", lineNumber, rowIndex)
}

func loadTargetFieldTypes(
	client *elasticsearchClient,
	index string,
) map[string]string {
	response, err := client.request(
		"GET",
		"/"+url.PathEscape(index)+"/_mapping",
		"",
		nil,
	)
	if err != nil {
		return map[string]string{}
	}
	var body map[string]any
	if err := json.Unmarshal(response, &body); err != nil {
		return map[string]string{}
	}
	indexMapping, _ := body[index].(map[string]any)
	if indexMapping == nil {
		for _, raw := range body {
			if candidate, ok := raw.(map[string]any); ok {
				indexMapping = candidate
				break
			}
		}
	}
	if indexMapping == nil {
		return map[string]string{}
	}
	mappings, _ := indexMapping["mappings"].(map[string]any)
	properties, _ := mappings["properties"].(map[string]any)
	result := make(map[string]string)
	flattenTargetFieldTypes(properties, "", result)
	return result
}

func flattenTargetFieldTypes(
	properties map[string]any,
	prefix string,
	result map[string]string,
) {
	for field, raw := range properties {
		definition, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		name := field
		if prefix != "" {
			name = prefix + "." + field
		}
		if dataType, ok := definition["type"].(string); ok && dataType != "" {
			result[name] = dataType
		}
		if nested, ok := definition["properties"].(map[string]any); ok {
			flattenTargetFieldTypes(nested, name, result)
		}
		if fields, ok := definition["fields"].(map[string]any); ok {
			for subField, rawSubField := range fields {
				subDefinition, ok := rawSubField.(map[string]any)
				if !ok {
					continue
				}
				if dataType, ok := subDefinition["type"].(string); ok && dataType != "" {
					result[name+"."+subField] = dataType
				}
			}
		}
	}
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
