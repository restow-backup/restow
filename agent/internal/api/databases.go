package api

import (
	"context"
	"net/http"
	"net/url"
	"time"
)

// The module "Databases" (docs/DATABASES.md, stage D1): the agent tests a
// connection for the server ("Test connection") and reports the database
// instances its inventory finds. The fixtures in testdata/contract/db-*.json
// are the contract with the server (@restow/core databases/facts.ts reads
// the same files).

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
}

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
	Version        string            `json:"version"`
	VersionComment *string           `json:"versionComment"`
	CurrentUser    string            `json:"currentUser"`
	Grants         []string          `json:"grants"`
	ServerUUID     *string           `json:"serverUuid"`
	ServerID       *int64            `json:"serverId"`
	Datadir        *string           `json:"datadir"`
	LogBin         *bool             `json:"logBin"`
	BinlogFormat   *string           `json:"binlogFormat"`
	Databases      []DBMysqlDatabase `json:"databases"`
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
	retry := RetryPolicy{MaxAttempts: 5, BaseDelay: 2 * time.Second, MaxDelay: 30 * time.Second}
	return c.do(ctx, call{method: http.MethodPost, path: "/agent/v1/databases/probes/" + url.PathEscape(probeID) + "/result",
		body: result, retry: &retry, idempotent: true, tolerate: []int{http.StatusNotFound}})
}
