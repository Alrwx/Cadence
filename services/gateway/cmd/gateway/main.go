// Command gateway is the only networked process: it serves the built headset and phone apps,
// the /ws event hub, and /clips, and talks to the model service on localhost.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"time"

	"github.com/Alrwx/Cadence/services/gateway/internal/clips"
	"github.com/Alrwx/Cadence/services/gateway/internal/config"
	"github.com/Alrwx/Cadence/services/gateway/internal/hub"
	"github.com/Alrwx/Cadence/services/gateway/internal/models"
	"github.com/Alrwx/Cadence/services/gateway/internal/orchestrator"
	"github.com/Alrwx/Cadence/services/gateway/internal/store"
)

const defaultPersonID = "person_default"

func main() {
	if err := run(); err != nil {
		slog.Error("gateway stopped", "err", err)
		os.Exit(1)
	}
}

func run() error {
	cfg := config.Load()
	if err := os.MkdirAll(cfg.DataDir, 0o755); err != nil {
		return err
	}
	st, err := store.Open(cfg.DBPath())
	if err != nil {
		return err
	}
	defer st.Close()
	cc, err := clips.New(cfg.ClipsDir())
	if err != nil {
		return err
	}
	mc := models.New(cfg.ModelsURL)

	// Single-user for the hackathon: one person, seeded with the starter phrase groups on first run.
	ctx := context.Background()
	if _, err := st.EnsurePerson(ctx, defaultPersonID, "Default", store.DefaultLocale); err != nil {
		return err
	}
	locale, err := st.PersonLocale(ctx, defaultPersonID)
	if err != nil {
		return err
	}

	h := hub.New(orchestrator.New(st, mc, cc, defaultPersonID, locale))
	h.OriginPatterns = []string{"*:5173", "*:5174"} // Vite dev servers

	mux := http.NewServeMux()
	mux.Handle("GET /ws", h)
	mux.Handle("GET /clips/{file}", cc)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		health, err := mc.Health(r.Context())
		if err != nil {
			http.Error(w, "model service unreachable: "+err.Error(), http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"models":"` + health.Backend + `"}`))
	})
	mux.Handle("GET /headset/", http.StripPrefix("/headset/", http.FileServer(http.Dir(filepath.Join(cfg.WebRoot, "headset", "dist")))))
	mux.Handle("GET /phone/", http.StripPrefix("/phone/", http.FileServer(http.Dir(filepath.Join(cfg.WebRoot, "phone", "dist")))))

	srv := &http.Server{Addr: cfg.Addr, Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdown)
	}()

	// Quest Browser and mobile browsers need HTTPS for WebXR and the mic, so TLS is the normal path.
	if fileExists(cfg.TLSCert) && fileExists(cfg.TLSKey) {
		slog.Info("gateway listening (TLS)", "addr", cfg.Addr, "models", cfg.ModelsURL)
		err = srv.ListenAndServeTLS(cfg.TLSCert, cfg.TLSKey)
	} else {
		slog.Warn("TLS cert not found; serving plain HTTP (WebXR and mic won't work off localhost)", "cert", cfg.TLSCert)
		err = srv.ListenAndServe()
	}
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
