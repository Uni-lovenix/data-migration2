package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"strings"
)

const version = "0.1.0"

func main() {
	if err := run(context.Background(), os.Args[1:]); err != nil {
		if err == errCanceled {
			fmt.Fprintln(os.Stderr, "canceled")
			os.Exit(3)
		}
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("usage: accessmigrator <list-tables|export|version>")
	}
	switch args[0] {
	case "version":
		fmt.Println(version)
		return nil
	case "list-tables":
		return runListTables(ctx, args[1:])
	case "export":
		return runExport(ctx, args[1:])
	default:
		return fmt.Errorf("unknown command: %s", args[0])
	}
}

func runListTables(ctx context.Context, args []string) error {
	flags := flag.NewFlagSet("list-tables", flag.ContinueOnError)
	file := flags.String("file", "", "Access database file")
	password := flags.String("password", "", "optional database password")
	binary := flags.String("mdb-tables-bin", envOrDefault("MDB_TABLES_BIN", "mdb-tables"), "mdb-tables executable")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if strings.TrimSpace(*file) == "" {
		return fmt.Errorf("--file is required")
	}
	tables, err := listTables(ctx, systemCommandRunner{}, *binary, *file, *password)
	if err != nil {
		return err
	}
	for _, table := range tables {
		fmt.Println(table)
	}
	return nil
}

func runExport(ctx context.Context, args []string) error {
	flags := flag.NewFlagSet("export", flag.ContinueOnError)
	options := exportOptions{}
	flags.StringVar(&options.File, "file", "", "Access database file")
	flags.StringVar(&options.Table, "table", "", "table name")
	flags.StringVar(&options.Output, "output", "", "output JSONL file")
	flags.StringVar(&options.Password, "password", "", "optional database password")
	flags.IntVar(&options.BatchSize, "batch-size", 500, "rows per JSONL batch")
	flags.Int64Var(&options.ResumeRows, "resume-rows", 0, "already exported rows")
	flags.StringVar(&options.ProgressFile, "progress-file", "", "progress JSON file")
	flags.StringVar(&options.CancelFile, "cancel-file", "", "cancel marker file")
	flags.StringVar(
		&options.ExportBinary,
		"mdb-export-bin",
		envOrDefault("MDB_EXPORT_BIN", "mdb-export"),
		"mdb-export executable",
	)
	if err := flags.Parse(args); err != nil {
		return err
	}
	if strings.TrimSpace(options.File) == "" {
		return fmt.Errorf("--file is required")
	}
	if strings.TrimSpace(options.Table) == "" {
		return fmt.Errorf("--table is required")
	}
	if strings.TrimSpace(options.Output) == "" {
		return fmt.Errorf("--output is required")
	}
	if options.BatchSize <= 0 {
		return fmt.Errorf("--batch-size must be positive")
	}
	rows, err := exportTable(ctx, systemCommandRunner{}, options)
	if err != nil {
		if err == errCanceled {
			_ = writeProgress(options.ProgressFile, progressState{
				Stage:    "export",
				Rows:     rows,
				Canceled: true,
			})
		} else {
			_ = os.Remove(options.Output + ".part")
		}
		return err
	}
	fmt.Printf("{\"rows\":%d}\n", rows)
	return nil
}

func envOrDefault(name string, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}
