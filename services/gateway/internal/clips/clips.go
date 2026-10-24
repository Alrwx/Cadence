// Package clips caches synthesized WAV clips on disk and serves them at /clips/{id}.wav.
package clips

import (
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

var validID = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)

type Cache struct {
	Dir string
}

func New(dir string) (*Cache, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("create clips dir: %w", err)
	}
	return &Cache{Dir: dir}, nil
}

func (c *Cache) Put(id string, wav []byte) error {
	if !validID.MatchString(id) {
		return fmt.Errorf("invalid clip id %q", id)
	}
	if err := os.WriteFile(filepath.Join(c.Dir, id+".wav"), wav, 0o644); err != nil {
		return fmt.Errorf("write clip %s: %w", id, err)
	}
	return nil
}

// Has reports whether the clip's file exists (the DB row can outlive a wiped clips directory).
func (c *Cache) Has(id string) bool {
	if !validID.MatchString(id) {
		return false
	}
	_, err := os.Stat(filepath.Join(c.Dir, id+".wav"))
	return err == nil
}

// ServeHTTP handles GET /clips/{id}; the route pattern must name the wildcard "file" (e.g. /clips/{file}).
func (c *Cache) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	file := r.PathValue("file")
	id, ok := strings.CutSuffix(file, ".wav")
	if !ok || !validID.MatchString(id) {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "audio/wav")
	http.ServeFile(w, r, filepath.Join(c.Dir, id+".wav"))
}
