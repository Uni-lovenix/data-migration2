package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func runExport(opts exportOptions) error {
	if opts.batchSize <= 0 {
		opts.batchSize = 1000
	}
	if err := checkCancel(opts.cancelFile); err != nil {
		return err
	}
	client, err := newPGClient(opts.dsn)
	if err != nil {
		return err
	}
	defer client.close()

	if err := os.MkdirAll(filepath.Dir(opts.outputFile), 0o755); err != nil {
		return err
	}

	partFile := opts.outputFile + ".part"
	flags := os.O_CREATE | os.O_WRONLY
	if opts.resumeRows > 0 {
		flags |= os.O_APPEND
	} else {
		flags |= os.O_TRUNC
	}
	output, err := os.OpenFile(partFile, flags, 0o644)
	if err != nil {
		return err
	}
	writer := bufio.NewWriterSize(output, 1<<20)
	startedAt := time.Now()

	rows, err := exportWithCopy(client, opts, writer)
	if err != nil {
		_ = writer.Flush()
		_ = output.Close()
		return err
	}
	if err := writer.Flush(); err != nil {
		_ = output.Close()
		return err
	}
	if err := output.Close(); err != nil {
		return err
	}

	info, err := os.Stat(partFile)
	if err != nil {
		return err
	}
	if err := os.Remove(opts.outputFile); err != nil && !os.IsNotExist(err) {
		return err
	}
	if err := os.Rename(partFile, opts.outputFile); err != nil {
		return err
	}

	result := map[string]any{
		"rows":       rows,
		"bytes":      info.Size(),
		"durationMs": time.Since(startedAt).Milliseconds(),
		"table":      opts.table,
	}
	data, _ := json.Marshal(result)
	fmt.Println(string(data))
	return nil
}

func exportWithCopy(client *pgClient, opts exportOptions, writer *bufio.Writer) (int64, error) {
	ctx := context.Background()

	// Parse schema.table into components
	tableParts := strings.SplitN(opts.table, ".", 2)
	var schema, table string
	if len(tableParts) == 2 {
		schema = tableParts[0]
		table = tableParts[1]
	} else {
		schema = "public"
		table = opts.table
	}

	// Get column names for the table
	var columns []string
	colQuery := `
		SELECT column_name
		FROM information_schema.columns
		WHERE table_schema = $1 AND table_name = $2
		ORDER BY ordinal_position`
	rows, err := client.pool.Query(ctx, colQuery, schema, table)
	if err != nil {
		return 0, fmt.Errorf("failed to query columns: %w", err)
	}
	for rows.Next() {
		var col string
		if err := rows.Scan(&col); err != nil {
			rows.Close()
			return 0, err
		}
		columns = append(columns, col)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return 0, err
	}
	rows.Close()
	if len(columns) == 0 {
		return 0, fmt.Errorf("no columns found for table %s.%s", schema, table)
	}

	// Use COPY TO STDOUT WITH BINARY for streaming export
	copySQL := fmt.Sprintf(`COPY %s.%s (%s) TO STDOUT WITH BINARY`,
		schema, table, strings.Join(columns, ", "))
	copyRows, err := client.pool.Query(ctx, copySQL)
	if err != nil {
		return 0, fmt.Errorf("COPY query failed: %w", err)
	}
	defer copyRows.Close()

	var rowsWritten int64
	for copyRows.Next() {
		if err := checkCancel(opts.cancelFile); err != nil {
			return rowsWritten, err
		}

		values, err := copyRows.Values()
		if err != nil {
			copyRows.Close()
			return rowsWritten, fmt.Errorf("row scan failed: %w", err)
		}

		record := map[string]any{
			"table":   opts.table,
			"columns": columns,
			"values":  values,
		}
		data, err := json.Marshal(record)
		if err != nil {
			copyRows.Close()
			return rowsWritten, err
		}
		if _, err := writer.Write(data); err != nil {
			copyRows.Close()
			return rowsWritten, err
		}
		if err := writer.WriteByte('\n'); err != nil {
			copyRows.Close()
			return rowsWritten, err
		}
		rowsWritten++

		if rowsWritten%int64(opts.batchSize) == 0 {
			if err := writer.Flush(); err != nil {
				copyRows.Close()
				return rowsWritten, err
			}
			if err := writeProgress(opts.progressFile, "export", rowsWritten, 0, 0); err != nil {
				copyRows.Close()
				return rowsWritten, err
			}
		}
	}
	if err := copyRows.Err(); err != nil {
		return rowsWritten, fmt.Errorf("COPY iteration error: %w", err)
	}
	return rowsWritten, nil
}
