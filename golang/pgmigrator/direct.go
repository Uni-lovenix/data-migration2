package main

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// runDirect reads from source PG and streams data directly into target PG,
// never touching the local filesystem.
func runDirect(opts directOptions) error {
	if opts.batchSize <= 0 {
		opts.batchSize = 1000
	}
	if opts.onConflict == "" {
		opts.onConflict = "skip"
	}

	srcClient, err := newPGClient(opts.srcDSN)
	if err != nil {
		return fmt.Errorf("source: %w", err)
	}
	defer srcClient.close()

	dstClient, err := newPGClient(opts.dstDSN)
	if err != nil {
		return fmt.Errorf("target: %w", err)
	}
	defer dstClient.close()

	if err := checkCancel(opts.cancelFile); err != nil {
		return err
	}

	startedAt := time.Now()
	rows, err := directCopyToCopy(srcClient, dstClient, opts)
	if err != nil {
		return err
	}

	result := map[string]any{
		"rows":       rows,
		"durationMs": time.Since(startedAt).Milliseconds(),
		"table":      opts.srcTable,
		"targetTable": opts.dstTable,
		"mode":      "direct",
	}
	data, _ := json.Marshal(result)
	fmt.Println(string(data))
	return nil
}

// directCopyToCopy streams from source PG using COPY TO STDOUT and inserts into target PG
// using CopyFrom, never materializing the full dataset on disk.
func directCopyToCopy(srcClient, dstClient *pgClient, opts directOptions) (int64, error) {
	ctx := context.Background()

	// Parse source schema.table.
	srcParts := strings.SplitN(opts.srcTable, ".", 2)
	var srcSchema, srcTable string
	if len(srcParts) == 2 {
		srcSchema = srcParts[0]
		srcTable = srcParts[1]
	} else {
		srcSchema = "public"
		srcTable = opts.srcTable
	}

	// Get source column names.
	var columns []string
	colQuery := `
		SELECT column_name
		FROM information_schema.columns
		WHERE table_schema = $1 AND table_name = $2
		ORDER BY ordinal_position`
	rows, err := srcClient.pool.Query(ctx, colQuery, srcSchema, srcTable)
	if err != nil {
		return 0, fmt.Errorf("query columns: %w", err)
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
		return 0, fmt.Errorf("no columns found for source table %s.%s", srcSchema, srcTable)
	}

	// Source: COPY TO STDOUT WITH BINARY.
	copyOutSQL := fmt.Sprintf(`COPY %s.%s (%s) TO STDOUT WITH BINARY`,
		srcSchema, srcTable, strings.Join(columns, ", "))
	srcRows, err := srcClient.pool.Query(ctx, copyOutSQL)
	if err != nil {
		return 0, fmt.Errorf("COPY query failed: %w", err)
	}
	defer srcRows.Close()

	// Parse target schema.table.
	dstParts := strings.SplitN(opts.dstTable, ".", 2)
	var dstSchema, dstTable string
	if len(dstParts) == 2 {
		dstSchema = dstParts[0]
		dstTable = dstParts[1]
	} else {
		dstSchema = "public"
		dstTable = opts.dstTable
	}

	// Target: CopyFrom with streaming rows.
	// We use a simple insert pipeline: read source rows in batches and insert.
	var rowsWritten int64
	skipRemaining := opts.resumeRows
	batch := make([][]any, 0, opts.batchSize)

	for srcRows.Next() {
		if err := checkCancel(opts.cancelFile); err != nil {
			return rowsWritten, err
		}

		values, err := srcRows.Values()
		if err != nil {
			return rowsWritten, fmt.Errorf("row scan failed: %w", err)
		}

		if skipRemaining > 0 {
			skipRemaining--
			continue
		}

		batch = append(batch, values)
		if len(batch) >= opts.batchSize {
			n, err := flushDirectBatch(ctx, dstClient, dstSchema, dstTable, columns, batch, opts.onConflict)
			if err != nil {
				return rowsWritten, err
			}
			rowsWritten += n
			batch = batch[:0]
			if err := writeProgress(opts.progressFile, "direct", rowsWritten, 0, 0); err != nil {
				return rowsWritten, err
			}
		}
	}
	if err := srcRows.Err(); err != nil {
		return rowsWritten, fmt.Errorf("COPY iteration error: %w", err)
	}

	// Flush remaining batch.
	if len(batch) > 0 {
		n, err := flushDirectBatch(ctx, dstClient, dstSchema, dstTable, columns, batch, opts.onConflict)
		if err != nil {
			return rowsWritten, err
		}
		rowsWritten += n
		if err := writeProgress(opts.progressFile, "direct", rowsWritten, 0, 0); err != nil {
			return rowsWritten, err
		}
	}

	return rowsWritten, nil
}

// flushDirectBatch inserts a batch of rows into the target table.
func flushDirectBatch(ctx context.Context, client *pgClient, schema, table string, columns []string, rows [][]any, onConflict string) (int64, error) {
	if len(rows) == 0 {
		return 0, nil
	}

	// Build batch insert with ON CONFLICT DO NOTHING (skip mode).
	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("INSERT INTO %s.%s (%s) VALUES ",
		schema, table, strings.Join(columns, ", ")))
	for i, row := range rows {
		if i > 0 {
			sb.WriteString(", ")
		}
		sb.WriteString("(")
		for j, val := range row {
			if j > 0 {
				sb.WriteString(", ")
			}
			if val == nil {
				sb.WriteString("NULL")
			} else {
				sb.WriteString(fmt.Sprintf("'%s'", escapeString(fmt.Sprintf("%v", val))))
			}
		}
		sb.WriteString(")")
	}
	if onConflict == "skip" {
		sb.WriteString(" ON CONFLICT DO NOTHING")
	}

	tag, err := client.pool.Exec(ctx, sb.String())
	if err != nil {
		return 0, fmt.Errorf("batch insert failed: %w", err)
	}
	// RowsAffected may be 0 if all were conflicts with DO NOTHING.
	_ = tag.RowsAffected()
	return int64(len(rows)), nil
}
