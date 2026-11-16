package sqlserver

import (
	"crypto/sha256"
	"encoding/hex"

	_ "embed" // the script
)

// Script is sql.ps1, the only PowerShell the native SQL Server backup runs.
// It comes from the signed agent; the runner writes it to a protected file
// and checks that file against ScriptSHA256 before each start.
//
//go:embed sql.ps1
var Script []byte

// ScriptSHA256 is the SHA-256 of Script (hex).
var ScriptSHA256 = func() string {
	sum := sha256.Sum256(Script)
	return hex.EncodeToString(sum[:])
}()

// ScriptFileName is the name of the script file in the agent's tmp folder:
// restow-sql-<first 8 hex of its SHA-256>.ps1, so an agent update writes a
// new file instead of changing one a running script still reads.
func ScriptFileName() string { return "restow-sql-" + ScriptSHA256[:8] + ".ps1" }
