package orchestrator

import (
	"context"
	"database/sql"
	"testing"
	"time"

	protocol "github.com/Alrwx/Cadence/packages/protocol/go"
	"github.com/Alrwx/Cadence/services/gateway/internal/store"
)

// metricDetails returns the details recorded for a metric name, in order, and whether each had a value.
func metricDetails(t *testing.T, o *Orchestrator, name string) (details []string, valued []bool) {
	t.Helper()
	rows, err := o.store.DB.Query(`SELECT COALESCE(detail, ''), value_ms IS NOT NULL FROM metric WHERE name = ? AND session_id = 's1' ORDER BY id`, name)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	for rows.Next() {
		var d string
		var v bool
		if err := rows.Scan(&d, &v); err != nil {
			t.Fatal(err)
		}
		details, valued = append(details, d), append(valued, v)
	}
	return details, valued
}

// TestTurnAndSelectionAreMeasured runs one turn and one selection, then checks the metric rows, the session
// row, and that turn text is stored only with store_chat consent.
func TestTurnAndSelectionAreMeasured(t *testing.T) {
	for _, storeChat := range []bool{false, true} {
		name := "without store_chat"
		if storeChat {
			name = "with store_chat"
		}
		t.Run(name, func(t *testing.T) {
			fm := &fakeModels{}
			o, headset, phone := pairedSession(t, fm)
			if storeChat {
				if _, err := o.store.CreateConsent(context.Background(), "p1", store.ConsentStoreChat, "", ""); err != nil {
					t.Fatal(err)
				}
			}

			phone.sendAudio(make([]byte, 640))
			var sugg protocol.SuggestionsData
			headset.expect(protocol.TypeSuggestions, &sugg, nil)
			for ready := map[string]bool{}; len(ready) < len(sugg.Items); {
				var ar protocol.SuggestionAudioReadyData
				headset.expect(protocol.TypeSuggestionAudioReady, &ar, nil)
				ready[ar.ID] = true
			}
			pick := sugg.Items[0]
			headset.send(protocol.TypeSelect, protocol.SelectData{SuggestionID: pick.ID})
			var play protocol.AudioPlayData
			phone.expect(protocol.TypeAudioPlay, &play, nil)
			o.writer.flush()

			for _, tc := range []struct {
				metric string
				want   []string
				valued bool
			}{
				{metricSuggest, []string{"ok"}, true},
				{metricFinalToSuggestions, []string{""}, true},
				{metricSelection, []string{"suggestion"}, false},
				{metricSelectToPlay, []string{"suggestion:cached"}, true}, // synthesized ahead of time
			} {
				got, valued := metricDetails(t, o, tc.metric)
				if len(got) != len(tc.want) || got[0] != tc.want[0] || valued[0] != tc.valued {
					t.Errorf("%s details = %v (valued %v), want %v (valued %v)", tc.metric, got, valued, tc.want, tc.valued)
				}
			}
			if got, _ := metricDetails(t, o, metricTTS); len(got) != 3 || got[0] != "suggestion" {
				t.Errorf("tts details = %v, want 3 x suggestion", got)
			}

			// No metric row carries text.
			var leaked int
			if err := o.store.DB.QueryRow(`SELECT COUNT(*) FROM metric WHERE detail LIKE ? OR detail LIKE ?`,
				"%"+fakeUtterance+"%", "%"+pick.Text+"%").Scan(&leaked); err != nil || leaked != 0 {
				t.Errorf("metric rows with conversation text = %d (err %v)", leaked, err)
			}

			var started int64
			var ended sql.NullInt64
			if err := o.store.DB.QueryRow(`SELECT started_at, ended_at FROM session WHERE id = 's1'`).Scan(&started, &ended); err != nil || started == 0 || ended.Valid {
				t.Errorf("session row = %d..%v, err %v", started, ended, err)
			}

			rows, err := o.store.DB.Query(`SELECT speaker, text FROM turn WHERE session_id = 's1' ORDER BY ts, rowid`)
			if err != nil {
				t.Fatal(err)
			}
			defer rows.Close()
			var turns []string
			for rows.Next() {
				var speaker string
				var text sql.NullString
				if err := rows.Scan(&speaker, &text); err != nil {
					t.Fatal(err)
				}
				if text.Valid != storeChat {
					t.Errorf("%s turn text = %+v with store_chat=%v", speaker, text, storeChat)
				}
				turns = append(turns, speaker+":"+text.String)
			}
			want := []string{"other:", "user:"}
			if storeChat {
				want = []string{"other:" + fakeUtterance, "user:" + pick.Text}
			}
			if len(turns) != 2 || turns[0] != want[0] || turns[1] != want[1] {
				t.Errorf("turns = %q, want %q", turns, want)
			}
		})
	}
}

// When both sockets close, the session row gets ended_at.
func TestSessionEndsWhenBothClientsLeave(t *testing.T) {
	o, headset, phone := pairedSession(t, &fakeModels{})
	headset.conn.CloseNow()
	phone.conn.CloseNow()
	eventually(t, "session ended_at set after both clients disconnected", func() bool {
		o.writer.flush()
		var ended sql.NullInt64
		if err := o.store.DB.QueryRow(`SELECT ended_at FROM session WHERE id = 's1'`).Scan(&ended); err != nil {
			t.Fatal(err)
		}
		return ended.Valid
	})
}

// eventually polls cond every few milliseconds until it holds, failing the test after 5 s.
func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for: %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}
