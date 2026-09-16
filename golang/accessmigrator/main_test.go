package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type fakeRunner struct {
	output      []byte
	stream      string
	outputCalls []string
	streamCalls []string
	err         error
}

func (runner *fakeRunner) Output(_ context.Context, name string, args ...string) ([]byte, error) {
	runner.outputCalls = append(runner.outputCalls, strings.Join(append([]string{name}, args...), " "))
	if runner.err != nil {
		return nil, runner.err
	}
	return runner.output, nil
}

func (runner *fakeRunner) Stream(_ context.Context, name string, args ...string) (io.ReadCloser, error) {
	runner.streamCalls = append(runner.streamCalls, strings.Join(append([]string{name}, args...), " "))
	if runner.err != nil {
		return nil, runner.err
	}
	return io.NopCloser(strings.NewReader(runner.stream)), nil
}

func TestListTables(t *testing.T) {
	runner := &fakeRunner{output: []byte("Users\r\nOrders\n\n")}
	tables, err := listTables(
		context.Background(),
		runner,
		"mdb-tables",
		"/tmp/source.mdb",
		"secret",
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(tables) != 2 || tables[0] != "Users" || tables[1] != "Orders" {
		t.Fatalf("unexpected tables: %#v", tables)
	}
	if got := runner.outputCalls[0]; got != "mdb-tables -1 -p secret /tmp/source.mdb" {
		t.Fatalf("unexpected command: %s", got)
	}
}

func TestExportTableWritesBatchesAndProgress(t *testing.T) {
	directory := t.TempDir()
	output := filepath.Join(directory, "users.jsonl")
	progress := filepath.Join(directory, "progress.json")
	runner := &fakeRunner{stream: "id,name\n1,Alice\n2,Bob\n3,Carol\n"}

	rows, err := exportTable(context.Background(), runner, exportOptions{
		File:         "/tmp/source.mdb",
		Table:        "Users",
		Output:       output,
		BatchSize:    2,
		ProgressFile: progress,
		ExportBinary: "mdb-export",
	})
	if err != nil {
		t.Fatal(err)
	}
	if rows != 3 {
		t.Fatalf("rows = %d, want 3", rows)
	}
	content, err := os.ReadFile(output)
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(string(content)), "\n")
	if len(lines) != 2 {
		t.Fatalf("lines = %d, want 2", len(lines))
	}
	var first exportEnvelope
	if err := json.Unmarshal([]byte(lines[0]), &first); err != nil {
		t.Fatal(err)
	}
	if first.Table.Name != "Users" || len(first.Rows) != 2 {
		t.Fatalf("unexpected first envelope: %#v", first)
	}
	if first.Rows[0][0] != "1" || first.Rows[0][1] != "Alice" {
		t.Fatalf("unexpected first row: %#v", first.Rows[0])
	}
	progressData, err := os.ReadFile(progress)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(progressData), `"rows":3`) {
		t.Fatalf("unexpected progress: %s", progressData)
	}
}

func TestExportTableResumesBySkippingRows(t *testing.T) {
	directory := t.TempDir()
	output := filepath.Join(directory, "users.jsonl")
	part := output + ".part"
	firstBatch, _ := json.Marshal(exportEnvelope{
		Table:   tableRef{Schema: "access", Name: "Users"},
		Columns: []string{"id", "name"},
		Rows: [][]any{
			{"1", "Alice"},
			{"2", "Bob"},
		},
	})
	if err := os.WriteFile(part, append(firstBatch, '\n'), 0o644); err != nil {
		t.Fatal(err)
	}
	runner := &fakeRunner{stream: "id,name\n1,Alice\n2,Bob\n3,Carol\n"}

	rows, err := exportTable(context.Background(), runner, exportOptions{
		File:         "/tmp/source.mdb",
		Table:        "Users",
		Output:       output,
		BatchSize:    500,
		ResumeRows:   2,
		ExportBinary: "mdb-export",
	})
	if err != nil {
		t.Fatal(err)
	}
	if rows != 3 {
		t.Fatalf("rows = %d, want 3", rows)
	}
	content, err := os.ReadFile(output)
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(string(content)), "\n")
	if len(lines) != 2 {
		t.Fatalf("lines = %d, want 2", len(lines))
	}
	if !strings.Contains(lines[1], `"3"`) || strings.Contains(lines[1], `"Alice"`) {
		t.Fatalf("resume appended wrong rows: %s", lines[1])
	}
}

func TestExportTableHonorsCancelMarker(t *testing.T) {
	directory := t.TempDir()
	cancel := filepath.Join(directory, "cancel")
	if err := os.WriteFile(cancel, []byte("cancel"), 0o644); err != nil {
		t.Fatal(err)
	}
	runner := &fakeRunner{stream: "id\n1\n"}

	_, err := exportTable(context.Background(), runner, exportOptions{
		File:         "/tmp/source.mdb",
		Table:        "Users",
		Output:       filepath.Join(directory, "users.jsonl"),
		BatchSize:    1,
		CancelFile:   cancel,
		ExportBinary: "mdb-export",
	})
	if !errors.Is(err, errCanceled) {
		t.Fatalf("err = %v, want errCanceled", err)
	}
	if len(runner.streamCalls) != 0 {
		t.Fatalf("runner should not start after cancellation")
	}
}
