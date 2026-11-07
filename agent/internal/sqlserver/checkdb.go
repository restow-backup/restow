package sqlserver

import (
	"fmt"

	"github.com/restow-backup/restow/agent/internal/api"
)

// What a DBCC CHECKDB proves (docs/BAREMETAL-WINDOWS.md 5.1.7: red only
// with evidence; space, rights and time limits are incomplete). The script
// reports the TABLERESULTS rows and, separately, every error SQL Server
// raised while CHECKDB ran (class 11 and up); JudgeCheckdb decides here, in
// Go, where the recorded runs of testdata/runs test it.
//
// Evidence that the backup is damaged is
//   - a TABLERESULTS row, unless its number says that CHECKDB stopped
//     (checkdbStopped) or it is the summary 8989;
//   - a raised error from the list of consistency errors (checkdbCorruption).
// Anything else CHECKDB raised means it did not run to its end: the check is
// incomplete, never red.

// checkdbStopped are errors that end or prevent a CHECKDB on this machine
// and say nothing about the backup.
var checkdbStopped = map[int]bool{
	665:   true, // file system limitation (sparse file of the internal snapshot)
	701:   true, // out of memory
	1101:  true, // no new page in the filegroup (disk full)
	1105:  true, // no space in the filegroup (tempdb or the copy itself)
	1222:  true, // lock request timeout
	1823:  true, // the internal database snapshot could not be created
	1824:  true, // the internal database snapshot could not be created
	2520:  true, // database not found
	5030:  true, // the database could not be locked exclusively
	5128:  true, // write to a sparse file failed
	7926:  true, // check aborted: no snapshot and no lock
	7928:  true, // the database snapshot for online checks could not be created
	8921:  true, // check terminated while collecting facts (tempdb out of space)
	8967:  true, // internal error in DBCC that stopped further processing
	9002:  true, // transaction log full (tempdb)
	50001: true, // the script's own guard: the name is not valid
}

// checkdbSpace are the stop errors that mean "not enough space".
var checkdbSpace = map[int]bool{665: true, 1101: true, 1105: true, 1823: true, 1824: true, 5128: true, 8921: true, 9002: true}

// checkdbSummary is the closing message of CHECKDB ("CHECKDB found %d
// allocation errors and %d consistency errors"); the errors it counts come
// as their own rows.
const checkdbSummary = 8989

// checkdbCorruption reports whether a raised error is a consistency error
// of the checked database: the allocation and page errors 8900-8999 (minus
// the stop and summary messages), the table errors of the 25xx range, the
// system table and metadata checks, schema corruption (211) and a page
// checksum or torn page found while reading (824).
func checkdbCorruption(number int) bool {
	switch {
	case checkdbStopped[number] || number == checkdbSummary:
		return false
	case number >= 8900 && number <= 8999:
		return true
	}
	switch number {
	case 211, 824,
		2508, 2511, 2512, 2514, 2515, 2516, 2517, 2533, 2534, 2536, 2537, 2570, 2575, 2576, 2577, 2579,
		3853, 3854, 3855, 3856,
		5242, 5243,
		7965, 7984, 7985, 7986, 7987, 7988, 7995:
		return true
	}
	return false
}

// JudgeCheckdb turns what the script saw into the result of the contract:
// Ran with the errors that prove damage, or Ran = false with the problem
// that stopped CHECKDB. A time limit the script reported stays as it is.
func JudgeCheckdb(c api.SQLCheckdbResult, raised []api.SQLError, prob *Problem) (api.SQLCheckdbResult, *Problem) {
	out := c
	out.Errors = []api.SQLCheckdbError{}
	if prob != nil && prob.Code == api.SQLVerifyTimeout {
		out.Ran = false
		return out, prob
	}
	var stoppedBy *api.SQLError
	stop := func(number, severity, state int, message string) {
		if stoppedBy == nil {
			stoppedBy = &api.SQLError{Number: number, Severity: severity, State: state, Message: message}
		}
	}
	seen := map[string]bool{}
	add := func(e api.SQLCheckdbError) {
		key := fmt.Sprintf("%d\x00%s", e.Number, e.Message)
		if seen[key] || len(out.Errors) >= api.MaxSQLCheckdbErrors {
			return
		}
		seen[key] = true
		out.Errors = append(out.Errors, e)
	}
	for _, e := range c.Errors {
		switch {
		case checkdbStopped[e.Number]:
			stop(e.Number, e.Level, e.State, e.Message)
		case e.Number == checkdbSummary:
		default:
			add(e)
		}
	}
	for _, e := range raised {
		switch {
		case e.Severity < 11 || e.Number == checkdbSummary:
		case checkdbCorruption(e.Number):
			add(api.SQLCheckdbError{Number: e.Number, Level: e.Severity, State: e.State, Message: e.Message})
		default:
			// Not a consistency error: CHECKDB did not end as it should
			// (a stop error, a broken connection, anything unknown).
			stop(e.Number, e.Severity, e.State, e.Message)
		}
	}
	switch {
	case len(out.Errors) > 0:
		// Damage was found; what stopped CHECKDB afterwards does not undo it.
		out.Ran = true
		return out, nil
	case stoppedBy != nil:
		out.Ran = false
		code := api.SQLScriptFailed
		if checkdbSpace[stoppedBy.Number] {
			code = api.SQLVerifyNoSpace
		}
		return out, &Problem{Code: code, Step: StepCheckDB, Number: stoppedBy.Number,
			Message: BoundMessage(fmt.Sprintf("%s (%d)", stoppedBy.Message, stoppedBy.Number))}
	case !c.Ran:
		// The script says it did not run, without an error to show.
		if prob == nil {
			prob = &Problem{Code: api.SQLScriptFailed, Step: StepCheckDB, Message: "DBCC CHECKDB returned no result."}
		}
		return out, prob
	}
	out.Ran = true
	return out, nil
}
