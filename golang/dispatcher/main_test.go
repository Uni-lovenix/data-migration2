package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// ------------------------------------------------------------------
// ParseTasks tests
// ------------------------------------------------------------------

func TestParseTasks(t *testing.T) {
	// Valid two-task file
	content := strings.Join([]string{
		`{"id":"t1","engine":"esmigrator","action":"export","url":"http://es:9200","index":"idx1","output":"/tmp/out1.jsonl"}`,
		`{"id":"t2","engine":"pgmigrator","action":"import","dsn":"postgres://u:p@h:5432/db","table":"public.t","input":"/tmp/in.jsonl"}`,
		``, // trailing newline is fine
	}, "\n")

	tmp := writeTempFile(t, content)
	defer os.Remove(tmp)

	tasks, err := ParseTasks(tmp)
	if err != nil {
		t.Fatalf("ParseTasks: %v", err)
	}
	if len(tasks) != 2 {
		t.Fatalf("expected 2 tasks, got %d", len(tasks))
	}
	if tasks[0].Engine != "esmigrator" || tasks[0].Action != "export" {
		t.Errorf("task 0: engine=%s action=%s", tasks[0].Engine, tasks[0].Action)
	}
	if tasks[1].Engine != "pgmigrator" || tasks[1].Action != "import" {
		t.Errorf("task 1: engine=%s action=%s", tasks[1].Engine, tasks[1].Action)
	}
}

func TestParseTasksMissingEngine(t *testing.T) {
	tmp := writeTempFile(t, `{"id":"t1","action":"export"}`)
	defer os.Remove(tmp)
	_, err := ParseTasks(tmp)
	if err == nil {
		t.Fatal("expected error for missing engine")
	}
}

func TestParseTasksUnknownEngine(t *testing.T) {
	tmp := writeTempFile(t, `{"id":"t1","engine":"unknown","action":"export"}`)
	defer os.Remove(tmp)
	_, err := ParseTasks(tmp)
	if err == nil {
		t.Fatal("expected error for unknown engine")
	}
}

func TestParseTasksUnknownAction(t *testing.T) {
	tmp := writeTempFile(t, `{"id":"t1","engine":"esmigrator","action":"unknown"}`)
	defer os.Remove(tmp)
	_, err := ParseTasks(tmp)
	if err == nil {
		t.Fatal("expected error for unknown action")
	}
}

func TestParseTasksEmptyFile(t *testing.T) {
	tmp := writeTempFile(t, "")
	defer os.Remove(tmp)
	tasks, err := ParseTasks(tmp)
	if err != nil {
		t.Fatalf("ParseTasks empty file: %v", err)
	}
	if len(tasks) != 0 {
		t.Fatalf("expected 0 tasks, got %d", len(tasks))
	}
}

// ------------------------------------------------------------------
// Progress aggregation tests
// ------------------------------------------------------------------

func TestAggregateProgressAddResult(t *testing.T) {
	p := &AggregateProgress{TotalTasks: 3}
	p.addResult(TaskResult{TaskID: "a", Status: "success"})
	p.addResult(TaskResult{TaskID: "b", Status: "failed"})
	p.addResult(TaskResult{TaskID: "c", Status: "canceled"})
	if p.Completed != 1 || p.Failed != 1 || p.Canceled != 1 {
		t.Errorf("counts: completed=%d failed=%d canceled=%d", p.Completed, p.Failed, p.Canceled)
	}
	if p.TotalTasks != 3 {
		t.Errorf("TotalTasks should stay 3, got %d", p.TotalTasks)
	}
}

func TestWriteReadAggregateProgress(t *testing.T) {
	origClock := clock
	defer func() { clock = origClock }()
	clock = func() time.Time { return time.Time{} }

	p := &AggregateProgress{
		TotalTasks: 2,
		Completed:  1,
		Failed:     1,
		TotalRows:  100,
		Tasks: []TaskResult{
			{TaskID: "t1", Status: "success", Rows: 50},
			{TaskID: "t2", Status: "failed", Error: "boom"},
		},
	}

	tmp := filepath.Join(t.TempDir(), "progress.json")
	if err := writeAggregateProgress(tmp, p); err != nil {
		t.Fatalf("writeAggregateProgress: %v", err)
	}

	data, err := os.ReadFile(tmp)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}

	var got AggregateProgress
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got.TotalTasks != 2 || got.Completed != 1 || got.Failed != 1 {
		t.Errorf("unexpected: %+v", got)
	}
}

// ------------------------------------------------------------------
// File helper tests
// ------------------------------------------------------------------

func TestTouchRemoveFile(t *testing.T) {
	tmp := filepath.Join(t.TempDir(), "marker.txt")
	if err := touchFile(tmp); err != nil {
		t.Fatalf("touchFile: %v", err)
	}
	if _, err := os.Stat(tmp); err != nil {
		t.Errorf("file should exist after touch: %v", err)
	}
	if err := removeFile(tmp); err != nil {
		t.Fatalf("removeFile: %v", err)
	}
	if _, err := os.Stat(tmp); !os.IsNotExist(err) {
		t.Errorf("file should be gone after remove")
	}
	// removeFile on non-existent is not an error
	if err := removeFile(tmp); err != nil {
		t.Errorf("removeFile on non-existent should not error: %v", err)
	}
}

// ------------------------------------------------------------------
// buildArgs tests
// ------------------------------------------------------------------

func TestBuildArgsESExport(t *testing.T) {
	cancelFile := "/tmp/cancel.txt"
	task := Task{
		Engine:     "esmigrator",
		Action:     "export",
		URL:        "http://es:9200",
		Index:      "myindex",
		OutputFile: "/data/out.jsonl",
		BatchSize:  500,
		Strategy:   "scroll",
	}
	args := buildArgs(task, cancelFile)
	if args[0] != "export" {
		t.Errorf("first arg should be 'export', got %s", args[0])
	}
	// check key flags are present
	joined := strings.Join(args, " ")
	for _, want := range []string{"--url", "http://es:9200", "--index", "myindex", "--output", "/data/out.jsonl", "--batch-size", "500", "--strategy", "scroll", "--cancel-file", cancelFile} {
		if !strings.Contains(joined, want) {
			t.Errorf("buildArgs missing: %s\nargs: %v", want, args)
		}
	}
}

func TestBuildArgsPGImport(t *testing.T) {
	cancelFile := "/tmp/cancel.txt"
	task := Task{
		Engine:     "pgmigrator",
		Action:     "import",
		DSN:        "postgres://u:p@h:5432/db",
		Table:      "public.mytable",
		InputFile:  "/data/in.jsonl",
		BatchSize:  1000,
		OnConflict: "skip",
	}
	args := buildArgs(task, cancelFile)
	if args[0] != "import" {
		t.Errorf("first arg should be 'import', got %s", args[0])
	}
	joined := strings.Join(args, " ")
	for _, want := range []string{"--dsn", "postgres://u:p@h:5432/db", "--table", "public.mytable", "--input", "/data/in.jsonl", "--batch-size", "1000", "--on-conflict", "skip", "--cancel-file", cancelFile} {
		if !strings.Contains(joined, want) {
			t.Errorf("buildArgs missing: %s\nargs: %v", want, args)
		}
	}
}

func TestBuildArgsProgressFile(t *testing.T) {
	cancelFile := "/tmp/cancel.txt"
	task := Task{
		Engine:       "pgmigrator",
		Action:       "export",
		DSN:          "postgres://u:p@h:5432/db",
		Table:        "t",
		OutputFile:   "/out.jsonl",
		ProgressFile: "/tmp/task-progress.json",
	}
	args := buildArgs(task, cancelFile)
	joined := strings.Join(args, " ")
	if !strings.Contains(joined, "--progress-file") {
		t.Errorf("missing --progress-file in %v", args)
	}
}

// ------------------------------------------------------------------
// parseDispatchFlags tests
// ------------------------------------------------------------------

func TestParseDispatchFlags(t *testing.T) {
	args := []string{
		"--tasks", "/tmp/tasks.jsonl",
		"--parallel", "4",
		"--progress-file", "/tmp/progress.json",
		"--cancel-file", "/tmp/cancel.txt",
		"--resume",
	}
	opts, err := parseDispatchFlags(args)
	if err != nil {
		t.Fatalf("parseDispatchFlags: %v", err)
	}
	if opts.tasksFile != "/tmp/tasks.jsonl" {
		t.Errorf("tasksFile: got %s", opts.tasksFile)
	}
	if opts.parallel != 4 {
		t.Errorf("parallel: got %d", opts.parallel)
	}
	if opts.progressFile != "/tmp/progress.json" {
		t.Errorf("progressFile: got %s", opts.progressFile)
	}
	if !opts.resume {
		t.Errorf("resume should be true")
	}
}

func TestParseDispatchFlagsMissingTasks(t *testing.T) {
	_, err := parseDispatchFlags([]string{})
	if err == nil {
		t.Error("expected error for missing --tasks")
	}
}

func TestParseDispatchFlagsParallelZero(t *testing.T) {
	_, err := parseDispatchFlags([]string{"--tasks", "/tmp/t.jsonl", "--parallel", "0"})
	if err == nil {
		t.Error("expected error for parallel=0")
	}
}

// ------------------------------------------------------------------
// findBinary tests
// ------------------------------------------------------------------

func TestFindBinarySelf(t *testing.T) {
	// The dispatcher binary itself should be found.
	exe, err := os.Executable()
	if err != nil {
		t.Skip("cannot find executable")
	}
	name := filepath.Base(exe)
	path, err := findBinary(name)
	if err != nil {
		t.Errorf("findBinary(%s): %v", name, err)
	}
	if path != exe {
		t.Logf("found at different path: %s vs %s", path, exe)
	}
}

func TestFindBinaryNotFound(t *testing.T) {
	_, err := findBinary("this-binary-does-not-exist-xyz")
	if err == nil {
		t.Error("expected error for non-existent binary")
	}
}

// ------------------------------------------------------------------
// Serial vs parallel dispatch (functional)
// ------------------------------------------------------------------

func TestRunDispatchSerial(t *testing.T) {
	// Set up a real-ish tasks file and run dispatch with parallel=1.
	// We use esmigrator version as a stand-in for a quick exec.
	tmpDir := t.TempDir()
	cancelFile := filepath.Join(tmpDir, "cancel.txt")
	progressFile := filepath.Join(tmpDir, "progress.json")
	tasksFile := filepath.Join(tmpDir, "tasks.jsonl")

	// Use 'export' action so ParseTasks validation passes (engine binary not found → fast failed result).
	taskLine, _ := json.Marshal(Task{
		ID:           "v1",
		Engine:       "esmigrator",
		Action:       "export",
		ProgressFile: filepath.Join(tmpDir, "sub1.json"),
		CancelFile:   cancelFile,
	})
	taskLine2, _ := json.Marshal(Task{
		ID:           "v2",
		Engine:       "pgmigrator",
		Action:       "export",
		ProgressFile: filepath.Join(tmpDir, "sub2.json"),
		CancelFile:   cancelFile,
	})
	if err := os.WriteFile(tasksFile, append(append(taskLine, '\n'), taskLine2...), 0o644); err != nil {
		t.Fatalf("write tasks file: %v", err)
	}

	cfg := dispatchConfig{
		parallel:     1,
		progressFile: progressFile,
		cancelFile:   cancelFile,
	}
	tasks, err := ParseTasks(tasksFile)
	if err != nil {
		t.Fatalf("ParseTasks: %v", err)
	}

	err = runDispatch(tasks, cfg)
	// Tasks fail because esmigrator/pgmigrator binaries are not in PATH,
	// but dispatch itself completes and writes progress.
	data, err := os.ReadFile(progressFile)
	if err != nil {
		t.Fatalf("read progress: %v", err)
	}
	var prog AggregateProgress
	if err := json.Unmarshal(data, &prog); err != nil {
		t.Fatalf("unmarshal progress: %v", err)
	}
	if prog.TotalTasks != 2 {
		t.Errorf("TotalTasks=2, got %d", prog.TotalTasks)
	}
	if prog.Failed != 2 {
		t.Errorf("Failed=2 (binaries not found), got %d", prog.Failed)
	}
}

func TestRunDispatchParallel(t *testing.T) {
	tmpDir := t.TempDir()
	cancelFile := filepath.Join(tmpDir, "cancel.txt")
	progressFile := filepath.Join(tmpDir, "progress.json")
	tasksFile := filepath.Join(tmpDir, "tasks.jsonl")

	// Use 'export' action so ParseTasks validation passes (engine binary not found → fast failed result).
	var tasksJSON bytes.Buffer
	for i := 0; i < 4; i++ {
		eng := "esmigrator"
		if i%2 == 1 {
			eng = "pgmigrator"
		}
		taskLine, _ := json.Marshal(Task{
			ID:           fmt.Sprintf("v%d", i+1),
			Engine:       eng,
			Action:       "export",
			ProgressFile: filepath.Join(tmpDir, fmt.Sprintf("sub%d.json", i+1)),
			CancelFile:   cancelFile,
		})
		tasksJSON.Write(taskLine)
		tasksJSON.WriteByte('\n')
	}
	if err := os.WriteFile(tasksFile, tasksJSON.Bytes(), 0o644); err != nil {
		t.Fatalf("write tasks file: %v", err)
	}

	tasks, err := ParseTasks(tasksFile)
	if err != nil {
		t.Fatalf("ParseTasks: %v", err)
	}

	cfg := dispatchConfig{
		parallel:     4,
		progressFile: progressFile,
		cancelFile:   cancelFile,
	}

	err = runDispatch(tasks, cfg)
	// Expect error because binaries are not found (Failed=4), but progress file should still be written.
	if err == nil {
		t.Errorf("runDispatch parallel: expected error due to missing binaries, got nil")
	}

	data, err := os.ReadFile(progressFile)
	if err != nil {
		t.Fatalf("read progress: %v", err)
	}
	var prog AggregateProgress
	if err := json.Unmarshal(data, &prog); err != nil {
		t.Fatalf("unmarshal progress: %v", err)
	}
	if prog.TotalTasks != 4 {
		t.Errorf("TotalTasks=4, got %d", prog.TotalTasks)
	}
	if prog.Failed != 4 {
		t.Errorf("Failed=4 (binaries not found), got %d", prog.Failed)
	}
}

// ------------------------------------------------------------------
// Helper
// ------------------------------------------------------------------

func writeTempFile(t *testing.T, content string) string {
	t.Helper()
	tmp := filepath.Join(t.TempDir(), "tasks.jsonl")
	if err := os.WriteFile(tmp, []byte(content), 0o644); err != nil {
		t.Fatalf("write temp file: %v", err)
	}
	return tmp
}

var _ = io.Discard // silence
var _ = sync.Mutex{} // silence
var _ = flag.NewFlagSet // silence
