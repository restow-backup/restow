# Windows-Agent für Restow 0.5.0 (Entwurf)

Dieses Dokument beschreibt die Portierung von `restow-agent` auf Windows für Restow 0.5.0:
dateibasierte Sicherung und Wiederherstellung auf Windows 10/11 und Windows Server 2016 und
neuer, mit Schattenkopie über VSS (restic `--use-fs-snapshot`), als Windows-Dienst unter
LocalSystem. Die Entscheidung, Windows mit 0.5.0 auszuliefern, hat der Maintainer getroffen.
Dieses Dokument legt fest, wie. Es ergänzt docs/AGENT.md (Vertrag Agent/Server) und
agent/README.md (Agent); beide werden mit der Umsetzung angepasst (Abschnitt 20).

Stand der Code-Verweise: Tag `v0.4.8` (Commit `275bbbe`). restic-Fakten sind gegen restic
0.19.1 geprüft: das Linux-Binary (`restic backup --help`, `restic restore --help`,
`restic options`), die Quellen bei `v0.19.1` (`cmd/restic/cmd_backup.go`,
`internal/fs/fs_local_vss.go`, `internal/fs/vss_windows.go`) und `go version -m` des
Windows-Binaries. Was sich nur auf einer echten Windows-Maschine klären lässt, ist mit
**[Maschine]** markiert und steht im Testplan (Abschnitt 22.3).

Überarbeitet nach drei Reviews (Mechanik, Sicherheit, Umfang). Die wichtigsten Änderungen
gegenüber dem ersten Entwurf: zwei Regelsätze in der Vertrauensprüfung (sonst scheitert jede
Standardinstallation an `C:\`), Freigabe zum Signieren erst nach dem Windows-Test im Release,
Staging des Installers in `Program Files` und Schlüssel-Pin, Hooks ohne `CTRL_BREAK` und mit
sicherem Exit-Code, kein angehaltener Prozessstart, Snapshot-Begriffe neutral statt `vss_*`
(macOS APFS und Linux LVM/btrfs kommen im selben Release), Meilensteine und "Nicht Teil von
0.5.0".

Harte Randbedingungen, die für alles Folgende gelten:

- Der Go-Agent nutzt kein Go-Modul außer seinem eigenen (`agent/go.mod` ohne `require`,
  CI `scripts/ci/check-go-deps.mjs`). Windows-APIs nur über das Standardpaket `syscall`
  (`syscall.NewLazyDLL`) oder über Werkzeuge des Betriebssystems als eigener Prozess.
  `golang.org/x/sys/windows` ist ausgeschlossen, Code daraus wird auch nicht kopiert.
- Keine neue Lizenzlast: Es wird nichts ausgeliefert außer `restow-agent.exe`, `restic.exe`,
  `THIRD_PARTY_NOTICES.txt` und dem PowerShell-Installer (eigener Code, Apache-2.0). Ein
  GPL-Werkzeug wird nicht gebraucht, `separateWorks` in `scripts/ci/license-policy.json`
  bleibt unverändert.
- Nur ausgehende Verbindungen (Heartbeat alle 5 Minuten, Aufgaben in der Antwort),
  Repository append-only (`packages/core/src/endpoints/restic-authz.ts`), signierte Releases
  (`scripts/release/sign-agent.sh`, `agent-SHA256SUMS.sig`, `.github/workflows/release.yml`).

## 0. Kurzfassung

- **Ziel:** `windows-amd64`. Kein `windows-arm64` in 0.5.0: restic 0.19.1 liefert kein
  Windows-arm64-Binary, und restics VSS-Code lehnt jede Architektur außer amd64 (auf
  64-Bit-Windows) ab (Abschnitt 1.2). Windows erscheint in 0.5.0 als **Vorschau**
  (Offene Entscheidung 6).
- **Nicht Teil von 0.5.0:** Bare Metal, Systemzustand, Registry, Domänencontroller- und
  Hyper-V-Host-Sicherung (Abschnitt 2.2). Wiederherstellung eines Rechners heißt: Windows neu
  installieren, dann Dateien zurückholen.
- **Dienst** `RestowAgent` unter LocalSystem mit reduzierter Privilegienliste und eigener
  Dienst-SID, eingerichtet über advapi32 (`CreateServiceW`), gesteuert über
  `StartServiceCtrlDispatcherW`, `RegisterServiceCtrlHandlerExW`, `SetServiceStatus`.
  Neustart nach Selbstaktualisierung über die Fehleraktionen des Dienststeuerungs-Managers
  (SCM). Sicherheitsrelevante Ereignisse gehen zusätzlich in die Ereignisanzeige.
- **Geheimnisse** in `C:\ProgramData\Restow\state\state.json`, Geheimfelder mit DPAPI
  (`CryptProtectData`, Maschinenbereich) verschlüsselt, Ordner nur für SYSTEM und
  Administratoren (geschützte DACL). Die eigentliche Grenze ist die DACL (Abschnitt 7).
- **Schattenkopie** immer, wenn `useVss` gesetzt ist (Standard für Windows). Fehlerpolitik
  als neue, betriebssystemneutrale Richtlinie `snapshotOnFailure`: `continue` (Standard, ohne
  Schattenkopie weiter, Lauf `partial`) oder `fail`. Neue Fehlercodes `snapshot_failed`,
  `snapshot_unavailable`, `snapshot_cleanup_failed`, Statistik `stats.snapshot`. Dieselben
  Namen nutzen APFS (macOS) und LVM/btrfs (Linux) im selben Release.
- **Wichtigster restic-Befund:** Schlägt das Anlegen einer Schattenkopie fehl, liest restic
  die Dateien dieses Volumes still vom Live-Dateisystem und **endet trotzdem mit Exit-Code
  0**. Der Agent muss den Fehler aus der JSON-Ausgabe erkennen (Abschnitt 17.3). Gelingt die
  Schattenkopie, ist das Ergebnis dateikonsistent, nicht anwendungskonsistent (Abschnitt 17.5).
- **Installer** `GET /install/windows.ps1`, Windows PowerShell 5.1 (64 Bit, startet sich aus
  einem 32-Bit-Host neu), prüft die Release-Signatur mit einer eigenen Ed25519-Prüfung in
  PowerShell (kein Drittwerkzeug), zeigt den Schlüssel-Fingerabdruck vor der Installation und
  nimmt einen Pin an.
- **Kein Authenticode:** SmartScreen greift beim Skriptweg nicht, Defender, Smart App
  Control und ASR-Regeln können die unsignierten Binaries blockieren (Abschnitt 15).
- **Keine Schemaänderung:** `endpoint_os` kennt `windows` schon, alles Neue liegt in
  JSONB-Spalten. Migration 0073 wird nicht gebraucht (Abschnitt 19.4).
- **Reihenfolge:** drei Meilensteine, das Build-/CI-/Release-Gerüst zuerst, weil Linux Bare
  Metal und APFS dieselben Dateien ändern (Abschnitt 23).

## 1. Ausgangslage

### 1.1 Was es heute gibt

- Der Agent ist Unix-only. `//go:build unix` tragen `internal/svc/{svc,systemd,launchd,uninstall}.go`,
  `internal/lock/lock.go`, `internal/hooks/{hooks,policy}.go`, `internal/update/update.go`,
  `internal/state/fs_unix.go` und `internal/paths/trust_unix.go`. Ein
  `GOOS=windows go build ./...` scheitert schon beim Import von `internal/hooks`,
  `internal/lock` und `internal/svc` ("build constraints exclude all Go files").
  `internal/pve` hat kein Build-Tag, nutzt aber `syscall.Kill` (`pve/restore.go:100`,
  `pve/cancel.go:71`).
- `svc.New` kennt nur Linux und macOS (`agent/internal/svc/svc.go:106-118`), `paths.InstallDirFor`
  nur zwei Präfixe (`agent/internal/paths/paths.go:57-63`), das Layout nur Unix-Pfade
  (`paths.go:98-102`).
- `build.sh` lehnt jedes andere Ziel ab (`agent/build.sh:46`, `:127-130`), `tools.env` pinnt
  restic nur für Linux und macOS (`agent/tools.env:16-20`).
- `useVss` ist reine Durchleitung: Feld im Agenten (`agent/internal/api/types.go:171`),
  einziger Verbraucher protokolliert "has no effect" (`agent/internal/core/backup.go:231-233`).
  Der Server setzt `useVss: os === "windows"` (`packages/core/src/endpoints/config.ts:213`),
  aber kein API-Aufruf und keine Oberfläche ändert es.
- Der Server lehnt `os=windows` ab: `SUPPORTED_ENDPOINT_OS = ["linux", "darwin"]`
  (`config.ts:35`), Prüfung in `apps/api/src/features/endpoints/agent-service.ts:237-246` und
  `service.ts:545-556`; `commandsFor` gibt für Windows `null` (`service.ts:321`), der
  Enroll-Dialog zeigt Windows deaktiviert (`apps/web/src/features/endpoints/components/enroll-dialog.tsx:59-63, 178`),
  der Restore-Dialog akzeptiert nur `/`-Pfade (`restore-dialog.tsx:33-63`), ebenso das
  API-Schema (`apps/api/src/features/endpoints/schemas.ts:427-441`).
- Standardordner und Ausschlüsse für Windows stehen schon im Modell
  (`config.ts:125-128`, `:158-166`).
- Ein Job schreibt seine `paths`, `excludes` und `hooks` unverändert in die Konfiguration
  jedes Mitglieds (`packages/core/src/backup-jobs/endpoint-config.ts:120-122`); die
  Job-Vorgaben für gemischte Rechner sind die Vereinigung über alle Betriebssysteme
  (`apps/api/src/features/backup-jobs/read.ts:898-932`). Ein Job kann also `/etc` und
  `C:\Users` zugleich tragen (Abschnitt 16.1).

### 1.2 Geprüfte restic-Fakten (0.19.1)

| Fakt | Beleg |
| --- | --- |
| Windows-Releases: nur `restic_0.19.1_windows_386.zip` und `restic_0.19.1_windows_amd64.zip` (SHA-256 `da948ad707ed690426473aaba2046cd61f8f90f6f0e7dab6be0d5796531de67d`), **kein arm64**. Das ZIP enthält genau `restic_0.19.1_windows_amd64.exe`. | `SHA256SUMS` des Releases, `unzip -l` |
| `--use-fs-snapshot` gibt es nur unter Windows, `--exclude-cloud-files` unter Windows und macOS. Beide fehlen im Linux-`--help`. | `cmd/restic/cmd_backup.go:150-155` |
| VSS-Optionen: `-o vss.timeout` (Standard 120 s), `vss.exclude-all-mount-points`, `vss.exclude-volumes` (Liste mit `;`), `vss.provider` (GUID, Name oder `MS`). Nur unter Windows registriert, darum fehlen sie in `restic options` unter Linux. | `internal/fs/fs_local_vss.go:15-33`, `doc/040_backup.rst:69-104` |
| Vor dem ersten Byte, aber **nach** dem Öffnen des Repositorys und dem Laden des Index, ruft restic `HasSufficientPrivilegesForVSS`: `VssApi.dll` laden, `CoInitializeEx`, `CoInitializeSecurity`. Jeder Fehler dort beendet `backup` mit Exit 1. Nur der `CoInitializeSecurity`-Fehler trägt das Präfix `VSS error:`; ein Ladefehler der DLL und ein roher `CoInitializeEx`-Fehler nicht. | `cmd_backup.go:570-579`, `vss_windows.go:797-861, 1203-1230` |
| **Schlägt die Schattenkopie eines Volumes fehl, meldet restic einen Eintrag `message_type: "error"` mit `during: "archival"`, `item: "c:\"` und dem Text `failed to create snapshot for [c:\]: …` und liest das Volume ohne Schattenkopie.** Dieser Weg setzt `success` nicht auf `false`: ohne weitere Lesefehler endet restic mit **Exit 0**. | `fs_local_vss.go:199-204`, `cmd_backup.go:581-583` gegen `:653-655` und `:703-706`, `internal/ui/backup/json.go:79-86` |
| Unterstützt der Anbieter das Volume nicht, ist der Text `failed to create snapshot for [e:\]: VSS error: Snapshots are not supported for volume e:\`. Das hängt nicht nur am Laufwerkstyp oder Dateisystemnamen (ReFS, eingehängte VHDs, gesperrte BitLocker-Volumes). | `vss_windows.go:966-972`, `fs_local_vss.go:199-204` |
| Ein unbekannter `-o vss.provider` ergibt je Volume `failed to create snapshot for [c:\]: invalid VSS provider "…"`, ohne dass eine Schattenkopie entstehen muss. | `vss_windows.go:1129-1175` |
| restic fordert die Schattenkopie mit `SetContext(VSS_CTX_BACKUP)` (nicht dauerhaft) und `SetBackupState(false, false, VSS_BT_COPY, false)` an: Kopie-Sicherung ohne Komponentenauswahl der Writer. Ergebnis ist ein dateikonsistenter Zeitpunkt; SQL Server oder Exchange werden nicht als Anwendung gesichert, Transaktionsprotokolle nicht gekürzt. | `vss_windows.go:227, 947, 954` |
| Im JSON-Modus schreibt restic keine Erfolgsmeldung ("creating VSS snapshot", "successfully created"); der Agent kann den Erfolg nur aus dem Fehlen eines Fehlers ableiten. | `cmd_backup.go:585-589` |
| UNC-Pfade und nicht unterstützte Einhängepunkte werden ohne Schattenkopie und ohne Fehler gelesen. | `fs_local_vss.go:160-164, 225-232` |
| VSS nur mit amd64-restic auf 64-Bit-Windows (oder 386 auf 32 Bit); ein arm64-restic bekommt `executables compiled for arm64 can't use VSS`. | `vss_windows.go:888-900, 1248-1260` |
| restic sichert und stellt Security Descriptors (Owner, Gruppe, DACL, SACL) wieder her, wenn es als Administrator läuft (sonst nur DACL); Vererbungs-Flags seit 0.19.0 korrekt. NTFS Extended Attributes seit 0.17.0. | CHANGELOG 0.17.0 #4708 und #4807, 0.19.0 #5427 und #5424; `doc/050_restore.rst:82-89` |
| **Alternate Data Streams werden nicht gesichert** (Pfade mit `:` werden übersprungen, kein Changelog-Eintrag führt ADS ein). `Zone.Identifier` (Mark of the Web) geht damit verloren. | `internal/fs/node_windows.go:96, 346` |
| restic setzt `godebug winsymlink=0`: Junctions verhalten sich wie vor Go 1.23 (als symbolische Links). | `go.mod:9` von restic |
| Snapshot-Pfade: Das Volume wird wörtlich übernommen, `C:\Users` wird `/C/Users`, `c:\Users` aber `/c/Users`. | `internal/archiver/tree.go:35-65` |
| Mindestversion von restic selbst: Windows 10 / Server 2016. | CHANGELOG 0.18.0 #4938 |
| `--one-file-system` bricht unter Windows sofort ab. | `doc/040_backup.rst:518-519` |
| `--files-from-raw` verlangt unter Windows UTF-8. Der Agent schreibt UTF-8. | `doc/040_backup.rst:562-567`, `agent/internal/restic/backup.go:103-114` |
| Muster: restic macht aus jedem Muster `filepath.Clean` und `filepath.ToSlash`, unter Windows wird `\` damit Trenner, **Escapen mit `\` geht unter Windows nicht**. `filepath.Match` kennt unter Windows keine Escapes. `$$` wird zu `$` (`getenvOrDollar`). Muster sind groß-/kleinschreibungsabhängig, außer mit `--iexclude-file`. | `internal/filter/filter.go:43, 60-61` |
| `restore` kennt `--overwrite never`, `--verify`, `--include`, `--iinclude`, `--exclude-xattr`; `backup` kennt `--iexclude-file`. | `restic restore --help`, `restic backup --help` |
| Abbruch: `context.Canceled` wird Exit 130. Ein Go-Programm bekommt unter Windows `CTRL_C_EVENT` und `CTRL_BREAK_EVENT` als `os.Interrupt`; restic hört auf SIGINT und SIGTERM. | `cmd/restic/main.go:235-236`, `go doc os/signal` (Abschnitt Windows) |
| restic.exe enthält gegenüber Linux drei weitere Go-Module: `github.com/Microsoft/go-winio` (MIT), `github.com/go-ole/go-ole` (MIT), `github.com/inconshreveable/mousetrap` (Apache-2.0); `anacrolix/fuse` und `pkg/xattr` fehlen. | `go version -m` beider Binaries |

### 1.3 Was das Standardpaket `syscall` bietet und was nicht

Vorhanden (`GOOS=windows go doc syscall`): `OpenProcessToken`, `GetTokenInformation`,
`TokenElevation`, `TokenUser`, `StringToSid`, `CreateFile`, `CreateDirectory` (mit
`SecurityAttributes`), `RegOpenKeyEx`, `RegQueryValueEx`, `LocalFree`, `GetFileInformationByHandle`,
`SysProcAttr` (mit `CreationFlags`, `CmdLine`, `HideWindow`, `Token`, `NoInheritHandles`),
`CREATE_NEW_PROCESS_GROUP`, `NewLazyDLL`, `NewCallback`. Es fehlen u. a. die Konstanten
`CREATE_NO_WINDOW` und `CREATE_SUSPENDED` sowie `RegCreateKeyEx`/`RegSetValueEx`; die
Konstanten stehen in `internal/winapi`, die Registry-Schreibfunktionen braucht der Agent nicht.

Nicht vorhanden und über `NewLazyDLL` zu laden: `LockFileEx`, `UnlockFileEx`,
`GetSystemPowerStatus`, `CreateJobObjectW`, `SetInformationJobObject`,
`AssignProcessToJobObject`, `TerminateJobObject`, `GenerateConsoleCtrlEvent`, `AllocConsole`,
`GetConsoleProcessList`, `MoveFileExW`, `GetSystemDirectoryW`, `GetFinalPathNameByHandleW`,
`GetVolumePathNameW`, `GetDriveTypeW`, `GetVolumeInformationW` (kernel32); `OpenSCManagerW`,
`CreateServiceW`, `OpenServiceW`, `StartServiceW`, `ControlService`, `QueryServiceStatusEx`,
`QueryServiceConfigW`, `QueryServiceConfig2W`, `ChangeServiceConfigW`, `ChangeServiceConfig2W`,
`DeleteService`, `CloseServiceHandle`, `StartServiceCtrlDispatcherW`,
`RegisterServiceCtrlHandlerExW`, `SetServiceStatus`, `GetNamedSecurityInfoW`,
`SetNamedSecurityInfoW`, `GetSecurityInfo`, `GetAce`, `GetAclInformation`,
`ConvertStringSecurityDescriptorToSecurityDescriptorW`, `CheckTokenMembership`,
`RegisterEventSourceW`, `ReportEventW`, `DeregisterEventSource` (advapi32);
`CryptProtectData`, `CryptUnprotectData` (crypt32); `SHGetKnownFolderPath` (shell32).
`CreateToolhelp32Snapshot`, `OpenThread` und `ResumeThread` werden **nicht** gebraucht
(kein angehaltener Start, Abschnitt 12.3).
`syscall.O_NOFOLLOW`, `syscall.Kill`, `syscall.Flock`, `Stat_t` und `Setpgid` gibt es unter
Windows nicht; `os.Process.Signal(os.Interrupt)` ist unter Windows nicht implementiert.

DLLs werden nur mit absolutem Pfad geladen: Ein neues internes Paket `internal/winapi`
ermittelt einmal das Systemverzeichnis (`GetSystemDirectoryW` aus `kernel32.dll`, eine
KnownDLL) und lädt `advapi32.dll`, `crypt32.dll` und `shell32.dll` als
`syscall.NewLazyDLL(filepath.Join(sysdir, name))`. Das vermeidet DLL-Preloading
(Warnung in `go doc syscall LoadDLL`). Alle Prozeduren eines Pakets stehen dort an einer
Stelle, jede mit Signatur und Verweis auf die Microsoft-Dokumentation im Kommentar.

**`go vet` und Zeiger:** Der geforderte `GOOS=windows go vet ./...` meldet jede Umwandlung
`unsafe.Pointer(uintptr)` (Prüfung `unsafeptr`). Ausgabeparameter, in die die API einen
Zeiger schreibt (Security Descriptor, SID, DACL, DPAPI-Blob), werden darum als
`*unsafe.Pointer` bzw. als typisierter Zeiger (`**byte`, `*uintptr` nur für Handles)
übergeben, nie als `uintptr` empfangen und danach umgewandelt. Freigabe mit `LocalFree`.

## 2. Zielplattformen und Umfang

### 2.1 Plattformen

| Ziel | 0.5.0 | Grund |
| --- | --- | --- |
| Windows 10 22H2 und Windows 11, amd64 | ja | |
| Windows 10 1607 bis 21H2 | Best effort | restic läuft dort, getestet wird nur 22H2 (Abschnitt 22.3) |
| Windows Server 2016, 2019, 2022, 2025, amd64 (mit Desktop und Core) | ja | Server Core: kein Explorer, Installer läuft trotzdem (Abschnitt 14); 2016 und 2022 stehen im Freigabetest |
| Windows on ARM (arm64) | nein | kein restic-Binary; restics VSS lehnt arm64 ab (Abschnitt 1.2). Installer und Server lehnen mit klarer Meldung ab. amd64 unter Emulation ist ungetestet. |
| 32-Bit-Windows | nein | Go-Ziel `windows/386` nicht geplant; restic hätte es |
| Windows 8.1, Server 2012 R2 und älter | nein | restic 0.18+ verlangt Windows 10 / Server 2016 |

Der Server nimmt `os=windows` nur mit `arch=amd64` an (Abschnitt 19.1).

### 2.2 Nicht Teil von 0.5.0

- **Bare Metal für Windows** (WIM/VHDX, WinPE- oder WinRE-Medium, BCD, Partitionierung). Das
  ist Phase 3 des Bare-Metal-Plans, ein späteres Release. 0.5.0 bringt Bare Metal nur für
  Linux.
- **Systemzustand und Registry.** Die Standardordner decken weder `C:\Windows` noch die
  Registry-Hives ab. Wiederherstellung eines Rechners heißt: Windows neu installieren, dann
  Dateien zurückholen.
- **Domänencontroller und Active Directory.** Eine Dateisicherung ist keine unterstützte
  AD-Sicherung. `DetectMachine` liest den Produkttyp (`sysinfo_windows.go`, Abschnitt 4);
  bei einem Domänencontroller (`ProductType = LanmanNT`) zeigt die Oberfläche einen festen
  Hinweis.
- **Hyper-V-Host** (VM-Dateien im laufenden Betrieb), **Exchange und SQL Server als
  Anwendung** (siehe Abschnitt 17.5: dateikonsistent, nicht anwendungskonsistent; für
  Anwendungskonsistenz bleiben Hooks wie `sqlcmd -Q "BACKUP DATABASE …"`).
- **Alternate Data Streams, EFS-Dateien anderer Benutzer, Authenticode, Windows on ARM.**
- **WPAD/PAC und NTLM/Kerberos am Proxy** (Abschnitt 12.5).

Die Oberfläche zeigt für Windows-Rechner wie für macOS den Satz "Wiederherstellung = Windows
neu installieren, dann Dateien zurückholen" (heute "keine Images, kein Bare-Metal-Restore",
`endpoints-page.test.tsx:188`, `agent/README.md:613`, `docs/AGENT.md:16`).

## 3. Build und Release

### 3.1 `agent/build.sh`

- `TARGETS` (`build.sh:46`) wird `linux-amd64 linux-arm64 darwin-amd64 darwin-arm64 windows-amd64`.
- Die Ziel-Prüfung (`:127-130`) nimmt `windows-amd64` auf, sonst nichts.
- Dateiendung je Ziel: `exe=""`, bei `os=windows` `exe=".exe"`. Der Build schreibt
  `$dir/restow-agent$exe` (`:134-135`), `fetch_tool` legt `$dir/restic$exe` ab (`:137`).
- Die Prüfung "läuft auf diesem Host" (`:138-143`) greift für Windows nur, wenn `build.sh`
  auf Windows läuft (unter Git-Bash im Windows-Job, Abschnitt 3.5); sonst übernimmt das der
  Windows-Job im Release.
- Die `SHA256SUMS`-Schleife (`:168`) nennt zusätzlich `restow-agent.exe` und `restic.exe`.
  Die Gesamtliste `dist/SHA256SUMS` (`:178-185`) enthält dann Zeilen
  `windows-amd64/restow-agent.exe` usw.; die Release-Signatur deckt sie ohne Änderung an
  `scripts/release/sign-agent.sh` mit ab.
- `restow-share` und `restow-pve` bleiben Linux-only (`:147-162` unverändert).
- Linker: weiter `-s -w`, Konsolen-Subsystem (kein `-H windowsgui`), denn das Binary ist
  auch das Kommandozeilenwerkzeug. Unter dem SCM öffnet ein Konsolenprogramm kein Fenster.
- Kein eingebettetes Manifest und keine Versionsressource: Beides bräuchte ein
  Drittwerkzeug (`rsrc`, `goversioninfo`) oder einen handgeschriebenen `.syso`. Lange Pfade
  brauchen kein Manifest, weil Go absolute Pfade über 248 Zeichen selbst mit `\\?\`
  versieht **[Maschine]**.
- Hilfetext (`:2-29`) und Kommentar "Linux and macOS" anpassen.

### 3.2 restic.exe pinnen

`agent/tools.env`:

```sh
RESTIC_SHA256_windows_amd64=da948ad707ed690426473aaba2046cd61f8f90f6f0e7dab6be0d5796531de67d
# nur für die Integrationstests auf dem Windows-Runner (Abschnitt 22.1)
REST_SERVER_SHA256_windows_amd64=36d124b7444793e6cf3e097b661875763543476834b7b34f0501b0600da26f42
```

Beide Werte stammen aus den `SHA256SUMS` der Releases restic 0.19.1 und rest-server 0.14.0
(`windows_amd64.zip` bzw. `windows_amd64.tar.gz`). Sie werden erst übernommen, wenn
`scripts/pin-tools.sh` die GPG-Signatur dieser `SHA256SUMS` geprüft hat; das Skript gibt die
Zeilen aus, die Werte hier sind nur zum Abgleich.

`agent/scripts/pin-tools.sh`:

- Die Zielliste (`:56`) wird `linux_amd64 linux_arm64 darwin_amd64 darwin_arm64 windows_amd64`.
- Das Dateimuster hängt vom System ab: restic `restic_<v>_windows_amd64.zip` statt `.bz2`,
  rest-server bleibt `.tar.gz` (für Windows gibt es `.zip` und `.tar.gz`; `.tar.gz` passt
  zum vorhandenen Entpacker).

`agent/scripts/lib.sh` (`fetch_tool`, `:31-49`):

- restic unter Windows: URL `restic_${RESTIC_VERSION}_windows_amd64.zip`, Aufruf
  `go run ./tools/fetch -format zip -member restic_${RESTIC_VERSION}_windows_amd64.exe`.
- rest-server unter Windows: `-format tar.gz -member rest-server.exe` (`tools/fetch`
  vergleicht über `path.Base`, das Mitglied im Archiv passt).

`agent/tools/fetch/main.go`:

- Neues Format `zip` in `unpack` (`:104-131`) mit `archive/zip` (Standardbibliothek). Die
  temporäre Datei ist schon ein `*os.File` (`:58`), taugt also als `io.ReaderAt`. Genau ein
  Mitglied mit exakt dem Namen aus `-member` (kein Pfad, kein `..`), nur reguläre Dateien,
  Größengrenze wie bei den anderen Formaten (`4*maxDownload`).
- Test in `tools/fetch/main_test.go`: ZIP mit passendem und fehlendem Mitglied, Mitglied mit
  Pfad.

### 3.3 Lizenzen von restic.exe

`scripts/restic-licenses.mjs` verlangt heute, dass alle Ziele dieselbe Modulliste haben
(`vendor`: `:293-301`; Text `:14`, `:354`). Für Windows stimmt das nicht (Abschnitt 1.2).
Änderung:

- `vendor` bildet die Vereinigung der Modullisten aller übergebenen Binaries; ein Modul, das
  in zwei Binaries mit verschiedener Version oder verschiedenem Hash vorkommt, bleibt ein
  Fehler. `modules.json` bekommt je Modul `targets: ["linux-amd64", …]` (fehlt das Feld,
  gilt "alle"), damit die Hinweise korrekt sagen, was wo einkompiliert ist.
- `check` (`:384-409`) prüft je Binary: Jedes Modul im Binary ist vendort (gleiche Version
  und gleicher Hash), und jedes vendorte Modul, das für dieses Ziel gelistet ist, steht im
  Binary.
- `scripts/ci/restic-licenses.test.mjs:150-158` prüft heute genau die Regel "alle Ziele
  gleich"; die Fälle werden auf "je Ziel laut `targets`" umgestellt, plus ein Fall mit einem
  Windows-only-Modul.
- Neu vendort werden `github.com/Microsoft/go-winio` (MIT), `github.com/go-ole/go-ole` (MIT)
  und `github.com/inconshreveable/mousetrap` (Apache-2.0) unter `licenses/restic-deps/`.
  Beide Lizenzen sind in `scripts/ci/license-policy.json` erlaubt, eine Ausnahme unter
  `redistributedBinaries` ist nicht nötig.
- `scripts/third-party-notices.mjs` erzeugt `THIRD_PARTY_NOTICES.md` und
  `agent/THIRD_PARTY_NOTICES.txt` neu; die Zahl "79 Module" in docs/AGENT.md (Abschnitt
  "Verteilung") wird "82 Module, je Ziel 80 oder 79".
- CI-Aufruf `node scripts/restic-licenses.mjs check "$RUNNER_TEMP"/agent-dist/*/restic`
  (`.github/workflows/ci.yml:543`) wird `…/agent-dist/*/restic*`, damit `restic.exe` mitkommt.

### 3.4 `scripts/ci/check-go-deps.mjs`

`TARGETS` (`:24-29`) bekommt `{ goos: "windows", goarch: "amd64" }`, Kommentar "the four
shipped targets" (`:6-7`) wird "the five shipped targets", ebenso der Test
`scripts/ci/check-go-deps.test.mjs:52-56`, der die Zielliste wörtlich erwartet. Damit prüft
`go list -deps -test` auch die `_windows.go`-Dateien. docs/CI.md (Zeilen 13 und 31-33) nennt
fünf Ziele.

### 3.5 CI (`.github/workflows/ci.yml`)

Bestehender Job `agent` (`:494-543`, Ubuntu):

- `agent/scripts/test.sh` (`:41-45`): `go vet` zusätzlich für `windows/amd64`
  (`CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go vet ./...`). Das findet Compilerfehler und
  Vet-Befunde der Windows-Dateien schon unter Linux. Der Integrations-Tag bleibt Linux/macOS.
- `agent/build.sh` baut ohne Argumente alle fünf Ziele und holt `restic.exe` (geprüft).
- Wächter für die erkannten restic-Texte: `restic.exe` aus `agent-dist/windows-amd64` muss
  die Zeichenketten `failed to create snapshot for [`, `failed to delete VSS snapshot`,
  `Snapshots are not supported for volume` und `VSS error: ` als Bytes enthalten
  (`grep -c -a -F`). Ein späteres restic mit anderen Texten fällt damit schon unter Linux auf,
  unabhängig davon, ob VSS auf dem Windows-Runner läuft.

**Tests mit Shell-Attrappen.** Viele Agent-Tests legen `#!/bin/sh`-Skripte als falsches
restic oder falschen Agenten an; `CreateProcess` kennt keine Shebangs. Betroffen:
`internal/core/harness_test.go:34` (falsches restic für alle Core-Tests), `core_test.go:1020`,
`cancel_test.go:101`, `update_now_test.go:27`, `internal/restic/restic_test.go:24`,
`internal/update/update_test.go:53`, `cmd/restow-agent/main_test.go:16`,
`internal/hooks/policy_test.go`, `internal/paths/trust_test.go:45`, `internal/pve`,
`internal/share`. Für 0.5.0:

- Diese Testdateien bekommen `//go:build unix`; Linux und macOS testen die Logik weiter.
- Die Windows-Logik, die nicht am Prozess hängt, liegt **ohne** Build-Tag und wird damit auch
  unter Linux getestet: Erkennung der Snapshot-Fehler aus restic-JSON, die Fehlerpolitik
  `snapshotOnFailure` samt Rückfall (Abschnitt 17.4, mit dem falschen restic, das die
  Windows-Fehlerzeilen ausgibt), Pfadabbildung, Zielregeln, `procenv`, ACE-Bewertung,
  PowerShell-Hülle der Hooks (Abschnitt 12.2).
- Auf Windows laufen die übrigen Unit-Tests, die `windowsintegration`-Tests und die
  Integration mit dem echten `restic.exe`.
- Später (0.5.x): falsches restic als Go-Programm über den Testbinary-Neustart
  (`TestMain`: ist `RESTOW_FAKE_RESTIC=1` gesetzt, verhält sich das kopierte Testbinary als
  restic), dann fallen die `unix`-Tags.

Neuer Job `agent-windows` (`runs-on: windows-2022`, `timeout-minutes: 40`), gleiche
Vorprüfung "Is there an agent in this commit?" wie `agent`:

1. `actions/setup-go` mit derselben SHA-Pin wie im Job `agent`, `go-version-file: agent/go.mod`, ohne Cache.
2. `gofmt -l` (leer), `go vet ./...` nativ, `go test -count=1 ./...` (mit `-race`, wenn
   `gcc` auf dem Runner gefunden wird, wie `test.sh:47-52`).
3. `go test -tags windowsintegration ./internal/winsvc/... ./internal/winapi/... ./internal/procctl/...`:
   Dienst anlegen, starten, stoppen, löschen; Stopp-Signal an restic aus dem echten Dienst
   (Abschnitt 22.1); Job Objects; DPAPI-Rundlauf; ACL-Prüfung; LockFileEx über zwei Prozesse;
   Privilegien des Diensttokens; Ereignisanzeige. Die gehosteten Runner laufen als
   Administrator, das reicht dafür.
4. `pwsh`-unabhängig: `powershell.exe -NoProfile -File agent/scripts/test-install-windows.ps1`
   (Abschnitt 22.1): Syntaxprüfung des Installers mit
   `[System.Management.Automation.Language.Parser]::ParseFile`, Ed25519-Testvektoren,
   Differenztest gegen Go, Prüfung einer echten `SHA256SUMS.sig` gegen
   `agent/release-signing.pub` (Testdatei im Repository), und ein vollständiger Lauf gegen
   eine lokale Testinstanz (`internal/testutil/fakeserver` hinter `http://127.0.0.1`, mit
   den Testschaltern des Installers), auch aus dem 32-Bit-Host
   (`%SystemRoot%\SysWOW64\WindowsPowerShell\v1.0\powershell.exe`).
5. Integrationstest Windows (`go test -tags integration ./integration/` mit `rest-server.exe`
   und `restic.exe` aus `tools.env`): Sicherung mit `--use-fs-snapshot` auf `C:\` eines
   Testordners mit einer exklusiv geöffneten Datei; Erwartung: Datei im Snapshot. Ist VSS auf
   dem gehosteten Runner nicht nutzbar, bricht der Test nicht ab, sondern meldet
   `::notice::` und prüft nur den Rückfall. Der Fall mit unbekanntem Anbieter
   (`-o vss.provider={00000000-0000-0000-0000-000000000001}`) braucht keine funktionierende
   Schattenkopie und läuft immer (Abschnitt 1.2). Die bestehende `integration/`-Suite ist
   heute Linux-only (`agent/scripts/integration.sh`); die Windows-Fälle kommen in eigene
   Dateien mit `//go:build integration && windows`.

Der Sammeljob `passed` (`:586-601`) bekommt `agent-windows` in `needs`.

### 3.6 Release (`.github/workflows/release.yml`)

Heute legt der Job `agent` (`:233-286`) die Prüfsummenliste schon selbst auf den Entwurf und
fordert zum Signieren auf (Schritt "Put agent-SHA256SUMS on the draft release", `:269-286`);
`sign-agent.sh` signiert, was auf dem Entwurf liegt, und gibt danach den wartenden Job frei
oder startet ihn neu (`sign-agent.sh:210-230`). Ein Windows-Test, der nur vor
`agent-signature` steht, hielte das Signieren also nicht auf. Neu:

- Job `agent` (Ubuntu) baut wie bisher, jetzt mit `windows-amd64`, und lädt nur noch das
  Artefakt `agent-dist` hoch. Der Schritt "Put agent-SHA256SUMS on the draft release" und der
  Hinweis "Sign the agent now" ziehen um.
- Neuer Job `agent-windows-check` (`needs: [verify, agent]`, `runs-on: windows-2022`): lädt
  `agent-dist`, prüft `windows-amd64/SHA256SUMS` mit `Get-FileHash`, führt
  `restow-agent.exe version --short` (muss die Release-Version sein) und `restic.exe version`
  (muss `0.19.1` sein) aus und legt den Dienst einmal an und wieder weg.
- Neuer Job `agent-sums` (`needs: [verify, agent, agent-windows-check]`, Ubuntu): der
  umgezogene Schritt. Erst jetzt liegt `agent-SHA256SUMS` auf dem Entwurf, erst jetzt kommt
  die Aufforderung zum Signieren, mit den SHA-256 von `restow-agent.exe` und `restic.exe` und
  der Erinnerung an die Defender-Einreichung (Abschnitt 15).
- Job `agent-signature` (`:288-294`) wird `needs: [verify, agent, agent-windows-check, agent-sums]`.
- Job `publish`, Schritt mit `agent-tree` (`:770-782`): Dateiname je Ziel mit Endung,
  `cp "$dir/restow-agent$exe" "assets/restow-agent_${VERSION}_${target}$exe"`. Öffentlicher
  Name für Windows: `restow-agent_${VERSION}_windows-amd64.exe`.
- Signaturabgleich (`:865-880`): Das Ziel wird aus dem Dateinamen ohne `.exe` gelesen, die
  erwartete Zeile ist `$target/restow-agent$exe`, für Windows also
  `windows-amd64/restow-agent.exe`.
- `scripts/release/sign-agent.sh` bleibt unverändert (es signiert die ganze Liste).
- Die Release-Notizen nennen die SHA-256 von `restow-agent.exe` und `restic.exe` (für
  Defender-Freigaben nach Hash, Abschnitt 15) und den Fingerabdruck des Release-Schlüssels
  (Abschnitt 14.3).

### 3.7 Image und Verteilung

- `Dockerfile:154` und `:162`: `cp …/install/*.sh` wird `cp …/install/*.sh …/install/*.ps1`;
  `:213` ebenso. `:150` (`chmod 0755 ./*/restow-agent ./*/restic`) bleibt, die Muster treffen
  die Windows-Dateien nicht, und die brauchen kein Ausführungsbit.
- `Dockerfile:205`: Die Kopierschleife nennt `restow-agent` und `restic` fest; unter `set -eu`
  bräche der Image-Bau am Ordner `windows-amd64` ab, für alle Ziele. Neu: `exe=""`, bei
  `windows-*` `exe=".exe"`, dann `cp "$dir"restow-agent$exe "$dir"restic$exe …`.
- `scripts/smoke/checks/01-install.mjs:161` prüft nur `ls /srv/agent/*/*/restow-agent`; die
  Prüfung bekommt zusätzlich `windows-amd64/restow-agent.exe` und dessen `SHA256SUMS`.
- `apps/api/src/features/endpoints/distribution.ts`:
  - `DISTRIBUTION_TARGETS` (`:31-34`) wird eine feste Liste
    `["linux-amd64", "linux-arm64", "darwin-amd64", "darwin-arm64", "windows-amd64"]` statt
    `SUPPORTED_ENDPOINT_OS.flatMap(...)`, sonst entstünde `windows-arm64`.
  - `INSTALL_SCRIPTS` (`:37-42`) bekommt `"windows.ps1": "windows.ps1"`.
  - `latestAgentRelease` (`:272-291`) sucht für Windows `restow-agent.exe` statt
    `restow-agent` (`:286-288`). Ohne diese Änderung bekäme ein Windows-Agent nie ein Update.
  - `renderInstallScript` (`:423-442`) bleibt: Origin, Version und Schlüssel sind geprüft und
    enthalten kein `'`, sind also auch in PowerShell-Strings mit einfachen Anführungszeichen
    sicher. Ein Test sichert das ab. Weil das Skript je Anfrage umgeschrieben wird, kann es
    keine Skriptsignatur tragen (Abschnitt 15).
- `install-routes.ts:32`: Schleife über `["linux.sh", "macos.sh", "windows.ps1"]`; für
  `.ps1` `content-type: text/plain; charset=utf-8`. Kommentar `:24-28` anpassen.
- `apps/api/src/lib/provider-access.ts:136-137`: `GET /install/windows.ps1` freigeben.

## 4. Codeaufteilung im Agenten

Grundsatz: Plattformlogik hinter den vorhandenen Schnittstellen, Dateien mit Suffix
`_windows.go` bzw. `_unix.go`. Gemeinsamer Code bleibt ohne Build-Tag, auch dann, wenn er
nur unter Windows gebraucht wird, aber ohne Systemaufruf auskommt (damit er unter Linux
getestet wird, Abschnitt 3.5).

| Paket | Heute | Windows |
| --- | --- | --- |
| `internal/winapi` | neu | DLL-Laden, Prozeduren, Hilfen (UTF-16, SID, Fehlercodes, Konstanten) |
| `internal/paths` | `paths.go`, `trust_unix.go` | `paths_windows.go` (Layout), `trust_windows.go` (ACL-Prüfung, Abschnitt 6), `acl.go` (ACE-Bewertung ohne Tag) |
| `internal/state` | `fs_unix.go` | `fs_windows.go` (ACL), `protect_windows.go` (DPAPI, Abschnitt 7) |
| `internal/svc` | `svc.go` u. a., alle `unix` | gemeinsame Typen (`Manager`, `State`, `Info`) in `svc.go` ohne Tag; `scm_windows.go` (Manager), `uninstall_windows.go` |
| `internal/winsvc` | neu | Dienst-Hauptprogramm (`StartServiceCtrlDispatcherW`, Abschnitt 9.2) |
| `internal/eventlog` | neu | Ereignisanzeige (Abschnitt 9.5); unter Unix ohne Wirkung |
| `internal/lock` | `lock.go` (`flock`) | `lock_windows.go` (`LockFileEx`) |
| `internal/hooks` | `hooks.go`, `policy.go` (`unix`) | Gemeinsames (Optionen, Fehler, `readLines`, Modi, PowerShell-Hülle) ohne Tag; `run_unix.go`, `run_windows.go`, `resolve_windows.go` |
| `internal/procctl` | neu | Job Objects, `CTRL_BREAK`, Konsole (Abschnitt 12) |
| `internal/atomicfile` | neu | atomares Schreiben mit Wiederholung, Lesen mit `FILE_SHARE_DELETE` (Abschnitt 7) |
| `internal/update` | `update.go` (`unix`) | Gemeinsames ohne Tag; `swap_unix.go`, `swap_windows.go` (Abschnitt 13) |
| `internal/power` | `power_linux.go`, `power_darwin.go` | `power_windows.go` |
| `internal/procenv` | Unix-Allowlist | Allowlist je System, Groß-/Kleinschreibung unter Windows egal (Abschnitt 12.4) |
| `internal/sysinfo` | `sysinfo_linux.go`, `sysinfo_darwin.go` | `sysinfo_windows.go` (Registry), `DetectMachine` mit Produkttyp, `datafolders_windows.go` (Abschnitt 16.1) |
| `internal/restic` | Runner, Backup, Restore | `runner_windows.go` (Abbruch), VSS-Argumente, `snapshot.go` (Erkennung, ohne Tag), `pattern.go` je System |
| `internal/core` | | Snapshot-Politik, Restore-Ziel je System, Pfadabbildung |
| `cmd/restow-agent` | | `requireRoot` je System, `run --service`, Windows-Texte |

`internal/share`, `internal/nbd`, `internal/pve` und `cmd/restow-pve`, `cmd/restow-share`
bleiben Linux-Sache; sie müssen unter `GOOS=windows` nur kompilieren (`go vet`), was
`share/sys_other.go` heute schon für Nicht-Linux abdeckt. `internal/pve` nutzt
`syscall.Kill` ohne Tag (`pve/restore.go:100`, `pve/cancel.go:71`) und bekommt
`//go:build !windows` am Paket, ebenso `cmd/restow-pve`. **Regel für alle Arbeitsstränge von
0.5.0:** Neuer Linux-only-Agentencode (Bare-Metal-Sammler, `restow-agent recover`,
LVM/btrfs-Snapshots) trägt `//go:build linux`, macOS-only-Code (APFS) `//go:build darwin`;
sonst scheitert der `GOOS=windows go vet` aus Abschnitt 3.5.

## 5. Pfade und Dateien

Ordner werden über `SHGetKnownFolderPath` (`FOLDERID_ProgramFiles`, `FOLDERID_ProgramData`)
ermittelt, nicht über Umgebungsvariablen und nicht fest `C:`. Im Dokument steht der
Normalfall.

| Pfad | Inhalt | DACL (geschützt, ohne Vererbung von oben) |
| --- | --- | --- |
| `C:\Program Files\Restow\bin\restow-agent.exe`, `restic.exe` | Binaries (`restow-agent.exe.prev` nach einem Update) | erbt von `C:\Program Files` (TrustedInstaller, SYSTEM, Administratoren Vollzugriff; Benutzer Lesen/Ausführen). Wird geprüft, nicht gesetzt. |
| `C:\Program Files\Restow\THIRD_PARTY_NOTICES.txt` | Lizenzhinweise | wie oben |
| `C:\Program Files\Restow\.stage-<zufall>` | Staging des Installers, nur während der Installation | `D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)`, beim Anlegen gesetzt |
| `C:\ProgramData\Restow\state\state.json` | Anmeldung, Geheimfelder DPAPI-verschlüsselt | `D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)` |
| `C:\ProgramData\Restow\state\hooks.d\` | Hook-Skripte für die Regel `scripts` | wie `state` |
| `C:\ProgramData\Restow\data\status.json` | Laufzeitstatus ohne Geheimnisse | Ordner `data`: SY, BA Vollzugriff, `BU` nur "Ordner auflisten" (dieser Ordner); Datei `status.json`: zusätzlich `(A;;FR;;;BU)` |
| `C:\ProgramData\Restow\data\{cache,tmp,restic-tmp,outbox}` | restic-Cache, temporäre Kopien, unzustellte Berichte | `D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)` |
| `C:\ProgramData\Restow\data\run.lock` | Laufsperre | wie `data` |
| `C:\ProgramData\Restow\logs\agent.log` | Agent-Log, rotiert wie heute (`internal/logging/rotate.go`) | `D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)` |
| Registry `HKLM\SYSTEM\CurrentControlSet\Services\RestowAgent` | Dienst, optional `Environment` (Proxy ohne Zugangsdaten, Abschnitt 12.5) | Standard des SCM (für Benutzer lesbar) |
| Ereignisanzeige, Protokoll "Anwendung", Quelle `Restow` | Sicherheitsrelevante Ereignisse (Abschnitt 9.5) | Standard |

`C:\ProgramData` selbst erlaubt Benutzern, Unterordner anzulegen. Darum setzt der Agent
(und der Installer) die DACL von `C:\ProgramData\Restow` und seinen Unterordnern selbst,
geschützt (Flag `P`), Eigentümer `BA`. Ein schon vorhandener Ordner, dessen Eigentümer nicht
SYSTEM, Administratoren oder TrustedInstaller ist oder der ein Reparse-Point ist, wird
abgelehnt und nicht repariert: das entspricht `EnsureRootDir`
(`agent/internal/paths/trust_unix.go:119-160`), dort "someone else may have prepared it".
Der Installer prüft das selbst in PowerShell, bevor der Agent existiert (Abschnitt 14.2).

`paths.go`: `WindowsInstallDir`, `InstallDirFor("windows")`, `Default()` mit Windows-Zweig,
`InstalledAgentBinary()`/`InstalledResticBinary()` mit `.exe`. `CommandLink` und die
`Legacy*`-Konstanten gelten nur unter Unix. `Ensure()` (`paths.go:134-145`) setzt unter
Windows die DACLs statt `0o755`/`0o750`. Alle `os.MkdirAll(…, 0o700)` im Code
(`cmd/restow-agent/enroll.go:236-237`, `hookscmd.go:84`, `core/run.go:80`, `core/outbox.go:36`,
`core/verify.go:69`, `restic/runner.go:324`) liegen unter einem dieser Ordner und erben die
geschützte DACL; die Modusangabe ist unter Windows wirkungslos und bleibt stehen.

## 6. Vertrauensprüfung (Ersatz für `trust_unix.go`)

Unix prüft "Eigentümer root, nicht schreibbar für Gruppe und andere" für die Datei und jeden
Ordner darüber bis `/` (`trust_unix.go:37-113`, Schleife `:76-96`). Windows bekommt dieselben
Funktionen (`TrustedFile`, `TrustedDir`, `EnsureRootDir`, `UntrustedError`) in
`trust_windows.go`. Eine wörtliche Übertragung scheitert an jeder Standardinstallation:
`C:\` gibt "Authentifizierte Benutzer" das Recht "Ordner erstellen" (`AD`) auf den Ordner
selbst, `C:\ProgramData` gibt "Benutzer" `WD,AD,WEA,WA`. Darum zwei Regelsätze:

- **Vertraute Prinzipale:** SYSTEM (`S-1-5-18`), Administratoren (`S-1-5-32-544`),
  TrustedInstaller (`S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464`). Ein
  Entwicklungslauf ohne Rechte vertraut zusätzlich dem eigenen Benutzer-SID (wie
  `trustedUID`, `trust_unix.go:25-27`).
- **Eigentümer** (`GetNamedSecurityInfoW`, `OWNER_SECURITY_INFORMATION`) muss für jeden
  geprüften Bestandteil vertraut sein.
- Bewertet werden nur Allow-ACEs, die nicht `INHERIT_ONLY_ACE` sind, für nicht vertraute
  SIDs. `CREATOR OWNER` (`S-1-3-0`) zählt nur, wenn der ACE nicht inherit-only ist. Eine
  NULL-DACL ist unvertraut. Generische Rechte werden vor der Bewertung über das
  Datei-Mapping aufgelöst.
- **Strenger Satz** für das geprüfte Objekt selbst und seinen direkten Elternordner:
  verboten sind `FILE_WRITE_DATA`/`FILE_ADD_FILE`, `FILE_APPEND_DATA`/`FILE_ADD_SUBDIRECTORY`,
  `FILE_WRITE_EA`, `FILE_WRITE_ATTRIBUTES`, `FILE_DELETE_CHILD`, `DELETE`, `WRITE_DAC`,
  `WRITE_OWNER`, `GENERIC_WRITE`, `GENERIC_ALL`.
- **Vorfahren-Satz** für alle Ordner darüber bis zum Volume-Stamm: verboten sind nur Rechte,
  mit denen jemand einen vorhandenen Eintrag entfernen, umbenennen oder neu berechtigen kann:
  `DELETE`, `FILE_DELETE_CHILD`, `WRITE_DAC`, `WRITE_OWNER`, `GENERIC_WRITE`, `GENERIC_ALL`.
  Anlegen neuer Einträge (`AD`, `WD`) und `WEA`/`WA` auf einem Vorfahren ändern den
  geprüften Pfad nicht; ein Reparse-Point lässt sich auf einen nicht leeren Ordner nicht
  setzen, und jeder Bestandteil wird ohnehin auf Reparse-Points geprüft (unten).
- **Restore-Ziel:** Der Elternordner des Ziels darf zusätzlich `FILE_ADD_FILE` und
  `FILE_ADD_SUBDIRECTORY` für nicht vertraute SIDs haben (das deckt `C:\` als Elternordner
  von `C:\Restow-Restore-…`). Das ersetzt `allowSticky`; der Parameter entfällt unter
  Windows, die Signatur bleibt plattformgleich (`TrustedDir(dir, allowSticky)` mit
  `allowSticky` = "Elternordner eines Restore-Ziels").
- **Umleitungen:** Jeder Pfadbestandteil unter dem Volume-Stamm wird mit
  `FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS` geöffnet; ist
  `FILE_ATTRIBUTE_REPARSE_POINT` gesetzt (Symlink, Junction, Einhängepunkt), ist der Pfad
  unvertraut. Danach wird der Pfad über `GetFinalPathNameByHandleW` aufgelöst
  (`VOLUME_NAME_DOS`, Präfix `\\?\` entfernt) und das Ergebnis zurückgegeben, wie
  `filepath.EvalSymlinks` unter Unix (`trust_unix.go:44`). 8.3-Kurznamen (`PROGRA~1`) sind
  damit aufgelöst. Der Laufwerksbuchstabe wird großgeschrieben.
- **Pfadformen:** Nur Laufwerkspfade `X:\…`. UNC (`\\server\share`), Gerätepfade (`\\.\`,
  `\\?\`) und relative Laufwerkspfade (`C:foo`) sind unvertraut.

Die ACE-Bewertung (Maske, SID, Flags → erlaubt/verboten, je Regelsatz) ist eine reine
Funktion in `paths/acl.go` ohne Build-Tag. Ihre Tests nutzen als Testdaten die echte
`icacls`-Ausgabe von `C:\`, `C:\ProgramData`, `C:\Program Files` und `C:\Windows\Temp` einer
frischen Windows-11- und Server-2022-Installation, als SDDL abgelegt
(`paths/testdata/*.sddl`) **[Maschine]**.

Verwendet wird die Prüfung wie heute: für `restic.exe` vor jedem Start
(`paths.TrustedRestic`, `paths.go:165-174`), für den Ordner der Binaries vor einem Update
(`update.go:164-171`), für Hook-Skripte (`hooks/policy.go:89-104`), für das Restore-Ziel
(Abschnitt 18) und für `service install` (`cmd/restow-agent/service.go:42-55`).

## 7. Geheimnisse: DPAPI und Datei-ACL

Unix: `state.json` mit `0600` in einem `0700`-Ordner, Eigentümer root
(`agent/internal/state/state.go:104-145`, `fs_unix.go:11-53`).

Windows:

- `state.json` bleibt JSON mit `schemaVersion: 1`. Die Felder `agentSecret` und
  `repositoryPassword` werden nicht im Klartext geschrieben, sondern als
  `"protected": { "scheme": "dpapi-machine", "blob": "<base64>" }`; der Blob ist
  `CryptProtectData` über das JSON `{"agentSecret": …, "repositoryPassword": …}` mit
  `CRYPTPROTECT_LOCAL_MACHINE | CRYPTPROTECT_UI_FORBIDDEN`, Beschreibung
  `Restow agent state`, ohne zusätzliche Entropie. Alle anderen Felder bleiben lesbar
  (`restow-agent status` und Diagnose brauchen sie nicht entschlüsselt).
- `Load` unter Windows verlangt `protected` und lehnt Klartext-Geheimnisse ab.
- `checkFile` (Windows): reguläre Datei, kein Reparse-Point, Eigentümer vertraut,
  DACL ohne Lese- oder Schreibrecht für nicht vertraute SIDs. Statt "Modus korrigieren"
  (`fs_unix.go:46-51`) setzt Windows die geschützte DACL neu, meldet eine Warnung und
  schreibt ein Ereignis (Abschnitt 9.5).
- `ensureDir` legt `state` mit `CreateDirectoryW` und der SDDL aus Abschnitt 5 an
  (Sicherheitsattribut beim Anlegen, kein Zeitfenster).
- **Warum Maschinenbereich:** `enroll`, `hooks`, `backup-now`, `update` und `installation`
  laufen als Administrator und lesen den ganzen Zustand samt Geheimnissen
  (`cmd/restow-agent/common.go:57-72`, `installation.go:96-101`, `hookscmd.go:61`); der
  Dienst liest ihn als SYSTEM. Der Benutzerbereich von SYSTEM schiede diese Befehle aus.
- **Was DPAPI hier leistet, und was nicht.** Die Grenze ist die DACL (nur SYSTEM und
  Administratoren). Mit `CRYPTPROTECT_LOCAL_MACHINE` und ohne Entropie kann **jeder Prozess
  auf diesem Rechner** den Blob entschlüsseln, auch LocalService, NetworkService oder ein
  IIS-Anwendungspool, sobald er die Datei lesen kann. DPAPI schützt nur eine Kopie der
  **Datei allein** (z. B. aus einem Restore an einen falschen Ort); ein Abbild des ganzen
  Volumes oder eine Schattenkopie von `C:\` enthält auch die Hives `SYSTEM` und `SECURITY`
  und damit das Nötige zum Entschlüsseln. Das ist schwächer als Unix (dort liest nur root),
  und so steht es im Sicherheitsmodell von docs/AGENT.md.
- `hooks`, `serverUrl` und `repositoryUrl` stehen im Klartext neben dem Blob und sind nicht
  gegen Änderung gesichert; ihre Unversehrtheit hängt allein an der DACL.
- Der Agent schließt `C:\ProgramData\Restow` selbst aus jeder Sicherung aus (Abschnitt 16.2),
  der Blob landet also nicht im Repository.

**Atomares Schreiben unter Windows** (`internal/atomicfile`). `os.Rename` macht unter Windows
`MoveFileEx(…, MOVEFILE_REPLACE_EXISTING)`. Das scheitert mit "Zugriff verweigert" oder
"Freigabeverletzung", solange ein anderer Prozess die Zieldatei ohne `FILE_SHARE_DELETE`
offen hat, und Go öffnet Dateien genau so (`syscall.Open`, `sharemode =
FILE_SHARE_READ | FILE_SHARE_WRITE`, Go `src/syscall/syscall_windows.go:374`). Leser sind
`restow-agent status`, ein Log-Betrachter des Administrators und Virenscanner. Darum:

- Jede atomare Ersetzung (`state.go:140`, `status/status.go:195`, `core/outbox.go:48`,
  `update.go:286`) geht über `atomicfile.Replace`: temporäre Datei im selben Ordner,
  `MoveFileExW(…, MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)`, bei
  `ERROR_ACCESS_DENIED` oder `ERROR_SHARING_VIOLATION` bis zu 10 Versuche mit steigender
  Pause (50 ms bis 1 s). `svc.go:156` schreibt nur Unit-Dateien und bleibt Unix.
- Eigene Leser öffnen über `atomicfile.Open` (`syscall.CreateFile` mit
  `FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE`).
- Log-Rotation (`logging/rotate.go:70-86`): Scheitert das Umbenennen von `agent.log`, schreibt
  der Agent in die bisherige Datei weiter und versucht es bei der nächsten Rotation erneut,
  statt mit Fehler zurückzukehren.

## 8. Rechteprüfung

`requireRoot` (`agent/cmd/restow-agent/common.go:29-35`) prüft `os.Geteuid() == 0`. Unter
Windows liefert `Geteuid` immer `-1`. Neu `isPrivileged()` je System:

- Windows: `OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY)`, dann
  `GetTokenInformation(TokenUser)`: SID `S-1-5-18` heißt SYSTEM (Dienst). Sonst
  `GetTokenInformation(TokenElevation)`: `TokenIsElevated != 0` heißt erhöhte
  Administratorsitzung. Ein Administrator ohne Erhöhung (UAC) gilt als nicht berechtigt.
- Meldung statt `sudo`: "restow-agent <cmd> muss in einer PowerShell oder Eingabeaufforderung
  laufen, die als Administrator gestartet wurde (Rechtsklick > Als Administrator ausführen)."
- Alle Texte mit `sudo` (z. B. `hooks/policy.go:86`, `enroll.go:77`, Ausgaben in
  `service.go`, `update.go`) bekommen eine Windows-Fassung über eine kleine Hilfsfunktion
  `adminHint(cmd)`.
- VSS braucht die erhöhten Rechte zusätzlich (restic `HasSufficientPrivilegesForVSS`). Ein
  Entwicklungslauf ohne Rechte (`RESTOW_AGENT_DIR`) schaltet VSS ab und protokolliert das.

## 9. Dienst

### 9.1 Einrichtung (`internal/svc/scm_windows.go`)

Ausschließlich über advapi32, nicht über `sc.exe`: `sc.exe` hat eine eigenwillige Syntax
(`binPath= "…"`) und lokalisierte Ausgabe, die man nicht zuverlässig auswerten kann.
`sc.exe` und `services.msc` bleiben in der Doku als Werkzeuge für den Administrator.

| Einstellung | Wert |
| --- | --- |
| Name / Anzeigename | `RestowAgent` / `Restow Agent` |
| Beschreibung (`SERVICE_CONFIG_DESCRIPTION`) | "Sichert diesen Rechner in die Restow-Instanz (restic). https://<instanz>" |
| Typ | `SERVICE_WIN32_OWN_PROCESS` |
| Start | `SERVICE_AUTO_START` mit `SERVICE_CONFIG_DELAYED_AUTO_START_INFO` = verzögert (bremst den Systemstart nicht; verpasste Sicherungen holt die Richtlinie ohnehin nach) |
| Konto | LocalSystem (`lpServiceStartName = NULL`) |
| Programm | `"C:\Program Files\Restow\bin\restow-agent.exe" run --service` (immer in Anführungszeichen, sonst "unquoted service path") |
| Fehleraktionen (`SERVICE_CONFIG_FAILURE_ACTIONS`) | Neustart nach 5 s, 30 s, 60 s; Zähler-Reset nach 1 Tag |
| `SERVICE_CONFIG_FAILURE_ACTIONS_FLAG` | `TRUE`: die Aktionen gelten auch, wenn der Dienst mit einem Fehlercode endet (nicht nur bei Absturz) |
| `SERVICE_CONFIG_PRESHUTDOWN_INFO` | 60 s |
| `SERVICE_CONFIG_REQUIRED_PRIVILEGES_INFO` | `SeBackupPrivilege`, `SeRestorePrivilege`, `SeSecurityPrivilege`, `SeTakeOwnershipPrivilege`, `SeCreateSymbolicLinkPrivilege`, `SeChangeNotifyPrivilege`, `SeImpersonatePrivilege`, `SeCreateGlobalPrivilege`, `SeManageVolumePrivilege`; endgültige Liste nach Maschinentest mit VSS **[Maschine]** |
| `SERVICE_CONFIG_SERVICE_SID_INFO` | `SERVICE_SID_TYPE_UNRESTRICTED` (SID `NT SERVICE\RestowAgent`) |

Härtung: Linux hat eine Liste für systemd (docs/AGENT.md, "Dienst-Härtung"). Unter Windows
erbten restic (das Daten aus einem servergesteuerten Repository verarbeitet) und Hooks sonst
das volle SYSTEM-Token mit `SeDebugPrivilege`, `SeTcbPrivilege`, `SeLoadDriverPrivilege` und
`SeAssignPrimaryTokenPrivilege`. Mit der Liste oben entfernt der SCM beim Start alle anderen
Privilegien aus dem Token; Kindprozesse erben das reduzierte Token. Ob der SCM die Liste auch
für LocalSystem durchsetzt und ob VSS damit auskommt, prüft ein `windowsintegration`-Test, der
die Privilegien aus dem laufenden Dienst liest, und der Maschinentest **[Maschine]**. Hooks,
die mehr brauchen, sind eine bekannte Grenze (dokumentiert). Die Dienst-SID erlaubt später
ACLs auf `NT SERVICE\RestowAgent` statt auf ganz SYSTEM; in 0.5.0 bleiben die DACLs bei SY
und BA.

Die Methoden des vorhandenen Interfaces (`svc.go:72-103`):

- `Install(exe)`: `OpenSCManagerW(SC_MANAGER_CREATE_SERVICE)`, `CreateServiceW`, dann
  `ChangeServiceConfig2W` für die Einstellungen oben. Existiert der Dienst, wird er über
  `ChangeServiceConfigW`/`ChangeServiceConfig2W` angeglichen (wiederholbar wie heute).
- `Start`, `Stop`, `Restart`: `StartServiceW`, `ControlService(SERVICE_CONTROL_STOP)` und
  Warten auf `SERVICE_STOPPED` über `QueryServiceStatusEx` (bis 90 s).
- `Status`: `QueryServiceStatusEx` liefert Zustand und PID.
- `Uninstall`: stoppen, `DeleteService`.
- `UninstallFromInside`: `DeleteService` zuerst (der SCM entfernt den Eintrag, sobald der
  Prozess endet), dann räumt der Agent auf und beendet sich (Abschnitt 9.4).
- `Refresh(exe)`: `QueryServiceConfigW` und `QueryServiceConfig2W`; weicht Programm,
  Startart, Fehleraktion oder Privilegienliste ab, wird angeglichen.
- `ReloadFromInside`: gibt `exitNow = true` zurück; der Neustart kommt über die Fehleraktion
  (Abschnitt 9.3).
- `Program`: Programmpfad aus `lpBinaryPathName` (erstes Argument, Anführungszeichen entfernt).
- `Name()`: `"Windows-Dienst"`.

`svc.New` (`svc.go:106-118`) gibt unter Windows diesen Manager zurück.

### 9.2 Dienst-Hauptprogramm (`internal/winsvc`)

`restow-agent run --service` (neue Flagge in `cmd/restow-agent/run.go`):

1. `main` ruft `StartServiceCtrlDispatcherW` mit einer `SERVICE_TABLE_ENTRYW` für
   `RestowAgent`; `ServiceMain` ist ein `syscall.NewCallback`. Der Aufruf blockiert, bis der
   Dienst endet.
2. `ServiceMain` registriert `HandlerEx` (`RegisterServiceCtrlHandlerExW`, ebenfalls
   `NewCallback`), meldet `SERVICE_START_PENDING`, startet die heutige `cmdRun`-Logik
   (`run.go:27-104`) in einer Goroutine mit einem eigenen Kontext und meldet
   `SERVICE_RUNNING` mit `SERVICE_ACCEPT_STOP | SERVICE_ACCEPT_PRESHUTDOWN`.
3. `HandlerEx` bei `SERVICE_CONTROL_STOP` oder `SERVICE_CONTROL_PRESHUTDOWN`: Kontext
   abbrechen, `SERVICE_STOP_PENDING` mit `dwWaitHint = 10000` und steigendem
   `dwCheckPoint` alle 5 s melden, bis `cmdRun` zurückkehrt. `SERVICE_CONTROL_INTERROGATE`:
   aktuellen Zustand melden. Alles andere: `ERROR_CALL_NOT_IMPLEMENTED`.
4. Ende: `SERVICE_STOPPED` mit Exit-Code. `0` bei normalem Ende; bei `core.ErrRestart`
   (`agent/internal/core/agent.go:33-35`, `run.go:94-96`) `dwWin32ExitCode =
   ERROR_SERVICE_SPECIFIC_ERROR`, `dwServiceSpecificExitCode = 3`; bei Fehler `1`.

Im Dienstmodus gibt es kein `signalContext` (`common.go:101-103`): Stoppen kommt nur über
`HandlerEx`. Ohne `--service` läuft `run` wie heute im Vordergrund (Konsole, Strg+C), für
Fehlersuche. Logs gehen im Dienstmodus in die rotierende Datei; die Erkennung von journald
über `INVOCATION_ID` (`run.go:43`) entfällt unter Windows. Was unter Linux journald als Senke
außerhalb der eigenen Dateien leistet, übernimmt für sicherheitsrelevante Ereignisse die
Ereignisanzeige (Abschnitt 9.5).

**Konsole für das Stoppsignal an restic.** Beim Start im Dienstmodus ruft der Agent einmal
`AllocConsole`. Gibt der Aufruf `ERROR_ACCESS_DENIED` zurück, hat der Prozess schon eine
Konsole; das gilt als Erfolg. Danach bestätigt `GetConsoleProcessList` (Ergebnis ≥ 1), dass
eine Konsole da ist; sonst protokolliert der Agent, dass restic nur hart beendet werden kann.
Die Konsole liegt in Sitzung 0 und ist unsichtbar. restic startet **ohne**
`CREATE_NO_WINDOW` und erbt sie (Abschnitt 12.1). Der Agent selbst reagiert im Dienstmodus
nicht auf Konsolenereignisse; das Go-Laufzeitsystem beendet einen Dienst seit Go 1.17 nicht
mehr bei `CTRL_LOGOFF_EVENT`/`CTRL_SHUTDOWN_EVENT` **[Maschine]**: Abmelden eines Benutzers
während eines Laufs.

### 9.3 Neustart nach Selbstaktualisierung

systemd startet den Agenten nach `exit 0` neu (`Restart=always`). Der SCM tut das nicht: Er
startet nur nach einem Fehler neu. Darum endet der Dienst nach einem Update mit dem
dienstspezifischen Code 3 (9.2, Schritt 4), und die Fehleraktion mit
`FailureActionsOnNonCrashFailures = TRUE` startet ihn nach 5 s neu, jetzt mit der neuen
`restow-agent.exe` am selben Pfad. Nebenwirkung: Die Ereignisanzeige zeigt Ereignis 7024
("beendet mit dienstspezifischem Fehler 3"). docs/AGENT.md erklärt das; das eigene Ereignis
"Update auf Version X installiert" (9.5) steht unmittelbar davor. Die Alternative, ein
abgekoppelter Hilfsprozess mit `sc.exe start`, ist verworfen: zusätzlicher Prozess,
Wettlauf mit dem Ende des Dienstes.

### 9.4 Deinstallation

- **Von Hand über den Installer** (`windows.ps1 -Uninstall`, empfohlener Weg): Das Skript
  ruft `restow-agent.exe uninstall --keep-binaries`, wartet auf das Ende des Prozesses und
  löscht danach `C:\Program Files\Restow` selbst. Kein Rest, kein Hilfsprozess.
- **Von Hand über das Binary** (`restow-agent.exe uninstall`, erhöht) und **aus dem Dienst**
  (Aufgabe `uninstall` vom Server, `UninstallFromInside`): Ablauf wie `svc.Uninstall`
  (`internal/svc/uninstall.go`): Dienst stoppen bzw. löschen, Logger und Laufsperre
  **schließen**, dann `C:\ProgramData\Restow` entfernen, dann `restic.exe` und
  `THIRD_PARTY_NOTICES.txt`. Die laufende `restow-agent.exe` und der Ordner
  `C:\Program Files\Restow` werden mit `MoveFileExW(…, MOVEFILE_DELAY_UNTIL_REBOOT)` zum
  Löschen beim nächsten Neustart vorgemerkt. Bis dahin bleibt eine Datei ohne Dienst liegen;
  `status` des Installers und die Doku sagen das. Kein `cmd /c ping … & rd`: das Muster
  scheitert an Gos Quoting der Argumente, öffnet ein Konsolenfenster und ist zugleich die
  typische Selbstlöschung von Schadsoftware, die Defender- und EDR-Heuristiken auslöst.
- **Logs bei Deinstallation aus dem Dienst:** `UninstallFromInside` behält unter Windows
  `C:\ProgramData\Restow\logs` (wie `--keep-logs`, `uninstall.go:140`; Standard bei Hand
  bleibt "löschen", `service.go:98`) und schreibt vorher das Ereignis "Deinstalliert durch
  Serveraufgabe <id>" (9.5). Sonst löschte eine Aufgabe vom Server die einzige lokale Spur.
- `protectedDirs` (`uninstall.go:39-43`) bekommt eine Windows-Liste: Laufwerkswurzeln,
  `%SystemRoot%`, `C:\Program Files`, `C:\Program Files (x86)`, `C:\ProgramData`,
  `C:\Users`, alle Vergleiche ohne Groß-/Kleinschreibung.

### 9.5 Ereignisanzeige (`internal/eventlog`)

- Quelle `Restow` im Protokoll "Anwendung". Der Installer legt sie an
  (`New-EventLog -LogName Application -Source Restow`, Windows PowerShell 5.1; registriert
  die .NET-Meldungsdatei `EventLogMessages.dll`, deren Meldungen nur `%1` sind). Der Agent
  schreibt über `RegisterEventSourceW`/`ReportEventW` (advapi32) einen Text je Ereignis.
  Fehlt die Quelle, schreibt `ReportEventW` trotzdem; die Ereignisanzeige zeigt dann den
  Hinweis "Beschreibung nicht gefunden" mit dem Text darunter **[Maschine]**.
- Ereignisse (feste IDs, Text englisch wie das Log): Anmeldung (`enroll`), Änderung der
  Hook-Regel, Ablehnung durch die Vertrauensprüfung, Reparatur einer State-DACL, Update
  installiert, Signatur- oder Prüfsummenfehler beim Update, Wiederherstellung mit Ziel,
  Deinstallation (mit Aufgaben-ID, falls vom Server).
- Unter Linux und macOS ohne Wirkung (journald bzw. Unified Log haben die Zeilen schon).

## 10. Einzelinstanz-Sperre

`internal/lock/lock_windows.go` mit derselben API (`TryAcquire`, `Release`, `ErrLocked`;
`lock.go:16-50`), genutzt in `core/agent.go:843`:

- `CreateFileW(run.lock, GENERIC_READ|GENERIC_WRITE, FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,
  OPEN_ALWAYS)`, dann `LockFileEx(h, LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
  0, 1, 0, &overlapped)` auf das erste Byte.
- `ERROR_LOCK_VIOLATION` (33) und `ERROR_IO_PENDING` werden `ErrLocked`. Die Konstanten
  fehlen in `syscall`; sie stehen in `internal/winapi` als `syscall.Errno(33)` usw.
- Freigabe: `UnlockFileEx` und `CloseHandle`. Endet der Prozess, gibt Windows die Sperre
  mit dem Handle frei, wie `flock` unter Unix.
- Der Test `lock_test.go` (heute `unix`) wird plattformneutral: zweiter Prozess bekommt
  `ErrLocked`, nach Ende des ersten die Sperre.

## 11. Netzteil

`internal/power/power_windows.go`: `GetSystemPowerStatus` (kernel32) füllt
`SYSTEM_POWER_STATUS`. Auswertung als reine Funktion `windowsPower(acLine, batteryFlag byte)`
mit Tests:

| Werte | Ergebnis |
| --- | --- |
| `BatteryFlag & 128` (kein Systemakku) | `OnAC: true, Known: true, "no battery present"` |
| `ACLineStatus == 1` | `OnAC: true, Known: true, "AC power"` |
| `ACLineStatus == 0` | `OnAC: false, Known: true, "running on battery"` |
| `ACLineStatus == 255` oder Aufruf schlägt fehl | `OnAC: true, Known: false` (wie heute: Erkennung blockiert nie, `power.go:1-5`) |

Eine USV über HID meldet Windows als Akku; ein Server an einer USV gilt dann bei Stromausfall
als "auf Akku", wie `pmset` unter macOS (`power.go:95-96`).

## 12. Prozesssteuerung

### 12.1 restic stoppen

Heute: `cmd.Cancel` sendet `SIGINT`, nach `WaitDelay` (45 s) wird getötet
(`agent/internal/restic/runner.go:128-132`). Unter Windows ist `Process.Signal(os.Interrupt)`
nicht implementiert: Der Agent würde 45 s warten und restic dann hart beenden; restic ließe
seine Sperre im Repository liegen.

Windows (`runner_windows.go`, über `internal/procctl`):

- restic startet mit `CREATE_NEW_PROCESS_GROUP`, **ohne** `CREATE_NO_WINDOW` (sonst bekäme es
  eine eigene, versteckte Konsole, die `GenerateConsoleCtrlEvent` nicht erreicht), und wird
  direkt nach `cmd.Start()` einem Job Object zugeordnet (12.3).
- `cmd.Cancel` ruft `GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, pid)`. Die neue
  Prozessgruppe sorgt dafür, dass nur restic das Ereignis bekommt, nicht der Agent. restic
  (Go) bekommt `os.Interrupt`, räumt auf (Sperre, Schattenkopie über
  `defer localVss.DeleteSnapshots()`, `cmd_backup.go:592`) und endet mit 130.
- Reagiert restic nicht innerhalb von `WaitDelay`, beendet `TerminateJobObject` restic samt
  allem, was es gestartet hat. Die Schattenkopie ist nicht dauerhaft (`VSS_CTX_BACKUP`,
  Abschnitt 1.2); Windows gibt sie in aller Regel frei, wenn der anfordernde Prozess endet
  **[Maschine]**. Die Repository-Sperre bleibt dann liegen und läuft wie heute ab.
- Voraussetzung: Agent und restic teilen eine Konsole. In der Eingabeaufforderung ist das
  so, im Dienst sorgt `AllocConsole` dafür (9.2). Dass das Signal aus dem echten Dienst in
  Sitzung 0 ankommt, prüft ein CI-Test mit einem echten Testdienst (Abschnitt 22.1).

### 12.2 Hooks

Heute: `/bin/sh -c` oder ein Skript, eigene Prozessgruppe, bei Zeitüberschreitung oder Abbruch
`SIGTERM`, nach 10 s `SIGKILL` (`agent/internal/hooks/hooks.go:88-174`, `:137-149`); jeder
Exit-Code ungleich 0 ist ein Fehler (`:170-172`), ein fehlgeschlagener Pre-Hook bricht die
Sicherung ab.

Windows (`hooks/run_windows.go`, `hooks/resolve_windows.go`):

- **Regel `any`:** `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe -NoLogo
  -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand <Base64(UTF-16LE)>`.
  `-EncodedCommand` umgeht jede Quoting-Frage der Windows-Kommandozeile. Windows PowerShell
  5.1 ist auf jedem unterstützten System vorhanden; PowerShell 7 (`pwsh`) wird nicht
  vorausgesetzt. Der Pfad kommt aus `GetSystemDirectoryW`, nicht aus `PATH`.
- **Exit-Code.** `powershell.exe -Command` liefert nur 0 oder 1 aus `$?` der letzten
  Anweisung, macht aus nativen Codes ungleich 0/1 eine 1 und übergeht nicht abbrechende
  Fehler davor (`Stop-Service X; Copy-Item fehlt` endet mit 0). Darum umhüllt der Agent jeden
  Befehl; der kodierte Text ist (Zeilenumbrüche getrennt, damit ein Kommentar am Ende des
  Befehls die Hülle nicht abschneidet):

  ```powershell
  [Console]::OutputEncoding = [Text.Encoding]::UTF8
  $ErrorActionPreference = 'Stop'
  <Befehl>
  exit $(if ($?) { 0 } elseif ($LASTEXITCODE) { $LASTEXITCODE } else { 1 })
  ```

  Damit bricht ein Cmdlet-Fehler ab (Exit 1), ein natives Programm mit Code 3 liefert 3, ein
  eigenes `exit 5` im Befehl liefert 5. Ein natives Programm, das mitten im Befehl scheitert,
  bricht unter Windows PowerShell 5.1 nicht ab (wie `sh -c` ohne `set -e`); die Doku sagt das.
  Die Hülle ist eine reine Funktion ohne Build-Tag und hat Tabellentests; die tatsächlichen
  Codes prüft der Windows-Job (Abschnitt 22.1).
- **Regel `scripts`:** Name nach `IsScriptName` (`policy.go:61-65`) in
  `C:\ProgramData\Restow\state\hooks.d`, Erweiterung bestimmt den Aufruf. In 0.5.0 nur zwei:
  - `.ps1`: über PowerShell wie oben, der Befehl ist `& '<pfad>'` in derselben Hülle (nicht
    `-File`, damit dieselbe Exit-Code-Regel gilt).
  - `.exe`: direkt, ohne Argumente.

  `.cmd` und `.bat` werden in 0.5.0 nicht ausgeführt (Codepage, Quoting von `cmd.exe`,
  Rückfrage "Batchvorgang abbrechen"); ein `.ps1` kann sie aufrufen. Die Prüfung "ausführbar"
  (`policy.go:100-102`) entfällt unter Windows; die Vertrauensprüfung (`paths.TrustedFile`,
  Abschnitt 6, strenger Satz für Datei und `hooks.d`) bleibt.
- **Ausführungsrichtlinie per GPO:** Eine Richtlinie im Bereich `MachinePolicy` oder
  `UserPolicy` geht `-ExecutionPolicy Bypass` vor. Bei `AllSigned` oder `Restricted` scheitern
  `.ps1`-Hooks mit "Die Ausführung von Skripts ist auf diesem System deaktiviert"; der Agent
  erkennt den Text und meldet den Hook-Fehler mit diesem Hinweis. `RemoteSigned` betrifft
  lokal abgelegte Skripte ohne Mark of the Web nicht. Der Agent umgeht die Richtlinie nicht.
- **Prozessbaum:** `CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW`, eigenes Job Object mit
  `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, Zuordnung direkt nach dem Start (12.3).
- **Zeitüberschreitung und Abbruch:** direkt `TerminateJobObject`, ohne Gnadenfrist. Ein
  `CTRL_BREAK` erreicht einen Prozess mit `CREATE_NO_WINDOW` nicht (eigene Konsole), und
  PowerShell reagiert darauf nicht verlässlich; das ist ein dokumentierter Unterschied zu Unix
  (dort 10 s `SIGTERM`).
- **Normales Ende:** Hintergrundprozesse eines Hooks bleiben unter Unix leben (Kill nur bei
  Zeitüberschreitung, `hooks.go:137-149`). Damit Windows sich gleich verhält, löscht der
  Agent nach normalem Ende das Flag `KILL_ON_JOB_CLOSE` mit `SetInformationJobObject` und
  schließt erst dann den Job-Handle.
- **Arbeitsordner:** `%SystemRoot%\System32` statt `/` (`hooks.go:105`).
- **Ausgabe:** wie heute über eine Pipe; Zeilenenden `\r\n` werden schon entfernt
  (`hooks.go:192`). Die Hülle setzt die Ausgabe auf UTF-8.
- Umgebungsvariablen: Abschnitt 12.4, plus `RESTOW_*` wie heute (`core/backup.go:127-149`).
- **Gemischte Jobs:** Ein Job-Hook gilt für alle Mitglieder (Abschnitt 1.1). Ein für `sh`
  geschriebener Befehl läuft auf einem Windows-Mitglied unter PowerShell und scheitert dort
  in der Regel. Der Job-Editor zeigt bei gesetzten Hooks und gemischten Betriebssystemen
  einen Hinweis und empfiehlt Hooks am Rechner statt am Job (Abschnitt 19.3).

### 12.3 Job Objects

Go startet Prozesse über `CreateProcessW` und gibt den Handle des Hauptthreads nicht heraus.
Ein angehaltener Start (`CREATE_SUSPENDED`, Threads über Toolhelp suchen, `ResumeThread`)
ist verworfen: rund 150 Zeilen und acht weitere API-Funktionen, ungetestet im Dienst, und das
Muster gleicht dem Process Hollowing, auf das EDR-Heuristiken anspringen (Abschnitt 15).

1. `cmd.Start()` ohne `CREATE_SUSPENDED`.
2. Sofort `OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, pid)` und
   `AssignProcessToJobObject`. Scheitert das, wird der Prozess mit `TerminateProcess` beendet
   und der Start als Fehler gemeldet.
3. Bekanntes Restrisiko: Ein Kindprozess könnte in den Mikrosekunden zwischen Start und
   Zuordnung einen Enkel starten, der außerhalb des Jobs landet. restic startet keine
   Kindprozesse; bei Hooks ist das Fenster praktisch ohne Bedeutung.

Ein Job je Kindprozess (`JOBOBJECT_EXTENDED_LIMIT_INFORMATION` mit
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`): Stirbt der Agent, schließt Windows den Job-Handle und
beendet restic und laufende Hooks mit. Verschachtelte Jobs gibt es seit Windows 8, also
überall, wo restic läuft.

### 12.4 Umgebung (`internal/procenv`)

`procenv.Filter` vergleicht Schlüssel mit genauer Schreibweise (`procenv.go:35`) und hängt
sonst einen Unix-`PATH` an (`procenv.go:21, 43-45`). Unter Windows heißt die Variable `Path`;
sie würde verworfen und durch `/usr/local/sbin:…` ersetzt. Änderung:

- Allowlist je System. Windows: `Path`, `PATHEXT`, `SystemRoot`, `windir`, `SystemDrive`,
  `ComSpec`, `TEMP`, `TMP`, `ProgramData`, `ProgramFiles`, `ProgramFiles(x86)`,
  `ProgramW6432`, `CommonProgramFiles`, `CommonProgramW6432`, `ALLUSERSPROFILE`,
  `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `COMPUTERNAME`, `NUMBER_OF_PROCESSORS`,
  `PROCESSOR_ARCHITECTURE`, `PSModulePath`, dazu die Proxy- und CA-Variablen von heute.
- Vergleich unter Windows ohne Groß-/Kleinschreibung (`strings.EqualFold`), ebenso in `Set`
  und `Get`.
- Fehlt `Path`: `%SystemRoot%\System32;%SystemRoot%;%SystemRoot%\System32\Wbem;%SystemRoot%\System32\WindowsPowerShell\v1.0`.
- restic unter Windows: `TMP` und `TEMP` auf `TmpDir` statt `TMPDIR` (`runner.go:74-76`);
  `HOME` wird nicht gesetzt (`runner.go:62-64`), restic nimmt `RESTIC_CACHE_DIR`.

### 12.5 Proxy

Ein Dienst unter SYSTEM nutzt keine Proxy-Einstellung eines Benutzers, und Go wie restic
lesen nur `HTTP(S)_PROXY`/`NO_PROXY` (`http.ProxyFromEnvironment`), nicht WinHTTP. Der
Installer setzt deshalb auf Wunsch (`-Proxy http://proxy:3128`) den Wert `Environment`
(`REG_MULTI_SZ`, `HTTPS_PROXY=…`, `NO_PROXY=…`) am Dienstschlüssel
`HKLM\SYSTEM\CurrentControlSet\Services\RestowAgent`; `procenv` reicht ihn an restic weiter.
Der Wert am Dienst wirkt mit dem nächsten Dienststart; systemweite Variablen (`setx /M`)
sieht ein Dienst dagegen erst nach einem Neustart des Rechners **[Maschine]**.

Grenzen (in "Known limits"):

- Nur ein fester Proxy per URL. Kein WPAD/PAC, keine Anmeldung per NTLM oder Kerberos am
  Proxy; das kann `net/http` der Standardbibliothek nicht.
- **Keine Zugangsdaten in `-Proxy`.** Der Dienstschlüssel ist für Benutzer lesbar; der
  Installer lehnt eine URL mit `user:pass@` ab. Ein Proxy, der Anmeldung verlangt, braucht
  eine Freigabe nach Quell-IP für den Rechner.

## 13. Selbstaktualisierung

Heute (`agent/internal/update/update.go`): Prüfsummen und Signatur laden und prüfen, Datei
unter Zufallsnamen mit `O_EXCL|O_NOFOLLOW` im Bin-Ordner anlegen (`:296-312`), SHA-256
vergleichen, `version` ausführen, alte Datei als `.prev` verlinken, `os.Rename` über die alte
(`:237-291`). restic wird dabei **vor** der Prüfung der Agent-Version ersetzt
(`update.go:187-191`). Die Signatur deckt die Dateiliste, nicht die Versionsnummer: Ein
feindlicher Server kann eine neue Version ankündigen und die gültig signierte Liste eines
älteren Releases liefern; das alte restic ist dann schon installiert, wenn die
Versionsprüfung des Agenten scheitert. Das gilt für alle Systeme.

Neu für alle Systeme: erst prüfen, dann tauschen. Agent und restic werden beide gestaged und
geprüft (SHA-256 gegen die signierte Liste, `version` des Agenten muss die angekündigte
Version sein, `restic version` muss zur angekündigten restic-Version passen), erst dann wird
irgendetwas umbenannt, restic zuerst, der Agent zuletzt.

Unter Windows lässt sich eine laufende `.exe` nicht überschreiben und nicht löschen, wohl
aber umbenennen (das Abbild ist mit `FILE_SHARE_DELETE` geöffnet). Ablauf
(`swap_windows.go`):

1. Dateinamen je System: `restow-agent.exe`, `restic.exe` (`update.go:48-49`);
   `sums.Lookup(target, …)` (`:151-158`) und die Download-URL (`:174`) nutzen sie.
2. Staging: `.restow-agent.new-<16 hex>.exe` und `.restic.new-<16 hex>.exe` (Endung `.exe`
   am Ende, damit `RunVersion` (`:329-339`) die Datei starten kann). `O_CREATE|O_EXCL` wird
   `CREATE_NEW`; `O_NOFOLLOW` gibt es unter Windows nicht und ist durch die
   Vertrauensprüfung des Ordners ersetzt (Abschnitt 6, strenger Satz für `bin`).
   `CleanupStaged` (`:342-353`) erkennt die Namensformen.
3. Prüfen wie oben, für beide Dateien, bevor etwas getauscht wird.
4. Tausch von restic.exe: Updates laufen nur im Leerlauf (`core.ErrBusy`), restic läuft also
   nicht. Alte Datei nach `restic.exe.old-<hex>` umbenennen, gestagte Datei an ihren Platz;
   lässt sich die alte Datei nicht löschen, `MOVEFILE_DELAY_UNTIL_REBOOT`.
5. Tausch des Agenten: alte `restow-agent.exe.prev` löschen (falls nicht in Benutzung),
   `MoveFileExW(restow-agent.exe, restow-agent.exe.prev)` (geht trotz laufendem Prozess),
   dann `MoveFileExW(staged, restow-agent.exe, MOVEFILE_WRITE_THROUGH)`. Scheitert der
   zweite Schritt, werden `.prev` und `restic.exe.old-<hex>` zurückbenannt.
6. Defender scannt frisch geschriebene `.exe` und hält sie kurz offen: jedes Umbenennen über
   `atomicfile` mit Wiederholung (Abschnitt 7).
7. Neustart: `core.ErrRestart`, Dienst endet mit Code 3, Fehleraktion startet neu (9.3).
   `cmd/restow-agent/update.go:21-33` (`restartService`) nutzt `Restart()` des Managers.

## 14. Installer `windows.ps1`

### 14.1 Aufruf

Der Server liefert `GET /install/windows.ps1` wie `linux.sh` aus und ersetzt dieselben
Platzhalter (`__RESTOW_URL__`, `__RESTOW_VERSION__`, `__RESTOW_RELEASE_KEY__`). Das Skript
ist reines ASCII (sonst verfälscht `Invoke-RestMethod` es je nach Codepage) und verlangt
Windows PowerShell 5.1 (in jedem unterstützten Windows enthalten); PowerShell 7 geht auch.

Befehle, die der Enroll-Dialog zeigt (in "PowerShell (Administrator)"):

```powershell
# Installation (fragt nach dem Token, Eingabe verdeckt)
[Net.ServicePointManager]::SecurityProtocol = 'Tls12'; iex (irm -UseBasicParsing 'https://restow.example.com/install/windows.ps1')

# Unbeaufsichtigt (RMM): Token aus einer Datei, Schlüssel-Pin Pflicht
$env:RESTOW_TOKEN_FILE = 'C:\Windows\System32\config\systemprofile\restow-enrollment.token'; $env:RESTOW_RELEASE_KEY_FINGERPRINT = 'SHA256:…'; [Net.ServicePointManager]::SecurityProtocol = 'Tls12'; iex (irm -UseBasicParsing 'https://restow.example.com/install/windows.ps1')

# Entfernen
[Net.ServicePointManager]::SecurityProtocol = 'Tls12'; & ([scriptblock]::Create((irm -UseBasicParsing 'https://restow.example.com/install/windows.ps1'))) -Uninstall

# Hooks erlauben
& 'C:\Program Files\Restow\bin\restow-agent.exe' hooks scripts
```

Begründungen:

- `SecurityProtocol = 'Tls12'` steht vor `irm`, weil Windows PowerShell 5.1 auf Server 2016
  ohne `SchUseStrongCrypto` nur TLS 1.0 anbietet; der Abruf des Skripts selbst würde sonst
  scheitern.
- `-UseBasicParsing`: ohne es braucht PowerShell 5.1 die Internet-Explorer-Engine, die auf
  Server Core fehlt.
- `iex` eines Strings unterliegt nicht der Ausführungsrichtlinie (anders als eine
  heruntergeladene `.ps1` mit Mark of the Web). AMSI, ASR- und EDR-Regeln melden das Muster
  `iex (irm …)` aber häufig (Abschnitt 15). Die Doku nennt darum gleichwertig den Weg
  "Datei laden, SHA-256 mit dem Wert im Enroll-Dialog vergleichen, mit
  `powershell -ExecutionPolicy Bypass -File windows.ps1` starten".
- Die Token-Datei liegt im Profil von SYSTEM (`config\systemprofile`), als Gegenstück zu
  `/root/restow-enrollment.token` (`apps/api/src/features/endpoints/commands.ts:45-48`).
  RMM-Werkzeuge laufen meist als SYSTEM und können dort schreiben. Ein 32-Bit-RMM-Prozess
  (Intune startet Skripte standardmäßig 32-bittig) sieht `System32` umgeleitet nach
  `SysWOW64`; die Doku nennt für diesen Fall `C:\Windows\Sysnative\config\systemprofile\…`
  zum Schreiben der Datei. Der Installer selbst startet sich 64-bittig neu (14.2).
- Dokumentiert wird nur `RESTOW_TOKEN_FILE`. `RESTOW_TOKEN` als Variable bleibt für Tests,
  steht aber nicht in der Doku: getippt landet es im PSReadLine-Verlauf und in der
  Skriptblock-Protokollierung (Ereignis 4104). Der Token wird nie als Cmdlet- oder
  Prozessargument übergeben (Ereignisse 4103, 4688), nur über die Umgebung des Kindprozesses.
- `RESTOW_RELEASE_KEY_FINGERPRINT` (oder Parameter `-ReleaseKeyFingerprint`): Pin auf den
  Release-Schlüssel (Abschnitt 14.3). Im unbeaufsichtigten Aufruf Pflicht; der Dialog füllt
  ihn vor, die Doku sagt, ihn einmal mit den Release-Notizen auf GitHub abzugleichen.
- Optionen als Umgebungsvariablen oder, über den Scriptblock-Aufruf, als Parameter:
  `-Hooks off|scripts|any`, `-Uninstall`, `-Proxy <url>`, `-ReleaseKeyFingerprint <fp>`.

### 14.2 Ablauf

Das Skript beginnt mit `Set-StrictMode -Version 2` und `$ErrorActionPreference = 'Stop'`;
jeder Schritt steht in `try`/`catch`, ein Fehler beendet das Skript mit Exit-Code ungleich 0.

1. **Vorbedingungen:**
   - 32-Bit-Host auf 64-Bit-Windows (`-not [Environment]::Is64BitProcess` und
     `[Environment]::Is64BitOperatingSystem`): Das Skript startet sich in
     `$env:windir\Sysnative\WindowsPowerShell\v1.0\powershell.exe` neu. Weil der Skripttext
     für `-EncodedCommand` zu lang ist, lädt der Neustart das Skript per
     `iex (irm …)` mit derselben URL neu; Parameter werden vorher in die entsprechenden
     `RESTOW_*`-Variablen übertragen, die der Kindprozess erbt. Ein zweiter 32-Bit-Start
     bricht ab. Pfade kommen danach aus `[Environment]::GetFolderPath` bzw. `$env:ProgramW6432`,
     nie aus `$env:ProgramFiles` eines 32-Bit-Hosts.
   - Administrator und erhöht
     (`[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole('Administrators')`),
     Windows-Build ab 14393 (`[Environment]::OSVersion.Version`). Architektur des
     **Systems** über `$env:PROCESSOR_ARCHITEW6432`/`PROCESSOR_ARCHITECTURE` und, wenn
     vorhanden, `[Runtime.InteropServices.RuntimeInformation]::OSArchitecture`: Eine
     x64-PowerShell unter ARM64-Emulation meldet sonst `AMD64`. ARM64 wird mit klarer Meldung
     abgelehnt.
   - `$ProgressPreference = 'SilentlyContinue'` (der Fortschrittsbalken macht Downloads in
     5.1 um ein Vielfaches langsamer). Läuft PowerShell im Constrained Language Mode
     (AppLocker/WDAC), bricht das Skript mit Verweis auf die manuelle Installation ab.
   - `-Proxy` mit Zugangsdaten in der URL wird abgelehnt (12.5).
2. **Prüfsummen und Signatur:** `SHA256SUMS` und `SHA256SUMS.sig` von
   `/install/agent/<version>/` laden und prüfen (14.3). Ohne gültige Signatur wird nichts
   installiert. **Direkt danach**, vor jedem weiteren Download, gibt das Skript
   "Signatur: OK (Release-Schlüssel SHA256:…)" aus, wie `linux.sh:304`. Ist ein Pin gesetzt
   und passt er nicht, bricht es hier ab. Testschalter wie in `agent/install/linux.sh:43-52`
   (`RESTOW_ALLOW_UNSIGNED_DEV` nur für `*-dev`, `RESTOW_SHA256SUMS_SHA256` für die
   manuelle Prüfung auf einem anderen Rechner, `RESTOW_ALLOW_INSECURE_HTTP` nur für Tests).
3. **Ordner prüfen:** `C:\ProgramData\Restow` muss fehlen oder Eigentümer SYSTEM,
   Administratoren oder TrustedInstaller haben und darf kein Reparse-Point sein (`Get-Item`
   `.Attributes`, `Get-Acl` `.Owner`); sonst Abbruch ohne Reparatur. Ein Benutzer könnte den
   Ordner sonst vorher anlegen, als Eigentümer `WRITE_DAC` erlangen und Dateien des Installers
   austauschen. Dasselbe für `C:\Program Files\Restow`, falls vorhanden.
4. **Download:** `windows-amd64/restow-agent.exe`, `restic.exe`, `THIRD_PARTY_NOTICES.txt`
   in einen neuen Ordner `C:\Program Files\Restow\.stage-<zufall>`. Dort kann ein Benutzer
   nichts vorbereiten. Angelegt wird er mit
   `[IO.Directory]::CreateDirectory(<pfad>, <DirectorySecurity mit SY, BA>)`, also mit der
   DACL im selben Aufruf. Jede Datei mit `Get-FileHash -Algorithm SHA256` gegen die signierte
   Liste. Erst danach wird irgendetwas ausgeführt.
5. **Installation:** Läuft der Dienst schon, `Stop-Service RestowAgent`. Ordner
   `C:\Program Files\Restow\bin` anlegen (erbt die DACL von `Program Files`), Eigentümer und
   DACL mit `Get-Acl` gegen die Regeln aus Abschnitt 6 prüfen. Dateien verschieben; eine
   laufende alte `restow-agent.exe` wird wie in Abschnitt 13 umbenannt. **Am Zielort**
   werden die Hashes unmittelbar vor `service install` noch einmal geprüft.
6. **Ereignisquelle:** `New-EventLog -LogName Application -Source Restow`, falls nicht
   vorhanden (9.5).
7. **Dienst und Anmeldung:** `restow-agent.exe service install`, dann `enroll` (Token über
   die Umgebung des Kindprozesses, wie `linux.sh`; die Eingabe kommt aus
   `Read-Host -AsSecureString` und wird nur für diesen Aufruf entschlüsselt), dann
   `service start` und `status`. Ist der Rechner schon angemeldet, wird kein Token
   abgefragt (Reparatur/Upgrade, wie unter Linux). Mit `RESTOW_TOKEN_FILE`: vorher die ACL
   der Datei mit den Regeln aus Abschnitt 6 prüfen (Lesen für nicht vertraute SIDs →
   Warnung wie `linux.sh:316-319`), nach erfolgreichem `enroll` die Datei löschen (der
   Token ist ohnehin nur einmal gültig, `agent-service.ts:226-257`).
8. **Aufräumen:** Staging-Ordner löschen.

### 14.3 Signaturprüfung ohne Drittwerkzeuge

Die Releases tragen eine SSH-Signatur (SSHSIG, Ed25519, Namensraum `restow-agent-release`)
über `SHA256SUMS` (`agent/internal/release/sshsig.go`, `linux.sh:232-271`). Windows hat:

- `ssh-keygen.exe` nur, wenn das optionale Feature "OpenSSH-Client" installiert ist (Windows
  10 ab 1809 und Windows 11 meist ja, Server 2016 nie), und `-Y verify` erst ab OpenSSH 8.1;
  die mit Windows 10 ausgelieferte Version ist älter. **[Maschine]**: Versionen auf den
  Testsystemen.
- .NET Framework 4.8 und CNG kennen kein Ed25519 (CNG nur X25519 für Schlüsseltausch).
- Authenticode-Werkzeuge helfen nicht (es gibt keine Authenticode-Signatur).

Entwurf: Der Installer prüft die Signatur **selbst, in PowerShell**:

- SSHSIG zerlegen wie `sshsig.go`: Armor entfernen (genau die erwarteten Kopf- und
  Fußzeilen), `SSHSIG`, Version 1, öffentlicher Schlüssel muss byte-gleich der
  Release-Schlüssel sein, Namensraum `restow-agent-release`, Hash-Algorithmus `sha512`,
  Signatur `ssh-ed25519` mit genau 64 Byte, keine Restbytes. Jede Längenangabe wird gegen den
  verbleibenden Puffer geprüft.
- Signierte Nachricht bauen wie `linux.sh:262-265`: `"SSHSIG" || string(namespace) ||
  string("") || string("sha512") || string(SHA512(SHA256SUMS))`.
- Ed25519-Prüfung mit **derselben Annahmemenge wie der Go-Agent** (`release.Key.Verify`,
  `crypto/ed25519`): kofaktorfrei, `S < L` (sonst ungültig),
  `k = SHA512(R || A || M) mod L`, `R' = [S]B − [k]A`, gültig genau dann, wenn die Kodierung
  von `R'` byte-gleich `R` ist (damit wird auch ein nicht kanonisches `R` abgelehnt). `A` ist
  der fest eingebaute, byte-verglichene Release-Schlüssel und wird einmal dekomprimiert.
  Rechnung mit `[System.Numerics.BigInteger]` und `[System.Security.Cryptography.SHA512]`
  (beides in .NET Framework 4.x enthalten), erweiterte Koordinaten. Etwa 150 Zeilen eigener
  Code, keine Kopie fremder Implementierungen. Laufzeit in PowerShell 5.1 geschätzt wenige
  Sekunden **[Maschine]**.
- **Gegen Fehlöffnen:** Die Prüffunktion gibt genau ein `[bool]` zurück (alle anderen
  Ausgaben mit `$null =` oder `[void]` verworfen); der Aufrufer prüft
  `(Test-ReleaseSignature …) -ceq $true` in `try`/`catch` und bricht sonst ab. Unter
  `Set-StrictMode` und `$ErrorActionPreference = 'Stop'` (14.2) beendet jede Ausnahme in der
  BigInteger-Rechnung das Skript.
- Kein `Add-Type` mit C#: Das kompiliert in eine temporäre DLL, scheitert unter Constrained
  Language Mode und ist ein typischer Auslöser für Defender-Heuristiken.
- **Tests** (Abschnitt 22.1): RFC 8032 Abschnitt 7.1, Vektoren 1 bis 3; die Ed25519-Vektoren
  aus Wycheproof (Apache-2.0, nur als Testdaten im Repository); eine echte Signatur mit
  `agent/release-signing.pub`; Negativfälle: verfälschte Datei, falscher Namensraum, fremder
  Schlüssel, abgeschnittene und überlange Signatur, Zufallsbytes, `S ≥ L`, nicht kanonisches
  `R`, falsche Armor, falsche Blob-Länge, Restbytes. Für jeden Negativfall: Exit-Code ungleich
  0 und keine Datei unter `Program Files\Restow` angelegt. **Differenztest:** Ein kleines
  Go-Programm (nur Standardbibliothek) erzeugt im Windows-Job einige tausend veränderte
  Signaturen (Bitkipper, Kürzungen, `S + L`) und vergleicht das Urteil von `crypto/ed25519`
  mit dem der PowerShell-Prüfung; jede Abweichung lässt den Job scheitern.
- Der Go-Agent prüft weiterhin selbst bei jedem Update (`release.VerifiedSums`), der
  Installer ist nur der erste Schritt.

**Was die Prüfung leistet.** Schlüssel, Prüfcode und Dateien kommen von derselben Instanz
(`renderInstallScript` setzt den Schlüssel ein, `instanceUrl` leitet den Ursprung aus der
Anfrage ab). Ohne Authenticode schützt die Prüfung gegen verfälschte Downloads, nicht gegen
eine feindliche Instanz oder einen TLS-aufbrechenden Proxy, der Skript und Schlüssel
austauscht, **außer** der Fingerabdruck ist gepinnt oder wird vor der Installation gegen eine
unabhängige Quelle verglichen. Darum: Fingerabdruck in den GitHub-Release-Notizen, in
README.md und docs/AGENT.md; Ausgabe vor der Installation (14.2, Schritt 2); Pin Pflicht im
unbeaufsichtigten Aufruf. So steht es im Sicherheitsmodell von docs/AGENT.md.

### 14.4 Testschalter und Wiederholbarkeit

Wie `linux.sh`: `RESTOW_INSTALL_ROOT` (Installation unter einem Präfix ohne Dienst, für die
CI), `RESTOW_SKIP_SERVICE`, `RESTOW_ALLOW_INSECURE_HTTP`, `RESTOW_ALLOW_UNSIGNED_DEV`. Ein
zweiter Lauf repariert oder aktualisiert, installiert nichts doppelt.

## 15. Ohne Authenticode: SmartScreen, Defender, Smart App Control, ASR

Weder `restow-agent.exe` noch `restic.exe` (restic signiert seine Windows-Binaries nicht)
noch `windows.ps1` tragen eine Authenticode-Signatur. `windows.ps1` kann auch später keine
tragen: Der Server schreibt es je Anfrage um (`renderInstallScript`), und `iex (irm …)` prüft
Skriptsignaturen ohnehin nicht. Folgen:

| Mechanismus | Folge | Gegenmaßnahme |
| --- | --- | --- |
| SmartScreen (App-Reputation) | Prüft Dateien mit Mark of the Web beim Start aus dem Explorer. `Invoke-RestMethod`/`Invoke-WebRequest` setzen kein Mark of the Web, der Dienst startet nicht über den Explorer: **kein SmartScreen-Dialog** beim Skriptweg. Lädt ein Admin die `.exe` per Browser und startet sie per Doppelklick, kommt "Der Computer wurde durch Windows geschützt". | Doku: nur den Skriptweg nutzen. |
| AMSI, ASR, EDR gegen `iex (irm …)` | Das Muster "Download und direkt ausführen" wird von vielen Regeln gemeldet oder blockiert. | Doku nennt den Weg "Datei laden, Hash vergleichen, mit `-File` starten" gleichwertig (14.1). |
| Microsoft Defender Antivirus | Unsignierte, neue Go-Binaries werden gelegentlich heuristisch als Schadsoftware erkannt (Fehlalarm), auch nach Updates (neuer Hash). | Einreichung über das Microsoft-Portal "Submit a file for malware analysis" als Softwareentwickler, **schon für den Prerelease-Build**: Der Build ist reproduzierbar (`SOURCE_DATE_EPOCH`, `release.yml:256`), die Hashes stehen nach dem Job `agent` fest, und das Urteil dauert Tage. Die Zeile "Defender-Einreichung geprüft" steht in der Aufforderung zum Signieren (3.6) und in der Checkliste von agent/README.md ("Release signing"). Keine pauschale Ausnahme für den Ordner empfehlen. |
| Smart App Control (Windows 11, nur bei Neuinstallation aktiv) | Blockiert unsignierte Programme ohne Reputation unabhängig vom Mark of the Web. Der Dienst startet dann nicht. | Kein Ausweg ohne Signatur; der Installer erkennt den Zustand (`HKLM\SYSTEM\CurrentControlSet\Control\CI\Policy`, Wert `VerifiedAndReputablePolicyState` = 1) und bricht mit Erklärung ab **[Maschine]**. Betrifft vor allem Privatgeräte; auf verwalteten Geräten ist SAC meist aus. |
| ASR-Regel "Ausführbare Dateien nur bei Verbreitung, Alter oder vertrauenswürdiger Liste" | Blockiert neue, seltene Binaries. Auf MSP-Flotten mit Defender for Endpoint häufig aktiv. | Doku: Ausnahme je Pfad `C:\Program Files\Restow\bin\` für diese ASR-Regel oder Datei-Indikator "Zulassen" nach SHA-256 (je Release neu). |
| WDAC / AppLocker | Publisher-Regeln greifen nicht; Hash-Regeln brechen bei jedem Update. | Pfadregel für `C:\Program Files\Restow\bin\` (nur Administratoren dürfen dort schreiben, Abschnitt 6). |
| Controlled Folder Access | Ein unbekanntes Programm darf nicht in geschützte Ordner (Dokumente, Bilder) schreiben. Betrifft Restores dorthin. | Standard-Restore-Ziel liegt außerhalb (Abschnitt 18.2). Doku nennt die App-Freigabe. |

Bewusst vermiedene Muster, die Heuristiken auslösen: angehaltener Prozessstart mit
`ResumeThread` (12.3), Selbstlöschung über `cmd /c ping … & rd` (9.4), `Add-Type` im
Installer (14.3). Ein späterer Weg zu Authenticode ist Offene Entscheidung 4.

## 16. Sicherung auf Windows

### 16.1 Standardordner, gemischte Jobs, Datenordner

`packages/core/src/endpoints/config.ts:125-128` bleibt: Server `C:\Users`,
`C:\ProgramData`; Client `C:\Users`. Weitere Laufwerke (`D:\Daten`) fügt der Job hinzu.
UNC-Pfade und verbundene Laufwerke (unter SYSTEM nicht vorhanden) lehnt der Server für
Windows-Rechner ab (Abschnitt 19.2), mit Verweis auf docs/FILESHARES.md.

**Gemischte Jobs.** Ein Job mit Linux- und Windows-Mitgliedern trägt legitim `/etc`, `/home`
und `C:\Users` zugleich (Abschnitt 1.1). Darum:

- Pfade **am Job** sind gültig, wenn sie zu mindestens einem Betriebssystem der Mitglieder
  passen; passt ein Pfad zu keinem, ist das ein Fehler, passt er nicht zu allen, eine
  Warnung im Editor. Streng je Betriebssystem geprüft werden nur Pfade **am Rechner** und
  Überschreibungen je Mitglied.
- Der Agent übernimmt nur Quellen in der Form seines Systems (Windows: `X:\…`; Unix: `/…`)
  und protokolliert die übrigen einmal je Lauf als "gilt für andere Betriebssysteme". Ein
  Job, in dem für einen Rechner keine Quelle übrig bleibt, endet mit `invalid_task`.
- Ausschlüsse eines Jobs ersetzen die des Rechners (`endpoint-config.ts:121`). Die
  Ausschlüsse, ohne die eine Windows-Sicherung mit Schattenkopie mehrere GB Unsinn je Lauf
  liest, setzt deshalb der Agent selbst (16.2).

**Datenordner (#59).** docs/AGENT.md (`:186-190`) und `data-folders.ts` lassen Windows bei
`dataFolders` bewusst aus; die Warnung "Ordner fehlt im Job" gibt es für Windows damit nicht,
und ein Serverjob mit den Standardordnern übergeht `D:\` still. Neu: Der Windows-Agent meldet
als Datenordner jedes feste Laufwerk außer dem Systemlaufwerk (`GetDriveTypeW` =
`DRIVE_FIXED`, NTFS oder ReFS, mindestens ein Eintrag im Stamm außer
`System Volume Information` und `$Recycle.Bin`) sowie `C:\inetpub`, falls vorhanden. Nur
Namen, wie heute. `DATA_FOLDER_CANDIDATES.windows` bekommt `C:\inetpub`; Laufwerke kommen
als Muster `X:\`. docs/AGENT.md `:189` wird angepasst. Gehört zu Meilenstein M3 und darf auf
0.5.x rutschen; dann steht der Satz "weitere Laufwerke werden nicht gemeldet" unter "Known
limits".

### 16.2 Ausschlüsse

`DEFAULT_EXCLUDES.windows` (`config.ts:158-166`) wird:

```ts
windows: [
  ...COMMON_EXCLUDES,
  "**\\AppData\\Local\\Temp",
  "**\\AppData\\Local\\Microsoft\\Windows\\INetCache",
  "**\\AppData\\Local\\Microsoft\\Windows\\Explorer",      // thumbcache_*.db
  "**\\AppData\\Local\\Microsoft\\Windows\\WebCache",
  "**\\AppData\\Local\\CrashDumps",
  "**\\AppData\\Local\\restic",
  "**\\AppData\\Local\\Google\\Chrome\\User Data\\*\\Cache",
  "**\\AppData\\Local\\Microsoft\\Edge\\User Data\\*\\Cache",
  "**\\AppData\\Local\\Mozilla\\Firefox\\Profiles\\*\\cache2",
  "**\\Thumbs.db",
  "C:\\Windows\\Temp",
  "C:\\ProgramData\\Microsoft\\Windows Defender",
  "C:\\ProgramData\\Microsoft\\Search\\Data",
  "C:\\ProgramData\\Microsoft\\Windows\\WER",
  "C:\\ProgramData\\Microsoft\\Network\\Downloader",
  "C:\\ProgramData\\Package Cache",
],
```

Dazu im Agenten, unabhängig vom Server und von Job-Ausschlüssen:

- Die eigenen Ordner: heute `CacheDir`, `TmpDir` und `Restow-Restore-*`
  (`agent/internal/core/backup.go:235-237`); unter Windows zusätzlich `StateDir` und
  `LogDir`, also `C:\ProgramData\Restow` ganz.
- Unter Windows immer: `**\pagefile.sys`, `**\hiberfil.sys`, `**\swapfile.sys`,
  `**\System Volume Information`, `**\$Recycle.Bin`. Diese stehen darum nicht mehr in
  `DEFAULT_EXCLUDES.windows`.
- `--iexclude-file` statt `--exclude-file` (`agent/internal/restic/backup.go:76-78`):
  Windows-Pfade sind ohne Groß-/Kleinschreibung; `C:\Windows\Temp` soll auch `c:\windows\temp`
  treffen.
- `--exclude-cloud-files`: Nur-Online-Dateien von OneDrive & Co. werden nicht gelesen. Das
  verhindert, dass der Dienst den ganzen OneDrive-Inhalt herunterlädt (oder an fehlender
  Anmeldung scheitert). Lokal vorhandene Dateien werden gesichert. Im Lauf-Log steht, dass die
  Option aktiv ist.
- `$` in Mustern verdoppelt `excludeFileLine` schon (`agent/internal/restic/pattern.go:28-34`),
  `**\$Recycle.Bin` funktioniert also.
- VSS ignoriert die in `HKLM\SYSTEM\CurrentControlSet\Control\BackupRestore\FilesNotToSnapshot`
  eingetragenen Dateien (Standard: Outlook-OST, `doc/040_backup.rst:108-113`); sie fehlen
  dann im Snapshot. docs/AGENT.md nennt das.

### 16.3 Lange Pfade und Unicode

- Go versieht absolute Pfade über 248 Zeichen intern mit `\\?\`; restic tut es ebenso
  (`fixpath`, `fs_local_vss.go:158`). Pfade bis 32.767 Zeichen gehen damit ohne
  `LongPathsEnabled` **[Maschine]**. Der Explorer zeigt wiederhergestellte lange Pfade erst
  mit `LongPathsEnabled = 1`; die Doku sagt das.
- Pfade sind im Agenten UTF-8 (Go-Strings), an der API UTF-16 (`syscall.UTF16PtrFromString`).
  Windows erlaubt Dateinamen mit ungepaarten Surrogaten (ungültiges UTF-16). Go wandelt sie
  verlustbehaftet um; solche Dateien kann restic nicht öffnen und meldet einen Lesefehler
  (Lauf `partial`) **[Maschine]**. Bekannte Grenze, dokumentiert.
- `--files-from-raw` mit UTF-8 ist unter Windows gefordert (Abschnitt 1.2) und erfüllt.
- Pfadvergleiche im Agenten unter Windows ohne Groß-/Kleinschreibung: `splitSources`
  (`core/util.go:68-110`), `underSources` (`core/activity.go:29-43`), eigene Ausschlüsse.

### 16.4 Snapshot-Pfade

restic legt `C:\Users\anna\a.txt` im Snapshot als `/C/Users/anna/a.txt` ab und übernimmt den
Laufwerksbuchstaben wörtlich (`archiver/tree.go:35-65`): `c:\Users` würde `/c/Users`, und
zwei Schreibweisen ergäben zwei Bäume im Snapshot. Restore legt unter `<ziel>\C\Users\anna\a.txt`
ab. Folgen im Agenten:

- Der Agent schreibt jeden Laufwerksbuchstaben einer Quelle groß, bevor er sie an restic gibt
  (ebenso das Volume in `vss.exclude-volumes`). `snapshotPathOf` und alle Vergleiche mit
  Snapshot-Pfaden behandeln den Laufwerksbuchstaben ohne Groß-/Kleinschreibung.
- `core/verify.go:60` prüft `filepath.Clean(f.Path) != f.Path`. Unter Windows macht
  `filepath.Clean("/C/Users/x")` daraus `\C\Users\x`: **jede Stichprobe würde abgelehnt.**
  Wird `path.Clean` (Schrägstriche). `verify.go:208` (`filepath.FromSlash`) ist richtig.
- `core/activity.go:32` vergleicht `filepath.ToSlash("C:\Users")` = `C:/Users` mit
  Snapshot-Pfaden `/C/Users/…`: **kein Treffer**, die Ransomware-Auswertung hielte jede Datei
  für "außerhalb der Quellen". Neue Funktion `snapshotPathOf(osPath)` (`C:\Users` →
  `/C/Users`), getestet.
- `restic/pattern.go:7-21` (`EscapeIncludePath`) escapt mit `\`; unter Windows wirkungslos
  (Abschnitt 1.2). Windows-Fassung: `[` wird `[[]`, `]` bleibt; `*` und `?` kommen in
  Windows-Dateinamen nicht vor. Restic-Muster unter Windows sind außerdem
  groß-/kleinschreibungsabhängig: Restore nimmt `--iinclude` statt `--include`
  (`restic/restore.go:37-46`).
- Die Weboberfläche zeigt Snapshot-Pfade eines Windows-Rechners als `C:\Users\anna`
  (Abschnitt 19.3); an API und Agent bleiben es `/C/…`-Pfade
  (`schemas.ts:390-396`, `core/restore.go:52-58` passen schon).

## 17. Schattenkopie (VSS)

Die Begriffe an API, Richtlinie und Fehlercodes sind betriebssystemneutral, weil im selben
Release APFS-Snapshots (macOS) und LVM/btrfs-Snapshots (Linux) dieselbe Semantik brauchen:
`snapshotOnFailure`, `stats.snapshot`, `snapshot_failed`, `snapshot_unavailable`,
`snapshot_cleanup_failed`. Windows-Besonderheiten (`vssadmin`, Ereignisquelle VSS) stehen im
Meldungstext und in den Erklärungsschritten. Das Feld `useVss` am Rechner bleibt, wie es ist.

### 17.1 Wann

- Nur unter Windows und nur, wenn `config.useVss` wahr ist. Standard für Windows-Rechner
  `true` (`config.ts:213`), je Rechner abschaltbar (Abschnitt 19.3). Der Job entscheidet es
  nicht (`docs/AGENT.md:243-245` bleibt so).
- Nur mit Rechten (Dienst als SYSTEM oder erhöhte Konsole, Abschnitt 8). Ohne Rechte:
  wie `snapshot_unavailable` (17.4).
- Volumes, die VSS sicher nicht kann: Vor dem Start ermittelt der Agent je Quelle das
  Volume (`GetVolumePathNameW`), den Typ (`GetDriveTypeW`) und das Dateisystem
  (`GetVolumeInformationW`). Wechseldatenträger, FAT32 und exFAT gehen als
  `-o vss.exclude-volumes=<liste>` an restic und stehen im Lauf-Log ("E:\ ohne
  Schattenkopie: Dateisystem exFAT"). Das ist nur eine Abkürzung, keine Vorhersage: Ob der
  Anbieter ein Volume kann, hängt auch an ReFS-Version, VHD oder BitLocker-Zustand; was die
  Vorprüfung durchlässt, entscheidet restic (17.3, `snapshot_skipped`).

### 17.2 Aufruf

`restic.BackupOptions` (`agent/internal/restic/backup.go:33-47`) bekommt:

```go
// UseFSSnapshot: --use-fs-snapshot (Windows VSS). Nur unter Windows gesetzt.
UseFSSnapshot bool
// VSSTimeout: -o vss.timeout=<d>; 0 = restics Standard.
VSSTimeout time.Duration
// VSSExcludeVolumes: -o vss.exclude-volumes=<a;b>.
VSSExcludeVolumes []string
// ExcludeCloudFiles: --exclude-cloud-files.
ExcludeCloudFiles bool
// CaseInsensitive: --iexclude-file statt --exclude-file.
CaseInsensitive bool
```

`backupArgs` (`backup.go:68-86`) ergänzt dann
`--use-fs-snapshot -o vss.timeout=5m [-o vss.exclude-volumes=E:\;F:\] --exclude-cloud-files`.
`vss.timeout` 5 Minuten statt 120 s, weil Server mit vielen Writern (SQL Server, Hyper-V,
Exchange) für das Sammeln der Writer-Metadaten länger brauchen können. `vss.provider` bleibt
leer (Windows wählt den Standardanbieter), `vss.exclude-all-mount-points` bleibt `false`
(eingehängte Ordner bekommen eigene Schattenkopien). Die Optionen sind keine Geheimnisse und
dürfen auf der Kommandozeile stehen (`backup.go:64-67`).

### 17.3 Erkennen, ob die Schattenkopie gegriffen hat

restic sagt im JSON-Modus nichts über Erfolg und endet bei einem VSS-Fehler mit Exit 0
(Abschnitt 1.2). Darum wertet der Agent die Fehlereinträge aus. `itemErrors.add`
(`agent/internal/restic/errors.go:24-34`) bekommt eine Klassifizierung (`restic/snapshot.go`,
ohne Build-Tag):

| restic-Eintrag | Bedeutung | Agent |
| --- | --- | --- |
| `during: "archival"`, `item` ist ein Volume (`x:\` oder `\\?\Volume{…}\`), Text beginnt mit `failed to create snapshot for [` und enthält `Snapshots are not supported for volume` | Anbieter kann das Volume nicht | `SkippedVolumes`, nur Lauf-Log ("ohne Schattenkopie: vom Anbieter nicht unterstützt"), **kein** Fehler, keine Abwertung, auch nicht bei `fail` |
| sonst Text beginnt mit `failed to create snapshot for [` | Schattenkopie eines Volumes fehlgeschlagen, restic liest live | `FailedVolumes = append(…, {Volume, Message})`, **nicht** als Dateifehler gezählt |
| Text beginnt mit `failed to delete VSS snapshot` | Schattenkopie blieb nach dem Lauf liegen | `CleanupFailed` |
| `failed to get volume from mount point` / `failed to parse vss.exclude-volumes` | Konfigurationsproblem einzelner Einhängepunkte | Warnung im Log |
| Exit 1 vor der ersten `status`-Zeile, `--use-fs-snapshot` war gesetzt, `Fatal`/`Stderr` enthält `VSS error`, einen `VSS_E_`-Code, `VssApi.dll`, `CoInitializeEx` oder `CoInitializeSecurity` | VSS gar nicht nutzbar (DLL, COM, Rechte, Dienst deaktiviert, Architektur) | `restic.Error` mit `SnapshotUnavailable() == true` |
| Exit 1 vor der ersten `status`-Zeile, `--use-fs-snapshot` war gesetzt, Exit nicht 10, 11 oder 12, Text passt auf nichts davon | vielleicht VSS, vielleicht nicht | Rückfall wie bei "nicht nutzbar" (17.4); `snapshot_unavailable` nur, wenn der zweite Lauf ohne VSS nicht mit derselben `Fatal`-Meldung scheitert, sonst normaler `restic_error` |

Die Texte sind restics eigene Formate (`fs_local_vss.go:199-204`, `:119`,
`vss_windows.go:199, 219, 966-972, 797-861`) und werden mit Testdaten aus genau diesen
Formaten getestet. Ändert ein späteres restic die Texte, fällt das schon im Ubuntu-Job auf
(Byte-Wächter auf `restic.exe`, Abschnitt 3.5) und zusätzlich im Windows-Job (Test mit
unbekanntem Anbieter, Abschnitt 22.1).

`BackupResult` bekommt `Snapshot SnapshotOutcome` mit `Requested bool`,
`FailedVolumes []VolumeFailure`, `SkippedVolumes []string`, `CleanupFailed []string`.

### 17.4 Fehlerpolitik

Neu als Richtlinie `snapshotOnFailure` mit den Werten `continue` (Standard) und `fail`, auf
den Ebenen Installation, Mandant und Job, wie die anderen Richtlinien
(`packages/core/src/endpoints/agent-policy.ts:26-44`). Die Wahl gehört in die Richtlinie und
nicht an den Rechner, weil sie eine Frage der Betriebsvorgabe ist ("lieber eine inkonsistente
Sicherung als keine?"), die ein Dienstleister zentral und ggf. gesperrt festlegt. Dieselbe
Richtlinie gilt für APFS und LVM/btrfs.

| Fall | `continue` | `fail` |
| --- | --- | --- |
| Ein Volume ohne Schattenkopie (`FailedVolumes`, restic Exit 0 oder 3) | Snapshot bleibt. Status `partial`, Fehler `snapshot_failed` je Volume. | Der Agent bricht restic ab, sobald der erste solche Eintrag kommt (CTRL_BREAK, 12.1; restic legt bei Abbruch keinen Snapshot an, `cmd_backup.go:697-701`). Status `failed`, Fehler `snapshot_failed`. Schon hochgeladene Daten ohne Snapshot räumt das nächste `prune` des Servers weg. |
| Volume vom Anbieter nicht unterstützt (`SkippedVolumes`) | nur Lauf-Log | nur Lauf-Log |
| VSS gar nicht nutzbar (17.3, oder Agent ohne Rechte) | Der Agent startet restic sofort ein zweites Mal ohne `--use-fs-snapshot`. Status höchstens `partial`, Fehler `snapshot_unavailable`. | Status `failed`, Fehler `snapshot_unavailable`. |
| Schattenkopie nicht gelöscht | Status bleibt, Fehler `snapshot_cleanup_failed` (Hinweis, keine Abwertung). | ebenso |

Der eigene Abbruch bei `fail` läuft über `context.WithCancelCause` mit einer eigenen Ursache
`errSnapshotFailed`; sonst landete er in `backup.go:255-275` als "interrupted" oder
`restic_error`. Beim Rückfall zählt die Laufzeit beider restic-Aufrufe gegen die 72 Stunden
(`maxRunTime`). `snapshot_failed` gilt als vorübergehend (häufige Ursachen: Writer in falschem
Zustand, ein anderes Backup erstellt gerade eine Schattenkopie,
`VSS_E_SNAPSHOT_SET_IN_PROGRESS`); die automatischen Wiederholungen der Richtlinie greifen.
`snapshot_unavailable` gilt als dauerhaft.

Der Server übermittelt die Richtlinie in `policy` von `GET /config`:
`policy: { …, snapshotOnFailure?: "fail" }` (fehlt = `continue`; ein älterer Agent kennt das
Feld nicht und läuft auf Linux/macOS ohnehin ohne Snapshot).

### 17.5 Wie ein Snapshot-Fehler gemeldet wird

- **Lauf-Fehler** (`errors[]` in `POST /runs/:id/finish`):
  - `{ code: "snapshot_failed", path: "C:\\", message: "<restics Text, geschwärzt>" }` je Volume.
  - `{ code: "snapshot_unavailable", message: "…" }` einmal.
  - `{ code: "snapshot_cleanup_failed", path: "C:\\", message: "…" }`.
- **Statistik:** `stats.snapshot = { method: "vss" | "apfs" | "lvm" | "btrfs", state:
  "used" | "partial" | "unavailable" | "off" }`. `used`: angefordert, kein Fehler
  (übersprungene Volumes zählen nicht); `partial`: mindestens ein Volume ohne; `unavailable`:
  ganz ohne; `off`: nicht angefordert.
- **Oberfläche:** "Schattenkopie (dateikonsistent)" bzw. "Ohne Schattenkopie". Nicht
  "konsistent": restic fordert eine Kopie-Sicherung ohne Writer-Komponenten an
  (`VSS_BT_COPY`, Abschnitt 1.2). Dateien offener Datenbanken (SQL Server, Exchange) sind
  absturzkonsistent, ein Administrator muss sie nach dem Restore anhängen bzw. wiederherstellen
  lassen, und Transaktionsprotokolle werden nicht gekürzt. Anwendungskonsistenz geht über
  Hooks (`sqlcmd -Q "BACKUP DATABASE … TO DISK=…"` als Pre-Hook). Das steht in docs/AGENT.md
  und agent/README.md unter den bekannten Grenzen.
- **Lauf-Log:** eine Zeile je Volume mit dem Grund und dem Hinweis "Ereignisanzeige >
  Windows-Protokolle > Anwendung, Quelle VSS; `vssadmin list writers` als Administrator".
- **Erklärung** (`endpoint_runs.failure`): neue Codes `endpoint.snapshot_failed` und
  `endpoint.snapshot_unavailable` im Katalog (Abschnitt 19.1) mit Schritten; der Schritttext
  nennt je Betriebssystem das passende Werkzeug.
- **Benachrichtigung:** wie bei jedem `partial`/`failed` (keine neue Ereignisart).

`agent/internal/core/backup.go:231-233` (das "has no effect"-Log) wird unter Linux/macOS
beibehalten (bis APFS/LVM es ersetzen) und unter Windows durch das obige Verhalten ersetzt.

## 18. Wiederherstellung auf Windows

### 18.1 Regeln für das Ziel

Unix (`agent/internal/core/util.go:223-271`): absolut, kanonisch, nicht `/`, Elternordner
existiert und ist nur für root änderbar (Sticky erlaubt), Ziel neu oder leer und root-eigen,
restic mit `--overwrite never`. Windows, gleiche Funktion `prepareRestoreTarget` in
`util_windows.go`:

1. Form: Laufwerkspfad `X:\…` (`filepath.VolumeName` ist `X:`). Abgelehnt: UNC, `\\?\`,
   `\\.\`, relative Laufwerkspfade, Laufwerkswurzel (`C:\`), `filepath.Clean(t) != t`
   (also kein `..`, kein `.`, kein doppelter oder abschließender `\`), `/` im Pfad, `:`
   außerhalb des Laufwerks (Alternate Data Streams), Zeichen `<>"|?*` und Steuerzeichen,
   Bestandteile, die auf Punkt oder Leerzeichen enden (Windows schneidet sie ab und macht
   daraus einen anderen Pfad), reservierte Gerätenamen (`CON`, `PRN`, `AUX`, `NUL`,
   `COM1`–`COM9`, `LPT1`–`LPT9`, auch mit Endung). Code `invalid_task`.
2. Volume des Ziels: `GetDriveTypeW` muss `DRIVE_FIXED` sein, `GetVolumeInformationW` muss
   `FILE_PERSISTENT_ACLS` melden. Sonst (Netzlaufwerk, Wechseldatenträger, FAT, exFAT, wo
   wiederhergestellte Dateien ihre Berechtigungen verlören) `target_unusable`.
3. Elternordner existiert und ist vertraut nach der Regel für Restore-Ziele (Abschnitt 6:
   strenger Satz, aber `AD`/`WD` erlaubt; `C:\` ist damit zulässig), ohne Reparse-Point im
   Pfad. Code `target_unusable`.
4. Sperrliste, nach Auflösung über `GetFinalPathNameByHandleW` und ohne
   Groß-/Kleinschreibung: das Ziel darf nicht in oder unter `%SystemRoot%`,
   `C:\Program Files`, `C:\Program Files (x86)`, `C:\ProgramData\Restow` oder einem
   `System Volume Information` liegen. Gegenstück zu `protectedDirs` (9.4). Grund: SYSTEM
   stellt ursprüngliche Eigentümer und DACLs wieder her (18.3); in einem Admin-Baum entstünden
   sonst für Benutzer schreibbare Unterbäume, und ein Snapshot kann Inhalte enthalten, die ein
   Benutzer kontrolliert. Die Rolle, die das Ziel wählt, ist `tenant_restore`. Code
   `target_unusable`.
5. Ziel = aufgelöster Elternordner + Name. Existiert es nicht: `CreateDirectoryW` mit der
   geschützten DACL `D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)`, atomar (scheitert bei
   `ERROR_ALREADY_EXISTS`, dann `target_not_empty`, wie `util.go:254-258`).
6. Existiert es: muss ein leerer Ordner sein, kein Reparse-Point, vertraut nach dem strengen
   Satz. Sonst `target_not_empty` bzw. `target_unusable`.
7. restic mit `--overwrite never --verify` wie heute (`restic/restore.go:37`). Ereignis
   "Wiederherstellung nach <ziel>" (9.5).

### 18.2 Standardziel

Unix legt `Restow-Restore-<zeit>` in den ersten vertrauten gesicherten Ordner
(`util.go:189-211`). Unter Windows wäre das meist `C:\Users\Restow-Restore-…`, das wie ein
Benutzerprofil aussieht. Entwurf: `%SystemDrive%\Restow-Restore-<yyyyMMdd-HHmmss>`
(Offene Entscheidung 5). Der Ausschluss `Restow-Restore-*` (`core/backup.go:237`) gilt
unverändert.

### 18.3 Was restic auf Windows wiederherstellt

- Inhalte, Zeitstempel, Datei-Attribute (versteckt, System, schreibgeschützt), Erstellzeit.
- Security Descriptors: Owner, DACL und SACL, weil der Dienst als SYSTEM die nötigen Rechte
  hat (`doc/050_restore.rst:86-89`, Privilegien `SeRestorePrivilege` und
  `SeSecurityPrivilege` stehen in der Liste aus 9.1). Vererbungs-Flags seit restic 0.19.0
  korrekt (#5427). Folge: Wiederhergestellte Dateien tragen ihre ursprünglichen
  Berechtigungen. Der Zielordner selbst lässt nur SYSTEM und Administratoren hinein; Windows
  gewährt aber jedem Benutzer "Bypass Traverse Checking", ein Benutzer mit ursprünglichem
  Recht auf eine Datei kann sie über den vollen Pfad öffnen. Das entspricht Unix, wo restic
  ebenfalls die ursprünglichen Modi setzt (`util.go:251`), dort aber der `0700`-Ordner den Weg
  versperrt. Wie die vererbten ACEs unter dem geschützten Zielordner tatsächlich aussehen,
  ist **[Maschine]** (Vergleich mit `icacls /save` vor und nach).
- NTFS Extended Attributes (#4807), wiederherstellbar; `--exclude-xattr` wird nicht genutzt.
- **Nicht:** Alternate Data Streams (nicht gesichert, Abschnitt 1.2), damit auch kein Mark of
  the Web an wiederhergestellten Downloads; EFS-Verschlüsselung (der Dienst kann
  EFS-verschlüsselte Dateien anderer Benutzer gar nicht lesen, sie erscheinen als Lesefehler
  beim Backup, Hinweistext wie `core/backup.go:292-299` für macOS); Hardlinks als
  Hardlinks **[Maschine]**.
- Symbolische Links: als Links (SYSTEM hat `SeCreateSymbolicLinkPrivilege`). Junctions
  werden wegen `winsymlink=0` vermutlich als symbolische Links gesichert und wiederhergestellt
  **[Maschine]**.
- Platzhalter von OneDrive: Nur-Online-Dateien fehlen im Snapshot (`--exclude-cloud-files`).

### 18.4 Server und Oberfläche

- `restoreTargetSchema` (`apps/api/src/features/endpoints/schemas.ts:427-441`) wird
  `restoreTargetSchemaFor(os)`; `createTaskSchema` (`:443-451`) prüft das Ziel nur auf
  Länge und Steuerzeichen, die Service-Schicht prüft je Betriebssystem des Rechners mit
  denselben Regeln wie 18.1, Schritte 1 und 4 (gemeinsame Funktion in `packages/core`,
  ohne Auflösung, die nur der Agent kann).
- `checkTargetDir` (`apps/web/src/features/endpoints/components/restore-dialog.tsx:39-63`)
  bekommt `os` und dieselben Regeln; Platzhalter im Feld `D:\Wiederherstellung`. Hinweistext
  unter dem Feld erklärt Standardziel, "nie überschreiben" und die gesperrten Orte.

## 19. Server-Änderungen

### 19.1 `packages/core`

- `endpoints/config.ts`: `SUPPORTED_ENDPOINT_OS` (`:35`) wird `["linux", "darwin", "windows"]`;
  neu `isSupportedEndpointTarget(os, arch)` (Windows nur `amd64`). Kopfkommentar (`:1-19`)
  und `DEFAULT_EXCLUDES.windows` (Abschnitt 16.2) anpassen. `useVss: os === "windows"`
  (`:213`) bleibt.
- `endpoints/agent-policy.ts`: Schlüssel `snapshotOnFailure` in `AGENT_POLICY_KEYS`
  (`:26-32`), `JOB_POLICY_KEYS` (`:38-43`), `AgentPolicyValues` (`:67-73`, Standard
  `"continue"`), Validierung, `AgentPolicyWire` (`:221-225`) und `agentPolicyWire`
  (`:227-237`): Feld nur bei `"fail"`.
- `endpoints/run-errors.ts`: `snapshot_failed`, `snapshot_unavailable`,
  `snapshot_cleanup_failed` in `ENDPOINT_RUN_ERROR_CODES` (`:12-26`).
- `endpoints/run-failures.ts`: `BY_CODE` (`:23-37`) `snapshot_failed →
  endpoint.snapshot_failed` (transient), `snapshot_unavailable →
  endpoint.snapshot_unavailable`; `NEEDS_FIRST` (`:44-52`): `snapshot_unavailable` nach
  `hooks_not_allowed`. `snapshot_cleanup_failed` bekommt keine eigene Erklärung (Hinweis,
  kein Grund für `partial`).
- `failures/types.ts`: Codes `endpoint.snapshot_failed`, `endpoint.snapshot_unavailable`
  (`:124-145`), Schritte `check_endpoint_snapshot` und `check_endpoint_snapshot_service` in
  `FAILURE_STEP_IDS` (`:263-343`).
- `failures/catalog.ts` (bei `:623-640`): beide Einträge, Kategorie `endpoint`;
  `snapshot_failed`: `transient: true`, Schritte `check_endpoint_snapshot`,
  `wait_endpoint_retry`; `snapshot_unavailable`: `transient: false`, Schritte
  `check_endpoint_snapshot_service`, `READ_DETAILS`.
- Prüfung von Sicherungsordnern je OS (neu `endpoint-paths.ts` neben `data-folders.ts`): für
  Windows nur `X:\…`, kein UNC; für Unix weiter `/…`; für Jobs die Regel "passt zu mindestens
  einem Mitglied" (16.1).
- `endpoints/data-folders.ts`: `DATA_FOLDER_CANDIDATES.windows`, Laufwerke als Muster (16.1).
- `endpoints/restore-target.ts` (neu): gemeinsame Zielregeln (18.4).

### 19.2 `apps/api`

- `features/endpoints/agent-service.ts:237-246` und `service.ts:545-556`: Windows annehmen,
  `windows` mit `arm64` mit eigenem Problemtext ablehnen ("Windows on ARM wird in dieser
  Version nicht unterstützt"); `extensions.supported` aus der Liste ableiten.
- `service.ts:321` (`commandsFor`): Windows-Befehle.
- `commands.ts`: `installCommands` für Windows (Abschnitt 14.1) mit `psQuote` (einfache
  Anführungszeichen, `'` → `''`) und vorbelegtem Fingerabdruck im unbeaufsichtigten Befehl;
  `INSTALLED_AGENT.windows = 'C:\Program Files\Restow\bin\restow-agent.exe'`,
  `TOKEN_FILE.windows` (Abschnitt 14.1). Typen `Record<"linux" | "darwin", …>` (`:33-48`)
  werden `Record<EndpointOsName, …>`.
- `schemas.ts`: `finishRunSchema.stats` (`:185-194`) um `snapshot` (Objekt mit zwei Enums)
  erweitern; `restoreTargetSchema` (Abschnitt 18.4); Einstellungs-Schema (`:313-320`) um
  `useVss`; `agentPolicyLevelSchema` (`:462…`) um `snapshotOnFailure`; Prüfung der
  Sicherungsordner je OS bei Rechner und Mitglied, "mindestens ein Mitglied" beim Job
  (`absolutePath`, `:267-273`, nimmt `C:\` schon an).
- `service.ts:787-789`: `useVss` wie `onlyOnAcPower` übernehmen, nur bei Windows-Rechnern
  (sonst 422).
- `distribution.ts`, `install-routes.ts`, `lib/provider-access.ts`: Abschnitt 3.7.
- `agent-service.ts` (Antwort `GET /config`): `policy.snapshotOnFailure`.
- Tests: `endpoints.test.ts`, `agent-config.pg.test.ts`, `agent-policy.pg.test.ts`,
  `agent-updates.pg.test.ts` (Windows-Ziel, `.exe`), `downloads.routes.test.ts`, ein Job mit
  Linux- und Windows-Mitglied (Pfade, Ausschlüsse, Hooks), ein Test, der `failures.json` für
  die neuen Codes verlangt (besteht schon allgemein).

### 19.3 `apps/web`

- `features/endpoints/components/enroll-dialog.tsx`: `isSelectableOs` (`:63`) nimmt Windows
  an, Hinweis `enroll.os.windowsNote` (`:178`) wird zum Vorschau-Hinweis (Offene
  Entscheidung 6); Befehlsblock zeigt PowerShell mit dem Hinweis "PowerShell als
  Administrator öffnen", den Fingerabdruck des Release-Schlüssels und den Hash von
  `windows.ps1` für den Datei-Weg; Profilvorschlag wie heute.
- `restore-dialog.tsx`: Abschnitt 18.4; Pfade aus dem Snapshot (`/C/…`) als `C:\…` anzeigen.
- `settings-tab.tsx` (neben dem Netzteil-Schalter, `:745-762`): Schalter "Schattenkopie (VSS)"
  nur für Windows-Rechner, mit Hinweis auf die Richtlinie `snapshotOnFailure`;
  `settings-form.ts` um `useVss`. `settings-tab.tsx:448` gibt heute fest
  `sudo restow-agent hooks …` aus und bekommt eine Windows-Fassung.
- Richtlinien-Editoren (Installation, Mandant, Job): Auswahl "Wenn der Dateisystem-Snapshot
  scheitert: ohne Snapshot weiter sichern (Teilerfolg) / Sicherung abbrechen", sperrbar wie
  die anderen Schlüssel.
- Job-Editor: Hinweis bei gesetzten Hooks und gemischten Betriebssystemen (12.2); Warnung bei
  Pfaden, die nicht zu allen Mitgliedern passen (16.1).
- Lauf-Details: Kennzeichen aus `stats.snapshot`.
- Rechnerseite: für Windows-Rechner der Satz zur Wiederherstellung (2.2), für
  Domänencontroller der feste Hinweis.
- `presenters.ts` (`:425-445`): neue Fehlercodes.
- Hook-Hilfetexte je OS: PowerShell statt `/bin/sh`, Ordner `C:\ProgramData\Restow\state\hooks.d`,
  erlaubte Endungen `.ps1` und `.exe`.
- Snapshot-Browser und ZIP-Download: Anzeige `C:\…`, Pfade an die API weiter `/C/…`.
- `features/endpoints/api.ts:239`: Typen (`useVss` gibt es schon).

### 19.4 Datenbank

Keine Migration. `endpoint_os` enthält `windows` seit `packages/db/drizzle/0012_loose_gertrude_yorkes.sql:5`.
`useVss` steht in `endpoints.config` (JSONB, `packages/db/src/schema/endpoints.ts:309`),
`snapshotOnFailure` in den JSONB-Spalten `agent_policy` (`schema/system.ts:325`,
`schema/tenants.ts:114`) bzw. in den Job-Einstellungen, `stats.snapshot` in
`endpoint_runs.stats` (JSONB, `endpoints.ts:444`; nur der Typ `EndpointRunStats`, `:405-416`,
wird erweitert). Die Nummer 0073 bleibt frei.

### 19.5 i18n und Demo

- `packages/i18n/resources/{de,en}/endpoints.json`: `runErrors.snapshot_failed`,
  `…snapshot_unavailable`, `…snapshot_cleanup_failed`, Enroll-Texte für Windows,
  Einstellungstexte, Restore-Ziel-Regeln, Vorschau-Hinweis. Die heute betriebssystemlosen
  Hook-Texte mit `sudo` und `/etc/restow-agent/hooks.d` (`endpoints.json:297-298`, `:374`,
  `:837-846`, `:1040-1041`, Schlüssel `hooksNotAllowed`, `hookNotAScript`) bekommen das
  Betriebssystem als ICU-`select` (`{os, select, windows {…} other {…}}`).
- `…/failures.json`: `cause.endpoint.snapshot_failed`, `cause.endpoint.snapshot_unavailable`,
  die zwei neuen Schritte. Der Schritt `allow_endpoint_hooks` (`failures.json:705`) kommt aus
  einem statischen Katalog ohne Rechnerkontext und wird neutral formuliert ("als
  Administrator auf dem Rechner: `restow-agent hooks scripts` (nur Skripte im Hook-Ordner des
  Agenten) oder `restow-agent hooks any`"), ohne `sudo` und ohne Pfad.
- Richtlinien-Texte (wo die anderen Policy-Schlüssel stehen).
- `deploy/demo/seed/src/agent-api.ts:28`: ein Windows-Demorechner (optional, aber nützlich für
  Screenshots).

## 20. Dokumentation

### 20.1 docs/AGENT.md

- Kopf (`:9-12`): "Stand 0.5.0: Linux, macOS und Windows (amd64, Vorschau)". `:16` ("keine
  Images, kein Bare-Metal-Restore") um Windows und den Linux-Bare-Metal-Stand ergänzen.
- "Grundsätze" und "Bausteine": Windows-Dienst, Installer.
- "Enrollment": PowerShell-Befehle, Token-Datei, Schlüssel-Pin, Architektur-Prüfung; Regel 6
  (`:138`, `os=windows` antwortet 422) streichen, Regel 7 (`:140`, Ablage) um Windows
  ergänzen.
- Tabelle `/agent/v1` (`:162`): `GET /config` mit `policy.snapshotOnFailure`;
  `POST /runs/:id/finish` mit `stats.snapshot`.
- Datenordner (`:186-190`, insbesondere `:189`): Windows-Regel (16.1).
- Standardordner (`:216`, "Windows später"): Windows-Werte.
- "Jobs" (`:243-245`): `useVss` bleibt am Rechner, `snapshotOnFailure` ist Richtlinie;
  gemischte Jobs (16.1).
- "Richtlinien" (ab `:367`): neuer Schlüssel.
- "Fehlercodes eines Laufs" (`:572-600`): drei neue Codes, zwei neue Erklärungen.
- "Restore" (ab `:980`): Windows-Zielregeln, Standardziel, ACL/ADS-Verhalten, Sperrliste.
- Problemtypen (`:1104`, Zeile `unsupported-os`): "Windows ist geplant" ersetzen durch
  "Windows on ARM".
- "Verteilung" (`:1134-1156`): fünf Ziele, `windows.ps1`, Satz "Es gibt kein `windows.ps1`"
  (`:1146`) streichen, Modulzahl.
- "Signierte Releases": Prüfung im PowerShell-Installer, Fingerabdruck und Pin.
- "Sicherheitsmodell" (ab `:1249`): DPAPI-Maschinenbereich und was er nicht schützt (7),
  ACLs statt Modi, reduzierte Dienstprivilegien statt "Dienst-Härtung (systemd)" (`:1310`),
  kein Authenticode und Folgen, Grenze der Installer-Prüfung ohne Pin (14.3), Ereignisanzeige.
  "Konsistenz" (`:1332-1334`) mit Schattenkopie (dateikonsistent) und der Rückfall-Regel.
- "Offene Punkte" (`:1338`): Windows-Eintrag ersetzen durch "Windows on ARM, Authenticode,
  Windows Bare Metal".
- "Tests" (ab `:1368`, Aufzählung `:1381` mit "Windows"): Windows-Job und Maschinentests.

### 20.2 agent/README.md (Englisch, wie bisher)

- "Installing" (`:28-…`): Windows-Block, 32-Bit-RMM-Hinweis, Datei-Weg statt `iex`.
- "Command line": `run --service`, Rechte unter Windows.
- "What the agent does" (`:198`): `useVss` beschreibt das echte Verhalten; Snapshot-Politik.
- "Hooks" (`:259-…`): PowerShell, Exit-Code-Hülle, `hooks.d`-Endungen, GPO-Ausführungsrichtlinie,
  keine Gnadenfrist bei Zeitüberschreitung.
- "Proxy" (`:286-287`): Windows über `-Proxy`, Grenzen (12.5).
- "Security model" (`:291-…`): DPAPI, ACL-Prüfung, Job Objects, Dienstprivilegien.
- "Files" (`:359-373`): Windows-Pfade (Tabelle aus Abschnitt 5).
- "Build" (`:375-…`): fünf Ziele, `restic.exe`, ZIP-Format von `tools/fetch`.
- "Release signing": Defender-Einreichung beim Prerelease, Freigabe erst nach
  `agent-windows-check`.
- "Tests" (`:516-…`): `agent-windows`, `test-install-windows.ps1`, Maschinentest.
- "Known limits" (`:604-636`): Windows-Eintrag (`:615-616`) ersetzen durch: Vorschau, kein
  arm64, kein Authenticode, keine ADS, keine EFS-Dateien anderer Benutzer, Nur-Online-Dateien
  ausgelassen, Junctions als Links, Schattenkopie nur dateikonsistent, kein Bare Metal, Proxy
  ohne WPAD/NTLM und ohne Zugangsdaten, Hooks nur `.ps1`/`.exe`. `:613` ("no bare-metal
  restore") um Windows ergänzen.

### 20.3 Weitere

- `docs/CI.md`: fünf Ziele, Jobs `agent-windows`, `agent-windows-check`, `agent-sums`;
  `:522` ("Windows and the Windows agent are not part of 0.1.0") streichen.
- `README.md` (Wurzel): `:32` ("Windows is planned") und `:119` (Aufzählung "Not included")
  anpassen.
- `docs/GLOSSARY.md`: VSS, DPAPI, Schattenkopie, Dateisystem-Snapshot.
- `THIRD_PARTY_NOTICES.md` (neu erzeugt). `docs/FILESHARES.md` bleibt (VSS über SMB gibt es
  dort weiterhin nicht, `:1691-1696`).
- `CHANGELOG.md` (0.5.0), Windows-Eintrag mit:
  - Windows-Agent als Vorschau, Grenzen (nur amd64, kein Authenticode, keine ADS/EFS,
    Junctions als Links, Schattenkopie dateikonsistent, kein Bare Metal).
  - Zwei weitere Binaries in jedem Server-Image und neue Release-Assets
    `restow-agent_<v>_windows-amd64.exe`.
  - "Für bestehende Installationen ist nichts zu tun": keine Migration; ältere Agenten
    ignorieren `snapshotOnFailure`.
  - Fingerabdruck des Release-Schlüssels.

## 21. Bekannte Grenzen (Zusammenfassung)

Was in 0.5.0 bewusst fehlt oder nur eingeschränkt geht, gesammelt für agent/README.md "Known
limits" und docs/AGENT.md: Abschnitt 2.2 (Umfang), dateikonsistente Schattenkopie (17.5),
DPAPI nur gegen Kopien der Datei allein (7), Proxy ohne WPAD/PAC/NTLM/Kerberos und ohne
Zugangsdaten (12.5), keine Gnadenfrist für Hooks unter Windows und Hooks nur `.ps1`/`.exe`
(12.2), `.ps1`-Hooks unter einer GPO mit `AllSigned` nur signiert (12.2), Binärdatei bleibt
nach Deinstallation über das Binary bis zum Neustart liegen (9.4), Restrisiko beim
Job-Zuordnen (12.3), Installer-Prüfung schützt ohne Pin nicht gegen eine feindliche Instanz
(14.3).

## 22. Testplan

### 22.1 Automatisch (CI)

Ubuntu-Job `agent`:

- `go vet` für `windows/amd64` (Abschnitt 3.5).
- Byte-Wächter auf `restic.exe` (Abschnitt 3.5).
- Reine Funktionen mit Tabellentests, laufen auf jedem System: `windowsPower`,
  Snapshot-Erkennung aus restic-Zeilen (fehlgeschlagen, nicht unterstützt, Cleanup, Exit 1
  mit `VSS error`, mit DLL-Text, mit `CoInitializeEx`, unbekannter Exit 1 mit Rückfall und
  Vergleich der `Fatal`-Meldungen), `backupArgs` mit VSS-Optionen und großem
  Laufwerksbuchstaben, `snapshotPathOf` (auch `c:`), Windows-`EscapeIncludePath`,
  Zielpfad-Regeln (18.1, Schritte 1 und 4) als reine Zeichenkettenprüfung, `procenv` mit
  Windows-Schreibweisen, ACE-Bewertung je Regelsatz mit den `icacls`-SDDL-Testdaten (Abschnitt
  6: `C:\` und `C:\ProgramData` als Vorfahren vertraut, als Objekt nicht; `C:\` als
  Elternordner eines Restore-Ziels vertraut), PowerShell-Hülle der Hooks, Zerlegung des
  Dienstprogrammpfads, Staging-Namen und `CleanupStaged`, Quellenfilter nach Pfadform (16.1).
- Core-Tests mit dem falschen restic, das die Windows-Fehlerzeilen ausgibt: Politik
  `continue`/`fail`, Rückfall, Abbruch beim ersten `snapshot_failed`, `stats.snapshot`.
- Update: Reihenfolge "erst beide prüfen, dann tauschen"; ein älteres, gültig signiertes
  Release mit falscher Version lässt restic unberührt.
- `tools/fetch` mit ZIP.
- `scripts/test-build.sh`: Ziel `windows-amd64`, `.exe`-Namen in `SHA256SUMS`.
- `check-go-deps.mjs` mit Windows-Ziel; `restic-licenses.mjs check` mit `restic.exe`.
- Server: Vitest/Postgres-Tests aus 19.2 (auch gemischter Job); i18n-Vollständigkeit.
- Image: Der Docker-Build mit einem `windows-amd64`-Ordner läuft durch, die Smoke-Prüfung
  findet `restow-agent.exe` (3.7).

Windows-Job `agent-windows` (Abschnitt 3.5):

- alle Unit-Tests ohne `unix`-Tag nativ, dazu mit Build-Tag `windowsintegration`:
  - Dienst: Anlegen mit Testnamen `RestowAgentTest`, Konfiguration auslesen und vergleichen
    (Programm in Anführungszeichen, verzögerter Start, Fehleraktionen, Flag,
    Privilegienliste, Dienst-SID), Start, Status, Stopp innerhalb von 15 s, Neustart über
    Exit-Code 3 (Fehleraktion), Löschen.
  - **Stoppsignal aus dem echten Dienst:** Der Testdienst (`restow-agent.exe run --service`
    mit Testkonfiguration) startet als "restic" ein kleines Go-Programm, das `os.Interrupt`
    in eine Datei schreibt. `ControlService(SERVICE_CONTROL_STOP)`; erwartet: das Programm sah
    das Signal innerhalb von 10 s. Prüft `AllocConsole` und `GenerateConsoleCtrlEvent` in
    Sitzung 0.
  - Privilegien: Der Testdienst schreibt die Privilegien seines Tokens; erwartet: genau die
    Liste aus 9.1, kein `SeDebugPrivilege`, kein `SeTcbPrivilege`.
  - Ereignisanzeige: Ein Ereignis wird geschrieben und mit `Get-WinEvent` gelesen.
  - `LockFileEx` mit zwei Prozessen.
  - DPAPI: `Save`/`Load`, Klartext wird abgelehnt, verfälschter Blob wird abgelehnt.
  - Atomares Schreiben, während ein zweiter Prozess die Zieldatei mit Gos Standard-Freigabe
    offen hält: Ersetzung gelingt nach Wiederholung bzw. nach Schließen; Log-Rotation bei
    offenem `agent.log` verliert keine Zeile.
  - ACL: die echten `C:\`, `C:\ProgramData`, `C:\Program Files` des Runners gegen die
    erwarteten Ergebnisse je Regelsatz; Ordner mit geschützter DACL ist vertraut; Ordner mit
    `Users: Modify` nicht; Junction im Pfad nicht; `TrustedFile` für eine Datei unter
    `C:\Program Files\…` und unter `C:\ProgramData\Restow\state\hooks.d` vertraut.
  - Job Objects: Hook startet `cmd /c start /b ping -t 127.0.0.1`, Zeitüberschreitung beendet
    beide; normales Ende lässt den Hintergrundprozess leben (Flag gelöscht).
  - Hooks: Exit-Codes der Hülle (`exit 3` → 3, `Write-Error` → 1, `cmd /c exit 7` → 7,
    erfolgreicher Befehl → 0, Befehl mit Kommentar am Ende → Hülle greift).
  - Selbstaktualisierung gegen `internal/testutil/fakeserver`: Tausch der laufenden
    `restow-agent.exe`, `.prev` vorhanden, Rücknahme bei Fehler.
- Integration mit `restic.exe` und `rest-server.exe`: Backup eines Testordners, Restore in ein
  neues Ziel, Stichprobe; mit `--use-fs-snapshot` eine exklusiv gesperrte Datei (Hinweis,
  falls VSS auf dem Runner nicht geht); Rückfall (`snapshot_unavailable`) über einen Lauf
  ohne Rechte, falls der Runner das zulässt; `-o vss.provider={00000000-0000-0000-0000-000000000001}`
  (unbekannter Anbieter) erzeugt `failed to create snapshot for [c:\]: invalid VSS provider …`
  und damit `snapshot_failed`, ohne funktionierende Schattenkopie; Restore-Ziel auf einem
  FAT-formatierten VHD (`New-VHD` ist auf dem Runner nicht garantiert, sonst `diskpart`-VHD)
  wird abgelehnt.
- Installer: `test-install-windows.ps1` mit Parser-Prüfung, RFC-8032- und
  Wycheproof-Vektoren, echter Signatur, Negativfällen (14.3) mit Prüfung "kein Exit 0, keine
  Datei angelegt", Differenztest gegen Go, Pin passend und unpassend, vollständigem Lauf mit
  `RESTOW_INSTALL_ROOT` und `RESTOW_SKIP_SERVICE` gegen die Testinstanz, Lauf aus dem
  32-Bit-Host, zweitem Lauf (Wiederholbarkeit), `-Uninstall`, Abbruch bei einem vorher von
  einem Testbenutzer angelegten `C:\ProgramData\Restow` und bei einer Junction an dieser
  Stelle, Ablehnung von `-Proxy` mit Zugangsdaten, Token-Datei wird nach `enroll` gelöscht.

Release: `agent-windows-check` vor `agent-sums` (Abschnitt 3.6).

### 22.2 Grenzen der CI

GitHub bietet nur Windows-Server-Runner (2022, 2025), keine Client-Versionen, kein ARM64 mit
Windows-Desktop, keinen Defender in Reinform, kein Smart App Control, keine Domäne, keine
GPOs, keinen Akku, keinen echten Neustart. Ob VSS auf dem gehosteten Runner funktioniert, ist
offen; der Test meldet es als Hinweis. Die Erkennung der restic-Texte hängt davon nicht ab
(Byte-Wächter, unbekannter Anbieter).

### 22.3 Auf echten Maschinen (Maintainer, vor dem Release)

Testsysteme: Windows 11 Pro 24H2 (Laptop mit Akku, OneDrive), Windows 10 22H2, Windows Server
2016 (frisch, ohne Updates auf TLS), Windows Server 2022 mit SQL Server Express, optional
Windows 11 auf ARM64 (nur für die Ablehnung).

**Freigabe-Gate** (vor dem Release Pflicht): Punkte 1, 2, 5, 6, 7, 9, 13, 15, 16. Die übrigen
Punkte folgen nach dem Release und gehen in 0.5.x ein.

1. Installation mit dem Befehl aus dem Enroll-Dialog auf allen Systemen, einmal aus einem
   32-Bit-Host mit Token-Datei; Server 2016 ohne TLS-1.2-Voreinstellung; Dauer der
   Signaturprüfung notieren; `icacls` von `C:\`, `C:\ProgramData`, `C:\Program Files` und
   `config\systemprofile` notieren und mit den Testdaten aus Abschnitt 6 vergleichen.
2. Defender: Wird `restow-agent.exe` oder `restic.exe` beim Download, Start oder Update
   gemeldet? Einreichung bei Microsoft vorher erledigt? Gilt als bestanden mit einem sauberen
   Ergebnis auf einem frischen Windows 11 mit Standardeinstellungen.
3. Smart App Control (Windows 11 frisch installiert, SAC an): erkennt der Installer es und
   bricht verständlich ab?
4. ARM64: klare Ablehnung durch Installer und Server.
5. Dienst: startet nach Neustart (verzögert), steht unter LocalSystem mit der reduzierten
   Privilegienliste (`sc qprivs RestowAgent`), kein sichtbares Konsolenfenster, Stopp über
   `services.msc` in unter 15 s ohne laufende Sicherung; Abmelden eines Benutzers beendet den
   Dienst nicht.
6. Sicherung mit Schattenkopie, während Outlook (PST), eine geöffnete Excel-Datei und SQL
   Server laufen: Dateien im Snapshot, `stats.snapshot.state = used`; Menge der
   Schattenkopie-IDs aus `vssadmin list shadows` vor und nach dem Lauf gleich. Restore der
   `.mdf`/`.ldf` und Anhängen an SQL Server gelingt.
7. VSS-Fehler erzwingen (Dienst "Volumeschattenkopie" deaktivieren): mit `continue` Lauf
   `partial` und `snapshot_unavailable`, mit `fail` Lauf `failed`; Texte in der Oberfläche.
8. Volume ohne VSS (exFAT-USB-Stick als Quelle) und ein vom Anbieter nicht unterstütztes
   Volume (z. B. eingehängte VHD): keine Fehlermeldung, Hinweis im Log, auch mit `fail`.
9. Abbruch aus der Oberfläche ("Sicherung stoppen") während restic läuft: restic endet über
   CTRL_BREAK, keine Sperre bleibt im Repository, Menge der Schattenkopie-IDs vorher/nachher
   gleich. Zusätzlich restic per `TerminateJobObject` hart beenden (Agent-Prozess im
   Taskmanager beenden): bleibt eine Schattenkopie liegen? Ergebnis in docs/AGENT.md.
10. Herunterfahren während einer Sicherung: Lauf `interrupted`, Fortsetzung nach dem Start.
11. Laptop: "nur am Netzteil" mit und ohne Ladekabel; Ruhezustand während des Laufs.
12. OneDrive mit Nur-Online-Dateien: nichts wird heruntergeladen.
13. Restore: Standardziel `C:\Restow-Restore-…`; eigenes Ziel `D:\R`; Ziel mit Inhalt wird
    abgelehnt; Junction als Ziel wird abgelehnt; Ziel unter `C:\Windows` und auf einem
    FAT-Stick wird abgelehnt; ACLs mit `icacls /save` vor Backup und nach Restore
    vergleichen; lange Pfade (> 260 Zeichen), Umlaute, Emoji, Datei mit `[` im Namen
    (Einzeldatei-Restore), Junctions, symbolische Links, Hardlinks, EFS-Datei, Datei mit ADS.
14. Hooks: `.ps1`, `.exe`, Regel `any` mit PowerShell-Befehl; fehlschlagender Pre-Hook bricht
    ab; Zeitüberschreitung beendet Kindprozesse; Ausgabe mit Umlauten im Lauf-Log; GPO
    `AllSigned` ergibt die verständliche Meldung.
15. Selbstaktualisierung auf eine Testversion: laufende Exe getauscht, Dienst nach etwa 5 s
    wieder da, Ereignis 7024 einmal, eigenes Update-Ereignis, `.prev` vorhanden.
16. Deinstallation über `windows.ps1 -Uninstall` (beide Ordner sofort weg) und über die
    Oberfläche (Dienst weg, `ProgramData\Restow` bis auf `logs` weg, `restow-agent.exe` nach
    Neustart weg, Ereignis "Deinstalliert durch Serveraufgabe"); keine Reste in der Registry
    außer Ereignisanzeige.
17. Proxy über `-Proxy`: Heartbeat und restic gehen über den Proxy; `-Proxy` mit
    Zugangsdaten wird abgelehnt.
18. Domänenrechner mit ASR-Regel "Verbreitung/Alter": Verhalten dokumentieren;
    Domänencontroller zeigt den Hinweis aus 2.2.

## 23. Reihenfolge und Meilensteine

Linux Bare Metal (Manifest, `--one-file-system`, `restow-agent recover`, ISO) und
APFS-Snapshots ändern dieselben Dateien wie der Windows-Port: `agent/build.sh`, `Dockerfile`,
`release.yml`, `restic/backup.go` (`backupArgs`), `core/backup.go`, `core/util.go`
(`prepareRestoreTarget`), `tools.env`, `docs/AGENT.md`, `agent/README.md`. Darum:

- **M1 (zuerst zusammenführen):** Build mit fünf Zielen, CI (`agent-windows`, `go vet` für
  Windows, Build-Tags inkl. `internal/pve`), Release-Gerüst (3.6), Image (3.7), neutrale
  Snapshot-Begriffe in Richtlinie, Fehlercodes und `stats.snapshot` (17), `internal/winapi`,
  Vertrauensprüfung, State/DPAPI, `atomicfile`, Sperre, Dienst, Server nimmt `windows` an
  (hinter dem Vorschau-Hinweis). Liefert noch keinen nutzbaren Windows-Agenten aus. Bare
  Metal und APFS setzen auf M1 auf.
- **M2:** Sicherung mit Schattenkopie und Fehlerpolitik, Restore, Hooks, Selbstaktualisierung,
  Ereignisanzeige.
- **M3:** Installer, Oberfläche, i18n, Dokumentation, Defender-Einreichung, Maschinen-Checkliste.

Rutscht der Plan, gehen aus M3 alles außer Installer, Enroll-Dialog und Freigabe-Gate nach
0.5.x: Hook-Hilfetexte je OS, Windows-Demorechner, Windows-`dataFolders`. Der Rückfall für
den Gesamtplan ist die Kennzeichnung als Vorschau (Offene Entscheidung 6).

## 24. Dateien, die sich ändern

Agent (`agent/`):

- `build.sh`, `tools.env`, `scripts/pin-tools.sh`, `scripts/lib.sh`, `scripts/test.sh`,
  `scripts/test-build.sh`, `tools/fetch/main.go`, `tools/fetch/main_test.go`
- neu `install/windows.ps1`, neu `scripts/test-install-windows.ps1`, neu Testdaten
  `install/testdata/` (Signatur, RFC- und Wycheproof-Vektoren), neu
  `scripts/sigdiff/main.go` (Differenztest, nur Standardbibliothek)
- `cmd/restow-agent/common.go`, `main.go` (Hilfetext), `run.go`, `service.go`, `update.go`,
  `enroll.go`, `hookscmd.go`, `installation.go` (unter Windows nur Vertrauensprüfung),
  `status.go`, `main_test.go` (`unix`)
- `cmd/restow-pve/main.go`, `cmd/restow-share/main.go` (Build-Tags)
- `internal/pve/` (`//go:build !windows`)
- neu `internal/winapi/` (`dll_windows.go`, `kernel32_windows.go`, `advapi32_windows.go`,
  `crypt32_windows.go`, `shell32_windows.go`, `errors_windows.go`, `consts.go`)
- neu `internal/winsvc/` (`service_windows.go`, Tests)
- neu `internal/procctl/` (`job_windows.go`, `ctrl_windows.go`, `console_windows.go`, Tests)
- neu `internal/eventlog/` (`eventlog_windows.go`, `eventlog_other.go`)
- neu `internal/atomicfile/` (`atomicfile.go`, `atomicfile_windows.go`, Tests)
- `internal/logging/rotate.go` (Rotation scheitert nicht hart)
- `internal/paths/paths.go`, neu `paths_windows.go`, neu `trust_windows.go`, neu `acl.go`,
  neu `testdata/*.sddl`, `trust_test.go` (Aufteilung, `unix`-Teil)
- `internal/state/state.go`, neu `fs_windows.go`, neu `protect_windows.go`, `state_test.go`
- `internal/status/status.go` (`atomicfile`)
- `internal/svc/svc.go` (gemeinsame Typen ohne Tag), `systemd.go`, `launchd.go`,
  `uninstall.go` (Unix-Teil), neu `scm_windows.go`, neu `uninstall_windows.go`,
  `svc_test.go`
- `internal/lock/lock.go` (Unix), neu `lock_windows.go`, `lock_test.go`
- `internal/hooks/hooks.go`, `policy.go` (Aufteilung), neu `run_unix.go`, `run_windows.go`,
  `resolve_windows.go`, neu `pwsh.go` (Hülle), Tests (`policy_test.go` `unix`)
- `internal/update/update.go` (Aufteilung, neue Reihenfolge für alle Systeme), neu
  `swap_unix.go`, `swap_windows.go`, `update_test.go`
- `internal/power/power.go`, neu `power_windows.go`, `power_test.go`
- `internal/procenv/procenv.go`, `procenv_test.go`
- `internal/sysinfo/sysinfo.go`, neu `sysinfo_windows.go`, neu `datafolders_windows.go`,
  `machine.go`
- `internal/restic/backup.go`, `errors.go`, `pattern.go`, `restore.go`, `runner.go`, neu
  `runner_windows.go`, neu `runner_unix.go`, neu `snapshot.go`, `restic_test.go` (`unix`)
- `internal/api/types.go` (`Policy.SnapshotOnFailure`, `Stats.Snapshot`), `errors.go`
  (`:130`, Windows-Fehlercode 10061 für "Verbindung abgelehnt")
- `internal/core/backup.go`, `restore.go`, `util.go`, neu `util_windows.go`,
  `verify.go`, `activity.go`, `outbox.go`, `core_test.go`, `harness_test.go`,
  `cancel_test.go`, `update_now_test.go` (`unix`, plus neue Fälle für die Snapshot-Politik)
- `integration/` (neue Windows-Dateien), `README.md`, `THIRD_PARTY_NOTICES.txt` (erzeugt)

Server und Web:

- `packages/core/src/endpoints/config.ts`, `agent-policy.ts`, `run-errors.ts`,
  `run-failures.ts`, `data-folders.ts`, neu `restore-target.ts`, neu `endpoint-paths.ts`
- `packages/core/src/failures/types.ts`, `catalog.ts`
- `packages/db/src/schema/endpoints.ts` (nur Typ `EndpointRunStats`)
- `apps/api/src/features/endpoints/agent-service.ts`, `service.ts`, `schemas.ts`,
  `commands.ts`, `distribution.ts`, `install-routes.ts`, `agent-policy.ts`, Tests
- `apps/api/src/features/backup-jobs/` (Pfadprüfung "mindestens ein Mitglied"), Tests
- `apps/api/src/lib/provider-access.ts`
- `apps/web/src/features/endpoints/components/enroll-dialog.tsx`, `restore-dialog.tsx`,
  `settings-tab.tsx`, `settings-form.ts`, `presenters.ts`, `api.ts`, die Richtlinien-Editoren,
  Job-Editor, Lauf-Details, Rechnerseite, Snapshot-Browser, `endpoints-page.test.tsx`
- `packages/i18n/resources/{de,en}/endpoints.json`, `failures.json` (und die Datei mit den
  Richtlinien-Texten)
- `deploy/demo/seed/src/agent-api.ts`

Build, CI, Lizenzen, Doku:

- `.github/workflows/ci.yml`, `.github/workflows/release.yml` (Jobs `agent`,
  `agent-windows-check`, `agent-sums`, `agent-signature`, `publish`), `Dockerfile`
  (`:154`, `:162`, `:205`, `:213`)
- `scripts/ci/check-go-deps.mjs`, `scripts/ci/check-go-deps.test.mjs`,
  `scripts/restic-licenses.mjs`, `scripts/ci/restic-licenses.test.mjs`,
  `scripts/third-party-notices.mjs` (nur Text), `licenses/restic-deps/` (drei Module,
  `modules.json`), `THIRD_PARTY_NOTICES.md`
- `scripts/smoke/checks/01-install.mjs`
- `docs/AGENT.md`, `docs/CI.md`, `docs/GLOSSARY.md`, `README.md`, `docs/WINDOWS-AGENT.md`
  (dieses Dokument, nach der Umsetzung als Referenz kürzen oder in AGENT.md aufgehen
  lassen), `CHANGELOG.md`

Unverändert: `scripts/release/sign-agent.sh`, `scripts/ci/license-policy.json`,
`packages/db/drizzle/` (keine Migration), `integrations/pve/`.

## 25. Offene Entscheidungen

1. **Standard der Snapshot-Fehlerpolitik.** `continue` (Sicherung ohne Schattenkopie,
   `partial`) oder `fail`. *Empfehlung:* `continue` als Standard, für alle drei Verfahren
   (VSS, APFS, LVM/btrfs). Eine Sicherung mit möglicherweise inkonsistenten offenen Dateien
   ist besser als keine, und `partial` mit klarer Erklärung macht das sichtbar; wer Konsistenz
   erzwingen will, setzt `fail` in der Richtlinie und sperrt sie.

2. **Windows on ARM.** Gar nicht oder amd64 unter Emulation. *Empfehlung:* In 0.5.0
   ablehnen (Installer und Server). restic liefert kein arm64, ein selbst gebautes arm64-restic
   kann kein VSS, und ob das amd64-restic unter Emulation VSS kann, ist ungeprüft. Wieder
   aufnehmen, wenn restic ein `windows_arm64`-Release mit VSS-Unterstützung hat.

3. **Signaturprüfung im Installer.** Eigene Ed25519-Prüfung in PowerShell oder nur
   `ssh-keygen -Y verify` (mit Abbruch, wo es fehlt). *Empfehlung:* Eigene Prüfung in
   PowerShell, mit derselben Annahmemenge wie `crypto/ed25519`, Differenztest gegen Go im
   Windows-Job und Negativvektoren. `ssh-keygen` ab 8.1 fehlt auf Server 2016 und vielen
   Windows-10-Systemen; ein Installer, der dort nur mit manueller Prüfsumme geht, wird in der
   Praxis umgangen. Der Agent prüft bei jedem Update ohnehin selbst.

4. **Authenticode.** Ohne Signatur bleiben Defender-Fehlalarme, Smart App Control und
   ASR-Regeln ein Risiko. *Empfehlung:* 0.5.0 ohne Signatur ausliefern, mit
   Defender-Einreichung je Prerelease und den Hinweisen aus Abschnitt 15; parallel bei der
   SignPath Foundation (kostenlose Code-Signierung für Open-Source-Projekte) anfragen und,
   wenn bewilligt, in 0.5.x `restow-agent.exe` signieren. `windows.ps1` bleibt unsigniert:
   Der Server schreibt es je Anfrage um, und `iex` prüft keine Signatur. Erst wenn es eine
   statische Datei wird, die Instanz, Version und Schlüssel als Parameter nimmt, hilft eine
   Signatur, und dann nur beim Start als Datei. restic.exe bliebe unsigniert, solange restic
   nicht selbst signiert.

5. **Standard-Restore-Ziel.** `%SystemDrive%\Restow-Restore-<zeit>` oder wie Unix im ersten
   vertrauten gesicherten Ordner (meist `C:\Users\Restow-Restore-<zeit>`). *Empfehlung:*
   `%SystemDrive%\Restow-Restore-<zeit>`. Für Windows-Admins naheliegend, nicht mit einem
   Benutzerprofil zu verwechseln, außerhalb von Controlled-Folder-Access-Ordnern; der
   Unterschied zu Unix wird dokumentiert.

6. **Windows in 0.5.0 als Vorschau kennzeichnen.** Voll unterstützt oder "Vorschau" im
   Enroll-Dialog, in der Rechnerliste und im CHANGELOG. *Empfehlung:* Vorschau, bis ein
   sauberes Defender-Ergebnis auf einem frischen Windows 11 mit Standardeinstellungen und das
   vollständige Freigabe-Gate (22.3) vorliegen; die Kennzeichnung fällt in einem 0.5.x ohne
   weitere Codeänderung. Die Kernprüfung (Schattenkopie, Stoppsignal im Dienst) hängt an
   Maschinentests, und 0.5.0 trägt mit Linux Bare Metal und APFS schon viel; die Vorschau
   ist auch der Rückfall, wenn M3 rutscht (Abschnitt 23).
