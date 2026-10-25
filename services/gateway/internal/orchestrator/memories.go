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
	// A saved conversation starts after the last one saved, or after a silence this long, whichever is later.
	conversationGap = 10 * time.Minute
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
		o.summarizeAndStore(ctx, s, ss, ss.lastMinuteLocked, "Nothing to remember from the last minute.",
			func(ctx context.Context, consentID, summary string, _ []heardTurn) error {
				if _, err := o.store.AddMemory(ctx, o.personID, consentID, summary); err != nil {
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
		label, err := store.CleanLabel(d.Label)
		if err != nil {
			o.memoryError(ctx, s, err)
			return
		}
		o.summarizeAndStore(ctx, s, ss, ss.conversationLocked, "Nothing to save from this conversation yet.",
			func(ctx context.Context, consentID, summary string, heard []heardTurn) error {
				if _, err := o.store.SaveConversation(ctx, o.personID, consentID, label, summary, heard[0].At.UnixMilli()); err != nil {
					return err
				}
				ss.mu.Lock()
				ss.savedThrough = heard[len(heard)-1].At
				ss.mu.Unlock()
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

// summarizeAndStore summarizes the turns pick chooses (called with ss.mu held) in the background, then hands the
// summary to save along with the consent it was captured under. It fails fast without store_chat consent or with
// nothing heard, and ignores a save while the session's previous summary is still running (repeated taps).
func (o *Orchestrator) summarizeAndStore(ctx context.Context, s *hub.Session, ss *sessionState, pick func() []heardTurn,
	nothingHeard string, save func(ctx context.Context, consentID, summary string, heard []heardTurn) error) {
	consentID, err := o.store.StoreChatConsent(ctx, o.personID)
	if err == nil && consentID == "" {
		err = store.ErrNoConsent
	}
	if err != nil {
		o.memoryError(ctx, s, err)
		return
	}
	ss.mu.Lock()
	if ss.summarizing {
		ss.mu.Unlock()
		slog.Info("save ignored: a summary is already running", "session", s.ID)
		return
	}
	heard := pick()
	ss.summarizing = len(heard) > 0
	ss.mu.Unlock()
	if len(heard) == 0 {
		o.sendError(ctx, s, "nothing_heard", nothingHeard)
		return
	}
	turns := make([]models.Turn, len(heard))
	for i, t := range heard {
		turns[i] = t.Turn
	}
	go func() {
		defer func() {
			ss.mu.Lock()
			ss.summarizing = false
			ss.mu.Unlock()
		}()
		ctx := context.Background()
		summary, err := o.models.Summarize(ctx, turns, o.currentLocale())
		if err == nil && strings.TrimSpace(summary) == "" {
			err = errors.New("empty summary")
		}
		if err != nil {
			slog.Error("summarize", "session", s.ID, "err", err)
			o.sendError(ctx, s, "summarize_failed", "Couldn't summarize that. Try again in a moment.")
			return
		}
		if err := save(ctx, consentID, summary, heard); err != nil {
			o.memoryError(ctx, s, err)
		}
	}()
}

// lastMinuteLocked returns the turns said within memoryWindow. Callers hold ss.mu.
func (ss *sessionState) lastMinuteLocked() []heardTurn {
	cutoff := time.Now().Add(-memoryWindow)
	var out []heardTurn
	for _, t := range ss.history {
		if !t.At.Before(cutoff) {
			out = append(out, t)
		}
	}
	return out
}

// conversationLocked returns the turns since the last saved conversation or the last conversationGap of
// silence, whichever is later. Callers hold ss.mu.
func (ss *sessionState) conversationLocked() []heardTurn {
	start := 0
	for i, t := range ss.history {
		switch {
		case !t.At.After(ss.savedThrough):
			start = i + 1
		case i > 0 && t.At.Sub(ss.history[i-1].At) > conversationGap:
			start = i
		}
	}
	return append([]heardTurn(nil), ss.history[start:]...)
}

func (o *Orchestrator) sendConsent(ctx context.Context, s *hub.Session) {
	consentID, err := o.store.StoreChatConsent(ctx, o.personID)
	if err != nil {
		slog.Error("load consent", "session", s.ID, "err", err)
		return // the headset assumes off and asks again
	}
	_ = s.Send(ctx, hub.Headset, protocol.TypeConsent, "", protocol.ConsentData{StoreChat: consentID != ""})
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
		byID := make(map[string]store.Conversation, len(convs))
		for _, c := range convs {
			byID[c.ID] = c
		}
		for _, id := range attached {
			if c, ok := byID[id]; ok {
				items = append(items, models.ContextItem{Label: c.Label, Summary: c.Summary})
				delete(byID, id) // an id attached twice is sent once
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

// English and Spanish, the supported languages (language.go); others just match more loosely. Words are
// matched in both, since a memory saved in one language may be matched against turns in the other.
var stopWords = func() map[string]bool {
	m := map[string]bool{}
	for _, w := range strings.Fields(`the an and or but if then so is are was were be been being am do does did
		have has had will would can could should may might must to of in on at by for with about from into up
		out over it its this that these those there here what when where who whom which why how not no yes
		me my mine you your yours he him his she her hers we us our they them their said say says tell told
		just very really too also all any some okay ok oh well ve ll re don isn didn doesn won
		el la los las un una unos unas lo le les al del de en con por para sin sobre entre hasta desde
		que qué y o pero si sí ni como cómo cuando cuándo donde dónde quien quién cual cuál por qué porque
		es son era eran fue fueron ser estar está están estaba estaban he ha han había hay hace hacer
		yo tú tu te ti mi mí mis me se nos usted ustedes él ella ellos ellas su sus nuestro nuestra
		este esta esto estos estas ese esa eso esos esas aquí allí ahí ya muy más menos también todo
		todos toda todas algo nada bueno bien vale dijo dice decir`) {
		m[w] = true
	}
	return m
}()
