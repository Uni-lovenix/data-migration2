package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"strings"
)

// Task represents a single migration sub-task.
type Task struct {
	ID     string `json:"id"`
	Engine string `json:"engine"` // "esmigrator" or "pgmigrator"
	Action string `json:"action"` // "export" or "import"

	// esmigrator flags
	URL         string `json:"url,omitempty"`
	Username    string `json:"username,omitempty"`
	Password    string `json:"password,omitempty"`
	InsecureTLS bool   `json:"insecureTLS,omitempty"`
	Index       string `json:"index,omitempty"`

	// esmigrator direct mode
	SrcURL         string `json:"srcURL,omitempty"`
	SrcUsername    string `json:"srcUsername,omitempty"`
	SrcPassword    string `json:"srcPassword,omitempty"`
	SrcInsecureTLS bool   `json:"srcInsecureTLS,omitempty"`
	SrcIndex       string `json:"srcIndex,omitempty"`
	DstURL         string `json:"dstURL,omitempty"`
	DstUsername    string `json:"dstUsername,omitempty"`
	DstPassword    string `json:"dstPassword,omitempty"`
	DstInsecureTLS bool   `json:"dstInsecureTLS,omitempty"`
	DstIndex       string `json:"dstIndex,omitempty"`

	// pgmigrator flags
	DSN   string `json:"dsn,omitempty"`
	Table string `json:"table,omitempty"`

	// pgmigrator direct mode
	SrcDSN   string `json:"srcDSN,omitempty"`
	SrcTable string `json:"srcTable,omitempty"`
	DstDSN   string `json:"dstDSN,omitempty"`
	DstTable string `json:"dstTable,omitempty"`

	// common
	InputFile   string `json:"inputFile,omitempty"`
	OutputFile  string `json:"outputFile,omitempty"`
	BatchSize   int    `json:"batchSize,omitempty"`
	OnConflict  string `json:"onConflict,omitempty"`
	Strategy    string `json:"strategy,omitempty"`
	ResumeRows  int64  `json:"resumeRows,omitempty"`
	ResumeLines int64  `json:"resumeLines,omitempty"`
	SearchAfter []any  `json:"searchAfter,omitempty"`

	// set by dispatcher
	ProgressFile string `json:"progressFile"`
	CancelFile   string `json:"cancelFile"`
	Direct       bool   `json:"direct,omitempty"`
}

// TaskResult records the outcome of a sub-task.
type TaskResult struct {
	TaskID     string `json:"taskId"`
	Engine     string `json:"engine"`
	Action     string `json:"action"`
	Status     string `json:"status"` // "success", "failed", "canceled"
	Rows       int64  `json:"rows"`
	DurationMs int64  `json:"durationMs"`
	Error      string `json:"error,omitempty"`
}

// ParseTasks reads a JSONL file and returns the list of tasks.
func ParseTasks(path string) ([]Task, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read tasks file: %w", err)
	}
	var tasks []Task
	lines := bytes.Split(data, []byte{'\n'})
	for i, line := range lines {
		if len(bytes.TrimSpace(line)) == 0 {
			continue
		}
		var t Task
		if err := json.Unmarshal(line, &t); err != nil {
			return nil, fmt.Errorf("task %d: parse: %w", i+1, err)
		}
		if t.Engine == "" || t.Action == "" {
			return nil, fmt.Errorf("task %d: engine and action are required", i+1)
		}
		if t.Engine != "esmigrator" && t.Engine != "pgmigrator" {
			return nil, fmt.Errorf("task %d: engine must be esmigrator or pgmigrator", i+1)
		}
		if t.Action != "export" && t.Action != "import" && t.Action != "direct" {
			return nil, fmt.Errorf("task %d: action must be export, import, or direct", i+1)
		}
		tasks = append(tasks, t)
	}
	return tasks, nil
}

func trimSpace(b []byte) []byte {
	return bytes.TrimSpace(b)
}

func splitLines(b []byte) [][]byte {
	return bytes.Split(b, []byte{'\n'})
}

// EscapeJSONString is used by buildArgs for JSON encoding.
func EscapeJSONString(s string) string {
	b, _ := json.Marshal(s)
	s = string(b)
	return strings.TrimPrefix(strings.TrimSuffix(s, "\""), "\"")
}
