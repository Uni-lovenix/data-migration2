package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

type tableRef struct {
	Schema string `json:"schema"`
	Name   string `json:"name"`
}

type exportEnvelope struct {
	Table   tableRef `json:"table"`
	Columns []string `json:"columns"`
	Rows    [][]any  `json:"rows"`
}

type exportOptions struct {
	File         string
	Table        string
	Output       string
	Password     string
	BatchSize    int
	ResumeRows   int64
	ProgressFile string
	CancelFile   string
	ExportBinary string
}

func exportTable(
	ctx context.Context,
	runner commandRunner,
	options exportOptions,
) (int64, error) {
	if options.BatchSize <= 0 {
		options.BatchSize = 500
	}
	if err := checkCancel(options.CancelFile); err != nil {
		return 0, err
	}

	args := []string{}
	if options.Password != "" {
		args = append(args, "-p", options.Password)
	}
	args = append(args, options.File, options.Table)
	stream, err := runner.Stream(ctx, options.ExportBinary, args...)
	if err != nil {
		return 0, err
	}
	defer stream.Close()

	reader, err := newCSVReader(stream)
	if err != nil {
		return 0, err
	}
	columns, err := reader.Read()
	if err != nil {
		if errors.Is(err, io.EOF) {
			return 0, fmt.Errorf("表没有可导出的列：%s", options.Table)
		}
		return 0, fmt.Errorf("读取 Access 表列失败：%w", err)
	}
	if len(columns) == 0 {
		return 0, fmt.Errorf("表没有可导出的列：%s", options.Table)
	}
	if err := os.MkdirAll(filepath.Dir(options.Output), 0o755); err != nil {
		return 0, err
	}
	flags := os.O_CREATE | os.O_WRONLY
	if options.ResumeRows > 0 {
		flags |= os.O_APPEND
	} else {
		flags |= os.O_TRUNC
	}
	output, err := os.OpenFile(options.Output+".part", flags, 0o644)
	if err != nil {
		return 0, err
	}
	writer := &batchWriter{
		output:    output,
		table:     options.Table,
		columns:   columns,
		batchSize: options.BatchSize,
	}

	rows := options.ResumeRows
	skipped := int64(0)
	for {
		record, readErr := reader.Read()
		if errors.Is(readErr, io.EOF) {
			break
		}
		if readErr != nil {
			writer.close()
			return rows, fmt.Errorf("读取 Access CSV 失败：%w", readErr)
		}
		if skipped < options.ResumeRows {
			skipped++
			continue
		}
		if err := writer.append(record); err != nil {
			writer.close()
			return rows, err
		}
		rows++
		if writer.pendingCount() >= options.BatchSize {
			if err := writer.flush(); err != nil {
				writer.close()
				return rows, err
			}
			if err := writeProgress(options.ProgressFile, progressState{
				Stage:    "export",
				Rows:     rows,
				Canceled: false,
			}); err != nil {
				writer.close()
				return rows, err
			}
			if err := checkCancel(options.CancelFile); err != nil {
				writer.close()
				return rows, err
			}
		}
	}
	if err := writer.flush(); err != nil {
		writer.close()
		return rows, err
	}
	if err := writer.close(); err != nil {
		return rows, err
	}
	if err := stream.Close(); err != nil {
		return rows, err
	}
	if err := os.Rename(options.Output+".part", options.Output); err != nil {
		return rows, err
	}
	if err := writeProgress(options.ProgressFile, progressState{
		Stage:    "export",
		Rows:     rows,
		Canceled: false,
	}); err != nil {
		return rows, err
	}
	return rows, nil
}

type batchWriter struct {
	output    *os.File
	encoder   *json.Encoder
	table     string
	columns   []string
	rows      [][]any
	batchSize int
}

func (writer *batchWriter) append(record []string) error {
	row := make([]any, len(writer.columns))
	for index := range writer.columns {
		if index < len(record) {
			row[index] = record[index]
		} else {
			row[index] = nil
		}
	}
	writer.rows = append(writer.rows, row)
	return nil
}

func (writer *batchWriter) pendingCount() int {
	return len(writer.rows)
}

func (writer *batchWriter) flush() error {
	if len(writer.rows) == 0 {
		return nil
	}
	if writer.encoder == nil {
		writer.encoder = json.NewEncoder(writer.output)
	}
	envelope := exportEnvelope{
		Table:   tableRef{Schema: "access", Name: writer.table},
		Columns: writer.columns,
		Rows:    writer.rows,
	}
	if err := writer.encoder.Encode(envelope); err != nil {
		return err
	}
	writer.rows = writer.rows[:0]
	return nil
}

func (writer *batchWriter) close() error {
	if writer.output == nil {
		return nil
	}
	err := writer.output.Close()
	writer.output = nil
	return err
}
