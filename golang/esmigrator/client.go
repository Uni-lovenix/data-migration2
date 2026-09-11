package main

import (
	"bytes"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const httpTimeout = 120 * time.Second

type elasticsearchClient struct {
	baseURL  string
	username string
	password string
	http     *http.Client
}

func newElasticsearchClient(rawURL, username, password string, insecureTLS bool) (*elasticsearchClient, error) {
	parsed, err := url.Parse(rawURL)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return nil, fmt.Errorf("无效的 Elasticsearch 地址：%s", rawURL)
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	if insecureTLS {
		transport.TLSClientConfig = &tls.Config{InsecureSkipVerify: true}
	}
	return &elasticsearchClient{
		baseURL:  strings.TrimRight(rawURL, "/"),
		username: username,
		password: password,
		http: &http.Client{
			Timeout:   httpTimeout,
			Transport: transport,
		},
	}, nil
}

func (c *elasticsearchClient) request(method, path, contentType string, body []byte) ([]byte, error) {
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequest(method, c.baseURL+path, reader)
	if err != nil {
		return nil, err
	}
	if c.username != "" {
		req.SetBasicAuth(c.username, c.password)
	}
	if body != nil {
		req.Header.Set("Content-Type", contentType)
		req.Header.Set("Content-Length", strconv.Itoa(len(body)))
	}

	response, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()

	data, err := io.ReadAll(response.Body)
	if err != nil {
		return nil, err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, elasticsearchHTTPError(response.StatusCode, data)
	}
	return data, nil
}

type httpError struct {
	Status int
	Body   string
	Err    error
}

func (e *httpError) Error() string { return e.Err.Error() }

func (e *httpError) Unwrap() error { return e.Err }

func elasticsearchHTTPError(status int, body []byte) error {
	var parsed struct {
		Error any `json:"error"`
	}
	if err := json.Unmarshal(body, &parsed); err == nil {
		switch value := parsed.Error.(type) {
		case string:
			if value != "" {
				return &httpError{Status: status, Body: string(body), Err: fmt.Errorf("Elasticsearch 请求失败：%s（HTTP %d）", value, status)}
			}
		case map[string]any:
			reason, _ := value["reason"].(string)
			errorType, _ := value["type"].(string)
			if reason != "" {
				return &httpError{Status: status, Body: string(body), Err: fmt.Errorf("Elasticsearch 请求失败：%s（HTTP %d）", reason, status)}
			}
			if errorType != "" {
				return &httpError{Status: status, Body: string(body), Err: fmt.Errorf("Elasticsearch 请求失败：%s（HTTP %d）", errorType, status)}
			}
		}
	}
	return &httpError{Status: status, Body: string(body), Err: fmt.Errorf("Elasticsearch 请求失败（HTTP %d）", status)}
}

func mustJSON(value any) []byte {
	data, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return data
}
