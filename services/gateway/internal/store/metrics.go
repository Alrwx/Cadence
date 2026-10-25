package store

import (
	"context"
	"database/sql"
	"fmt"
	"sort"
)

// Metric is one latency or count measurement (§2: metrics only, never conversation content).
// ValueMs < 0 means "no value" (a count, such as which kind of reply was picked) and is stored as NULL.
type Metric struct {
	SessionID string
	Name      string
	ValueMs   int64
	Detail    string
	TS        int64
}

// AddMetric stores one metric row.
func (s *Store) AddMetric(ctx context.Context, m Metric) error {
	var value sql.NullInt64
	if m.ValueMs >= 0 {
		value = sql.NullInt64{Int64: m.ValueMs, Valid: true}
	}
	var session, detail sql.NullString
	if m.SessionID != "" {
		session = sql.NullString{String: m.SessionID, Valid: true}
	}
	if m.Detail != "" {
		detail = sql.NullString{String: m.Detail, Valid: true}
	}
	if _, err := s.DB.ExecContext(ctx,
		`INSERT INTO metric (session_id, name, value_ms, detail, ts) VALUES (?, ?, ?, ?, ?)`,
		session, m.Name, value, detail, m.TS); err != nil {
		return fmt.Errorf("add metric %s: %w", m.Name, err)
	}
	return nil
}

// MetricStat summarizes one metric name, or one (name, detail) pair. Detail "*" is every row of the name.
// P50/P95/Max are nil for count-only metrics.
type MetricStat struct {
	Name   string `json:"name"`
	Detail string `json:"detail"`
	Count  int    `json:"count"`
	P50    *int64 `json:"p50Ms,omitempty"`
	P95    *int64 `json:"p95Ms,omitempty"`
	Max    *int64 `json:"maxMs,omitempty"`
}

// MetricSummary returns count, p50, p95 and max per metric name and per (name, detail), for rows with
// ts >= since (0 for all). Percentiles are nearest-rank.
func (s *Store) MetricSummary(ctx context.Context, since int64) ([]MetricStat, error) {
	rows, err := s.DB.QueryContext(ctx,
		`SELECT name, COALESCE(detail, ''), value_ms FROM metric WHERE ts >= ? ORDER BY name, detail`, since)
	if err != nil {
		return nil, fmt.Errorf("metric summary: %w", err)
	}
	defer rows.Close()

	type group struct {
		count  int
		values []int64
	}
	groups := map[[2]string]*group{}
	add := func(key [2]string, v sql.NullInt64) {
		g := groups[key]
		if g == nil {
			g = &group{}
			groups[key] = g
		}
		g.count++
		if v.Valid {
			g.values = append(g.values, v.Int64)
		}
	}
	for rows.Next() {
		var name, detail string
		var v sql.NullInt64
		if err := rows.Scan(&name, &detail, &v); err != nil {
			return nil, fmt.Errorf("metric summary: %w", err)
		}
		add([2]string{name, "*"}, v)
		add([2]string{name, detail}, v)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("metric summary: %w", err)
	}

	out := make([]MetricStat, 0, len(groups))
	for key, g := range groups {
		st := MetricStat{Name: key[0], Detail: key[1], Count: g.count}
		if n := len(g.values); n > 0 {
			sort.Slice(g.values, func(i, j int) bool { return g.values[i] < g.values[j] })
			st.P50, st.P95, st.Max = rank(g.values, 50), rank(g.values, 95), &g.values[n-1]
		}
		out = append(out, st)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Name != out[j].Name {
			return out[i].Name < out[j].Name
		}
		if (out[i].Detail == "*") != (out[j].Detail == "*") {
			return out[i].Detail == "*"
		}
		return out[i].Detail < out[j].Detail
	})
	return out, nil
}

// rank is the nearest-rank percentile p of sorted values.
func rank(sorted []int64, p int) *int64 {
	i := (p*len(sorted) + 99) / 100 // ceil(p/100 * n)
	if i < 1 {
		i = 1
	}
	v := sorted[i-1]
	return &v
}
