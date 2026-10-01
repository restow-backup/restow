package restic

import (
	"encoding/json"
	"fmt"
	"strings"
)

// maxKeptItemErrors bounds the per-item errors a backup or a restore keeps
// (all are counted).
const maxKeptItemErrors = 100

// itemErrors collects the errors restic reports for single items (JSON
// message_type "error"): restic 0.19 writes them to stderr, an older restic
// wrote them to stdout, so both streams feed it. It keeps the first
// maxKeptItemErrors in restic's order, counts all, and logs each once in a
// readable form. The runner never calls it from two streams at once.
type itemErrors struct {
	r     *Runner
	kept  []ItemError
	count int
}

func (c *itemErrors) add(line []byte) {
	var em errorMessage
	if json.Unmarshal(line, &em) != nil {
		return
	}
	c.count++
	if len(c.kept) < maxKeptItemErrors {
		c.kept = append(c.kept, ItemError{Path: em.Item, Message: em.Error.Message, During: em.During})
	}
	c.r.log(fmt.Sprintf("error: %s: %s", em.Item, em.Error.Message))
}

// Exit codes documented by restic.
const (
	ExitFatal          = 1
	ExitIncomplete     = 3 // snapshot created, but some files could not be read
	ExitNoRepository   = 10
	ExitRepoLocked     = 11
	ExitWrongPassword  = 12
	ExitInterrupted    = 130
	exitKilledBySignal = -1
)

// Error is a failed restic invocation.
type Error struct {
	// Command is the restic subcommand (backup, restore, ...), never with
	// arguments: arguments can name customer files.
	Command  string
	ExitCode int
	// Message is restic's own explanation (the last error line).
	Message string
	// Stderr holds the last lines of restic's stderr for the run log.
	Stderr []string
	// Fatal is the error restic ended with (its exit_error message, for
	// example "Fatal: There were 2 errors"); empty when it wrote none.
	Fatal string
	// Items are the errors restic reported for single items before it ended
	// (backup, restore), at most maxKeptItemErrors, in its order. ItemCount
	// counts all of them.
	Items     []ItemError
	ItemCount int
}

func (e *Error) Error() string {
	msg := e.Message
	if msg == "" {
		msg = "no error message"
	}
	return fmt.Sprintf("restic %s failed (exit code %d): %s", e.Command, e.ExitCode, msg)
}

// Hint says what the operator can do about the failure. It is empty when
// there is nothing more specific to say than the message.
func (e *Error) Hint() string {
	lower := strings.ToLower(e.Message + " " + strings.Join(e.Stderr, " "))
	switch {
	case e.ExitCode == ExitNoRepository:
		return "The repository does not exist on the Restow instance. The server creates it when the endpoint is enrolled; " +
			"ask the Restow administrator to check the endpoint or enroll this machine again."
	case e.ExitCode == ExitRepoLocked:
		return "The repository is locked, usually by server-side maintenance (prune or check). The agent retries later."
	case e.ExitCode == ExitWrongPassword:
		return "The repository password is wrong. The state file may be damaged: enroll this machine again with a new token."
	case e.ExitCode == ExitInterrupted:
		return "The backup was interrupted; the agent resumes it when possible."
	case strings.Contains(lower, "401") || strings.Contains(lower, "unauthorized"):
		return "The Restow instance rejected the agent credentials for the repository. The endpoint may have been revoked: " +
			"create a new server or client in the Restow UI and run the install command again."
	case strings.Contains(lower, "403") || strings.Contains(lower, "forbidden"):
		return "The repository is append-only for agents: this operation (delete or overwrite) is not allowed from the endpoint. " +
			"Retention and pruning run on the Restow server."
	case strings.Contains(lower, "no space left"):
		return "The disk is full. Free space on this machine (restic needs room for its cache) and try again."
	case strings.Contains(lower, "x509") || strings.Contains(lower, "certificate"):
		return "The TLS certificate of the Restow instance is not trusted by this machine. " +
			"Install the CA certificate into the operating system trust store."
	case strings.Contains(lower, "no such host") || strings.Contains(lower, "connection refused") ||
		strings.Contains(lower, "i/o timeout") || strings.Contains(lower, "dial tcp"):
		return "The Restow instance could not be reached. Check the network connection, firewall and proxy (outbound HTTPS is required)."
	}
	return ""
}

// Transient reports failures that are worth retrying without operator action.
func (e *Error) Transient() bool {
	return e.ExitCode == ExitRepoLocked || e.ExitCode == ExitInterrupted
}

func stderrTail(lines []string, n int) []string {
	if len(lines) <= n {
		return lines
	}
	return lines[len(lines)-n:]
}
