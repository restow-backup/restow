package sqlserver

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/restow-backup/restow/agent/internal/api"
	"github.com/restow-backup/restow/agent/internal/sysinfo"
)

// The pure decisions of the native SQL Server backup: which databases, where
// their files go, how much space they need, how a check copy is named, where
// restored files go and how long a step may take. No build tag: every rule
// is tested on every system.

// GiB is 2^30 bytes.
const GiB = int64(1) << 30

// DefaultInstance is the name of the default instance.
const DefaultInstance = "MSSQLSERVER"

// DataSourceFor is the Shared Memory address of an instance.
func DataSourceFor(instance string) string {
	if strings.EqualFold(instance, DefaultInstance) {
		return `lpc:.`
	}
	return `lpc:.\` + instance
}

// ServiceNameFor is the Windows service of an instance.
func ServiceNameFor(instance string) string {
	if strings.EqualFold(instance, DefaultInstance) {
		return DefaultInstance
	}
	return "MSSQL$" + instance
}

// ---- names and paths ------------------------------------------------------

// SafeName keeps the letters, digits, '-', '_' and '.' of s (ASCII), replaces
// every other character with '_', and cuts it to maxRunes; never empty, never
// starting with a dot.
func SafeName(s string, maxRunes int) string {
	var b strings.Builder
	n := 0
	for _, r := range s {
		if n == maxRunes {
			break
		}
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_', r == '.':
			b.WriteRune(r)
		default:
			b.WriteByte('_')
		}
		n++
	}
	out := strings.TrimRight(b.String(), ".")
	if out == "" {
		return "db"
	}
	if out[0] == '.' {
		out = "_" + out[1:]
	}
	return out
}

// SafeFolder is the staging folder of a database: <SafeName(db)>~<first 8
// hex of the SHA-256 of the name>, so two names that look alike after
// SafeName still get folders of their own.
func SafeFolder(db string) string {
	sum := sha256.Sum256([]byte(db))
	return SafeName(db, 48) + "~" + hex.EncodeToString(sum[:])[:8]
}

// TimeStamp is the UTC time in names: 20261105T020011Z.
func TimeStamp(t time.Time) string { return t.UTC().Format("20060102T150405Z") }

// InstanceFolder is the staging folder of one instance below root.
func InstanceFolder(root, instance string) string {
	return filepath.Join(root, strings.ToUpper(instance))
}

// BackupPath is where SQL Server writes the full of a database.
func BackupPath(root, instance, db string, t time.Time) string {
	return filepath.Join(InstanceFolder(root, instance), SafeFolder(db), "full-"+TimeStamp(t)+".bak")
}

// SnapshotPathOf is the path restic stores a file under: C:\ProgramData\x
// becomes /C/ProgramData/x (drive letter in capitals); a path of another
// system only gets forward slashes.
func SnapshotPathOf(p string) string {
	if len(p) >= 2 && p[1] == ':' && isLetter(p[0]) {
		rest := strings.ReplaceAll(p[2:], `\`, "/")
		return "/" + strings.ToUpper(p[:1]) + rest
	}
	return filepath.ToSlash(p)
}

// RestoredPath is where restic restores a snapshot path below target: it
// keeps the drive letter as the first folder (C:\target\C\ProgramData\x).
func RestoredPath(target, snapshotPath string) string {
	return filepath.Join(target, filepath.FromSlash(strings.TrimPrefix(snapshotPath, "/")))
}

func isLetter(c byte) bool { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') }

// ---- selection --------------------------------------------------------------

// Selection is what the job's settings make of the databases of an
// instance: the databases to back up, and those that are reported as
// skipped (excluded ones and tempdb are neither).
type Selection struct {
	Backup  []InventoryDB
	Skipped []api.SQLDatabaseResult
	// CopyOnlySecondary are selected databases on a secondary replica of an
	// availability group (COPY_ONLY is all SQL Server allows there, and all
	// W2a does anyway).
	CopyOnlySecondary []string
}

// SelectDatabases applies the job's settings to the inventory of an
// instance: tempdb and database snapshots are never backed up; excluded
// databases are left out; a database that is not ONLINE, or that the login
// may not back up, is reported as skipped.
func SelectDatabases(cfg *api.SQLConfig, instance string, dbs []InventoryDB) Selection {
	var sel Selection
	for _, db := range dbs {
		if strings.EqualFold(db.Name, "tempdb") || db.Snapshot {
			continue
		}
		if !selected(cfg, instance, db.Name) {
			continue
		}
		skip := func(code, format string, args ...any) {
			sel.Skipped = append(sel.Skipped, api.SQLDatabaseResult{
				Name: db.Name, FamilyGUID: db.FamilyGUID, DatabaseGUID: db.DatabaseGUID, RecoveryModel: db.RecoveryModel,
				Outcome: api.SQLSkipped, Code: code, Message: BoundMessage(fmt.Sprintf(format, args...)),
			})
		}
		switch {
		case db.State != "ONLINE":
			skip(api.SQLDatabaseUnavailable, "%s was not backed up: it is %s, not ONLINE.", db.Name, db.State)
		case !db.CanBackup:
			skip(api.SQLPermissionMissing, "%s was not backed up: the login of the agent may not back it up (BACKUP DATABASE).", db.Name)
		default:
			sel.Backup = append(sel.Backup, db)
			if strings.EqualFold(db.ReplicaRole, "SECONDARY") {
				sel.CopyOnlySecondary = append(sel.CopyOnlySecondary, db.Name)
			}
		}
	}
	return sel
}

func selected(cfg *api.SQLConfig, instance, name string) bool {
	for _, x := range cfg.Exclude {
		if (x.Instance == "" || strings.EqualFold(x.Instance, instance)) && x.Name == name {
			return false
		}
	}
	if cfg.Databases.All {
		return true
	}
	for _, x := range cfg.Databases.List {
		if (x.Instance == "" || strings.EqualFold(x.Instance, instance)) && x.Name == name {
			return true
		}
	}
	return false
}

// ---- space ------------------------------------------------------------------

// ReserveBytes stay free on the staging volume whatever the plan says.
const ReserveBytes = GiB

// LiveVolumeReserve is what a restore or a check leaves free on a volume
// that takes data or log files: usually the volume of the live databases,
// whose autogrowth must keep working while the copy exists. It is the larger
// of ReserveBytes and a tenth of the volume (ReserveBytes when its size is
// unknown).
func LiveVolumeReserve(total uint64) uint64 {
	return max(uint64(ReserveBytes), total/10)
}

// EstimateBackupBytes is what the full of a database needs in the staging
// folder: its used pages plus the used log, plus 10 percent. Unknown parts
// count with the size of the files.
func EstimateBackupBytes(db InventoryDB) int64 {
	used := db.UsedBytes
	if used < 0 {
		used = db.SizeBytes
	}
	log := db.LogUsedBytes
	if log < 0 {
		log = 0
	}
	n := used + log
	return n + n/10
}

// SpacePlan says which databases fit into the staging folder one after
// another (the files stay until the snapshot is done).
type SpacePlan struct {
	Fit []InventoryDB
	// TooSmall are those that did not fit, with what they need.
	TooSmall []api.SQLDatabaseResult
}

// PlanSpace plans the staging space cumulatively: a database fits while
// everything planned before it plus its estimate plus ReserveBytes is free.
// A database that does not fit is skipped (sql_staging_too_small); the
// databases after it may still fit.
func PlanSpace(free uint64, where string, dbs []InventoryDB) SpacePlan {
	var p SpacePlan
	var planned int64
	for _, db := range dbs {
		need := EstimateBackupBytes(db)
		if uint64(planned+need+ReserveBytes) <= free {
			planned += need
			p.Fit = append(p.Fit, db)
			continue
		}
		left := int64(free) - planned - ReserveBytes
		if left < 0 {
			left = 0
		}
		p.TooSmall = append(p.TooSmall, api.SQLDatabaseResult{
			Name: db.Name, FamilyGUID: db.FamilyGUID, DatabaseGUID: db.DatabaseGUID, RecoveryModel: db.RecoveryModel,
			Outcome: api.SQLSkipped, Code: api.SQLStagingTooSmall,
			Message: BoundMessage(fmt.Sprintf("%s was not backed up: its backup needs about %s in the staging folder and %s has %s free after the databases before it. Free space there or set another staging folder in the backup job.",
				db.Name, GiBText(need), where, GiBText(left))),
		})
	}
	return p
}

// GiBText writes bytes as GiB with one decimal (0.6 GiB, 40.0 GiB).
func GiBText(n int64) string { return fmt.Sprintf("%.1f GiB", float64(n)/float64(GiB)) }

// SpaceNeed is what restoring a backup needs: the backup file in the
// restore staging folder, the data files (D, and FILESTREAM or full-text
// containers) in the data folder, the log files in the log folder.
type SpaceNeed struct {
	Bak, Data, Log int64
}

// NeedOf adds up the file list of a backup.
func NeedOf(bak int64, files []api.SQLFile) SpaceNeed {
	n := SpaceNeed{Bak: bak}
	for _, f := range files {
		if f.Type == "L" {
			n.Log += f.SizeBytes
		} else {
			n.Data += f.SizeBytes
		}
	}
	return n
}

// ---- check copies -------------------------------------------------------------

// VerifyMarker is part of every check copy's name.
const VerifyMarker = "__restow_verify_"

// maxVerifyPrefixRunes bounds the database part of a check name (with the
// marker and the time the name stays far below SQL Server's 128).
const maxVerifyPrefixRunes = 80

var verifyNameRe = regexp.MustCompile(`^(?s:.{1,` + fmt.Sprint(maxVerifyPrefixRunes) + `})` + VerifyMarker + `\d{8}T\d{6}Z$`)

// VerifyName is the name of the check copy of db at t:
// <first 80 runes of db>__restow_verify_<yyyymmddThhmmssZ>.
func VerifyName(db string, t time.Time) string {
	r := []rune(db)
	if len(r) > maxVerifyPrefixRunes {
		r = r[:maxVerifyPrefixRunes]
	}
	return string(r) + VerifyMarker + TimeStamp(t)
}

// IsVerifyName reports whether name has the form VerifyName gives. It alone
// never decides a drop: the name must also be in the journal (C7).
func IsVerifyName(name string) bool {
	return utf8.ValidString(name) && verifyNameRe.MatchString(name)
}

// ValidNewName checks the name of a restore under a new name: 1 to 128
// runes, no control character, no system database, no check marker.
func ValidNewName(name string) error {
	n := utf8.RuneCountInString(name)
	switch {
	case !utf8.ValidString(name) || n == 0 || n > api.MaxSQLNameRunes:
		return errors.New("the new name must have 1 to 128 characters")
	case strings.IndexFunc(name, func(r rune) bool { return r < 0x20 }) >= 0:
		return errors.New("the new name contains a control character")
	case strings.Contains(name, VerifyMarker):
		return fmt.Errorf("the new name must not contain %s (the marker of check copies)", VerifyMarker)
	}
	for _, sys := range []string{"master", "model", "msdb", "tempdb"} {
		if strings.EqualFold(name, sys) {
			return fmt.Errorf("the new name must not be that of the system database %s", sys)
		}
	}
	return nil
}

// ---- restore targets ------------------------------------------------------------

// MoveSuffix is the 8 hex characters that make the files of one restore
// unique: from the new name and the run.
func MoveSuffix(newName, runID string) string {
	sum := sha256.Sum256([]byte(newName + "\x00" + runID))
	return hex.EncodeToString(sum[:])[:8]
}

// MoveTargets decides where each file of a backup goes when it is restored
// as newName: <SafeName(newName)>_<suffix>_<fileId> plus .mdf (the primary
// data file), .ndf (other data files), .ldf (log), _fs (FILESTREAM or
// memory-optimized container) or _ft (full-text catalog), in the instance's
// default data or log folder. The names never collide with existing files of
// other databases (suffix) and never come from the backup's own paths.
func MoveTargets(newName, suffix string, files []api.SQLFile, dataDir, logDir string) ([]api.SQLMove, error) {
	if len(files) == 0 {
		return nil, errors.New("the backup lists no files")
	}
	if len(files) > api.MaxSQLFileList {
		return nil, fmt.Errorf("the backup lists %d files, more than %d", len(files), api.MaxSQLFileList)
	}
	if dataDir == "" {
		return nil, errors.New("the instance names no default data folder")
	}
	if logDir == "" {
		logDir = dataDir
	}
	base := SafeName(newName, 64) + "_" + suffix
	seenID := map[int64]bool{}
	moves := make([]api.SQLMove, 0, len(files))
	for _, f := range files {
		if f.LogicalName == "" || seenID[f.FileID] {
			return nil, fmt.Errorf("the file list of the backup is not valid (file %d)", f.FileID)
		}
		seenID[f.FileID] = true
		name := fmt.Sprintf("%s_%d", base, f.FileID)
		dir := dataDir
		switch f.Type {
		case "D":
			if f.FileID == 1 {
				name += ".mdf"
			} else {
				name += ".ndf"
			}
		case "L":
			name += ".ldf"
			dir = logDir
		case "S":
			name += "_fs"
		case "F":
			name += "_ft"
		default:
			return nil, fmt.Errorf("the backup lists a file of the unknown type %q", f.Type)
		}
		moves = append(moves, api.SQLMove{LogicalName: f.LogicalName, PhysicalName: joinWindows(dir, name)})
	}
	return moves, nil
}

// joinWindows joins a folder SQL Server named and a file name with the
// folder's own separator (SQL Server on Windows names C:\...\DATA\).
func joinWindows(dir, name string) string {
	sep := `\`
	if strings.HasPrefix(dir, "/") {
		sep = "/"
	}
	return strings.TrimRight(dir, `\/`) + sep + name
}

// ---- time limits ------------------------------------------------------------------

// StepTimeout is the limit of one statement for a database with used bytes:
// one hour plus one hour per started 50 GiB, at most 48 hours.
func StepTimeout(used int64) time.Duration {
	if used < 0 {
		used = 0
	}
	per := 50 * GiB
	d := time.Hour + time.Duration((used+per-1)/per)*time.Hour
	return min(d, 48*time.Hour)
}

// ---- exclusions of the file backup -------------------------------------------------

// FileBackupExcludes are the files of the databases the native backup
// covers (and of tempdb): while it is on, the file backup leaves them out,
// because a copy of an open database file has no value (C8). The folders
// around them are kept, they may hold other data, and so are the files of a
// database the job leaves out of the native backup.
func FileBackupExcludes(inv *Inventory, cfg *api.SQLConfig) []string {
	if inv == nil || cfg == nil || !cfg.Enabled {
		return nil
	}
	seen := map[string]bool{}
	var out []string
	for _, inst := range inv.Instances {
		if inst.Result == nil || !cfg.Instances.Includes(inst.Fact.Name) {
			continue
		}
		for _, db := range inst.Result.Databases {
			if db.Snapshot || (!strings.EqualFold(db.Name, "tempdb") && !selected(cfg, inst.Fact.Name, db.Name)) {
				continue
			}
			for _, f := range db.Files {
				p := strings.TrimSpace(f.PhysicalName)
				if p == "" || seen[strings.ToLower(p)] {
					continue
				}
				seen[strings.ToLower(p)] = true
				out = append(out, p)
			}
		}
	}
	sort.Strings(out)
	return out
}

// ---- staging folder -----------------------------------------------------------------

// VolumeFacts describe the volume and the path of a folder.
type VolumeFacts struct {
	// Root is the volume's root (E:\).
	Root string
	// Fixed: a local fixed disk (no network, no removable media).
	Fixed bool
	// FileSystem is NTFS, ReFS, FAT32, ...
	FileSystem string
	// ReparseAt is the first existing part of the path that is a reparse
	// point (junction, symbolic link, mounted folder); "" when none.
	ReparseAt string
	// TotalBytes is the size of the volume; 0 when unknown.
	TotalBytes uint64
}

// windowsAbs matches X:\ followed by something.
var windowsAbs = regexp.MustCompile(`^[A-Za-z]:\\[^\x00-\x1f"*?<>|:]+$`)

// ValidateStagingDir checks a custom staging folder (C8): an absolute path
// on a local fixed NTFS disk, without a reparse point on its way, not below
// the Windows folder or a Program Files folder. blocked are those folders.
func ValidateStagingDir(dir string, vol VolumeFacts, blocked []string) error {
	if !windowsAbs.MatchString(dir) || strings.Contains(dir, `\..`) || strings.Contains(dir, `\.\`) {
		return fmt.Errorf("the staging folder %q is not an absolute local path such as E:\\SqlStaging", dir)
	}
	if !vol.Fixed {
		return fmt.Errorf("the staging folder %q is not on a local fixed disk", dir)
	}
	if !strings.EqualFold(vol.FileSystem, "NTFS") {
		return fmt.Errorf("the staging folder %q is on a %s volume; it has to be NTFS", dir, orUnknown(vol.FileSystem))
	}
	if vol.ReparseAt != "" {
		return fmt.Errorf("the staging folder %q passes the link or mount point %s", dir, vol.ReparseAt)
	}
	clean := strings.ToLower(strings.TrimRight(dir, `\`)) + `\`
	for _, b := range blocked {
		if b == "" {
			continue
		}
		prefix := strings.ToLower(strings.TrimRight(b, `\`)) + `\`
		if strings.HasPrefix(clean, prefix) {
			return fmt.Errorf("the staging folder %q lies in the system folder %s", dir, b)
		}
	}
	if len(clean) <= 4 { // X:\ itself
		return fmt.Errorf("the staging folder %q is the root of a drive; use a folder on it", dir)
	}
	return nil
}

func orUnknown(s string) string {
	if s == "" {
		return "unknown"
	}
	return s
}

// ---- versions -------------------------------------------------------------------------

// TestedMajors are the SQL Server releases W2a supports (2016 to 2025).
var TestedMajors = map[int]string{13: "2016", 14: "2017", 15: "2019", 16: "2022", 17: "2025"}

// MajorOf reads the major version of a ProductVersion such as 16.0.4135.4.
func MajorOf(version string) int {
	n := 0
	for i := 0; i < len(version) && version[i] >= '0' && version[i] <= '9'; i++ {
		n = n*10 + int(version[i]-'0')
		if n > 1000 {
			return 0
		}
	}
	return n
}

// ValidInstanceName is the rule of the registry facts.
func ValidInstanceName(name string) bool { return sysinfo.ValidSQLInstanceName(name) }
