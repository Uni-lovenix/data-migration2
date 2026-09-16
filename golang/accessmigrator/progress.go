package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
)

var errCanceled = errors.New("operation canceled")

type progressState struct {
	Stage     string `json:"stage"`
	Rows      int64  `json:"rows"`
	TotalRows int64  `json:"totalRows,omitempty"`
	Canceled  bool   `json:"canceled,omitempty"`
}

func writeProgress(path string, progress progressState) error {
	if path == "" {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	data, err := json.Marshal(progress)
	if err != nil {
		return err
	}
	temporary := path + ".tmp"
	if err := os.WriteFile(temporary, append(data, '\n'), 0o644); err != nil {
		return err
	}
	return os.Rename(temporary, path)
}

func checkCancel(path string) error {
	if path == "" {
		return nil
	}
	_, err := os.Stat(path)
	if err == nil {
		return errCanceled
	}
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}
