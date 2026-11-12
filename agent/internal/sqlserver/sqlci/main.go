//go:build sqlci

// Command sqlci is the CI probe of the native SQL Server backup
// (docs/BAREMETAL-WINDOWS.md 8.2, CI job windows-sql). It is never part of a
// release. agent/scripts/test-sql-windows.ps1 registers it as the service
// RestowSqlCi with an unrestricted service SID, so it reaches SQL Server
// exactly as the agent does: as LocalSystem with the service SID
// NT SERVICE\RestowSqlCi, over Shared Memory with integrated authentication.
// It reads one job from -in, runs the flows of internal/sqlserver with the
// real script runner, file system and restic against a local repository,
// and writes the reports of the contract to -out:
//
//	{"op":"inventory"|"backup"|"verify"|"restore"|"restore-script-input", "instance":"SQLEXPRESS",
//	 "workDir":"C:\\ci\\work", "resticBinary":"...\\restic.exe", "repository":"C:\\ci\\repo",
//	 "passwordFile":"C:\\ci\\repo.pw", "databases":["RestowCi"], "from":"C:\\ci\\backup.json",
//	 "database":"RestowCi", "newName":"RestowCi_restored", "targetInstance":"RESTOWB",
//	 "checkdb":true, "endpointId":"ci", "hostname":"sql-ci"}
//
// restore-script-input writes the input of the restore script generator
// (scripts/ci/render-sql-restore-script.mts) for one database of an earlier
// backup.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/restow-backup/restow/agent/internal/api"
	"github.com/restow-backup/restow/agent/internal/restic"
	"github.com/restow-backup/restow/agent/internal/sqlserver"
	"github.com/restow-backup/restow/agent/internal/sysinfo"
	"github.com/restow-backup/restow/agent/internal/winsvc"
)

type job struct {
	Op             string   `json:"op"`
	Instance       string   `json:"instance"`
	WorkDir        string   `json:"workDir"`
	ResticBinary   string   `json:"resticBinary"`
	Repository     string   `json:"repository"`
	PasswordFile   string   `json:"passwordFile"`
	Databases      []string `json:"databases"`
	From           string   `json:"from"`
	Database       string   `json:"database"`
	NewName        string   `json:"newName"`
	TargetInstance string   `json:"targetInstance"`
	Checkdb        bool     `json:"checkdb"`
	EndpointID     string   `json:"endpointId"`
	Hostname       string   `json:"hostname"`
	StagingDir     string   `json:"stagingDir"`
}

type result struct {
	Op         string                `json:"op"`
	Status     string                `json:"status"`
	SnapshotID string                `json:"snapshotId,omitempty"`
	Errors     []api.RunError        `json:"errors"`
	Notices    []api.Notice          `json:"notices,omitempty"`
	SQL        *api.SQLRunReport     `json:"sql,omitempty"`
	SQLVerify  *api.SQLVerifyReport  `json:"sqlVerify,omitempty"`
	SQLRestore *api.SQLRestoreReport `json:"sqlRestore,omitempty"`
	Inventory  *api.SQLInventory     `json:"sqlInventory,omitempty"`
	// RestoreScriptInput is the RestoreScriptInput of packages/core.
	RestoreScriptInput map[string]any `json:"restoreScriptInput,omitempty"`
	Log                []string       `json:"log"`
}

type ciLog struct{ lines []string }

func (l *ciLog) add(level, f string, a ...any) {
	l.lines = append(l.lines, time.Now().UTC().Format(time.RFC3339)+" "+level+" "+fmt.Sprintf(f, a...))
}
func (l *ciLog) Infof(f string, a ...any)  { l.add("INFO", f, a...) }
func (l *ciLog) Warnf(f string, a ...any)  { l.add("WARN", f, a...) }
func (l *ciLog) Errorf(f string, a ...any) { l.add("ERROR", f, a...) }

func main() {
	in := flag.String("in", "", "job file (JSON)")
	out := flag.String("out", "", "result file (JSON)")
	service := flag.Bool("service", false, "run as the service RestowSqlCi")
	flag.Parse()
	if *in == "" || *out == "" {
		fmt.Fprintln(os.Stderr, "usage: sqlci [-service] -in job.json -out result.json")
		os.Exit(2)
	}
	if *service {
		err := winsvc.Run("RestowSqlCi", func(ctx context.Context) winsvc.Exit {
			if err := runJob(ctx, *in, *out); err != nil {
				_ = os.WriteFile(*out+".error", []byte(err.Error()), 0o644)
				return winsvc.Exit{Code: 1066, Specific: 1}
			}
			return winsvc.Exit{}
		})
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	if err := runJob(context.Background(), *in, *out); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func runJob(ctx context.Context, inPath, outPath string) error {
	b, err := os.ReadFile(inPath)
	if err != nil {
		return err
	}
	var j job
	if err := json.Unmarshal(b, &j); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Hour)
	defer cancel()
	res, err := run(ctx, j)
	if err != nil {
		return err
	}
	data, err := json.MarshalIndent(res, "", "  ")
	if err != nil {
		return err
	}
	tmp := outPath + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, outPath)
}

func instanceFact(name string) (api.SQLInstanceFact, error) {
	w := sysinfo.DetectMachine().Windows
	if w != nil {
		for _, f := range w.SQLInstances {
			if strings.EqualFold(f.Name, name) {
				return f, nil
			}
		}
	}
	return api.SQLInstanceFact{}, fmt.Errorf("SQL Server instance %s is not in the registry", name)
}

func env(j job, log *ciLog) (*sqlserver.Env, error) {
	runner, err := sqlserver.NewScriptRunner(filepath.Join(j.WorkDir, "tmp"), func(s string) { log.Warnf("script stderr: %s", s) })
	if err != nil {
		return nil, err
	}
	fs, err := sqlserver.NewFS()
	if err != nil {
		return nil, err
	}
	pw, err := os.ReadFile(j.PasswordFile)
	if err != nil {
		return nil, err
	}
	r := &restic.Runner{Bin: j.ResticBinary, Repo: j.Repository, Password: strings.TrimSpace(string(pw)),
		CacheDir: filepath.Join(j.WorkDir, "cache"), TmpDir: filepath.Join(j.WorkDir, "restic-tmp"), Log: func(l string) { log.Infof("restic: %s", l) }}
	for _, d := range []string{r.CacheDir, r.TmpDir} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			return nil, err
		}
	}
	e := &sqlserver.Env{Runner: runner, FS: fs, Restic: r, Log: log, Host: j.Hostname,
		StagingRoot: filepath.Join(j.WorkDir, "staging", "sql"), RestoreRoot: filepath.Join(j.WorkDir, "staging", "sql-restore"),
		JournalPath: filepath.Join(j.WorkDir, "sql-verify-journal.json")}
	if j.StagingDir != "" {
		e.StagingRoot, e.CustomStaging = j.StagingDir, true
	}
	return e, nil
}

// previous reads the result of an earlier backup job.
func previous(j job) (*result, error) {
	b, err := os.ReadFile(j.From)
	if err != nil {
		return nil, err
	}
	var r result
	if err := json.Unmarshal(b, &r); err != nil {
		return nil, err
	}
	if r.SQL == nil || r.SnapshotID == "" {
		return nil, errors.New("the earlier job holds no SQL Server backup")
	}
	return &r, nil
}

func backupOf(prev *result, db string) (*api.SQLBackupFacts, error) {
	for _, d := range prev.SQL.Databases {
		if d.Name == db && d.Backup != nil {
			return d.Backup, nil
		}
	}
	return nil, fmt.Errorf("the earlier backup has no backup of %s", db)
}

func run(ctx context.Context, j job) (*result, error) {
	log := &ciLog{}
	res := &result{Op: j.Op, Errors: []api.RunError{}}
	defer func() { res.Log = log.lines }()
	if j.Op == "restore-script-input" {
		prev, err := previous(j)
		if err != nil {
			return nil, err
		}
		b, err := backupOf(prev, j.Database)
		if err != nil {
			return nil, err
		}
		res.Status = api.StatusSucceeded
		res.RestoreScriptInput = map[string]any{
			"endpointId": j.EndpointID, "hostname": j.Hostname, "instance": prev.SQL.Instance, "database": j.Database,
			"backup": map[string]any{"snapshotId": prev.SnapshotID, "pathInSnapshot": b.PathInSnapshot, "sha256": b.SHA256, "bytes": b.Bytes,
				"firstLsn": b.FirstLSN, "lastLsn": b.LastLSN, "backupFinish": b.BackupFinish, "fileList": b.FileList},
			"repositoryHint": "the local CI repository " + j.Repository,
		}
		return res, nil
	}
	fact, err := instanceFact(j.Instance)
	if err != nil {
		return nil, err
	}
	e, err := env(j, log)
	if err != nil {
		return nil, err
	}
	switch j.Op {
	case "inventory":
		inv := sqlserver.CollectInventory(ctx, e.Runner, []api.SQLInstanceFact{fact}, time.Now())
		res.Inventory = inv.Wire()
		res.Status = api.StatusSucceeded
		if p := inv.Instances[0].Problem; p != nil {
			res.Status = api.StatusFailed
			res.Errors = append(res.Errors, api.RunError{Code: p.Code, Message: p.Message})
		}
	case "backup":
		cfg := &api.SQLConfig{Enabled: true, Mode: api.SQLModeAlongside, Instances: api.SQLInstanceSelection{All: true},
			Databases: api.SQLDatabaseSelection{All: true}}
		if len(j.Databases) > 0 {
			cfg.Databases = api.SQLDatabaseSelection{}
			for _, d := range j.Databases {
				cfg.Databases.List = append(cfg.Databases.List, api.SQLDatabaseRef{Name: d})
			}
		}
		o := e.BackupInstance(ctx, cfg, fact)
		res.Status, res.SnapshotID, res.Errors, res.Notices, res.SQL = o.Status, o.SnapshotID, append(res.Errors, o.Errors...), o.Notices, o.Report
		if o.Inventory != nil {
			inv := &sqlserver.Inventory{CollectedAt: time.Now().UTC(), Instances: []sqlserver.InstanceInventory{*o.Inventory}}
			res.Inventory = inv.Wire()
		}
	case "verify":
		prev, err := previous(j)
		if err != nil {
			return nil, err
		}
		p := api.SQLVerifyParams{Instance: fact.Name, MaxGiB: 200}
		for i, d := range prev.SQL.Databases {
			if d.Backup == nil || (len(j.Databases) > 0 && !contains(j.Databases, d.Name)) {
				continue
			}
			p.Databases = append(p.Databases, api.SQLVerifyDatabase{DatabaseID: fmt.Sprintf("ci-%d", i), BackupID: fmt.Sprintf("ci-%d", i),
				Name: d.Name, SnapshotID: prev.SnapshotID, PathInSnapshot: d.Backup.PathInSnapshot, SHA256: d.Backup.SHA256,
				Bytes: d.Backup.Bytes, FileList: d.Backup.FileList})
		}
		o := e.Verify(ctx, p, fact, "ci-verify-"+time.Now().UTC().Format("150405"))
		res.Status, res.Errors, res.SQLVerify = o.Status, append(res.Errors, o.Errors...), o.Report
	case "restore":
		prev, err := previous(j)
		if err != nil {
			return nil, err
		}
		b, err := backupOf(prev, j.Database)
		if err != nil {
			return nil, err
		}
		target := fact
		if j.TargetInstance != "" {
			if target, err = instanceFact(j.TargetInstance); err != nil {
				return nil, err
			}
		}
		o := e.Restore(ctx, api.SQLRestoreParams{BackupID: "ci", Instance: fact.Name, TargetInstance: target.Name, Database: j.Database,
			NewName: j.NewName, SnapshotID: prev.SnapshotID, PathInSnapshot: b.PathInSnapshot, SHA256: b.SHA256, Bytes: b.Bytes,
			FileList: b.FileList, Checkdb: j.Checkdb, MaxGiB: 200}, target, "ci-restore")
		res.Status, res.Errors, res.SQLRestore = o.Status, append(res.Errors, o.Errors...), o.Report
	default:
		return nil, fmt.Errorf("unknown op %q", j.Op)
	}
	return res, nil
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}
