package main

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"
	"time"
)

type importJob struct {
	seq     int
	rows    []map[string]any
	endLine int64
}

type importJobResult struct {
	seq     int
	rows    int64
	skipped int64
	endLine int64
	err     error
}

func runParallelImport(
	client *elasticsearchClient,
	opts importOptions,
	targetTypes map[string]string,
	indexCreated bool,
	mappingSource string,
) error {
	startedAt := time.Now()
	input, err := os.Open(opts.inputFile)
	if err != nil {
		return err
	}
	defer input.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	jobs := make(chan importJob, opts.concurrency)
	results := make(chan importJobResult, opts.concurrency)
	producerErr := make(chan error, 1)

	var workers sync.WaitGroup
	workers.Add(opts.concurrency)
	for workerID := 0; workerID < opts.concurrency; workerID++ {
		go func() {
			defer workers.Done()
			runImportWorker(ctx, client, opts, jobs, results)
		}()
	}

	go func() {
		err := produceImportJobs(
			ctx,
			bufio.NewReaderSize(input, 1<<20),
			opts,
			targetTypes,
			jobs,
		)
		close(jobs)
		producerErr <- err
	}()

	go func() {
		workers.Wait()
		close(results)
	}()

	var firstErr error
	nextSeq := 0
	var committedRows, committedSkipped, committedLines int64
	pending := make(map[int]importJobResult)

	for result := range results {
		if result.err != nil {
			if firstErr == nil {
				firstErr = result.err
				cancel()
			}
			continue
		}
		pending[result.seq] = result
		if firstErr != nil {
			continue
		}

		for {
			committed, ok := pending[nextSeq]
			if !ok {
				break
			}
			delete(pending, nextSeq)
			nextSeq++
			committedRows += committed.rows
			committedSkipped += committed.skipped
			committedLines = committed.endLine
			if err := writeProgress(
				opts.progressFile,
				"import",
				committedRows,
				committedLines,
				committedSkipped,
				nil,
			); err != nil {
				if firstErr == nil {
					firstErr = err
					cancel()
				}
				break
			}
		}
	}

	if err := <-producerErr; err != nil && firstErr == nil {
		firstErr = err
	}
	if firstErr != nil {
		return firstErr
	}
	if len(pending) != 0 {
		return fmt.Errorf("并发导入提前结束：仍有未提交批次")
	}

	result := map[string]any{
		"rows":         committedRows,
		"skipped":      committedSkipped,
		"durationMs":   time.Since(startedAt).Milliseconds(),
		"index":        opts.index,
		"indexCreated": indexCreated,
		"concurrency":  opts.concurrency,
	}
	if mappingSource != "" {
		result["mappingSource"] = mappingSource
	}
	fmt.Println(string(mustJSON(result)))
	return nil
}

func produceImportJobs(
	ctx context.Context,
	reader *bufio.Reader,
	opts importOptions,
	targetTypes map[string]string,
	jobs chan<- importJob,
) error {
	var (
		lines   int64
		seq     int
		pending []map[string]any
	)

	for {
		line, readErr := reader.ReadString('\n')
		if readErr != nil && readErr != io.EOF {
			return readErr
		}
		if readErr == io.EOF && len(line) == 0 {
			break
		}

		lines++
		if lines <= opts.resumeLines {
			if readErr == io.EOF {
				break
			}
			continue
		}
		if strings.TrimSpace(line) == "" {
			if readErr == io.EOF {
				break
			}
			continue
		}

		parsedRows, err := parseImportRows(
			line,
			lines,
			opts.selectedCols,
			opts.fieldTransforms,
			targetTypes,
		)
		if err != nil {
			return err
		}
		pending = append(pending, parsedRows...)
		for len(pending) >= opts.batchSize {
			job := importJob{
				seq:     seq,
				rows:    append([]map[string]any(nil), pending[:opts.batchSize]...),
				endLine: lines,
			}
			if err := sendImportJob(ctx, jobs, job); err != nil {
				return err
			}
			seq++
			pending = pending[opts.batchSize:]
		}

		if readErr == io.EOF {
			break
		}
	}

	if len(pending) > 0 {
		if err := sendImportJob(ctx, jobs, importJob{
			seq:     seq,
			rows:    pending,
			endLine: lines,
		}); err != nil {
			return err
		}
	}
	return nil
}

func sendImportJob(ctx context.Context, jobs chan<- importJob, job importJob) error {
	select {
	case jobs <- job:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func runImportWorker(
	ctx context.Context,
	client *elasticsearchClient,
	opts importOptions,
	jobs <-chan importJob,
	results chan<- importJobResult,
) {
	for job := range jobs {
		if ctx.Err() != nil {
			return
		}
		if err := checkCancel(opts.cancelFile); err != nil {
			select {
			case results <- importJobResult{seq: job.seq, err: err}:
			case <-ctx.Done():
			}
			return
		}

		skipped, err := flushBulk(client, opts, job.rows)
		result := importJobResult{
			seq:     job.seq,
			rows:    int64(len(job.rows)),
			skipped: skipped,
			endLine: job.endLine,
			err:     err,
		}
		select {
		case results <- result:
		case <-ctx.Done():
			return
		}
		if err != nil {
			return
		}
	}
}
