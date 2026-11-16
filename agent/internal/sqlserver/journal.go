package sqlserver

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"
)

// The journal of check copies (C7, data\sql-verify-journal.json): before a
// RESTORE under a check name the agent writes the name here, after the DROP
// it takes it out again. A copy left behind by a crash or a stop is dropped
// before the next check of the instance, and only a name that is in the
// journal and has the form of a check name is ever dropped: a customer's
// database that merely looks like a check copy stays.

// JournalEntry is one planned check copy.
type JournalEntry struct {
	Instance  string    `json:"instance"`
	Name      string    `json:"name"`
	PlannedAt time.Time `json:"plannedAt"`
}

type journalFile struct {
	Version int            `json:"version"`
	Entries []JournalEntry `json:"entries"`
}

// maxJournalEntries bounds the journal (a check of 1000 databases that
// crashes again and again cannot make it grow without end).
const maxJournalEntries = 2000

// Journal reads and writes the journal file through FS.
type Journal struct {
	FS   FS
	Path string
}

// Load reads the journal; a missing file is an empty journal.
func (j Journal) Load() ([]JournalEntry, error) {
	b, err := j.FS.ReadFile(j.Path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var f journalFile
	if err := json.Unmarshal(b, &f); err != nil {
		return nil, fmt.Errorf("the journal of check copies %s is damaged: %w", j.Path, err)
	}
	return f.Entries, nil
}

func (j Journal) save(entries []JournalEntry) error {
	if len(entries) > maxJournalEntries {
		entries = entries[len(entries)-maxJournalEntries:]
	}
	b, err := json.MarshalIndent(journalFile{Version: 1, Entries: entries}, "", "  ")
	if err != nil {
		return err
	}
	return j.FS.WriteFile(j.Path, b)
}

// Add records a planned check copy. Only names of the check form are taken.
func (j Journal) Add(instance, name string, at time.Time) error {
	if !IsVerifyName(name) {
		return fmt.Errorf("%q is no check name", name)
	}
	entries, err := j.Load()
	if err != nil {
		return err
	}
	return j.save(append(entries, JournalEntry{Instance: instance, Name: name, PlannedAt: at.UTC()}))
}

// Remove takes names of an instance out of the journal.
func (j Journal) Remove(instance string, names ...string) error {
	entries, err := j.Load()
	if err != nil {
		return err
	}
	drop := map[string]bool{}
	for _, n := range names {
		drop[n] = true
	}
	kept := entries[:0]
	for _, e := range entries {
		if strings.EqualFold(e.Instance, instance) && drop[e.Name] {
			continue
		}
		kept = append(kept, e)
	}
	return j.save(kept)
}

// Leftovers are the names of an instance the journal still holds that have
// the check form (the only names a cleanup may drop).
func (j Journal) Leftovers(instance string) ([]string, error) {
	entries, err := j.Load()
	if err != nil {
		return nil, err
	}
	var out []string
	seen := map[string]bool{}
	for _, e := range entries {
		if strings.EqualFold(e.Instance, instance) && IsVerifyName(e.Name) && !seen[e.Name] {
			seen[e.Name] = true
			out = append(out, e.Name)
		}
	}
	return out, nil
}
