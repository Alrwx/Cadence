package orchestrator

import (
	"context"
	"errors"
	"log/slog"
	"sort"
	"strings"
	"time"
	"unicode"

	protocol "github.com/Alrwx/Cadence/packages/protocol/go"
	"github.com/Alrwx/Cadence/services/gateway/internal/hub"
	"github.com/Alrwx/Cadence/services/gateway/internal/models"
	"github.com/Alrwx/Cadence/services/gateway/internal/store"
)

const (
	memoryWindow = 60 * time.Second // "Remember this" summarizes this much of the conversation
	memoriesSent = 5                // at most this many memories go to /suggest
	keywordTurns = 3                // memories must share a content word with this many recent turns
)

// onMemoryEvent handles consent.set, memory.save/delete and conversation.save/delete/attach. Only AI summaries
// are stored, and only with store_chat consent; the transcript they come from stays in ss.history.
func (o *Orchestrator) onMemoryEvent(ctx context.Context, s *hub.Session, ss *sessionState, data any) {
	switch d := data.(type) {
	case *protocol.ConsentSetData:
		if d.Kind != store.ConsentStoreChat {
			slog.Warn("consent.set ignored", "session", s.ID, "kind", d.Kind)
			return
		}
		if err := o.store.SetStoreChat(ctx, o.personID, d.Granted); err != nil {
			o.memoryError(ctx, s, err)
			return
		}
		o.sendConsent(ctx, s)
		if !d.Granted {
			o.sendMemories(ctx, s)
			o.sendConversations(ctx, s)
		}
	case *protocol.MemorySaveData:
		o.summarizeAndStore(ctx, s, ss, time.Now().Add(-memoryWindow), "Nothing to remember from the last minute.",
			func(ctx context.Context, summary string, _ time.Time) error {
				if _, err := o.store.AddMemory(ctx, o.personID, summary); err != nil {
					return err
				}
				o.sendMemories(ctx, s)
				return nil
			})
	case *protocol.MemoryDeleteData:
		if err := o.store.DeleteMemory(ctx, o.personID, d.MemoryID); err != nil {
			o.memoryError(ctx, s, err)
		}
		o.sendMemories(ctx, s)
	case *protocol.ConversationSaveData:
		o.summarizeAndStore(ctx, s, ss, time.Time{}, "Nothing to save from this conversation yet.",
			func(ctx context.Context, summary string, startedAt time.Time) error {
				if _, err := o.store.SaveConversation(ctx, o.personID, d.Label, summary, startedAt.UnixMilli()); err != nil {
					return err
				}
				o.sendConversations(ctx, s)
				return nil
			})
	case *protocol.ConversationDeleteData:
		if err := o.store.DeleteConversation(ctx, o.personID, d.ConversationID); err != nil {
			o.memoryError(ctx, s, err)
		}
		o.sendConversations(ctx, s)
	case *protocol.ConversationAttachData:
		ss.mu.Lock()
		ss.attached = append([]string(nil), d.ConversationIDs...)
		ss.mu.Unlock()
	}
}

// summarizeAndStore summarizes the turns said since `since` in the background, then hands the summary to save.
// It fails fast without store_chat consent or with nothing heard; save re-checks consent as it inserts.
func (o *Orchestrator) summarizeAndStore(ctx context.Context, s *hub.Session, ss *sessionState, since time.Time,
	nothingHeard string, save func(ctx context.Context, summary string, startedAt time.Time) error) {
	if granted, err := o.store.StoreChat(ctx, o.personID); err != nil {
		o.memoryError(ctx, s, err)
		return
	} else if !granted {
		o.memoryError(ctx, s, store.ErrNoConsent)
		return
	}
	heard := ss.turnsSince(since)
	if len(heard) == 0 {
		_ = s.Send(ctx, hub.Headset, protocol.TypeError, "", protocol.ErrorData{Code: "nothing_heard", Message: nothingHeard, Recoverable: true})
		return
	}
	turns := make([]models.Turn, len(heard))
	for i, t := range heard {
		turns[i] = t.Turn
	}
	go func() {
		ctx := context.Background()
		summary, err := o.models.Summarize(ctx, turns, o.locale)
		if err == nil && strings.TrimSpace(summary) == "" {
			err = errors.New("empty summary")
		}
		if err != nil {
			slog.Error("summarize", "session", s.ID, "err", err)
			o.sendError(ctx, s, "summarize_failed", "Couldn't summarize that. Try again in a moment.")
			return
		}
		if err := save(ctx, summary, heard[0].At); err != nil {
			o.memoryError(ctx, s, err)
		}
	}()
}

func (o *Orchestrator) sendConsent(ctx context.Context, s *hub.Session) {
	granted, err := o.store.StoreChat(ctx, o.personID)
	if err != nil {
		slog.Error("load consent", "session", s.ID, "err", err)
		return // the headset assumes off and asks again
	}
	_ = s.Send(ctx, hub.Headset, protocol.TypeConsent, "", protocol.ConsentData{StoreChat: granted})
}

func (o *Orchestrator) sendMemories(ctx context.Context, s *hub.Session) {
	mems, err := o.store.Memories(ctx, o.personID)
	if err != nil {
		slog.Error("load memories", "session", s.ID, "err", err)
		o.sendError(ctx, s, "storage_failed", "Couldn't load memories.")
		return
	}
	items := make([]protocol.MemoriesItem, len(mems))
	for i, m := range mems {
		items[i] = protocol.MemoriesItem{ID: m.ID, Summary: m.Summary, CreatedAt: m.CreatedAt}
	}
	_ = s.Send(ctx, hub.Headset, protocol.TypeMemories, "", protocol.MemoriesData{Items: items})
}

func (o *Orchestrator) sendConversations(ctx context.Context, s *hub.Session) {
	convs, err := o.store.Conversations(ctx, o.personID)
	if err != nil {
		slog.Error("load saved conversations", "session", s.ID, "err", err)
		o.sendError(ctx, s, "storage_failed", "Couldn't load saved conversations.")
		return
	}
	items := make([]protocol.ConversationsItem, len(convs))
	for i, c := range convs {
		items[i] = protocol.ConversationsItem{ID: c.ID, Label: c.Label, StartedAt: c.StartedAt, Summary: c.Summary}
	}
	_ = s.Send(ctx, hub.Headset, protocol.TypeConversations, "", protocol.ConversationsData{Items: items})
}

func (o *Orchestrator) memoryError(ctx context.Context, s *hub.Session, err error) {
	switch {
	case errors.Is(err, store.ErrNoConsent):
		o.sendError(ctx, s, "no_consent", "Turn on Save memories in Settings first.")
	case errors.Is(err, store.ErrNotFound):
		o.sendError(ctx, s, "not_found", "That memory or conversation no longer exists.")
	case errors.Is(err, store.ErrInvalid):
		o.sendError(ctx, s, "invalid_label", "Conversation labels can't be empty or too long.")
	default:
		slog.Error("memories", "session", s.ID, "err", err)
		o.sendError(ctx, s, "storage_failed", "Couldn't save that change.")
	}
}

// suggestContext returns the memories and attached conversation summaries to send to /suggest with history.
// A storage error only costs the extra context, so it is logged and the suggestion goes ahead without it.
func (o *Orchestrator) suggestContext(ss *sessionState, history []models.Turn) ([]string, []models.ContextItem) {
	ctx := context.Background()
	mems, err := o.store.Memories(ctx, o.personID)
	if err != nil {
		slog.Error("memories for suggest", "err", err)
	}
	ss.mu.Lock()
	attached := ss.attached
	ss.mu.Unlock()
	var items []models.ContextItem
	if len(attached) > 0 {
		convs, err := o.store.Conversations(ctx, o.personID)
		if err != nil {
			slog.Error("conversations for suggest", "err", err)
		}
		for _, c := range convs {
			for _, id := range attached {
				if c.ID == id {
					items = append(items, models.ContextItem{Label: c.Label, Summary: c.Summary})
				}
			}
		}
	}
	return relevantMemories(mems, history[max(0, len(history)-keywordTurns):]), items
}

// relevantMemories picks up to memoriesSent of mems (newest first) that share a content word with recent,
// most shared words first, ties to the newer. None match, none are sent: an unrelated memory only distracts.
func relevantMemories(mems []store.Memory, recent []models.Turn) []string {
	said := map[string]bool{}
	for _, t := range recent {
		for w := range contentWords(t.Text) {
			said[w] = true
		}
	}
	type scored struct {
		summary string
		shared  int
	}
	var hits []scored
	for _, m := range mems {
		n := 0
		for w := range contentWords(m.Summary) {
			if said[w] {
				n++
			}
		}
		if n > 0 {
			hits = append(hits, scored{m.Summary, n})
		}
	}
	sort.SliceStable(hits, func(i, j int) bool { return hits[i].shared > hits[j].shared })
	var out []string
	for _, h := range hits[:min(len(hits), memoriesSent)] {
		out = append(out, h.summary)
	}
	return out
}

// contentWords lowercases text and drops stop words and single letters; numbers count ("3 pm").
func contentWords(text string) map[string]bool {
	words := map[string]bool{}
	for _, w := range strings.FieldsFunc(strings.ToLower(text), func(r rune) bool {
		return !unicode.IsLetter(r) && !unicode.IsDigit(r)
	}) {
		if stopWords[w] || (len([]rune(w)) == 1 && !unicode.IsDigit([]rune(w)[0])) {
			continue
		}
		words[w] = true
	}
	return words
}

// English only for now (AGENTS(GH).md §1); other locales just match more loosely.
var stopWords = func() map[string]bool {
	m := map[string]bool{}
	for _, w := range strings.Fields(`the an and or but if then so is are was were be been being am do does did
		have has had will would can could should may might must to of in on at by for with about from into up
		out over it its this that these those there here what when where who whom which why how not no yes
		me my mine you your yours he him his she her hers we us our they them their said say says tell told
		just very really too also all any some okay ok oh well ve ll re don isn didn doesn won`) {
		m[w] = true
	}
	return m
}()
