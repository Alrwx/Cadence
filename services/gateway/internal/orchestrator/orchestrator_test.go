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

// fakeModels is a model service: /tts returns a tiny WAV and counts calls, /suggest returns three canned
// replies, and /stt emits one partial and one final after the first audio frame.
type fakeModels struct {
	ttsCalls atomic.Int64
	delay    time.Duration // /tts latency

	suggestDelay time.Duration
	suggestFail  bool
	sttDown      bool
	sttDials     atomic.Int64

	mu          sync.Mutex
	suggestReqs []models.SuggestRequest
}

const fakeUtterance = "How are you feeling today?"

func (f *fakeModels) suggestRequests() []models.SuggestRequest {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]models.SuggestRequest(nil), f.suggestReqs...)
}

func (f *fakeModels) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case "/tts":
		f.ttsCalls.Add(1)
		time.Sleep(f.delay)
		w.Header().Set("Content-Type", "audio/wav")
		_, _ = w.Write([]byte("RIFF-fake-wav"))
	case "/suggest":
		var req models.SuggestRequest
		_ = json.NewDecoder(r.Body).Decode(&req)
		f.mu.Lock()
		f.suggestReqs = append(f.suggestReqs, req)
		f.mu.Unlock()
		time.Sleep(f.suggestDelay)
		if f.suggestFail {
			http.Error(w, "model crashed", http.StatusInternalServerError)
			return
		}
		_ = json.NewEncoder(w).Encode(models.SuggestResponse{TurnID: req.TurnID, Ms: 1, Items: []models.Suggestion{
			{Text: "I'm doing fine, thanks", Kind: "statement"},
			{Text: "Not so great today", Kind: "statement"},
			{Text: "Can you say that again?", Kind: "question"},
		}})
	case "/stt":
		f.sttDials.Add(1)
		if f.sttDown {
			http.Error(w, "loading", http.StatusServiceUnavailable)
			return
		}
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer conn.CloseNow()
		ctx := r.Context()
		sent := false
		for {
			if _, _, err := conn.Read(ctx); err != nil {
				return
			}
			if !sent {
				sent = true
				_ = conn.Write(ctx, websocket.MessageText, []byte(`{"kind":"partial","text":"How are you"}`))
				_ = conn.Write(ctx, websocket.MessageText, []byte(`{"kind":"final","text":"`+fakeUtterance+`"}`))
			}
		}
	default:
		http.NotFound(w, r)
	}
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

// sendAudio sends one binary mic frame (phone only).
func (c *client) sendAudio(frame []byte) {
	c.t.Helper()
	if err := c.conn.Write(context.Background(), websocket.MessageBinary, frame); err != nil {
		c.t.Fatal(err)
	}
}

// expectState reads events until a state event announces want.
func (c *client) expectState(want string) {
	c.t.Helper()
	var st protocol.StateData
	c.expect(protocol.TypeState, &st, func() bool { return st.State == want })
}

// expectStateTurn reads events until a state event announces want, and returns its turnId.
func (c *client) expectStateTurn(want string) string {
	c.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for {
		_, msg, err := c.conn.Read(ctx)
		if err != nil {
			c.t.Fatalf("waiting for state %s: %v", want, err)
		}
		var env protocol.Envelope
		var st protocol.StateData
		if json.Unmarshal(msg, &env) != nil || env.Type != protocol.TypeState || json.Unmarshal(env.Data, &st) != nil {
			continue
		}
		if st.State == want {
			return env.TurnID
		}
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

// TestPhoneClientReconnects plays the phone client the way apps/phone does: hello first on every open,
// phone.unlock and any unsent audio.done re-sent after a reconnect, and one audio.play per spoken utterance.
// Events go over the phone's socket only, so the gateway handles them in order and "next state" is meaningful.
func TestPhoneClientReconnects(t *testing.T) {
	fm := &fakeModels{}
	o := newTestOrchestrator(t, fm)
	srv := httptest.NewServer(hub.New(o))
	t.Cleanup(srv.Close)

	open := func() *client {
		phone := dial(t, srv.URL, "phone")
		phone.send(protocol.TypeHello, protocol.HelloData{Role: "phone", ClientVersion: "0.1.0"})
		return phone
	}
	var state protocol.StateData
	nextState := func(c *client, want string) {
		t.Helper()
		c.expect(protocol.TypeState, &state, nil)
		if state.State != want {
			t.Fatalf("next state = %s, want %s", state.State, want)
		}
	}
	sayYes := func(c *client) protocol.AudioPlayData {
		t.Helper()
		c.send(protocol.TypeInstant, protocol.InstantData{PhraseID: "yes"})
		nextState(c, "SPEAKING")
		var play protocol.AudioPlayData
		c.expect(protocol.TypeAudioPlay, &play, nil)
		c.send(protocol.TypeAudioDone, protocol.AudioDoneData{ClipID: play.ClipID})
		nextState(c, "LISTENING")
		return play
	}

	phone := open()
	nextState(phone, "IDLE")
	phone.send(protocol.TypePhoneUnlock, protocol.PhoneUnlockData{})
	nextState(phone, "LISTENING")
	// A repeated unlock is ignored: the next state change comes from the instant phrase.
	phone.send(protocol.TypePhoneUnlock, protocol.PhoneUnlockData{})

	// Saying "Yes" twice reuses one clip, so the phone must play by event, not by clip id.
	first, second := sayYes(phone), sayYes(phone)
	if first.ClipID != second.ClipID || first.Text != "Yes" || first.Source != "instant" {
		t.Fatalf("audio.play = %+v then %+v, want the same cached clip", first, second)
	}
	if n := fm.ttsCalls.Load(); n != 1 {
		t.Fatalf("%d TTS calls for one phrase, want 1", n)
	}

	// After a reconnect: state on connect, then the re-sent unlock and a stale audio.done change nothing.
	phone.conn.CloseNow()
	phone = open()
	nextState(phone, "LISTENING")
	phone.send(protocol.TypePhoneUnlock, protocol.PhoneUnlockData{})
	phone.send(protocol.TypeAudioDone, protocol.AudioDoneData{ClipID: first.ClipID})
	phone.send(protocol.TypeComposeStart, protocol.ComposeStartData{})
	nextState(phone, "COMPOSING")
	phone.send(protocol.TypeCancel, protocol.CancelData{})
	nextState(phone, "LISTENING")
	sayYes(phone)
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

// pairedSession connects a headset and a phone, unlocks the phone, and waits until the session is LISTENING.
func pairedSession(t *testing.T, fm *fakeModels) (o *Orchestrator, headset, phone *client) {
	t.Helper()
	o = newTestOrchestrator(t, fm)
	srv := httptest.NewServer(hub.New(o))
	t.Cleanup(srv.Close)
	headset = dial(t, srv.URL, "headset")
	phone = dial(t, srv.URL, "phone")
	phone.send(protocol.TypePhoneUnlock, protocol.PhoneUnlockData{})
	phone.expectState("LISTENING")
	return o, headset, phone
}

func TestSuggestionPipelineEndToEnd(t *testing.T) {
	fm := &fakeModels{}
	o, headset, phone := pairedSession(t, fm)

	phone.sendAudio(make([]byte, 640))

	var partial protocol.TranscriptPartialData
	headset.expect(protocol.TypeTranscriptPartial, &partial, nil)
	var final protocol.TranscriptFinalData
	headset.expect(protocol.TypeTranscriptFinal, &final, nil)
	if final.Text != fakeUtterance || final.Speaker != "other" {
		t.Fatalf("transcript.final = %+v", final)
	}
	headset.expectState("SUGGESTING")
	var sugg protocol.SuggestionsData
	headset.expect(protocol.TypeSuggestions, &sugg, nil)
	if len(sugg.Items) != 3 || sugg.Items[0].ID != "s_t_1_0" || sugg.Items[2].Kind != "question" {
		t.Fatalf("suggestions = %+v", sugg.Items)
	}
	headset.expectState("CHOOSING")

	reqs := fm.suggestRequests()
	if len(reqs) != 1 || reqs[0].TurnID != "t_1" || len(reqs[0].History) != 1 ||
		reqs[0].History[0] != (models.Turn{Speaker: "other", Text: fakeUtterance}) {
		t.Fatalf("/suggest requests = %+v", reqs)
	}

	// Every suggestion is synthesized ahead of time and announced.
	ready := map[string]bool{}
	for len(ready) < len(sugg.Items) {
		var ar protocol.SuggestionAudioReadyData
		headset.expect(protocol.TypeSuggestionAudioReady, &ar, nil)
		ready[ar.ID] = true
	}

	// Picking one plays the clip that was already made.
	pick := sugg.Items[1]
	cached, ok, err := o.store.ClipID(context.Background(), o.voiceID, o.locale, pick.Text)
	if err != nil || !ok {
		t.Fatalf("no cached clip for %q: ok=%v err=%v", pick.Text, ok, err)
	}
	headset.send(protocol.TypeSelect, protocol.SelectData{SuggestionID: pick.ID})
	var play protocol.AudioPlayData
	phone.expect(protocol.TypeAudioPlay, &play, nil)
	if play.Text != pick.Text || play.Source != "suggestion" || play.ClipID != cached {
		t.Fatalf("audio.play = %+v, want text %q clip %s", play, pick.Text, cached)
	}

	// What the user said joins the history for the next turn.
	o.session("s1").mu.Lock()
	defer o.session("s1").mu.Unlock()
	h := o.session("s1").history
	if len(h) != 2 || h[1] != (models.Turn{Speaker: "user", Text: pick.Text}) {
		t.Fatalf("history = %+v", h)
	}
}

// A phone that reconnects mid-turn (and re-sends phone.unlock, as apps/phone does) must not end the turn or
// reopen the speech stream; state events carry the new turnId so clients drop the previous turn's suggestions.
func TestPhoneReconnectKeepsTheTurn(t *testing.T) {
	fm := &fakeModels{}
	o := newTestOrchestrator(t, fm)
	srv := httptest.NewServer(hub.New(o))
	t.Cleanup(srv.Close)
	headset := dial(t, srv.URL, "headset")
	phone := dial(t, srv.URL, "phone")
	phone.send(protocol.TypePhoneUnlock, protocol.PhoneUnlockData{})
	phone.expectState("LISTENING")

	phone.sendAudio(make([]byte, 640))
	if turn := headset.expectStateTurn("SUGGESTING"); turn != "t_1" {
		t.Fatalf("SUGGESTING turnId = %q, want t_1", turn)
	}
	var sugg protocol.SuggestionsData
	headset.expect(protocol.TypeSuggestions, &sugg, nil)
	if turn := headset.expectStateTurn("CHOOSING"); turn != "t_1" {
		t.Fatalf("CHOOSING turnId = %q, want t_1", turn)
	}

	phone.conn.CloseNow()
	phone = dial(t, srv.URL, "phone")
	phone.send(protocol.TypeHello, protocol.HelloData{Role: "phone", ClientVersion: "0.1.0"})
	if turn := phone.expectStateTurn("CHOOSING"); turn != "t_1" {
		t.Fatalf("state on reconnect has turnId %q, want t_1", turn)
	}
	phone.send(protocol.TypePhoneUnlock, protocol.PhoneUnlockData{})

	// The suggestion is still live and plays on the new phone socket.
	headset.send(protocol.TypeSelect, protocol.SelectData{SuggestionID: sugg.Items[0].ID})
	var play protocol.AudioPlayData
	phone.expect(protocol.TypeAudioPlay, &play, nil)
	if play.Text != sugg.Items[0].Text {
		t.Fatalf("audio.play = %+v, want %q", play, sugg.Items[0].Text)
	}
	phone.send(protocol.TypeAudioDone, protocol.AudioDoneData{ClipID: play.ClipID})
	phone.expectState("LISTENING")

	// More audio reuses the open stream. compose.start is a barrier (see TestSTTDownKeepsInstantPhrasesWorking).
	phone.sendAudio(make([]byte, 640))
	phone.send(protocol.TypeComposeStart, protocol.ComposeStartData{})
	phone.expectState("COMPOSING")
	if n := fm.sttDials.Load(); n != 1 {
		t.Fatalf("%d /stt dials, want 1: the reconnect reopened the speech stream", n)
	}
}

func TestStaleSuggestionsAreDropped(t *testing.T) {
	fm := &fakeModels{suggestDelay: 400 * time.Millisecond}
	o, headset, phone := pairedSession(t, fm)

	phone.sendAudio(make([]byte, 640))
	headset.expectState("SUGGESTING")
	headset.send(protocol.TypeCancel, protocol.CancelData{})
	headset.expectState("LISTENING")

	// The slow /suggest answer arrives after the user backed out and must not bring the turn back.
	time.Sleep(900 * time.Millisecond)
	ss := o.session("s1")
	ss.mu.Lock()
	state, left := ss.machine.State(), len(ss.suggestions)
	ss.mu.Unlock()
	if state != "LISTENING" || left != 0 {
		t.Fatalf("state = %s with %d suggestions after cancel, want LISTENING with none", state, left)
	}

	headset.send(protocol.TypeSelect, protocol.SelectData{SuggestionID: "s_t_1_0"})
	var errData protocol.ErrorData
	headset.expect(protocol.TypeError, &errData, nil)
	if errData.Code != "stale_suggestion" {
		t.Fatalf("error = %+v", errData)
	}
}

func TestSuggestFailureKeepsInstantPhrasesWorking(t *testing.T) {
	fm := &fakeModels{suggestFail: true}
	_, headset, phone := pairedSession(t, fm)

	phone.sendAudio(make([]byte, 640))
	var errData protocol.ErrorData
	headset.expect(protocol.TypeError, &errData, nil)
	if errData.Code != "suggest_failed" || !errData.Recoverable {
		t.Fatalf("error = %+v", errData)
	}
	headset.expectState("LISTENING")

	headset.send(protocol.TypeInstant, protocol.InstantData{PhraseID: "yes"})
	var play protocol.AudioPlayData
	phone.expect(protocol.TypeAudioPlay, &play, nil)
	if play.Text != "Yes" || play.Source != "instant" {
		t.Fatalf("audio.play = %+v", play)
	}
}

func TestSTTDownKeepsInstantPhrasesWorking(t *testing.T) {
	fm := &fakeModels{sttDown: true}
	_, headset, phone := pairedSession(t, fm)

	phone.sendAudio(make([]byte, 640))
	var errData protocol.ErrorData
	headset.expect(protocol.TypeError, &errData, nil)
	if errData.Code != "stt_failed" || !errData.Recoverable {
		t.Fatalf("error = %+v", errData)
	}

	// More frames inside the retry window don't redial. compose.start from the phone is a barrier: the hub
	// handles one connection's messages in order, so seeing COMPOSING means the frames were processed.
	phone.sendAudio(make([]byte, 640))
	phone.sendAudio(make([]byte, 640))
	phone.send(protocol.TypeComposeStart, protocol.ComposeStartData{})
	phone.expectState("COMPOSING")
	if n := fm.sttDials.Load(); n != 1 {
		t.Fatalf("%d /stt dials inside the retry window, want 1", n)
	}

	headset.send(protocol.TypeInstant, protocol.InstantData{PhraseID: "yes"})
	var play protocol.AudioPlayData
	phone.expect(protocol.TypeAudioPlay, &play, nil)
	if play.Text != "Yes" {
		t.Fatalf("audio.play = %+v", play)
	}
}
