package sqlserver

import (
	"flag"
	"regexp"
	"strings"
	"testing"

	"github.com/restow-backup/restow/agent/internal/api"
)

var updateGolden = flag.Bool("update", false, "rewrite the golden files")

// Static checks of sql.ps1 (docs/BAREMETAL-WINDOWS.md 5.1.2): no T-SQL is
// put together in the client except the placeholder MOVE clauses, every
// statement it runs comes from the request, nothing is evaluated from text.
func TestScriptRules(t *testing.T) {
	// The rules apply to the code, not to the comments that explain them.
	var code []string
	for _, line := range strings.Split(string(Script), "\n") {
		if !strings.HasPrefix(strings.TrimSpace(line), "#") {
			code = append(code, line)
		}
	}
	s := strings.Join(code, "\n")
	for _, bad := range []string{"Invoke-Expression", "iex ", "[scriptblock]::Create", "ScriptBlock]::Create", "Add-Type",
		"-EncodedCommand", "Invoke-Command", "Start-Process", "DownloadString", "Net.WebClient", "Invoke-WebRequest"} {
		if strings.Contains(strings.ToLower(s), strings.ToLower(bad)) {
			t.Errorf("sql.ps1 uses %s", bad)
		}
	}
	// CommandText is set in one place, from -Text.
	var ct []string
	for _, line := range strings.Split(s, "\n") {
		if strings.Contains(line, "CommandText") {
			ct = append(ct, strings.TrimSpace(line))
		}
	}
	if len(ct) != 1 || ct[0] != "$cmd.CommandText = $Text" {
		t.Fatalf("CommandText is set here: %q", ct)
	}
	// Every -Text is a statement of the request or the restore text.
	texts := regexp.MustCompile(`(?:^|\s)-Text\s+(\S+)`).FindAllStringSubmatch(s, -1)
	if len(texts) < 10 {
		t.Fatalf("only %d statements found", len(texts))
	}
	stmt := regexp.MustCompile(`^\$req\.statements\.([A-Za-z]+)$`)
	for _, m := range texts {
		if m[1] == "$restoreText" {
			continue
		}
		if !stmt.MatchString(m[1]) {
			t.Errorf("Invoke-Step runs %s, which is no statement of the request", m[1])
		}
	}
	// The restore text is the fixed statement with the placeholder clauses.
	assign := regexp.MustCompile(`(?m)^\s*\$restoreText\s*=\s*(.*)$`).FindAllStringSubmatch(s, -1)
	if len(assign) != 2 {
		t.Fatalf("%d assignments of $restoreText", len(assign))
	}
	for _, a := range assign {
		if strings.TrimSpace(a[1]) != `$req.statements.RestoreNewName.Replace('{{MOVES}}', (New-RestowMoveClause $mv.count))` {
			t.Errorf("$restoreText = %s", a[1])
		}
	}
	// New-RestowMoveClause concatenates placeholders and an integer only.
	fn := regexp.MustCompile(`(?s)function New-RestowMoveClause\(\[int\]\$Count\) \{(.*?)\n\}`).FindStringSubmatch(s)
	if fn == nil {
		t.Fatal("New-RestowMoveClause not found")
	}
	body := fn[1]
	if !strings.Contains(body, `$parts.Add('MOVE @l' + $i + ' TO @p' + $i)`) || !strings.Contains(body, "for ($i = 0; $i -lt $Count; $i++)") ||
		strings.Count(body, "+") != 4+1 { // four in the clause, one in $i++
		t.Errorf("New-RestowMoveClause builds more than placeholders:%s", body)
	}
	// Every statement used exists, and every statement is used.
	used := map[string]bool{}
	for _, m := range regexp.MustCompile(`\$req\.statements\.([A-Za-z]+)`).FindAllStringSubmatch(s, -1) {
		used[m[1]] = true
		if _, ok := Statements()[m[1]]; !ok {
			t.Errorf("sql.ps1 uses the statement %s, which statements.go does not have", m[1])
		}
	}
	for _, n := range StatementNames() {
		if !used[n] {
			t.Errorf("statement %s is never used by sql.ps1", n)
		}
	}
	// Parameters bound are the declared ones (MOVE pairs from Get-MoveParams).
	declared := map[string]bool{}
	for _, ps := range StatementParams {
		for _, p := range ps {
			declared[p] = true
		}
	}
	for _, m := range regexp.MustCompile(`'(@[A-Za-z0-9_]+)'`).FindAllStringSubmatch(s, -1) {
		if !declared[m[1]] && m[1] != "@l" && m[1] != "@p" {
			t.Errorf("sql.ps1 binds %s, which no statement declares", m[1])
		}
	}
	// The language mode is checked before anything else runs.
	lm := strings.Index(s, "$ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage'")
	if lm < 0 || lm > strings.Index(s, "Set-StrictMode") || lm > strings.Index(s, "New-Object") {
		t.Error("the language mode is not checked first")
	}
	// Exit codes are 0, 2 and 3 (crash) only.
	for _, m := range regexp.MustCompile(`\bexit (\S+)`).FindAllStringSubmatch(s, -1) {
		if m[1] != "0" && m[1] != "2" && m[1] != "3" {
			t.Errorf("exit %s", m[1])
		}
	}
	// Every error code of the script belongs to the contract.
	known := map[string]bool{api.SQLInstanceUnreachable: true, api.SQLLoginMissing: true, api.SQLPermissionMissing: true,
		api.SQLPowerShellConstraint: true, api.SQLBackupFailed: true, api.SQLScriptFailed: true, api.SQLRestoreNameTaken: true,
		api.SQLRestoreFailed: true, api.SQLVerifyTimeout: true}
	for _, m := range regexp.MustCompile(`'(sql_[a-z_]+)'|"code":"(sql_[a-z_]+)"`).FindAllStringSubmatch(s, -1) {
		c := m[1] + m[2]
		if !known[c] {
			t.Errorf("sql.ps1 reports the code %s", c)
		}
	}
	// The script refuses a request of another protocol.
	if !strings.Contains(s, "[int]$req.protocol -ne 1") || Protocol != 1 {
		t.Error("protocol check")
	}
	if ScriptSHA256 == "" || !strings.HasPrefix(ScriptFileName(), "restow-sql-") || !strings.HasSuffix(ScriptFileName(), ".ps1") {
		t.Error("script file name")
	}
}
