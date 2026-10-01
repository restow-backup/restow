package main

import (
	"github.com/restow-backup/restow/agent/internal/redact"
	"github.com/restow-backup/restow/agent/internal/state"
)

// registerSecrets makes the redactor mask the stored secrets everywhere.
func registerSecrets(st *state.State) { redact.Add(st.Secrets()...) }
