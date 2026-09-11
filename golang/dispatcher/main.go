package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"
)

const version = "0.1.0"

type dispatchOptions struct {
	tasksFile    string
	parallel     int
	progressFile string
	cancelFile   string
	resume       bool
}

func main() {
	if len(os.Args) < 2 {
		dispatcherUsage()
		os.Exit(2)
	}

	var err error
	switch os.Args[1] {
	case "dispatch":
		err = runDispatchCommand(os.Args[2:])
	case "version":
		fmt.Println("dispatcher version", version)
		return
	default:
		dispatcherUsage()
		os.Exit(2)
	}

	if err != nil {
		if errors.Is(err, errCanceled) {
			fmt.Fprintln(os.Stderr, "canceled")
			os.Exit(3)
		}
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func parseDispatchFlags(args []string) (dispatchOptions, error) {
	var opts dispatchOptions
	fs := flag.NewFlagSet("dispatch", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	fs.StringVar(&opts.tasksFile, "tasks", "", "JSONL file containing sub-tasks")
	fs.IntVar(&opts.parallel, "parallel", 1, "number of concurrent workers (1 = serial)")
	fs.StringVar(&opts.progressFile, "progress-file", "", "aggregate progress output file")
	fs.StringVar(&opts.cancelFile, "cancel-file", "", "cancellation marker file")
	fs.BoolVar(&opts.resume, "resume", false, "resume incomplete tasks")
	if err := fs.Parse(args); err != nil {
		return opts, err
	}
	if opts.tasksFile == "" {
		return opts, errors.New("--tasks is required")
	}
	if opts.parallel < 1 {
		return opts, errors.New("--parallel must be >= 1")
	}
	return opts, nil
}

func runDispatchCommand(args []string) error {
	opts, err := parseDispatchFlags(args)
	if err != nil {
		return err
	}

	// Resolve cancel file to an absolute path.
	cancelFile := opts.cancelFile
	if cancelFile == "" {
		cancelFile = filepath.Join(os.TempDir(), fmt.Sprintf("dispatcher-%d.cancel", time.Now().UnixNano()))
	}

	// Generate progress file name if not provided.
	progressFile := opts.progressFile
	if progressFile == "" {
		progressFile = filepath.Join(os.TempDir(), fmt.Sprintf("dispatcher-%d.progress.json", time.Now().UnixNano()))
	}

	tasks, err := ParseTasks(opts.tasksFile)
	if err != nil {
		return fmt.Errorf("parse tasks: %w", err)
	}

	cfg := dispatchConfig{
		parallel:     opts.parallel,
		progressFile: progressFile,
		cancelFile:   cancelFile,
		resume:       opts.resume,
	}

	// Auto-generate per-task progress files if not set.
	for i := range tasks {
		if tasks[i].ProgressFile == "" {
			tasks[i].ProgressFile = filepath.Join(os.TempDir(),
				fmt.Sprintf("dispatcher-task-%s.progress.json", tasks[i].ID))
		}
	}

	return runDispatch(tasks, cfg)
}

var errCanceled = errors.New("canceled")

func dispatcherUsage() {
	fmt.Fprintln(os.Stderr, `dispatcher - parallel migration dispatcher

Usage:
  dispatcher dispatch --tasks TASKS_FILE [options]
  dispatcher version

Options:
  --parallel N        number of concurrent workers (default 1 = serial)
  --progress-file FILE  aggregate progress output file
  --cancel-file FILE  cancellation marker file
  --resume           resume incomplete tasks from progress files

TASKS_FILE is a JSONL file where each line is a sub-task JSON object.
Run "dispatcher dispatch -h" for full options.`)
}
