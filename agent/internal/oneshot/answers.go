package oneshot

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/restow-backup/restow/agent/internal/recovery"
)

// AnswersFormat is the format of the answers of an unattended oneshot
// restore (--answers; docs/BAREMETAL-ONESHOT.md 8.4).
const AnswersFormat = "restow-oneshot-answers-v1"

// Answers are what the console asks otherwise: the identities of the disks
// to erase and the passphrase of new LUKS volumes. The code is never part
// of them; it comes over stdin.
type Answers struct {
	Format       string   `json:"format"`
	ConfirmErase []string `json:"confirmErase"`
	Passphrase   string   `json:"passphrase,omitempty"`
	Language     string   `json:"language,omitempty"`
	Keymap       string   `json:"keymap,omitempty"`
}

// ParseAnswers reads and checks the answers file.
func ParseAnswers(b []byte) (*Answers, error) {
	if len(b) > 64<<10 {
		return nil, errors.New("answers: too large")
	}
	var probe map[string]json.RawMessage
	if err := json.Unmarshal(b, &probe); err != nil {
		return nil, fmt.Errorf("answers: %w", err)
	}
	if _, ok := probe["code"]; ok {
		return nil, errors.New("answers: a code does not belong in the answers; it comes over stdin (--code-stdin)")
	}
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields()
	var a Answers
	if err := dec.Decode(&a); err != nil {
		return nil, fmt.Errorf("answers: %w", err)
	}
	if a.Format != AnswersFormat {
		return nil, fmt.Errorf("answers: format must be %q", AnswersFormat)
	}
	if len(a.ConfirmErase) == 0 {
		return nil, errors.New("answers: confirmErase names no disk")
	}
	seen := map[string]bool{}
	for _, id := range a.ConfirmErase {
		if !recovery.ValidIdentity(id) || seen[id] {
			return nil, fmt.Errorf("answers: confirmErase %q is no disk identity or named twice", id)
		}
		seen[id] = true
	}
	if len(a.Passphrase) > 512 {
		return nil, errors.New("answers: passphrase too long")
	}
	if a.Language != "" && a.Language != recovery.LangDE && a.Language != recovery.LangEN {
		return nil, fmt.Errorf("answers: language %q", a.Language)
	}
	return &a, nil
}
