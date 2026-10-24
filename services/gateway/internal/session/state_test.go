package session

import "testing"

func TestMachine(t *testing.T) {
	tests := []struct {
		name    string
		inputs  []Input
		want    State
		wantErr bool
	}{
		{"starts idle", nil, Idle, false},
		{"suggestion happy path", []Input{Start, SpeechEnded, SuggestionsReady, Speak, ClipDone}, Listening, false},
		{"instant while listening", []Input{Start, Speak}, Speaking, false},
		{"instant while suggestions load", []Input{Start, SpeechEnded, Speak}, Speaking, false},
		{"compose then submit", []Input{Start, SpeechEnded, SuggestionsReady, ComposeStart, Speak}, Speaking, false},
		{"cancel choosing", []Input{Start, SpeechEnded, SuggestionsReady, Cancel}, Listening, false},
		{"cancel composing", []Input{Start, ComposeStart, Cancel}, Listening, false},
		{"no speaking before start", []Input{Speak}, Idle, true},
		{"no double speak", []Input{Start, Speak, Speak}, Speaking, true},
		{"suggestions ready while listening is ignored", []Input{Start, SuggestionsReady}, Listening, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			m := NewMachine()
			var err error
			for _, in := range tt.inputs {
				if _, err = m.Apply(in); err != nil {
					break
				}
			}
			if (err != nil) != tt.wantErr {
				t.Fatalf("err = %v, wantErr %v", err, tt.wantErr)
			}
			if got := m.State(); got != tt.want {
				t.Fatalf("state = %s, want %s", got, tt.want)
			}
		})
	}
}
