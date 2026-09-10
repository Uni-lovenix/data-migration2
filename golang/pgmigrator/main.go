package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
)

const version = "0.1.0"

type exportOptions struct {
	dsn          string
	table        string
	outputFile   string
	batchSize    int
	resumeRows   int64
	progressFile string
	cancelFile   string
}

type importOptions struct {
	dsn          string
	table        string
	inputFile    string
	batchSize    int
	onConflict   string
	resumeLines  int64
	progressFile string
	cancelFile   string
}

type directOptions struct {
	srcDSN       string
	srcTable     string
	dstDSN       string
	dstTable     string
	batchSize    int
	onConflict   string
	resumeRows   int64
	progressFile string
	cancelFile   string
}

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}

	var err error
	switch os.Args[1] {
	case "export":
		var opts exportOptions
		opts, err = parseExportFlags(os.Args[2:])
		if err == nil {
			err = runExport(opts)
		}
	case "import":
		var opts importOptions
		opts, err = parseImportFlags(os.Args[2:])
		if err == nil {
			err = runImport(opts)
		}
	case "direct":
		var opts directOptions
		opts, err = parseDirectFlags(os.Args[2:])
		if err == nil {
			err = runDirect(opts)
		}
	case "version":
		fmt.Println(version)
		return
	default:
		usage()
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

func parseExportFlags(args []string) (exportOptions, error) {
	var opts exportOptions
	fs := flag.NewFlagSet("export", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	fs.StringVar(&opts.dsn, "dsn", "", "PostgreSQL connection string")
	fs.StringVar(&opts.table, "table", "", "source table (schema.table)")
	fs.StringVar(&opts.outputFile, "output", "", "output JSONL file")
	fs.IntVar(&opts.batchSize, "batch-size", 1000, "rows per COPY batch")
	fs.Int64Var(&opts.resumeRows, "resume-rows", 0, "rows already written to the .part file")
	fs.StringVar(&opts.progressFile, "progress-file", "", "progress JSON file")
	fs.StringVar(&opts.cancelFile, "cancel-file", "", "cancellation marker file")
	if err := fs.Parse(args); err != nil {
		return opts, err
	}
	if opts.dsn == "" || opts.table == "" || opts.outputFile == "" {
		return opts, errors.New("export requires --dsn, --table, and --output")
	}
	if opts.batchSize <= 0 {
		return opts, errors.New("--batch-size must be positive")
	}
	return opts, nil
}

func parseImportFlags(args []string) (importOptions, error) {
	var opts importOptions
	fs := flag.NewFlagSet("import", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	fs.StringVar(&opts.dsn, "dsn", "", "PostgreSQL connection string")
	fs.StringVar(&opts.table, "table", "", "target table (schema.table)")
	fs.StringVar(&opts.inputFile, "input", "", "input JSONL file")
	fs.IntVar(&opts.batchSize, "batch-size", 1000, "rows per insert batch")
	fs.StringVar(&opts.onConflict, "on-conflict", "skip", "skip or overwrite")
	fs.Int64Var(&opts.resumeLines, "resume-lines", 0, "lines already read from the input file")
	fs.StringVar(&opts.progressFile, "progress-file", "", "progress JSON file")
	fs.StringVar(&opts.cancelFile, "cancel-file", "", "cancellation marker file")
	if err := fs.Parse(args); err != nil {
		return opts, err
	}
	if opts.dsn == "" || opts.table == "" || opts.inputFile == "" {
		return opts, errors.New("import requires --dsn, --table, and --input")
	}
	if opts.batchSize <= 0 {
		return opts, errors.New("--batch-size must be positive")
	}
	if opts.onConflict != "skip" && opts.onConflict != "overwrite" {
		return opts, errors.New("--on-conflict must be skip or overwrite")
	}
	return opts, nil
}

func parseDirectFlags(args []string) (directOptions, error) {
	var opts directOptions
	fs := flag.NewFlagSet("direct", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	fs.StringVar(&opts.srcDSN, "src-dsn", "", "source PostgreSQL connection string")
	fs.StringVar(&opts.srcTable, "src-table", "", "source table (schema.table)")
	fs.StringVar(&opts.dstDSN, "dst-dsn", "", "target PostgreSQL connection string")
	fs.StringVar(&opts.dstTable, "dst-table", "", "target table (schema.table)")
	fs.IntVar(&opts.batchSize, "batch-size", 1000, "rows per batch")
	fs.StringVar(&opts.onConflict, "on-conflict", "skip", "skip or overwrite")
	fs.Int64Var(&opts.resumeRows, "resume-rows", 0, "rows already written to target")
	fs.StringVar(&opts.progressFile, "progress-file", "", "progress JSON file")
	fs.StringVar(&opts.cancelFile, "cancel-file", "", "cancellation marker file")
	if err := fs.Parse(args); err != nil {
		return opts, err
	}
	if opts.srcDSN == "" || opts.srcTable == "" {
		return opts, errors.New("direct requires --src-dsn and --src-table")
	}
	if opts.dstDSN == "" || opts.dstTable == "" {
		return opts, errors.New("direct requires --dst-dsn and --dst-table")
	}
	if opts.onConflict != "skip" && opts.onConflict != "overwrite" {
		return opts, errors.New("--on-conflict must be skip or overwrite")
	}
	return opts, nil
}

func usage() {
	fmt.Fprintln(os.Stderr, `pgmigrator - PostgreSQL migration engine

Usage:
  pgmigrator export --dsn DSN --table TABLE --output FILE [options]
  pgmigrator import --dsn DSN --table TABLE --input FILE [options]
  pgmigrator direct --src-dsn DSN --src-table TABLE --dst-dsn DSN --dst-table TABLE [options]
  pgmigrator version

Run "pgmigrator export -h", "pgmigrator import -h", or "pgmigrator direct -h" for options.`)
}
