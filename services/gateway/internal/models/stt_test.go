package models

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestSTTURL(t *testing.T) {
	tests := []struct {
		base, locale, want string
		wantErr            bool
	}{
		{"http://127.0.0.1:8000", "en", "ws://127.0.0.1:8000/stt?locale=en", false},
		{"https://models.local:8000/", "es", "wss://models.local:8000/stt?locale=es", false},
		{"ftp://127.0.0.1", "en", "", true},
	}
	for _, tt := range tests {
		got, err := sttURL(tt.base, tt.locale)
		if (err != nil) != tt.wantErr || got != tt.want {
			t.Errorf("sttURL(%q, %q) = %q, %v; want %q (err %v)", tt.base, tt.locale, got, err, tt.want, tt.wantErr)
		}
	}
}

func TestOpenSTTRoundTrip(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/stt" || r.URL.Query().Get("locale") != "en" {
			http.NotFound(w, r)
			return
		}
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer conn.CloseNow()
		ctx := r.Context()
		if _, _, err := conn.Read(ctx); err != nil { // one audio frame in...
			return
		}
		_ = conn.Write(ctx, websocket.MessageText, []byte(`{"kind":"partial","text":"How are"}`))
		_ = conn.Write(ctx, websocket.MessageText, []byte(`{"kind":"final","text":"How are you?"}`))
		_ = conn.Close(websocket.StatusNormalClosure, "")
	}))
	t.Cleanup(srv.Close)

	stream, err := New(srv.URL).OpenSTT(context.Background(), "en")
	if err != nil {
		t.Fatal(err)
	}
	defer stream.Close()
	if err := stream.Send(make([]byte, 640)); err != nil {
		t.Fatal(err)
	}

	want := []STTEvent{{"partial", "How are"}, {"final", "How are you?"}}
	for _, w := range want {
		select {
		case got, ok := <-stream.Events():
			if !ok || got != w {
				t.Fatalf("got %+v (open=%v), want %+v", got, ok, w)
			}
		case <-time.After(3 * time.Second):
			t.Fatalf("timed out waiting for %+v", w)
		}
	}
	select {
	case _, ok := <-stream.Events():
		if ok {
			t.Fatal("expected events to close after the server hung up")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("events not closed after the server hung up")
	}
}

func TestOpenSTTUnreachable(t *testing.T) {
	srv := httptest.NewServer(http.NotFoundHandler())
	url := srv.URL
	srv.Close()
	if _, err := New(url).OpenSTT(context.Background(), "en"); err == nil {
		t.Fatal("expected a dial error")
	}
}
