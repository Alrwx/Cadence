package clips

import (
	"encoding/binary"
	"testing"
	"time"
)

// wav builds a mono 16-bit WAV at rate lasting d, with an odd-sized LIST chunk before "data" if list is set,
// as some writers add.
func wav(rate uint32, d time.Duration, list bool) []byte {
	data := int(time.Duration(rate)*d/time.Second) * 2
	le := binary.LittleEndian
	b := []byte("RIFF\x00\x00\x00\x00WAVEfmt ")
	b = le.AppendUint32(b, 16)
	b = le.AppendUint16(b, 1) // PCM
	b = le.AppendUint16(b, 1) // mono
	b = le.AppendUint32(b, rate)
	b = le.AppendUint32(b, rate*2)
	b = le.AppendUint16(b, 2)
	b = le.AppendUint16(b, 16)
	if list {
		b = append(b, "LIST"...)
		b = le.AppendUint32(b, 3)
		b = append(b, "abc\x00"...) // 3 bytes plus the pad byte
	}
	b = append(b, "data"...)
	b = le.AppendUint32(b, uint32(data))
	b = append(b, make([]byte, data)...)
	le.PutUint32(b[4:], uint32(len(b)-8))
	return b
}

func TestDuration(t *testing.T) {
	c, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for name, file := range map[string][]byte{
		"plain":      wav(24000, 3600*time.Millisecond, false),
		"extraChunk": wav(16000, 3600*time.Millisecond, true),
	} {
		if err := c.Put(name, file); err != nil {
			t.Fatal(err)
		}
		if d, ok := c.Duration(name); !ok || d != 3600*time.Millisecond {
			t.Errorf("%s: Duration = %v, %v; want 3.6s, true", name, d, ok)
		}
	}

	if err := c.Put("notWav", []byte("RIFF-fake-wav")); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"notWav", "missing", "../escape"} {
		if d, ok := c.Duration(id); ok {
			t.Errorf("Duration(%q) = %v, true; want ok false", id, d)
		}
	}
}
