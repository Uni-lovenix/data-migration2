package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

// mockPGServer creates an in-memory PostgreSQL-like server using pgx mock
// For unit tests, we mock at the pool level.

func TestExportHonorsCancelFile(t *testing.T) {
	directory := t.TempDir()
	cancelFile := filepath.Join(directory, "cancel")
	if err := os.WriteFile(cancelFile, []byte("cancel"), 0o644); err != nil {
		t.Fatalf("write cancel marker: %v", err)
	}

	// A dummy server that won't be reached because cancel is checked first
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		t.Fatal("request should not be made when cancel file exists")
	}))
	defer server.Close()

	err := runExport(exportOptions{
		dsn:        server.URL + "/db",
		table:      "public.users",
		outputFile: filepath.Join(directory, "out.jsonl"),
		batchSize:  100,
		cancelFile: cancelFile,
	})
	if !errors.Is(err, errCanceled) {
		t.Fatalf("expected errCanceled, got %v", err)
	}
}

func TestImportHonorsCancelFile(t *testing.T) {
	directory := t.TempDir()
	cancelFile := filepath.Join(directory, "cancel")
	if err := os.WriteFile(cancelFile, []byte("cancel"), 0o644); err != nil {
		t.Fatalf("write cancel marker: %v", err)
	}

	inputFile := filepath.Join(directory, "in.jsonl")
	// Valid JSONL record
	record := importRecord{Table: "public.users", Columns: []string{"id", "name"}, Values: []any{int64(1), "alice"}}
	data, _ := json.Marshal(record)
	if err := os.WriteFile(inputFile, data, 0o644); err != nil {
		t.Fatalf("write input: %v", err)
	}

	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		t.Fatal("request should not be made when cancel file exists")
	}))
	defer server.Close()

	err := runImport(importOptions{
		dsn:        server.URL + "/db",
		table:      "public.users",
		inputFile:  inputFile,
		batchSize:  100,
		cancelFile: cancelFile,
	})
	if !errors.Is(err, errCanceled) {
		t.Fatalf("expected errCanceled, got %v", err)
	}
}

func TestProgressWriteAndRead(t *testing.T) {
	directory := t.TempDir()
	progressFile := filepath.Join(directory, "progress.json")

	err := writeProgress(progressFile, "export", 100, 0, 0)
	if err != nil {
		t.Fatalf("writeProgress: %v", err)
	}

	data, err := os.ReadFile(progressFile)
	if err != nil {
		t.Fatalf("read progress: %v", err)
	}

	var p progress
	if err := json.Unmarshal(data, &p); err != nil {
		t.Fatalf("parse progress: %v", err)
	}
	if p.Rows != 100 {
		t.Fatalf("expected rows 100, got %d", p.Rows)
	}
	if p.Stage != "export" {
		t.Fatalf("expected stage export, got %s", p.Stage)
	}
	if p.UpdatedAt == "" {
		t.Fatal("expected UpdatedAt to be set")
	}
}

func TestCheckCancel(t *testing.T) {
	directory := t.TempDir()
	cancelFile := filepath.Join(directory, "cancel")

	// No cancel file -> no error
	err := checkCancel(cancelFile)
	if err != nil {
		t.Fatalf("expected no error without cancel file, got %v", err)
	}

	// Cancel file exists -> errCanceled
	if err := os.WriteFile(cancelFile, []byte("x"), 0o644); err != nil {
		t.Fatalf("write cancel: %v", err)
	}
	err = checkCancel(cancelFile)
	if !errors.Is(err, errCanceled) {
		t.Fatalf("expected errCanceled, got %v", err)
	}
}

func TestParseExportFlags(t *testing.T) {
	opts, err := parseExportFlags([]string{
		"--dsn", "postgres://localhost/db",
		"--table", "public.users",
		"--output", "/tmp/out.jsonl",
		"--batch-size", "500",
		"--resume-rows", "10",
	})
	if err != nil {
		t.Fatalf("parseExportFlags: %v", err)
	}
	if opts.dsn != "postgres://localhost/db" {
		t.Fatalf("expected dsn, got %s", opts.dsn)
	}
	if opts.table != "public.users" {
		t.Fatalf("expected table, got %s", opts.table)
	}
	if opts.outputFile != "/tmp/out.jsonl" {
		t.Fatalf("expected output, got %s", opts.outputFile)
	}
	if opts.batchSize != 500 {
		t.Fatalf("expected batchSize 500, got %d", opts.batchSize)
	}
	if opts.resumeRows != 10 {
		t.Fatalf("expected resumeRows 10, got %d", opts.resumeRows)
	}
}

func TestParseImportFlags(t *testing.T) {
	opts, err := parseImportFlags([]string{
		"--dsn", "postgres://localhost/db",
		"--table", "public.users",
		"--input", "/tmp/in.jsonl",
		"--batch-size", "200",
		"--on-conflict", "skip",
		"--resume-lines", "5",
	})
	if err != nil {
		t.Fatalf("parseImportFlags: %v", err)
	}
	if opts.dsn != "postgres://localhost/db" {
		t.Fatalf("expected dsn, got %s", opts.dsn)
	}
	if opts.table != "public.users" {
		t.Fatalf("expected table, got %s", opts.table)
	}
	if opts.inputFile != "/tmp/in.jsonl" {
		t.Fatalf("expected input, got %s", opts.inputFile)
	}
	if opts.batchSize != 200 {
		t.Fatalf("expected batchSize 200, got %d", opts.batchSize)
	}
	if opts.onConflict != "skip" {
		t.Fatalf("expected onConflict skip, got %s", opts.onConflict)
	}
	if opts.resumeLines != 5 {
		t.Fatalf("expected resumeLines 5, got %d", opts.resumeLines)
	}
}

func TestParseImportRow(t *testing.T) {
	line := `{"table":"public.users","columns":["id","name"],"values":[1,"alice"]}`
	vals, err := parseImportRow(line, 1)
	if err != nil {
		t.Fatalf("parseImportRow: %v", err)
	}
	if len(vals) != 2 {
		t.Fatalf("expected 2 values, got %d", len(vals))
	}
}

func TestParseImportRowInvalid(t *testing.T) {
	_, err := parseImportRow("not json", 1)
	if err == nil {
		t.Fatal("expected error for invalid JSON")
	}
}

func TestEscapeString(t *testing.T) {
	tests := []struct {
		input    string
		expected string
	}{
		{"alice", "alice"},
		{"alice's", "alice''s"},
		{"line\nbreak", "line\\nbreak"},
		{"with\ttab", "with\\ttab"},
		{"back\\slash", "back\\\\slash"},
		{"null\x00byte", "nullbyte"},
	}
	for _, tc := range tests {
		got := escapeString(tc.input)
		if got != tc.expected {
			t.Errorf("escapeString(%q): got %q, want %q", tc.input, got, tc.expected)
		}
	}
}

// Integration test against Docker PostgreSQL
func TestIntegrationExportImport(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}
	dsn := os.Getenv("POSTGRES_INTEGRATION_DSN")
	if dsn == "" {
		t.Skip("POSTGRES_INTEGRATION_DSN not set")
	}

	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer pool.Close()

	// Setup: create table
	_, _ = pool.Exec(ctx, "DROP TABLE IF EXISTS pgmigrator_src")
	_, _ = pool.Exec(ctx, "DROP TABLE IF EXISTS pgmigrator_dst")
	_, err = pool.Exec(ctx, "CREATE TABLE pgmigrator_src (id SERIAL PRIMARY KEY, name TEXT)")
	if err != nil {
		t.Fatalf("create src: %v", err)
	}
	_, err = pool.Exec(ctx, "CREATE TABLE pgmigrator_dst (id SERIAL PRIMARY KEY, name TEXT)")
	if err != nil {
		t.Fatalf("create dst: %v", err)
	}

	// Insert 100 rows
	for i := 0; i < 100; i++ {
		_, err = pool.Exec(ctx, "INSERT INTO pgmigrator_src (name) VALUES ($1)", "user-"+string(rune('a'+i%26))+string(rune('0'+i/26)))
		if err != nil {
			t.Fatalf("insert: %v", err)
		}
	}

	directory := t.TempDir()
	outputFile := filepath.Join(directory, "export.jsonl")
	progressFile := filepath.Join(directory, "progress.json")

	err = runExport(exportOptions{
		dsn:          dsn,
		table:        "public.pgmigrator_src",
		outputFile:   outputFile,
		batchSize:    50,
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
	if len(lines) != 100 {
		t.Fatalf("expected 100 lines, got %d", len(lines))
	}

	// Import
	inputFile := outputFile
	err = runImport(importOptions{
		dsn:          dsn,
		table:        "public.pgmigrator_dst",
		inputFile:    inputFile,
		batchSize:    50,
		onConflict:   "skip",
		progressFile: progressFile,
	})
	if err != nil {
		t.Fatalf("runImport: %v", err)
	}

	// Verify count
	var count int
	if err := pool.QueryRow(ctx, "SELECT COUNT(*) FROM pgmigrator_dst").Scan(&count); err != nil {
		t.Fatalf("count dst: %v", err)
	}
	if count != 100 {
		t.Fatalf("expected 100 rows in dst, got %d", count)
	}

	// Verify data matches
	var srcNames, dstNames []string
	rows, _ := pool.Query(ctx, "SELECT name FROM pgmigrator_src ORDER BY id")
	for rows.Next() {
		var n string
		rows.Scan(&n)
		srcNames = append(srcNames, n)
	}
	rows.Close()
	rows, _ = pool.Query(ctx, "SELECT name FROM pgmigrator_dst ORDER BY id")
	for rows.Next() {
		var n string
		rows.Scan(&n)
		dstNames = append(dstNames, n)
	}
	rows.Close()
	if len(srcNames) != len(dstNames) {
		t.Fatalf("row count mismatch: src=%d dst=%d", len(srcNames), len(dstNames))
	}
	for i := range srcNames {
		if srcNames[i] != dstNames[i] {
			t.Errorf("row %d mismatch: src=%q dst=%q", i, srcNames[i], dstNames[i])
		}
	}

	// Cleanup
	_, _ = pool.Exec(ctx, "DROP TABLE pgmigrator_src")
	_, _ = pool.Exec(ctx, "DROP TABLE pgmigrator_dst")
}

// pgx/mock doesn't exist; we use a real pgx pool for integration tests.
// For unit tests without a real DB, the mock server above is sufficient.

func TestContains(t *testing.T) {
	if !contains([]string{"a", "b", "c"}, "b") {
		t.Error("expected contains to find 'b'")
	}
	if contains([]string{"a", "b", "c"}, "d") {
		t.Error("expected contains to not find 'd'")
	}
}

func contains(values []string, target string) bool {
	for _, v := range values {
		if v == target {
			return true
		}
	}
	return false
}
