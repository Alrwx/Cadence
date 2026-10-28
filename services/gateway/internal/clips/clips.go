// Package clips caches synthesized WAV clips on disk and serves them at /clips/{id}.wav.
package clips

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
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

// Remove deletes a clip's file. A file that's already gone is not an error.
func (c *Cache) Remove(id string) error {
	if !validID.MatchString(id) {
		return fmt.Errorf("invalid clip id %q", id)
	}
	if err := os.Remove(filepath.Join(c.Dir, id+".wav")); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("remove clip %s: %w", id, err)
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

// Duration is how long the clip plays, read from its WAV header: the "fmt " chunk's byte rate and the "data"
// chunk's size. ok is false if the file is missing or isn't a WAV it can read.
func (c *Cache) Duration(id string) (d time.Duration, ok bool) {
	if !validID.MatchString(id) {
		return 0, false
	}
	f, err := os.Open(filepath.Join(c.Dir, id+".wav"))
	if err != nil {
		return 0, false
	}
	defer f.Close()
	var riff [12]byte
	if _, err := io.ReadFull(f, riff[:]); err != nil || string(riff[:4]) != "RIFF" || string(riff[8:]) != "WAVE" {
		return 0, false
	}
	var byteRate uint32
	for {
		var chunk [8]byte
		if _, err := io.ReadFull(f, chunk[:]); err != nil {
			return 0, false
		}
		size := int64(binary.LittleEndian.Uint32(chunk[4:]))
		skip := size + size&1 // chunks are padded to an even length
		switch string(chunk[:4]) {
		case "fmt ":
			var format [16]byte
			if size < 16 {
				return 0, false
			}
			if _, err := io.ReadFull(f, format[:]); err != nil {
				return 0, false
			}
			byteRate = binary.LittleEndian.Uint32(format[8:12])
			skip -= 16
		case "data":
			if byteRate == 0 {
				return 0, false
			}
			return time.Duration(size) * time.Second / time.Duration(byteRate), true
		}
		if _, err := f.Seek(skip, io.SeekCurrent); err != nil {
			return 0, false
		}
	}
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
