package main

import (
	"bytes"
	"strings"
	"testing"

	"github.com/restow-backup/restow/agent/internal/status"
)

func TestStatusSaysWhenTheMachineWaitsForABackupJob(t *testing.T) {
	report := statusReport{
		AgentVersion: "0.2.1", Platform: "linux/amd64", Enrolled: true, EndpointID: "e-1",
		ServerURL: "https://backup.example", Service: serviceReport{State: "running"},
		Runtime: &status.Status{ConfigVersion: "1", Schedule: "waiting for a backup job", WaitingForJob: true},
	}
	var out bytes.Buffer
	printStatus(&out, report)
	text := out.String()
	for _, want := range []string{"version 1, waiting for a backup job", "Backups:", "added to a backup job"} {
		if !strings.Contains(text, want) {
			t.Errorf("status lacks %q:\n%s", want, text)
		}
	}

	report.Runtime = &status.Status{ConfigVersion: "2", Schedule: "daily at 22:00 UTC"}
	out.Reset()
	printStatus(&out, report)
	if strings.Contains(out.String(), "Backups:") {
		t.Fatalf("a machine in a job must not be called waiting:\n%s", out.String())
	}
}
