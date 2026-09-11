package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// dispatchConfig holds the parameters for a dispatch run.
type dispatchConfig struct {
	parallel     int
	progressFile string
	cancelFile   string
	resume       bool
}

// runDispatch coordinates the worker pool for the given tasks.
func runDispatch(tasks []Task, cfg dispatchConfig) error {
	if len(tasks) == 0 {
		return fmt.Errorf("no tasks to dispatch")
	}

	// Create the shared cancel file so engines can watch it.
	if err := touchFile(cfg.cancelFile); err != nil {
		return fmt.Errorf("create cancel file: %w", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer func() {
		cancel()
		// Clean up cancel file on exit.
		_ = removeFile(cfg.cancelFile)
	}()

	tasksCh := make(chan Task, len(tasks))
	resultsCh := make(chan TaskResult, len(tasks))

	// Launch workers.
	workerCount := cfg.parallel
	if workerCount < 1 {
		workerCount = 1
	}
	if workerCount > len(tasks) {
		workerCount = len(tasks)
	}

	var wg sync.WaitGroup
	for i := 0; i < workerCount; i++ {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			worker(ctx, id, tasksCh, resultsCh, cfg)
		}(i)
	}

	// Enqueue tasks.
	for _, t := range tasks {
		tasksCh <- t
	}
	close(tasksCh)

	// Close results channel when all workers done.
	go func() {
		wg.Wait()
		close(resultsCh)
	}()

	// Aggregate results.
	var (
		aggregate  = &AggregateProgress{TotalTasks: len(tasks)}
		resultMu    sync.Mutex
		wgProgress sync.WaitGroup
	)

	// Progress aggregator loop.
	wgProgress.Add(1)
	go func() {
		defer wgProgress.Done()
		ticker := time.NewTicker(500 * time.Millisecond)
		defer ticker.Stop()
		var done bool
		for !done {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				resultMu.Lock()
				_ = writeAggregateProgress(cfg.progressFile, aggregate)
				resultMu.Unlock()
			case r, ok := <-resultsCh:
				if !ok {
					done = true
					break
				}
				resultMu.Lock()
				aggregate.addResult(r)
				_ = writeAggregateProgress(cfg.progressFile, aggregate)
				resultMu.Unlock()
			}
		}
	}()

	// Wait for all results.
	for r := range resultsCh {
		resultMu.Lock()
		aggregate.addResult(r)
		resultMu.Unlock()
	}
	resultMu.Lock()
	_ = writeAggregateProgress(cfg.progressFile, aggregate)
	hasFailure := aggregate.Failed > 0
	resultMu.Unlock()

	wgProgress.Wait()

	if hasFailure {
		return fmt.Errorf("one or more tasks failed")
	}
	return nil
}

// worker pulls tasks from tasksCh and executes them.
func worker(ctx context.Context, id int, tasksCh <-chan Task, resultsCh chan<- TaskResult, cfg dispatchConfig) {
	for task := range tasksCh {
		// Check top-level cancel before starting.
		select {
		case <-ctx.Done():
			resultsCh <- TaskResult{
				TaskID: task.ID,
				Engine: task.Engine,
				Action: task.Action,
				Status: "canceled",
			}
			continue
		default:
		}

		start := clock()
		result := executeTask(ctx, task, cfg)
		result.DurationMs = clock().Sub(start).Milliseconds()
		resultsCh <- result
	}
}

// executeTask runs a single task via the appropriate engine binary.
func executeTask(ctx context.Context, task Task, cfg dispatchConfig) TaskResult {
	bin, err := findEngine(task.Engine)
	if err != nil {
		return TaskResult{
			TaskID: task.ID,
			Engine: task.Engine,
			Action: task.Action,
			Status: "failed",
			Error:  err.Error(),
		}
	}

	args := buildArgs(task, cfg.cancelFile)
	cmd := exec.CommandContext(ctx, bin, args...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	if err := cmd.Start(); err != nil {
		return TaskResult{
			TaskID: task.ID,
			Engine: task.Engine,
			Action: task.Action,
			Status: "failed",
			Error:  fmt.Sprintf("start: %v", err),
		}
	}

	// Wait for the subprocess; use a goroutine to allow cancellation.
	done := make(chan error, 1)
	go func() {
		done <- cmd.Wait()
	}()

	select {
	case <-ctx.Done():
		_ = cmd.Process.Kill()
		<-done
		return TaskResult{
			TaskID: task.ID,
			Engine: task.Engine,
			Action: task.Action,
			Status: "canceled",
		}
	case err := <-done:
		if err != nil {
			exitCode := exitCodeFromError(err)
			if exitCode == 3 {
				return TaskResult{
					TaskID: task.ID,
					Engine: task.Engine,
					Action: task.Action,
					Status: "canceled",
				}
			}
			return TaskResult{
				TaskID: task.ID,
				Engine: task.Engine,
				Action: task.Action,
				Status: "failed",
				Error:  err.Error(),
			}
		}
	}

	// Read rows from sub progress file.
	rows, _ := readSubProgress(task.ProgressFile)
	return TaskResult{
		TaskID: task.ID,
		Engine: task.Engine,
		Action: task.Action,
		Status: "success",
		Rows:   rows,
	}
}

// findEngine returns the absolute path to the engine binary.
func findEngine(engine string) (string, error) {
	switch engine {
	case "esmigrator":
		return findBinary("esmigrator")
	case "pgmigrator":
		return findBinary("pgmigrator")
	default:
		return "", fmt.Errorf("unknown engine: %s", engine)
	}
}

// findBinary searches for a binary in common locations.
func findBinary(name string) (string, error) {
	// If the name contains a path separator, treat it as an absolute/relative path.
	if strings.ContainsRune(name, '/') {
		return name, nil
	}
	// Search PATH.
	path, err := exec.LookPath(name)
	if err == nil {
		return path, nil
	}
	// Fallback: look relative to the dispatcher binary location.
	exe, err := os.Executable()
	if err == nil {
		dir := filepath.Dir(exe)
		candidate := filepath.Join(dir, name)
		if _, err := os.Stat(candidate); err == nil {
			return candidate, nil
		}
		// Also check ../<name> (development layout).
		candidate = filepath.Join(dir, "..", name)
		if _, err := os.Stat(candidate); err == nil {
			return candidate, nil
		}
	}
	// Fallback: check current working directory.
	cwd, err := os.Getwd()
	if err == nil {
		candidate := filepath.Join(cwd, name)
		if _, err := os.Stat(candidate); err == nil {
			return candidate, nil
		}
	}
	return "", fmt.Errorf("%s not found in PATH", name)
}

// buildArgs constructs the CLI arguments for the engine sub-process.
func buildArgs(task Task, cancelFile string) []string {
	var args []string

	if task.Direct {
		args = append(args, "direct")
	} else {
		args = append(args, task.Action)
	}

	switch task.Engine {
	case "esmigrator":
		if task.Direct {
			// Direct mode: source and target flags.
			if task.SrcURL != "" {
				args = append(args, "--src-url", task.SrcURL)
			}
			if task.SrcUsername != "" {
				args = append(args, "--src-username", task.SrcUsername)
			}
			if task.SrcPassword != "" {
				args = append(args, "--src-password", task.SrcPassword)
			}
			if task.SrcInsecureTLS {
				args = append(args, "--src-insecure-tls")
			}
			if task.SrcIndex != "" {
				args = append(args, "--src-index", task.SrcIndex)
			}
			if task.DstURL != "" {
				args = append(args, "--dst-url", task.DstURL)
			}
			if task.DstUsername != "" {
				args = append(args, "--dst-username", task.DstUsername)
			}
			if task.DstPassword != "" {
				args = append(args, "--dst-password", task.DstPassword)
			}
			if task.DstInsecureTLS {
				args = append(args, "--dst-insecure-tls")
			}
			if task.DstIndex != "" {
				args = append(args, "--dst-index", task.DstIndex)
			}
		} else {
			// File-based mode.
			if task.URL != "" {
				args = append(args, "--url", task.URL)
			}
			if task.Username != "" {
				args = append(args, "--username", task.Username)
			}
			if task.Password != "" {
				args = append(args, "--password", task.Password)
			}
			if task.InsecureTLS {
				args = append(args, "--insecure-tls")
			}
			if task.Index != "" {
				args = append(args, "--index", task.Index)
			}
			if task.OutputFile != "" {
				args = append(args, "--output", task.OutputFile)
			}
			if task.InputFile != "" {
				args = append(args, "--input", task.InputFile)
			}
		}
		if task.BatchSize > 0 {
			args = append(args, "--batch-size", fmt.Sprintf("%d", task.BatchSize))
		}
		if task.Strategy != "" {
			args = append(args, "--strategy", task.Strategy)
		}
		if task.OnConflict != "" {
			args = append(args, "--on-conflict", task.OnConflict)
		}
		if task.ResumeRows > 0 {
			args = append(args, "--resume-rows", fmt.Sprintf("%d", task.ResumeRows))
		}
		if task.ResumeLines > 0 {
			args = append(args, "--resume-lines", fmt.Sprintf("%d", task.ResumeLines))
		}
		if len(task.SearchAfter) > 0 {
			raw, _ := json.Marshal(task.SearchAfter)
			args = append(args, "--search-after", string(raw))
		}

	case "pgmigrator":
		if task.Direct {
			// Direct mode: source and target flags.
			if task.SrcDSN != "" {
				args = append(args, "--src-dsn", task.SrcDSN)
			}
			if task.SrcTable != "" {
				args = append(args, "--src-table", task.SrcTable)
			}
			if task.DstDSN != "" {
				args = append(args, "--dst-dsn", task.DstDSN)
			}
			if task.DstTable != "" {
				args = append(args, "--dst-table", task.DstTable)
			}
		} else {
			// File-based mode.
			if task.DSN != "" {
				args = append(args, "--dsn", task.DSN)
			}
			if task.Table != "" {
				args = append(args, "--table", task.Table)
			}
			if task.OutputFile != "" {
				args = append(args, "--output", task.OutputFile)
			}
			if task.InputFile != "" {
				args = append(args, "--input", task.InputFile)
			}
		}
		if task.BatchSize > 0 {
			args = append(args, "--batch-size", fmt.Sprintf("%d", task.BatchSize))
		}
		if task.OnConflict != "" {
			args = append(args, "--on-conflict", task.OnConflict)
		}
		if task.ResumeRows > 0 {
			args = append(args, "--resume-rows", fmt.Sprintf("%d", task.ResumeRows))
		}
		if task.ResumeLines > 0 {
			args = append(args, "--resume-lines", fmt.Sprintf("%d", task.ResumeLines))
		}
	}

	// Per-task progress and cancel files.
	if task.ProgressFile != "" {
		args = append(args, "--progress-file", task.ProgressFile)
	}
	args = append(args, "--cancel-file", cancelFile)

	return args
}

func exitCodeFromError(err error) int {
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		return ee.ExitCode()
	}
	// On non-exec errors (Start failure), return 1.
	return 1
}

