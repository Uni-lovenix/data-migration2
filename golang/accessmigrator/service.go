package main

import (
	"bytes"
	"context"
	"encoding/csv"
	"fmt"
	"io"
	"os/exec"
	"strings"
	"sync"
)

type commandRunner interface {
	Output(ctx context.Context, name string, args ...string) ([]byte, error)
	Stream(ctx context.Context, name string, args ...string) (io.ReadCloser, error)
}

type systemCommandRunner struct{}

func (systemCommandRunner) Output(ctx context.Context, name string, args ...string) ([]byte, error) {
	command := exec.CommandContext(ctx, name, args...)
	var stderr bytes.Buffer
	command.Stderr = &stderr
	output, err := command.Output()
	if err != nil {
		message := strings.TrimSpace(stderr.String())
		if message == "" {
			message = err.Error()
		}
		return nil, fmt.Errorf("%s 执行失败：%s", name, message)
	}
	return output, nil
}

func (systemCommandRunner) Stream(ctx context.Context, name string, args ...string) (io.ReadCloser, error) {
	command := exec.CommandContext(ctx, name, args...)
	stdout, err := command.StdoutPipe()
	if err != nil {
		return nil, err
	}
	var stderr bytes.Buffer
	command.Stderr = &stderr
	if err := command.Start(); err != nil {
		return nil, fmt.Errorf("%s 启动失败：%w", name, err)
	}
	return &commandReadCloser{
		ReadCloser: stdout,
		wait: func() error {
			if err := command.Wait(); err != nil {
				message := strings.TrimSpace(stderr.String())
				if message == "" {
					message = err.Error()
				}
				return fmt.Errorf("%s 执行失败：%s", name, message)
			}
			return nil
		},
	}, nil
}

type commandReadCloser struct {
	io.ReadCloser
	wait     func() error
	once     sync.Once
	waitErr  error
	closeErr error
}

func (reader *commandReadCloser) Close() error {
	reader.once.Do(func() {
		reader.closeErr = reader.ReadCloser.Close()
		reader.waitErr = reader.wait()
	})
	if reader.closeErr != nil {
		return reader.closeErr
	}
	return reader.waitErr
}

func listTables(ctx context.Context, runner commandRunner, binary string, file string, password string) ([]string, error) {
	args := mdbtoolsArgs(binary, file, password)
	output, err := runner.Output(ctx, binary, args...)
	if err != nil {
		return nil, err
	}
	lines := strings.Split(strings.ReplaceAll(string(output), "\r\n", "\n"), "\n")
	tables := make([]string, 0, len(lines))
	for _, line := range lines {
		table := strings.TrimSpace(line)
		if table != "" {
			tables = append(tables, table)
		}
	}
	return tables, nil
}

func mdbtoolsArgs(binary string, file string, password string) []string {
	args := make([]string, 0, 4)
	if strings.Contains(binary, "mdb-tables") {
		args = append(args, "-1")
	}
	if password != "" {
		args = append(args, "-p", password)
	}
	return append(args, file)
}

func newCSVReader(reader io.Reader) (*csv.Reader, error) {
	csvReader := csv.NewReader(reader)
	csvReader.FieldsPerRecord = -1
	csvReader.ReuseRecord = false
	csvReader.LazyQuotes = true
	return csvReader, nil
}
