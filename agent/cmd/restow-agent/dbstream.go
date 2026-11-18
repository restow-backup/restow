package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"

	"github.com/restow-backup/restow/agent/internal/dbrun"
)

// cmdDBStream is db-stream (docs/DATABASES.md 5.1): restic starts it with
// --stdin-from-command for one dump. It reads the spec the run wrote (0600,
// in memory), runs the program and passes its output to restic on stdout.
// Its exit code is not 0 when the dump failed: restic keeps no snapshot.
func cmdDBStream(args []string, stdout, stderr io.Writer) int {
	path := ""
	for i := 0; i+1 < len(args); i++ {
		if args[i] == "--spec" {
			path = args[i+1]
		}
	}
	if path == "" {
		fmt.Fprintln(stderr, "db-stream: --spec <file> is required")
		return 2
	}
	raw, err := os.ReadFile(path) // #nosec G304 -- the run's own spec file
	if err != nil {
		fmt.Fprintln(stderr, "db-stream:", err)
		return 1
	}
	var spec dbrun.StreamSpec
	if err := json.Unmarshal(raw, &spec); err != nil {
		fmt.Fprintln(stderr, "db-stream: the spec is not readable")
		return 1
	}
	return dbrun.Stream(context.Background(), spec, stdout)
}
