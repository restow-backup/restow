//go:build windows

package eventlog

import "github.com/restow-backup/restow/agent/internal/winapi"

// report writes one event. Without the registered source Windows still
// stores it; the viewer then prefixes "The description cannot be found" to
// the text. Failures are ignored: the event log is an additional record.
func report(level int, id uint32, message string) {
	typ := uint16(winapi.EventlogInformationType)
	switch level {
	case levelWarning:
		typ = winapi.EventlogWarningType
	case levelError:
		typ = winapi.EventlogErrorType
	}
	_ = winapi.ReportEvent(Source, typ, id, message)
}
