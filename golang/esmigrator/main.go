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

type directOptions struct {
	srcURL        string
	srcUsername   string
	srcPassword   string
	srcInsecure   bool
	srcIndex      string
	dstURL        string
	dstUsername   string
	dstPassword   string
	dstInsecure   bool
	dstIndex      string
	batchSize     int
	strategy      string
	onConflict    string
	resumeSearch  []any
	resumeRows    int64
	progressFile  string
	cancelFile    string
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

func parseDirectFlags(args []string) (directOptions, error) {
	var opts directOptions
	var searchAfterRaw string
	fs := flag.NewFlagSet("direct", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	// Source
	fs.StringVar(&opts.srcURL, "src-url", "", "source Elasticsearch base URL")
	fs.StringVar(&opts.srcUsername, "src-username", "", "source basic auth username")
	fs.StringVar(&opts.srcPassword, "src-password", "", "source basic auth password")
	fs.BoolVar(&opts.srcInsecure, "src-insecure-tls", false, "skip source TLS verification")
	fs.StringVar(&opts.srcIndex, "src-index", "", "source index")
	// Target
	fs.StringVar(&opts.dstURL, "dst-url", "", "target Elasticsearch base URL")
	fs.StringVar(&opts.dstUsername, "dst-username", "", "target basic auth username")
	fs.StringVar(&opts.dstPassword, "dst-password", "", "target basic auth password")
	fs.BoolVar(&opts.dstInsecure, "dst-insecure-tls", false, "skip target TLS verification")
	fs.StringVar(&opts.dstIndex, "dst-index", "", "target index")
	// Tuning
	fs.IntVar(&opts.batchSize, "batch-size", 500, "documents per search/bulk batch")
	fs.StringVar(&opts.strategy, "strategy", "scroll", "scroll or search_after")
	fs.StringVar(&opts.onConflict, "on-conflict", "skip", "skip or overwrite")
	fs.Int64Var(&opts.resumeRows, "resume-rows", 0, "rows already written to target")
	fs.StringVar(&searchAfterRaw, "search-after", "", "JSON array cursor for search_after resume")
	fs.StringVar(&opts.progressFile, "progress-file", "", "progress JSON file")
	fs.StringVar(&opts.cancelFile, "cancel-file", "", "cancellation marker file")
	if err := fs.Parse(args); err != nil {
		return opts, err
	}
	if opts.srcURL == "" || opts.srcIndex == "" {
		return opts, errors.New("direct 需要 --src-url 和 --src-index")
	}
	if opts.dstURL == "" || opts.dstIndex == "" {
		return opts, errors.New("direct 需要 --dst-url 和 --dst-index")
	}
	if opts.strategy != "scroll" && opts.strategy != "search_after" {
		return opts, errors.New("--strategy 必须是 scroll 或 search_after")
	}
	if searchAfterRaw != "" {
		if err := json.Unmarshal([]byte(searchAfterRaw), &opts.resumeSearch); err != nil {
			return opts, fmt.Errorf("--search-after 必须是 JSON 数组：%w", err)
		}
	}
	return opts, nil
}

func usage() {
	fmt.Fprintln(os.Stderr, `esmigrator - Elasticsearch migration engine

Usage:
  esmigrator export --url URL --index INDEX --output FILE [options]
  esmigrator import --url URL --index INDEX --input FILE [options]
  esmigrator direct --src-url URL --src-index INDEX --dst-url URL --dst-index INDEX [options]
  esmigrator version

Run "esmigrator export -h", "esmigrator import -h", or "esmigrator direct -h" for options.`)
}
