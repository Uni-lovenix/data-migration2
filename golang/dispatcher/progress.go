package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// AggregateProgress is the top-level progress written to the main progress file.
type AggregateProgress struct {
	TotalTasks int          `json:"totalTasks"`
	Completed  int          `json:"completed"`
	Failed     int          `json:"failed"`
	Canceled   int          `json:"canceled"`
	TotalRows  int64        `json:"totalRows"`
	DurationMs int64        `json:"durationMs"`
	Tasks      []TaskResult `json:"tasks"`
}

func (p *AggregateProgress) addResult(r TaskResult) {
	switch r.Status {
	case "success":
		p.Completed++
	case "failed":
		p.Failed++
	case "canceled":
		p.Canceled++
	}
	p.TotalRows += r.Rows
	p.DurationMs += r.DurationMs
	p.Tasks = append(p.Tasks, r)
}

// subProgress is the minimal shape shared by esmigrator and pgmigrator progress files.
type subProgress struct {
	Rows      int64  `json:"rows"`
	Lines     int64  `json:"lines,omitempty"`
	Skipped   int64  `json:"skipped,omitempty"`
	UpdatedAt string `json:"updatedAt"`
}

var readProgressMu sync.Mutex

// readSubProgress reads a sub-task progress file and returns rows processed.
// It handles both esmigrator (rows) and pgmigrator (rows) formats.
func readSubProgress(path string) (int64, error) {
	if path == "" {
		return 0, nil
	}
	readProgressMu.Lock()
	defer readProgressMu.Unlock()
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return 0, nil
		}
		return 0, err
	}
	var sp subProgress
	if err := json.Unmarshal(data, &sp); err != nil {
		return 0, err
	}
	return sp.Rows, nil
}

// writeAggregateProgress writes the aggregate progress file atomically.
func writeAggregateProgress(path string, p *AggregateProgress) error {
	if path == "" {
		return nil
	}
	data, err := json.Marshal(p)
	if err != nil {
		return err
	}
	// Ensure parent directory exists
	dir := filepath.Dir(path)
	if dir != "" && dir != "." {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		_ = os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		return err
	}
	return nil
}

// touchFile creates an empty file to signal cancellation.
func touchFile(path string) error {
	if path == "" {
		return nil
	}
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	return f.Close()
}

// removeFile removes a file if it exists.
func removeFile(path string) error {
	if path == "" {
		return nil
	}
	err := os.Remove(path)
	if os.IsNotExist(err) {
		return nil
	}
	return err
}

// clock is configurable for testing.
var clock = func() time.Time { return time.Now() }
