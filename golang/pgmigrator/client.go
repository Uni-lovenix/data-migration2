package main

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type pgClient struct {
	pool *pgxpool.Pool
}

func newPGClient(dsn string) (*pgClient, error) {
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		return nil, fmt.Errorf("failed to create connection pool: %w", err)
	}
	if err := pool.Ping(context.Background()); err != nil {
		pool.Close()
		return nil, fmt.Errorf("failed to ping database: %w", err)
	}
	return &pgClient{pool: pool}, nil
}

func (c *pgClient) close() {
	c.pool.Close()
}

func (c *pgClient) queryRow(ctx context.Context, sql string, args ...any) any {
	row := c.pool.QueryRow(ctx, sql, args...)
	var val any
	if err := row.Scan(&val); err != nil {
		return nil
	}
	return val
}

func (c *pgClient) begin(ctx context.Context) (pgx.Tx, error) {
	return c.pool.Begin(ctx)
}
