package main

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"

	"github.com/Alrwx/Cadence/services/gateway/internal/store"
)

// metricsSummary serves GET /api/metrics/summary[?since=<unix ms>]: count, p50, p95 and max per metric name
// and per (name, detail), for docs/latency.md. Metric rows hold latencies and selection types only, never
// conversation content (§2), so this exposes nothing said in a conversation.
func metricsSummary(st *store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var since int64
		if v := r.URL.Query().Get("since"); v != "" {
			n, err := strconv.ParseInt(v, 10, 64)
			if err != nil {
				http.Error(w, "since must be unix milliseconds", http.StatusBadRequest)
				return
			}
			since = n
		}
		stats, err := st.MetricSummary(r.Context(), since)
		if err != nil {
			slog.Error("metrics summary", "err", err)
			http.Error(w, "couldn't read metrics", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"metrics": stats})
	}
}
