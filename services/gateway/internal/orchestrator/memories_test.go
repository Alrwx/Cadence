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
	if left, _ := o.store.Memories(context.Background(), o.personID); len(left) != 0 {
		t.Fatalf("%d memories stored after revoking store_chat", len(left))
	}

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
	ctx := context.Background()
	if err := o.store.SetStoreChat(ctx, o.personID, true); err != nil {
		t.Fatal(err)
	}

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
	fm := &fakeModels{}
	o, headset, phone := pairedSession(t, fm)
	ctx := context.Background()
	if err := o.store.SetStoreChat(ctx, o.personID, true); err != nil {
		t.Fatal(err)
	}
	related := "Their daughter is visiting today at 5 pm."
	for _, summary := range []string{related, "The TV remote is on the shelf."} {
		if _, err := o.store.AddMemory(ctx, o.personID, summary); err != nil {
			t.Fatal(err)
		}
	}
	lee, err := o.store.SaveConversation(ctx, o.personID, "Dr. Lee", "Started lisinopril for blood pressure.", 1)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := o.store.SaveConversation(ctx, o.personID, "Dentist", "Not attached.", 2); err != nil {
		t.Fatal(err)
	}

	headset.send(protocol.TypeConversationAttach, protocol.ConversationAttachData{ConversationIDs: []string{lee.ID}})
	// compose.start and cancel on the same socket are a barrier: once COMPOSING arrives, the attach was handled.
	headset.send(protocol.TypeComposeStart, protocol.ComposeStartData{})
	headset.expectState("COMPOSING")
	headset.send(protocol.TypeCancel, protocol.CancelData{})
	headset.expectState("LISTENING")

	hearUtterance(headset, phone)
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
		t.Errorf("context = %+v, want %+v", got.Context, want)
	}
	if got.Locale != store.DefaultLocale {
		t.Errorf("locale = %q", got.Locale)
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
