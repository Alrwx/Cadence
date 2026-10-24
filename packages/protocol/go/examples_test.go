package protocol

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// Contract test: every example in ../examples decodes into its generated struct with no unknown fields.
func TestExamplesDecode(t *testing.T) {
	files, err := filepath.Glob(filepath.Join("..", "examples", "*.json"))
	if err != nil || len(files) == 0 {
		t.Fatalf("no examples found: %v", err)
	}
	for _, file := range files {
		t.Run(filepath.Base(file), func(t *testing.T) {
			raw, err := os.ReadFile(file)
			if err != nil {
				t.Fatal(err)
			}
			var env Envelope
			if err := strictDecode(raw, &env); err != nil {
				t.Fatalf("envelope: %v", err)
			}
			if env.V != Version {
				t.Fatalf("v = %d, want %d", env.V, Version)
			}
			data, ok := NewData(env.Type)
			if !ok {
				t.Fatalf("unknown event type %q", env.Type)
			}
			if err := strictDecode(env.Data, data); err != nil {
				t.Fatalf("data: %v", err)
			}
		})
	}
}

func strictDecode(raw []byte, v any) error {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	return dec.Decode(v)
}
