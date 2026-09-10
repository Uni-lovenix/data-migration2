package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestExportWithScroll(t *testing.T) {
	directory := t.TempDir()
	outputFile := filepath.Join(directory, "logs.jsonl")
	progressFile := filepath.Join(directory, "progress.json")
	var requests []string
	var mu sync.Mutex

	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		mu.Lock()
		requests = append(requests, request.Method+" "+request.URL.Path)
		mu.Unlock()
		switch request.URL.Path {
		case "/logs/_search":
			_, _ = writer.Write([]byte(`{
				"_scroll_id": "scroll-1",
				"hits": {"hits": [
					{"_id": "1", "_source": {"level": "info"}},
					{"_id": "2", "_source": {"level": "warn"}}
				]}
			}`))
		case "/_search/scroll":
			if request.Method == http.MethodDelete {
				_, _ = writer.Write([]byte(`{"succeeded": true}`))
				return
			}
			_, _ = writer.Write([]byte(`{
				"_scroll_id": "scroll-2",
				"hits": {"hits": [
					{"_id": "3", "_source": {"level": "error"}}
				]}
			}`))
		default:
			http.Error(writer, "unexpected", http.StatusNotFound)
		}
	}))
	defer server.Close()

	err := runExport(exportOptions{
		url:          server.URL,
		index:        "logs",
		outputFile:   outputFile,
		batchSize:    2,
		strategy:     "scroll",
		progressFile: progressFile,
	})
	if err != nil {
		t.Fatalf("runExport: %v", err)
	}

	content, err := os.ReadFile(outputFile)
	if err != nil {
		t.Fatalf("read output: %v", err)
	}
	lines := strings.Split(strings.TrimSpace(string(content)), "\n")
	if len(lines) != 3 {
		t.Fatalf("expected 3 lines, got %d", len(lines))
	}
	if !strings.Contains(string(content), `"_id":"1"`) {
		t.Fatalf("output is missing exported document: %s", content)
	}
	progressData, err := os.ReadFile(progressFile)
	if err != nil {
		t.Fatalf("read progress: %v", err)
	}
	var reported progress
	if err := json.Unmarshal(progressData, &reported); err != nil {
		t.Fatalf("parse progress: %v", err)
	}
	if reported.Rows != 3 {
		t.Fatalf("expected progress rows 3, got %d", reported.Rows)
	}
	mu.Lock()
	defer mu.Unlock()
	if !contains(requests, "DELETE /_search/scroll") {
		t.Fatalf("scroll context was not cleared: %v", requests)
	}
}

func TestExportWithSearchAfterAndResume(t *testing.T) {
	directory := t.TempDir()
	outputFile := filepath.Join(directory, "logs.jsonl")
	progressFile := filepath.Join(directory, "progress.json")
	var searches int

	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/logs/_pit":
			_, _ = writer.Write([]byte(`{"id": "pit-1"}`))
		case "/_search":
			searches++
			if searches == 1 {
				_, _ = writer.Write([]byte(`{
					"pit_id": "pit-2",
					"hits": {"hits": [
						{"_id": "2", "_source": {"seq": 2}, "sort": [2]}
					]}
				}`))
			} else {
				_, _ = writer.Write([]byte(`{
					"pit_id": "pit-2",
					"hits": {"hits": []}
				}`))
			}
		case "/_pit":
			_, _ = writer.Write([]byte(`{"succeeded": true}`))
		default:
			http.Error(writer, "unexpected", http.StatusNotFound)
		}
	}))
	defer server.Close()

	err := runExport(exportOptions{
		url:          server.URL,
		index:        "logs",
		outputFile:   outputFile,
		batchSize:    2,
		strategy:     "search_after",
		resumeRows:   1,
		searchAfter:  []any{1},
		progressFile: progressFile,
	})
	if err != nil {
		t.Fatalf("runExport: %v", err)
	}

	content, err := os.ReadFile(outputFile)
	if err != nil {
		t.Fatalf("read output: %v", err)
	}
	if !strings.Contains(string(content), `"_id":"2"`) {
		t.Fatalf("expected resumed document, got %s", content)
	}
	progressData, err := os.ReadFile(progressFile)
	if err != nil {
		t.Fatalf("read progress: %v", err)
	}
	var reported progress
	if err := json.Unmarshal(progressData, &reported); err != nil {
		t.Fatalf("parse progress: %v", err)
	}
	if reported.Rows != 2 {
		t.Fatalf("expected progress rows 2, got %d", reported.Rows)
	}
	if reported.SearchAfter == nil {
		t.Fatalf("expected search_after cursor in progress")
	}
}

func TestImportWithBulkAndConflictSkip(t *testing.T) {
	directory := t.TempDir()
	inputFile := filepath.Join(directory, "logs.jsonl")
	content := []string{
		`{"_id": "1", "_source": {"level": "info"}}`,
		`{"_id": "2", "_source": {"level": "warn"}}`,
		`{"_id": "3", "_source": {"level": "error"}}`,
	}
	if err := os.WriteFile(inputFile, []byte(strings.Join(content, "\n")+"\n"), 0o644); err != nil {
		t.Fatalf("write input: %v", err)
	}

	progressFile := filepath.Join(directory, "progress.json")
	var bulkBodies []string
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch {
		case request.Method == http.MethodHead && request.URL.Path == "/logs":
			writer.WriteHeader(http.StatusOK)
			return
		case request.URL.Path != "/_bulk":
			http.Error(writer, "unexpected", http.StatusNotFound)
			return
		}
		body := make([]byte, request.ContentLength)
		_, _ = request.Body.Read(body)
		bulkBodies = append(bulkBodies, string(body))
		if len(bulkBodies) == 1 {
			_, _ = writer.Write([]byte(`{
				"items": [
					{"create": {"status": 201}},
					{"create": {"status": 409, "error": {"type": "version_conflict_engine_exception", "reason": "already exists"}}}
				]
			}`))
		} else {
			_, _ = writer.Write([]byte(`{"items": [{"create": {"status": 201}}]}`))
		}
	}))
	defer server.Close()

	err := runImport(importOptions{
		url:          server.URL,
		index:        "logs",
		inputFile:    inputFile,
		batchSize:    2,
		onConflict:   "skip",
		progressFile: progressFile,
		createIndex:  false,
	})
	if err != nil {
		t.Fatalf("runImport: %v", err)
	}
	if len(bulkBodies) != 2 {
		t.Fatalf("expected 2 bulk requests, got %d", len(bulkBodies))
	}
	if !strings.Contains(bulkBodies[0], `"create"`) || !strings.Contains(bulkBodies[0], `"_id":"2"`) {
		t.Fatalf("unexpected bulk body: %s", bulkBodies[0])
	}

	progressData, err := os.ReadFile(progressFile)
	if err != nil {
		t.Fatalf("read progress: %v", err)
	}
	var reported progress
	if err := json.Unmarshal(progressData, &reported); err != nil {
		t.Fatalf("parse progress: %v", err)
	}
	if reported.Rows != 3 || reported.Skipped != 1 {
		t.Fatalf("expected rows 3 skipped 1, got rows %d skipped %d", reported.Rows, reported.Skipped)
	}
}

func TestExportHonorsCancelFile(t *testing.T) {
	directory := t.TempDir()
	cancelFile := filepath.Join(directory, "cancel")
	if err := os.WriteFile(cancelFile, []byte("cancel"), 0o644); err != nil {
		t.Fatalf("write cancel marker: %v", err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		_, _ = writer.Write([]byte(`{"hits": {"hits": []}}`))
	}))
	defer server.Close()

	err := runExport(exportOptions{
		url:        server.URL,
		index:      "logs",
		outputFile: filepath.Join(directory, "logs.jsonl"),
		batchSize:  10,
		strategy:   "scroll",
		cancelFile: cancelFile,
	})
	if !errors.Is(err, errCanceled) {
		t.Fatalf("expected errCanceled, got %v", err)
	}
}

func contains(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func TestExportHonorsQuery(t *testing.T) {
	directory := t.TempDir()
	outputFile := filepath.Join(directory, "logs.jsonl")

	var searchBodies []string
	var mu sync.Mutex
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/logs/_search":
			body := make([]byte, request.ContentLength)
			_, _ = request.Body.Read(body)
			mu.Lock()
			searchBodies = append(searchBodies, string(body))
			mu.Unlock()
			_, _ = writer.Write([]byte(`{"hits": {"hits": []}}`))
		default:
			http.Error(writer, "unexpected", http.StatusNotFound)
		}
	}))
	defer server.Close()

	err := runExport(exportOptions{
		url:        server.URL,
		index:      "logs",
		outputFile: outputFile,
		batchSize:  10,
		strategy:   "scroll",
		query:      `{"range":{"level":{"gte":"warn"}}}`,
	})
	if err != nil {
		t.Fatalf("runExport: %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(searchBodies) != 1 {
		t.Fatalf("expected one search request, got %d", len(searchBodies))
	}
	if !strings.Contains(searchBodies[0], `"range"`) {
		t.Fatalf("expected query DSL to be forwarded, got %s", searchBodies[0])
	}
	if strings.Contains(searchBodies[0], `"match_all"`) {
		t.Fatalf("expected user query to replace match_all, got %s", searchBodies[0])
	}
}

func TestExportRejectsMalformedQuery(t *testing.T) {
	directory := t.TempDir()
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		http.Error(writer, "should not be called", http.StatusInternalServerError)
	}))
	defer server.Close()

	err := runExport(exportOptions{
		url:        server.URL,
		index:      "logs",
		outputFile: filepath.Join(directory, "logs.jsonl"),
		batchSize:  10,
		strategy:   "scroll",
		query:      "{not json",
	})
	if err == nil {
		t.Fatalf("expected runExport to reject malformed query")
	}
	if !strings.Contains(err.Error(), "query") && !strings.Contains(err.Error(), "JSON") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestExportWritesMappingSidecar(t *testing.T) {
	directory := t.TempDir()
	outputFile := filepath.Join(directory, "logs.jsonl")
	sidecarPath := outputFile + ".mapping.json"

	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/logs/_search":
			_, _ = writer.Write([]byte(`{"hits": {"hits": []}}`))
		case "/logs":
			if request.Method != http.MethodGet {
				http.Error(writer, "unexpected method", http.StatusMethodNotAllowed)
				return
			}
			_, _ = writer.Write([]byte(`{
				"logs": {
					"settings": { "number_of_shards": 1 },
					"mappings": { "properties": { "level": { "type": "keyword" } } },
					"aliases": { "logs-read": {} }
				}
			}`))
		default:
			http.Error(writer, "unexpected", http.StatusNotFound)
		}
	}))
	defer server.Close()

	err := runExport(exportOptions{
		url:           server.URL,
		index:         "logs",
		outputFile:    outputFile,
		batchSize:     10,
		strategy:      "scroll",
		exportMapping: true,
	})
	if err != nil {
		t.Fatalf("runExport: %v", err)
	}

	sidecarBytes, err := os.ReadFile(sidecarPath)
	if err != nil {
		t.Fatalf("read sidecar: %v", err)
	}
	var parsed map[string]any
	if err := json.Unmarshal(sidecarBytes, &parsed); err != nil {
		t.Fatalf("parse sidecar: %v", err)
	}
	if parsed["index"] != "logs" {
		t.Fatalf("expected index field 'logs', got %v", parsed["index"])
	}
	if _, ok := parsed["settings"]; !ok {
		t.Fatalf("sidecar missing settings: %s", sidecarBytes)
	}
	if _, ok := parsed["mappings"]; !ok {
		t.Fatalf("sidecar missing mappings: %s", sidecarBytes)
	}
	if _, ok := parsed["aliases"]; !ok {
		t.Fatalf("sidecar missing aliases: %s", sidecarBytes)
	}
}

func TestExportSkipsMappingWhenDisabled(t *testing.T) {
	directory := t.TempDir()
	outputFile := filepath.Join(directory, "logs.jsonl")
	sidecarPath := outputFile + ".mapping.json"

	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/logs/_search":
			_, _ = writer.Write([]byte(`{"hits": {"hits": []}}`))
		case "/logs":
			t.Fatalf("GET /logs should not be called when exportMapping is false")
		default:
			http.Error(writer, "unexpected", http.StatusNotFound)
		}
	}))
	defer server.Close()

	err := runExport(exportOptions{
		url:           server.URL,
		index:         "logs",
		outputFile:    outputFile,
		batchSize:     10,
		strategy:      "scroll",
		exportMapping: false,
	})
	if err != nil {
		t.Fatalf("runExport: %v", err)
	}
	if _, err := os.Stat(sidecarPath); !os.IsNotExist(err) {
		t.Fatalf("expected no sidecar file, stat err = %v", err)
	}
}

func TestImportCreatesIndexFromSidecar(t *testing.T) {
	directory := t.TempDir()
	inputFile := filepath.Join(directory, "logs.jsonl")
	sidecarFile := filepath.Join(directory, "logs.mapping.json")
	if err := os.WriteFile(inputFile, []byte(`{"_id":"1","_source":{"level":"info"}}
`), 0o644); err != nil {
		t.Fatalf("write input: %v", err)
	}
	sidecar := `{"index":"logs","settings":{"number_of_shards":1},"mappings":{"properties":{"level":{"type":"keyword"}}}}`
	if err := os.WriteFile(sidecarFile, []byte(sidecar), 0o644); err != nil {
		t.Fatalf("write sidecar: %v", err)
	}

	var putBody []byte
	var putCalled bool
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch {
		case request.Method == http.MethodHead && request.URL.Path == "/logs":
			http.Error(writer, `{"error":"missing"}`, http.StatusNotFound)
		case request.Method == http.MethodPut && request.URL.Path == "/logs":
			putCalled = true
			putBody = make([]byte, request.ContentLength)
			_, _ = request.Body.Read(putBody)
			_, _ = writer.Write([]byte(`{"acknowledged": true}`))
		case request.URL.Path == "/_bulk":
			_, _ = writer.Write([]byte(`{"items":[{"index":{"status":201}}]}`))
		default:
			http.Error(writer, "unexpected: "+request.Method+" "+request.URL.Path, http.StatusNotFound)
		}
	}))
	defer server.Close()

	err := runImport(importOptions{
		url:         server.URL,
		index:       "logs",
		inputFile:   inputFile,
		batchSize:   10,
		onConflict:  "skip",
		createIndex: true,
		mappingFile: sidecarFile,
	})
	if err != nil {
		t.Fatalf("runImport: %v", err)
	}
	if !putCalled {
		t.Fatalf("expected PUT /logs to be called")
	}
	if !strings.Contains(string(putBody), `"number_of_shards"`) {
		t.Fatalf("PUT body missing settings: %s", putBody)
	}
	if !strings.Contains(string(putBody), `"keyword"`) {
		t.Fatalf("PUT body missing mapping: %s", putBody)
	}
	if strings.Contains(string(putBody), `"index"`) {
		t.Fatalf("PUT body should not contain wrapper 'index' field: %s", putBody)
	}
}

func TestImportSkipsCreateWhenIndexExists(t *testing.T) {
	directory := t.TempDir()
	inputFile := filepath.Join(directory, "logs.jsonl")
	if err := os.WriteFile(inputFile, []byte(`{"_id":"1","_source":{"level":"info"}}
`), 0o644); err != nil {
		t.Fatalf("write input: %v", err)
	}

	var putCalled bool
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch {
		case request.Method == http.MethodHead && request.URL.Path == "/logs":
			writer.WriteHeader(http.StatusOK)
		case request.Method == http.MethodPut && request.URL.Path == "/logs":
			putCalled = true
			http.Error(writer, "should not be called", http.StatusInternalServerError)
		case request.URL.Path == "/_bulk":
			_, _ = writer.Write([]byte(`{"items":[{"index":{"status":201}}]}`))
		default:
			http.Error(writer, "unexpected", http.StatusNotFound)
		}
	}))
	defer server.Close()

	err := runImport(importOptions{
		url:         server.URL,
		index:       "logs",
		inputFile:   inputFile,
		batchSize:   10,
		onConflict:  "skip",
		createIndex: true,
		mappingFile: filepath.Join(directory, "nonexistent.mapping.json"),
	})
	if err != nil {
		t.Fatalf("runImport: %v", err)
	}
	if putCalled {
		t.Fatalf("PUT should not be called when index already exists")
	}
}

func TestImportFailsWhenIndexMissingAndCreateIndexFalse(t *testing.T) {
	directory := t.TempDir()
	inputFile := filepath.Join(directory, "logs.jsonl")
	if err := os.WriteFile(inputFile, []byte(`{"_source":{"level":"info"}}
`), 0o644); err != nil {
		t.Fatalf("write input: %v", err)
	}

	var bulkCalled bool
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch {
		case request.Method == http.MethodHead && request.URL.Path == "/logs":
			http.Error(writer, `{"error":"missing"}`, http.StatusNotFound)
		case request.URL.Path == "/_bulk":
			bulkCalled = true
			_, _ = writer.Write([]byte(`{"items":[]}`))
		default:
			http.Error(writer, "unexpected", http.StatusNotFound)
		}
	}))
	defer server.Close()

	err := runImport(importOptions{
		url:         server.URL,
		index:       "logs",
		inputFile:   inputFile,
		batchSize:   10,
		onConflict:  "skip",
		createIndex: false,
	})
	if err == nil {
		t.Fatalf("expected error when createIndex is false and index is missing")
	}
	if !strings.Contains(err.Error(), "create-index") {
		t.Fatalf("expected create-index error, got %v", err)
	}
	if bulkCalled {
		t.Fatalf("bulk should not be called when index missing + createIndex=false")
	}
}

func TestImportUsesInlineMapping(t *testing.T) {
	directory := t.TempDir()
	inputFile := filepath.Join(directory, "logs.jsonl")
	if err := os.WriteFile(inputFile, []byte(`{"_source":{"level":"info"}}
`), 0o644); err != nil {
		t.Fatalf("write input: %v", err)
	}

	var putBody []byte
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch {
		case request.Method == http.MethodHead && request.URL.Path == "/logs":
			http.Error(writer, `{"error":"missing"}`, http.StatusNotFound)
		case request.Method == http.MethodPut && request.URL.Path == "/logs":
			putBody = make([]byte, request.ContentLength)
			_, _ = request.Body.Read(putBody)
			_, _ = writer.Write([]byte(`{"acknowledged": true}`))
		case request.URL.Path == "/_bulk":
			_, _ = writer.Write([]byte(`{"items":[{"index":{"status":201}}]}`))
		default:
			http.Error(writer, "unexpected", http.StatusNotFound)
		}
	}))
	defer server.Close()

	err := runImport(importOptions{
		url:           server.URL,
		index:         "logs",
		inputFile:     inputFile,
		batchSize:     10,
		onConflict:    "skip",
		createIndex:   true,
		inlineMapping: `{"mappings":{"properties":{"level":{"type":"keyword"}}}}`,
	})
	if err != nil {
		t.Fatalf("runImport: %v", err)
	}
	if !strings.Contains(string(putBody), `"keyword"`) {
		t.Fatalf("PUT body missing inline mapping: %s", putBody)
	}
}

func TestImportRejectsMalformedSidecar(t *testing.T) {
	directory := t.TempDir()
	inputFile := filepath.Join(directory, "logs.jsonl")
	sidecarFile := filepath.Join(directory, "logs.mapping.json")
	if err := os.WriteFile(inputFile, []byte(`{"_source":{"level":"info"}}
`), 0o644); err != nil {
		t.Fatalf("write input: %v", err)
	}
	if err := os.WriteFile(sidecarFile, []byte(`{not-json`), 0o644); err != nil {
		t.Fatalf("write sidecar: %v", err)
	}

	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch {
		case request.Method == http.MethodHead && request.URL.Path == "/logs":
			http.Error(writer, `{"error":"missing"}`, http.StatusNotFound)
		default:
			http.Error(writer, "unexpected", http.StatusNotFound)
		}
	}))
	defer server.Close()

	err := runImport(importOptions{
		url:         server.URL,
		index:       "logs",
		inputFile:   inputFile,
		batchSize:   10,
		onConflict:  "skip",
		createIndex: true,
		mappingFile: sidecarFile,
	})
	if err == nil {
		t.Fatalf("expected error for malformed sidecar")
	}
	if !strings.Contains(err.Error(), "mapping") {
		t.Fatalf("expected mapping error, got %v", err)
	}
}

func TestParseExportFlagsValidatesQuery(t *testing.T) {
	if _, err := parseExportFlags([]string{
		"--url", "http://localhost:9200",
		"--index", "logs",
		"--output", "/tmp/logs.jsonl",
		"--query", "{not json",
	}); err == nil {
		t.Fatalf("expected parseExportFlags to reject malformed --query")
	}
	if _, err := parseExportFlags([]string{
		"--url", "http://localhost:9200",
		"--index", "logs",
		"--output", "/tmp/logs.jsonl",
		"--query", `["array","not","object"]`,
	}); err == nil {
		t.Fatalf("expected parseExportFlags to reject non-object --query")
	}
	if _, err := parseExportFlags([]string{
		"--url", "http://localhost:9200",
		"--index", "logs",
		"--output", "/tmp/logs.jsonl",
		"--query", `{"match_all":{}}`,
	}); err != nil {
		t.Fatalf("expected valid query to pass, got %v", err)
	}
}

func TestParseImportFlagsValidatesMapping(t *testing.T) {
	if _, err := parseImportFlags([]string{
		"--url", "http://localhost:9200",
		"--index", "logs",
		"--input", "/tmp/logs.jsonl",
		"--mapping-file", "/tmp/m.json",
		"--inline-mapping", `{"mappings":{}}`,
	}); err == nil {
		t.Fatalf("expected parseImportFlags to reject mapping-file + inline-mapping combination")
	}
	if _, err := parseImportFlags([]string{
		"--url", "http://localhost:9200",
		"--index", "logs",
		"--input", "/tmp/logs.jsonl",
		"--inline-mapping", "{bad",
	}); err == nil {
		t.Fatalf("expected parseImportFlags to reject malformed inline-mapping")
	}
}
