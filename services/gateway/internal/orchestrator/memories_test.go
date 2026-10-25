package orchestrator

import (
	"context"
	"database/sql"
	"fmt"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	protocol "github.com/Alrwx/Cadence/packages/protocol/go"
	"github.com/Alrwx/Cadence/services/gateway/internal/hub"
	"github.com/Alrwx/Cadence/services/gateway/internal/models"
	"github.com/Alrwx/Cadence/services/gateway/internal/store"
)

func (c *client) expectError(code string) {
	c.t.Helper()
	var e protocol.ErrorData
	c.expect(protocol.TypeError, &e, nil)
	if e.Code != code || !e.Recoverable {
		c.t.Fatalf("error = %+v, want recoverable %s", e, code)
	}
}

// hearUtterance has the fake STT deliver fakeUtterance and waits until it is in the session's history.
func hearUtterance(headset, phone *client) {
	phone.sendAudio(make([]byte, 640))
	headset.expectState("SUGGESTING")
}

func TestStoreChatConsentOnOffAndRevokeWipesMemories(t *testing.T) {
	fm := &fakeModels{}
	o := newTestOrchestrator(t, fm)
	srv := httptest.NewServer(hub.New(o))
	t.Cleanup(srv.Close)
	headset := dial(t, srv.URL, "headset")
	phone := dial(t, srv.URL, "phone")
	phone.send(protocol.TypePhoneUnlock, protocol.PhoneUnlockData{})
	phone.expectState("LISTENING")

	var consent protocol.ConsentData
	headset.expect(protocol.TypeConsent, &consent, nil)
	if consent.StoreChat {
		t.Fatal("consent on connect = on before it was ever granted")
	}

	hearUtterance(headset, phone)
	headset.send(protocol.TypeMemorySave, protocol.MemorySaveData{})
	headset.expectError("no_consent")
	if n := len(fm.summarizeRequests()); n != 0 {
		t.Fatalf("%d /summarize calls without consent, want 0", n)
	}

	headset.send(protocol.TypeConsentSet, protocol.ConsentSetData{Kind: store.ConsentStoreChat, Granted: true})
	headset.expect(protocol.TypeConsent, &consent, func() bool { return consent.StoreChat })
	headset.send(protocol.TypeMemorySave, protocol.MemorySaveData{})
	var mems protocol.MemoriesData
	headset.expect(protocol.TypeMemories, &mems, func() bool { return len(mems.Items) == 1 })

	headset.send(protocol.TypeConsentSet, protocol.ConsentSetData{Kind: store.ConsentStoreChat, Granted: false})
	headset.expect(protocol.TypeConsent, &consent, func() bool { return !consent.StoreChat })
	headset.expect(protocol.TypeMemories, &mems, func() bool { return len(mems.Items) == 0 })

	// A reconnecting headset is told the current setting.
	headset.conn.CloseNow()
	headset = dial(t, srv.URL, "headset")
	consent.StoreChat = true
	headset.expect(protocol.TypeConsent, &consent, nil)
	if consent.StoreChat {
		t.Fatal("consent on reconnect = on after revoking")
	}
}

// TestOnlySummariesReachTheDB: "Remember this" summarizes just the last minute, a saved conversation summarizes
// the whole session, and neither writes transcript text anywhere in the database.
func TestOnlySummariesReachTheDB(t *testing.T) {
	fm := &fakeModels{}
	o, headset, phone := pairedSession(t, fm)
	grantStoreChat(t, o)

	headset.send(protocol.TypeMemorySave, protocol.MemorySaveData{})
	headset.expectError("nothing_heard")

	const oldNews = "The pharmacy closes early on Sundays."
	ss := o.session("s1")
	ss.mu.Lock()
	ss.history = append(ss.history, heardTurn{models.Turn{Speaker: "other", Text: oldNews}, time.Now().Add(-2 * time.Minute)})
	ss.mu.Unlock()
	hearUtterance(headset, phone)

	headset.send(protocol.TypeMemorySave, protocol.MemorySaveData{})
	var mems protocol.MemoriesData
	headset.expect(protocol.TypeMemories, &mems, func() bool { return len(mems.Items) == 1 })
	if mems.Items[0].Summary != fakeSummary {
		t.Fatalf("memory = %+v", mems.Items[0])
	}

	headset.send(protocol.TypeConversationSave, protocol.ConversationSaveData{Label: "Dr. Lee – Oct 24"})
	var convs protocol.ConversationsData
	headset.expect(protocol.TypeConversations, &convs, func() bool { return len(convs.Items) == 1 })
	if c := convs.Items[0]; c.Label != "Dr. Lee – Oct 24" || c.Summary != fakeSummary || c.StartedAt == 0 {
		t.Fatalf("conversation = %+v", c)
	}

	reqs := fm.summarizeRequests()
	heard := models.Turn{Speaker: "other", Text: fakeUtterance}
	if len(reqs) != 2 || !reflect.DeepEqual(reqs[0], []models.Turn{heard}) ||
		!reflect.DeepEqual(reqs[1], []models.Turn{{Speaker: "other", Text: oldNews}, heard}) {
		t.Fatalf("/summarize got %+v; want the last minute, then the whole session", reqs)
	}

	o.writer.flush() // turn rows are written off the event path
	for _, transcript := range []string{fakeUtterance, oldNews} {
		if where := tablesContaining(t, o.store.DB, transcript); len(where) > 0 {
			t.Errorf("transcript %q written to %v", transcript, where)
		}
	}
	if where := tablesContaining(t, o.store.DB, fakeSummary); !reflect.DeepEqual(where, []string{"memory", "saved_conversation"}) {
		t.Errorf("summary stored in %v, want memory and saved_conversation", where)
	}

	// Deleting removes the summary.
	headset.send(protocol.TypeMemoryDelete, protocol.MemoryDeleteData{MemoryID: mems.Items[0].ID})
	headset.expect(protocol.TypeMemories, &mems, func() bool { return len(mems.Items) == 0 })
	headset.send(protocol.TypeConversationDelete, protocol.ConversationDeleteData{ConversationID: convs.Items[0].ID})
	headset.expect(protocol.TypeConversations, &convs, func() bool { return len(convs.Items) == 0 })
	if where := tablesContaining(t, o.store.DB, fakeSummary); len(where) > 0 {
		t.Errorf("summary still in %v after deleting", where)
	}
}

// grantStoreChat turns store_chat on directly in the store and returns the consent id.
func grantStoreChat(t *testing.T, o *Orchestrator) string {
	t.Helper()
	ctx := context.Background()
	if err := o.store.SetStoreChat(ctx, o.personID, true); err != nil {
		t.Fatal(err)
	}
	id, err := o.store.StoreChatConsent(ctx, o.personID)
	if err != nil || id == "" {
		t.Fatalf("store_chat consent = %q, %v", id, err)
	}
	return id
}

func TestSavedConversationStartsAfterLastSaveOrLongSilence(t *testing.T) {
	fm := &fakeModels{}
	o, headset, _ := pairedSession(t, fm)
	grantStoreChat(t, o)
	now := time.Now()
	turn := func(text string, ago time.Duration) heardTurn {
		return heardTurn{models.Turn{Speaker: "other", Text: text}, now.Add(-ago)}
	}
	ss := o.session("s1")
	ss.mu.Lock()
	ss.history = []heardTurn{
		turn("Your prescription is ready.", 40*time.Minute),
		turn("I'm Dr. Lee.", 15*time.Minute), // 25 minutes of silence before this: a new conversation
		turn("Take one pill at breakfast.", 14*time.Minute),
	}
	ss.mu.Unlock()

	var convs protocol.ConversationsData
	headset.send(protocol.TypeConversationSave, protocol.ConversationSaveData{Label: "Dr. Lee"})
	headset.expect(protocol.TypeConversations, &convs, func() bool { return len(convs.Items) == 1 })
	if got, want := convs.Items[0].StartedAt, now.Add(-15*time.Minute).UnixMilli(); got != want {
		t.Errorf("startedAt = %d, want %d (the first turn after the silence)", got, want)
	}

	ss.mu.Lock()
	ss.history = append(ss.history, turn("Any questions?", 13*time.Minute))
	ss.mu.Unlock()
	headset.send(protocol.TypeConversationSave, protocol.ConversationSaveData{Label: "Dr. Lee, part 2"})
	headset.expect(protocol.TypeConversations, &convs, func() bool { return len(convs.Items) == 2 })

	reqs := fm.summarizeRequests()
	texts := func(turns []models.Turn) []string {
		var out []string
		for _, t := range turns {
			out = append(out, t.Text)
		}
		return out
	}
	if len(reqs) != 2 || !reflect.DeepEqual(texts(reqs[0]), []string{"I'm Dr. Lee.", "Take one pill at breakfast."}) ||
		!reflect.DeepEqual(texts(reqs[1]), []string{"Any questions?"}) {
		t.Fatalf("/summarize got %+v; want the turns after the silence, then only those after the save", reqs)
	}
}

func TestRepeatedRememberTapsMakeOneMemory(t *testing.T) {
	fm := &fakeModels{summarizeDelay: 200 * time.Millisecond}
	o, headset, phone := pairedSession(t, fm)
	grantStoreChat(t, o)
	hearUtterance(headset, phone)

	headset.send(protocol.TypeMemorySave, protocol.MemorySaveData{})
	headset.send(protocol.TypeMemorySave, protocol.MemorySaveData{})
	var mems protocol.MemoriesData
	headset.expect(protocol.TypeMemories, &mems, func() bool { return len(mems.Items) == 1 })
	if n := len(fm.summarizeRequests()); n != 1 {
		t.Fatalf("%d /summarize calls for two quick taps, want 1", n)
	}

	// Once the summary is in, the next tap works again.
	headset.send(protocol.TypeMemorySave, protocol.MemorySaveData{})
	headset.expect(protocol.TypeMemories, &mems, func() bool { return len(mems.Items) == 2 })
}

// tablesContaining lists the tables with a text value that contains needle, in name order.
func tablesContaining(t *testing.T, db *sql.DB, needle string) []string {
	t.Helper()
	rows, err := db.Query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
	if err != nil {
		t.Fatal(err)
	}
	var tables []string
	for rows.Next() {
		var name string
		_ = rows.Scan(&name)
		tables = append(tables, name)
	}
	rows.Close()

	var found []string
	for _, table := range tables {
		rows, err := db.Query(fmt.Sprintf("SELECT * FROM %q", table))
		if err != nil {
			t.Fatal(err)
		}
		cols, _ := rows.Columns()
		hit := false
		for rows.Next() {
			vals := make([]any, len(cols))
			ptrs := make([]any, len(cols))
			for i := range vals {
				ptrs[i] = &vals[i]
			}
			if err := rows.Scan(ptrs...); err != nil {
				t.Fatal(err)
			}
			for _, v := range vals {
				if s, ok := v.(string); ok && strings.Contains(s, needle) {
					hit = true
				}
			}
		}
		rows.Close()
		if hit {
			found = append(found, table)
		}
	}
	return found
}

func TestMemoriesAndAttachedSummariesReachSuggest(t *testing.T) {
	for _, speculate := range []bool{false, true} {
		t.Run(fmt.Sprintf("speculative=%v", speculate), func(t *testing.T) {
			fm := &fakeModels{}
			var configure []func(*Orchestrator)
			if speculate {
				fm.sttScript = make(chan string)
				configure = append(configure, func(o *Orchestrator) { o.speculateAfter = 20 * time.Millisecond })
			}
			o, headset, phone := pairedSession(t, fm, configure...)
			ctx := context.Background()
			consent := grantStoreChat(t, o)
			related := "Their daughter is visiting today at 5 pm."
			for _, summary := range []string{related, "The TV remote is on the shelf."} {
				if _, err := o.store.AddMemory(ctx, o.personID, consent, summary); err != nil {
					t.Fatal(err)
				}
			}
			lee, err := o.store.SaveConversation(ctx, o.personID, consent, "Dr. Lee", "Started lisinopril for blood pressure.", 1)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := o.store.SaveConversation(ctx, o.personID, consent, "Dentist", "Not attached.", 2); err != nil {
				t.Fatal(err)
			}

			headset.send(protocol.TypeConversationAttach, protocol.ConversationAttachData{ConversationIDs: []string{lee.ID, lee.ID}})
			// compose.start and cancel on the same socket are a barrier: once COMPOSING arrives, the attach was handled.
			headset.send(protocol.TypeComposeStart, protocol.ComposeStartData{})
			headset.expectState("COMPOSING")
			headset.send(protocol.TypeCancel, protocol.CancelData{})
			headset.expectState("LISTENING")

			if speculate {
				// A speculation hit reuses the call made on the partial, so that call has to carry the context too.
				phone.sendAudio(make([]byte, 640))
				fm.sttScript <- sttMsg("partial", strings.TrimSuffix(fakeUtterance, "?"))
				eventually(t, "speculative /suggest call", func() bool { return len(fm.suggestRequests()) == 1 })
				fm.sttScript <- sttMsg("final", fakeUtterance)
				headset.expectState("SUGGESTING")
			} else {
				hearUtterance(headset, phone)
			}
			var sugg protocol.SuggestionsData
			headset.expect(protocol.TypeSuggestions, &sugg, nil)
			reqs := fm.suggestRequests()
			if len(reqs) != 1 {
				t.Fatalf("%d /suggest calls, want 1", len(reqs))
			}
			got := reqs[0]
			if !reflect.DeepEqual(got.Memories, []string{related}) {
				t.Errorf("memories = %q, want only the one that shares a word with %q", got.Memories, fakeUtterance)
			}
			if want := []models.ContextItem{{Label: "Dr. Lee", Summary: "Started lisinopril for blood pressure."}}; !reflect.DeepEqual(got.Context, want) {
				t.Errorf("context = %+v, want %+v (once, though attached twice)", got.Context, want)
			}
			if got.Locale != store.DefaultLocale {
				t.Errorf("locale = %q", got.Locale)
			}
		})
	}
}

func TestRelevantMemories(t *testing.T) {
	mem := func(summaries ...string) []store.Memory { // newest first, as the store returns them
		out := make([]store.Memory, len(summaries))
		for i, s := range summaries {
			out[i] = store.Memory{Summary: s}
		}
		return out
	}
	recent := []models.Turn{{Speaker: "other", Text: "When does the doctor come by?"}, {Speaker: "user", Text: "Is it 3 pm?"}}
	for _, tc := range []struct {
		name string
		mems []store.Memory
		want []string
	}{
		{"best match first", mem("The doctor is late.", "The doctor visits at 3 pm."), []string{"The doctor visits at 3 pm.", "The doctor is late."}},
		{"ties go to the newer", mem("Doctor Kim is new.", "The doctor left."), []string{"Doctor Kim is new.", "The doctor left."}},
		{"stop words don't match", mem("It is what it is."), nil},
		{"at most five", mem("doctor a1", "doctor b2", "doctor c3", "doctor d4", "doctor e5", "doctor f6"),
			[]string{"doctor a1", "doctor b2", "doctor c3", "doctor d4", "doctor e5"}},
	} {
		if got := relevantMemories(tc.mems, recent); !reflect.DeepEqual(got, tc.want) {
			t.Errorf("%s: got %q, want %q", tc.name, got, tc.want)
		}
	}
}
