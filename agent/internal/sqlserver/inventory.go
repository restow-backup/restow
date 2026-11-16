package sqlserver

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/restow-backup/restow/agent/internal/api"
)

// Inventory is the SQL inventory of the machine: what each instance said.
// The agent keeps it in memory with the physical file names (the file
// backup leaves them out); the server gets the bounded Wire form.
type Inventory struct {
	CollectedAt time.Time
	Instances   []InstanceInventory
}

// InstanceInventory is one instance: Result when it could be read, else
// Problem.
type InstanceInventory struct {
	Fact    api.SQLInstanceFact
	Result  *InventoryResult
	Problem *Problem
}

// inventoryStep is the statement limit of the inventory.
const inventoryStep = 10 * time.Minute

// ReadInstance runs the inventory of one instance.
func ReadInstance(ctx context.Context, runner ScriptRunner, fact api.SQLInstanceFact) InstanceInventory {
	ii := InstanceInventory{Fact: fact}
	if !ValidInstanceName(fact.Name) {
		ii.Problem = &Problem{Code: api.SQLInstanceUnreachable, Step: StepRequest, Message: "The instance name is not valid."}
		return ii
	}
	req, err := NewRequest(OpInventory, fact.Name, inventoryStep, nil)
	if err != nil {
		ii.Problem = &Problem{Code: api.SQLScriptFailed, Step: StepRequest, Message: err.Error()}
		return ii
	}
	res := runner.Run(ctx, req, nil)
	if !res.OK() {
		ii.Problem = classify(fact, res.Problem)
		return ii
	}
	var inv InventoryResult
	if err := res.Decode(&inv); err != nil {
		ii.Problem = &Problem{Code: api.SQLScriptFailed, Step: StepInventory, Message: BoundMessage("The inventory of the instance could not be read: " + err.Error())}
		return ii
	}
	ii.Result = &inv
	return ii
}

// classify refines the problem of a script by the registry facts: an
// instance that cannot be reached while it enforces strict encryption (TDS
// 8.0) is not reachable for the driver of the agent.
func classify(fact api.SQLInstanceFact, p *Problem) *Problem {
	if p == nil {
		return &Problem{Code: api.SQLScriptFailed, Step: StepScript, Message: "The SQL Server script gave no result."}
	}
	q := *p
	if fact.StrictEncryption && q.Code == api.SQLInstanceUnreachable {
		q.Code = api.SQLStrictEncryption
		q.Message = BoundMessage("The instance enforces strict encryption (TDS 8.0), which the SQL Server client of Windows PowerShell cannot speak. " + q.Message)
	}
	return &q
}

// CollectInventory reads every instance one after another.
func CollectInventory(ctx context.Context, runner ScriptRunner, facts []api.SQLInstanceFact, now time.Time) *Inventory {
	inv := &Inventory{CollectedAt: now.UTC()}
	for _, f := range facts {
		if ctx.Err() != nil {
			break
		}
		inv.Instances = append(inv.Instances, ReadInstance(ctx, runner, f))
	}
	return inv
}

// Instance returns the entry of an instance (nil when it was not read).
func (inv *Inventory) Instance(name string) *InstanceInventory {
	if inv == nil {
		return nil
	}
	for i := range inv.Instances {
		if strings.EqualFold(inv.Instances[i].Fact.Name, name) {
			return &inv.Instances[i]
		}
	}
	return nil
}

// Replace puts a fresh entry of one instance into the inventory.
func (inv *Inventory) Replace(ii InstanceInventory) {
	for i := range inv.Instances {
		if strings.EqualFold(inv.Instances[i].Fact.Name, ii.Fact.Name) {
			inv.Instances[i] = ii
			return
		}
	}
	inv.Instances = append(inv.Instances, ii)
}

// WireDatabase is the inventory form of a database.
func WireDatabase(db InventoryDB) api.SQLInventoryDatabase {
	used := db.UsedBytes
	if used < 0 {
		used = db.SizeBytes
	}
	w := api.SQLInventoryDatabase{
		Name: db.Name, DatabaseID: db.DatabaseID, System: db.System, FamilyGUID: db.FamilyGUID, DatabaseGUID: db.DatabaseGUID,
		State: db.State, RecoveryModel: db.RecoveryModel, ReadOnly: db.ReadOnly, Encrypted: db.Encrypted,
		SizeBytes: db.SizeBytes, UsedBytes: used, CanBackup: db.CanBackup,
	}
	if t, ok := ParseUTC(db.LastFullBackup); ok {
		w.LastFullBackupAt = &t
	}
	return w
}

// WireInstance is the inventory form of an instance.
func WireInstance(ii InstanceInventory) api.SQLInventoryInstance {
	if ii.Result == nil {
		p := ii.Problem
		if p == nil {
			p = &Problem{Code: api.SQLScriptFailed, Step: StepInventory}
		}
		return api.SQLInventoryInstance{Name: ii.Fact.Name, State: api.SQLInstanceError, Error: p}
	}
	r := ii.Result
	login := r.Login
	w := api.SQLInventoryInstance{
		Name: ii.Fact.Name, State: api.SQLInstanceOK, Version: r.Version, Edition: r.Edition, EngineEdition: r.EngineEdition,
		Clustered: r.Clustered || ii.Fact.Clustered, Hadr: r.Hadr, BackupCompressionDefault: r.BackupCompressionDefault,
		Login: &login, Databases: []api.SQLInventoryDatabase{},
	}
	for _, db := range r.Databases {
		if strings.EqualFold(db.Name, "tempdb") || db.Snapshot {
			continue
		}
		w.Databases = append(w.Databases, WireDatabase(db))
	}
	return w
}

// Wire is the inventory of the heartbeat, at most MaxSQLInventoryBytes and
// MaxSQLDatabases: should it be larger, databases are dropped from the end
// and Truncated is set.
func (inv *Inventory) Wire() *api.SQLInventory {
	if inv == nil {
		return nil
	}
	out := &api.SQLInventory{CollectedAt: inv.CollectedAt, Instances: []api.SQLInventoryInstance{}}
	total := 0
	for _, ii := range inv.Instances {
		w := WireInstance(ii)
		if room := api.MaxSQLDatabases - total; len(w.Databases) > room {
			w.Databases = w.Databases[:max(room, 0)]
			out.Truncated = true
		}
		total += len(w.Databases)
		out.Instances = append(out.Instances, w)
	}
	size := func() int {
		b, _ := json.Marshal(out)
		return len(b)
	}
	n := size()
	for n > api.MaxSQLInventoryBytes {
		// Drop from the end; one database at a time, the size of each known.
		i := len(out.Instances) - 1
		for i >= 0 && len(out.Instances[i].Databases) == 0 {
			i--
		}
		if i < 0 {
			break
		}
		dbs := out.Instances[i].Databases
		last, _ := json.Marshal(dbs[len(dbs)-1])
		out.Instances[i].Databases = dbs[:len(dbs)-1]
		out.Truncated = true
		n -= len(last) + 1
		if n <= api.MaxSQLInventoryBytes {
			n = size()
		}
	}
	return out
}

// ParseUTC reads a time the script wrote in UTC (yyyy-mm-ddThh:mi:ss).
func ParseUTC(s string) (time.Time, bool) {
	if s == "" {
		return time.Time{}, false
	}
	t, err := time.ParseInLocation("2006-01-02T15:04:05", s, time.UTC)
	if err != nil {
		return time.Time{}, false
	}
	return t, true
}

// ParseLocal reads a local time of the server and turns it into UTC.
func ParseLocal(s string, offsetMinutes int) (time.Time, bool) {
	t, ok := ParseUTC(s)
	if !ok {
		return t, false
	}
	return t.Add(-time.Duration(offsetMinutes) * time.Minute), true
}

// validLSN: a decimal number of at most 25 digits.
func validLSN(s string) bool {
	if s == "" || len(s) > 25 {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

// validGUID: lower case with dashes.
func validGUID(s string) bool {
	if len(s) != 36 {
		return false
	}
	for i := 0; i < 36; i++ {
		c := s[i]
		switch i {
		case 8, 13, 18, 23:
			if c != '-' {
				return false
			}
		default:
			if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
				return false
			}
		}
	}
	return true
}

// BackupFacts turns HEADERONLY and FILELISTONLY of a backup file into the
// wire facts; it refuses a header that is not that of a COPY_ONLY full of
// the expected database.
func BackupFacts(r BackupResult, db InventoryDB, snapshotPath, sha string, size int64) (api.SQLBackupFacts, error) {
	h := r.Header
	f := api.SQLBackupFacts{Kind: "full", CopyOnly: h.CopyOnly, Compressed: h.Compressed, Checksum: h.HasChecksums,
		PathInSnapshot: snapshotPath, SHA256: sha, Bytes: size,
		FirstLSN: h.FirstLSN, LastLSN: h.LastLSN, DatabaseBackupLSN: h.DatabaseBackupLSN, CheckpointLSN: h.CheckpointLSN,
		FirstRecoveryForkGUID: h.FirstRecoveryForkGUID, LastRecoveryForkGUID: h.LastRecoveryForkGUID,
		BeginsLogChain: h.BeginsLogChain, HasBulkLoggedData: h.HasBulkLoggedData, FileList: r.FileList}
	if h.BackupType != 1 {
		return f, fmt.Errorf("the backup file holds a backup of type %d, not a full", h.BackupType)
	}
	if !h.CopyOnly {
		return f, fmt.Errorf("the backup file is no COPY_ONLY backup")
	}
	if !strings.EqualFold(h.DatabaseName, db.Name) {
		return f, fmt.Errorf("the backup file holds the database %q", h.DatabaseName)
	}
	if db.FamilyGUID != "" && h.FamilyGUID != "" && h.FamilyGUID != db.FamilyGUID {
		return f, fmt.Errorf("the backup file belongs to another database family (%s)", h.FamilyGUID)
	}
	for _, l := range []string{h.FirstLSN, h.LastLSN, h.CheckpointLSN} {
		if !validLSN(l) {
			return f, fmt.Errorf("the backup file has an invalid LSN %q", l)
		}
	}
	if h.DatabaseBackupLSN == "" {
		f.DatabaseBackupLSN = "0"
	} else if !validLSN(h.DatabaseBackupLSN) {
		return f, fmt.Errorf("the backup file has an invalid LSN %q", h.DatabaseBackupLSN)
	}
	for _, g := range []string{h.FirstRecoveryForkGUID, h.LastRecoveryForkGUID} {
		if g != "" && !validGUID(g) {
			return f, fmt.Errorf("the backup file has an invalid fork GUID %q", g)
		}
	}
	start, ok1 := ParseLocal(h.BackupStart, h.TZOffsetMinutes)
	finish, ok2 := ParseLocal(h.BackupFinish, h.TZOffsetMinutes)
	if !ok1 || !ok2 {
		return f, fmt.Errorf("the backup file has no valid start and finish time")
	}
	f.BackupStart, f.BackupFinish = start, finish
	if len(f.FileList) == 0 || len(f.FileList) > api.MaxSQLFileList {
		return f, fmt.Errorf("the backup file lists %d database files", len(f.FileList))
	}
	return f, nil
}
