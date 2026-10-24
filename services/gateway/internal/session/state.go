// Package session holds the per-session state machine from AGENTS(GH).md §3.
package session

import "fmt"

type State string

const (
	Idle       State = "IDLE"
	Listening  State = "LISTENING"
	Suggesting State = "SUGGESTING"
	Choosing   State = "CHOOSING"
	Composing  State = "COMPOSING"
	Speaking   State = "SPEAKING"
)

// Input is something that happened which may move the session to another state.
type Input string

const (
	Start            Input = "start"             // phone.unlock
	SpeechEnded      Input = "speech_ended"      // transcript.final
	SuggestionsReady Input = "suggestions_ready" // /suggest returned
	Speak            Input = "speak"             // select, instant, phrase.speak, compose.submit
	ComposeStart     Input = "compose_start"
	Cancel           Input = "cancel"
	ClipDone         Input = "clip_done" // audio.done
)

// Instant and saved phrases must work even while suggestions are loading, so Speak is allowed
// from every active state except SPEAKING.
var transitions = map[State]map[Input]State{
	Idle:       {Start: Listening},
	Listening:  {SpeechEnded: Suggesting, Speak: Speaking, ComposeStart: Composing},
	Suggesting: {SuggestionsReady: Choosing, Speak: Speaking, ComposeStart: Composing, Cancel: Listening},
	Choosing:   {Speak: Speaking, ComposeStart: Composing, Cancel: Listening},
	Composing:  {Speak: Speaking, Cancel: Listening},
	Speaking:   {ClipDone: Listening},
}

// Machine is not safe for concurrent use; the session that owns it serializes access.
type Machine struct {
	state State
}

func NewMachine() *Machine { return &Machine{state: Idle} }

func (m *Machine) State() State { return m.state }

// Apply moves to the next state, or returns an error and stays put if the input isn't allowed now.
func (m *Machine) Apply(in Input) (State, error) {
	next, ok := transitions[m.state][in]
	if !ok {
		return m.state, fmt.Errorf("input %q not allowed in state %s", in, m.state)
	}
	m.state = next
	return next, nil
}
