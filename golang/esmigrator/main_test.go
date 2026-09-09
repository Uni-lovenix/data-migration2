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
		if request.URL.Path != "/_bulk" {
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
