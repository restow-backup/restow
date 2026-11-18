package api

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"time"
)

// MaxDBFactsBody is the body limit of POST /agent/v1/databases/probes/:id/result
// and POST /agent/v1/databases/health/:taskId/samples (apps/api
// middleware/body-limit.ts, DATABASE_FACTS_BODY_LIMIT): up to 1000 databases
// and the grants of a MySQL user (at most 1 MiB in all) fit with room to
// spare. FitDBProbeResult makes what the agent sends fit.
const MaxDBFactsBody = 4 << 20

// encodedLen is the size of v as the client sends it.
func encodedLen(v any) int {
	b, err := json.Marshal(v)
	if err != nil {
		return int(^uint(0) >> 1)
	}
	return len(b)
}

// FitDBProbeResult shrinks r until it encodes in at most limit bytes: first
// the lines of SHOW GRANTS from the end (GrantsTruncated, so the server rates
// no right as missing), then the sizes of a health check (as if none were
// read). What still does not fit is replaced by an error without facts, so
// the server answers the test or the check instead of refusing the body.
func FitDBProbeResult(r *DBProbeResult, limit int) {
	if encodedLen(r) <= limit {
		return
	}
	if r.MySQL != nil && len(r.MySQL.Grants) > 0 {
		grants := r.MySQL.Grants
		r.MySQL.GrantsTruncated = true
		// The most lines that fit (none may).
		lo, hi := 0, len(grants)
		for lo < hi {
			mid := (lo + hi + 1) / 2
			r.MySQL.Grants = grants[:mid]
			if encodedLen(r) <= limit {
				lo = mid
			} else {
				hi = mid - 1
			}
		}
		r.MySQL.Grants = grants[:lo]
		if encodedLen(r) <= limit {
			return
		}
	}
	if r.Health != nil && r.Health.Databases != nil {
		r.Health.Databases = nil
		if encodedLen(r) <= limit {
			return
		}
	}
	*r = DBProbeResult{
		Engine: r.Engine, Port: r.Port, TLS: r.TLS, Login: "skipped",
		Error:      &DBProbeError{Code: "db_probe_failed", Message: "the facts were too large to report"},
		DurationMs: r.DurationMs,
	}
}

// The module "Databases" (docs/DATABASES.md, stage D1): the agent tests a
// connection for the server ("Test connection") and reports the database
// instances its inventory finds. The fixtures in testdata/contract/db-*.json
// are the contract with the server (@restow/core databases/facts.ts reads
// the same files).

// TaskDBHealth hands the agent the health checks of the connections it runs
// (D2, docs/DATABASES.md 8): it fetches them once with their credentials,
// runs each one when due within the window and posts the samples. It ends on
// delivery; a newer one replaces the running one.
const TaskDBHealth = "db_health"

// DBHealthTaskParams are the parameters of a db_health task.
type DBHealthTaskParams struct {
	WindowSeconds int `json:"windowSeconds"`
}

// DBHealthCheck is one connection of a health task.
type DBHealthCheck struct {
	ConnectionID      string      `json:"connectionId"`
	FirstAfterSeconds int         `json:"firstAfterSeconds"`
	IntervalSeconds   int         `json:"intervalSeconds"`
	Spec              DBProbeSpec `json:"spec"`
}

// DBHealthPlan is what GET /agent/v1/databases/health/:taskId returns, once.
type DBHealthPlan struct {
	TaskID        string          `json:"taskId"`
	WindowSeconds int             `json:"windowSeconds"`
	Checks        []DBHealthCheck `json:"checks"`
}

// DBHealthSample is one check as the agent reports it.
type DBHealthSample struct {
	ConnectionID string        `json:"connectionId"`
	At           time.Time     `json:"at"`
	Result       DBProbeResult `json:"result"`
}

// DBHealthSamples is the body of POST /agent/v1/databases/health/:taskId/samples.
type DBHealthSamples struct {
	Samples []DBHealthSample `json:"samples"`
}

// TaskDBBackup and TaskDBRestore are a backup or restore run of a database
// connection (D3, docs/DATABASES.md 4.3): the agent fetches the run once
// with its credentials and repository access and reports its outcome. They
// end on delivery.
const (
	TaskDBBackup  = "db_backup"
	TaskDBRestore = "db_restore"
)

// DBRunTaskParams are the parameters of a db_backup or db_restore task.
type DBRunTaskParams struct {
	RunID string `json:"runId"`
}

// DBRunConnection is the connection a run signs in to (the target's for a restore).
type DBRunConnection struct {
	ConnectionID            string  `json:"connectionId"`
	Engine                  string  `json:"engine"`
	Host                    *string `json:"host"`
	Port                    *int    `json:"port"`
	LoginDatabase           *string `json:"loginDatabase"`
	AuthMethod              string  `json:"authMethod"`
	User                    *string `json:"user"`
	Password                *string `json:"password"`
	AllowUnencrypted        bool    `json:"allowUnencrypted"`
	PinnedFingerprintSHA256 *string `json:"pinnedFingerprintSha256"`
	InstanceKey             *string `json:"instanceKey"`
	Selection               struct {
		Mode    string   `json:"mode"`
		Names   []string `json:"names"`
		Exclude []string `json:"exclude"`
	} `json:"selection"`
}

// DBRunRepository is the restic access of a backup run: the connection's
// repository through the run's own REST credential (append only). A restore
// run gets none: it reads its one dump from the server (StreamDBRunDump).
type DBRunRepository struct {
	URL                string `json:"url"`
	Username           string `json:"username"`
	Password           string `json:"password"`
	RepositoryPassword string `json:"repositoryPassword"`
}

// DBRunRestore is what a restore run plays back, and under which name.
type DBRunRestore struct {
	FileName   string `json:"fileName"`
	SHA256     string `json:"sha256"`
	TargetName string `json:"targetName"`
}

// DBRunSpec is what GET /agent/v1/databases/runs/:runId returns, once.
type DBRunSpec struct {
	RunID              string           `json:"runId"`
	Kind               string           `json:"kind"`
	Connection         DBRunConnection  `json:"connection"`
	Repository         *DBRunRepository `json:"repository"`
	Restore            *DBRunRestore    `json:"restore"`
	MaxDurationSeconds int              `json:"maxDurationSeconds"`
}

// DBRunInstance is what a run found of the instance.
type DBRunInstance struct {
	SystemIdentifier string `json:"systemIdentifier"`
	ServerVersion    string `json:"serverVersion"`
	Databases        []struct {
		Name string `json:"name"`
		OID  string `json:"oid"`
	} `json:"databases"`
}

// DBRunBackup is one snapshot a backup run wrote.
type DBRunBackup struct {
	Kind        string         `json:"kind"`
	Name        string         `json:"name"`
	OID         *string        `json:"oid"`
	SnapshotID  string         `json:"snapshotId"`
	FileName    string         `json:"fileName"`
	SHA256      string         `json:"sha256"`
	Bytes       int64          `json:"bytes"`
	Objects     map[string]int `json:"objects"`
	StartedAt   time.Time      `json:"startedAt"`
	FinishedAt  time.Time      `json:"finishedAt"`
	ToolVersion *string        `json:"toolVersion"`
}

// DBRunFinish is the body of POST /agent/v1/databases/runs/:runId/finish.
type DBRunFinish struct {
	Status    string           `json:"status"`
	Error     *DBProbeError    `json:"error"`
	Instance  *DBRunInstance   `json:"instance"`
	Backups   []DBRunBackup    `json:"backups"`
	Notes     []map[string]any `json:"notes"`
	TargetOID *string          `json:"targetOid"`
}

// FetchDBRun fetches a run with its credentials; the server hands them out once.
func (c *Client) FetchDBRun(ctx context.Context, runID string) (*DBRunSpec, error) {
	var out DBRunSpec
	once := RetryPolicy{MaxAttempts: 2, BaseDelay: time.Second, MaxDelay: 5 * time.Second}
	if err := c.do(ctx, call{method: http.MethodGet, path: "/agent/v1/databases/runs/" + url.PathEscape(runID), out: &out, retry: &once}); err != nil {
		return nil, err
	}
	return &out, nil
}

// dumpBusyRetries and dumpBusyWait: the server takes a restore's dump only
// while it has a download slot free (429); the agent waits for one.
var (
	dumpBusyRetries = 10
	dumpBusyWait    = 30 * time.Second
)

// StreamDBRunDump writes the dump of a restore run into w, as the server reads
// it from the source connection's repository. A busy server (429) is asked
// again before anything was written; once bytes flowed, no retry: the
// restore starts over as a new run.
func (c *Client) StreamDBRunDump(ctx context.Context, runID string, w io.Writer) error {
	path := "/agent/v1/databases/runs/" + url.PathEscape(runID) + "/dump"
	for attempt := 0; ; attempt++ {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.base.String()+path, nil)
		if err != nil {
			return err
		}
		c.decorate(req, false)
		req.Header.Set("Accept", "application/octet-stream")
		resp, err := c.http.Do(req)
		if err != nil {
			return err
		}
		if resp.StatusCode == http.StatusTooManyRequests && attempt < dumpBusyRetries {
			_ = resp.Body.Close()
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(dumpBusyWait):
			}
			continue
		}
		if resp.StatusCode != http.StatusOK {
			_ = resp.Body.Close()
			return &APIError{Method: http.MethodGet, Path: path, Status: resp.StatusCode, Title: http.StatusText(resp.StatusCode)}
		}
		_, err = io.Copy(w, resp.Body)
		_ = resp.Body.Close()
		return err
	}
}

// FinishDBRun reports a run's outcome.
func (c *Client) FinishDBRun(ctx context.Context, runID string, finish DBRunFinish) error {
	retry := RetryPolicy{MaxAttempts: 5, BaseDelay: 2 * time.Second, MaxDelay: 30 * time.Second}
	if finish.Backups == nil {
		finish.Backups = []DBRunBackup{}
	}
	if finish.Notes == nil {
		finish.Notes = []map[string]any{}
	}
	return c.do(ctx, call{method: http.MethodPost, path: "/agent/v1/databases/runs/" + url.PathEscape(runID) + "/finish",
		body: finish, retry: &retry, idempotent: true, tolerate: []int{http.StatusNotFound}})
}

// TaskDBProbe is a connection test: the agent fetches the probe (with its
// credentials, once), runs it and posts the facts. It ends on delivery.
const TaskDBProbe = "db_probe"

// CapabilityDBRunner: the agent can run database connections (D1: tests and
// the inventory). Every agent from 0.6.0 sends it.
const CapabilityDBRunner = "db_runner_v1"

// MaxDBInventoryBytes bounds the inventory in a heartbeat.
const MaxDBInventoryBytes = 64 * 1024

// DBProbeTaskParams are the parameters of a db_probe task.
type DBProbeTaskParams struct {
	ProbeID string `json:"probeId"`
}

// DBProbeSpec is what GET /agent/v1/databases/probes/:id returns. User and
// Password are only ever held in memory.
type DBProbeSpec struct {
	ProbeID          string  `json:"probeId"`
	Engine           *string `json:"engine"`
	Host             *string `json:"host"`
	Port             *int    `json:"port"`
	Path             *string `json:"path"`
	Database         *string `json:"database"`
	AuthMethod       string  `json:"authMethod"`
	User             *string `json:"user"`
	Password         *string `json:"password"`
	AllowUnencrypted bool    `json:"allowUnencrypted"`
	TimeoutSeconds   int     `json:"timeoutSeconds"`
	// PinnedFingerprintSHA256 is the certificate the connection confirmed
	// ("AB:CD:..."): the probe stops right after the TLS handshake, before any
	// sign-in, when the server shows another one or no TLS. Health checks (D2)
	// always carry it for a connection with a confirmed certificate.
	PinnedFingerprintSHA256 *string `json:"pinnedFingerprintSha256,omitempty"`
	// Purpose is "probe" (a connection test, also when empty) or "health"
	// (the light health check of a stored connection, D2).
	Purpose string `json:"purpose,omitempty"`
	// Sizes asks a health check for the size of each database too.
	Sizes bool `json:"sizes,omitempty"`
}

// PurposeHealth is the Purpose of a health check.
const PurposeHealth = "health"

// DBTLSFacts is what the TLS session showed.
type DBTLSFacts struct {
	Offered           *bool   `json:"offered"`
	Used              bool    `json:"used"`
	FingerprintSHA256 *string `json:"fingerprintSha256"`
	Subject           *string `json:"subject"`
	Issuer            *string `json:"issuer"`
	NotAfter          *string `json:"notAfter"`
}

// DBProbeError is why a test did not get further.
type DBProbeError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// DBPostgresDatabase is one row of pg_database.
type DBPostgresDatabase struct {
	Name             string `json:"name"`
	OID              string `json:"oid"`
	AllowConnections bool   `json:"allowConnections"`
	CanConnect       bool   `json:"canConnect"`
	SizeBytes        *int64 `json:"sizeBytes"`
}

// DBPostgresFacts are the facts of a PostgreSQL sign-in.
type DBPostgresFacts struct {
	VersionNum       int                  `json:"versionNum"`
	Version          string               `json:"version"`
	CurrentUser      string               `json:"currentUser"`
	Superuser        bool                 `json:"superuser"`
	CreateDB         bool                 `json:"createDb"`
	Replication      bool                 `json:"replication"`
	ReadAllData      *bool                `json:"readAllData"`
	SystemIdentifier *string              `json:"systemIdentifier"`
	Databases        []DBPostgresDatabase `json:"databases"`
}

// DBMysqlDatabase is one schema.
type DBMysqlDatabase struct {
	Name      string `json:"name"`
	SizeBytes *int64 `json:"sizeBytes"`
}

// DBMysqlFacts are the facts of a MySQL or MariaDB sign-in.
type DBMysqlFacts struct {
	Version        string   `json:"version"`
	VersionComment *string  `json:"versionComment"`
	CurrentUser    string   `json:"currentUser"`
	Grants         []string `json:"grants"`
	// GrantsTruncated: a line of SHOW GRANTS was longer than 64 KiB or there
	// were more than 200; the server then calls no right missing.
	GrantsTruncated bool              `json:"grantsTruncated,omitempty"`
	ServerUUID      *string           `json:"serverUuid"`
	ServerID        *int64            `json:"serverId"`
	Datadir         *string           `json:"datadir"`
	LogBin          *bool             `json:"logBin"`
	BinlogFormat    *string           `json:"binlogFormat"`
	Databases       []DBMysqlDatabase `json:"databases"`
}

// DBSQLServerFacts are what a PRELOGIN answer says.
type DBSQLServerFacts struct {
	Version    *string `json:"version"`
	Encryption *string `json:"encryption"`
}

// DBSQLiteFacts describe an SQLite file.
type DBSQLiteFacts struct {
	Path       string  `json:"path"`
	SizeBytes  int64   `json:"sizeBytes"`
	PageSize   int     `json:"pageSize"`
	Inode      *string `json:"inode"`
	Device     *string `json:"device"`
	CreatedAt  *string `json:"createdAt"`
	ModifiedAt *string `json:"modifiedAt"`
}

// DBHealthDatabase is the size of one database a health check read.
type DBHealthDatabase struct {
	Name      string  `json:"name"`
	OID       *string `json:"oid"`
	SizeBytes *int64  `json:"sizeBytes"`
}

// DBHealthFacts are what a health check found besides the sign-in.
type DBHealthFacts struct {
	LatencyMs        int64              `json:"latencyMs"`
	StartedAt        *string            `json:"startedAt"`
	ConnectionsUsed  *int64             `json:"connectionsUsed"`
	ConnectionsMax   *int64             `json:"connectionsMax"`
	SystemIdentifier *string            `json:"systemIdentifier"`
	ServerUUID       *string            `json:"serverUuid"`
	ServerID         *int64             `json:"serverId"`
	Datadir          *string            `json:"datadir"`
	Databases        []DBHealthDatabase `json:"databases"`
}

// DBProbeResult is the body of POST /agent/v1/databases/probes/:id/result:
// facts only, the server judges them.
type DBProbeResult struct {
	Engine        *string           `json:"engine"`
	Port          *int              `json:"port"`
	ServerVersion *string           `json:"serverVersion"`
	TLS           DBTLSFacts        `json:"tls"`
	Login         string            `json:"login"`
	Error         *DBProbeError     `json:"error"`
	PostgreSQL    *DBPostgresFacts  `json:"postgresql,omitempty"`
	MySQL         *DBMysqlFacts     `json:"mysql,omitempty"`
	SQLServer     *DBSQLServerFacts `json:"sqlserver,omitempty"`
	SQLite        *DBSQLiteFacts    `json:"sqlite,omitempty"`
	Health        *DBHealthFacts    `json:"health,omitempty"`
	DurationMs    int64             `json:"durationMs"`
}

// DBInventoryInstance is one instance the inventory found on the machine.
type DBInventoryInstance struct {
	Engine    string  `json:"engine"`
	Source    string  `json:"source"`
	Name      string  `json:"name"`
	Version   *string `json:"version"`
	Port      *int    `json:"port"`
	Socket    *string `json:"socket"`
	Container *string `json:"container"`
	Running   *bool   `json:"running"`
}

// DBInventory is the field databaseInventory of a heartbeat.
type DBInventory struct {
	CollectedAt time.Time             `json:"collectedAt"`
	Instances   []DBInventoryInstance `json:"instances"`
}

// FetchDBProbe fetches a connection test with its credentials. The server
// hands them out once; a second call fails with 409.
func (c *Client) FetchDBProbe(ctx context.Context, probeID string) (*DBProbeSpec, error) {
	var out DBProbeSpec
	once := RetryPolicy{MaxAttempts: 2, BaseDelay: time.Second, MaxDelay: 5 * time.Second}
	if err := c.do(ctx, call{method: http.MethodGet, path: "/agent/v1/databases/probes/" + url.PathEscape(probeID), out: &out, retry: &once}); err != nil {
		return nil, err
	}
	return &out, nil
}

// FinishDBProbe posts the facts of a connection test.
func (c *Client) FinishDBProbe(ctx context.Context, probeID string, result DBProbeResult) error {
	FitDBProbeResult(&result, MaxDBFactsBody)
	retry := RetryPolicy{MaxAttempts: 5, BaseDelay: 2 * time.Second, MaxDelay: 30 * time.Second}
	return c.do(ctx, call{method: http.MethodPost, path: "/agent/v1/databases/probes/" + url.PathEscape(probeID) + "/result",
		body: result, retry: &retry, idempotent: true, tolerate: []int{http.StatusNotFound}})
}

// FetchDBHealth fetches the health checks of a db_health task with their
// credentials. The server hands them out once; a second call fails with 409.
func (c *Client) FetchDBHealth(ctx context.Context, taskID string) (*DBHealthPlan, error) {
	var out DBHealthPlan
	once := RetryPolicy{MaxAttempts: 2, BaseDelay: time.Second, MaxDelay: 5 * time.Second}
	if err := c.do(ctx, call{method: http.MethodGet, path: "/agent/v1/databases/health/" + url.PathEscape(taskID), out: &out, retry: &once}); err != nil {
		return nil, err
	}
	return &out, nil
}

// ReportDBHealth posts the samples of a health task. A closed task (409) or
// one the server no longer knows (404) is not retried: the samples are lost,
// the next task brings new ones.
func (c *Client) ReportDBHealth(ctx context.Context, taskID string, samples []DBHealthSample) error {
	// Each sample fits on its own (the agent posts one per check); room is
	// left for the envelope of the samples.
	fitted := make([]DBHealthSample, len(samples))
	for i, sample := range samples {
		FitDBProbeResult(&sample.Result, MaxDBFactsBody/max(1, len(samples))-1024)
		fitted[i] = sample
	}
	samples = fitted
	retry := RetryPolicy{MaxAttempts: 3, BaseDelay: 2 * time.Second, MaxDelay: 10 * time.Second}
	return c.do(ctx, call{method: http.MethodPost, path: "/agent/v1/databases/health/" + url.PathEscape(taskID) + "/samples",
		body: DBHealthSamples{Samples: samples}, retry: &retry, tolerate: []int{http.StatusNotFound, http.StatusConflict}})
}
