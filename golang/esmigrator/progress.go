package main

import (
	"encoding/json"
	"errors"
	"os"
	"time"
)

var errCanceled = errors.New("canceled")

type progress struct {
	Stage       string `json:"stage"`
	Rows        int64  `json:"rows"`
	Lines       int64  `json:"lines,omitempty"`
	Skipped     int64  `json:"skipped,omitempty"`
	SearchAfter any    `json:"searchAfter,omitempty"`
	UpdatedAt   string `json:"updatedAt"`
}

func writeProgress(
	path, stage string,
	rows, lines, skipped int64,
	searchAfter []any,
) error {
	if path == "" {
		return nil
	}
	value := progress{
		Stage:       stage,
		Rows:        rows,
		Lines:       lines,
		Skipped:     skipped,
		SearchAfter: searchAfter,
		UpdatedAt:   time.Now().UTC().Format(time.RFC3339Nano),
	}
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	tmpPath := path + ".tmp"
	if err := os.WriteFile(tmpPath, data, 0o644); err != nil {
		return err
	}
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		_ = os.Remove(tmpPath)
		return err
	}
	if err := os.Rename(tmpPath, path); err != nil {
		return err
	}
	return nil
}

func checkCancel(path string) error {
	if path == "" {
		return nil
	}
	_, err := os.Stat(path)
	if err == nil {
		return errCanceled
	}
	if !os.IsNotExist(err) {
		return err
	}
	return nil
}
