// Package store reads and writes the order tables.
package store

import (
	"context"
	"database/sql"
)

// Orders is every order the shop has taken.
type Orders struct {
	db *sql.DB
}

// New opens the order store over an existing connection.
func New(db *sql.DB) *Orders {
	return &Orders{db: db}
}

// All returns every order, newest first.
func (o *Orders) All(ctx context.Context) ([]string, error) {
	rows, err := o.db.QueryContext(ctx, "SELECT id FROM orders ORDER BY created_at DESC")
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// Insert records one order.
func (o *Orders) Insert(ctx context.Context, status string) error {
	_, err := o.db.ExecContext(ctx, "INSERT INTO orders (status) VALUES ($1)", status)
	return err
}

// Delete removes one order.
func (o *Orders) Delete(ctx context.Context, id string) error {
	_, err := o.db.ExecContext(ctx, "DELETE FROM orders WHERE id = $1", id)
	return err
}
