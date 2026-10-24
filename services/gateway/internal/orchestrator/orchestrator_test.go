package orchestrator

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"

	protocol "github.com/Alrwx/Cadence/packages/protocol/go"
	"github.com/Alrwx/Cadence/services/gateway/internal/clips"
	"github.com/Alrwx/Cadence/services/gateway/internal/hub"
	"github.com/Alrwx/Cadence/services/gateway/internal/models"
	"github.com/Alrwx/Cadence/services/gateway/internal/store"
)

// fakeModels is a model service whose /tts returns a tiny WAV and counts calls.
type fakeModels struct {
	ttsCalls atomic.Int64
	delay    time.Duration
}

func (f *fakeModels) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/tts" {
		http.NotFound(w, r)
		return
	}
	f.ttsCalls.Add(1)
	time.Sleep(f.delay)
	w.Header().Set("Content-Type", "audio/wav")
	_, _ = w.Write([]byte("RIFF-fake-wav"))
}

func newTestOrchestrator(t *testing.T, fm *fakeModels) *Orchestrator {
	t.Helper()
	ctx := context.Background()
	dir := t.TempDir()
	st, err := store.Open(filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	if _, err := st.EnsurePerson(ctx, "p1", "Pat", store.DefaultLocale); err != nil {
		t.Fatal(err)
	}
	cc, err := clips.New(filepath.Join(dir, "clips"))
	if err != nil {
		t.Fatal(err)
	}
	ms := httptest.NewServer(fm)
	t.Cleanup(ms.Close)
	return New(st, models.New(ms.URL), cc, "p1", store.DefaultLocale)
}

// client is one side (headset or phone) of a test session.
type client struct {
	t    *testing.T
	conn *websocket.Conn
}

func dial(t *testing.T, url, role string) *client {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, strings.Replace(url, "http", "ws", 1)+"/ws?session=s1&role="+role, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.CloseNow() })
	return &client{t: t, conn: conn}
}

func (c *client) send(eventType string, data any) {
	c.t.Helper()
	raw, _ := json.Marshal(data)
	frame, _ := json.Marshal(protocol.Envelope{Type: eventType, V: protocol.Version, SessionID: "s1", TS: 1, Data: raw})
	if err := c.conn.Write(context.Background(), websocket.MessageText, frame); err != nil {
		c.t.Fatal(err)
	}
}

// expect reads events until one of eventType satisfies match, decoding it into out.
func (c *client) expect(eventType string, out any, match func() bool) {
	c.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for {
		_, msg, err := c.conn.Read(ctx)
		if err != nil {
			c.t.Fatalf("waiting for %s: %v", eventType, err)
		}
		var env protocol.Envelope
		if err := json.Unmarshal(msg, &env); err != nil || env.Type != eventType {
			continue
		}
		if err := json.Unmarshal(env.Data, out); err != nil {
			c.t.Fatal(err)
		}
		if match == nil || match() {
			return
		}
	}
}

func allReady(p *protocol.PhrasesData) bool {
	for _, g := range p.Groups {
		for _, it := range g.Items {
			if !it.AudioReady {
				return false
			}
		}
	}
	return true
}

func TestSavedPhrasesEndToEnd(t *testing.T) {
	fm := &fakeModels{}
	o := newTestOrchestrator(t, fm)
	srv := httptest.NewServer(hub.New(o))
	t.Cleanup(srv.Close)

	headset := dial(t, srv.URL, "headset")

	// On connect: starter groups right away, then again once warm-up has synthesized every clip.
	var phrases protocol.PhrasesData
	headset.expect(protocol.TypePhrases, &phrases, nil)
	if len(phrases.Groups) != 2 || phrases.Groups[0].Name != "Hospital" || phrases.Groups[1].Name != "Demo" {
		t.Fatalf("starter groups = %+v", phrases.Groups)
	}
	headset.expect(protocol.TypePhrases, &phrases, func() bool { return allReady(&phrases) })
	warmed := fm.ttsCalls.Load()
	if want := int64(len(instantText) + 5); warmed != want {
		t.Fatalf("warm-up made %d TTS calls, want %d (instant + starter phrases)", warmed, want)
	}

	phone := dial(t, srv.URL, "phone")
	phone.send(protocol.TypePhoneUnlock, protocol.PhoneUnlockData{})
	var state protocol.StateData
	phone.expect(protocol.TypeState, &state, func() bool { return state.State == "LISTENING" })

	// Speaking a saved phrase plays its cached clip without another /tts call.
	water := phrases.Groups[0].Items[0]
	headset.send(protocol.TypePhraseSpeak, protocol.PhraseSpeakData{PhraseID: water.ID})
	var play protocol.AudioPlayData
	phone.expect(protocol.TypeAudioPlay, &play, nil)
	if play.Text != "I need some water" || play.Source != "saved" || !strings.HasPrefix(play.URL, "/clips/") {
		t.Fatalf("audio.play = %+v", play)
	}
	if fm.ttsCalls.Load() != warmed {
		t.Fatal("saved phrase was re-synthesized")
	}
	if !o.clips.Has(play.ClipID) {
		t.Fatalf("clip file %s missing", play.ClipID)
	}
	phone.send(protocol.TypeAudioDone, protocol.AudioDoneData{ClipID: play.ClipID})
	phone.expect(protocol.TypeState, &state, func() bool { return state.State == "LISTENING" })

	// Saving a phrase shows it immediately, then marks it ready once its clip exists.
	hospital := phrases.Groups[0].ID
	headset.send(protocol.TypePhraseSave, protocol.PhraseSaveData{Text: "Please close the curtain", GroupID: hospital})
	headset.expect(protocol.TypePhrases, &phrases, func() bool {
		items := phrases.Groups[0].Items
		return len(items) == 5 && items[4].Text == "Please close the curtain" && items[4].AudioReady
	})
	if got := fm.ttsCalls.Load(); got != warmed+1 {
		t.Fatalf("save made %d TTS calls, want 1", got-warmed)
	}

	// Groups: create, then delete it.
	headset.send(protocol.TypePhraseGroupSave, protocol.PhraseGroupSaveData{Name: "Doctor"})
	headset.expect(protocol.TypePhrases, &phrases, func() bool { return len(phrases.Groups) == 3 })
	headset.send(protocol.TypePhraseGroupDelete, protocol.PhraseGroupDeleteData{GroupID: phrases.Groups[2].ID})
	headset.expect(protocol.TypePhrases, &phrases, func() bool { return len(phrases.Groups) == 2 })

	// Unknown ids are reported, not crashes.
	headset.send(protocol.TypePhraseDelete, protocol.PhraseDeleteData{PhraseID: "ph_missing"})
	var errData protocol.ErrorData
	headset.expect(protocol.TypeError, &errData, nil)
	if errData.Code != "not_found" || !errData.Recoverable {
		t.Fatalf("error = %+v", errData)
	}
}

func TestClipForSharesConcurrentSynthesis(t *testing.T) {
	fm := &fakeModels{delay: 100 * time.Millisecond}
	o := newTestOrchestrator(t, fm)

	var wg sync.WaitGroup
	ids := make([]string, 5)
	for i := range ids {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			id, err := o.clipFor(context.Background(), "Can you call my family?", "en")
			if err != nil {
				t.Error(err)
			}
			ids[i] = id
		}(i)
	}
	wg.Wait()
	if n := fm.ttsCalls.Load(); n != 1 {
		t.Fatalf("%d TTS calls for one phrase, want 1", n)
	}
	for _, id := range ids[1:] {
		if id != ids[0] {
			t.Fatalf("callers got different clips: %v", ids)
		}
	}
	// A different locale is a different clip.
	if _, err := o.clipFor(context.Background(), "Can you call my family?", "es"); err != nil {
		t.Fatal(err)
	}
	if n := fm.ttsCalls.Load(); n != 2 {
		t.Fatalf("locale not part of the cache key: %d calls", n)
	}
}
