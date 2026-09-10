package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"
)

// runDirect reads from source ES and streams documents directly into target ES,
// never touching the local filesystem.
func runDirect(opts directOptions) error {
	if opts.batchSize <= 0 {
		opts.batchSize = 500
	}
	if opts.onConflict == "" {
		opts.onConflict = "skip"
	}

	srcClient, err := newElasticsearchClient(opts.srcURL, opts.srcUsername, opts.srcPassword, opts.srcInsecure)
	if err != nil {
		return fmt.Errorf("source: %w", err)
	}
	dstClient, err := newElasticsearchClient(opts.dstURL, opts.dstUsername, opts.dstPassword, opts.dstInsecure)
	if err != nil {
		return fmt.Errorf("target: %w", err)
	}

	if err := checkCancel(opts.cancelFile); err != nil {
		return err
	}

	startedAt := time.Now()
	var rows int64

	if opts.strategy == "search_after" {
		rows, err = directSearchAfter(srcClient, dstClient, opts)
	} else {
		rows, err = directScroll(srcClient, dstClient, opts)
	}
	if err != nil {
		return err
	}

	result := map[string]any{
		"rows":        rows,
		"durationMs":  time.Since(startedAt).Milliseconds(),
		"index":       opts.srcIndex,
		"targetIndex": opts.dstIndex,
		"mode":        "direct",
	}
	data, _ := json.Marshal(result)
	fmt.Println(string(data))
	return nil
}

// directScroll streams from source ES using scroll, immediately bulk-inserts into target ES.
func directScroll(srcClient, dstClient *elasticsearchClient, opts directOptions) (int64, error) {
	searchBody := mustJSON(map[string]any{
		"size":  opts.batchSize,
		"query": map[string]any{"match_all": map[string]any{}},
		"sort":  []string{"_doc"},
	})
	responseData, err := srcClient.request(
		"POST",
		"/"+url.PathEscape(opts.srcIndex)+"/_search?scroll=1m",
		"application/json",
		searchBody,
	)
	if err != nil {
		return 0, fmt.Errorf("scroll init: %w", err)
	}
	var response searchResponse
	if err := json.Unmarshal(responseData, &response); err != nil {
		return 0, fmt.Errorf("scroll response not valid JSON: %w", err)
	}
	scrollID := response.ScrollID
	if scrollID != "" {
		defer clearScroll(srcClient, scrollID)
	}

	var rows int64
	skipRemaining := opts.resumeRows

	for {
		hits := response.Hits.Hits
		if len(hits) == 0 {
			break
		}

		// Skip already-processed rows (resume support).
		start := int(skipRemaining)
		if start > len(hits) {
			start = len(hits)
		}
		skipRemaining -= int64(start)
		pageHits := hits[start:]
		if len(pageHits) == 0 {
			if scrollID == "" || len(hits) < opts.batchSize {
				break
			}
			// Fetch next batch.
			nextBody := mustJSON(map[string]any{
				"scroll":    "1m",
				"scroll_id": scrollID,
			})
			nextData, err := srcClient.request("POST", "/_search/scroll", "application/json", nextBody)
			if err != nil {
				return rows, fmt.Errorf("scroll next: %w", err)
			}
			var next searchResponse
			if err := json.Unmarshal(nextData, &next); err != nil {
				return rows, fmt.Errorf("scroll next response: %w", err)
			}
			if next.ScrollID != "" {
				scrollID = next.ScrollID
			}
			response = next
			continue
		}

		// Bulk-insert this batch directly into target.
		skipped, err := directFlushBulk(dstClient, opts.dstIndex, opts, pageHits)
		if err != nil {
			return rows, fmt.Errorf("bulk insert: %w", err)
		}
		rows += int64(len(pageHits)) - skipped

		if err := writeProgress(opts.progressFile, "direct", rows, 0, skipped, nil); err != nil {
			return rows, err
		}
		if err := checkCancel(opts.cancelFile); err != nil {
			return rows, err
		}

		if len(hits) < opts.batchSize || scrollID == "" {
			break
		}

		// Fetch next batch.
		nextBody := mustJSON(map[string]any{
			"scroll":    "1m",
			"scroll_id": scrollID,
		})
		nextData, err := srcClient.request("POST", "/_search/scroll", "application/json", nextBody)
		if err != nil {
			return rows, fmt.Errorf("scroll next: %w", err)
		}
		var next searchResponse
		if err := json.Unmarshal(nextData, &next); err != nil {
			return rows, fmt.Errorf("scroll next response: %w", err)
		}
		if next.ScrollID != "" {
			scrollID = next.ScrollID
		}
		response = next
	}
	return rows, nil
}

// directSearchAfter uses ES PIT + search_after to stream documents, immediately bulk-inserting each batch.
func directSearchAfter(srcClient, dstClient *elasticsearchClient, opts directOptions) (int64, error) {
	pitData, err := srcClient.request(
		"POST",
		"/"+url.PathEscape(opts.srcIndex)+"/_pit?keep_alive=1m",
		"application/json",
		nil,
	)
	if err != nil {
		return 0, fmt.Errorf("PIT init: %w", err)
	}
	var pit struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(pitData, &pit); err != nil {
		return 0, fmt.Errorf("PIT response: %w", err)
	}
	pitID := pit.ID
	if pitID == "" {
		return 0, fmt.Errorf("could not create PIT for index %s", opts.srcIndex)
	}
	defer clearPit(srcClient, pitID)

	searchAfter := opts.resumeSearch
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
		responseData, err := srcClient.request("POST", "/_search", "application/json", mustJSON(body))
		if err != nil {
			return rows, fmt.Errorf("search_after request: %w", err)
		}
		var response searchResponse
		if err := json.Unmarshal(responseData, &response); err != nil {
			return rows, fmt.Errorf("search_after response: %w", err)
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
		pageHits := hits[start:]
		if len(pageHits) == 0 {
			break
		}

		skipped, err := directFlushBulk(dstClient, opts.dstIndex, opts, pageHits)
		if err != nil {
			return rows, fmt.Errorf("bulk insert: %w", err)
		}
		rows += int64(len(pageHits)) - skipped

		lastHit := hits[len(hits)-1]
		sortValue, _ := lastHit["sort"].([]any)
		searchAfter = sortValue

		if err := writeProgress(opts.progressFile, "direct", rows, 0, skipped, searchAfter); err != nil {
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

// directFlushBulk sends a batch of documents to the target ES _bulk API.
// It returns the number of skipped (conflicted) documents.
func directFlushBulk(client *elasticsearchClient, index string, opts directOptions, hits []map[string]any) (int64, error) {
	action := "index"
	if opts.onConflict == "skip" {
		action = "create"
	}

	var buf bytes.Buffer
	for _, hit := range hits {
		meta := map[string]any{"_index": index}
		if id, ok := hit["_id"].(string); ok && id != "" {
			meta["_id"] = id
		}
		if routing, ok := hit["_routing"].(string); ok && routing != "" {
			meta["routing"] = routing
		}
		metaData, _ := json.Marshal(map[string]any{action: meta})
		buf.Write(metaData)
		buf.WriteByte('\n')
		source, _ := hit["_source"].(map[string]any)
		sourceData, _ := json.Marshal(source)
		buf.Write(sourceData)
		buf.WriteByte('\n')
	}

	// Build request manually to control content-length header.
	req, err := http.NewRequest("POST", client.baseURL+"/_bulk", bytes.NewReader(buf.Bytes()))
	if err != nil {
		return 0, err
	}
	if client.username != "" {
		req.SetBasicAuth(client.username, client.password)
	}
	req.Header.Set("Content-Type", "application/x-ndjson")

	response, err := client.http.Do(req)
	if err != nil {
		return 0, fmt.Errorf("bulk request: %w", err)
	}
	defer response.Body.Close()

	responseData, err := io.ReadAll(response.Body)
	if err != nil {
		return 0, fmt.Errorf("read bulk response: %w", err)
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return 0, elasticsearchHTTPError(response.StatusCode, responseData)
	}

	var bulkResp struct {
		Items []map[string]any `json:"items"`
	}
	if err := json.Unmarshal(responseData, &bulkResp); err != nil {
		return 0, fmt.Errorf("bulk response not valid JSON: %w", err)
	}

	var skipped int64
	for _, item := range bulkResp.Items {
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
		return skipped, fmt.Errorf("%s failed: %s", action, bulkReason(actionResult))
	}
	return skipped, nil
}
