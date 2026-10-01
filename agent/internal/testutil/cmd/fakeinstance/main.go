// Command fakeinstance is a stand-in for a Restow instance, for testing the
// install scripts: it serves the templated install scripts, the agent
// artifacts (a dist folder from build.sh, with SHA256SUMS.sig when it was
// signed) and the agent API (enrollment, config, heartbeat, runs, update
// offer). It is a test tool and not part of the shipped agent.
package main

import (
	"crypto/rand"
	"encoding/hex"
	"flag"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/restow-backup/restow/agent/internal/testutil/fakeserver"
)

func main() {
	listen := flag.String("listen", "127.0.0.1:18080", "address to listen on")
	dist := flag.String("dist", "dist", "directory produced by build.sh")
	installDir := flag.String("install", "install", "directory with linux.sh and macos.sh")
	version := flag.String("version", "0.1.0", "agent version to announce")
	publicURL := flag.String("public-url", "", "URL written into the scripts (default http://<listen>)")
	info := flag.String("info", "", "file that receives URL= and TOKEN= lines when the server is ready")
	releaseKey := flag.String("release-key", "", "file with the release public key (ssh-ed25519 line) written into the scripts")
	updateVersion := flag.String("update", "", "also serve this version from -update-dist and offer it to agents as an update")
	updateDist := flag.String("update-dist", "", "directory produced by build.sh for the -update version")
	flag.Parse()
	if *publicURL == "" {
		*publicURL = "http://" + *listen
	}
	keyLine := ""
	if *releaseKey != "" {
		raw, err := os.ReadFile(*releaseKey)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		keyLine = strings.TrimSpace(string(raw))
	}
	if (*updateVersion == "") != (*updateDist == "") {
		fmt.Fprintln(os.Stderr, "-update and -update-dist go together")
		os.Exit(2)
	}

	var srv *fakeserver.Server
	newToken := func() string {
		b := make([]byte, 24)
		_, _ = rand.Read(b)
		tok := "rset_" + hex.EncodeToString(b)
		srv.SetEnrollToken(tok)
		return tok
	}
	srv = fakeserver.NewWithOptions(fakeserver.Options{Listen: *listen, NoReleases: true, Extra: func(mux *http.ServeMux) {
		for _, name := range []string{"linux.sh", "macos.sh"} {
			name := name
			mux.HandleFunc("/install/"+name, func(w http.ResponseWriter, r *http.Request) {
				raw, err := os.ReadFile(filepath.Join(*installDir, name))
				if err != nil {
					http.Error(w, err.Error(), http.StatusNotFound)
					return
				}
				body := strings.NewReplacer("__RESTOW_URL__", *publicURL, "__RESTOW_VERSION__", *version,
					"__RESTOW_RELEASE_KEY__", keyLine).Replace(string(raw))
				w.Header().Set("Content-Type", "text/x-shellscript")
				_, _ = w.Write([]byte(body))
			})
		}
		prefix := "/install/agent/" + *version + "/"
		mux.Handle(prefix, http.StripPrefix(prefix, http.FileServer(http.Dir(*dist))))
		if *updateVersion != "" && *updateVersion != *version {
			up := "/install/agent/" + *updateVersion + "/"
			mux.Handle(up, http.StripPrefix(up, http.FileServer(http.Dir(*updateDist))))
		}
		mux.HandleFunc("/test/token", func(w http.ResponseWriter, r *http.Request) {
			fmt.Fprint(w, newToken())
		})
	}})
	// The agent only accepts a repository on the host it enrolled with.
	srv.Lock()
	srv.RepoURL = "rest:" + strings.TrimSuffix(*publicURL, "/") + "/agent/restic/" + srv.EndpointID + "/"
	srv.Unlock()
	if *updateVersion != "" {
		target := runtime.GOOS + "-" + runtime.GOARCH
		binary, err := os.ReadFile(filepath.Join(*updateDist, target, "restow-agent"))
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		srv.SetUpdate(*updateVersion, target, binary)
	}
	tok := newToken()
	fmt.Printf("fake Restow instance on %s (public URL %s)\n", srv.URL, *publicURL)
	if *info != "" {
		content := fmt.Sprintf("URL=%s\nTOKEN=%s\n", *publicURL, tok)
		if err := os.WriteFile(*info, []byte(content), 0o600); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
	}
	select {}
}
