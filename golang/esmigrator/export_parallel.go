package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"
)

type exportSliceState struct {
	ID          int   `json:"id"`
	Rows        int64 `json:"rows"`
	SearchAfter []any `json:"searchAfter,omitempty"`
}

type parallelExportCursor struct {
	Rows   int64              `json:"rows"`
	Slices []exportSliceState `json:"slices"`
}

func runParallelExport(opts exportOptions) error {
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
	if opts.concurrency > maxConcurrency {
		return fmt.Errorf("--concurrency 不能超过 %d", maxConcurrency)
	}

	states := make([]exportSliceState, opts.concurrency)
	if opts.resumeCursor != "" {
		var cursor parallelExportCursor
		if err := json.Unmarshal([]byte(opts.resumeCursor), &cursor); err != nil {
			return fmt.Errorf("--resume-cursor 不是合法 JSON：%w", err)
		}
		if len(cursor.Slices) == 0 {
			if opts.resumeRows > 0 || cursor.Rows > 0 {
				return errors.New("并发导出无法从单并发游标恢复，请将并发度恢复为 1 或重新开始导出")
			}
		} else {
			states = make([]exportSliceState, len(cursor.Slices))
			for index, state := range cursor.Slices {
				state.ID = index
				states[index] = state
			}
		}
	} else if opts.resumeRows > 0 {
		return errors.New("并发导出无法从单并发游标恢复，请将并发度恢复为 1 或重新开始导出")
	} else {
		if err := removeSliceParts(opts.outputFile); err != nil {
			return err
		}
		for index := range states {
			states[index] = exportSliceState{ID: index}
		}
	}

	var (
		progressMu sync.Mutex
		errorMu    sync.Mutex
		stop       atomic.Bool
		workers    sync.WaitGroup
		firstErr   error
	)

	setError := func(err error) {
		if err == nil {
			return
		}
		errorMu.Lock()
		defer errorMu.Unlock()
		stop.Store(true)
		if firstErr == nil {
			firstErr = err
		}
	}

	persistProgress := func() error {
		progressMu.Lock()
		defer progressMu.Unlock()
		var rows int64
		snapshot := make([]exportSliceState, len(states))
		copy(snapshot, states)
		for _, state := range snapshot {
			rows += state.Rows
		}
		return writeCursorProgress(
			opts.progressFile,
			"export",
			rows,
			0,
			0,
			parallelExportCursor{Rows: rows, Slices: snapshot},
		)
	}

	startedAt := time.Now()
	for sliceID := range states {
		workers.Add(1)
		go func(id int) {
			defer workers.Done()
			if stop.Load() {
				return
			}

			localState := states[id]
			partPath := slicePartPath(opts.outputFile, id)
			flags := os.O_WRONLY
			if localState.Rows > 0 {
				flags |= os.O_APPEND
			} else {
				flags |= os.O_CREATE | os.O_TRUNC
			}
			part, err := os.OpenFile(partPath, flags, 0o644)
			if err != nil {
				setError(err)
				return
			}
			writer := bufio.NewWriterSize(part, 1<<20)

			onBatch := func() error {
				progressMu.Lock()
				states[id] = localState
				progressMu.Unlock()
				return persistProgress()
			}

			var exported int64
			if opts.strategy == "search_after" {
				exported, err = exportSliceSearchAfter(
					client,
					opts,
					id,
					len(states),
					&localState,
					writer,
					onBatch,
				)
			} else {
				exported, err = exportSliceScroll(
					client,
					opts,
					id,
					len(states),
					&localState,
					writer,
					onBatch,
				)
			}
			_ = exported

			flushErr := writer.Flush()
			closeErr := part.Close()
			if err == nil {
				err = flushErr
			}
			if err == nil {
				err = closeErr
			}
			if err != nil {
				setError(err)
			}
		}(sliceID)
	}
	workers.Wait()
	if firstErr != nil {
		return firstErr
	}

	if err := persistProgress(); err != nil {
		return err
	}
	if err := mergeSliceParts(opts.outputFile, len(states)); err != nil {
		return err
	}

	var rows int64
	for _, state := range states {
		rows += state.Rows
	}
	info, err := os.Stat(opts.outputFile)
	if err != nil {
		return err
	}

	var mappingFile string
	if opts.exportMapping {
		if err := checkCancel(opts.cancelFile); err != nil {
			return err
		}
		mappingFile, err = exportMappingSidecar(client, opts)
		if err != nil {
			return err
		}
	}

	result := map[string]any{
		"rows":        rows,
		"bytes":       info.Size(),
		"durationMs":  time.Since(startedAt).Milliseconds(),
		"index":       opts.index,
		"mappingFile": mappingFile,
		"concurrency": opts.concurrency,
	}
	fmt.Println(string(mustJSON(result)))
	return nil
}

func exportSliceScroll(
	client *elasticsearchClient,
	opts exportOptions,
	sliceID int,
	sliceMax int,
	state *exportSliceState,
	writer *bufio.Writer,
	onBatch func() error,
) (int64, error) {
	searchBody, err := sliceSearchBody(opts, sliceID, sliceMax)
	if err != nil {
		return state.Rows, err
	}
	responseData, err := client.request(
		"POST",
		"/"+url.PathEscape(opts.index)+"/_search?scroll=1m",
		"application/json",
		searchBody,
	)
	if err != nil {
		return state.Rows, err
	}
	var response searchResponse
	if err := json.Unmarshal(responseData, &response); err != nil {
		return state.Rows, fmt.Errorf("scroll 响应不是有效 JSON：%w", err)
	}
	scrollID := response.ScrollID
	if scrollID != "" {
		defer clearScroll(client, scrollID)
	}

	skipRemaining := state.Rows
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
				return state.Rows, err
			}
			state.Rows++
		}
		if err := writer.Flush(); err != nil {
			return state.Rows, err
		}
		if err := onBatch(); err != nil {
			return state.Rows, err
		}
		if err := checkCancel(opts.cancelFile); err != nil {
			return state.Rows, err
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
			return state.Rows, err
		}
		var next searchResponse
		if err := json.Unmarshal(nextData, &next); err != nil {
			return state.Rows, fmt.Errorf("scroll 续读响应不是有效 JSON：%w", err)
		}
		if next.ScrollID != "" {
			scrollID = next.ScrollID
		}
		response = next
	}
	return state.Rows, nil
}

func exportSliceSearchAfter(
	client *elasticsearchClient,
	opts exportOptions,
	sliceID int,
	sliceMax int,
	state *exportSliceState,
	writer *bufio.Writer,
	onBatch func() error,
) (int64, error) {
	pitData, err := client.request(
		"POST",
		"/"+url.PathEscape(opts.index)+"/_pit?keep_alive=1m",
		"application/json",
		nil,
	)
	if err != nil {
		return state.Rows, err
	}
	var pit struct {
		ID    string `json:"id"`
		PitID string `json:"pit_id"`
	}
	if err := json.Unmarshal(pitData, &pit); err != nil {
		return state.Rows, fmt.Errorf("PIT 响应不是有效 JSON：%w", err)
	}
	pitID := pit.ID
	if pitID == "" {
		pitID = pit.PitID
	}
	if pitID == "" {
		return state.Rows, errors.New("无法创建 Elasticsearch 时间点（PIT），请检查版本与索引权限")
	}
	defer clearPit(client, pitID)

	searchAfter := state.SearchAfter
	skipRemaining := int64(0)
	if searchAfter == nil {
		skipRemaining = state.Rows
	}

	for {
		queryMap, err := resolveQueryMap(opts)
		if err != nil {
			return state.Rows, err
		}
		body, err := sliceSearchBody(opts, sliceID, sliceMax)
		if err != nil {
			return state.Rows, err
		}
		var bodyMap map[string]any
		if err := json.Unmarshal(body, &bodyMap); err != nil {
			return state.Rows, err
		}
		bodyMap["query"] = queryMap
		bodyMap["pit"] = map[string]any{
			"id":         pitID,
			"keep_alive": "1m",
		}
		if searchAfter != nil {
			bodyMap["search_after"] = searchAfter
		}

		responseData, err := client.request("POST", "/_search", "application/json", mustJSON(bodyMap))
		if err != nil {
			return state.Rows, err
		}
		var response searchResponse
		if err := json.Unmarshal(responseData, &response); err != nil {
			return state.Rows, fmt.Errorf("search_after 响应不是有效 JSON：%w", err)
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
				return state.Rows, err
			}
			state.Rows++
		}

		lastHit := hits[len(hits)-1]
		sortValue, ok := lastHit["sort"].([]any)
		if !ok || len(sortValue) == 0 {
			return state.Rows, errors.New("search_after 响应缺少排序游标")
		}
		if searchAfter != nil && fmt.Sprint(searchAfter) == fmt.Sprint(sortValue) {
			return state.Rows, errors.New("search_after 游标没有推进")
		}
		searchAfter = sortValue
		state.SearchAfter = sortValue

		if err := writer.Flush(); err != nil {
			return state.Rows, err
		}
		if err := onBatch(); err != nil {
			return state.Rows, err
		}
		if err := checkCancel(opts.cancelFile); err != nil {
			return state.Rows, err
		}
		if len(hits) < opts.batchSize {
			break
		}
	}
	return state.Rows, nil
}

func sliceSearchBody(opts exportOptions, sliceID int, sliceMax int) ([]byte, error) {
	body := map[string]any{
		"size": opts.batchSize,
		"sort": []string{"_shard_doc"},
		"slice": map[string]any{
			"id":  sliceID,
			"max": sliceMax,
		},
	}
	queryMap, err := resolveQueryMap(opts)
	if err != nil {
		return nil, err
	}
	body["query"] = queryMap
	return mustJSON(body), nil
}

func slicePartPath(outputFile string, sliceID int) string {
	return fmt.Sprintf("%s.part.%d", outputFile, sliceID)
}

func removeSliceParts(outputFile string) error {
	matches, err := filepath.Glob(outputFile + ".part.*")
	if err != nil {
		return err
	}
	for _, path := range matches {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	return nil
}

func mergeSliceParts(outputFile string, sliceCount int) error {
	temporaryPath := outputFile + ".part"
	if err := os.Remove(temporaryPath); err != nil && !os.IsNotExist(err) {
		return err
	}
	output, err := os.OpenFile(temporaryPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}

	for sliceID := 0; sliceID < sliceCount; sliceID++ {
		part, err := os.Open(slicePartPath(outputFile, sliceID))
		if err != nil {
			_ = output.Close()
			return err
		}
		_, copyErr := io.Copy(output, part)
		closeErr := part.Close()
		if copyErr != nil {
			_ = output.Close()
			return copyErr
		}
		if closeErr != nil {
			_ = output.Close()
			return closeErr
		}
	}
	if err := output.Close(); err != nil {
		return err
	}

	if err := os.Remove(outputFile); err != nil && !os.IsNotExist(err) {
		return err
	}
	if err := os.Rename(temporaryPath, outputFile); err != nil {
		return err
	}
	return removeSliceParts(outputFile)
}
