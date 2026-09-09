package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
)

const version = "0.1.0"

type exportOptions struct {
	url          string
	username     string
	password     string
	insecureTLS  bool
	index        string
	outputFile   string
	batchSize    int
	strategy     string
	resumeRows   int64
	searchAfter  []any
	progressFile string
	cancelFile   string
}

type importOptions struct {
	url          string
	username     string
	password     string
	insecureTLS  bool
	index        string
	inputFile    string
	batchSize    int
	onConflict   string
	resumeLines  int64
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
	var searchAfterRaw string
	fs := flag.NewFlagSet("export", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	fs.StringVar(&opts.url, "url", "", "Elasticsearch base URL")
	fs.StringVar(&opts.username, "username", "", "basic auth username")
	fs.StringVar(&opts.password, "password", "", "basic auth password")
	fs.BoolVar(&opts.insecureTLS, "insecure-tls", false, "skip TLS verification")
	fs.StringVar(&opts.index, "index", "", "source index")
	fs.StringVar(&opts.outputFile, "output", "", "output JSONL file")
	fs.IntVar(&opts.batchSize, "batch-size", 500, "documents per search/bulk batch")
	fs.StringVar(&opts.strategy, "strategy", "scroll", "scroll or search_after")
	fs.Int64Var(&opts.resumeRows, "resume-rows", 0, "rows already written to the .part file")
	fs.StringVar(&searchAfterRaw, "search-after", "", "JSON array cursor for search_after resume")
	fs.StringVar(&opts.progressFile, "progress-file", "", "progress JSON file")
	fs.StringVar(&opts.cancelFile, "cancel-file", "", "cancellation marker file")
	if err := fs.Parse(args); err != nil {
		return opts, err
	}
	if opts.url == "" || opts.index == "" || opts.outputFile == "" {
		return opts, errors.New("export 需要 --url、--index 和 --output")
	}
	if opts.batchSize <= 0 {
		return opts, errors.New("--batch-size 必须大于 0")
	}
	if opts.strategy == "" {
		opts.strategy = "scroll"
	}
	if opts.strategy != "scroll" && opts.strategy != "search_after" {
		return opts, errors.New("--strategy 必须是 scroll 或 search_after")
	}
	if searchAfterRaw != "" {
		if err := json.Unmarshal([]byte(searchAfterRaw), &opts.searchAfter); err != nil {
			return opts, fmt.Errorf("--search-after 必须是 JSON 数组：%w", err)
		}
	}
	return opts, nil
}

func parseImportFlags(args []string) (importOptions, error) {
	var opts importOptions
	fs := flag.NewFlagSet("import", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	fs.StringVar(&opts.url, "url", "", "Elasticsearch base URL")
	fs.StringVar(&opts.username, "username", "", "basic auth username")
	fs.StringVar(&opts.password, "password", "", "basic auth password")
	fs.BoolVar(&opts.insecureTLS, "insecure-tls", false, "skip TLS verification")
	fs.StringVar(&opts.index, "index", "", "target index")
	fs.StringVar(&opts.inputFile, "input", "", "input JSONL file")
	fs.IntVar(&opts.batchSize, "batch-size", 500, "documents per bulk batch")
	fs.StringVar(&opts.onConflict, "on-conflict", "skip", "skip or overwrite")
	fs.Int64Var(&opts.resumeLines, "resume-lines", 0, "lines already read from the input file")
	fs.StringVar(&opts.progressFile, "progress-file", "", "progress JSON file")
	fs.StringVar(&opts.cancelFile, "cancel-file", "", "cancellation marker file")
	if err := fs.Parse(args); err != nil {
		return opts, err
	}
	if opts.url == "" || opts.index == "" || opts.inputFile == "" {
		return opts, errors.New("import 需要 --url、--index 和 --input")
	}
	if opts.batchSize <= 0 {
		return opts, errors.New("--batch-size 必须大于 0")
	}
	if opts.onConflict != "skip" && opts.onConflict != "overwrite" {
		return opts, errors.New("--on-conflict 必须是 skip 或 overwrite")
	}
	return opts, nil
}

func usage() {
	fmt.Fprintln(os.Stderr, `esmigrator - Elasticsearch JSONL migration engine

Usage:
  esmigrator export --url URL --index INDEX --output FILE [options]
  esmigrator import --url URL --index INDEX --input FILE [options]
  esmigrator version

Run "esmigrator export -h" or "esmigrator import -h" for options.`)
}
