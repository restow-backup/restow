package sqlserver

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
)

func statementsText() string {
	var b strings.Builder
	b.WriteString("-- The fixed T-SQL of the Restow agent (internal/sqlserver/statements.go).\n")
	b.WriteString("-- Reviewed text; go test ./internal/sqlserver -run TestStatementsGolden -update rewrites it.\n\n")
	all := Statements()
	for _, n := range StatementNames() {
		b.WriteString("-- " + n)
		if ps := StatementParams[n]; len(ps) > 0 {
			b.WriteString(" (" + strings.Join(ps, ", ") + ")")
		}
		b.WriteString("\n" + all[n] + "\n\n")
	}
	return b.String()
}

func TestStatementsGolden(t *testing.T) {
	path := filepath.Join("testdata", "statements.golden.sql")
	got := statementsText()
	if *updateGolden {
		if err := os.WriteFile(path, []byte(got), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(want) != got {
		t.Fatalf("the statements differ from %s (review them, then run with -update)\n%s", path, got)
	}
}

var (
	paramRe = regexp.MustCompile(`@[A-Za-z_][A-Za-z0-9_]*`)
	locals  = map[string]bool{"@q": true, "@sql": true, "@state": true}
)

// Every text declares only the parameters the script binds; every text
// that builds a command on the server does so with QUOTENAME and refuses a
// name QUOTENAME cannot quote.
func TestStatementsRules(t *testing.T) {
	for name, text := range Statements() {
		allowed := map[string]bool{}
		for _, p := range StatementParams[name] {
			allowed[p] = true
		}
		for _, p := range paramRe.FindAllString(text, -1) {
			if !allowed[p] && !locals[p] {
				t.Errorf("%s uses %s, which is no declared parameter", name, p)
			}
		}
		for p := range allowed {
			if !strings.Contains(text, p) {
				t.Errorf("%s declares %s but does not use it", name, p)
			}
		}
		if strings.Contains(text, "sp_executesql") {
			if !strings.Contains(text, "QUOTENAME(@db)") || !strings.Contains(text, "IF @q IS NULL") {
				t.Errorf("%s runs dynamic SQL without the QUOTENAME guard", name)
			}
			// Only the quoted name and fixed text go into @sql.
			for _, line := range strings.Split(text, "\n") {
				if strings.Contains(line, "@sql nvarchar") || strings.Contains(line, "SET @sql") {
					rest := strings.NewReplacer("@q", "", "@sql", "").Replace(line)
					if strings.Contains(rest, "@") {
						t.Errorf("%s puts a parameter into dynamic SQL unquoted: %s", name, line)
					}
				}
			}
		}
		if strings.Contains(text, MovesSlot) && name != "RestoreNewName" {
			t.Errorf("%s has the MOVE slot", name)
		}
	}
	for _, want := range []string{"COPY_ONLY", "CHECKSUM", "NO_COMPRESSION", "INIT", "FORMAT"} {
		if !strings.Contains(BackupFullCopyOnly, want) {
			t.Errorf("BACKUP without %s", want)
		}
	}
	for _, want := range []string{"NO_INFOMSGS", "ALL_ERRORMSGS", "TABLERESULTS"} {
		if !strings.Contains(CheckDB, want) || !strings.Contains(CheckDBPhysicalOnly, want) {
			t.Errorf("CHECKDB without %s", want)
		}
	}
	if !strings.Contains(CheckDBPhysicalOnly, "PHYSICAL_ONLY") || strings.Contains(CheckDB, "PHYSICAL_ONLY") {
		t.Error("PHYSICAL_ONLY")
	}
	if !strings.Contains(RestoreNewName, "CHECKSUM, RECOVERY") || strings.Contains(RestoreNewName, "REPLACE") {
		t.Error("RESTORE must check sums, recover and never replace")
	}
	// The name is checked in the batch of the RESTORE itself.
	if !strings.HasPrefix(RestoreNewName, "IF DB_ID(@new) IS NOT NULL BEGIN; THROW 50003,") {
		t.Error("RESTORE without the name guard in its batch")
	}
	// The cleanup after a failed restore drops only a database in RESTORING.
	if !strings.Contains(DropRestoring, "IF @state = N'RESTORING'") || strings.Contains(DropRestoring, "SINGLE_USER") {
		t.Error("DropRestoring drops more than a database in RESTORING")
	}
	if !strings.Contains(DropVerifyCopy, "CHARINDEX(N'"+VerifyMarker+"', @db) = 0") {
		t.Error("DropVerifyCopy does not refuse other names")
	}
	names := StatementNames()
	if !sort.StringsAreSorted(names) || len(names) != len(Statements()) {
		t.Fatal("names")
	}
}
