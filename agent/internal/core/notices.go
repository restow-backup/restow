package core

import (
	"log/slog"
	"strings"

	"github.com/restow-backup/restow/agent/internal/api"
	"github.com/restow-backup/restow/agent/internal/paths"
	"github.com/restow-backup/restow/agent/internal/sqlserver"
)

// The fixed warnings of a run (W1, docs/BAREMETAL-WINDOWS.md 1.3): a file
// backup copies the files of open databases, but that is no backup SQL
// Server, Exchange, Active Directory or Hyper-V can be brought back from.
// The warning names what this machine runs; the SQL Server part disappears
// once the native SQL Server backup covers every database.

// appSubjects are the subjects of app_files_not_app_backup, in this order,
// with the name each has in the message.
var appSubjects = []struct{ subject, name string }{
	{api.SubjectSQLServer, "SQL Server"},
	{api.SubjectExchange, "Exchange"},
	{api.SubjectActiveDirectory, "Active Directory"},
	{api.SubjectHyperV, "Hyper-V"},
}

// sqlCoversAll: the native backup is on for every instance and database.
func sqlCoversAll(cfg *api.SQLConfig, active bool) bool {
	return active && cfg != nil && cfg.Enabled && cfg.Mode == api.SQLModeAlongside &&
		cfg.Instances.All && cfg.Databases.All && len(cfg.Exclude) == 0
}

// AppFileNotices is the notice of a file backup on a machine with such a
// role; nil without one.
func AppFileNotices(w *api.WindowsFacts, sql *api.SQLConfig, sqlActive bool) []api.Notice {
	if w == nil {
		return nil
	}
	has := map[string]bool{
		api.SubjectSQLServer:       w.Roles.SQLServer && !sqlCoversAll(sql, sqlActive),
		api.SubjectExchange:        w.Roles.Exchange,
		api.SubjectActiveDirectory: w.Roles.DomainController,
		api.SubjectHyperV:          w.Roles.HyperV,
	}
	var subjects, names []string
	for _, s := range appSubjects {
		if has[s.subject] {
			subjects = append(subjects, s.subject)
			names = append(names, s.name)
		}
	}
	if len(subjects) == 0 {
		return nil
	}
	return []api.Notice{{Code: api.NoticeAppFilesNotAppBackup, Subjects: subjects,
		Message: "Files of open databases are not a restorable " + orList(names) + " backup."}}
}

// orList writes a, b or c.
func orList(names []string) string {
	if len(names) < 2 {
		return strings.Join(names, "")
	}
	return strings.Join(names[:len(names)-1], ", ") + " or " + names[len(names)-1]
}

// capNotices keeps at most api.MaxNotices notices with bounded messages.
func capNotices(ns []api.Notice) []api.Notice {
	if len(ns) > api.MaxNotices {
		ns = ns[:api.MaxNotices]
	}
	for i := range ns {
		ns[i].Message = sqlserver.BoundMessage(ns[i].Message)
	}
	return ns
}

// defaultSQLSupport is the native SQL Server backup of this system: the
// script runner and the file system of Windows (sqlserver.ErrUnsupported
// on every other system).
func defaultSQLSupport(l paths.Layout, log *slog.Logger) func() (*SQLSupport, error) {
	return func() (*SQLSupport, error) {
		r, err := sqlserver.NewScriptRunner(l.TmpDir(), func(stderr string) {
			log.Warn("the SQL Server script wrote error output", "stderr", stderr)
		})
		if err != nil {
			return nil, err
		}
		fs, err := sqlserver.NewFS()
		if err != nil {
			return nil, err
		}
		return &SQLSupport{Runner: r, FS: fs}, nil
	}
}
