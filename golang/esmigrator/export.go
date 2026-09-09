package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"time"
)

type searchResponse struct {
	ScrollID string `json:"_scroll_id"`
	PitID    string `json:"pit_id"`
	Hits     struct {
		Hits []map[string]any `json:"hits"`
	} `json:"hits"`
}

func runExport(opts exportOptions) error {
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
	if err := os.MkdirAll(filepath.Dir(opts.outputFile), 0o755); err != nil {
		return err
	}

	partFile := opts.outputFile + ".part"
	flags := os.O_CREATE | os.O_WRONLY
	if opts.resumeRows > 0 {
		flags |= os.O_APPEND
	} else {
		flags |= os.O_TRUNC
	}
	output, err := os.OpenFile(partFile, flags, 0o644)
	if err != nil {
		return err
	}
	writer := bufio.NewWriterSize(output, 1<<20)
	startedAt := time.Now()

	var rows int64
	if opts.strategy == "search_after" {
		rows, err = exportWithSearchAfter(client, opts, writer)
	} else {
		rows, err = exportWithScroll(client, opts, writer)
	}
	if err != nil {
		_ = writer.Flush()
		_ = output.Close()
		return err
	}
	if err := writer.Flush(); err != nil {
		_ = output.Close()
		return err
	}
	if err := output.Close(); err != nil {
		return err
	}

	info, err := os.Stat(partFile)
	if err != nil {
		return err
	}
	if err := os.Remove(opts.outputFile); err != nil && !os.IsNotExist(err) {
		return err
	}
	if err := os.Rename(partFile, opts.outputFile); err != nil {
		return err
	}

	result := map[string]any{
		"rows":       rows,
		"bytes":      info.Size(),
		"durationMs": time.Since(startedAt).Milliseconds(),
		"index":      opts.index,
	}
	data, _ := json.Marshal(result)
	fmt.Println(string(data))
	return nil
}

func exportWithScroll(
	client *elasticsearchClient,
	opts exportOptions,
	writer *bufio.Writer,
) (int64, error) {
	rows := opts.resumeRows
	skipRemaining := opts.resumeRows
	searchBody := mustJSON(map[string]any{
		"size":  opts.batchSize,
		"query": map[string]any{"match_all": map[string]any{}},
		"sort":  []string{"_doc"},
	})
	responseData, err := client.request(
		"POST",
		"/"+url.PathEscape(opts.index)+"/_search?scroll=1m",
		"application/json",
		searchBody,
	)
	if err != nil {
		return 0, err
	}
	var response searchResponse
	if err := json.Unmarshal(responseData, &response); err != nil {
		return 0, fmt.Errorf("scroll 响应不是有效 JSON：%w", err)
	}
	scrollID := response.ScrollID
	if scrollID != "" {
		defer clearScroll(client, scrollID)
	}

	for {
		hits := response.Hits.Hits
		if len(hits) == 0 {
			break
		}
		start := int(skipRemaining)
		if start > len(hits) {
			start = len(hits)
		}
		skipRemaining -= int64(start)
		for _, hit := range hits[start:] {
			if err := writeHit(writer, hit); err != nil {
				return rows, err
			}
			rows++
		}
		if err := writer.Flush(); err != nil {
			return rows, err
		}
		if err := writeProgress(opts.progressFile, "export", rows, 0, 0, nil); err != nil {
			return rows, err
		}
		if err := checkCancel(opts.cancelFile); err != nil {
			return rows, err
		}
		if len(hits) < opts.batchSize || scrollID == "" {
			break
		}

		nextBody := mustJSON(map[string]any{
			"scroll":    "1m",
			"scroll_id": scrollID,
		})
		nextData, err := client.request("POST", "/_search/scroll", "application/json", nextBody)
		if err != nil {
			return rows, err
		}
		var next searchResponse
		if err := json.Unmarshal(nextData, &next); err != nil {
			return rows, fmt.Errorf("scroll 续读响应不是有效 JSON：%w", err)
		}
		if next.ScrollID != "" {
			scrollID = next.ScrollID
		}
		response = next
	}
	return rows, nil
}

func exportWithSearchAfter(
	client *elasticsearchClient,
	opts exportOptions,
	writer *bufio.Writer,
) (int64, error) {
	pitData, err := client.request(
		"POST",
		"/"+url.PathEscape(opts.index)+"/_pit?keep_alive=1m",
		"application/json",
		nil,
	)
	if err != nil {
		return 0, err
	}
	var pit struct {
		ID    string `json:"id"`
		PitID string `json:"pit_id"`
	}
	if err := json.Unmarshal(pitData, &pit); err != nil {
		return 0, fmt.Errorf("PIT 响应不是有效 JSON：%w", err)
	}
	pitID := pit.ID
	if pitID == "" {
		pitID = pit.PitID
	}
	if pitID == "" {
		return 0, errors.New("无法创建 Elasticsearch 时间点（PIT），请检查版本与索引权限")
	}
	defer clearPit(client, pitID)

	searchAfter := opts.searchAfter
	rows := opts.resumeRows
	skipRemaining := opts.resumeRows
	if searchAfter != nil {
		skipRemaining = 0
	}

	for {
		body := map[string]any{
			"size":  opts.batchSize,
			"query": map[string]any{"match_all": map[string]any{}},
			"sort":  []string{"_doc"},
			"pit": map[string]any{
				"id":         pitID,
				"keep_alive": "1m",
			},
		}
		if searchAfter != nil {
			body["search_after"] = searchAfter
		}
		responseData, err := client.request("POST", "/_search", "application/json", mustJSON(body))
		if err != nil {
			return rows, err
		}
		var response searchResponse
		if err := json.Unmarshal(responseData, &response); err != nil {
			return rows, fmt.Errorf("search_after 响应不是有效 JSON：%w", err)
		}
		if response.PitID != "" {
			pitID = response.PitID
		}

		hits := response.Hits.Hits
		if len(hits) == 0 {
			break
		}
		start := int(skipRemaining)
		if start > len(hits) {
			start = len(hits)
		}
		skipRemaining -= int64(start)
		for _, hit := range hits[start:] {
			if err := writeHit(writer, hit); err != nil {
				return rows, err
			}
			rows++
		}

		lastHit := hits[len(hits)-1]
		sortValue, ok := lastHit["sort"].([]any)
		if !ok || len(sortValue) == 0 {
			return rows, errors.New("search_after 响应缺少排序游标")
		}
		searchAfter = sortValue

		if err := writer.Flush(); err != nil {
			return rows, err
		}
		if err := writeProgress(opts.progressFile, "export", rows, 0, 0, searchAfter); err != nil {
			return rows, err
		}
		if err := checkCancel(opts.cancelFile); err != nil {
			return rows, err
		}
		if len(hits) < opts.batchSize {
			break
		}
	}
	return rows, nil
}

func writeHit(writer *bufio.Writer, hit map[string]any) error {
	source, ok := hit["_source"].(map[string]any)
	if !ok {
		source = map[string]any{}
	}
	line := map[string]any{"_source": source}
	if id, ok := hit["_id"].(string); ok && id != "" {
		line["_id"] = id
	}
	if routing, ok := hit["_routing"].(string); ok && routing != "" {
		line["_routing"] = routing
	}
	data, err := json.Marshal(line)
	if err != nil {
		return err
	}
	if _, err := writer.Write(data); err != nil {
		return err
	}
	return writer.WriteByte('\n')
}

func clearScroll(client *elasticsearchClient, scrollID string) {
	body := mustJSON(map[string]any{"scroll_id": scrollID})
	_, _ = client.request("DELETE", "/_search/scroll", "application/json", body)
}

func clearPit(client *elasticsearchClient, pitID string) {
	body := mustJSON(map[string]any{"id": pitID})
	_, _ = client.request("DELETE", "/_pit", "application/json", body)
}
