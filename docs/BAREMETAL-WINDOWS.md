# Windows: Bare Metal, Rollback und Anwendungen (Entwurf)

Dieses Dokument beschreibt, wie Restow einen Windows-Rechner so sichert, dass er sich
**wiederherstellen** lässt: als ganzer Rechner auf neuer oder leerer Hardware (Bare Metal),
als Rollback desselben Rechners auf einen früheren Stand und, für SQL Server, als einzelne
Datenbank bis zu einem Zeitpunkt. Anlass ist die Anforderung des Maintainers: "Eine
Windows-Sicherung (z. B. SQL) bringt nichts, wenn man sie nicht wiederherstellen kann; wir
brauchen Windows Bare Metal und eine Rollback- bzw. Restore-Option." Der Maßstab ist derselbe
wie in docs/BAREMETAL.md: **Es muss beim ersten Mal auf echten Maschinen funktionieren**, und
**Grün ist Beweis**.

Das Dokument baut auf docs/BAREMETAL.md auf und übernimmt dessen Begriffe und Bausteine:
Layout-Manifest (M1, Abschnitt 4 dort), Planer und Stufe 1 (M2, Abschnitt 10.4 und 12.1),
Wiederherstellungscode, Freigabe, Recovery-Sitzung, Lesezugang und Wiederanbindung (M3,
Abschnitt 9 und 11), Recovery-ISO und `restow-agent recover` (M4, Abschnitt 8 und 10),
Startprobe im Labor (M5, Abschnitt 12.3). Verweise der Form "BM 9.4" meinen Abschnitte von
docs/BAREMETAL.md, "WA 17.5" Abschnitte von docs/WINDOWS-AGENT.md.

Stand der Code-Verweise: Zweig `wip/050-windows-bmr`, Commit `7d25a6d5` (auf
`wip/050-baremetal`, M1 bis M3 umgesetzt, M4 bis M6 offen). restic-Fakten sind gegen die
Quellen von restic `v0.19.1` geprüft (gepinnt in `agent/tools.env`). Markierungen:

- **[Maschine]**: nur auf echter Hardware bzw. einem echten Windows zu klären; steht im
  Testplan (Abschnitt 8.4) und gesammelt in Abschnitt 8.5.
- **[CI]**: auf dem Windows-Runner oder in der KVM-CI zu klären (Abschnitt 8.2, 8.3).
- **[Quelle]**: gegen die Quellen von restic `v0.19.1` zu belegen, bevor der Meilenstein
  fertig ist.
- **[Win]**: bekanntes Verhalten von Windows, SQL Server, Exchange oder Active Directory laut
  Herstellerdokumentation, hier nicht geprüft. Jede **[Win]**-Aussage, auf der ein
  Meilenstein beruht, steht zusätzlich im Testplan.
- **Vorschlag:** eine Entscheidung dieses Entwurfs, die der Maintainer noch nicht getroffen
  hat. Alle Vorschläge stehen gesammelt mit Alternative in Abschnitt 11.

Fassung 2: Die Befunde zweier Reviews (Windows-Interna und Datensicherheit; Umfang,
Reihenfolge und Testbarkeit) sind eingearbeitet. Was übernommen und was mit Begründung
abgelehnt wurde, steht in Abschnitt 11.2.

Die Grundregeln aus BM (Einleitung) gelten unverändert und werden hier für Windows
ausgelegt:

1. **Identität bewahren statt umbauen.** Die Wiederherstellung schreibt dieselbe
   Partitionstabelle mit denselben Kennungen (GPT-Disk-GUID und Partitions-GUIDs bzw.
   MBR-Signatur und Startoffsets) und dieselben Volumes Block für Block zurück. Dann stimmen
   BCD, `HKLM\SYSTEM\MountedDevices`, Laufwerksbuchstaben und die Seriennummern der Volumes
   ohne Änderung. Wer den Stapel ändern will (MBR nach GPT, BIOS nach UEFI, Storage Spaces,
   kleinere Platte), installiert neu und holt Dateien zurück. Weil die Identität gleich
   bleibt, darf keine zweite Kopie dieser Identität am Ziel angeschlossen sein (BM 10.7).
2. **Erst prüfen, dann zerstören.** Vor dem ersten Schreibzugriff steht ein vollständiger
   Plan, den der Bediener sieht und bestätigt. Größen, Sektorgrößen, Speichertreiber für den
   Ziel-Controller, Secure-Boot-Stand der Ziel-Firmware (auch die Sperrliste für
   Windows-Bootmanager), BitLocker-Zustand und doppelte Identitäten werden vor dem Löschen
   geprüft. Derselbe Planer läuft auf dem Server gegen jedes erfasste Layout (Stufe 1).
3. **Nichts löschen, was nicht gelöscht werden muss.** Ein Rollback schreibt nur die Blöcke,
   die sich gegenüber dem Stand geändert haben (Ausnahme: ein BitLocker-Volume mit dem ISO,
   Abschnitt 3.6). Ein Rollback aus dem laufenden System (C2 bis C4) sichert vorher den
   jetzigen Stand und ist damit umkehrbar. Ein Rollback vom Medium (C1) ist nur umkehrbar, wenn
   der Bediener im Plan die volle Sicherung vorher wählt (Abschnitt 4.3, Frage 19); sonst sagt
   der Plan ausdrücklich "nicht umkehrbar".
4. **Grün ist Beweis.** "Bare Metal: grün" heißt für Windows, dass für genau dieses Layout und
   diese Startkette eine Wiederherstellung in einer virtuellen Maschine bis zum laufenden
   Dienst `RestowAgent` gelaufen ist (Abschnitt 8 und W6), auf einem anderen Controller als die
   Quelle, mit dem Secure-Boot-Stand echter Firmware. Das beweist eine VM mit
   Standard-Controller, nicht die Ziel-Firmware, RAID oder VMD des Kunden; dafür gibt es die
   Vorabprüfung auf der echten Zielhardware (4.6). "SQL: grün" heißt, dass eine Sicherung
   **aus dem Repository** zurückgespielt und `DBCC CHECKDB` darauf fehlerfrei gelaufen ist
   (Abschnitt 5.1.7). Eine Prüfung, die nicht vollständig lief, bewertet nichts.

Harte Randbedingungen (aus BM und WA, unverändert):

- Der Go-Agent nutzt kein Go-Modul außer seinem eigenen (`agent/go.mod` ohne `require`,
  CI `scripts/ci/check-go-deps.mjs`). Windows-APIs nur über das Standardpaket `syscall`
  (`syscall.NewLazyDLL`, `syscall.SyscallN` auch für COM-Methoden über die vtable) oder über
  Werkzeuge des Betriebssystems als eigener Prozess, immer mit Argumentliste, nie über eine
  Shell. `golang.org/x/sys/windows` und `go-ole` sind ausgeschlossen, Code daraus wird nicht
  kopiert. restics VSS-Code (`internal/fs/vss_windows.go`, BSD-2) dient als Vorlage für die
  Reihenfolge der Aufrufe, nicht als Kopie (Abschnitt 11, Frage 9).
- Neuer Windows-only-Code trägt `//go:build windows`; reine Logik (Manifest, Planer, Masken,
  Blockstrom, XML der Writer-Metadaten, LSN-Ketten, ISO-Schreiber) bleibt ohne Build-Tag und
  wird auf jedem System getestet.
- Restow liefert keine Microsoft-Dateien aus (kein `winre.wim`, kein `bootmgr`, kein
  `boot.sdi`, keine Treiber). Was davon gebraucht wird, baut der Agent auf dem Rechner des
  Kunden aus dessen eigener Windows-Installation (Abschnitt 4.2).
- Das Recovery-ISO bleibt das eigene GPL-Werk unter `integrations/recovery` (BM 8.1). Neue
  Pakete darin (Abschnitt 4.1.1) ändern daran nichts; der Agent selbst bleibt Apache-2.0 und
  liefert unter Windows weiter nur `restow-agent.exe`, `restic.exe`, die Hinweise und den
  Installer aus (WA, Randbedingungen).
- Nur ausgehende Verbindungen; das Repository und der Image-Speicher eines Rechners sind für
  den Agenten nur anhängbar; die Wiederherstellung liest mit dem Prinzipal `reader`.
- Community-Edition, ohne Lizenzprüfung. Kein Code unter `ee/`.
- Keine Erweiterung über ein eigenes Kernelmodul (Filtertreiber): Es gibt keinen
  Authenticode-Schlüssel (WA 15), und ein Kernelmodul bräuchte eine Signatur des
  Betriebssystemherstellers.

## 0. Kurzfassung

- **Befund:** Heute sichert der Agent unter Windows Dateien aus einer Schattenkopie, die restic
  selbst anlegt. Das ist für Datenordner richtig, aber kein wiederherstellbarer Rechner und
  keine wiederherstellbare Datenbank: Ein Ganz-Rechner-Job sichert unter Windows nur die
  Ordner (`fsbackup.go:66-71`, Logzeile `:83`); restic legt für jedes Volume einen **eigenen**
  Snapshot-Satz an, wenn es das Volume zum ersten Mal liest, ohne Writer-Komponenten und ohne
  `GatherWriterStatus`. Eine Datenbank mit Daten auf `D:` und Log auf `L:` kommt aus zwei
  Zeitpunkten. restic sichert unter Windows weder Hardlinks noch Alternate Data Streams,
  WOF-Kompression, Kurznamen oder Reparse-Daten; ein Systemvolume lässt sich aus Dateien
  nicht treu wieder aufbauen. Restore geht nur in einen neuen, leeren Ordner; ein Restore an
  den Originalort und ein Rollback fehlen. Die als Weg zur SQL-Konsistenz dokumentierte
  Pre-Hook (`sqlcmd -Q "BACKUP DATABASE …"`) scheitert auf einer Standardinstallation, weil
  SYSTEM seit SQL Server 2012 kein sysadmin ist (**[Win]**). Einzelheiten in Abschnitt 1.
- **Restore-Option zuerst (0.5.1):** Restore an den Originalort (überschreiben oder
  überspringen) und "Ordner zurücksetzen" (C4) brauchen weder Images noch einen M-Meilenstein,
  nur restic `restore --overwrite`/`--delete`. Sie kommen als W7a vor jedem Bare-Metal-Teil,
  für alle Plattformen.
- **SQL Server (0.5.0 und 0.5.1):** native Sicherung, die der Agent selbst steuert (kein Hook).
  Erste Stufe W2a: `BACKUP DATABASE … WITH COPY_ONLY, CHECKSUM, NO_COMPRESSION` je Datenbank in
  einen Staging-Ordner, eigener restic-Snapshot, Restore unter neuem Namen, herunterladbares
  Restore-Skript für einen anderen Rechner und **Prüfung = Restore aus dem Repository unter
  Prüfnamen + `DBCC CHECKDB`**. Zweite Stufe W2b: "Restow führt die Log-Kette" mit
  `BACKUP LOG`, Point-in-Time (`STOPAT`), Tail-Log (nach `SINGLE_USER`) und Restore über die
  vorhandene Datenbank.
- **Sicherung (neu, Bare Metal):** Mit "Ganzer Rechner" sichert der Agent unter Windows
  **zusätzlich** zu den Ordnern **Volume-Images**: ein eigener VSS-Requester (COM über
  `syscall`, als Hilfsprozess `restow-agent vss-hold`) legt **einen** Snapshot-Satz über alle
  Volumes des Images an, nimmt die Pflicht- und Systemzustands-Komponenten der Writer auf
  (Kopie-Sicherung `VSS_BT_COPY`, damit die Sicherungsketten des Kunden unberührt bleiben),
  meldet erwartete, aber fehlende Writer, prüft den Zustand jedes Writers vor und nach dem
  Abschluss und liest dann aus jeder Schattenkopie nur die **belegten** Cluster (Volume-Bitmap)
  und immer den Bereich hinter dem letzten Cluster (Backup-Bootsektor). Geheimnisse und Ballast
  des Agenten (`state.json` und seine Temp-Dateien, Slot-Dateien, Cache, Temp, Outbox,
  SQL-Staging) sowie Auslagerungs-, Ruhezustands- und Speicherabbilddateien werden im
  Datenstrom zu Nullen, defekte Cluster ebenfalls. Ablage **Vorschlag:** im vorhandenen
  Blockspeicher der PVE-Integration (4-MiB-Blöcke, SHA-256, Null-Blöcke frei, Hashliste je
  Volume, Block-Map je Sicherungsstand, serverseitig verschlüsselt und dedupliziert), nicht als
  Datenstrom in restic; Abwägung in Abschnitt 3.5. Dazu das **Layout-Manifest `windows`** als
  neue Plattform des Manifests aus M1.
- **Wiederherstellung:** drei Wege auf denselben Images und demselben Planer:
  - **B, WinRE-Medium (Vorschlag: zuerst, Frage 18):** ein WinPE, das der Agent aus der eigenen
    WinRE des Rechners baut (mit dessen Treibern, Microsoft-signierte Startkette, DISM,
    `bcdboot`, `manage-bde`, `reg load` mit Nachspielen der Hive-Logs), im Image-Speicher des
    Rechners abgelegt und als ISO herunterladbar. Es hängt für die Wiederherstellung nur an M3
    (fertig) und umgeht die meisten Punkte, die nur auf echter Hardware zu klären sind
    (Drittanbieter-CA, VMD/RST, BitLocker, schmutzige Hives, ntfs-3g).
  - **A, Recovery-ISO (M4):** der tote Rechner ohne Kit und der Rückfall; Partitionstabelle mit
    denselben GUIDs, Images zurück, Speichertreiber `storahci`/`stornvme` (nur Inbox-Treiber,
    nicht VMD/RST, nicht VirtIO), Eintrag im NVRAM, Wiederanbindung. Ein BitLocker-Systemvolume
    schreibt A immer ganz und unverschlüsselt (Abschnitt 3.6).
  - **C, Rollback:** derselbe Rechner zurück auf einen früheren Stand. C1 vom Medium (B oder A),
    C2 aus der Oberfläche ohne Medium (Neustart in das WinPE aus B als RAM-Disk), C3 für
    Datenvolumes im laufenden Betrieb (gesperrt **und** ausgehängt), C4 für einen Ordner
    (dateibasiert). Volumes eines Stands gehen als Gruppe zurück; eine Abwahl prüft der Planer
    gegen die Writer-Metadaten des Stands. Jeder Rollback aus dem laufenden System braucht die
    lokale Erlaubnis am Rechner (wie Hooks) und eine frische Anmeldung des Admins.
  - **Notfall-Assistent** fragt nach dem Szenario (Platte tot, neue Hardware, Update kaputt,
    Ransomware, Datenbank defekt, DC tot), nicht nach Buchstaben (Abschnitt 4.5); eine
    **Vorabprüfung** startet das Medium auf der echten Zielhardware und plant nur (4.6).
- **Weitere Anwendungen:** **Exchange:** im Image anwendungskonsistent wiederherstellbar,
  Log-Kürzung und Postfach-Restore erst später, DAG-Mitglieder mit Warnung. **Active
  Directory:** jede Wiederherstellung eines Domänencontrollers (A, B, C1, C2) setzt offline
  `Database restored from backup` und synchronisiert SYSVOL nicht autoritativ; Sperre jenseits
  der Tombstone-Lebensdauer (Vorgabe 60 Tage, wenn nicht lesbar).
- **Release-Vorschlag:**

| Release | Inhalt | Meilensteine |
| --- | --- | --- |
| **0.5.0** | Ehrliche Grundlage ohne neues Verhalten der Sicherung: Erkennung von Domänencontroller, SQL Server, Exchange, Hyper-V und BitLocker; feste Warnungen "Dateien offener Datenbanken sind keine wiederherstellbare SQL-, Exchange- oder AD-Sicherung"; korrigierte Hook-Doku; Mehr-Volume-Befund in der CI nachgestellt. **Dazu SQL Server, erste Stufe (Vorschau):** COPY_ONLY-Full, Restore unter neuem Namen, Restore-Skript für einen anderen Rechner, Prüfung mit CHECKDB ("SQL: grün"), wenn das Gate von W2a vor dem Tag besteht; sonst 0.5.1. Ändert keine Sicherungskette des Kunden. | W1, (W2a) |
| **0.5.1** | **Restore-Option:** Restore an den Originalort, Ordner zurücksetzen (C4) für alle Plattformen. **SQL, zweite Stufe:** eigene Log-Kette, Point-in-Time, Tail-Log, Restore über die vorhandene Datenbank, Aufbewahrung der Logs. | W7a, W2b |
| **0.5.x Vorschau "Windows Bare Metal"** (realistisch einige Monate nach 0.5.0) | Requester, Manifest, Volume-Images, Stufe 1; Wiederherstellung über das WinRE-Medium B und Rollback C1 von diesem Medium; Startprobe Windows. Weg A über das ISO im selben Release, wenn M4 und M5 bis dahin stabil sind, sonst im nächsten. Sichtbar erst mit bestandener Startprobe; kein Tag liefert vorher einen einschaltbaren Image-Schalter. | W3, W4a, W4, W8, W6, (W5) |
| **0.5.x danach** | Rollback eines Datenvolumes im Betrieb (C3), Fern-Rollback (C2). | W7b, W9 |
| **später** | Exchange mit Log-Kürzung und Postfach-Restore, AD-Einzelobjekte, Hyper-V-Host je VM, SQL ohne Staging (VDI), SQL-Snapshot-Sicherung ab 2022, Lesen nur geänderter Bereiche über das USN-Journal, Restore ohne Server für Images, Nachspielen der Hive-Logs in Go, MBR2GPT im WinPE. | W10 |

- **Aufwand, ehrlich:** W3 bis W8 kosten zusammen etwa 24 bis 35 PW, dazu je Gate-Runde auf
  echter Hardware 2 bis 3 PW (Beschaffung und Aufbau von DC-Paar, Exchange SE, Secured-core-
  und VMD-Laptop, RAID-Servern) und die Klärung der Lizenzfrage 12. Windows Bare Metal
  (Vorschau) kommt damit Monate nach 0.5.0, nicht mit ihm (Abschnitt 9).
- Das widerspricht drei bestehenden Festlegungen, die der Maintainer neu entscheiden muss
  (Abschnitt 11, Fragen 1 bis 3): BM 25.A1 ("Windows Bare Metal später, nicht in 0.5.0") wird
  eingehalten, aber "später" bekommt einen Plan; docs/AGENT.md "Keine Images, kein
  Bare-Metal-Restore" fällt für Windows mit W4; WA 2.2 ("Systemzustand und Registry nicht
  Teil") gilt nur noch für die Dateisicherung.

## 1. Ausgangslage

### 1.1 Was der Windows-Agent heute tut

Sicherung (Pfade relativ zu `agent/`):

- **Schattenkopie nur über restic.** `planSnapshot` (`internal/core/snapshot_windows.go:20-55`)
  fordert VSS an, wenn `useVss` gesetzt ist (`internal/api/types.go:177`) und der Prozess
  erhöhte Rechte hat (Zeile 26). Je Quelle bestimmt es das Volume (`GetVolumePathNameW`);
  Wechseldatenträger, optische Laufwerke, Netzlaufwerke, FAT, FAT32 und exFAT werden von vorn
  herein live gelesen (`vssExcludeReason`, `internal/core/snapshot.go:305-321`) und restic als
  `-o vss.exclude-volumes` übergeben. restic bekommt `--use-fs-snapshot -o vss.timeout=5m`
  (`internal/restic/backup.go:136-147`, Zeitgrenze `snapshot.go:26` "für SQL Server, Hyper-V,
  Exchange").
- **Ausschlüsse** auf jeder Windows-Sicherung: Groß-/Kleinschreibung egal,
  `--exclude-cloud-files`, der ganze Datenordner des Agenten
  (`platformBackupOptions`, `snapshot_windows.go:61-66`) und fest `pagefile.sys`,
  `hiberfil.sys`, `swapfile.sys`, `System Volume Information`, `$Recycle.Bin`
  (`snapshot.go:323-326`).
- **Fehlerpolitik** `snapshotOnFailure`: `continue` wiederholt ohne VSS, `fail` bricht restic
  mit `errSnapshotFailed` ab (`internal/core/backup.go:305`, `:323`, `:376`, `:400-409`).
  Bericht `consistency` mit `method`, `state` (`used`, `partial`, `unavailable`, `off`) und
  `liveFilesystems` (`internal/api/types.go:386-425`); `state = used` heißt nur "kein Volume
  ist gescheitert" (`consistencyOf`, `snapshot.go:188`), nicht "anwendungskonsistent".
- **Kein Ganzer Rechner unter Windows.** `newFSBackend` liefert unter Windows `nil`
  (`snapshot_windows.go:70`), damit ist `wholeMachineApplies` falsch
  (`internal/core/fsbackup.go:66-71`), und ein Job mit "Ganzer Rechner" sichert die Ordner mit
  der Logzeile "Whole machine (bare metal) is available for Linux in this version"
  (`fsbackup.go:83`).
- **Ein Lauf zur Zeit:** Jeder Lauf nimmt `lock.TryAcquire` auf `data\run.lock`
  (`internal/core/backup.go:39`, `run.go:322`, `agent.go:845`); ein zweiter Lauf startet nicht,
  solange einer läuft.
- **Datenordner:** `C:\ProgramData\Restow\{state,data,logs}` (`internal/paths/paths_windows.go:42-47`).
  Unter `state` liegen `state.json` (Geheimnisse) und `hooks.d` (Hook-Skripte,
  `paths.go:121`); die lokale Hook-Erlaubnis steht in `state.json` (`internal/hooks/policy.go:15`).
  Unter `data` liegen `cache`, `tmp`, `baremetal` und `outbox` (`paths.go:130`, `:133`, `:139`,
  `:149`). Ist `state.json` nicht lesbar, meldet `state.Load` "re-enroll"
  (`internal/state/state.go:95-97`).
- **Hooks** nur vor und nach dem ganzen Lauf (`internal/hooks/hooks.go:21-22`: 60 und
  30 Minuten; Aufruf `internal/core/backup.go:171-172`), nur `.ps1` oder `.exe`, nur bei
  lokaler Erlaubnis (WA 12.2). Es gibt keinen Zeitpunkt zwischen Freeze und Thaw.
- **Erkennung:** `internal/sysinfo/sysinfo_windows.go:5` ist ein Platzhalter
  (`func osVersion() string { return "Windows" }`). Produkttyp, Domänencontroller, SQL Server,
  Exchange, Hyper-V und BitLocker erkennt der Agent nicht, obwohl WA 2.2 die Erkennung des
  Domänencontrollers beschreibt.
- **Systemaufrufe:** `internal/winapi` lädt aus kernel32 genau die Funktionen in
  `kernel32_windows.go:14-30`, aus advapi32 Sicherheits-, Dienst- und Ereignisfunktionen
  (`advapi32_windows.go:11-34`); `DeviceIoControl` und die lesenden Registry-Funktionen bringt
  das Paket `syscall` selbst mit (1.4). Aus ole32 lädt `winapi` nur
  `CoTaskMemFree` (`crypt32_windows.go:16`, DLL `dll_windows.go:58`). WA 1.3 hält fest: "die
  Registry-Schreibfunktionen braucht der Agent nicht" (docs/WINDOWS-AGENT.md:146).
- **Privilegien des Dienstes** (`internal/svc/windows.go:30-34`): SeBackup, SeRestore,
  SeSecurity, SeTakeOwnership, SeCreateSymbolicLink, SeChangeNotify, SeImpersonate,
  SeCreateGlobal, SeManageVolume. Es fehlen SeShutdownPrivilege (Neustart, Startprobe) und
  SeSystemEnvironmentPrivilege (UEFI-Variablen lesen). Dienst-SID `NT SERVICE\RestowAgent`,
  Typ unrestricted (docs/WINDOWS-AGENT.md:658).

Wiederherstellung:

- `restic restore --json --target <ziel> --overwrite never --verify --retry-lock 15m`
  (`internal/restic/restore.go:37`).
- `prepareRestoreTarget` (`internal/core/util_windows.go:32-86`): nur fest eingebaute
  Laufwerke mit `FILE_PERSISTENT_ACLS`, Elternordner vertraut, nicht unter `%SystemRoot%`,
  `Program Files` oder dem Datenordner des Agenten (Zeile 53), Ziel neu oder leer, angelegt mit
  der geschützten DACL `D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)` (Zeile 57,
  `internal/paths/acl.go:346`). Standardziel `%SystemDrive%\Restow-Restore-<zeit>`
  (`defaultRestoreDir`, Zeile 20). Ein Restore an den Originalort oder über vorhandene Dateien
  gibt es nicht, also auch keinen Rollback.

Bausteine aus M1 bis M3 und der PVE-Integration, die dieser Entwurf weiterverwendet:

- Layout-Manifest, diskriminiert nach Plattform (BM 4.2), Tabelle `endpoint_layouts` mit
  CHECK `platform IN ('linux', 'darwin')` (`packages/db/drizzle/0076_baremetal_layouts.sql:19`).
- `agent/internal/baremetal`: `efi.go` (Load-Options, Signaturlisten), `pe.go`
  (Authenticode-Hash und Signaturgeber), `secureboot.go` mit `isMicrosoftLoader` (Zeile 70) und
  `CheckChain` (Zeile 93), `assess.go` mit der GUID der MSR-Partition (Zeile 384).
- `agent/internal/recovery` (`code.go`, `session.go`): Code, Origin-Bindung, Prüfwert,
  Vertrags-Client der Recovery-API einschließlich `Release`, `Finish`, `Rebind`; ohne
  Build-Tag, also auch unter Windows übersetzbar.
- Server-Seite von M3: Recovery-Sitzungen, Freigabe, `reader`-Route, Sperre gegen Prune
  (BM 9.7), Wiederanbindungs-Token (BM 11), Migrationen bis 0079
  (`0079_endpoint_recovery_log_key_block`). Der Server nimmt heute nur Linux-Layouts an:
  `apps/api/src/features/endpoints/baremetal.ts:124` und `:246` verwerfen jedes Manifest mit
  `platform != "linux"`.
- PVE-Blockpfad: 4-MiB-Blöcke (`agent/internal/pve/formats.go:25`), SHA-256 je Block,
  Null-Flag, Hochladen nur geänderter Blöcke gegen die Hashliste des Basisstands, serverseitig
  geprüft, zerlegt, verschlüsselt und gepackt im Chunk-Speicher des Mandanten
  (`packages/db/src/schema/backup.ts`: `packs`, `chunks`), Block-Map je Platte und
  Sicherungsstand (synthetischer Vollstand, `pve_snapshots`), Rücklesen von Stichproben,
  Node-API `PUT /runs/:id/blocks`, `GET /snapshots/:id/disks/:device/hashes|blocks`
  (docs/PVE-PROTOCOL.md). Das Paket ist heute `//go:build !windows`
  (`agent/internal/pve/backupvm.go:1`).
- Server-seitige Leser für Images ohne Einhängen: `packages/core/src/pve/guestfs` mit
  `partitions.ts`, `ntfs.ts`, `fat.ts` in einem Wegwerf-Kindprozess (docs/PVE.md,
  Dateiwiederherstellung aus VMs).
- Starttest der PVE-Integration (`agent/internal/pve/boottest.go:24-40`): wiederherstellen,
  isolieren, starten, auf Beweis warten.

Eine Windows-VM auf Proxmox VE ist schon heute als Image mit Starttest gesichert (PVE-
Integration). Dieser Entwurf betrifft physische Windows-Rechner und VMs auf anderen
Hypervisoren.

### 1.2 Geprüfte restic-Fakten (0.19.1) für Windows

| Fakt | Beleg |
| --- | --- |
| restic fordert `VSS_CTX_BACKUP` und `SetBackupState(false, false, VSS_BT_COPY, false)` an: Kopie-Sicherung, keine Komponentenauswahl. | `internal/fs/vss_windows.go:947`, `:954` |
| Weder `GatherWriterStatus` noch `AddComponent` noch `SetBackupSucceeded` kommen in `internal/fs` vor. Ein Writer, der beim Freeze scheitert, bleibt unbemerkt. | grep über `internal/fs` |
| Ein Snapshot-Satz **je Volume**, angelegt beim ersten Zugriff auf einen Pfad dieses Volumes, jeder mit eigenem `GatherWriterMetadata` und Freeze. | `internal/fs/fs_local_vss.go:157-205` |
| Scheitert ein Volume, liest restic es live und endet trotzdem mit 0; der Agent erkennt das an restics Texten. | `fs_local_vss.go:199-204`; Agent `internal/restic/snapshot.go` |
| `extendedStat` unter Windows füllt Name, Modus, Größe und Zeiten, aber keine Inode, kein Gerät und keine Linkanzahl: Hardlinks werden als getrennte Dateien gesichert und zurückgeschrieben. | `internal/fs/stat_windows.go:15-38`; `internal/restorer/restorer.go:395` |
| Namen mit `:` werden übergangen: keine Alternate Data Streams (auch nicht `WofCompressedData`, `Zone.Identifier`). | `internal/fs/node_windows.go:95-97` |
| `--stdin-from-command` speichert die Standardausgabe eines Befehls als eine Datei und verwirft den Snapshot, wenn der Befehl nicht mit 0 endet. | `cmd/restic/cmd_backup.go:131`; `doc/040_backup.rst` |

**[Quelle]** vor W7a zu belegen: ob `restore --delete` (C4) Ordner und Dateien auch
unter Windows mit `--overwrite always` zuverlässig entfernt, die im Snapshot fehlen, und wie
es sich mit Reparse-Points im Zielbaum verhält.

### 1.3 Was eine Dateisicherung unter Windows nicht zurückbringt

| Eigenschaft | Folge für ein Systemvolume |
| --- | --- |
| Hardlinks | `System32` und `WinSxS` (Komponentenspeicher) sind über Hardlinks verbunden **[Win]**. Getrennte Kopien brechen die Wartung (Updates, `DISM /ScanHealth`) **[Maschine]**. |
| Alternate Data Streams | WOF-komprimierte Dateien (CompactOS) kommen entpackt zurück und passen nicht mehr; Zone-Kennungen fehlen. |
| Kurznamen (8.3), Objekt-IDs, Reparse-Daten (Deduplizierung, App-Ausführungsaliase, Cloud-Platzhalter) | Pfade der Form `PROGRA~1` in der Registry ins Leere; neue Datei-IDs entwerten Suchindex und Synchronisationszustand. |
| Gesperrte Dateien des laufenden Systems | Ein Zurückschreiben in ein laufendes `C:\Windows` ist ohnehin unmöglich. |
| Restore unter Linux (ISO) | Die Attribute `windows.*` kennt restic unter Linux nicht: keine ACLs auf einem mit ntfs-3g geschriebenen NTFS. |

Daraus folgt die Kernentscheidung dieses Entwurfs: **Systemvolume, ESP und
Wiederherstellungspartition werden blockweise aus der Schattenkopie gesichert**, die
Dateisicherung bleibt für Ordner, einzelne Dateien und den Weg auf andere Systeme.

### 1.4 Was das Standardpaket `syscall` unter Windows bietet

Vorhanden (geprüft mit `GOOS=windows go doc syscall`; WA 1.3, docs/WINDOWS-AGENT.md:138ff,
sagt dasselbe): `NewLazyDLL`, `SyscallN` (beliebig viele Argumente, also auch COM-Methoden:
`obj->lpVtbl[n](obj, ...)`), `UTF16PtrFromString`, `Handle`, `CreateFile`, `ReadFile`,
`WriteFile`, `Seek`, `GetFileInformationByHandle`, **`DeviceIoControl`** und die lesenden
Registry-Funktionen **`RegOpenKeyEx`, `RegQueryValueEx`, `RegEnumKeyEx`, `RegQueryInfoKey`,
`RegCloseKey`**.

Über `NewProc` nachzuladen sind nur:

- kernel32: `FindFirstVolumeW`, `FindNextVolumeW`, `FindVolumeClose`,
  `GetVolumePathNamesForVolumeNameW`, `GetDiskFreeSpaceExW`, `GetFirmwareType`,
  `GetFirmwareEnvironmentVariableExW` (im WinPE zusätzlich `SetFirmwareEnvironmentVariableExW`),
  `VirtualAlloc`/`VirtualFree` (ausgerichtete Puffer, Abschnitt 3.4), `InitiateShutdownW` (nur
  C2, W9);
- advapi32: `RegEnumValueW`, `RegFlushKey` (beide nicht in `syscall`);
- ole32: `CoInitializeEx`, **`CoInitializeSecurity`**, `CoUninitialize`;
- VssApi.dll: `CreateVssBackupComponentsInternal`, `VssFreeSnapshotPropertiesInternal`;
- iphlpapi: `GetAdaptersAddresses`.

COM verlangt einen festen Thread: der Requester läuft mit `runtime.LockOSThread` im
Multithreaded Apartment. `CoInitializeSecurity` ruft restic vor jedem VSS-Aufruf auf
(`internal/fs/vss_windows.go:820`); ohne ihn scheitern VSS-Aufrufe mit Zugriffsfehlern
**[Win]**. Der Aufruf gilt **prozessweit und nur einmal je Prozess**. Das ist ein Grund, warum
der Requester als eigener Hilfsprozess läuft und nicht im Dienstprozess (Abschnitt 3.3).

## 2. Ziele, Nicht-Ziele, Begriffe

### 2.1 Ziele

| Bereich | Ziel | Meilenstein |
| --- | --- | --- |
| Quellsysteme | **geprüft:** Windows 11 24H2 und 25H2, Windows Server 2019, 2022, 2025 (mit Desktop und Core), amd64, physisch und als VM (Hyper-V Gen1/Gen2, Proxmox VE); **nicht geprüft, mit Warnung:** Windows 10 22H2 (Support seit Oktober 2025 beendet), Windows 11 23H2, Server 2016 (Support endet Januar 2027), VMware-Gäste (Frage 22) | W3 bis W9 |
| SQL-Versionen | SQL Server 2016 bis 2025 einschließlich Express; geprüft 2019 Standard, 2022 Express (CI und H5, H10) | W2a, W2b |
| Firmware und Tabelle | UEFI mit GPT (mit und ohne Secure Boot), Legacy-BIOS mit MBR (ältere Server); keine Umwandlung | W3 |
| Volumes im Image | NTFS auf Basisdatenträgern (System, Boot, Daten), ESP (FAT32, roh), MSR (nur Größe), Wiederherstellungspartition (NTFS), BitLocker-Volumes im entsperrten Zustand (als Klartext, Abschnitt 3.6) | W4 |
| Konsistenz | ein Snapshot-Satz über alle Image-Volumes, Writer-Komponenten gewählt, Writer-Zustand geprüft und berichtet; SQL Server, Exchange, AD (NTDS), Registry und Systemdateien anwendungskonsistent im Image | W3 |
| Bare Metal | auf gleiche, größere, andere Hardware (NVMe statt SATA und umgekehrt, auch mit fremden Speichertreibern) über das WinRE-Medium (B, zuerst); mit Inbox-Treibern auch über das ISO (A) | W8, W5 |
| Restore und Rollback | Restore an den Originalort; derselbe Rechner auf einen früheren Stand: vom Medium (C1), aus der Oberfläche (C2), Datenvolumes im Betrieb (C3), einzelne Ordner (C4); aus dem laufenden System umkehrbar durch eine Sicherung vorher | W7a, W8, W5, W7b, W9 |
| SQL Server | anwendungskonsistente native Sicherung jeder Datenbank, Einzel-DB-Restore (auch auf einem anderen Rechner über ein Restore-Skript), Prüfung mit `DBCC CHECKDB` aus dem Repository (W2a); Point-in-Time über Log-Sicherungen (W2b) | W2a, W2b |
| AD | Domänencontroller über das Image nicht autoritativ zurück, mit SYSVOL-Synchronisierung; Hinweise zum autoritativen Weg | W8, W5 |
| Grün ist Beweis | Stufe 1 auf dem Server für jedes Windows-Image, Startprobe im Labor für dieselben Fingerabdrücke, Vorabprüfung auf der Zielhardware, SQL-Prüfung je Datenbank | W4, W6, W8, W2a |

### 2.2 Nicht-Ziele (erste Ausbaustufe)

- **Änderung des Speicherstapels:** MBR nach GPT, BIOS nach UEFI, Zielplatte kleiner als das
  Ende der letzten Partition, 512-Byte-NTFS auf eine 4Kn-Platte (Abschnitt 4.1.4), Umbau von
  oder nach Storage Spaces oder dynamischen Datenträgern.
- **Storage Spaces, dynamische Datenträger (LDM), ReFS** als Image-Volumes. Datenvolumes darauf
  sichert der Agent weiter als Dateien (Warnung); ein Systemvolume darauf ist "nicht möglich"
  (Abschnitt 3.7).
- **Changed Block Tracking** über einen eigenen Filtertreiber. Jede Image-Sicherung liest alle
  belegten Cluster (Abschnitt 3.4); nur geänderte Blöcke gehen über die Leitung.
- **BitLocker-Wiederherstellungsschlüssel** speichert Restow nicht (keine neue Geheimnisklasse).
  Ein auf neue Hardware wiederhergestelltes Volume ist unverschlüsselt, bis der Admin BitLocker
  wieder einschaltet (Abschnitt 3.6).
- **An das TPM gebundene Identitäten** auf neuer Hardware: Windows Hello, Geräteschlüssel von
  Entra ID und Intune, BitLocker-TPM-Schutz. Sie müssen neu eingerichtet werden.
- **Fremde Speichertreiber im ISO-Weg (A):** Treiber, die Windows nicht mitbringt
  (herstellereigene RAID-Treiber, Intel VMD/RST `iaStorVD`/`iaStorAC`, VirtIO
  `viostor`/`vioscsi`, VMware `pvscsi`), gibt es nur über das WinRE-Medium (B). Auf aktuellen
  Business-Laptops mit VMD ist das eher die Regel als die Ausnahme (4.1.5).
- **Klonen** (ein Image auf viele Rechner, neue SID, Sysprep) und Bereitstellung.
- **Wiederherstellung ohne Restow-Server** für Images (BM 25.A7 gilt; für Dateien bleibt
  `restow-restore`). Kandidat für später (Abschnitt 11, Frage 14).
- **VSS-Wiederherstellung über Writer** (PreRestore, PostRestore). SQL-Point-in-Time geht über
  native Sicherungen (Abschnitt 5.1), nicht über den SQL-Writer.
- In der ersten Ausbaustufe nicht: Exchange-Log-Kürzung und Postfach-Restore,
  AD-Einzelobjekte, autoritativer AD-Restore als Automatik, Hyper-V-Host je VM, SQL-Failover-
  Cluster-Instanzen, Automatisierung von Verfügbarkeitsgruppen, Windows on ARM, 32-Bit.
- Windows 8.1, Server 2012 R2 und älter (restic 0.18+ verlangt Windows 10 bzw. Server 2016,
  WA 2.1).

### 2.3 Begriffe

- **Image-Sicherung**: der Teil eines Ganz-Rechner-Laufs unter Windows, der Volumes blockweise
  aus **einem** Snapshot-Satz liest. Ergebnis ist ein **Image-Stand** (Tabelle
  `endpoint_images`, Abschnitt 6.4) mit einer Block-Map je Volume.
- **Snapshot-Satz**: alle Schattenkopien, die der eigene Requester mit einem `DoSnapshotSet`
  anlegt; ein Zeitpunkt für alle Volumes.
- **Belegt-Maske**: die Cluster-Bitmap eines Volumes zum Snapshot-Zeitpunkt, abgelegt am
  Image-Stand. Nur Blöcke mit mindestens einem belegten Cluster werden gelesen und geschrieben.
- **Geschwärzt**: Bereiche, die im Datenstrom als Nullen stehen, obwohl NTFS sie als belegt
  führt (`state.json`, Auslagerungsdateien, Abschnitt 3.4).
- **Slot-Datei**: nicht residente Datei fester Größe unter `state\`, im Image geschwärzt, deren
  Sektoren die Wiederherstellung roh beschreibt (Wiederanbindungs-Token, Probe-Nonce, 4.1.8).
- **Gruppe**: die Volumes eines Stands, die zusammen zurück müssen, weil Komponenten einer
  Anwendung über sie verteilt sind (4.3).
- **Kit**: das WinPE, das der Agent aus der WinRE des Rechners baut (Abschnitt 4.2), mit
  `restow-agent.exe`, Treibern und nicht geheimer Konfiguration.
- **Rollback**: Wiederherstellung desselben Rechners auf seine eigene Platte mit derselben
  Identität; schreibt nur Blöcke, deren maskierter Inhalt sich unterscheidet.
- **Prüfname**: der temporäre Name einer SQL-Datenbank für die Prüfung,
  `<db>__restow_verify_<zeit>`.

## 3. Sicherung: Volume-Images aus VSS

### 3.1 Job-Einstellung und Umfang

- `wholeMachine` (BM 5.1) gilt nun auch für Windows-Mitglieder eines Jobs.
  `packages/core/src/backup-jobs/endpoint-config.ts` schreibt es in deren Konfiguration;
  `GET /agent/v1/config` liefert dazu `image: { volumes: "all" | [<volumeKey>...],
  filesOnly: [<volumeKey>...], ioPriority: "low" | "normal", vssBackupType: "copy" }`.
  Vorgabe: alle unterstützten Volumes, niedrige E/A-Priorität, Kopie-Sicherung.
- Die Ordner des Jobs (`paths`) bleiben unverändert und werden **im selben Lauf** wie heute
  mit restic gesichert (Abschnitt 3.8). Unter Windows ersetzt "Ganzer Rechner" die Ordner also
  nicht, es kommt das Image dazu.
- Ein älterer Agent kennt `image` nicht und sichert weiter seine Ordner; die Oberfläche zeigt
  "Agent zu alt für Ganzer Rechner (Windows)".
- Solange W6 (Startprobe) nicht fertig ist, steht der Schalter für Windows hinter
  `RESTOW_BAREMETAL_WINDOWS_PREVIEW` (Standard aus), wie Linux hinter
  `RESTOW_BAREMETAL_PREVIEW` (BM 5.1, 22). Kein Tag liefert einen einschaltbaren
  Image-Schalter, bevor ein Wiederherstellungsweg (W8 oder W5) gemergt ist (Abschnitt 9).
- Rechner, die schon über die PVE-Integration als VM gesichert werden (Abgleich über die
  SMBIOS-UUID, docs/PVE-PROTOCOL.md `smbiosUuid`), bekommen den Hinweis "wird als VM gesichert
  und starttestet; ein Image im Agenten ist doppelt".

### 3.2 Layout-Manifest `windows`

Neue Plattform im Manifest aus M1: `platform: "windows"`, `format: "restow-layout-v1"`,
`schemaVersion: 2` (BM 4.2: neue Plattform = neue Felder; ein älterer Leser lehnt mit "Dieses
Recovery-ISO ist zu alt für diese Sicherung" ab). Go: `Manifest.Windows *WindowsLayout`
(`agent/internal/baremetal/manifest.go`), `Validate` verlangt genau eine der drei Plattformen.
TS: `windowsLayoutSchema` in `layoutManifestSchema`
(`packages/core/src/endpoints/baremetal/manifest.ts`). Gemeinsame Testdaten
`agent/internal/baremetal/testdata/manifests/windows-*.json`, gleiche Regeln (kanonische
Kodierung, keine Steuerzeichen, höchstens 512 KiB, Fingerabdruck in beiden Sprachen gleich).

Erfassung (`agent/internal/baremetal/capture_windows.go`, `//go:build windows`), je Sammler eine
Funktion und ein Test gegen aufgezeichnete Ausgaben echter Systeme
(`testdata/capture/windows-<system>/`):

| Funktion | Quelle | Was |
| --- | --- | --- |
| `captureDisks` | `IOCTL_DISK_GET_DRIVE_GEOMETRY_EX`, `IOCTL_STORAGE_QUERY_PROPERTY` (`StorageDeviceProperty`, `StorageAccessAlignmentProperty`) auf `\\.\PhysicalDriveN` | Nummer, Größe in Bytes, logische und physische Sektorgröße, Bus (`NVMe`, `SATA`, `SAS`, `RAID`, `Spaces`, `Virtual`, `USB`, `iSCSI`), Modell, Seriennummer, Wechseldatenträger |
| `capturePartitions` | `IOCTL_DISK_GET_DRIVE_LAYOUT_EX` | Stil (GPT/MBR/RAW), GPT-Disk-GUID bzw. MBR-Signatur; je Partition Nummer, `startBytes`, `sizeBytes`, Typ-GUID bzw. Typ-Byte, `PartitionId`, GPT-Attribute, Name, Aktiv-Flag (MBR) |
| `captureVolumes` | `FindFirstVolumeW`, `GetVolumePathNamesForVolumeNameW`, `GetVolumeInformationW`, `IOCTL_VOLUME_GET_VOLUME_DISK_EXTENTS`, `FSCTL_GET_NTFS_VOLUME_DATA` | Volume-GUID-Pfad, Buchstaben und Einhängeordner, Dateisystem, Label, Seriennummer, Clustergröße, Bytes je Sektor laut NTFS, Gesamtcluster, belegte Bytes, Extents (mehr als einer: Abschnitt 3.7), Rolle (`system`, `boot`, `esp`, `msr`, `recovery`, `data`, `pagefile`) |
| `captureBitLocker` | `manage-bde -status <vol>` ist lokalisiert und darum **nicht** die Quelle; statt dessen das FVE-Kennzeichen `-FVE-FS-` im rohen Bootsektor der Partition und WMI `Win32_EncryptableVolume` über `powershell.exe -NoProfile -Command` mit fester, eingebetteter Abfrage und JSON-Ausgabe (`GetProtectionStatus`, `GetConversionStatus`, `GetEncryptionMethod`, Arten der Schlüsselschutzvorrichtungen) | je Volume `bitlocker: { encrypted, protection, conversion, method, protectorTypes, metadataOffsets, version }` (Offsets der drei FVE-Metadatenbereiche aus dem rohen FVE-Bootsektor, Abschnitt 3.6); **nie** Schlüssel, Wiederherstellungskennwörter oder deren IDs |
| `captureFirmware` | `GetFirmwareType`; `GetFirmwareEnvironmentVariableExW` aus derselben Positivliste wie BM 4.1 (`Boot####`, `BootOrder`, `BootCurrent`, `SecureBoot`, `SetupMode`, `db`, `dbx` nur SHA-256 und Subjekte, dazu die Variable des VBS-Anti-Rollback aus KB5042562); `HKLM\SYSTEM\CurrentControlSet\Control\SecureBoot\State` und `…\SecureBoot\AvailableUpdates` | Modus, Secure Boot, Einträge (über `ParseLoadOption`, `efi.go`), Zertifikate in `db` (Windows Production PCA 2011, Windows UEFI CA 2023, UEFI CA 2011/2023 für Dritte), Anti-Rollback an/aus, Stand der Secure-Boot-Aktualisierung |
| `captureLoaders` | ESP aus dem eigenen Lesestrom (Abschnitt 3.4) mit einem kleinen FAT-Leser in Go (`baremetal/fat.go`, nur lesen) | `\EFI\Microsoft\Boot\bootmgfw.efi`, `\EFI\Boot\bootx64.efi` über `InspectLoader` (`pe.go`): Größe, Authenticode-SHA-256, Signaturgeber; ob `C:\Windows\Boot\EFI_EX` (mit CA 2023 signierte Bootdateien) vorhanden ist |
| `captureBCD` | `HKLM\BCD00000000\Objects\*\Elements\*` (der Systemspeicher der BCD ist im laufenden System als Registry-Hive eingehängt), nur lesen | `{bootmgr}` und Standardeintrag: Gerät und Betriebssystemgerät als Rohwert und daraus gelesene Partitions- und Disk-GUIDs bzw. MBR-Signatur und Offset; `devicesMatchLayout` (Abgleich mit `capturePartitions`) **[Maschine]**: das Format der Geräteelemente ist nicht vollständig dokumentiert |
| `captureWinRE` | `C:\Windows\System32\Recovery\ReAgent.xml` (XML, nicht lokalisiert; `reagentc /info` ist lokalisiert) | aktiviert ja/nein, `WinreLocation` (Pfad, GUID, Offset), Ort von `Winre.wim` |
| `captureBootDrivers` | `HKLM\SYSTEM\Select\Current`, `…\ControlSet00N\Services\{storahci,stornvme,…}` (`Start`, `StartOverride`), `…\Enum\PCI\*` (`Service` je Controller), Speicher-INFs in `C:\Windows\INF` und `DriverStore\FileRepository` (Klasse `SCSIAdapter` und `HDC`, Hardware-IDs bis 256 je INF) | je Controller des Rechners PCI-ID und Dienst; je Speichertreiber Dienst, Start, StartOverride, inbox ja/nein, Hardware- und Kompatibilitäts-IDs; Intel VMD/RST bzw. SATA im RAID-Modus erkannt; ob die Vorbereitung auf andere Hardware gesetzt ist (4.1.5). Ob die Hives sauber sind, misst der Agent im Snapshot (3.4 Punkt 8), nicht hier |
| `captureOS` | `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion` (`ProductName`, `EditionID`, `InstallationType`, `CurrentBuild`, `UBR`, `DisplayVersion`), `HKLM\SYSTEM\CurrentControlSet\Control\ProductOptions\ProductType` (`WinNT`, `ServerNT`, `LanmanNT`) | Version, Build, Edition, Core oder Desktop, Rolle; ersetzt den Platzhalter in `sysinfo_windows.go` |
| `captureDomain` | `HKLM\SYSTEM\CurrentControlSet\Services\Tcpip\Parameters` (`Domain`), Netlogon-Parameter (`MaximumPasswordAge`, `DisablePasswordChange`), bei `LanmanNT` `NTDS\Parameters` (Pfade der Datenbank und der Logs), Rollenerkennung DFSR | Mitglied ja/nein, Domäne, DC ja/nein, Orte von `ntds.dit`, Logs und SYSVOL; `tombstoneLifetime` (5.3); Windows LAPS konfiguriert ja/nein (4.1.7) |
| `captureApps` | Registry: `HKLM\SOFTWARE\Microsoft\Microsoft SQL Server\Instance Names\SQL`, Dienste `MSExchangeIS`, `vmms`, `NTDS`, `DFSR` | Liste der SQL-Instanzen (Name, Version, Edition, Dienstkonto), Exchange, Hyper-V-Host, AD DS |
| `captureNetwork` | `GetAdaptersAddresses` (iphlpapi, neu), `HKLM\SYSTEM\CurrentControlSet\Services\Tcpip\Parameters\Interfaces\{GUID}` | je Adapter Name, MAC, Schnittstellen-GUID, Dienst des Treibers, DHCP oder statisch mit Adressen, Gateway, DNS (für das Wiederherstellen fester Adressen auf neuer Hardware, Abschnitt 4.1.7) |
| `captureShadowStorage` | `GetDiskFreeSpaceExW` je Image-Volume. Nicht `vssadmin list shadowstorage` (lokalisierte Ausgabe) und in der ersten Stufe nicht `IVssDifferentialSoftwareSnapshotMgmt` (weitere COM-Schnittstelle, Vorschlag) | Warnung `vss_low_space`, wenn ein Image-Volume weniger als 10 % oder 2 GiB frei hat |

Regeln zusätzlich zu BM 4.2:

- Verweise laufen über `BlockRef` mit den neuen Arten `winPartition` (Platte, Nummer) und
  `winVolume` (Volume-ID im Manifest); keine Laufwerksbuchstaben als Schlüssel (sie sind nur
  Anzeige und Teil der Prüfung).
- Größen in Bytes; Sektorgröße der Quellplatte steht dabei (BM 4.2).
- Geheimnisse stehen nie im Manifest: keine BitLocker-Schlüssel oder deren IDs, keine Inhalte
  von `HKLM\SECURITY` oder `SAM`, keine LSA-Geheimnisse, keine Kennwörter von Dienstkonten
  (nur Name und SID). Seriennummern, MAC- und IP-Adressen stehen darin, wie unter Linux.
- Ablage wie BM 4.3: vor dem Snapshot schreibt der Agent `layout.json` und `raw/`
  (bereinigte Rohausgaben, z. B. `drive-layout-<n>.json`, `bcd-elements.json`,
  `reagent.xml`, bei MBR `mbr-<n>.bin` und `ebr-<n>-<k>.bin`) nach
  `C:\ProgramData\Restow\data\baremetal\` (`paths.go:139`); sie liegen damit im Image. Dazu kommt
  das Manifest im Abschluss des Laufs (`layout`), dedupliziert in `endpoint_layouts`.
- **Bewertung** (`Assess`, `assess_windows.go`, ohne Build-Tag): `unsupported` für ein
  System- oder Bootvolume auf dynamischem Datenträger, Storage Spaces oder ReFS
  (`win_system_volume_unsupported`), ein Systemvolume über mehrere Extents
  (`win_spanned_volume`), einen gesperrten oder mitten in der Umwandlung befindlichen
  BitLocker-Systemvolume (`bitlocker_locked`, `bitlocker_converting`, gilt für diesen Lauf),
  Windows älter als 10/Server 2016 (`windows_too_old`), arm64 (`arch_unsupported`).
  `supported_with_warnings` für Datenvolumes auf Spaces, LDM oder ReFS (`win_files_only`, sie
  kommen nur als Dateien zurück), BitLocker an (`bitlocker_plaintext_image`, Abschnitt 3.6),
  Domänencontroller (`domain_controller`, Abschnitt 5.3), Exchange (`exchange_no_log_truncation`),
  Hyper-V-Host (`hyperv_host_vm_files`, Abschnitt 5.4), BIOS-Start (`bios_needs_csm`, BM 4.4),
  ein nicht inbox-Speichertreiber für die Bootplatte (`boot_driver_not_inbox`, Text je
  verfügbarem Weg: mit B "auf andere Hardware nur mit dem WinRE-Medium", ohne B "auf anderer
  Hardware nicht möglich; Ersatzrechner mit AHCI oder NVMe bzw. VMD/RST im Firmware-Setup
  abschalten", Abschnitt 4), wenig Platz für Schattenkopien (`vss_low_space`), feste
  IP-Adressen (`static_ip`), Exchange in einer DAG (`exchange_dag_member`), VBS-Anti-Rollback
  (`vbs_rollback_protection`), UEFI mit MBR-Systemplatte (4.1.3). `hive_dirty` und
  `ntfs_unclean` sind Fakten des Image-Stands (3.4 Punkt 8), keine Erfassung vor dem Snapshot.
- **Fingerabdrücke** (BM 12.4, je Plattform): `layoutFingerprint` (Windows) über Platten,
  Tabellenstil, Partitionen mit Typ, Größe und GUID, Volumes mit Dateisystem, Seriennummer und
  Rolle, Firmwaremodus, BitLocker an/aus; `bootChainFingerprint` (Windows) über
  Authenticode-Hash und Signaturgeber von `bootmgfw.efi` und `winload.efi`, die Geräteelemente
  der BCD, `Start`/`StartOverride` der Speichertreiber, `CurrentBuild.UBR`. Ein kumulatives
  Update ändert `bootChainFingerprint` und löst damit eine neue Startprobe aus (Abschnitt 4.4).

### 3.3 Eigener VSS-Requester (`agent/internal/vss`, Hilfsprozess `vss-hold`)

Aufteilung:

| Datei | Build-Tag | Inhalt |
| --- | --- | --- |
| `requester_windows.go` | windows | COM über `syscall.SyscallN`: `CoInitializeEx`, `CoInitializeSecurity`, `CreateVssBackupComponentsInternal`, `InitializeForBackup`, `SetContext(VSS_CTX_BACKUP)`, `SetBackupState(selectComponents, bootableSystemState, backupType, partialFileSupport=false)`, `DisableWriterClasses`, `GatherWriterMetadata` (mit Warten auf `IVssAsync`), `GetWriterMetadataCount`/`GetWriterMetadata`, `IVssExamineWriterMetadata::SaveAsXML`, `AddComponent`, `StartSnapshotSet`, `AddToSnapshotSet` je Volume, `PrepareForBackup`, `DoSnapshotSet`, `GatherWriterStatus`/`GetWriterStatusCount`/`GetWriterStatus` (Zustand, `hrWriterFailure`, Text des Writers), `GetSnapshotProperties`, `SetBackupSucceeded`, `BackupComplete`, `SaveAsXML` (Sicherungsdokument), `Release` |
| `hold_windows.go` | windows | Hilfsprozess `restow-agent vss-hold`: Eingabe und Ausgabe als JSON-Zeilen über stdin/stdout, hält den Satz bis zum Befehl `release` oder bis stdin schließt |
| `metadata.go` | keins | Zerlegen des Writer-XML (`encoding/xml`): Writer-ID, Klasse, Name, Komponenten mit logischem Pfad, auswählbar ja/nein, Systemzustand ja/nein, Dateilisten (Pfad, Muster, rekursiv), Datenbank- und Log-Dateien |
| `select.go` | keins | Auswahl der Komponenten (unten), rein und getestet |
| `expect.go` | keins | erwartete Writer aus `captureApps` gegen die gemeldeten (unten, Schritt 3) |
| `status.go` | keins | Abbildung der Writer-Zustände (`VSS_WS_STABLE`, `VSS_WS_FAILED_AT_FREEZE`, …) und HRESULTs auf Codes und Text |
| `testdata/` | | Writer-XML und Sicherungsdokumente echter Systeme (Client, Server mit SQL, DC, Exchange, Hyper-V-Host), anonymisiert |

Ablauf eines Snapshot-Satzes:

1. **Hilfsprozess** (Vorschlag, Frage 8, jetzt Vorgabe): Der Dienst startet
   `restow-agent vss-hold` als Kindprozess (dieselbe Binary, Argumentliste, in einem Job-Objekt
   mit `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, damit das Kind mit dem Dienst endet). Er ruft
   einmal `CoInitializeEx` (MTA) und `CoInitializeSecurity` (Werte wie restic
   `vss_windows.go:820`, **[Quelle]**) auf einem festen Thread. Gründe: Eine Zugriffsverletzung
   in COM-Code unter `SyscallN` beendet den ganzen Go-Prozess; im Dienstprozess wäre "darf den
   Dienst nicht beenden" nicht erreichbar. `CoInitializeSecurity` gilt prozessweit (1.4).
   Stürzt das Kind ab, scheitert der Image-Teil mit `vss_helper_crashed`, der Dienst lebt
   weiter. Hängt ein Aufruf über seine Zeitgrenze (`GatherWriterMetadata` 5 Minuten wie heute
   `vss.timeout`, `PrepareForBackup` und `DoSnapshotSet` je 10 Minuten), beendet der Dienst das
   Kind über das Job-Objekt und meldet `vss_hung`; VSS löscht die nicht persistenten
   Schattenkopien eines beendeten Requesters selbst **[Win]**. Kosten: eine Prozessgrenze, über
   die nur Gerätepfade, IDs und Zustände gehen; die Geräte öffnet der Dienst selbst.
2. **Writer ausschließen:** vor `GatherWriterMetadata` `DisableWriterClasses` mit der
   Klassen-ID des Hyper-V-Writers (er würde je VM Prüfpunkte auslösen; Abschnitt 5.4)
   **[Win]**. Ein Writer wird nie durch bloßes Weglassen seiner Komponenten ausgeschlossen:
   Ein beteiligter Writer friert trotzdem ein.
3. **Fehlende Writer:** `expect.go` gleicht die Anwendungen aus `captureApps` mit den gemeldeten
   Writern ab: SQL-Instanz mit laufendem Dienst → `SqlServerWriter`, NTDS → `NTDS`,
   Exchange-Informationsspeicher → `Microsoft Exchange Writer`, DFSR → `DFS Replication service
   writer`. Fehlt ein erwarteter Writer (häufig: Dienst "SQL Server VSS Writer" beendet oder
   deaktiviert **[Win]**), meldet `GatherWriterStatus` dazu nichts, und die Anwendung wäre im
   Image still nur absturzkonsistent. Darum: Code `vss_writer_missing` mit Name und Schritt
   ("Dienst SQL Server VSS Writer starten und auf automatisch stellen"), der Image-Stand trägt
   "für <Anwendung> nur absturzkonsistent", WL8 warnt; Politik `snapshotOnFailure = fail`
   verwirft das Image.
4. **Komponentenauswahl** (`select.go`): Komponentenmodus `SetBackupState(true, true,
   VSS_BT_COPY, false)`. Regeln:
   - Von jedem beteiligten Writer kommen **alle nicht auswählbaren Komponenten der obersten
     Ebene** mit `AddComponent` in die Sicherung. Sie sind Pflicht; fehlen sie, scheitert
     `PrepareForBackup` oder die Sicherung ist unvollständig **[Win]**.
   - Mit `bootableSystemState = true` sind alle Komponenten des Systemzustands Pflicht (System
     Writer, Registry Writer, COM+ REGDB Writer, WMI Writer, auf DCs NTDS; Kennzeichen im XML).
     Liegt eine ihrer Dateien auf einem Volume ohne Image, ist der Stand für Bare Metal
     ungültig (`win_system_state_incomplete`, Problem).
   - Dazu jede auswählbare Komponente, deren Dateien vollständig auf Volumes des Satzes
     liegen. Liegt eine auswählbare Komponente teilweise außerhalb, wird sie nicht gewählt und
     im Bericht genannt ("SQL-Datenbank X liegt teilweise auf einem Volume ohne Image").
   - Liegen Dateien einer Pflichtkomponente auf einem Volume, das sonst nur als Dateien
     gesichert würde, kommt dieses Volume in den Satz (nicht ins Image).
   - `VSS_BT_FULL` gibt es nur als ausdrückliche Einstellung je Rechner (später, für Exchange,
     Abschnitt 5.2), weil sie die Differenzbasis von SQL Server zurücksetzt **[Win]**.
5. Volumes: alle Image-Volumes mit NTFS über ihren Volume-GUID-Pfad (`\\?\Volume{…}\`), auch
   ohne Laufwerksbuchstaben, nach `IsVolumeSupported`. Nicht in den Satz: ESP (FAT32, VSS
   kann es nicht), MSR (kein Dateisystem). Kann VSS die Wiederherstellungspartition nicht
   aufnehmen (zu wenig Platz für die Differenzdaten auf dem kleinen Volume,
   `VSS_E_INSUFFICIENT_STORAGE`) **[Maschine]**, wird sie roh gelesen (Abschnitt 3.4, Punkt 9).
6. Nach `DoSnapshotSet`: `GatherWriterStatus`. Jeder Writer mit Zustand außer `STABLE` oder
   mit Fehler kommt mit Zustand, `hrWriterFailure` und Text in den Bericht (`writers[]`,
   Abschnitt 6.2). Politik `snapshotOnFailure`: `continue` → Image bleibt,
   `consistency.state = partial`, die betroffenen Writer sind genannt und der Image-Stand trägt
   "für <Writer> absturzkonsistent"; `fail` → Image verworfen, Lauf `failed`.
7. Lebensdauer: Die Schattenkopien eines nicht persistenten Kontexts leben, solange der
   Requester sie hält **[Win]**, hier also der Hilfsprozess. Es bleiben keine Reste wie bei
   LVM (BM 6.5), ein Aufräumen beim Start ist nicht nötig.
8. Abschluss nach dem Commit des Image-Stands beim Server: `SetBackupSucceeded` je gewählter
   Komponente, `BackupComplete`, dann **erneut `GatherWriterStatus`** (manche Writer melden
   Fehler erst im Abschluss **[Win]**; sie stehen als Warnung am Stand), `SaveAsXML`, `Release`.
   Scheitert der Commit, meldet der Agent `SetBackupSucceeded(false)`. Das Sicherungsdokument
   (`SaveAsXML`) liegt bereinigt am Image-Stand; es ist die Grundlage der Gruppenprüfung, wenn
   ein Bediener Volumes eines Stands abwählt (Abschnitt 4.3), und einer späteren
   VSS-Wiederherstellung (Abschnitt 2.2).
9. **Lieferung:** In W3 läuft der Requester nur in den CI-Tests und auf ausdrücklich gewählten
   Laborrechnern. Auf Kundenrechnern läuft er erst mit W4, wenn er ein Image liefert; ein
   Freeze ohne Image würde die Writer von SQL Server und Exchange ohne Nutzen anhalten.
   Ausgeliefert werden in W3 Erfassung, Manifest, `Assess` und Warnungen.

Die Dateisicherung nutzt diesen Requester in der ersten Ausbaustufe **nicht**: restic legt für
die Ordner weiter seine eigene Schattenkopie an (Abschnitt 3.8).

### 3.4 Lesen der belegten Cluster (`agent/internal/winimage`)

Je Volume des Satzes:

1. **Öffnen:** Gerät der Schattenkopie aus `GetSnapshotProperties().m_pwszSnapshotDeviceObject`
   (`\\?\GLOBALROOT\Device\HarddiskVolumeShadowCopyN`, vom Hilfsprozess gemeldet) mit
   `CreateFileW(GENERIC_READ, FILE_SHARE_READ|FILE_SHARE_WRITE, FILE_FLAG_NO_BUFFERING)`
   öffnen, dann `FSCTL_ALLOW_EXTENDED_DASD_IO` (sonst ist der Bereich hinter dem Dateisystem
   nicht lesbar, Punkt 3). `FILE_FLAG_NO_BUFFERING` verlangt sektorausgerichtete Offsets,
   Längen **und Pufferadressen**; Go-Slices sind das nicht von selbst. Puffer darum über
   `VirtualAlloc` (seitenausgerichtet) oder als überlanger Go-Puffer mit ausgerichtetem
   Teilstück; ein Test prüft die Ausrichtung. Puffer von 4 MiB. E/A-Priorität niedrig über
   `SetFileInformationByHandle(FileIoPriorityHintInfo)` (in `winapi` vorhanden,
   `kernel32_windows.go:25`).
2. Größe über `IOCTL_DISK_GET_LENGTH_INFO`, Clustergröße und `TotalClusters` über
   `FSCTL_GET_NTFS_VOLUME_DATA`, Belegung über `FSCTL_GET_VOLUME_BITMAP` (in Stücken) **[CI]**:
   dass alle drei auf dem Gerät der Schattenkopie gehen und den Stand des Snapshots liefern
   (VHDX auf dem Windows-Runner, Abschnitt 8.2).
3. **Bereich hinter dem letzten Cluster:** NTFS legt eine Kopie des Bootsektors in den letzten
   Sektor des Volumes, hinter `TotalClusters` und damit außerhalb der Bitmap **[Win]**. Nach der
   Belegt-Maske allein würde er nie geschrieben; ein Volume ohne Backup-Bootsektor meldet
   `chkdsk` als beschädigt. Darum wird der Bereich von `TotalClusters × Clustergröße` bis zum
   Volume-Ende **immer** gelesen, gesichert und zurückgeschrieben (in der Maske "immer belegt").
   Lässt sich der letzte Sektor auf dem Gerät der Schattenkopie trotz
   `FSCTL_ALLOW_EXTENDED_DASD_IO` nicht lesen **[CI]**, schreibt die Wiederherstellung dort den
   primären Bootsektor aus dem Image (beide sind gleich **[Win]**), und der Bericht sagt das.
   WL4 prüft, dass der Bereich im Image steht.
4. **Defekte Cluster:** `$BadClus:$Bad` führt nicht lesbare Cluster als belegt. Auf einer HDD
   mit defekten Sektoren würde sonst jedes Image scheitern. Der Agent liest die Runs dieses
   Streams (`FSCTL_GET_RETRIEVAL_POINTERS` auf `\$BadClus:$Bad` in der Schattenkopie **[CI]**)
   und maskiert sie: Nullen im Datenstrom, Warnung `bad_clusters_masked` mit Anzahl. Ein
   Lesefehler auf einem anderen belegten Cluster wird einmal sektorweise wiederholt; bleibt er,
   wird der Sektor genullt, der Stand trägt `read_errors` mit den Offsets, und die Oberfläche
   meldet die Platte als verdächtig. Über 1 % unlesbarer belegter Sektoren eines Volumes wird
   das Image verworfen (`image_read_errors`).
5. **Schwärzung:** für jede Datei der Liste `FSCTL_GET_RETRIEVAL_POINTERS` auf die Datei **in
   der Schattenkopie** und die Extents in eine Null-Maske. Die Pfade folgen dem echten Layout
   `C:\ProgramData\Restow\{state,data,logs}` (`paths_windows.go:42-47`, `paths.go`):
   - `state\state.json`, `state\.state-*.tmp` (`state.Save` schreibt über eine Temp-Datei,
     `createTemp`), `state\rebind.slot`, `state\probe.slot` (Slot-Dateien, 4.1.8);
   - `data\cache\*` (restic-Cache), `data\tmp\*` (Stichproben-Restores), `data\outbox\*`
     (nicht zugestellte Berichte, sonst würden sie nach der Wiederherstellung erneut gesendet),
     `data\staging\*` (SQL-Staging, Abschnitt 5.1.3);
   - `\pagefile.sys`, `\swapfile.sys`, `\hiberfil.sys`, `\Windows\MEMORY.DMP`,
     `\Windows\Minidump\*`, `\Windows\LiveKernelReports\*`.

   **Nicht** geschwärzt: `state\hooks.d` (die Hook-Skripte, `paths.go:121`) und die neue Datei
   `state\local-policy.json` mit den lokalen Erlaubnissen für Hooks und Rollback (heute stehen
   sie in `state.json`, `hooks/policy.go:15`; W4 zieht sie in diese Datei ohne Geheimnisse um,
   Abschnitt 6.1). Beide müssen nach einer Wiederherstellung unverändert da sein. Geschwärzte
   Bereiche bleiben in der Belegt-Maske (NTFS führt sie als belegt) und werden als Nullen
   zurückgeschrieben, also nie als alter Inhalt der Zielplatte gelesen. Eine Datei, die NTFS
   **resident** im MFT-Eintrag hält (kleiner als etwa 700 Byte), hat keine Extents: Der Agent
   schreibt `state.json` und seine Temp-Datei darum ab W4 immer mit mindestens 4 KiB
   (aufgefüllt), die Slot-Dateien mit 64 KiB. Kleine Dateien der Outbox können resident sein;
   der wiederhergestellte Agent verwirft die Outbox darum zusätzlich (4.1.7). Stufe 1 prüft die
   Schwärzung im fertigen Image (WL7).
6. **Blockstrom**: Blöcke zu 4 MiB ab Volume-Anfang (wie `BlockSize`). Ein Block ohne belegten
   Cluster wird nicht gelesen und ist ein Null-Block (Flag, kein Speicher). Ein Block mit
   mindestens einem belegten Cluster wird gelesen; freie Cluster und geschwärzte Bereiche darin
   werden genullt; der Hash ist SHA-256 des maskierten Blocks. Nur Blöcke, deren Hash sich gegen
   die Hashliste des Basisstands (`GET …/hashes`) geändert hat, gehen zum Server.
   **Wichtig:** Ein Block, der zwar nur Nullen enthält, aber belegte Cluster hat (eine Datei aus
   Nullen ohne Sparse-Attribut), ist kein Null-Block im Sinn "nicht schreiben": Die Belegt-Maske
   entscheidet, nicht der Inhalt. Der Server bekommt die Maske als eigene Datei am Image-Stand
   (komprimiert, ein Bit je Cluster, dazu der Bereich aus Punkt 3).
7. Fehler beim Lesen des Geräts der Schattenkopie mitten in der Sicherung bedeuten meist, dass
   VSS die Kopie verworfen hat (Differenzbereich voll) **[Win]**: Der Image-Stand wird nicht
   abgeschlossen (`image_shadow_lost`, Hinweis "Speicherplatz für Schattenkopien vergrößern"),
   die Dateisicherung läuft weiter. Ein unvollständiges Image ist nie ein Stand.
8. **Fakten des Image-Stands aus dem Snapshot:** Was nur im Snapshot zählt, wird dort gemessen
   und am Image-Stand gemeldet (`facts`), nicht im Manifest, das vor dem Snapshot entsteht:
   ob die Hives `SYSTEM` und `SOFTWARE` sauber sind (Sequenznummern im Basisblock, gelesen aus
   der Schattenkopie; Code `hive_dirty`), ob das NTFS des Systemvolumes sauber ist (Dirty-Bit,
   Zustand von `$LogFile`; Code `ntfs_unclean`), Lage der Slot-Dateien (Extents), Runs von
   `$BadClus`.
9. **ESP und roh gelesene Volumes** (ESP, eine Wiederherstellungspartition ohne VSS): Auf der
   ESP liegt die BCD als offene Registry-Hive mit `BCD.LOG*`, und der FAT-Cache ist eventuell
   nicht geschrieben; zwei gleiche Lesedurchgänge beweisen das nicht. Vorher darum
   `RegFlushKey(HKLM\BCD00000000)` und `FlushFileBuffers` auf dem Volume der ESP **[Win]**, dann
   über `\\?\Volume{GUID}` bzw. die Partition auf `\\.\PhysicalDriveN` mit Offset roh lesen,
   zweimal, SHA-256 beider Durchgänge vergleichen; bei Abweichung bis zu dreimal wiederholen,
   sonst `raw_volume_changing` (Warnung, Stand ohne dieses Volume ist für Bare Metal ungültig).
   Stufe 1 prüft zusätzlich die Sequenznummern der BCD-Hive im Image (WL11). Belegt-Maske für
   FAT32 aus der FAT selbst (`fat.go`), sonst alles belegt.
10. **MSR**: nur Größe und GUID; bei der Wiederherstellung leer angelegt.
11. Der Agent schreibt keinen Block auf die eigene Platte (kein lokaler Zwischenspeicher, BM
    25.A7); der Speicherbedarf ist ein Puffer von 16 Blöcken je Volume (wie
    `MaxBlocksPerFrame`).

Zeitbedarf und Last (Schätzung, **[Maschine]**): Jede Image-Sicherung liest alle belegten
Cluster. Lesezeit ≈ belegte Bytes ÷ Lesedurchsatz: 100 GB auf NVMe (1 bis 2 GB/s) etwa 1 bis
2 Minuten E/A, auf SATA-SSD (0,5 GB/s) etwa 3,5 Minuten, auf HDD (0,12 bis 0,15 GB/s) etwa 12
bis 14 Minuten. Dazu SHA-256 (in Go mit SHA-NI weit über 1 GB/s je Kern). Hochgeladen werden
nur geänderte Blöcke; an einem normalen Tag einige GB, an Patch-Tagen mehr (Updates schreiben
Komponentenspeicher und Bootdateien neu). Defragmentierung und TRIM-bedingte Umlagerung
vergrößern die Änderung; der Agent schaltet nichts davon ab. Die Gegenrichtung, die Dauer einer
Wiederherstellung, schätzt Abschnitt 4.6.

### 3.5 Ablage: restic-Datenstrom oder Blockspeicher

| | (a) restic `backup --stdin-from-command` je Volume, Restore mit `restic dump` | (b) Blockspeicher der PVE-Integration (4-MiB-Blöcke) |
| --- | --- | --- |
| schon für Rechner gebaut | ja: Repository des Rechners, Prinzipal `agent` (nur anhängen), `reader`-Route aus M3, Sperre gegen Prune, `--group-by host` | nein: Upload-Route für Rechner, Lese-Route für Recovery-Sitzungen, Aufbewahrung der Image-Stände, Windows-Build des Blockformats |
| Lesen je Lauf | alles Belegte; restic zerlegt **jeden** Lauf den ganzen Strom (Rabin, etwa 1 MiB im Mittel) **[Quelle]**; CPU oft der Engpass | alles Belegte; nur SHA-256 je 4-MiB-Block, kein Zerlegen beim Agenten |
| Hochladen | neue Chunks | geänderte Blöcke |
| ein Stand über mehrere Volumes | N restic-Snapshots, über ein Tag verbunden; kein gemeinsamer Abschluss | ein Image-Stand mit N Block-Maps, Abschluss atomar (`commit`) |
| Größe des Baums | eine Datei mit etwa 10^6 Blob-IDs je TB, ein Baum-Blob von geschätzt 60 bis 70 MB je Snapshot **[Quelle]** | Hashliste 8 MiB je TB (32 Byte je Block) |
| wahlfreier Zugriff | nein, nur `dump` der ganzen Datei | ja, `GET …/blocks?from=&count=` |
| Stufe 1 auf dem Server (BCD, SYSTEM-Hive, Schwärzung im Image lesen) | nur nach `dump` des ganzen Volumes | direkt über `guestfs` (`ntfs.ts`, `fat.ts`), wenige MB gelesen |
| Rollback nur geänderter Blöcke | nein (kein Blockindex) | ja: lokal maskiert hashen, vergleichen, nur abweichende Blöcke holen |
| Dateien aus dem Image | nein | ja, mit dem vorhandenen NTFS-Leser (PVE-Dateiwiederherstellung) |
| Verschlüsselung | beim Agenten (Repository-Passwort) | auf dem Server mit dem Schlüssel des Mandanten, wie PVE-VMs (Abschnitt 7.1) |
| Restore ohne Datenbank | Repository und Passwort genügen | Manifeste im Speicherziel sind maßgeblich (`snapshots.manifestPath`, wie PVE); `restow-restore` kann Images noch nicht (später) |

**Vorschlag:** (b), der Blockspeicher. Ausschlaggebend sind der Rollback nur geänderter Blöcke
(C1 bis C3), die Prüfung des Images auf dem Server ohne vollständiges Lesen (Stufe 1) und ein
atomarer Stand über alle Volumes. Der Mehraufwand liegt in Routen und Aufbewahrung, nicht in
neuen Formaten: Blockformat, Prüfung beim Hochladen, Chunk-Speicher, synthetischer Vollstand,
Stichproben und NTFS-Leser gibt es. Dafür wird `agent/internal/pve/formats.go` in ein Paket
ohne Build-Tag `agent/internal/blockfmt` verschoben (die PVE-Integration importiert es), und
`packages/core` bekommt `blockstore/` als gemeinsamen Teil von PVE und Rechnern. Das ist ein
Umbau mit Regressionsrisiko für PVE-Kunden und darum ein eigener Vorschritt W4a ohne
Verhaltensänderung, mit grünen PVE-Tests als Kriterium (Abschnitt 9). (a) bleibt die
Alternative, falls der Maintainer die Image-Daten im Repository des Rechners will (Abschnitt
11, Frage 4).

Speicherort: der Chunk-Speicher des Mandanten im primären Speicherziel (wie PVE-VMs), nicht das
restic-Repository des Rechners. Deduplizierung: je Mandant über alle Image-Stände; ausgerichtete
4-MiB-Blöcke deduplizieren innerhalb eines Volumes über die Zeit sehr gut, über Rechner hinweg
wenig (gleiche Dateien liegen auf anderen Clustern). Der Agent vergleicht nur gegen **seine
eigene** Hashliste; er erfährt nie, ob ein Block bei einem anderen Rechner schon liegt (kein
Orakel über fremde Daten).

### 3.6 BitLocker

- **Lesen:** Über das Volume- bzw. Schattenkopie-Gerät kommt **Klartext**: Der
  BitLocker-Filter liegt unter der Schattenkopie **[Win]** **[Maschine]**. Das Volume-Gerät
  zeigt einen virtualisierten NTFS-Bootsektor und blendet die FVE-Metadatenbereiche aus
  **[Win]**; wie genau sie im Image aussehen, ist **[Maschine]** (Stufe 1 prüft die Kennung
  `NTFS    ` im Bootsektor, WL5). `captureBitLocker` erfasst zusätzlich aus dem rohen
  FVE-Bootsektor (`-FVE-FS-`) der Partition die Offsets der drei FVE-Metadatenbereiche und
  deren Version; am Image-Stand stehen dazu die Extents von
  `System Volume Information\FVE2.{…}` (Fakten aus dem Snapshot, 3.4 Punkt 8).
- **Folge für die Ablage:** Ein Image eines BitLocker-Volumes liegt im Image-Speicher
  **unverschlüsselt durch BitLocker, verschlüsselt durch Restow** (Abschnitt 7.1).
- **Neue Hardware (A, B):** Es entsteht ein unverschlüsseltes Volume, das startet. Windows 11
  24H2 kann ein solches Volume beim ersten Start selbst wieder verschlüsseln
  (Geräteverschlüsselung), mit Hinterlegung bei Microsoft-Konto oder Entra ID oder ganz ohne
  Hinterlegung **[Win]**. `postRestore` (4.1.7) meldet darum nicht nur "aus", sondern
  Verschlüsselungszustand, Arten der Schutzvorrichtungen und ob ein
  Wiederherstellungskennwort-Schutz existiert. Alarme: `endpoint.bitlocker_off_after_restore`
  ("BitLocker war an und ist nach der Wiederherstellung aus. Bitte wieder einschalten,
  Schutzvorrichtungen und Hinterlegung wie in Ihrer Richtlinie") bzw.
  `endpoint.bitlocker_unescrowed` ("Windows hat das Volume neu verschlüsselt; prüfen Sie, wo
  der Wiederherstellungsschlüssel hinterlegt ist"). Restow schaltet BitLocker nicht selbst ein,
  weil die Hinterlegung Richtlinie des Kunden ist (Vorschlag, Abschnitt 11, Frage 10).
- **Rollback mit dem ISO (C1 über A) auf ein BitLocker-Volume:** Das Linux-ISO kann BitLocker
  nicht entsperren. Ein Blockvergleich von Klartext-Hashes gegen Chiffretext würde jeden Block
  als geändert sehen, ihn als Klartext schreiben und dabei FVE-Metadaten teilweise
  überschreiben: BitLocker wäre still weg und das Volume beschädigt. Darum erkennt der Plan
  `-FVE-FS-` in Sektor 0 der Zielpartition und bietet nur:
  1. "**Ganzes Volume unverschlüsselt neu schreiben**" (wie A auf neue Hardware) mit
     Zeitschätzung (4.6), eigener Bestätigung und dem Hinweis "BitLocker ist danach aus";
  2. oder den Weg über das WinRE-Medium (B, C1 von B) bzw. C2: dort entsperrt der Bediener das
     Volume mit dem Wiederherstellungskennwort (`manage-bde -unlock -RecoveryPassword`, Eingabe
     am Rechner, Restow speichert es nicht), und der Blockvergleich läuft über das entsperrte
     Volume.

  Die Erkennung "derselbe Rechner" läuft in diesem Fall nur über Disk-GUID und Partitionen; die
  Seriennummer des Volumes steht im verschlüsselten Bootsektor nicht. Auf Clients ist das der
  Normalfall, weil Windows 11 24H2 die Geräteverschlüsselung oft selbst einschaltet. Fall H13.
- **Rollback über das entsperrte Volume (C1 von B, C2, C3):** Geschrieben wird über das
  Volume-Gerät, BitLocker verschlüsselt beim Schreiben **[Maschine]** (größtes Einzelrisiko
  dieses Teils, Abschnitt 10). Die Bereiche der FVE-Metadaten, der virtualisierte Bootsektor
  und die Extents von `FVE2.{…}` des Stands werden als "nicht schreiben" maskiert.
  Voraussetzung: Die Metadaten-Offsets des Stands sind gleich den aktuellen. Ein Stand vor dem
  Einschalten von BitLocker oder vor einer Neuverschlüsselung wird abgelehnt
  (`bitlocker_layout_changed`); Ausweg ist das volle Neuschreiben ohne BitLocker. Für C2 setzt
  der Agent vorher `manage-bde -protectors -disable C: -RebootCount 1` (Abschnitt 4.3).
- Gesperrte Volumes (Datenvolumes ohne automatische Entsperrung) und Volumes mitten in der
  Ver- oder Entschlüsselung werden in diesem Lauf nicht als Image gesichert
  (`bitlocker_locked`, `bitlocker_converting`).
- Nicht gewählt: das rohe, verschlüsselte Partitionsabbild. Es ließe sich nicht vergrößern,
  hätte keine Belegt-Maske (alles lesen) und bräuchte zum Zurückholen den
  Wiederherstellungsschlüssel, den Restow dann hinterlegen müsste (Abschnitt 2.2).

### 3.7 Grenzen: Storage Spaces, dynamische Datenträger, ReFS, Hardware-RAID

- **Storage Spaces:** Die virtuelle Platte erscheint mit Bus `Spaces` und eigener
  Partitionstabelle. Eine Wiederherstellung müsste Pool und virtuelle Platte (Resilienz,
  Spalten) neu anlegen; das braucht im WinPE die Speicherverwaltung über WMI und im ISO gibt
  es sie nicht. Erste Ausbaustufe: Volumes darauf als Dateien (`win_files_only`), System darauf
  `unsupported`.
- **Dynamische Datenträger (LDM):** abgekündigt **[Win]**. Einfache Volumes mit genau einem
  Extent ließen sich als Basispartition zurückschreiben (Kandidat später); übergreifend,
  Stripeset, Spiegel und RAID-5 nie. Erste Ausbaustufe wie Spaces.
- **ReFS:** VSS-Unterstützung hängt von der Version ab, `FSCTL_GET_VOLUME_BITMAP` auf ReFS ist
  **[Maschine]**. Erste Ausbaustufe: Dateien.
- **Hardware-RAID:** erscheint als normale Platte (Bus `RAID`); unterstützt, solange der
  Controller-Treiber für das Ziel vorhanden ist (Abschnitt 4.1.6). Die virtuelle Platte legt der
  Bediener vorher im Controller an (wie BM 2.1).
- **4Kn-Quellplatten** sind unterstützt (NTFS mit 4096 Byte je Sektor), aber nur auf 4Kn-Ziele;
  512 und 512e untereinander frei (Abschnitt 4.1.4).

### 3.8 Parallel zur Dateisicherung

Ein Ganz-Rechner-Lauf unter Windows hat zwei Teile in fester Reihenfolge:

1. **Image-Teil**: Manifest erfassen, Snapshot-Satz, Volumes lesen und hochladen, Image-Stand
   abschließen, `BackupComplete`, Schattenkopien freigeben.
2. **Datei-Teil**: die Ordner des Jobs mit restic wie heute (`--use-fs-snapshot`, eigene
   Schattenkopie von restic).

Folgen, offen benannt:

- Zwei Zeitpunkte: Die Dateien eines Laufs sind einige Minuten jünger als das Image. Der
  Bericht nennt beide Zeiten. Für Einzeldateien gilt die Dateisicherung, für den Rechner das
  Image.
- Zweimal lesen: Ordner auf Image-Volumes werden in einem Lauf zweimal gelesen. Vorgabe bleibt
  "beides", weil Dateien unabhängig von Images zurückkommen müssen (andere Plattformen,
  `restow-restore`, ein beschädigter Image-Stand). Später kann die Oberfläche Einzeldateien aus
  dem Image anbieten (NTFS-Leser) und die Dateisicherung auf Datenordner außerhalb der Images
  beschränken (Abschnitt 11, Frage 5).
- Der Mehr-Volume-Befund der Dateisicherung (Abschnitt 1.2) bleibt dort bestehen; für SQL ist
  er durch das Image (ein Satz) und die native Sicherung (Abschnitt 5.1) gelöst, und die
  Dateisicherung schließt die Daten- und Logordner der Instanzen aus, sobald die native
  Sicherung an ist (Abschnitt 5.1.3).
- Sperre: Beide Teile laufen unter `run.lock`; SQL-Log-Läufe haben eine eigene Sperrklasse und
  laufen parallel (5.1.3).
- Fehler: Scheitert der Image-Teil, läuft der Datei-Teil trotzdem; der Lauf endet `partial`
  mit `image_failed` (oder dem genaueren Code). Scheitert der Datei-Teil, bleibt ein
  abgeschlossener Image-Stand gültig.

### 3.9 Ablauf eines Ganz-Rechner-Laufs (Windows)

```
Rechner (Windows)                                        Restow-Instanz
restow-agent (Job: Ganzer Rechner)
  1 Manifest erfassen -> C:\ProgramData\Restow\data\baremetal\layout.json
  2 POST /agent/v1/images/runs  {runId, volumes[]} ----> Image-Lauf, Basisstand je Volume
  3 GET  .../volumes/:key/hashes  <--------------------- Hashliste des Basisstands
  4 vss-hold: Writer abgleichen, ein Satz, Pflichtkomponenten, DoSnapshotSet,
    GatherWriterStatus
  5 je Volume: Bitmap, Bereich hinter dem letzten Cluster, $BadClus, Schwärzung,
    belegte Blöcke lesen, maskieren, hashen; Fakten (Hives, NTFS, Slots)
    PUT  .../volumes/:key/blocks (RSBF, bis 16 Blöcke) -> prüft SHA-256, Chunk-Speicher
  6 RegFlushKey(BCD), ESP roh (zweimal), MSR nur Größe
  7 POST .../commit {volumes, masks, facts, writers, layoutSha256} -> endpoint_images (Stand)
  8 SetBackupSucceeded, BackupComplete, GatherWriterStatus, Release, vss-hold endet
  9 restic backup (Ordner, wie heute) ------------------> /agent/restic/<id>
 10 POST /agent/v1/runs/:id/finish {consistency, layout, image} -> Stufe 1 Windows,
                                                            Startprobe nach Plan
```

## 4. Wiederherstellung

Alle Wege nutzen denselben Planer (`agent/internal/baremetal/plan_windows.go`, ohne
Build-Tag; auf dem Server in Stufe 1 wie BM 12.2; er kommt mit W4, weil WL3 ihn braucht),
denselben Block-Schreiber (`agent/internal/winimage/writer.go`, ohne Build-Tag, schreibt über
eine Schnittstelle `BlockDevice` auf Linux-Blockgeräte, Windows-Plattenhandles oder
Testdateien) und dieselbe Recovery-Sitzung aus M3. Neu an der Recovery-API ist nur die
Lese-Route für Image-Blöcke (Abschnitt 6.3).

Reihenfolge (Vorschlag, Frage 18): **Weg B wird zuerst gebaut** (W8 vor W5). B hängt nur an
M3, das fertig ist; A hängt an M4 und M5, die offen sind und woanders umgesetzt werden. B hat
außerdem weniger Punkte, die nur auf echter Hardware zu klären sind: eine von Microsoft
signierte Startkette (keine Drittanbieter-CA), die Treiber des Rechners, `reg load` mit
Nachspielen der Hive-Logs (kein `hive_dirty`), BitLocker entsperrbar, kein ntfs-3g, kein
hivex, keine Sichtbarkeit von VMD unter Linux. A ist der Rückfall für Rechner ohne Kit und für
den Fall, dass ein Kit nicht startet. Bleibt der Maintainer bei A zuerst, gilt: W5 beginnt
erst nach dem Merge von M4 und stabilem E1/E2 (BM 21.2); W3 und W4 laufen parallel zu M4/M5.

**Meldungen nur auf vorhandene Wege:** Jeder Text, der einen Ausweg nennt, kommt aus einem
Katalog mit Varianten je verfügbarem Weg. Solange es B nicht gibt, sagen
`boot_driver_not_inbox`, `win_boot_driver_missing`, `hive_dirty` und der Secured-core-Hinweis
zum Beispiel "auf dieser Hardware nicht möglich; Ersatzrechner mit AHCI oder NVMe", "VMD/RST
im Firmware-Setup abschalten" oder "Secure Boot für die Wiederherstellung kurz ausschalten".
Solange es A nicht gibt, nennt kein Text das ISO. Die Bewertung zeigt solche Fälle vor dem
Notfall als "nicht möglich auf anderer Hardware" (4.4.3).

### 4.1 Weg A: Recovery-ISO (M4)

`recover` (BM 10) erkennt am Manifest `platform: "windows"` und nimmt den Windows-Zweig. Netz,
Uhrzeit, TLS mit Prüfwert, Code, Freigabe, Zugangsdaten, Fortschritt, Abbruch, Fortsetzen,
`release` und `finish` sind unverändert (BM 10.2 bis 10.4, 10.18).

#### 4.1.1 Inhalt des ISO

Zusätzliche Pakete in `recovery.list.chroot` (BM 8.2): `ntfs-3g` (nur lesendes Einhängen für
die Prüfung und, nur bei sauberem NTFS, schreibend für den Hive-Fixup, 4.1.5) und
`libhivex-bin` (`hivexregedit`, Bearbeiten der SYSTEM-Hive offline, nur bei sauberer Hive).
Beide stehen unter GPL bzw. LGPL und gehören in das GPL-Werk; der Check `recover --list-tools`
(BM 8.2) nimmt sie auf. Der Kernel des ISO muss das Modul `vmd` enthalten (NVMe hinter Intel
VMD); ob die Platten dahinter sichtbar sind, ist **[Maschine]**. Kein `ntfsresize`-Einsatz in
der ersten Stufe (Abschnitt 4.1.4).

#### 4.1.2 Plan (Windows)

Eingaben wie BM 10.4: Manifest, Hardwarebeschreibung des Ziels, Fakten aus dem Image-Stand
(`facts`: Belegt-Masken-Zusammenfassung, Treiberfakten, Hive- und NTFS-Zustand, Slot-Extents
aus Stufe 1). Schritte, jeder mit Befehl bzw. Aufruf und Argumenten sichtbar:

1. Zuordnung der gesicherten Platten zu Zielplatten (BM 10.7, gleiche Regeln: keine Platte mit
   passender Identität automatisch zum Löschen, doppelte Identitäten sind ein Problem). Eine
   Zielplatte, deren GPT-Disk-GUID bzw. MBR-Signatur und Partitionen zum Manifest passen, ist
   "derselbe Rechner": Der Plan bietet **Rollback** (Abschnitt 4.3) statt Neuaufbau an. Trägt
   die Systempartition `-FVE-FS-`, gilt 3.6 (kein Blockvergleich mit dem ISO). Hängt neben der
   neuen Platte noch die alte am Rechner (häufig bei "neue SSD"), gibt es zwei Platten mit
   derselben Identität: Problem `duplicate_disk_identity` mit "alte Platte abklemmen" vor dem
   Schreiben, nicht erst beim Start (WE4, H14).
2. Partitionstabelle: GPT mit `sgdisk -o`, `-U <disk-guid>`, je Partition `-n
   <nr>:<start>:<ende>` mit **denselben Start-LBAs** (umgerechnet in die Sektoren der
   Zielplatte), `-t <typ>`, `-u <nr>:<partitions-guid>`, `-A` Attribute, `-c` Name. MBR mit
   `sfdisk` mit `label-id` = Signatur und denselben Startoffsets in Bytes, Typ-Bytes und
   Aktiv-Flag; **danach** schreibt der Plan ausdrücklich die ersten 446 Byte aus
   `raw/mbr-<n>.bin` (Bootcode; `sfdisk` schreibt auf eine leere Platte keinen) und lässt die
   Tabelle und die Signatur unberührt. Erweiterte und logische Partitionen: die EBR-Kette wird
   mit exakt denselben Offsets aus `raw/ebr-<n>-<k>.bin` geschrieben, weil `MountedDevices`
   logische Laufwerke über Signatur und Offset findet **[Win]**. Größere Zielplatte: der Rest
   bleibt frei (Abschnitt 4.1.4).
3. Volumes: Image-Blöcke über die Lese-Route holen (jeder Block gegen SHA-256 der Map geprüft),
   alle Blöcke mit mindestens einem belegten Cluster schreiben, die übrigen nicht; den Bereich
   hinter dem letzten Cluster immer (3.4 Punkt 3). ESP und roh gesicherte Volumes vollständig.
   MSR mit Nullen im ersten MiB.
4. `release` (BM 10.13): Ab hier liest `recover` nichts mehr aus dem Repository.
5. Fixups offline (Abschnitt 4.1.5), Wiederanbindung (Abschnitt 4.1.8), NVRAM (4.1.6).
6. Prüfung: Tabelle, Bootcode und GUIDs zurücklesen; je NTFS den Bootsektor, den
   Backup-Bootsektor und den `$MFT`-Spiegel lesen (eigene kleine Prüfung in Go), ntfs-3g nur
   lesend einhängen und `Windows\System32\config\SYSTEM`, `winload.efi` bzw. `winload.exe` und
   `bootmgfw.efi` auf der ESP finden; Bericht an den Server.

Abbruch, Fortsetzen, Stromausfall und Netzverlust während des Schreibens folgen BM 10.18; der
Windows-Zweig bekommt dafür einen eigenen Ende-zu-Ende-Fall (WE5, Gegenstück zu E8).

#### 4.1.3 Firmwaremodus und Secure Boot

- Gesichert UEFI → ISO im UEFI-Modus, gesichert BIOS → ISO im BIOS-Modus (BM 10.5, gleiche
  Meldungen). UEFI mit einer MBR-Systemplatte kommt in der Matrix vor; `Assess` entscheidet
  (Windows startet im UEFI-Modus nur von GPT **[Win]**, ein solcher Fund heißt meist CSM-Start
  und wird als BIOS behandelt, sonst `uefi_mbr_unsupported`). BIOS nach UEFI geht in der ersten
  Stufe nicht; später über `MBR2GPT.exe` im WinPE (Weg B, W10).
- `CheckChain` (`secureboot.go:93`) bekommt einen Windows-Zweig: Signaturgeber von
  `bootmgfw.efi` aus dem Manifest muss zu einem Zertifikat in `db` des Ziels passen
  ("Microsoft Windows Production PCA 2011" oder "Windows UEFI CA 2023"); weder Hash noch
  Zertifikat in `dbx` (`secure_boot_revoked`).
- **Übergang zu CA 2023, in beide Richtungen:** Die 2011-Zertifikate von Microsoft (KEK, UEFI
  CA, PCA) sind seit Juni bzw. Oktober 2026 abgelaufen; neue Bootmanager tragen oft nur noch
  eine Signatur der CA 2023 **[Win]**.
  - Ziel hat die PCA 2011 in `dbx` gesperrt (KB5025885), das Image hat nur einen mit 2011
    signierten Bootmanager: Der Plan bietet den Weg, den Windows selbst geht, die Bootdateien
    aus `Windows\Boot\EFI_EX` des Images (mit CA 2023 signiert, wenn vorhanden) auf die ESP
    (Problem `secure_boot_bootmgr_revoked` mit Lösung, nur wenn `EFI_EX` im Image liegt)
    **[Maschine]**.
  - Image hat nur einen mit CA 2023 signierten Bootmanager, das Ziel hat eine Werks-`db` ohne
    CA 2023 (Ersatzboard, alte Hyper-V-Vorlage, alte `OVMF_VARS`): Problem
    `secure_boot_ca2023_missing` vor dem Löschen. Auswege: Firmware-Update des Ziels, das die
    CA 2023 in `db` bringt; die `db`-Aktualisierung über Windows auf dem Ziel vorher (wenn dort
    ein Windows läuft); Secure Boot für den ersten Start aus und danach die Aktualisierung über
    Windows **[Win]**. Die Startprobe testet beide `db`-Varianten (4.4.2, H15).
  - Dasselbe ist ein Startrisiko für das ISO aus M4 selbst (shim mit CA 2023 auf einer Firmware
    nur mit CA 2011 und umgekehrt); WE2 bekommt zwei OVMF-Varianten (nur 2011; 2023 mit
    gesperrter 2011).
- **Schutz gegen Rückstufung:** VBS-Anti-Rollback (KB5042562: `SkuSiPolicy.p7b` auf der ESP
  plus UEFI-Variable) kann ältere Stände blockieren **[Win]**. `captureFirmware` erfasst die
  Variable (Name aus derselben Positivliste), der Plan warnt vor C1 und C2
  (`vbs_rollback_protection`). Nach einem Rollback passt der Registry-Stand
  `Control\SecureBoot\AvailableUpdates` nicht mehr zur `dbx`, und spätere Wartung kann einen
  gesperrten Bootmanager zurückschreiben **[Win]**; `postRestore` (4.1.7) prüft den
  Signaturgeber des Bootmanagers auf der ESP gegen die `dbx` und meldet Abweichungen.
- Das ISO selbst startet unter Secure Boot nur, wenn die Firmware die Drittanbieter-CA kennt
  und zulässt. Secured-core-Geräte haben sie ab Werk aus (BM 10.5): Der Assistent sagt vorher
  "für die Wiederherstellung Secure Boot kurz ausschalten oder die Drittanbieter-CA zulassen,
  danach wieder einschalten", und nennt Weg B, sobald es ihn gibt. Für Hyper-V Gen2: Vorlage
  "Microsoft UEFI Certificate Authority" für den Start des ISO, danach zurück auf "Microsoft
  Windows".

#### 4.1.4 Größen und Sektorgrößen

- Zielplatte mindestens so groß wie das Ende der letzten Partition der Quelle (in Bytes).
  Kleiner: Problem `win_target_too_small` vor dem Löschen. Ein Schrumpfen von NTFS aus einem
  Image ist in der ersten Stufe nicht vorgesehen (Abschnitt 2.2); Ausweg in der Meldung: auf
  der Quelle das Volume in der Datenträgerverwaltung verkleinern, neu sichern.
- Größere Zielplatte: Partitionen an denselben Offsets mit denselben Größen, der Rest frei.
  Ist das Systemvolume die letzte Partition, vergrößert der wiederhergestellte Agent sie nach
  dem ersten Start und der Wiederanbindung mit `IOCTL_DISK_GROW_PARTITION` und
  `FSCTL_EXTEND_VOLUME` (beides von Windows im Betrieb unterstützt **[Win]**), wenn der Bediener
  das im Plan gewählt hat (Vorgabe an). Liegt die Wiederherstellungspartition hinter C:
  (häufig bei Windows 10/11), bleibt der Platz frei und der Abschluss sagt, wie man ihn von
  Hand nutzt. Vorschlag statt Verschieben der WinRE-Partition, weil `ReAgent.xml` deren Offset
  enthält (Abschnitt 11, Frage 11).
- Sektorgrößen: 512 und 512e untereinander frei; NTFS aus 512-Byte-Quelle auf 4Kn-Ziel und
  umgekehrt: Problem `win_sector_size_mismatch` (NTFS führt die Sektorgröße im Bootsektor
  **[Win]**). Ausweg: Platte mit 512-Byte-Format oder neu installieren.
- MBR: Offsets müssen exakt bleiben, weil BCD und `MountedDevices` Partitionen über
  Signatur und Offset finden **[Win]**. GPT: über Partitions-GUID; die Offsets bleiben trotzdem
  gleich (einfacher, gleicher Prüfpfad).

#### 4.1.5 Speichertreiber und Fixups offline

- **Treiberprüfung vor dem Löschen** (Gegenstück zu BM 10.8): Der Plan bestimmt den Controller
  jeder Ziel-Bootplatte (PCI-Klasse und -ID aus `/sys`) und sucht in den Treiberfakten des
  Manifests (`captureBootDrivers`) einen Treiber, dessen Hardware- oder Kompatibilitäts-ID passt.
  `storahci` (AHCI, `PCI\CC_010601`) und `stornvme` (NVMe, `PCI\CC_010802`) sind inbox ab
  Windows 10 und Server 2016 **[Win]**. Ohne passenden Treiber: Problem `win_boot_driver_missing`
  (Text je verfügbarem Weg, Abschnitt 4). Ein passender, aber nicht inbox-Treiber, der im
  Treiberspeicher liegt, aber nie installiert war: Problem mit Verweis auf B (ISO kann nicht
  `DISM /Add-Driver`).
- **Häufige Fälle, die A nicht kann:**
  - **Intel VMD/RST** ("RAID On", häufig in aktuellen Business-Laptops): `iaStorVD` bzw.
    `iaStorAC` sind nicht inbox; SATA im RAID-Modus (`PCI\CC_0104`) erkennt `storahci` nicht
    **[Win]**. Ohne B: "VMD/RST im Firmware-Setup abschalten" (dann braucht das Image den
    Inbox-Treiber, siehe Vorbereitung unten). Unter Linux braucht das ISO das Modul `vmd`
    **[Maschine]**.
  - **Proxmox VE mit VirtIO** (`viostor`/`vioscsi`) ist nicht inbox. Für P2V empfiehlt der
    Planer SATA- oder NVMe-Emulation des Ziels; VirtIO nur über B mit dem Treiber im Kit.
  - **Hyper-V:** Gen2 nur mit UEFI/GPT, Gen1 nur mit BIOS/MBR; der Planer sagt das vor dem
    Anlegen der VM.
- **Vorbereitung auf andere Hardware** (Vorschlag, Frage 20; Microsofts eigener Weg vor einem
  Controllerwechsel **[Win]**): eine lokale Opt-in-Aktion im laufenden System
  (`restow-agent prepare-hardware-change on` bzw. Schalter in der Oberfläche, nur mit lokaler
  Erlaubnis) setzt für `storahci` und `stornvme` `Start = 0` und entfernt `StartOverride`. Der
  Wert steht dann im nächsten Image, Windows hält ihn selbst konsistent, und für Inbox-Treiber
  ist **kein Offline-Edit** nötig. Geschrieben wird mit `reg.exe` als Prozess mit
  Argumentliste; WA 1.3 ("keine Registry-Schreibfunktionen im Agenten") wird damit für genau
  diese zwei Werte eingeschränkt.
- **Offline-Edit nur auf sauberer Hive:** Ohne diese Vorbereitung setzt `recover` in der aktiven
  ControlSet (`Select\Current`) `Services\<treiber>\Start = 0` und entfernt `StartOverride`
  mit `hivexregedit --merge` auf der über ntfs-3g eingehängten Hive. Das geht nur, wenn die
  Hive im Image sauber ist: hivex markiert eine schmutzige Hive beim Schreiben als sauber,
  Windows verwirft dann die Logs, und die neuesten Registry-Änderungen gehen still verloren
  **[Quelle]** (hivex) **[Win]**. Mit inkrementellem Logging (ab Windows 8.1) ist eine
  schmutzige Hive im Snapshot vermutlich häufig, und `RegFlushKey` schreibt dabei ins Log,
  nicht zwingend in die Hauptdatei **[Win]**; wie oft, misst die CI (8.2). Darum: `hive_dirty`
  (gemessen im Snapshot, 3.4 Punkt 8) ist ein Problem vor dem Löschen, wenn ein Offline-Edit
  nötig wäre; Auswege: ein anderer Stand, die Vorbereitung oben, Weg B (`reg load` spielt die
  Logs nach), oder ohne Treiberänderung, wenn der Ziel-Controller dem der Quelle entspricht.
  Ein Nachspielen der Logs in Go (Format HvLE) ist später möglich (W10). hivex wird nie auf eine
  schmutzige Hive angewandt.
- **ntfs-3g schreibend nur auf sauberem NTFS:** NTFS aus einer Schattenkopie kann ein
  unsauberes `$LogFile` oder ein gesetztes Dirty-Bit tragen; ntfs-3g verweigert dann das
  schreibende Einhängen, und `ntfsfix` ist destruktiv **[Quelle]** (ntfs-3g). Stufe 1 prüft den
  Zustand im Image (`ntfs.ts`: Dirty-Bit, `$LogFile`, Fakt `ntfs_unclean`), der Plan meldet ein
  Problem **vor dem Löschen**, wenn ein schreibender Schritt nötig wäre. Ein schreibendes
  Einhängen ist nur noch für den Hive-Fixup nötig; Wiederanbindung und Probe schreiben roh in
  Slot-Dateien (4.1.8). In der CI prüfbar (VHDX-Image unter Linux mit ntfs-3g einhängen).
- **Domänencontroller:** `Services\NTDS\Parameters\Database restored from backup = 1`
  (DWORD) in derselben Hive bei **jeder** Wiederherstellung eines DC (A, B, C1, C2), nicht nur
  bei einem Controllerwechsel (Abschnitt 5.3). Ist die Hive schmutzig oder das NTFS unsauber,
  kann A einen DC aus diesem Stand nicht wiederherstellen: Problem vor dem Löschen, Ausweg B
  oder ein anderer Stand.
- Nichts sonst wird offline geändert. Alles Weitere erledigt der wiederhergestellte Agent nach
  dem ersten Start (Abschnitt 4.1.7).

#### 4.1.6 NVRAM und Rückfallpfad

- UEFI: `recover` schreibt einen Eintrag "Windows Boot Manager" mit `HD()` auf die
  Partitions-GUID der ESP und Pfad `\EFI\Microsoft\Boot\bootmgfw.efi` und setzt ihn an den
  Anfang von `BootOrder`, wie BM 10.15 für Linux. `BuildLoadOption` gibt es noch nicht
  (`efi.go:101`: "part of the restore (M4)"); W5 hängt dafür an M4, W8 bringt im WinPE eine
  eigene Nutzung derselben Funktion und baut sie, falls M4 später kommt. Ein vorhandener
  Eintrag mit derselben ESP-GUID wird übernommen. Rückfallpfad `\EFI\Boot\bootx64.efi` liegt
  von Windows auf der ESP **[Win]**; die Startprobe startet wöchentlich einmal mit leeren
  Variablen (BM 12.3), um ihn zu beweisen.
- BIOS: Bootcode und EBR-Kette schreibt Schritt 2 aus `raw/` (4.1.2); der Bootsektor des
  Systemvolumes kommt mit dem Image. Aktiv-Flag wie gesichert.

#### 4.1.7 Nach dem ersten Start (wiederhergestellter Agent)

Der Dienst `RestowAgent` startet mit geschwärztem `state.json` (nur Nullen). Heute meldet
`state.Load` dann "re-enroll" (`state.go:95-97`); die Erkennung "aus einem Image
wiederhergestellt" läuft darum **vor jedem `Load` mit Fehlerpfad und vor jedem `Save`**:
Datei aus Nullen (oder Slot mit Token) → Modus "wiederhergestellt", nichts wird überschrieben,
bevor die Liste abgearbeitet ist:

1. Outbox verwerfen (Berichte aus der Zeit vor dem Stand, 3.4 Punkt 5).
2. Wiederanbinden mit dem Token aus `rebind.slot` (Abschnitt 4.1.8); ohne Token wartet er und
   die Oberfläche zeigt "Rechner wiederhergestellt, nicht angebunden" mit dem Dialog aus M3.
   Die lokalen Erlaubnisse stehen unverändert in `local-policy.json`.
3. Bericht `postRestore` an den Server:
   - Windows-Build; Domänenvertrauen (`Test-ComputerSecureChannel` über PowerShell; scheitert
     es: `domain_trust_broken` mit dem Schritt "als Domänenadmin
     `Test-ComputerSecureChannel -Repair -Credential …`");
   - BitLocker: Zustand, Schutzvorrichtungen, Hinterlegung (3.6);
   - WinRE aktiviert (`ReAgent.xml`);
   - Signaturgeber des Bootmanagers auf der ESP gegen die `dbx` (4.1.3);
   - **Aktivierung:** `LicenseStatus` aus `SoftwareLicensingProduct` (WMI, feste Abfrage) lesen
     und berichten; benannte Fälle: OEM-Schlüssel aus der MSDM-Tabelle mit anderer Edition, an
     die Hardware gebundene digitale Lizenz, Server-Evaluierung (fährt nach Ablauf stündlich
     herunter), AVMA **[Win]**;
   - **Windows LAPS:** Nach einem Rollback ist das Kennwort im Verzeichnis neuer als das auf dem
     Rechner, der lokale Admin ist ausgesperrt **[Win]**. Ist LAPS konfiguriert: Warnung
     `laps_password_stale` mit `Reset-LapsPassword`; eine sichere Erkennung gibt es erst mit
     `msLAPS-CurrentPasswordVersion` (Schema Server 2025);
   - Netzwerkkarten neu (feste Adressen aus dem Manifest: der Agent wendet sie nur an, wenn der
     Bediener das im Plan gewählt hat, über `netsh interface ipv4 set address` mit
     Argumentliste, sonst Hinweis);
   - vergrößerte Partition (4.1.4);
   - **DC:** nicht autoritative SYSVOL-Synchronisierung (Abschnitt 5.3);
   - **SQL mit eigener Log-Kette:** Kette schließen, nächste Full ohne `COPY_ONLY`
     (Abschnitt 5.1.3).
4. Erst danach normale Sicherungen; der erste gute Lauf setzt `activity_baseline` (BM 26.7).

#### 4.1.8 Wiederanbindung und Slot-Dateien

Wie BM 10.19 holt `recover` nach `finish` mit `succeeded` über `POST …/current/rebind` ein
Wiederanbindungs-Token. Es schreibt das Token **nicht** über ntfs-3g, sondern roh in eine
**Slot-Datei**: Der Agent legt ab W4 `C:\ProgramData\Restow\state\rebind.slot` und
`…\probe.slot` als nicht residente Dateien fester Größe (64 KiB) mit der geschützten DACL des
Ordners an. Sie sind geschwärzt (im Image nur Nullen), ihre Extents stehen in den Fakten des
Image-Stands (3.4 Punkt 8). `recover` schreibt Kopf, Länge, Token und Prüfsumme in genau diese
Sektoren; Größe und Metadaten der Datei ändern sich nicht, NTFS protokolliert nicht residente
Daten nicht im `$LogFile` **[Win]**. Damit entfallen das schreibende Einhängen und die Frage, ob
ntfs-3g mit `inherit` die DACL richtig setzt. Der Agent prüft vor dem Lesen, dass Ordner und
Datei nur SYSTEM und Administratoren gehören bzw. von ihnen änderbar sind (vorhandene
Vertrauensprüfung, WA 6), löst das Token ein und nullt den Slot. Ein Token, das niemand
einlöst, läuft nach höchstens 24 Stunden ab (BM 14.2). Dass rohes Schreiben in die Extents auf
echter Hardware und nach `chkdsk` hält, ist vor W5 bzw. W8 zu prüfen **[CI]** **[Maschine]**.
Jeder Image-Stand hat Slots, weil Images und Slots mit demselben Meilenstein (W4) kommen;
fehlt ein Slot trotzdem (gelöscht), bleibt der Dialog aus M3. Im WinPE (B) schreibt
`recover --winpe` den Slot über die Datei selbst, ohne Rohzugriff.

### 4.2 Weg B: WinRE-Medium

#### 4.2.1 Bau des Kits auf dem Rechner (`agent/internal/winpe`, `//go:build windows`)

Aufgabe `kit_build`, vom Server geplant nach dem ersten Image-Stand, wenn sich der Windows-Build
ändert, und monatlich:

1. `Winre.wim` finden: Ort aus `ReAgent.xml`; liegt sie auf der Wiederherstellungspartition,
   liest der Agent sie aus der Schattenkopie dieses Volumes im nächsten Snapshot-Satz (kein
   Einhängen, kein Laufwerksbuchstabe). Ist WinRE abgeschaltet, liegt sie unter
   `C:\Windows\System32\Recovery\Winre.wim`. Fehlt sie: `kit_no_winre` mit dem Hinweis, WinRE
   mit `reagentc /enable` einzuschalten oder ein Installationsmedium bereitzustellen
   (`boot.wim`, Pfad als Einstellung). **Die installierte WinRE wird nie verändert** (Windows
   wartet sie selbst, und Updates auf zu kleinen Wiederherstellungspartitionen scheitern
   bekanntlich **[Win]**).
2. Kopie nach `C:\ProgramData\Restow\kit\work\` (Platzprüfung vorher, etwa 2 GiB).
3. `dism /Mount-Image /ImageFile:<kopie> /Index:1 /MountDir:<mnt>`.
4. Dateien hinein: `\Restow\restow-agent.exe` (dieselbe, signaturgeprüfte Version), `kit.json`
   (Adresse der Instanz, Prüfwert der Instanz, Agent-Version, Rechner-ID; **keine
   Geheimnisse**), `\Windows\System32\winpeshl.ini` mit `wpeinit` und
   `X:\Restow\restow-agent.exe recover --winpe`.
5. Treiber: `pnputil /export-driver * <dir>` (ab Windows 10 1607 und Server 2016 **[Win]**),
   gefiltert auf die Klassen `Net`, `SCSIAdapter`, `HDC`; dann
   `dism /Image:<mnt> /Add-Driver /Driver:<dir> /Recurse`. Treiber, die DISM ablehnt, stehen im
   Bericht.
6. `dism /Unmount-Image /MountDir:<mnt> /Commit`, dann `dism /Export-Image` zum Verkleinern.
7. Startdateien aus der Installation des Rechners: `Windows\Boot\EFI` bzw. `EFI_EX`, wenn die
   `db` des Rechners die CA 2023 enthält (passt dann zur `dbx` dieses Rechners), `boot.sdi`,
   für BIOS `etfsboot.com`; BCD des Mediums mit `bcdedit /createstore` und
   RAM-Disk-Einträgen (`bcdedit /store …` mit Argumentliste; GUIDs aus der Ausgabe über
   `{[0-9a-f-]{36}}`, nicht über lokalisierten Text).
8. ISO: eigener Schreiber `agent/internal/isowriter` (ohne Build-Tag): ISO 9660 mit Joliet,
   El Torito mit UEFI-Startabbild (kleines FAT-Abbild mit `\EFI\Boot\bootx64.efi`, ebenfalls
   selbst geschrieben) und BIOS-Eintrag. Ob bootmgr von ISO 9660 mit Joliet ohne UDF startet, ist
   ungeprüft; Microsoft selbst baut mit `-u1 -udfver102`. Die CI prüft beides (Start in QEMU,
   Abschnitt 8.2); verlangt bootmgr UDF, bekommt der Schreiber eine UDF-1.02-Brücke.
9. Hochladen in den Image-Speicher des Rechners als Kit-Objekt (Blöcke, dedupliziert),
   Eintrag in `endpoint_recovery_kits` (Abschnitt 6.4) mit Version, SHA-256, Größe, Windows-Build
   der WinRE, Treiberliste.

Lizenz (Einschätzung, keine Rechtsberatung): Das Kit entsteht aus der lizenzierten WinRE des
Kunden zur Wiederherstellung dieses Geräts; Restow verteilt keine Microsoft-Dateien. Ein Kit für
viele Geräte zu verwenden ist eine Grauzone (Abschnitt 11, Frage 12).

#### 4.2.2 Medium

- Oberfläche "Wiederherstellungsmedium dieses Rechners herunterladen" (Admin, frische
  Anmeldung, Audit `endpoint.recovery_kit.downloaded`): ISO für Fernverwaltungskonsolen und VMs;
  für USB der Hinweis "Inhalt des ISO auf einen mit FAT32 formatierten Stick kopieren" (UEFI
  startet davon, die WIM ist kleiner als 4 GiB).
- SHA-256 steht im Dialog; das Medium enthält keine Geheimnisse, ist aber wie das ISO zu
  verwahren: Wer es verändert, kann den eingegebenen Code abgreifen (Abschnitt 7.3).
- Ein Rechner ohne Kit (tot, bevor eines gebaut war) hat Weg A; ein Kit eines gleichartigen
  Rechners desselben Mandanten funktioniert technisch, ist aber Frage 12.

#### 4.2.3 `recover --winpe`

Derselbe Code wie A, übersetzt für `windows/amd64` (`cmd/restow-agent/recover_windows.go`),
mit Windows-Teilen:

- Netz: `wpeinit` (DHCP); statisch über `netsh` mit Argumentliste. Uhrzeit: wie BM 10.3 (aus
  dem RTC, Prüfung gegen den Server, keine Uhrzeit aus einem `Date`-Kopf). TLS: Prüfwert der
  Instanz aus `kit.json` bzw. aus dem Code-Dialog; WinPE hat keinen aktuellen Stammzertifikatsspeicher.
  Go und restic unter WinPE: **[Maschine]**.
- Zielgeräte über `IOCTL_STORAGE_QUERY_PROPERTY`, PCI-IDs über SetupAPI-Registry
  (`HKLM\SYSTEM\CurrentControlSet\Enum\PCI`).
- Partitionieren: `IOCTL_DISK_CREATE_DISK` und `IOCTL_DISK_SET_DRIVE_LAYOUT_EX` (setzt
  `PartitionId` und Disk-GUID; `diskpart` kann Partitions-GUIDs nicht setzen **[Win]**),
  `IOCTL_DISK_UPDATE_PROPERTIES`. Automatisches Einhängen neuer Volumes vorher aus
  (`mountvol /N`) **[CI]**.
- **Volume vor dem Schreiben sperren:** Sobald ein NTFS-Bootsektor geschrieben ist, kann
  Windows das Volume einhängen; danach werden Schreibzugriffe abgelehnt, oder NTFS hält ein
  halbes Volume im Cache **[Win]**. Darum je Ziel-Volume (auch C: beim Rollback) das Volume
  öffnen, `FSCTL_LOCK_VOLUME` und `FSCTL_DISMOUNT_VOLUME`, und dieses Handle während des ganzen
  Schreibens halten; geschrieben wird über das Volume-Handle bzw., für noch nicht erkannte
  Partitionen, über das Plattenhandle mit Offsets. Danach Handle schließen und
  `IOCTL_DISK_UPDATE_PROPERTIES` erneut.
- RAM: Vor dem Start prüft der Agent, dass der Rechner WIM-Größe plus 1 GiB Reserve an
  Arbeitsspeicher hat (für C2 Voraussetzung, 4.3).
- Treiber: fehlt dem wiederhergestellten System der Treiber des Ziel-Controllers, aber das Kit
  hat ihn: `dism /Image:W:\ /Add-Driver /Driver:X:\Restow\drivers\<inf>`; Inbox-Treiber über
  `reg load HKLM\RESTOW_SYSTEM W:\Windows\System32\config\SYSTEM`, `reg add … /v Start /t
  REG_DWORD /d 0 /f`, `reg delete … StartOverride /f`, `reg unload` (`reg load` spielt die Logs
  nach **[Win]**, `hive_dirty` ist hier kein Problem). Auf einem DC in derselben geladenen Hive
  immer `NTDS\Parameters\Database restored from backup = 1` (5.3).
- BitLocker (C1 vom Kit): `manage-bde -unlock W: -RecoveryPassword <eingegeben>` vor dem
  Blockvergleich; das Kennwort gibt der Bediener am Rechner ein, es verlässt den Prozess nicht
  (3.6).
- NVRAM: `SetFirmwareEnvironmentVariableExW` mit `BuildLoadOption` (WinPE läuft mit allen
  Privilegien). `bcdboot W:\Windows /s S: /f UEFI` nur, wenn die Identität nicht gehalten werden
  konnte (der Bediener wählte neue GUIDs) oder die ESP neu gebaut werden muss.
- Prüfung: `chkdsk W: /scan` (nur lesend) zusätzlich zur eigenen Prüfung.
- Wiederanbindung: Token in `state\rebind.slot` über die Datei selbst schreiben (Größe
  bleibt, DACL bleibt, 4.1.8).
- Neustart: `wpeutil reboot`.

### 4.3 Rollback C

Gemeinsame Regeln für C1 bis C4:

- **Erlaubnis am Rechner.** Ein Rollback zerstört die Änderungen seit dem Stand. Ein
  kompromittierter Server dürfte das nicht für eine ganze Flotte auslösen können. Darum gilt
  wie bei Hooks (WA 12.2): nur wenn am Rechner erlaubt (`restow-agent config allow-rollback on`,
  Installer-Schalter `-AllowRollback`; Vorgabe aus; gespeichert in `local-policy.json`, nicht
  geschwärzt). Sonst antwortet der Agent `rollback_not_allowed` und die Oberfläche zeigt den
  Befehl. Damit der Admin das nicht erst im Notfall merkt, zeigt die Bewertungskarte des
  Rechners den Zustand deutlich ("Rollback aus der Oberfläche: nicht erlaubt, so einschalten:
  …"). C1 vom Medium braucht diese Erlaubnis nicht, weil jemand vor Ort das Medium startet und
  den Code eingibt (Vorschlag, Abschnitt 11, Frage 6).
- **Auslösen** nur durch Mandanten-Admins mit frischer Anmeldung, Eingabe des Rechnernamens zur
  Bestätigung, Audit `endpoint.rollback.requested`, Sicherheitsalarm wie
  `endpoint.recovery.started` (BM 12.6). Höchstens ein Rollback je Rechner gleichzeitig,
  höchstens fünf je Mandant und Stunde (Schutz gegen Missbrauch über die Oberfläche).
- **Sicherung vorher:** Bei C2 bis C4 (aus dem laufenden System) entsteht vor dem Schreiben ein
  Image-Stand bzw. (C4) ein restic-Snapshot des jetzigen Zustands, markiert `pre_rollback`
  (Vorgabe an; abschalten nur ausdrücklich, im Audit vermerkt). Bei C1 vom Medium läuft kein
  System; der Plan bietet "jetzigen Stand vorher vollständig sichern" an (volles Lesen der
  belegten Cluster des jetzigen NTFS über dessen `$Bitmap`, Upload als `pre_rollback`; braucht
  ein Anhängerecht der Sitzung, Frage 19) und sagt sonst ausdrücklich "nicht umkehrbar". Die
  beim Blockvergleich gelesenen abweichenden Blöcke allein ergeben keinen Stand (11.2).
- **Nur geänderte Blöcke** (C1 bis C3): Für jeden Block des Ziel-Volumes, der im gewählten
  Stand mindestens einen belegten Cluster hat, liest der Agent den lokalen Block, nullt die im
  Stand freien Cluster und die geschwärzten Bereiche, hasht und vergleicht mit der Hashliste
  des Stands; nur bei Abweichung holt er den Block und schreibt ihn. Blöcke ohne belegten
  Cluster im Stand bleiben unberührt (freier Platz, egal was darin steht). Der Bereich hinter
  dem letzten Cluster wird immer verglichen. Ausnahme BitLocker mit dem ISO (3.6).
- **Volumes als Gruppe:** Vorgabe ist **alle Volumes des Stands**. Anwendungen verteilen
  zusammengehörige Dateien über Volumes: SQL-Daten auf D: und Log auf L: (nur D: zurück macht die
  Datenbank `SUSPECT`, Fehler 9003 **[Win]**), NTDS, SYSVOL und DFSR-Ordner (USN-Rollback bzw.
  wiederverwendete DFSR-Versionen), Exchange-Datenbank und -Logs, und auf dem Systemvolume
  `master`/`msdb` und die Binärdateien gegen Datenbanken und Daten auf anderen Volumes. Jede
  Abwahl eines Volumes prüft der Planer gegen die Writer-Metadaten des Stands
  (Sicherungsdokument, 3.3 Punkt 8): trennt sie Dateien derselben Komponente oder derselben
  Anwendung, ist das ein Problem (`rollback_splits_application`), nicht nur eine Warnung.
- **Prüfungen vorher**, als Probleme bzw. Warnungen im Plan: Identität der Platte passt
  (Disk-GUID bzw. Signatur, Partitionen, bei unverschlüsselten Volumes die Seriennummer);
  Stand jünger als die Tombstone-Lebensdauer bei einem DC (Abschnitt 5.3); Domänenmitglied
  und Stand älter als 30 Tage (Warnung "das Computerkonto-Kennwort kann seitdem zweimal
  gewechselt sein, danach ist die Vertrauensstellung neu herzustellen") bzw. älter als 60 Tage
  (deutlicher); BitLocker-Zustand und FVE-Offsets (3.6); VBS-Anti-Rollback (4.1.3); SQL mit
  eigener Log-Kette (die Kette wird nach dem Rollback geschlossen, 5.1.3); Exchange in einer
  DAG (5.2); laufende Recovery-Sitzung.
- **Ransomware:** Nach einem Befall ist ein Rollback aus dem kompromittierten System (C2) nicht
  vertrauenswürdig: Das System selbst stellt Kit, BCD-Eintrag und Sitzung bereit. Der
  Assistent empfiehlt im Szenario "Ransomware" (4.5) C1 vom Medium bzw. A/B auf eine leere
  Platte; die "Sicherung vorher" ist dann ein langer Upload verschlüsselter Daten und standardmäßig
  aus (mit Begründung im Plan).
- Die Sitzung ist eine Recovery-Sitzung neuer Art `rollback` (Abschnitt 6.4) mit denselben
  Regeln (Lesezugang `reader` nur auf diesen Rechner, höchstens 48 Stunden, kein Prune
  während der Sitzung, Audit je Übergang). Die Freigabe ist die Auslösung in der Oberfläche
  selbst (wie die Migrationssitzung, BM 25.C12).

#### C1: Rollback vom Medium (W8 über B, W5 über A)

`recover --winpe` (B) oder `recover` (A) findet an der Zielplatte die Identität des Manifests
und bietet "Rollback auf diesen Stand (schreibt nur Geänderte)" an. Ablauf wie 4.1 bzw. 4.2.3,
aber ohne Partitionieren (Tabelle wird nur geprüft, bei Abweichung Problem), ohne
NVRAM-Änderung, mit dem Blockvergleich. Für alle Volumes der Gruppe:

- **ESP:** wie C2 bleibt die **aktuelle ESP** (ein neuerer Bootmanager startet ein älteres
  `winload`; der Bootmanager des Stands kann inzwischen in der `dbx` dieses Rechners gesperrt
  sein, KB5025885 **[Win]**). Die ESP des Stands schreibt C1 nur, wenn die aktuelle fehlt oder
  beschädigt ist (das Szenario "Update kaputt" kann genau das sein) **und** `CheckChain` den
  Bootmanager des Stands gegen die `dbx` desselben Rechners (aus dem NVRAM gelesen) zulässt.
- **Fixups:** Speichertreiber nur, wenn der Controller gewechselt hat; der DC-Wert
  `Database restored from backup` **immer** auf einem DC (5.3).
- **BitLocker:** 3.6 (mit dem ISO nur volles Neuschreiben ohne BitLocker; vom WinPE nach
  Entsperren mit Blockvergleich).
- **Sicherung vorher:** nur als ausdrückliche Wahl (oben); sonst sagt der Plan "nicht
  umkehrbar".

#### C2: Fern-Rollback aus der Oberfläche (W9)

1. Prüfungen (oben), Kit vorhanden und passend zum Windows-Build des Stands oder neuer, genug
   RAM für die WIM plus Reserve (WIM-Größe + 1 GiB, sonst `rollback_ram_too_small`). Auf
   Servern verlangt C2 einen Fernzugriff außerhalb des Betriebssystems (iDRAC, iLO, IPMI mit
   virtuellem Medium; Bestätigung des Admins), damit bei einem Abbruch A oder B nachgeladen
   werden kann.
2. Sicherung vorher (Image-Stand des jetzigen Zustands).
3. Kit als RAM-Disk-Eintrag in die BCD des Systems. Die WIM liegt möglichst **nicht** auf einem
   Volume, das zurückgesetzt wird: auf einem Datenvolume außerhalb der Gruppe, wenn es eines
   gibt, sonst unter `C:\ProgramData\Restow\rollback\restow-re.wim`.
   `bcdedit /create /d "Restow Rollback" /application osloader`, `device` und `osdevice` als
   `ramdisk=[<vol>]\…\restow-re.wim,{ramdiskoptions}`, `winpe yes`, `detecthal yes` **[Win]**.
   Die WIM wird beim Start ganz in den Speicher geladen; das Überschreiben von C: danach ist
   sicher **[Maschine]**.
4. Sitzungsgeheimnis in `C:\ProgramData\Restow\rollback\session.json` (geschützte DACL), gilt
   einmal, höchstens 4 Stunden, nur für diese Sitzung. Das WinPE liest es in den Speicher.
5. `manage-bde -protectors -disable C: -RebootCount 1` bei BitLocker.
6. `bcdedit /bootsequence {id}` (einmaliger Start; nicht `reagentc /boottore`, das die
   unveränderte WinRE startet). Neustart über `InitiateShutdownW` (braucht
   SeShutdownPrivilege, Abschnitt 6.1).
7. Im WinPE: Netz, Sitzung, Sperren und Aushängen jedes Ziel-Volumes (4.2.3), Blockvergleich
   und Schreiben für alle Volumes der Gruppe. **Die aktuelle ESP bleibt** (wie C1); nur der
   Restow-Eintrag wird aus der BCD entfernt. Fixups für DCs (5.3). Wiederanbindungs-Token in
   den Slot (4.1.8; das `state.json` des Stands ist geschwärzt, und ein neuerer
   DPAPI-Hauptschlüssel des jetzigen `state.json` fehlt im älteren Stand). `release`,
   `finish`, Neustart.
8. **Abbruch und Stromausfall, ehrlich:** Scheitert das WinPE **vor** dem ersten
   Schreibzugriff (kein Netz, Sitzung abgelaufen), startet der Rechner beim nächsten Mal wieder
   normal (`bootsequence` gilt einmal) und der Agent meldet `rollback_aborted`. **Nach** dem
   ersten Schreibzugriff gilt: Fortsetzen geht nur, solange das WinPE läuft (Fehlerbildschirm
   "Rollback unvollständig, nicht neu starten; Oberfläche: Fortsetzen", BM 10.18). Nach einem
   Stromausfall ist C: teilweise geschrieben, `-RebootCount 1` ist verbraucht (C: lässt sich
   dann nur mit dem Wiederherstellungsschlüssel entsperren **[Maschine]**), und liegt die WIM
   auf C:, lässt sich das WinPE nicht mehr laden. Darum: Liegt die WIM außerhalb der Gruppe,
   macht das WinPE ab dem ersten Schreibzugriff den Restow-Eintrag zum Standard der BCD auf der
   ESP (`bcdedit /store <esp>\EFI\Microsoft\Boot\BCD /default {id}`) und setzt ihn am Ende
   zurück; sonst bleibt als Weg der Fernzugriff aus Schritt 1 mit A oder B. Der Plan sagt das
   vor der Auslösung.

#### C3: Datenvolume im Betrieb (W7b)

Für Volumes ohne System, ohne Auslagerungsdatei und ohne Datenordner des Agenten, die
**allein** eine Gruppe bilden (keine Komponente mit Dateien auch auf einem anderen Volume, oben):

1. Prüfen: Das Volume trägt keinen Schattenkopie-Speicher anderer Volumes (sonst
   `volume_hosts_shadow_storage`, Problem). Sicherung vorher (Image-Stand nur dieses Volumes).
2. Dienste mit Dateien auf dem Volume beenden: aus dem Manifest und den Writer-Metadaten
   bekannte (SQL-Instanzen mit Dateien darauf, Hyper-V, IIS-Sites) und vom Admin gewählte.
3. **Schattenkopien dieses Volumes löschen** (über den Requester,
   `DeleteSnapshots` für das Volume), sonst schreibt Copy-on-Write unter dem Rohschreiben mit
   und kann den Differenzbereich füllen **[Win]**. Der Dialog sagt, dass "Vorgängerversionen"
   dieses Volumes dabei verloren gehen.
4. `FSCTL_LOCK_VOLUME`, dann `FSCTL_DISMOUNT_VOLUME`; das Handle bleibt während des ganzen
   Schreibens offen. Scheitert die Sperre (offene Dateien), bietet der Dialog "erzwingen"
   (Aushängen ohne Sperre, offene Handles werden ungültig) mit eigener Bestätigung.
5. Blockvergleich und Schreiben über das gesperrte Volume-Handle.
6. Handle schließen; NTFS hängt beim nächsten Zugriff neu ein und liest die Metadaten frisch.
   Ohne `FSCTL_DISMOUNT_VOLUME` behielte NTFS die alten Metadaten im Speicher und beschädigte
   das Volume **[Win]**. Danach `chkdsk <vol> /scan`, Dienste wieder starten.

#### C4: Ordner zurücksetzen (W7a, alle Plattformen)

Ein gesicherter Ordner auf den Stand eines Snapshots, dateibasiert:

- restic-Snapshot des jetzigen Ordners vorher (normale Sicherung nur dieses Pfads, Tag
  `restow-pre-rollback`).
- `restic restore <snap>:<ordner> --target <ordner> --overwrite always --delete --verify`
  **[Quelle]** (Abschnitt 1.2).
- Neue Funktion `prepareRollbackTarget` neben `prepareRestoreTarget`: Ziel muss genau ein
  gesicherter Quellpfad dieses Snapshots sein, lokal und fest, nicht `%SystemRoot%`,
  `Program Files`, Datenordner des Agenten, keine Laufwerkswurzel eines Systemvolumes; nur mit
  der lokalen Erlaubnis und einer Aufgabe mit `rollback: true`.
- Zusammen damit (W7a) der **Restore an den Originalort** ohne `--delete`: `--overwrite
  if-changed` ("überschreiben") bzw. `--overwrite never` ("nur Fehlendes ergänzen"), mit
  derselben Zielprüfung. "Überschreiben" zerstört den jetzigen Inhalt wie ein Rollback und
  braucht darum dieselbe lokale Erlaubnis, die Sicherung vorher und eine frische Anmeldung;
  "nur Fehlendes ergänzen" ändert keine vorhandene Datei und braucht keine Erlaubnis.
- Gilt sinngemäß für Linux und macOS (`util_unix.go`), Vorschlag (Abschnitt 11, Frage 7).

### 4.4 Restore-Prüfung auf dem Server ("Grün ist Beweis")

#### 4.4.1 Stufe 1 Windows

Job `baremetal-check` (BM 12.1) mit einem Windows-Zweig, Bericht derselben Art
`baremetal_check`. Gelesen wird über `guestfs` direkt aus den Block-Maps (wie die
PVE-Dateiwiederherstellung, im Wegwerf-Kindprozess), nie durch Einhängen:

| Nr. | Prüfung | Wie | Rot nur bei |
| --- | --- | --- | --- |
| WL1 | Schema und Verweise | `parseLayoutManifest` (`windows`) | ungültigem Manifest |
| WL2 | Unterstützt | `verdict`, `unsupported[]` | `unsupported` |
| WL3 | Plan erstellbar | `restow-agent baremetal plan --platform windows` (Planer kommt mit W4) mit `--target same`, `--target other-controller` (NVMe↔AHCI), je verfügbarem Weg (A, B), isoliert nach BM 12.2 | Problem bei `same` |
| WL4 | Image vollständig | je Image-Volume des Manifests eine Block-Map, Länge = Volume-Größe, Belegt-Maske vorhanden und passend zur Clusterzahl, Bereich hinter dem letzten Cluster vorhanden (Backup-Bootsektor gleich dem primären); Stichprobe von 64 belegten Blöcken gegen SHA-256 | fehlender Map, fehlendem Endbereich oder Hash-Abweichung (Beleg) |
| WL5 | Dateisysteme lesbar und sauber | Bootsektor `NTFS` (nicht `-FVE-FS-`), `$MFT` lesbar (`ntfs.ts`), Dirty-Bit und Zustand von `$LogFile` (`ntfs_unclean`: Problem für jeden schreibenden Schritt von A, kein Rot); ESP als FAT (`fat.ts`) | nicht lesbarem Systemvolume oder ESP |
| WL6 | Startkette im Image | ESP: `\EFI\Microsoft\Boot\bootmgfw.efi`, `\EFI\Microsoft\Boot\BCD`; Systemvolume: `Windows\System32\winload.efi` bzw. `.exe`, `Windows\System32\config\SYSTEM`; BCD-Geräteelemente zeigen auf Partitions-GUIDs des Manifests (neuer Leser `guestfs/regf.ts`, nur lesen; wendet die Hive-Logs lesend an oder markiert den Zustand `hive_dirty`); `Start` des Treibers der Quell-Bootplatte ist 0 | fehlender Datei, BCD zeigt auf fremde Partition |
| WL7 | Geheimnisse geschwärzt | `ProgramData\Restow\state\state.json`, `state\.state-*.tmp` und die Slots im Image bestehen nur aus Nullen (oder fehlen) | **jedem** anderen Inhalt: Sicherheitsbefund, Alarm `baremetal.secret_in_image`, der Image-Stand wird sofort zur Löschung markiert |
| WL8 | Konsistenz | `writers[]` des Laufs, `vss_writer_missing` | nie rot; Writer nicht `STABLE` oder erwarteter Writer fehlt ist Warnung mit Name |
| WL9 | Manifest im Image | `ProgramData\Restow\data\baremetal\layout.json` im Image, SHA-256 gleich `endpoint_layouts.sha256` | Abweichung |
| WL10 | Slots | `state\rebind.slot` und `state\probe.slot` vorhanden, nicht resident, Extents gleich den Fakten des Stands | nie rot; fehlend ist Problem für A (Dialog aus M3) |
| WL11 | BCD sauber | Sequenznummern der BCD-Hive auf der ESP gleich | nie rot; ungleich ist Warnung `esp_bcd_dirty` (B baut die BCD mit `bcdboot` neu, A meldet ein Problem für neue Hardware) |

Neu im Server ist dafür `packages/core/src/pve/guestfs/regf.ts` (Registry-Hive lesen: Basisblock,
`hbin`, `nk`/`vk`-Zellen; Grenzen für Tiefe und Größe wie die übrigen Leser) mit Testdaten aus
echten Hives (anonymisiert, auch schmutzige).

#### 4.4.2 Stufe 2: Startprobe Windows (W6)

Wie BM 12.3 (getrenntes Labor, Labor-API, Probe-Listener, qcow2 mit LUKS im Labor, ein
`OVMF_VARS` für beide Phasen mit aktueller DBX), mit diesen Unterschieden:

- **Wiederherstellung** mit dem Weg, der zuerst ausgeliefert wird: dem Kit des Rechners (B,
  `recover --winpe` mit Antworten über eine zweite, kleine Antwort-Platte) bzw. dem echten ISO
  (A, `--answers` über `fw_cfg`). Gibt es beide, prüft die Probe abwechselnd beide. Geschrieben
  werden ESP, MSR, Wiederherstellungspartition und Systemvolume vollständig, Datenvolumes nur
  bis zur Grenze `RESTOW_LAB_MAX_RESTORE_GIB` (Vorschlag für Windows: 256 GiB **belegte**
  Bytes, weil sich ein Systemvolume blockweise nicht teilweise herstellen lässt; Frage 13);
  Datenvolumes darüber bleiben leere Partitionen mit ihrer GUID (Windows sieht sie als RAW).
  Ist schon das Systemvolume größer: "nicht möglich (zu groß)".
- **Hardware der Probe:** Controller anders als die Quelle (NVMe → AHCI, sonst NVMe), damit der
  Treiber-Fixup bewiesen ist; Netzwerkkarte `e1000e` (inbox **[CI]**), ohne Netz; OVMF mit
  Microsoft-Schlüsseln und Secure Boot wie die Quelle, sonst SeaBIOS bei BIOS-Quellen; 4 GiB
  RAM, 2 vCPU. Die `db` wechselt zwischen zwei Varianten (mit und ohne CA 2023, mit aktueller
  `dbx`), damit beide Richtungen des CA-Übergangs geprüft sind (4.1.3).
- **Beweis ohne Gast-Agent und ohne Registry-Änderung:** `recover` schreibt im Probemodus auf
  der Wegwerfkopie eine Einmal-Nonce in `ProgramData\Restow\state\probe.slot` (roh, 4.1.8).
  Der wiederhergestellte Dienst `RestowAgent` findet beim Start Slot und geschwärztes
  `state.json`, schreibt `RESTOW-PROBE-OK <nonce> <CurrentBuild.UBR>` auf `\\.\COM1` und
  wartet. Das Labor beendet die VM nach dieser Zeile selbst; der Gast fährt nicht herunter, W6
  braucht darum kein `SeShutdownPrivilege`, und Images aus der Zeit vor einer neuen
  Privilegienliste bleiben prüfbar. Das beweist Bootmanager, Kernel, Speichertreiber,
  Dienststeuerung und einen Dienst unter LocalSystem. Vorher, höchstens 10 Minuten, meldet er
  auf derselben Leitung die Zustände der SQL-Server-Dienste und, wenn sie laufen,
  `SELECT name, state_desc FROM sys.databases` (alle `ONLINE`?) sowie bei einem DC den Zustand
  von NTDS; das sind Warnungen am grünen Bericht, keine Bedingung. Ein Agent im Image, der
  älter ist als W6, kennt den Probemodus nicht: "Probe nicht möglich (Agent im Image zu alt)".
- **Zeitgrenze** 30 Minuten (erster Start auf neuer Hardware installiert Geräte und kann einmal
  neu starten **[CI]**).
- **Rot nur mit Beleg**, unabhängig von der Sprache: QEMU läuft mit `-cpu …,hv-crash`; Windows
  meldet einen Bluescreen dann über die Hyper-V-Crash-MSRs mit Stoppcode als QMP-Ereignis
  `GUEST_PANICKED` **[Win]** **[CI]**, bevor es neu startet oder den
  Wiederherstellungsbildschirm zeigt. Dazu Secure-Boot-Ablehnung der Firmware. Der Text
  "Your device ran into a problem" auf einem `screendump` ist kein Kriterium mehr (auf einem
  deutschen Windows lautet er anders). Ein Fehler des Bootmanagers ohne Bluescreen (z. B.
  `0xc000000e`) und alles andere ist unvollständig, nicht rot. `recoveryenabled no` in der
  Wegwerfkopie ist nicht nötig (11.2).
- **Wann:** wie BM 12.3, bei geändertem `layoutFingerprint` oder `bootChainFingerprint`
  (also nach jedem kumulativen Update), sonst wöchentlich.
- **Kapazität:** `RESTOW_LAB_CONCURRENCY` ist standardmäßig 1 (BM 12.3). Jedes kumulative
  Update ändert `bootChainFingerprint`; am Patch-Dienstag sind damit alle Windows-Rechner
  gleichzeitig neu zu prüfen, je Probe 30 bis 60 Minuten und bis zu 256 GiB Restore. Darum:
  eine Kapazitätsrechnung in docs/SIZING.md (Proben je Tag und Labor nach Größe der Images),
  Priorisierung der Warteschlange (DCs und Server vor Clients, Rechner ohne grünen Stand
  zuerst, gleicher Build mehrerer Rechner zusammen geplant), und die Oberfläche zeigt in dieser
  Zeit "grün für den Stand vom <Datum> (vor dem Update); neuer Stand wird geprüft", nicht
  `overdue`, solange der ältere grüne Stand jünger als 8 Tage ist.
- Lizenz: Der Start einer Windows-Kopie des Kunden in der Labor-VM zum Beweis der
  Wiederherstellbarkeit ist rechtlich nicht eindeutig (Abschnitt 11, Frage 12); die Probe
  aktiviert nichts und hat kein Netz.

#### 4.4.3 Bewertung

`baremetalReadiness` (BM 12.4) gilt für `platform = windows` mit denselben Zuständen
(`not_enabled`, `not_possible`, `no_layout`, `unverified`, `layout_checked`, `green`, `red`,
`overdue`). Grün: Stufe 1 des neuesten Image-Stands grün **und** eine grüne Startprobe mit
gleichen Fingerabdrücken, höchstens 8 Tage alt. Was Grün beweist, sagt die Oberfläche genau:
"Wiederherstellung mit dem <Medium/ISO> in einer VM mit Standard-Controller bewiesen". Das
gilt nicht für die echte Ziel-Firmware, RAID oder VMD; dafür gibt es den Zustand
"Zielhardware geprüft" aus der Vorabprüfung (4.6) als eigene Zeile. Wege, die die Probe nicht
fährt (C2 immer; A oder B, solange nur einer geprüft wird), sind durch CI-Tests nur dann
belegt, wenn diese Tests laufen; solange Frage 12 offen ist und WE2 nicht läuft, zeigt die
Oberfläche sie ausdrücklich als "nicht bewiesen". Fälle, die auf anderer Hardware nicht gehen
(nicht inbox-Treiber ohne B, VMD ohne B, BitLocker-Volume mit dem ISO), zeigt die Bewertung
vorher als "nicht möglich auf anderer Hardware" bzw. "nur unverschlüsselt".

### 4.5 Notfall-Abläufe je Szenario

Der Assistent "Wiederherstellen…" fragt zuerst nach dem Szenario und wählt daraus Weg,
Vorgaben und Warnungen; die Buchstaben A, B, C1 bis C4 sieht der Bediener nur im Plan.

| Szenario | Empfohlener Weg | Vorgaben und Warnungen |
| --- | --- | --- |
| **Platte tot**, Rechner sonst gleich | B (Kit) auf die neue Platte, sonst A | alle Volumes; alte Platte abklemmen (`duplicate_disk_identity`); BitLocker danach aus bzw. neu (3.6); Zeitschätzung (4.6) |
| **Neue Hardware** (Ersatzgerät, P2V) | B mit Treibern aus dem Kit; A nur mit Inbox-Treibern | Vorabprüfung auf dem Ziel (4.6) dringend; Original läuft noch → `source_alive` bzw. Probewiederherstellung (4.6); Aktivierung, LAPS, Vertrauensstellung im Abschluss |
| **Update kaputt** (startet nicht oder Fehler nach dem Patch) | C2, wenn das System noch startet; sonst C1 vom Medium | Stand vor dem Update vorgeschlagen; aktuelle ESP bleibt, außer sie ist selbst beschädigt (C1); VBS-Anti-Rollback (4.1.3); BitLocker (3.6) |
| **Ransomware** | C1 vom Medium oder B/A auf eine leere Platte; kein C2 | Stand vor dem ersten Anzeichen (Hinweis auf Aktivitätswarnungen, BM 26.7); "Sicherung vorher" aus; Netz am Ziel bis zum Abschluss getrennt; Kennwörter danach ändern |
| **Datenbank defekt** | SQL-Restore der einen Datenbank (5.1.4), nicht der Rechner | Zeitpunkt im wiederherstellbaren Zeitraum; Restore unter neuem Namen als Vorgabe |
| **Datenvolume defekt oder verschlüsselt** | C3 (Gruppenprüfung) bzw. C4 für einen Ordner | Dienste auf dem Volume, Schattenkopien des Volumes gehen verloren |
| **DC tot** | bei mehreren DCs: neu aufsetzen und Metadaten bereinigen (Hinweis); sonst B/A mit nicht autoritativer Wiederherstellung | Tombstone-Sperre, SYSVOL-Synchronisierung (5.3); einziger DC: Verlust seit dem Stand |

### 4.6 Vorabprüfung, Zeitschätzung, Probewiederherstellung

- **Vorabprüfung auf der echten Zielhardware** ("beim ersten Mal richtig"): Medium (Kit oder ISO)
  auf dem Rechner bzw. der Ersatzhardware starten und nur planen (`--plan-only`, mit Code,
  ohne Freigabe zum Schreiben), Bericht an den Server. Das zeigt, dass Secure Boot das Medium
  annimmt, Platten, VMD und RAID sichtbar sind, die Netzwerkkarte geht und der Server
  erreichbar ist; die Startprobe prüft nur QEMU-Hardware. Ergebnis: Zustand
  "Zielhardware geprüft (<Datum>, <Modell>)" in der Bewertung. Der Assistent empfiehlt die
  Vorabprüfung nach jedem neuen Kit und für jede Ersatzhardware.
- **Zeitschätzung der Wiederherstellung** im Plan und auf der Rechnerseite: Bytes zu schreiben
  (belegte Bytes bzw. abweichende Blöcke beim Rollback) geteilt durch den gemessenen Durchsatz;
  der hängt an Entschlüsselung und Lieferung durch den Server, an der WAN-Strecke und an der
  Zielplatte. Die Startprobe misst den tatsächlichen Durchsatz der Lese-Route und gibt ihn mit
  aus; die Vorabprüfung misst die Strecke vom Ziel aus (kurzer Lesetest von einigen hundert MB).
  Die H-Fälle messen ihn auf echten Leitungen.
- **Probewiederherstellung neben dem laufenden Original:** Ein Admin, der auf Ersatzhardware
  üben will, während das Original weiterläuft, bekäme sonst einen Klon im Netz, der das
  Kennwort des Computerkontos und DNS-Einträge ändert, einen doppelten DC bildet und über die
  Wiederanbindung die Identität des Endpunkts übernimmt (das Original sichert dann nicht
  mehr). Darum:
  - Planoption "**Probewiederherstellung (Original läuft weiter)**": kein Rebind-Token (der
    Slot bleibt leer, der Klon sichert nicht), Hinweis "Netz am Ziel trennen", optional die
    Netzwerkkarten im wiederhergestellten System offline deaktivieren (nur über B mit
    `reg load`, bei A nur auf sauberer Hive).
  - Problem `source_alive` bei einer normalen Wiederherstellung auf andere Hardware, wenn das
    Original in den letzten 30 Minuten einen Heartbeat gesendet hat; außer der Bediener
    bestätigt, dass das Ziel netzisoliert ist, oder wählt die Probewiederherstellung.

## 5. Anwendungen

### 5.1 SQL Server (W2a, W2b)

Zwei Stufen: **W2a** (0.5.0 oder 0.5.1) ändert keine Kette des Kunden: COPY_ONLY-Full, Restore
unter neuem Namen, Restore-Skript für einen anderen Rechner, Prüfung mit CHECKDB. **W2b**
(0.5.1) bringt die riskanten Teile: eigene Log-Kette, Point-in-Time, Tail-Log, Restore über die
vorhandene Datenbank und die Aufbewahrung der Logs.

#### 5.1.1 Grundsatz

Die native Sicherung ist der einzige Weg, der auf jeder Edition (Express bis Enterprise)
**Point-in-Time** und **Einzel-Datenbank-Restore** gibt, ohne einen eigenen
VSS-Wiederherstellungs-Requester zu schreiben. Das Image (W4) bringt SQL-Datenbanken als Teil
des ganzen Rechners anwendungskonsistent zurück (SQL-Writer im Komponentenmodus, Kopie);
die native Sicherung bringt eine Datenbank zurück. Beide sind Kopie-Sicherungen und berühren die
Sicherungskette des Kunden nicht, solange "Restow führt die Log-Kette" aus ist.

Was nicht stimmt und darum nirgends behauptet wird: Eine VSS-Sicherung kürzt das
Transaktionslog von SQL Server nie, auch nicht als `VSS_BT_FULL`; nur `BACKUP LOG` kürzt
(Wiederherstellungsmodell FULL oder BULK_LOGGED) **[Win]**.

Unterstützt werden SQL Server 2016 bis 2025 einschließlich Express; geprüft wird in der CI mit
Express (2019 und 2022), auf echter Hardware mit 2019 Standard und 2022 Express (H5, H10).
Ältere Versionen laufen mit der Warnung "nicht geprüft".

#### 5.1.2 Verbindung und Rechte

- Verbindung über PowerShell 5.1 und `System.Data.SqlClient` (in .NET Framework auf jedem
  Windows ab 10/Server 2016, auch Server Core **[Win]**), über Shared Memory
  (`Data Source=lpc:.\<instanz>`), integrierte Anmeldung, `CommandTimeout = 0` (keine Grenze
  im Treiber, weil `BACKUP`, `RESTORE` und `CHECKDB` Stunden dauern können; die Zeitgrenze
  setzt der Agent selbst je Schritt und bricht über `SqlCommand.Cancel` ab). Das Skript ist fest im Agenten
  eingebettet (`agent/internal/sqlserver/sql.ps1`, `go:embed`), bekommt seine Eingabe als JSON
  auf stdin und gibt JSON-Zeilen aus; es läuft mit `-NoProfile -NonInteractive
  -ExecutionPolicy Bypass` über den vorhandenen PowerShell-Pfad (`internal/hooks/run_windows.go`),
  aber **nicht** als Hook (keine lokale Hook-Erlaubnis nötig, weil der Inhalt aus dem signierten
  Agenten kommt).
- **Grenzen dieses Wegs**, offen benannt: `System.Data.SqlClient` kann kein TDS 8 ("Strict
  Encryption", ab SQL Server 2022 als Servereinstellung) **[Win]**; ob das über Shared Memory
  greift, ist **[CI]**. WDAC oder der Constrained Language Mode verhindern `New-Object` für
  SqlClient. Das Skript prüft zuerst `$ExecutionContext.SessionState.LanguageMode` und meldet
  `sql_powershell_constrained` bzw. `sql_strict_encryption` mit Schritt. Rückfall (W2b, in H10
  getestet): ODBC über `odbc32.dll` per `syscall` aus dem Agenten selbst, mit "ODBC Driver 18
  for SQL Server", wenn installiert (kann TDS 8), sonst dem mitgelieferten `SQLSRV32` (kann
  kein TDS 8, hilft nur gegen WDAC/CLM).
- **Jeder T-SQL-Text ist fest**, Namen und Pfade gehen als Parameter (`SqlParameter`):
  `BACKUP DATABASE @db TO DISK = @path WITH COPY_ONLY, CHECKSUM, NO_COMPRESSION, INIT, FORMAT`,
  `RESTORE DATABASE @new FROM DISK = @path WITH MOVE @logical TO @file, …`,
  `DBCC CHECKDB (@db) WITH NO_INFOMSGS, ALL_ERRORMSGS` (Variablen in BACKUP, RESTORE und DBCC
  **[CI]**). Befehle, die keine Variablen für Namen annehmen (`ALTER DATABASE`,
  `DROP DATABASE`, `CREATE LOGIN`), laufen als fester T-SQL-Text, der den Befehl **auf dem
  Server** mit `QUOTENAME(@name)` zusammensetzt und mit `sp_executesql` ausführt. Im Client wird
  nie T-SQL aus Namen verkettet; ein Test sucht im Skript jede Verkettung in `CommandText`.
- Anmeldung: Der Prozess trägt die Dienst-SID `NT SERVICE\RestowAgent`. SQL Server ab 2012
  gibt weder SYSTEM noch den Administratoren sysadmin **[Win]**. Die Oberfläche zeigt einmal je
  Instanz einen T-SQL-Block zum Ausführen durch den DBA: `CREATE LOGIN [NT SERVICE\RestowAgent]
  FROM WINDOWS;` und dann entweder `ALTER SERVER ROLE sysadmin ADD MEMBER …` (Vorgabe, einfach)
  oder die kleine Variante (`dbcreator` plus `db_backupoperator` und `db_owner` je Datenbank;
  neue Datenbanken bekommen das nicht von selbst). Der Agent prüft die Rechte vor jedem Lauf
  (`IS_SRVROLEMEMBER`, `HAS_PERMS_BY_NAME`) und meldet `sql_login_missing` bzw.
  `sql_permission_missing` je Datenbank. Dass die Dienst-SID als Windows-Anmeldung über die
  lokale Verbindung greift, ist **[CI]**.
- Entdeckung: Instanzen aus `HKLM\SOFTWARE\Microsoft\Microsoft SQL Server\Instance Names\SQL`,
  Dienstkonto aus der Dienstkonfiguration (`QueryServiceConfigW`, in `winapi` vorhanden), dann
  `sys.databases` (Name, `family_guid` und `database_guid` aus `sys.database_recovery_status`, Zustand,
  Wiederherstellungsmodell, Verfügbarkeitsgruppe, TDE, Größe), `msdb.dbo.backupset` (letzte
  Sicherungen, auch fremde, nur zur Anzeige). Ergebnis als "SQL-Inventar" im Heartbeat
  (höchstens alle 6 Stunden, höchstens 64 KiB).

#### 5.1.3 Sicherung

- Neue Job-Einstellung je Rechner bzw. Instanz `sql: { enabled, databases: "all" | [...],
  exclude: [...], mode: "alongside" | "own_log_chain", logIntervalMinutes, stagingDir,
  verify: { schedule, maxGiB, physicalOnly } }`. Vorgabe: aus; mit Erkennung einer Instanz
  bietet die Job-Seite es an. W2a kennt nur `alongside`.
- **Full** je Datenbank: `COPY_ONLY, CHECKSUM, NO_COMPRESSION`. `NO_COMPRESSION` steht
  ausdrücklich da, weil sonst die Serveroption `backup compression default` komprimiert und die
  Deduplizierung verloren geht (H-Fall mit erzwungener Kompression). Ziel
  `<stagingDir>\<instanz>\<db>\full-<zeit>.bak`. `stagingDir` Vorgabe
  `C:\ProgramData\Restow\data\staging\sql` (fest, lokal, NTFS), DACL geschützt plus Schreibrecht
  für die Dienst-SID der SQL-Instanz (`NT SERVICE\MSSQLSERVER` bzw. `NT SERVICE\MSSQL$<name>`;
  SQL Server schreibt die Datei selbst) **[CI]**. Der Staging-Ordner ist im Image geschwärzt
  (3.4). Platzprüfung vorher aus der Größe der belegten Seiten; passt eine Datenbank nicht:
  `sql_staging_too_small`, kein stiller Rückfall.
- Dann **eigener restic-Snapshot** je Instanz und Lauf mit eigenem Codepfad: Die
  Ordnersicherung schließt über `platformBackupOptions` immer den ganzen `DataRoot` aus
  (`snapshot_windows.go:64`); der SQL-Snapshot übernimmt diese Ausschlüsse nicht. Quellen nur
  der Staging-Ordner, Tags `restow-sql`, `restow-sql-instance=<name>`, `--group-by host,tags`.
  Die Staging-Datei wird erst nach erfolgreichem Snapshot gelöscht. **Umsetzung W2a:** Auf jedem
  anderen Weg aus dem Lauf (jede `BACKUP` gescheitert, auch halb geschrieben bei vollem
  Laufwerk; Stopp oder `maxRunTime`; Snapshot gescheitert) löscht der Agent den Ordner der
  Instanz ebenfalls, denn der nächste Lauf schreibt die Dateien ohnehin neu; sonst belegten sie
  bis dahin das Staging-Volume.
- **Eigener `stagingDir` (Umsetzung W2a):** Der Ordner darüber muss existieren und die
  Vertrauensprüfung eines Restore-Ziels bestehen (`paths.TrustedDir`). Ein neuer Ordner wird mit
  Eigentümer Administratoren und geschützter DACL angelegt und bekommt die Markierungsdatei
  `.restow-sql-staging`; ein vorhandener gilt nur, wenn Eigentümer und DACL vertrauenswürdig sind
  (`paths.CheckTarget`) und er leer ist oder die Markierung trägt. Sonst `sql_staging_unusable`:
  ein fremder Ordner wird weder neu berechtigt noch geleert. Unterordner, die jemand anderes
  angelegt hat, lehnt `MkdirWithSIDs` ab (ein Eigentümer behält `WRITE_DAC`).
- **Sperren:** Der Agent erlaubt heute nur einen Lauf gleichzeitig (`lock.TryAcquire` auf
  `data\run.lock`, `core/backup.go:39`, `run.go:322`, `agent.go:845`). Ein `sql_log` alle 15
  Minuten fiele aus, solange ein Image-, Datei-, `sql_verify`- oder `kit_build`-Lauf über
  Stunden läuft: Lücke im RPO, wachsendes Log. Darum Sperrklassen (W2b): `run.lock` bleibt für
  Image-, Datei- und Kit-Läufe; `sql-<instanz>.lock` für `sql` (Full), `sql_log` und
  `sql_restore` derselben Instanz; `sql_verify` nimmt nur eine eigene Prüfsperre je Instanz.
  `sql_log` läuft damit parallel zu jedem Lauf der ersten Klasse (während eines VSS-Freeze
  wartet SQL Server mit dem Log-Backup selbst einige Sekunden **[Win]**). Ein `sql_log`, das
  seine Sperre nicht bekommt, wird nach 1 Minute wiederholt und nach dem Intervall als
  `sql_log_skipped` gemeldet.
- **Modus "neben der vorhandenen Sicherung"** (Vorgabe, W2a): nur Kopie-Fulls, keine Logs, kein
  Point-in-Time; die Ketten des Kunden bleiben unberührt. FULL-Datenbanken ohne
  Log-Sicherung durch irgendwen: Warnung `sql_log_growing`.
- **Modus "Restow führt die Log-Kette"** je Datenbank (W2b, nur FULL/BULK_LOGGED): erste Full
  ohne `COPY_ONLY`, dann `BACKUP LOG @db TO DISK = @path WITH CHECKSUM, NO_COMPRESSION` alle
  `logIntervalMinutes` (Vorgabe 15) als eigener kurzer Lauf `sql_log` ohne Image und ohne
  Ordner. **Fremde Log-Sicherungen** erkennt der Agent nicht über `msdb` (in
  Verfügbarkeitsgruppen hat jede Replik ihr eigenes `msdb`, und bereinigte Historie fehlt),
  sondern über `sys.database_recovery_status.last_log_backup_lsn`: weicht sie vom eigenen
  letzten `last_lsn` ab, hat jemand anderes eine Log-Sicherung gemacht, und der Lauf bricht mit
  `sql_foreign_log_backup` ab (die Kette wäre sonst gebrochen).
- **Kette auf dem Server:** Jede Sicherung meldet aus `msdb.dbo.backupset` und
  `RESTORE HEADERONLY` der eigenen Datei: `first_lsn`, `last_lsn`, `database_backup_lsn`,
  `checkpoint_lsn`, `fork_point_lsn`, `database_guid`, `family_guid`,
  `first_recovery_fork_guid`, `last_recovery_fork_guid`, `begins_log_chain`,
  `has_bulk_logged_data`, `is_copy_only`, Start, Ende, Größe, Pfad im Snapshot (Tabelle
  `endpoint_sql_backups`, Abschnitt 6.4). Der Server berechnet daraus den
  **wiederherstellbaren Zeitraum** je Datenbank und erkennt Lücken (`last_lsn` ≠ `first_lsn`
  des nächsten Logs, wechselnder Recovery-Fork; neue `family_guid` bei gleichem Namen =
  gelöschte und neu angelegte, also andere Datenbank mit eigener Kette): Lücke = rot mit Beleg. Logs mit `has_bulk_logged_data` erlauben kein
  `STOPAT` innerhalb ihres Intervalls **[Win]**; der Zeitraum nimmt diese Intervalle aus.
- **Image-Restore oder Rollback eines Rechners mit eigener Log-Kette** (A, B, C1 bis C3): Die
  Datenbank kommt auf einen älteren Stand zurück, ohne neuen Recovery-Fork; ihre LSNs werden
  wiederverwendet, und Logs des verworfenen Zweigs passen der LSN nach scheinbar weiter
  **[Win]**. Darum schließt der Server die Kette beim Start der Wiederherstellung
  (`sql.chain_closed`, Grund "Rechner aus Image wiederhergestellt"), und der Agent erzwingt im
  Modus "wiederhergestellt" (4.1.7) vor dem nächsten Log eine Full ohne `COPY_ONLY`. Der
  Abschluss warnt: "Sicherungsketten anderer Werkzeuge auf diesem Server sind ebenfalls
  ungültig; dort eine neue Full anlegen."
- Systemdatenbanken `master`, `model`, `msdb` werden mitgesichert (nur Full); ihr Restore ist
  dokumentiert, nicht automatisiert (Einzelbenutzermodus, Abschnitt 5.1.6).
- Datei-Ordner der Instanz (Daten und Logs aus `sys.master_files`) schließt die Ordnersicherung
  aus, sobald die native Sicherung an ist; sie sind dort nur doppelt und ohne Wert (Abschnitt
  3.8). Das Image enthält sie weiter (für den ganzen Rechner).
- Verfügbarkeitsgruppen: auf einer sekundären Replik nur `COPY_ONLY` (SQL lässt nichts anderes
  zu) und Logs nur, wenn `sys.fn_hadr_backup_is_preferred_replica` 1 ergibt; Failover-Cluster-
  Instanzen: erkannt, `sql_fci_unsupported` (erste Stufe).
- TDE: Warnung `sql_tde_certificate`, solange der Administrator nicht bestätigt hat, dass
  Zertifikat und Schlüssel gesichert sind; ohne sie geht ein Restore auf einer anderen Instanz
  nicht **[Win]**. Restow sichert das Zertifikat nicht (Geheimnisklasse, Frage 10).

#### 5.1.4 Einzel-Datenbank-Restore

- Oberfläche: Datenbank, Zeitpunkt (ein Sicherungsstand oder, ab W2b, eine Uhrzeit im
  wiederherstellbaren Zeitraum), Ziel: **neuer Name** (Vorgabe, W2a) oder **über die
  vorhandene** (W2b). Aufgabe `sql_restore` an den Agenten.
- Agent: benötigte Dateien (Full, Logs bis zum Zeitpunkt) mit `restic restore` aus den
  Snapshots in einen Restore-Staging-Ordner (DACL wie 5.1.3), dann `RESTORE FILELISTONLY` der
  Full als Quelle für `MOVE` (alle Dateien einschließlich FILESTREAM und speicheroptimierter
  Dateigruppe; nicht `sys.master_files`, das bei einem neuen Namen nichts weiß), dann
  `RESTORE DATABASE @new FROM DISK=@full WITH MOVE …, NORECOVERY, CHECKSUM`, je Log
  `RESTORE LOG @new FROM DISK=@log WITH NORECOVERY[, STOPAT=@t]`, zum Schluss
  `RESTORE DATABASE @new WITH RECOVERY`; optional `DBCC CHECKDB` (Vorgabe an bis `maxGiB`);
  Bericht mit Dauer, LSN, Ergebnis; Staging löschen.
- **Über die vorhandene** (W2b): frische Anmeldung, Eingabe des Datenbanknamens, Hinweis auf
  Verbindungen. Reihenfolge auf **derselben Verbindung**: zuerst
  `ALTER DATABASE … SET SINGLE_USER WITH ROLLBACK IMMEDIATE` (über `QUOTENAME`, 5.1.2), dann
  die **Tail-Log-Sicherung** (`BACKUP LOG @db TO DISK=@tail WITH NORECOVERY`, bei beschädigter
  Datenbank zusätzlich `NO_TRUNCATE`; sie braucht exklusiven Zugriff **[Win]**), die sofort wie
  jede Log-Sicherung in das Repository geht (damit ist der Schritt umkehrbar), dann
  `RESTORE … WITH REPLACE`. Im Modus "neben": `BACKUP LOG … WITH COPY_ONLY, NORECOVERY` lässt
  die Kette des Kunden unberührt und macht den Schritt ebenfalls umkehrbar (**[CI]**: dass SQL
  Server diese Kombination auf jeder unterstützten Version annimmt). Nur bei
  Wiederherstellungsmodell SIMPLE gibt es kein Tail-Log; dann sagt der Dialog "Änderungen seit
  der Sicherung gehen verloren".
- Eine Datenbank in einer Verfügbarkeitsgruppe lässt sich nicht überschreiben; Problem
  `sql_ag_restore_blocked` mit dem Schritt "erst aus der Verfügbarkeitsgruppe entfernen".
- Verwaiste Benutzer nach einem Restore auf einer anderen Instanz: Hinweis mit
  `ALTER USER … WITH LOGIN`.
- **Restore auf einen anderen Rechner** (Server tot, W2a): ohne neuen Lesezugang über
  Rechnergrenzen. Die Oberfläche bietet je Datenbank und Zeitpunkt ein **Restore-Skript** zum
  Herunterladen an: die Liste der Dateien im Snapshot mit SHA-256, die Befehle zum Holen mit
  `restow-restore` bzw. restic (Repository-Zugang wie beim Datei-Restore), und die geordnete
  `RESTORE`-Folge nach LSN mit `MOVE` aus `FILELISTONLY` und, ab W2b, `STOPAT`. Der Weg ist
  dokumentiert und in der CI getestet (8.2). Ein Assistent mit Lesezugang des Zielrechners
  folgt später (wie die Migrationssitzung BM 13.6).
- **Umsetzung W2a, Name und Aufräumen:** `RESTORE` prüft den Namen im selben Batch
  (`IF DB_ID(@new) IS NOT NULL THROW 50003`), eine Datenbank, die seit dem Nachsehen entstanden
  ist, wird also nie berührt. Nach einem gescheiterten oder abgebrochenen `RESTORE` (Fehler,
  Zeitgrenze, Absturz des Skripts, Stopp) löscht der Agent den neuen Namen nur, solange er im
  Zustand `RESTORING` ist (`DropRestoring`, bei einem Stopp mit eigenem kurzem Kontext); eine
  Datenbank in jedem anderen Zustand bleibt, und der Lauf nennt sie mit Zustand und Dateien.
- **Umsetzung W2a, Restore-Skript:** Es legt immer einen neuen eigenen Ordner
  `restow-sql-restore-<guid>` unter `-StagingDir` (ein vorhandener Ordner) oder unter `TEMP` an,
  mit geschützter DACL: Vollzugriff für SYSTEM, Administratoren und den ausführenden Benutzer,
  Lesen für die Dienst-SID der Zielinstanz (aus `-Instance` abgeleitet, `-SqlServiceAccount`
  überschreibt), die die Datei mit ihrem eigenen Konto öffnet. restic 0.19.1 stellt die
  gesicherten Security Descriptors über das Geholte (WINDOWS-AGENT.md); die Staging-Ordner des
  Agenten geben nur der Dienst-SID der Quellinstanz Lesen. Darum setzt das Skript direkt nach
  `restic restore`, vor dem Hash und vor `RESTORE FILELISTONLY`, auf jedes geholte Element die
  DACL seines Ordners (`Set-RestowStagingAccess`: von oben nach unten, ein Ordner wird erst nach
  dem Setzen gelesen, ein Link bricht ab wie `SetReadSIDs` im Agenten). Gelöscht wird am Ende nur
  dieser Ordner, nie der angegebene.

#### 5.1.5 Point-in-Time (W2b)

- Nur im Modus "Restow führt die Log-Kette". Der Zeitraum reicht von der ältesten
  aufbewahrten Full mit lückenloser Log-Folge bis zur letzten Log-Sicherung, ohne die
  Intervalle von Logs mit Bulk-Logged-Daten (5.1.3).
- **Aufbewahrung:** Logs werden nie einzeln nach der Regel des Jobs entfernt. Der Server
  behält jede Log-Sicherung, die für eine aufbewahrte Full innerhalb des eingestellten
  Point-in-Time-Fensters (Vorgabe 7 Tage) gebraucht wird, und entfernt Logs erst mit ihrer Full
  (`apps/worker/src/endpoints/retention.ts`, Schutz über die Tags und `endpoint_sql_backups`).
  In W2a folgen die Fulls der normalen Regel des Jobs.
- Bei einem Ausfall des Rechners endet der Zeitraum an der letzten hochgeladenen Log-Sicherung;
  die Oberfläche nennt sie ("Datenverlust höchstens bis …").

#### 5.1.6 Grenzen in der ersten Stufe

Kein Restore von `master` als Automatik (Einzelbenutzermodus; die Doku beschreibt den Weg), keine
Failover-Cluster, keine Automatisierung von Verfügbarkeitsgruppen, kein Streaming ohne Staging
(VDI, später, W10), keine Snapshot-Sicherung mit `SUSPEND_FOR_SNAPSHOT_BACKUP` (ab SQL Server
2022, später, baut auf dem eigenen Requester auf).

#### 5.1.7 Prüfung ("Grün ist Beweis", W2a)

- Aufgabe `sql_verify` je Datenbank nach Plan (Vorgabe wöchentlich, außerhalb der
  Geschäftszeiten, je Instanz eine gleichzeitig): die neueste Full **aus dem Repository**
  zurückholen (nicht aus dem Staging), bei eigener Log-Kette alle Logs bis zur neuesten dazu,
  `RESTORE … AS <db>__restow_verify_<zeit> WITH MOVE … (aus FILELISTONLY), RECOVERY`, dann
  `ALTER DATABASE … SET NEW_BROKER` (die Prüfkopie darf keine Service-Broker-Nachrichten der
  Produktion empfangen oder senden), `DBCC CHECKDB WITH NO_INFOMSGS, ALL_ERRORMSGS` (über
  `maxGiB` mit `PHYSICAL_ONLY`, Vorgabe 200 GiB), dann `DROP DATABASE`. Platzbedarf etwa die
  Datengröße; vorher geprüft (`sql_verify_no_space`: unvollständig, nicht rot). **Umsetzung
  W2a:** Die Platzprüfung von Prüfung und Restore hält auf jedem berührten Volume eine Reserve
  frei, `ReserveBytes` (1 GiB) und auf den Volumes der Daten- und Log-Dateien (meist die der
  Produktion, deren Autogrowth weiterlaufen muss) das Größere von 1 GiB und einem Zehntel des
  Volumes.
- Bericht neuer Art `sql_verify` je Datenbank: `{ method: "restore+checkdb", ok, durationMs,
  errors, backupLsn, logsApplied, physicalOnly }`. **Grün** nur mit fehlerfreiem CHECKDB der aus
  dem Repository zurückgeholten Sicherung. `RESTORE VERIFYONLY` zählt als "lesbar", nie als
  bewiesen. Rot nur mit Beleg (CHECKDB-Fehler, `RESTORE` scheitert an der Sicherung selbst, z. B.
  Prüfsummenfehler); Platz, Rechte, Zeitgrenze sind unvollständig. **Umsetzung W2a:** Das Skript
  urteilt nicht; es meldet die TABLERESULTS-Zeilen und getrennt die Fehler, die SQL Server
  während CHECKDB ausgelöst hat. `JudgeCheckdb` im Agenten (`internal/sqlserver/checkdb.go`)
  zählt als Beleg nur die Zeilen (ohne Abbruchmeldungen und die Summe 8989) und ausgelöste
  Fehler aus einer Liste von Konsistenzfehlern (8900 bis 8999 ohne 8921, 8967 und 8989; die
  Tabellenfehler der 25xx wie 2533; 211, 824, 3853 bis 3856, 5242, 5243, 7965, 7984 bis 7988,
  7995). Alles andere heißt, CHECKDB lief nicht zu Ende: unvollständig, bei Platzfehlern (1105,
  1101, 9002, 8921, 1823, 1824, 665, 5128) mit `sql_verify_no_space`, sonst mit
  `sql_script_failed` (701, 2520, 5030, 7928, abgebrochene Verbindung, Unbekanntes).
- SQL-Bewertung je Datenbank in der Oberfläche: `not_protected`, `unverified`, `green`,
  `red`, `overdue` (älter als 8 Tage), daneben der wiederherstellbare Zeitraum.
- Bleibt eine Prüfdatenbank nach einem Absturz liegen, erkennt der Agent sie am Präfix
  `__restow_verify_` und entfernt sie vor der nächsten Prüfung.

### 5.2 Exchange

- **Im Image (W4):** Der Exchange-Writer (im Informationsspeicher) ist im Komponentenmodus
  gewählt, die Datenbanken sind im Image anwendungskonsistent; der ganze Server kommt über A,
  B, C zurück **[Maschine]**.
- **Log-Kürzung:** Exchange kürzt seine Logs nur nach einer komponentenbasierten
  `VSS_BT_FULL`- oder `INCREMENTAL`-Sicherung mit `SetBackupSucceeded` und `BackupComplete`
  **[Win]**. Restow sichert mit Kopie; die Logs wachsen, bis die Platte voll ist, außer bei
  Umlaufprotokollierung. Darum in der ersten Stufe: Warnung `exchange_no_log_truncation` mit
  "vorhandene Sicherungslösung für Exchange behalten oder Umlaufprotokollierung einschalten
  (dann kein Point-in-Time)".
- **Später (W10):** Einstellung `vssBackupType: "full"` je Rechner mit Bestätigung (sie macht
  Restow zur Sicherung, auf die Exchange sich verlässt); Restore einer Datenbank als Dateien,
  `eseutil /mh` und `/r` bis "Clean Shutdown", Wiederherstellungsdatenbank
  (`New-MailboxDatabase -Recovery`), Postfach-Restore (`New-MailboxRestoreRequest`) als
  Assistent; DAG über eine passive Kopie.
- **DAG und mehrere Exchange-Server:** Bei einem DAG-Mitglied oder in einer Organisation mit
  mehreren Exchange-Servern passt ein älteres Image nicht mehr zur Konfiguration im AD; der
  unterstützte Weg ist `Setup /m:RecoverServer` mit anschließendem Reseed der Kopien **[Win]**.
  Warnung `exchange_dag_member` in `Assess` und im Plan; für solche Server empfiehlt der
  Assistent "Server neu aufsetzen mit RecoverServer" statt Image-Restore.

### 5.3 Active Directory

- **Erkennung** (W1): `ProductType = LanmanNT`; Warnung schon heute "Eine Dateisicherung ist
  keine AD-Sicherung".
- **Im Image (W4):** NTDS-Writer im Komponentenmodus (Systemzustand, 3.3), `ntds.dit`, Logs und
  SYSVOL konsistent; fehlt der Writer, `vss_writer_missing`.
- **Wiederherstellung (A, B, C1, C2, jede):** offline `Services\NTDS\Parameters\Database
  restored from backup = 1` in der SYSTEM-Hive des wiederhergestellten Systems, auch beim
  Rollback auf demselben Rechner ohne Controllerwechsel. Beim Start bekommt der DC eine neue
  Invocation-ID und repliziert die neueren Änderungen von seinen Partnern (nicht autoritativ)
  **[Win]** **[Maschine]**. Ohne diesen Wert droht ein USN-Rollback, der die Replikation
  dauerhaft stört **[Win]**. Mit A setzt das eine saubere Hive und ein sauberes NTFS im Image
  voraus (4.1.5); sonst B.
- **SYSVOL (DFSR):** Der NTDS-Wert macht DFSR **nicht** nicht autoritativ. Die DFSR-Datenbank
  liegt auf dem Volume und kommt mit alten Versionsvektoren zurück; Folge wären
  wiederverwendete Versionen, still fehlende Replikation und alte GPOs **[Win]**. Darum ist die
  **nicht autoritative SYSVOL-Synchronisierung** ein Pflichtschritt nach dem ersten Start
  (KB 2218556): auf dem Abonnement-Objekt dieses DC
  (`CN=SYSVOL Subscription,CN=Domain System Volume,CN=DFSR-LocalSettings,CN=<DC>,…`)
  `msDFSR-Enabled = FALSE`, AD-Replikation anstoßen, auf Ereignis 4114 warten, dann
  `msDFSR-Enabled = TRUE`, auf 4614 und 4604 warten (`wevtutil qe` mit fester Abfrage). Der
  wiederhergestellte Agent führt das aus (Vorschlag, Frage 21: automatisch, abschaltbar je Rechner;
  festes PowerShell-Skript mit `[ADSI]`, Rechte des DC-Computerkontos **[Maschine]**) und
  meldet "SYSVOL repliziert" oder die Schritte von Hand. Einziger DC der Domäne: kein Partner,
  die Synchronisierung entfällt mit Hinweis. Ausnahme: P2V bzw. Wiederherstellung in eine VM
  mit geänderter VM-Generation-ID (PVE `vmgenid`, Hyper-V) erkennt Windows selbst und setzt
  NTDS und DFSR zurück **[Win]**; der Agent prüft dann nur die Ereignisse.
- **Sperren:** Stand älter als die Tombstone-Lebensdauer (gelesen beim Erfassen über
  `[ADSI]` aus `tombstoneLifetime` an
  `CN=Directory Service,CN=Windows NT,CN=Services,CN=Configuration,…`) → Problem
  `dc_tombstone_expired` vor dem Löschen. Fehlt das Attribut, gelten 60 Tage **[Win]**; ist
  nichts lesbar, nimmt der Agent ebenfalls 60 Tage an (die kleinere, sichere Zahl). Einziger DC
  der Domäne: Warnung "Änderungen seit dem Stand sind verloren". Virtualisierte DCs mit
  VM-Generation-ID sind zusätzlich geschützt **[Win]**.
- **Probewiederherstellung neben dem laufenden DC** erzeugt einen doppelten DC im Netz:
  `source_alive` (4.6) ist bei DCs ein Problem, nicht nur eine Warnung; nur netzisoliert.
- **Autoritativ** (Objekte nach Löschen wiederherstellen): nicht automatisiert. Die Doku
  beschreibt: nach der nicht autoritativen Wiederherstellung im Verzeichnisdienst-
  Wiederherstellungsmodus starten (`bcdedit /set safeboot dsrepair`, DSRM-Kennwort nötig),
  `ntdsutil "authoritative restore"`, SYSVOL autoritativ nur auf einem DC.
- **Praxis-Hinweis** im Assistenten (Szenario "DC tot", 4.5): Bei mehreren DCs ist ein
  defekter DC meist schneller neu aufgesetzt (Metadaten bereinigen) als wiederhergestellt; die
  Wiederherstellung ist für den einzigen DC, für die Gesamtstruktur und für gelöschte Objekte
  ohne AD-Papierkorb.
- **Später (W10):** Einzelobjekte über `ntdsutil "ac i ntds" "ifm" "create sysvol full <dir>"`
  und `dsamain` (nur lesend, Export), kein DC-Restore.

### 5.4 Hyper-V-Host

Der Hyper-V-Writer ist ausgeschlossen (3.3); VM-Dateien im Image sind absturzkonsistent. Warnung
`hyperv_host_vm_files`: "VMs auf diesem Host bitte je VM sichern". Später je VM über WMI mit
Produktions-Prüfpunkten und Resilient Change Tracking, wie die PVE-Integration, nicht über
Dateien.

## 6. Änderungen

### 6.1 Agent (`agent/`)

| Ort | Änderung | W |
| --- | --- | --- |
| `internal/sysinfo/sysinfo_windows.go` | Version, Build, Edition, Produkttyp, Core/Desktop aus der Registry; Rollen (SQL, Exchange, Hyper-V, AD DS, DFSR); BitLocker-Zusammenfassung; im Heartbeat (`machine.windows`) | W1 |
| `internal/winapi` | Registry lesen über die vorhandenen `syscall`-Funktionen (`RegOpenKeyEx`, `RegQueryValueEx`, `RegEnumKeyEx`, `RegQueryInfoKey`, `RegCloseKey`) plus nachgeladen `RegEnumValueW`, `RegFlushKey`; `DeviceIoControl` aus `syscall` mit den IOCTLs/FSCTLs aus 3.2 bis 4.3; nachgeladen nur die Liste aus 1.4 (Volumes, `GetDiskFreeSpaceExW`, `VirtualAlloc`, ole32 mit `CoInitializeSecurity`, VssApi.dll, Firmware, iphlpapi, `InitiateShutdownW` erst W9). Keine Registry-**Schreib**funktion im Agenten; die einzige Schreibaktion im laufenden System ist die Opt-in-Vorbereitung über `reg.exe` (4.1.5, Frage 20) | W1, W3, W4, W9 |
| `internal/svc/windows.go` | Privilegienliste um `SeSystemEnvironmentPrivilege` (UEFI-Variablen lesen, W3) und erst für C2 um `SeShutdownPrivilege` (W9) erweitern; die Startprobe braucht es nicht mehr (4.4.2); die Selbstaktualisierung setzt die Liste mit `ChangeServiceConfig2W` neu (wirkt nach dem Neustart) | W3, W9 |
| `internal/sqlserver` (neu) | Skript, Entdeckung, Rechteprüfung, Full, Restore unter neuem Namen, Restore-Skript, Prüfung, Aufräumen (W2a); Log-Kette, Tail-Log, REPLACE, ODBC-Rückfall (W2b); reine Logik (LSN-Kette mit Forks, Planung der Restore-Schritte) ohne Build-Tag | W2a, W2b |
| `internal/lock`, `internal/core` (Sperren) | Sperrklassen: `run.lock` (Image, Dateien, Kit), `sql-<instanz>.lock` (Full, Log, Restore), Prüfsperre je Instanz (5.1.3) | W2b |
| `internal/vss` (neu) | Requester und Hilfsprozess `vss-hold` (3.3) | W3 |
| `cmd/restow-agent` | Unterbefehl `vss-hold` (nur vom Dienst gestartet, prüft den Elternprozess); `prepare-hardware-change on|off` (4.1.5) | W3, W4 |
| `internal/baremetal` | `WindowsLayout`, `capture_windows.go`, `assess_windows.go`, `fingerprint_windows.go`, `fat.go` (W3); `plan_windows.go` und `baremetal plan --platform windows` (W4, für WL3); Windows-Zweig in `CheckChain` (W4); `BuildLoadOption` aus M4 bzw. eigene Fassung in W8 | W3, W4, W5, W8 |
| `internal/winimage` (neu) | Bitmap, Endbereich, `$BadClus`, Schwärzung, Fakten aus dem Snapshot, ausgerichtete Puffer, Blockstrom, Block-Schreiber, Rollback-Vergleich, Slot-Schreiber | W4, W5, W7b, W8 |
| `internal/blockfmt` (neu, aus `internal/pve/formats.go`) | Blockformat ohne Build-Tag, reiner Umbau ohne Verhaltensänderung (W4a); Client für die Image-Routen (W4) | W4a, W4 |
| `internal/core` | Windows-Zweig von `wholeMachineApplies` und `fsPrepare` (Image-Teil vor dem Datei-Teil), Berichtsfelder, `postRestore`-Liste, Probemodus, `prepareRollbackTarget`, Restore an den Originalort | W4 bis W8, W7a |
| `internal/state` | `state.json` und Temp-Datei mindestens 4 KiB; Slot-Dateien `rebind.slot`, `probe.slot` (64 KiB, nicht resident); Erkennung "aus Image wiederhergestellt" (Datei aus Nullen) **vor jedem `Load`-Fehlerpfad und vor jedem `Save`** (heute meldet `state.Load` "re-enroll", `state.go:95-97`); lokale Erlaubnisse aus `state.json` in `local-policy.json` (nicht geschwärzt) umziehen, mit Übernahme beim ersten Start | W4 |
| `internal/hooks/policy.go` | liest die Hook-Erlaubnis aus `local-policy.json` (heute `state.json`, `policy.go:15`) | W4 |
| `internal/winpe`, `internal/isowriter` (neu) | Kit-Bau, ISO-Schreiber (ISO 9660, Joliet, El Torito, UDF-Brücke, falls die CI sie verlangt, 4.2.1) | W8 |
| `cmd/restow-agent/recover*.go` | `recover_windows.go` (B, W8); Windows-Zweig in `recover` (A, W5) | W8, W5 |
| `internal/rollback` (neu, `//go:build windows`) | C2: Kit bereitstellen, BCD-Eintrag, BitLocker aussetzen, Neustart (W9); C3 mit Sperren, Aushängen, Löschen der Schattenkopien (W7b) | W7b, W9 |
| `internal/core/config` | `restow-agent config allow-rollback on|off` (lokal, in `local-policy.json`, wie die Hook-Erlaubnis) | W7a |
| `install/windows.ps1` | Schalter `-AllowRollback`; Hinweis auf SQL-Anmeldung | W2a, W7a |

### 6.2 Vertrag Agent/Server (`agent/internal/api`, docs/AGENT.md)

- `FinishRequest.Consistency` bekommt `writers: [{ name, id, state, hresult, failureText,
  phase: "snapshot" | "complete", components }]` (höchstens 64), `missingWriters: [name]`,
  `snapshotSetId`, `snapshotAt`; ein älterer Server ignoriert sie.
- `FinishRequest.Image`: `{ imageId, volumes: [{ key, bytesUsed, blocksRead, blocksUploaded,
  durationMs, method: "vss" | "raw", badClusters, readErrors }], facts: { hives, ntfs, slots,
  bitlockerMetadata }, warnings }`.
- `FinishRequest.Sql` (Lauf `sql` und `sql_log`): je Datenbank die Felder aus 5.1.3.
- Heartbeat: `machine.windows` (W1), `sqlInventory` (W2a), `rollbackAllowed`,
  `hardwareChangePrepared` (W4, W7a).
- Aufgaben: `sql_restore`, `sql_verify` (W2a), `kit_build` (W8), `rollback_prepare` (C2),
  `volume_rollback` (C3), `folder_rollback` und `restore_in_place` (W7a).
- Fehler- und Warncodes (neu): `image_failed`, `image_shadow_lost`, `image_snapshot_unavailable`,
  `image_read_errors`, `bad_clusters_masked`, `vss_writer_failed`, `vss_writer_missing`,
  `vss_hung`, `vss_helper_crashed`, `win_system_state_incomplete`, `raw_volume_changing`,
  `esp_bcd_dirty`, `hive_dirty`, `ntfs_unclean`, `bitlocker_locked`, `bitlocker_converting`,
  `bitlocker_layout_changed`, `duplicate_disk_identity`, `source_alive`,
  `secure_boot_ca2023_missing`, `vbs_rollback_protection`, `rollback_splits_application`,
  `rollback_ram_too_small`, `volume_hosts_shadow_storage`, `laps_password_stale`,
  `exchange_dag_member`, `sql_login_missing`, `sql_permission_missing`,
  `sql_staging_too_small`, `sql_foreign_log_backup`, `sql_log_skipped`, `sql_verify_no_space`,
  `sql_powershell_constrained`, `sql_strict_encryption`, `sql_ag_restore_blocked`,
  `kit_no_winre`, `rollback_not_allowed`, `rollback_aborted`; Katalog in `packages/core` mit
  Schritten je verfügbarem Weg (Abschnitt 4).

### 6.3 Server

`packages/core`:

- `endpoints/baremetal/manifest.ts`: `windowsLayoutSchema`; `fingerprint.ts`, `summary.ts`,
  `readiness.ts` für Windows; Testdaten aus dem Agenten (wie M1).
- `blockstore/` (neu, aus `pve/`): Blockformat, Prüfung beim Hochladen, Block-Maps, synthetischer
  Vollstand, Stichproben; die PVE-Integration nutzt es weiter unverändert.
- `pve/guestfs/regf.ts` (neu); `ntfs.ts` und `fat.ts` bekommen den Zugriff über eine Block-Map
  eines Image-Stands (heute über die einer VM-Platte).
- `endpoints/sql/` (neu): Schema des Inventars, LSN-Kette, Zeitraum, Lücken, Bewertung.
- `endpoints/baremetal/windows-check.ts`: Stufe 1 Windows (4.4.1).
- Alarme: `baremetal.secret_in_image` (Sicherheit), `endpoint.bitlocker_off_after_restore`,
  `endpoint.bitlocker_unescrowed`, `endpoint.rollback.requested`, `endpoint.rollback.finished`,
  `sql.red`, `sql.recovered`, `sql.overdue`, `sql.chain_broken`, `sql.chain_closed`.
- Katalog der Meldungen mit Texten je verfügbarem Weg (Abschnitt 4).

`apps/api`:

- `features/endpoints/baremetal.ts` (W3): die Ablehnung `platform !== "linux"` an Zeile 124
  (`layout refused`) wird zu "Linux oder Windows" (macOS weiter mit eigener Meldung), und
  `snapshotHintOf` an Zeile 246 bekommt einen Windows-Zweig (Hinweis `vss_low_space` statt
  `vg_no_space`). Ohne diese zwei Stellen nützt die Migration W3 nichts.
- `/agent/v1/images`: `POST /runs` (öffnet einen Image-Lauf zum Lauf `runId`, nennt je Volume
  Basisstand und `hashesDigest`), `GET /runs/:id/volumes/:key/hashes`,
  `PUT /runs/:id/volumes/:key/blocks` (RSBF, bis 16 Blöcke), `PUT /runs/:id/volumes/:key/mask`,
  `POST /runs/:id/commit`; Basic `<endpointId>:<secret>`, nur anhängen, Body-Grenzen wie die
  Node-Route. `GET /images/:imageId/volumes/:key/hashes|blocks|mask` für C3 (eigener Rechner,
  nur lesen).
- `/agent/recovery/images/:sessionId/*` (neu, Prinzipal `reader` wie die restic-Route aus M3):
  `GET manifest`, `GET volumes/:key/hashes|mask|blocks?from=&count=`, Ratenbegrenzung je
  Sitzung wie BM 9.6, Ende mit `release`.
- `/api/v1/endpoints/:id/sql/*`: Inventar, Sicherungen, Zeitraum, `POST restore`,
  `POST verify`; Rechte "Administrator" für Restore, frische Anmeldung beim Überschreiben.
- `/api/v1/endpoints/:id/rollbacks`: `POST` (Stand, Art `system`/`volume`/`folder`, Ziel,
  Volumes der Gruppe, `backupBefore`), `GET`, `POST :id/cancel`; frische Anmeldung,
  Bestätigung, Grenzen, Gruppenprüfung (4.3).
- `/api/v1/endpoints/:id/restores` (W7a): Ziel `original` mit `overwrite | missing_only`.
- `/api/v1/endpoints/:id/sql/:db/restore-script` (W2a): Skript für einen anderen Rechner
  (5.1.4), Audit.
- Vorabprüfung (4.6): Recovery-Sitzung im Modus `plan_only` (kein Lesezugang auf Blöcke außer
  einem Durchsatztest), Bericht "Zielhardware geprüft".
- `/api/v1/endpoints/:id/recovery-kit`: Zustand, `GET download` (frische Anmeldung, Audit).
- Recovery-Code (BM 9.2): Bedingung "Linux" wird zu "Linux oder Windows mit Image-Stand".

`apps/worker` und `apps/scheduler`:

- `baremetal-check` mit Windows-Zweig; `boot-probe` mit Windows-Zweig (Labor, 4.4.2).
- `retention.ts`: Image-Stände nach der Regel des Jobs (wie restic-Snapshots, eigener
  Zähler), Freigabe der Chunk-Referenzen wie bei PVE; SQL-Logs nach 5.1.5; Sperre während einer
  Sitzung (BM 9.7) auch für Image-Stände.
- Planung von `sql_verify` und `kit_build`; Monitor für Rollback-Sitzungen.
- Stichprobenprüfung der Image-Stände (wie `pve`-Restore-Check, 1 % der belegten Blöcke, mind.
  64).

Größenordnung (Schätzung): 100 Windows-Rechner mit je 5 GB geänderten Blöcken am Tag sind
500 GB Eingang am Tag durch die API (prüfen, zerlegen, verschlüsseln); das entspricht einer
mittleren PVE-Installation. docs/SIZING.md bekommt eine Zeile.

### 6.4 Datenbank: eine Migration je Meilenstein

Nummern: die nächsten freien beim Merge. 0079 ist vergeben
(`0079_endpoint_recovery_log_key_block`); BM 26 plant für M5 und M6 noch 0079 und 0080, beide
bekommen beim Merge ebenfalls die nächsten freien Nummern, und die Windows-Migrationen folgen
danach. Wie BM 14.2: `ADD VALUE` vorn und ohne Verwendung in derselben Migration, jede Migration
einzeln auf ihren Vorgänger getestet. **Row Level Security** steht nicht in der Migration,
sondern nach der Konvention des Repositories in `packages/db/sql/rls.sql`: die neuen Tabellen
`endpoint_sql_databases`, `endpoint_sql_backups`, `endpoint_images`,
`endpoint_image_run_blocks` und `endpoint_recovery_kits` kommen in die Liste `tenant_tables`
(dort neben `endpoint_layouts` und `endpoint_recoveries`, BM 25.C).

**W1:** keine Migration (Felder im JSON von `endpoints.settings.agent.machine`).

**W2a (`sql`):** (die Spalten der Kette kommen schon hier, damit W2b keine Migration auf
gefüllte Tabellen braucht; umgesetzt als `0089_endpoint_sql.sql` mit den Ergänzungen aus
Abschnitt 12.2, C1)

```sql
ALTER TYPE "public"."endpoint_report_kind" ADD VALUE 'sql_verify';--> statement-breakpoint
CREATE TABLE "endpoint_sql_databases" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "endpoint_id" uuid NOT NULL REFERENCES "endpoints"("id") ON DELETE CASCADE,
  "instance" text NOT NULL,
  "database" text NOT NULL,
  "family_guid" uuid NOT NULL,               -- bleibt über Restores gleich, neu bei CREATE
  "database_guid" uuid NOT NULL,             -- aktueller Wert aus sys.database_recovery_status (neu nach jedem Restore)
  "recovery_model" text NOT NULL,
  "mode" text NOT NULL DEFAULT 'alongside' CHECK ("mode" IN ('alongside', 'own_log_chain', 'off')),
  "chain_closed_at" timestamptz,             -- Image-Restore/Rollback, fremde Log-Sicherung
  "dropped_at" timestamptz,                  -- Datenbank auf dem Rechner nicht mehr vorhanden
  "facts" jsonb NOT NULL DEFAULT '{}',       -- Größe, AG, TDE, Zustand
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
-- eine gelöschte und neu angelegte Datenbank gleichen Namens ist eine andere Zeile (andere
-- family_guid); eine Kopie unter neuem Namen ebenfalls (anderer Name, gleiche family_guid)
CREATE UNIQUE INDEX "endpoint_sql_databases_uq" ON "endpoint_sql_databases" ("endpoint_id", "instance", "database", "family_guid");--> statement-breakpoint
CREATE TABLE "endpoint_sql_backups" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "database_id" uuid NOT NULL REFERENCES "endpoint_sql_databases"("id") ON DELETE CASCADE,
  "run_id" uuid REFERENCES "endpoint_runs"("id") ON DELETE SET NULL,
  "kind" text NOT NULL CHECK ("kind" IN ('full', 'log', 'tail')),
  "copy_only" boolean NOT NULL,
  "restic_snapshot_id" text NOT NULL,
  "path_in_snapshot" text NOT NULL,
  "first_lsn" numeric(25,0) NOT NULL,
  "last_lsn" numeric(25,0) NOT NULL,
  "database_backup_lsn" numeric(25,0),
  "checkpoint_lsn" numeric(25,0),
  "fork_point_lsn" numeric(25,0),
  "database_guid" uuid NOT NULL,
  "family_guid" uuid NOT NULL,
  "first_recovery_fork_guid" uuid,
  "last_recovery_fork_guid" uuid,
  "begins_log_chain" boolean NOT NULL DEFAULT false,
  "has_bulk_logged_data" boolean NOT NULL DEFAULT false,
  "backup_start" timestamptz NOT NULL,
  "backup_finish" timestamptz NOT NULL,
  "bytes" bigint NOT NULL,
  "status" text NOT NULL DEFAULT 'active' CHECK ("status" IN ('active', 'pruned')),
  "created_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE INDEX "endpoint_sql_backups_chain_idx" ON "endpoint_sql_backups" ("database_id", "first_lsn");
```

**W2b:** keine (Modus `own_log_chain`, Kinds `log` und `tail` sind schon erlaubt).

**W3 (`windows_layout`):**

```sql
ALTER TABLE "endpoint_layouts" DROP CONSTRAINT "endpoint_layouts_platform_ck";--> statement-breakpoint
ALTER TABLE "endpoint_layouts" ADD CONSTRAINT "endpoint_layouts_platform_ck"
  CHECK ("platform" IN ('linux', 'darwin', 'windows'));
```

**W4 (`endpoint_images`):**

```sql
CREATE TABLE "endpoint_images" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "endpoint_id" uuid NOT NULL REFERENCES "endpoints"("id") ON DELETE CASCADE,
  "run_id" uuid REFERENCES "endpoint_runs"("id") ON DELETE SET NULL,
  "layout_id" uuid REFERENCES "endpoint_layouts"("id") ON DELETE SET NULL,
  "sequence" integer NOT NULL,
  "status" text NOT NULL DEFAULT 'open' CHECK ("status" IN ('open', 'active', 'pruned', 'condemned')),
  "manifest_path" text,                      -- maßgeblich im Speicherziel, wie pve_snapshots
  "volumes" jsonb NOT NULL DEFAULT '[]',     -- je Volume Schlüssel, Größe, Cluster, Hashlisten-Digest, Masken-Objekt
  "consistency" jsonb,                       -- writers, snapshotSetId, snapshotAt
  "kind" text NOT NULL DEFAULT 'scheduled' CHECK ("kind" IN ('scheduled', 'pre_rollback')),
  "chunk_refs" integer NOT NULL DEFAULT 0,
  "base_image_id" uuid,
  "byte_size" bigint NOT NULL DEFAULT 0,
  "verify" jsonb,
  "backup_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE UNIQUE INDEX "endpoint_images_seq_uq" ON "endpoint_images" ("endpoint_id", "sequence");--> statement-breakpoint
CREATE TABLE "endpoint_image_run_blocks" (   -- wie pve_run_blocks, bis zum commit
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "image_id" uuid NOT NULL REFERENCES "endpoint_images"("id") ON DELETE CASCADE,
  "volume_key" text NOT NULL,
  "block_index" bigint NOT NULL,
  "sha256" text NOT NULL,
  "chunk_ids" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE UNIQUE INDEX "endpoint_image_run_blocks_uq" ON "endpoint_image_run_blocks" ("image_id", "volume_key", "block_index");
```

**W5:** keine (Recovery-Art `code` aus M3, Lese-Route ohne neue Spalte).

**W6:** keine, wenn M5 `endpoint_recovery_kind` um `probe` erweitert hat.

**W7a (`rollback`):**

```sql
ALTER TYPE "public"."endpoint_recovery_kind" ADD VALUE 'rollback';--> statement-breakpoint
ALTER TABLE "endpoint_recoveries" ADD COLUMN "rollback" jsonb;   -- Art, Ziel, Stand, backupBefore, Ergebnis
```

**W8 (`recovery_kits`):**

```sql
CREATE TABLE "endpoint_recovery_kits" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "endpoint_id" uuid NOT NULL REFERENCES "endpoints"("id") ON DELETE CASCADE,
  "agent_version" text NOT NULL,
  "winre_build" text NOT NULL,
  "sha256" text NOT NULL,
  "bytes" bigint NOT NULL,
  "manifest_path" text NOT NULL,
  "drivers" jsonb NOT NULL DEFAULT '[]',
  "status" text NOT NULL DEFAULT 'active' CHECK ("status" IN ('active', 'superseded')),
  "created_at" timestamptz NOT NULL DEFAULT now()
);
```

**W9:** keine.

### 6.5 Oberfläche (`apps/web`) und i18n

- Rechnerseite Windows: Karte "Bare Metal" mit Bewertung (4.4.3) und genauem Beweistext,
  Zeile "Zielhardware geprüft" (4.6), geschätzte Wiederherstellungszeit, Liste der
  Image-Volumes (je Volume "Image" oder "nur Dateien" mit Grund), BitLocker-Hinweis,
  Writer-Zustände und fehlende Writer des letzten Laufs, Kit-Zustand, **lokale Erlaubnis für
  Rollback** deutlich (ja/nein mit Befehl), Vorbereitung auf andere Hardware (ja/nein).
- Assistent "Wiederherstellen…" nach **Szenario** (4.5), nicht nach Buchstaben; danach Weg mit
  Code, Schritt "Vorbereitung" mit Secure-Boot- und Treiberhinweis (Texte je verfügbarem Weg,
  Abschnitt 4), Option "Probewiederherstellung (Original läuft weiter)", Vorabprüfung.
- Dialog "Zurücksetzen…": Art (Rechner, Volume, Ordner), Stand, Volumes der Gruppe (Abwahl mit
  Gruppenprüfung), Warnungen (Domäne, DC, BitLocker, SQL-Kette, Dienste, VBS), "Sicherung
  vorher" (an, bei Ransomware aus), Zeitschätzung, Eingabe des Rechnernamens; Live-Ansicht wie
  `recovery-live.tsx`.
- Datei-Restore: Ziel "Originalort" mit "überschreiben" oder "nur Fehlendes ergänzen" (W7a).
- Reiter "SQL Server": Instanzen, Anmeldestatus mit dem T-SQL-Block zum Kopieren, Datenbanken
  mit Modell, Modus, letzter Sicherung, Zeitraum, Prüfstand; Dialog "Datenbank
  wiederherstellen" (Zeitpunkt mit Schieber im Zeitraum, Ziel, Prüfung) und "Restore-Skript für
  einen anderen Rechner herunterladen" (5.1.4).
- Feste Warnungen aus W1 auf Rechnern mit DC, SQL, Exchange, Hyper-V, solange die passende
  Funktion nicht an ist.
- Der Satz "Wiederherstellung = Windows neu installieren, dann Dateien zurückholen" (WA 2.2,
  `endpoints-page.test.tsx`) gilt nur noch für Windows-Rechner ohne Image-Stand.
- Alle Texte de/en; Glossar: "Image-Stand", "Rollback", "Kit", "Prüfname", "Slot-Datei",
  "Vorabprüfung", "Probewiederherstellung".

### 6.6 Dokumentation

docs/AGENT.md (Grundsätze, Image-Routen, Recovery-Image-Route, Fehlercodes, Rollback,
SQL), docs/WINDOWS-AGENT.md (2.2, 9.1 Privilegien, 17.5, 18, 21), docs/BAREMETAL.md (2.2,
25.A1 mit Verweis hierher), agent/README.md (Known limits, SQL), docs/GLOSSARY.md,
docs/SIZING.md, CHANGELOG je Meilenstein. Die falsche Hook-Empfehlung (`sqlcmd` als SYSTEM,
agent/README.md:244, docs/AGENT.md:1442, docs/WINDOWS-AGENT.md:208 und :1640, WA 17.5; die
Zeilen dieses Entwurfs hatten sich verschoben) wird in W1 an allen Stellen korrigiert (umgesetzt,
Abschnitt 12).

## 7. Sicherheit

### 7.1 Was neu im Speicher liegt

- Ein Windows-Image enthält, was die Ordnersicherung nie enthielt: `SAM`, `SECURITY`
  (LSA-Geheimnisse, darunter das Kennwort des Computerkontos und zwischengespeicherte
  Domänenanmeldungen), DPAPI-Hauptschlüssel des Systems, bei einem DC `ntds.dit` mit den
  Kennwort-Hashes **der ganzen Domäne**. Wer Image-Daten eines DC liest, besitzt die Domäne.
- Folgen: Bare Metal für einen DC ist eine bewusste Entscheidung im Job (eigene Bestätigung
  "enthält die Anmeldedaten der Domäne"); die Dateiwiederherstellung aus Images (NTFS-Leser)
  sperrt `Windows\System32\config\*`, `Windows\NTDS\*`, `Windows\System32\Microsoft\Protect\*`,
  `ProgramData\Microsoft\Crypto\*` und `Users\*\AppData\Roaming\Microsoft\Protect\*` für
  Downloads (Sperrliste in `guestfs`, Test); der Lesezugang einer Recovery-Sitzung bleibt auf den
  einen Rechner beschränkt (BM 9.6).
- Verschlüsselung: Image-Blöcke gehen im Klartext über TLS an den Server, der sie mit dem
  Schlüssel des Mandanten verschlüsselt, wie VM-Platten der PVE-Integration. Das ist kein neues
  Vertrauen: Der Server kennt das Repository-Passwort jedes Rechners ohnehin (Anzeige,
  Recovery-Zugangsdaten BM 9.5).
- Repository-Passwort und Master-Key: unverändert (BM 16).

### 7.2 Geheimnisse des Agenten im Image

- `state.json` (DPAPI-geschützt, aber der DPAPI-Hauptschlüssel des Systems liegt im selben Image),
  seine Temp-Dateien `.state-*.tmp` und die Slot-Dateien werden geschwärzt (3.4), ebenso
  `data\cache`, `data\tmp`, `data\outbox` und `data\staging` des Agenten sowie Auslagerungs-,
  Ruhezustands- und Speicherabbilddateien (Speicher des Agenten-Prozesses). Stufe 1 beweist die
  Schwärzung (WL7); ein Fehlschlag ist ein Sicherheitsbefund mit Alarm und Löschung des Stands.
- Nicht geschwärzt und ohne Geheimnisse: `state\hooks.d` und `state\local-policy.json`.
- `state.json` und Temp-Datei bleiben nicht resident (4 KiB), die Slots ebenso (64 KiB); damit
  steht ihr Inhalt auch nicht im `$LogFile` (NTFS protokolliert dort Metadaten und residente
  Daten **[Win]**).
- Alte Fassungen von `state.json` in freien Clustern werden nie gelesen (Belegt-Maske).
- Das Wiederanbindungs-Token steht höchstens 24 Stunden im Slot und wird nach dem Einlösen
  genullt (4.1.8).
- Das Sitzungsgeheimnis eines Fern-Rollbacks liegt höchstens 4 Stunden in einer Datei mit
  geschützter DACL; nach `release` ist es wertlos.

### 7.3 Medien und Kit

- Das ISO bleibt signiert (BM 8.5). Das Kit enthält keine Geheimnisse; Secure Boot schützt
  Bootmanager und WinPE-Kern, aber nicht `restow-agent.exe` in der WIM. Ein verändertes Medium
  kann den eingegebenen Code abgreifen; die Origin-Bindung (BM 9.1) und die Freigabe mit
  Prüfzahl (BM 9.4) gelten unverändert, und die Oberfläche zeigt SHA-256 des Kits.
- Der Kit-Bau läuft als SYSTEM mit DISM auf einer Kopie; der Arbeitsordner hat die geschützte
  DACL (WA 7), damit kein Benutzer Dateien in die WIM schieben kann.

### 7.4 Rollback als Waffe

- Ein kompromittierter Server oder Admin-Zugang könnte mit Rollbacks Daten zerstören. Gegen
  die Flotte schützt die **lokale Erlaubnis** (4.3); gegen Datenverlust die **Sicherung vorher**
  (Vorgabe an, abschalten wird auditiert); gegen Eile die Grenze von fünf je Mandant und
  Stunde; gegen Unbemerktes der Sicherheitsalarm.
- Rollback-Sitzungen sind Recovery-Sitzungen (Lesezugang nur auf den einen Rechner, Ablauf,
  Audit, kein Prune); sie geben nichts, was der Agent nicht schon hätte.

### 7.5 Neue Rechte und Prozesse

- `SeSystemEnvironmentPrivilege` zusätzlich ab W3, `SeShutdownPrivilege` erst mit C2 (W9; die
  Startprobe braucht es nicht, 4.4.2) (6.1). `SeDebug`, `SeTcb`,
  `SeLoadDriver` bleiben ausgeschlossen.
- Neue Prozessaufrufe (alle mit Argumentliste, `procenv.Base()`, Zeitgrenze, Ausgabegrenze, wie
  BM 4.1 `tools.go`): der eigene Hilfsprozess `restow-agent vss-hold` (Job-Objekt, endet mit
  dem Dienst), `powershell.exe` (feste eingebettete Skripte für SQL, WMI BitLocker und
  Aktivierung, `[ADSI]` für Tombstone und SYSVOL-Synchronisierung,
  `Test-ComputerSecureChannel`), `reg.exe` im laufenden System nur für die Opt-in-Vorbereitung
  auf andere Hardware (4.1.5), `dism.exe`, `pnputil.exe`, `bcdedit.exe`,
  `manage-bde.exe`, `netsh.exe`, `wevtutil.exe`, im WinPE `reg.exe`, `bcdboot.exe`,
  `chkdsk.exe`, `mountvol.exe`, `wpeutil.exe`. Die Attrappe der Tests scheitert bei
  `manage-bde -protectors -get` und `-recoverypassword` (Schlüssel dürfen nie gelesen werden),
  wie BM 4.1 bei `--dump-volume-key`.
- Das SQL-Skript bekommt keine Zeichenkette, die als T-SQL ausgeführt wird (5.1.2); ein Test
  sucht im Skript jede Verkettung in `CommandText`.

### 7.6 Bedrohungsmodell (Ergänzung zu BM 16.2)

| Angreifer | Ziel | Schutz |
| --- | --- | --- |
| liest den Speicher des Mandanten | Domänen-Hashes aus einem DC-Image | Verschlüsselung mit dem Schlüssel des Mandanten; Master-Key nicht im Speicher (BM 16) |
| stiehlt einen Wiederherstellungscode | Image lesen | Origin-Bindung, Freigabe, ein Rechner, 48 Stunden (M3) |
| kompromittierter Agent | fremde Images lesen, Dedup-Orakel | Routen nur für den eigenen Rechner; Vergleich nur gegen eigene Hashliste |
| kompromittierter Server | Flotte zurücksetzen | lokale Erlaubnis, Sicherung vorher, Grenze, Alarm |
| Benutzer am Rechner | Dateien in Kit oder Staging schieben, SQL-Staging lesen | geschützte DACLs; Staging nur SYSTEM, Administratoren, SQL-Dienst-SID; ein eigener `stagingDir` nur mit vertrauenswürdigem Elternordner, neu oder leer übernommen und markiert, Unterordner fremder Eigentümer abgelehnt (5.1.3) |
| manipuliertes Medium | Code abgreifen | wie ISO (BM 9.1, 9.4); SHA-256 in der Oberfläche |

## 8. Tests

### 8.1 Unit-Tests (jedes System, Jobs `agent`, `agent-windows`, `test`)

- Manifest `windows`: Go und Zod gegen dieselben Testdaten (gültige echter Systeme, ungültige
  mit Steuerzeichen, zwei Plattformen, fehlenden Pflichtfeldern), Fingerabdruck in beiden
  Sprachen gleich (wie M1).
- Erfassung gegen aufgezeichnete Ausgaben (`testdata/capture/windows-*`): Windows 11 UEFI
  (ESP, MSR, C:, WinRE hinter C:), Server 2022 UEFI mit Datenvolume, Server 2016 BIOS/MBR,
  BitLocker an, DC, SQL mit Daten auf D: und Log auf L:, Hyper-V-Host, Storage Spaces, LDM.
- `Assess`, Planer (Golden Files wie M2): gleiche Hardware, größere Platte, kleinere (Problem),
  4Kn-Ziel (Problem), NVMe → AHCI (Fixup), nicht inbox-Treiber (Problem mit B), dirty Hive
  (Problem), doppelte Identität, Rollback-Erkennung, MBR-Offsets, Secure-Boot-Fälle mit `dbx`
  gegen PCA 2011 und vorhandenem `EFI_EX`.
- Blockstrom und Schreiber gegen kleine NTFS-Abbilder in `testdata` (mit `mkntfs` erzeugt und
  eingecheckt): Belegt-Maske, Schwärzung (residente und nicht residente Datei), Block mit
  Nullen in belegten Clustern wird geschrieben, Block ohne belegte Cluster nicht,
  Rollback-Vergleich (nur abweichende Blöcke).
- Blockstrom zusätzlich: Bereich hinter dem letzten Cluster immer im Strom, `$BadClus`-Runs
  genullt, Slot-Extents geschrieben und gelesen, Pufferausrichtung, Schwärzungsliste mit den
  echten Pfaden (und `hooks.d`, `local-policy.json` **nicht** geschwärzt).
- VSS: Zerlegen der Writer-XML echter Systeme, Komponentenauswahl (nicht auswählbare
  Komponenten immer, Systemzustand vollständig, Dateien außerhalb des Satzes, Hyper-V über
  `DisableWriterClasses`), erwartete gegen gemeldete Writer, Abbildung der Zustände.
- Planer zusätzlich: BitLocker-Ziel mit dem ISO (nur volles Neuschreiben), Bootcode und
  EBR-Kette bei MBR, ESP-Wahl bei C1, CA-2023 in beide Richtungen, Gruppenprüfung bei
  Abwahl von Volumes, `source_alive`, Texte je verfügbarem Weg.
- SQL: LSN-Kette (Lücke, fremde Log-Sicherung über `last_log_backup_lsn`, Tail, Forks,
  `family_guid`, Bulk-Logged-Intervalle, geschlossene Kette nach Image-Restore), Zeitraum,
  Restore-Schritte für einen Zeitpunkt, Restore-Skript; das Skript ohne T-SQL-Verkettung;
  Aufbewahrung der Logs; Sperrklassen.
- Agent-Zustand: Erkennung "aus Image wiederhergestellt" vor `Load`-Fehler und vor `Save`,
  Umzug der lokalen Erlaubnisse nach `local-policy.json`, Verwerfen der Outbox.
- ISO-Schreiber: Struktur gegen Spezifikation (Volume-Deskriptoren, Joliet, El Torito) und
  `xorriso -indev … -report_el_torito` als Gegenprobe in der Linux-CI (nur Test).
- `regf.ts`, `fat.ts`, `ntfs.ts` gegen echte Hives und Images; Sperrliste der Dateiwiederherstellung.
- Server: Routen (nur anhängen, fremder Rechner 403, Body-Grenzen, `reader` endet mit
  `release`), Aufbewahrung der Image-Stände in beiden Reihenfolgen mit einer Sitzung (wie M3),
  Stufe 1 Windows mit jedem Rot-Fall (insbesondere WL7), Migrationen einzeln.

### 8.2 CI auf Windows-Runnern

Neuer Job `agent-windows-image` auf dem Windows-Server-Runner (Administrator, Server 2022 und
2025), nachts und bei Änderungen unter `agent/internal/{vss,winimage,baremetal,sqlserver}`.

- **Gegenstelle:** Die gehosteten Windows-Runner (`windows-2022` in `ci.yml`) starten keine
  Linux-Container, `scripts/smoke` braucht aber docker compose. Darum läuft der
  Ganz-Rechner-Lauf gegen eine **nachgebaute Image- und Agent-API in Go** (wie die nachgebaute
  Instanz im Installer-Test): Routen aus 6.3 mit Prüfung der Blöcke, Hashlisten, Masken und
  Commit, Block-Speicher im Dateisystem des Runners. Der Vertrag zur echten API ist durch
  gemeinsame Testdaten und den Server-Test der Routen (8.1) gesichert; der Ende-zu-Ende-Lauf
  gegen die echte Instanz ist WE1 (8.3).
- **VHDX statt echter Platten** (`diskpart create vdisk`/`attach vdisk`, ohne Hyper-V): eine
  GPT-Platte mit ESP, MSR, NTFS-System- und Datenvolume anlegen, Dateien schreiben (auch
  Hardlinks, ADS, komprimierte und WOF-Dateien), Ganz-Rechner-Lauf, dann auf eine zweite VHDX
  zurückschreiben (Block-Schreiber über das Plattenhandle) und vergleichen: Dateiinhalte,
  Hardlinks, ADS, Kompression, Seriennummer, GUIDs, Backup-Bootsektor, `chkdsk /scan`.
  **[CI]**: dass VSS Volumes auf angehängten VHDX aufnimmt, `FSCTL_GET_VOLUME_BITMAP`,
  `IOCTL_DISK_GET_LENGTH_INFO`, `FSCTL_GET_RETRIEVAL_POINTERS` und
  `FSCTL_ALLOW_EXTENDED_DASD_IO` auf der Schattenkopie gehen, `$BadClus` lesbar ist,
  `IOCTL_DISK_SET_DRIVE_LAYOUT_EX` `PartitionId` setzt, Slot-Dateien nach rohem Schreiben und
  `chkdsk` gültig bleiben. Dazu der Hive-Zustand in jedem Snapshot (wie oft `hive_dirty`).
- **Mehr-Volume-Befund (W1)** nachgestellt: SQL Express mit Daten auf VHDX D: und Log auf
  VHDX L:, heutiger Agent, zwei Snapshot-Sätze mit verschiedenen Zeitpunkten in den
  restic-Logs belegen. Der Tag von 0.5.0 hängt nicht an H5. Umsetzung: C3, C16 und C23
  (12.2).
- **Writer:** `GatherWriterStatus` auf dem Runner (System, Registry, WMI, ...), Writer-XML als
  Testdaten; SQL-Writer-Dienst gestoppt → `vss_writer_missing`.
- **SQL Server Express** (nur im Test): Datenbanken mit Daten auf VHDX D: und Log auf VHDX L:,
  Last während der Sicherung; native Full mit `NO_COMPRESSION` auch bei gesetztem
  `backup compression default` (Umsetzung: Express kennt keine Sicherungskomprimierung und
  keine Option `backup compression default`; dieses Gate läuft darum im Linux-Container mit der
  Developer Edition, Job `tsql-linux`, siehe 12.4); Restore unter neuem Namen; Restore-Skript auf einer zweiten
  Instanz; Logs, `STOPAT`, Tail-Log in beiden Modi (W2b); CHECKDB grün; Image mit SQL-Writer,
  danach Attach aus dem zurückgeschriebenen Image und CHECKDB. Rechte mit und ohne Anmeldung
  der Dienst-SID, Variablen in `BACKUP`/`RESTORE`/`DBCC`, Schreibrecht der SQL-Dienst-SID auf
  das Staging, Sperrklassen (Log während eines langen Laufs). Der Installer wird von Microsoft
  geladen und lässt sich nicht über einen festen SHA-256 pinnen (der Bootstrapper lädt nach):
  Der Job lädt das volle Medium (`/ACTION=Download`), prüft die Authenticode-Signatur, und ein
  Fehlschlag des Downloads macht den Lauf "unvollständig", nicht rot.
- **Kit** mit einer WinPE aus dem ADK (nur Test; der Runner hat oft keine WinRE **[CI]**):
  Bau, ISO-Schreiber (mit und ohne UDF-Brücke: startet bootmgr von ISO 9660 mit Joliet ohne
  UDF? Microsoft selbst nutzt `-u1 -udfver102` **[CI]**), Start in QEMU, `recover --winpe
  --plan-only` gegen die nachgebaute API. Start und Ausführung im **selben Job** auf einem
  Runner mit KVM (8.3); keine Actions-Artefakte und keine Caches mit Microsoft-Dateien (ADK,
  WinPE, Golden Images), weil das Repository `restow-backup/restow` öffentlich ist.
- **Werkzeuge unter der Privilegienliste des Dienstes:** ein Testdienst mit derselben Liste wie
  `RestowAgent` ruft `bcdedit`, `manage-bde -status`, `pnputil`, `dism` auf **[CI]**.
- Grenze: keine echte Firmware, kein BitLocker (das Feature fehlt auf dem Runner und braucht
  einen Neustart), kein Neustart des Runners (also kein C2-Ende-zu-Ende).

### 8.3 KVM-CI und Labor mit Windows-Gästen

- **Voraussetzung:** Frage 12 (Lizenz der Evaluierungsfassungen für automatisierte Tests) ist
  **vor Beginn von W8 bzw. W5** entschieden; ohne sie hat der erste Wiederherstellungsweg keinen
  automatischen Ende-zu-Ende-Test, und die Tests laufen nur im Labor des Maintainers (Proxmox
  VE, Hyper-V).
- **Ressourcen:** Golden Images (Windows Server 2022 und Windows 11, je 10 bis 15 GB),
  Zielplatte und Blockspeicher der Test-Instanz sprengen den freien Platz eines
  Standard-Runners, GitHub-Caches sind auf 10 GB je Repository begrenzt (und dürfen ohnehin
  keine Microsoft-Dateien tragen, 8.2). Darum ein großer oder eigener Runner mit KVM, Budget je
  Fall 45 bis 90 Minuten. Golden Images werden **wöchentlich** aus der Evaluierungs-ISO gebaut
  (30 bis 60 Minuten) und **gepatcht** (aktuelles kumulatives Update, CA-2023-Übergang und
  `dbx`), weil ein ungepatchtes Eval-ISO den Übergang nicht testet; sie liegen nur auf dem
  eigenen Runner.
- **WE1** (je PR mit Änderung am Windows-Zweig, sobald Frage 12 entschieden ist):
  Image-Sicherung im Gast gegen die echte Test-Instanz, Wiederherstellung mit dem ersten Weg
  (Kit bzw. ISO) in eine neue VM mit anderem Controller (NVMe → AHCI), Start bis
  `RESTOW-PROBE-OK`.
- **WE2** (nachts, leichte Fälle): BIOS/MBR-Gast mit erweiterter Partition; Secure Boot mit
  aktueller `dbx` in zwei OVMF-Varianten (nur CA 2011; CA 2023 mit gesperrter PCA 2011, H15);
  größere Zielplatte mit Vergrößern von C:; Rollback C1 auf dieselbe Platte mit Zählung der
  geschriebenen Blöcke; SQL-Gast mit Image-Restore und `sys.databases` ONLINE; schmutzige Hive
  und unsauberes NTFS im Image (Problem vor dem Löschen); WinRE-Medium B mit Treiberinjektion
  (VirtIO-Speichertreiber als Beispiel für einen nicht inbox-Treiber, nur Test).
- **WE3** (wöchentlich, Labor): Startprobe gegen ein echtes Windows-Image (Probe-Pfad
  vollständig wie in Installationen, `hv-crash`), DC in einer Zwei-DC-Domäne mit Prüfung der
  Invocation-ID, der Replikation und der SYSVOL-Synchronisierung (Ereignisse 4114/4614/4604),
  Exchange, Fern-Rollback C2 (Neustart in die RAM-Disk, BitLocker mit Kennwort-Schutz auf
  vTPM/swtpm).
- **WE4** (nachts): alte Platte mit derselben Identität noch angeschlossen (Gegenstück zu E9):
  Problem `duplicate_disk_identity` vor dem Schreiben.
- **WE5** (nachts, Gegenstück zu E8): Abbruch, Fortsetzen, Stromausfall (VM hart beenden) und
  Netzverlust während des Restores im Windows-Zweig; nach dem Neustart des Mediums wird
  fortgesetzt und das Ergebnis ist gleich dem ungestörten Lauf.

### 8.4 Auf echter Hardware und echten Windows-Servern (Maintainer, vor dem Release)

Fälle (Ergebnisse in diesem Dokument und in Testdaten):

| Nr. | System | Fall |
| --- | --- | --- |
| H1 | Arbeitsplatz Windows 11 24H2, NVMe, UEFI, Secure Boot, BitLocker mit TPM | Image, Wiederherstellung auf denselben Rechner mit neuer SSD; BitLocker danach aus bzw. neu verschlüsselt und Alarm; Rollback C1; später C2; Vorabprüfung |
| H2 | Secured-core-Laptop (Drittanbieter-CA aus) | Weg B ohne Änderung der Firmware; Weg A mit dem Hinweis |
| H3 | Server 2022, Hardware-RAID, UEFI | Image, Wiederherstellung B auf anderen Server mit anderem RAID-Controller (Treiber aus dem Kit) |
| H4 | Server mit BIOS/MBR (2019, sonst 2016) | Image, Wiederherstellung, Bootcode, Offsets, EBR-Kette, Signatur |
| H5 | Server 2019 mit SQL Server 2019 Standard, Daten D:, Log L:, 50+ Datenbanken | Writer-Freeze in einem Satz, Freeze-Zeiten gegen das Flush-and-Hold-Fenster von VSS (etwa 10 s) und Microsofts Hinweise zu VSS-Sicherungen vieler Datenbanken **[Win]**; native Full und Logs; STOPAT; CHECKDB; Restore über die vorhandene mit Tail-Log; Deduplizierung unkomprimierter Fulls über Tage |
| H6 | Server 2022 als DC (zwei DCs) | Image-Restore nicht autoritativ, Invocation-ID, SYSVOL/DFSR-Synchronisierung; später Rollback 35 Tage zurück eines Mitglieds (Vertrauensstellung) |
| H7 | Server 2022 mit Exchange Server SE | Image und Restore, Zustand der Datenbanken, Logwachstum mit Kopie |
| H8 | Hyper-V-Host | Image ohne Hyper-V-Writer, Warnungen |
| H9 | Rechner mit Storage Spaces und mit dynamischem Datenträger | Erkennung, `win_files_only` |
| H10 | Server mit SQL Server 2022 Express auf deutscher und englischer Windows-Version | Erkennung, Anmeldeprüfung, Texte, CLM/WDAC, Strict Encryption, ODBC-Rückfall (W2b) |
| H11 | NVMe-Quelle → SATA-Ziel und umgekehrt, physisch | Treiber-Fixup (Vorbereitung bzw. offline), auf dem ersten Weg |
| H12 | Server 2025, Windows 11 25H2 | je ein Image und eine Wiederherstellung |
| H13 | Windows 11 mit BitLocker (Geräteverschlüsselung) | Rollback mit dem ISO: Plan erkennt `-FVE-FS-`, volles Neuschreiben ohne BitLocker; vom Kit: Entsperren und Blockvergleich |
| H14 | Rechner mit alter und neuer Platte gleichzeitig angeschlossen | `duplicate_disk_identity` vor dem Schreiben |
| H15 | Firmware nur mit CA 2011 bzw. mit gesperrter PCA 2011; Bootmanager nur mit CA 2023 auf einem Ziel mit alter `db` | `CheckChain`, Problem und Ausweg vor dem Löschen; Start des Mediums |
| H16 | Laptop mit Intel VMD/RST | Erkennung, Kit mit `iaStorVD`, ISO mit `vmd`, Text ohne B |
| H17 | DC, Rollback C1 | `Database restored from backup` gesetzt, kein USN-Rollback, SYSVOL |
| H18 | SQL mit getrennten Daten- und Log-Volumes | C3 nur eines Volumes → `rollback_splits_application`; Gruppe → Datenbank ONLINE |
| H19 | HDD mit defekten Sektoren | `bad_clusters_masked`, Image entsteht |
| H20 | Proxmox-VE-Ziel mit VirtIO (P2V) | Empfehlung SATA/NVMe; B mit VirtIO-Treiber im Kit |
| H21 | Laptop mit Windows LAPS, Rollback | `laps_password_stale`, `Reset-LapsPassword` |
| H22 | Kunden-Instanz mit `backup compression default = 1` | `NO_COMPRESSION` greift, Deduplizierung |
| H23 | Restore über WAN und Stromausfall während des Restores | gemessene Zeit gegen die Schätzung (4.6), Fortsetzen |
| H24 | Probewiederherstellung neben dem laufenden Original | kein Rebind, `source_alive`, Original sichert weiter |

**Gate je Meilenstein** (jeder Meilenstein hat seine eigene Liste; ein Gate prüft nur, was der
Meilenstein liefert):

| Meilenstein | Gate |
| --- | --- |
| W1 | CI (Mehr-Volume-Befund, 8.2); keine echte Hardware |
| W2a | H5 (Full, Restore unter neuem Namen, Restore-Skript, CHECKDB), H10, H22 |
| W2b und W7a | H5 (Logs, STOPAT, Tail-Log, REPLACE), H10 (ODBC); C4 und Restore an den Originalort in den Plattform-Tests (BM 21) |
| Vorschau Windows Bare Metal (W3, W4a, W4, W8, W6) | H1 (Wiederherstellung und C1 vom Kit), H2 (Weg B), H3, H4, H5 (Image-Teil), H6 (Image-Restore), H11, H12, H13 (Kit-Teil), H14, H15, H16, H17, H19, H20, H23 |
| W5 (Weg A) | H1 (A und C1 über das ISO), H2 (Weg A), H4, H11, H13 (ISO-Teil), H15, H16 (ISO), H24 |
| W7b | H18 |
| W9 | H1 mit C2, H6 mit dem Mitglieds-Rollback, H21 |

Jede Gate-Runde kostet grob 2 bis 3 PW (Aufbau, Durchlauf, Auswertung) und steht in der
Schätzung (Abschnitt 9).

### 8.5 Nur auf echter Hardware zu prüfen (gesammelt)

In der CI prüfbar und darum dort geführt (**[CI]**, 8.2, 8.3): Bitmap, Länge, Retrieval
Pointers und Extended DASD auf der Schattenkopie; `$BadClus`; ACL- und Slot-Verhalten (statt
ntfs-3g `inherit`); `IOCTL_DISK_SET_DRIVE_LAYOUT_EX`; Werkzeuge unter der Privilegienliste des
Dienstes; Dienst-SID als SQL-Anmeldung, Variablen in `BACKUP`/`RESTORE`/`DBCC`, Schreibrecht
auf das Staging; Hive- und NTFS-Zustand im Snapshot; ntfs-3g schreibend auf einem Image mit
unsauberem `$LogFile`; Bluescreen-Erkennung über `hv-crash`.

Auf echter Hardware bleibt:

1. Klartext beim Lesen von BitLocker-Volumes über die Schattenkopie; Aussehen der
   Metadatenbereiche und des Bootsektors im Image; Schreiben über das entsperrte Volume erhält
   die Verschlüsselung (C1 von B, C2); Geräteverschlüsselung nach dem ersten Start (H1, H13).
2. Writer-Zustände nach `DoSnapshotSet` auf SQL-, Exchange-, DC- und Hyper-V-Systemen;
   Freeze-Zeiten mit vielen Datenbanken (H5 bis H8).
3. BCD und `MountedDevices` bleiben mit gleichen GUIDs (GPT) bzw. Signatur und Offsets (MBR)
   auf **fremder** Hardware gültig; Format der BCD-Geräteelemente (H3, H4).
4. Wiederherstellungspartition in VSS (Platz) oder roh; `reagentc` nach dem Restore.
5. ESP roh lesen im Betrieb nach `RegFlushKey`.
6. ReFS, Storage Spaces, LDM: Erkennung und Verhalten (H9).
7. Treiber-Fixup NVMe → AHCI und zurück, Vorbereitung und offline (H11).
8. Go-Agent und Block-Lesen im WinPE; TLS mit Prüfwert.
9. RAM-Disk-Start einer WIM von einem BitLocker-C: nach `-RebootCount 1`; `bootsequence`; ob
   ein Start des WinPE den Zähler verbraucht.
10. DC: `Database restored from backup` im Offline-Hive, SYSVOL-Synchronisierung mit den Rechten
    des DC, Tombstone-Lesen über `[ADSI]` (H6, H17).
11. Vertrauensstellung eines Mitglieds nach Rollback um 30 und 60 Tage.
12. Bootmanager mit CA 2023 (`EFI_EX`) auf Rechnern mit gesperrter PCA 2011 in `dbx`; nur CA
    2023 auf alter `db`; VBS-Anti-Rollback (H15).
13. Dauer und Last täglicher Images auf NVMe, SATA-SSD und HDD; Platz der Schattenkopien bei
    langen Lesevorgängen auf ausgelasteten Servern; Dauer einer Wiederherstellung über WAN
    (H23).
14. Erster Start auf neuer Hardware: Geräteinstallation, Neustarts, Aktivierung.
15. Intel VMD/RST: Sichtbarkeit unter Linux (`vmd`) und im Kit (H16).
16. Alte Platte noch angeschlossen (H14); defekte Sektoren (H19); LAPS (H21).

## 9. Meilensteine

Jeder Meilenstein ist einzeln mergebar, mit eigenen Tests, eigener Migration (wo nötig) und
eigenem CHANGELOG-Eintrag, und lässt die vorigen unverändert gelten. Schätzungen in
Personenwochen (PW) sind grob und keine Zusage; die Gate-Runden auf echter Hardware (8.4) stehen
in einer eigenen Spalte.

| W | Inhalt | hängt ab von | Schätzung | Gate-Runde | Release |
| --- | --- | --- | --- | --- | --- |
| **W1** Ehrliche Grundlage | `sysinfo_windows.go` (Version, Produkttyp, Rollen, BitLocker), Heartbeat `machine.windows`, feste Warnungen in Oberfläche und Lauf-Bericht, Korrektur der Hook-Doku, Mehr-Volume-Befund in der CI nachgestellt (8.2) | – | 1 | – (CI) | 0.5.0 |
| **W2a** SQL, erste Stufe | Skript, Inventar, Anmeldeprüfung, COPY_ONLY-Full mit `NO_COMPRESSION`, eigener Snapshot-Pfad, Restore unter neuem Namen, Restore-Skript für einen anderen Rechner, Prüfung mit CHECKDB, Oberfläche; Migration W2a | W1 | 2 bis 3 | 2 | 0.5.0 (Vorschau) oder 0.5.1 |
| **W2b** SQL, zweite Stufe | eigene Log-Kette, Erkennung fremder Logs über `last_log_backup_lsn`, Forks und Bulk-Logged, Point-in-Time, Tail-Log, REPLACE, Sperrklassen, Aufbewahrung der Logs, ODBC-Rückfall | W2a | 3 bis 4 | 2 (mit W7a) | 0.5.1 |
| **W7a** Restore-Option | Restore an den Originalort, C4 Ordner zurücksetzen (alle Plattformen), lokale Erlaubnis in `local-policy.json`, Sicherung vorher, Grenzen, Alarme; Migration W7a | W1 | 2 | (mit W2b) | 0.5.1 |
| **W3** VSS-Requester und Manifest | `internal/vss` mit `vss-hold`, Pflichtkomponenten, fehlende Writer, `capture_windows.go`, `assess_windows.go`, Fingerabdrücke, Manifest im Abschluss, Server nimmt Windows-Layouts an (`baremetal.ts`), Writer im Bericht, Privileg `SeSystemEnvironment`; Migration W3. Requester nur in der CI | **M1**, W1 | 4 bis 6 | – | Vorschau BM |
| **W4a** Blockspeicher herauslösen | `blockfmt` (Agent) und `blockstore/` (Server) aus der PVE-Integration, **ohne Verhaltensänderung**; Kriterium: alle PVE-Tests grün | – | 1 bis 2 | – | Vorschau BM |
| **W4** Volume-Images, Planer und Stufe 1 | `winimage` (Bitmap, Endbereich, `$BadClus`, Schwärzung, Slots, Fakten, Strom), Image-Routen, `endpoint_images`, Aufbewahrung, Stichproben, `regf.ts`, Planer `plan_windows.go` (für WL3), Stufe 1 Windows (WL1 bis WL11), `local-policy.json`, Bewertung bis `layout_checked`; Migration W4. Kein einschaltbarer Image-Schalter in einem Tag, bevor ein Wiederherstellungsweg (W8 oder W5) gemergt ist | **M2**, W3, W4a | 6 bis 8 | – | Vorschau BM |
| **W8** WinRE-Medium B und C1 vom Kit | `winpe` (Kit-Bau), `isowriter`, Kit-Upload und -Download, `recover_windows.go` (IOCTL-Partitionierung, Sperren und Aushängen, Slots, DISM, `reg load`, NVRAM, `bcdboot`, BitLocker entsperren), Rollback-Erkennung mit Blockvergleich, `postRestore` im Agenten, Lese-Route für Images; CI mit ADK-WinPE; Migration W8 | **M3**, W4; Frage 12 entschieden | 6 bis 9 | 3 (mit W6) | Vorschau BM |
| **W6** Startprobe Windows | Probemodus im Agenten (`probe.slot`, COM1), Labor-Zweig (Kit bzw. ISO, Controllerwechsel, zwei `db`-Varianten, `hv-crash`, Zeitgrenze), Kapazität und Priorisierung, Bewertung `green`/`overdue`/`red`; CI WE3. **Ohne W6 bleibt Windows Bare Metal verborgen** | **M5**, W8 (oder W5) | 3 bis 4 | (mit W8) | Vorschau BM |
| **W5** Weg A über das ISO und C1 vom ISO | Windows-Zweig in `recover` (Planer, sgdisk/sfdisk mit Bootcode und EBR, Block-Schreiber, Fixups mit hivex nur auf sauberer Hive, Slots roh, NVRAM, Prüfung), BitLocker-Zweig (volles Neuschreiben), ISO-Pakete und `vmd`; CI WE1/WE2 für A | **M3**, **M4** (gemergt, E1/E2 stabil), W4, W8 (gemeinsamer Planer) | 4 bis 6 | 2 | Vorschau BM oder danach |
| **W7b** C3 Datenvolume im Betrieb | Gruppenprüfung, Schattenkopien löschen, Sperren und Aushängen, Dienste | W4, W7a | 2 bis 3 | 1 | 0.5.x danach |
| **W9** Fern-Rollback C2 | `rollback_prepare` (Kit als RAM-Disk außerhalb der Gruppe, BCD-Eintrag, BitLocker aussetzen, Neustart), Rollback-Modus im WinPE, Fernzugriff als Voraussetzung, DC- und Domänenschutz, Fortsetzen; `SeShutdown` | W7a, W8 | 3 bis 5 | 2 | 0.5.x danach |
| **W10** später | Exchange mit `VSS_BT_FULL` und Postfach-Restore, AD-Einzelobjekte, Hyper-V-Host je VM, SQL über VDI ohne Staging, SQL-Snapshot-Sicherung ab 2022, Lesen nur geänderter Bereiche über das USN-Journal, Restore von Images ohne Server, Dateien aus Images in der Oberfläche, einfache LDM-Volumes, Nachspielen der Hive-Logs in Go, MBR2GPT im WinPE | W3 bis W9 | – | – | später |

Summe für die Vorschau "Windows Bare Metal" (W3, W4a, W4, W8, W6): etwa 20 bis 29 PW plus eine
Gate-Runde von etwa 3 PW, mit W5 weitere 6 bis 8 PW. Das kommt zusätzlich zu M4 und M5.
Realistisch kommt die Vorschau damit einige Monate nach 0.5.0.

Reihenfolge und Gates:

- **B zuerst** (Vorschlag, Frage 18): Der kritische Pfad ist M3 (fertig) → W3 → W4 → W8 → W6
  (an M5). Bleibt der Maintainer bei A zuerst, wird er M4 → W5 → M5 → W6, und es gilt: W5
  beginnt erst nach dem Merge von M4 und stabilem E1/E2; W3 und W4 laufen parallel zu M4/M5;
  die Spalte "hängt ab von" für W8 und W5 tauscht.
- Windows Bare Metal (Schalter, Assistent, Code für Windows) wird erst sichtbar, wenn W3, W4a,
  W4, der erste Weg und W6 fertig sind und dessen Gate-Liste (8.4) bestanden ist. Rutscht W6,
  bleibt alles hinter `RESTOW_BAREMETAL_WINDOWS_PREVIEW` (wie BM 22 für M5). Kein Tag liefert
  vorher einen einschaltbaren Image-Schalter: Images ohne Wiederherstellungsweg wären genau
  das, was der Maintainer kritisiert.
- Meldungen nennen nur Wege, die es im Release gibt (Abschnitt 4).
- W2a wird ausgeliefert, wenn seine Gate-Liste bestanden ist; es braucht keinen
  M-Meilenstein. W2b und W7a ebenso.
- W7a (C4, Restore an den Originalort) ist für Linux und macOS mit derselben Logik nutzbar;
  die Freigabe dort folgt den Tests in BM 21.
- Frage 12 ist vor Beginn von W8 (bzw. W5) entschieden; sonst hat der erste Weg keine
  Ende-zu-Ende-CI.

## 10. Risiken

| Risiko | Auswirkung | Gegenmaßnahme |
| --- | --- | --- |
| COM über `syscall` ohne Bibliothek (falsche vtable-Indizes, Referenzzählung, Threading) | Absturz oder Hänger des Requesters | Hilfsprozess `vss-hold` (Absturz beendet nur das Kind), Zeitgrenzen je Aufruf, eigener Thread, Tests auf jeder Windows-Version der Matrix (3.3) |
| Schattenkopie wird während des Lesens verworfen (Differenzbereich voll) | kein Image-Stand an ausgelasteten Tagen | erkennen (`image_shadow_lost`), Warnung `vss_low_space` vorher, Hinweis; Stand nie unvollständig |
| BitLocker: Metadatenbereiche bzw. Schreiben im WinPE verhalten sich anders als erwartet | C2 beschädigt ein verschlüsseltes Volume | **[Maschine]** vor W9; Rückfall: C2 nur für unverschlüsselte Volumes, BitLocker-Volumes über C1 mit anschließendem Neuverschlüsseln |
| Hive nach dem Snapshot nicht sauber | Offline-Fixup aus A unmöglich oder gefährlich | Prüfung des Basisblocks, Problem vor dem Löschen, `RegFlushKey` vor dem Snapshot, Weg B |
| Ziel-Firmware sperrt den Bootmanager des Images (`dbx`) | Rechner startet nicht | Prüfung vor dem Löschen (`CheckChain`), Bootdateien aus `EFI_EX`, Weg B mit den Startdateien des Kits |
| Secured-core ohne Drittanbieter-CA | ISO startet nicht | Hinweis im Assistenten, Weg B |
| Fremder Speichertreiber auf neuer Hardware | `INACCESSIBLE_BOOT_DEVICE` | Treiberprüfung vor dem Löschen, Weg B mit DISM |
| Domänenvertrauen nach Rollback, USN-Rollback eines DC | Anmeldungen scheitern, Replikation gestört | Warnungen nach Alter, Offline-Wert für DCs, Tombstone-Sperre, Prüfung nach dem Start |
| SQL-Rechte fehlen, Staging zu klein, fremde Log-Sicherungen | keine oder gebrochene SQL-Sicherung | Prüfung vor jedem Lauf, klare Codes, kein stiller Rückfall, Kette auf dem Server |
| CHECKDB-Last auf Produktionsinstanzen | Leistungseinbruch | Zeitplan außerhalb der Geschäftszeiten, `PHYSICAL_ONLY` über `maxGiB`, eine Prüfung je Instanz |
| Lesen aller belegten Cluster jeden Tag | Last auf HDD-Servern | niedrige E/A-Priorität, Zeitplan, später USN-gestütztes Lesen (W10) |
| Serverlast durch Image-Eingang | API und Speicher ausgelastet | Größenangabe in SIZING.md, Drosselung wie PVE |
| Lizenzlage: Kit aus WinRE, Windows in der Labor-VM, Evaluierungsfassungen in der CI | rechtliche Unsicherheit | keine Microsoft-Dateien ausliefern, Fragen 12 und 13 an den Maintainer |
| Umfang | Zeitplan von 0.5.0 | W1 klein in 0.5.0, W2a nur bei bestandenem Gate, W2b und W7a in 0.5.1, Bare Metal als Vorschau Monate später mit Startprobe; Gate-Runden in der Schätzung (9) |
| BitLocker-Rollback mit dem ISO | still unverschlüsseltes oder beschädigtes Volume | `-FVE-FS-` im Plan erkannt, nur volles Neuschreiben mit Bestätigung oder Weg B (3.6, H13) |
| ntfs-3g verweigert das schreibende Einhängen | Wiederanbindung oder Fixup scheitert nach dem Löschen | Slot-Dateien statt Einhängen, NTFS- und Hive-Zustand in Stufe 1, Problem vor dem Löschen (4.1.5, 4.1.8) |
| Volumes einer Anwendung getrennt zurückgesetzt | SQL `SUSPECT`, USN-Rollback, DFSR-Versionen | Gruppe als Vorgabe, Abwahl gegen Writer-Metadaten geprüft (4.3) |
| Image-Restore auf einem Rechner mit eigener SQL-Log-Kette | Logs eines verworfenen Zweigs scheinen zu passen | Server schließt die Kette, nächste Full ohne `COPY_ONLY` (5.1.3) |
| Startprobe-Stau nach dem Patch-Dienstag | viele Rechner `overdue` | Kapazitätsrechnung, Priorisierung, Anzeige des älteren grünen Stands (4.4.2) |
| VMD/RST auf Laptops | A sieht die Platte nicht oder Windows startet nicht | Erkennung, Text ohne B, Kit mit Treiber, H16 |
| Abhängigkeit von M4/M5, die woanders entstehen | Bare Metal verschiebt sich | B zuerst (nur M3), Frage 18 |
| Zwei Zeitpunkte (Image und Dateien) | Verwirrung beim Restore | Bericht nennt beide; Oberfläche trennt "Rechner" (Image) und "Dateien" |

## 11. Offene Fragen und Entscheidungen

### 11.0 Entscheidungen des Maintainers (5. November 2026)

- **Frage 1:** W2a (SQL Server, erste Stufe) kommt in **0.5.0**, sobald seine Gate-Liste
  bestanden ist. Für 0.5.0 gibt es keinen Termindruck; W1 und W2a werden vollständig gebaut
  statt gekürzt.
- **Frage 18:** **Weg B (WinRE-Medium) zuerst**, A danach. Kritischer Pfad M3 → W3 → W4 → W8
  → W6 wie in Abschnitt 9.
- **Frage 12:** Kit aus der WinRE des Kunden je Gerät: **ja** (nur für dieses Gerät, Download
  nur für Admins). Start von Kunden-Windows in der Labor-VM ohne Netz und ohne Aktivierung:
  **ja** (abschaltbar je Mandant). Evaluierungsfassungen in der CI: **prüft der Maintainer
  rechtlich**; bis dahin gelten nur in der CI belegte Wege als "nicht bewiesen" (4.4.3), und
  W8 bzw. W5 beginnen erst nach dieser Klärung.
- **Fragen 2 und 3, frühere Festlegungen:** angenommen. "Windows Bare Metal später" bekommt
  diesen Plan; "Keine Images" in docs/AGENT.md fällt für Windows ab W4; "Systemzustand und
  Registry nicht Teil" gilt nur noch für die Dateisicherung.
- Die übrigen Fragen nehmen den Vorschlag.

### 11.1 Fragen an den Maintainer

Der Entwurf schlägt vor und setzt den Vorschlag um, wenn keine andere Entscheidung kommt.
**Vor dem Start zu entscheiden** sind die Fragen 12 (vor W8 bzw. W5), 18 (vor W5/W8) und 1.

1. **Umfang 0.5.0 und 0.5.1:** 0.5.0 mit W1 und, bei bestandenem Gate, W2a (Vorschlag); 0.5.1
   mit W2b und W7a; Windows Bare Metal als Vorschau in einem späteren 0.5.x. Das hält BM 25.A1
   ein. Alternative: W2a ebenfalls erst 0.5.1.
2. **"Keine Images"** in docs/AGENT.md und der Oberfläche: für Windows ab W4 aufheben
   (Vorschlag), Linux bleibt dateibasiert.
3. **WA 2.2 "Systemzustand und Registry nicht Teil"**: gilt weiter für die Dateisicherung; das
   Image enthält beides (Vorschlag).
4. **Ablage der Images:** Blockspeicher der PVE-Integration (Vorschlag, 3.5) statt
   restic-Datenstrom im Repository des Rechners. Folge: Images sind ohne Datenbank über die
   Manifeste im Speicherziel wiederherstellbar, aber noch nicht mit `restow-restore`.
5. **Doppeltes Lesen:** Ordner auf Image-Volumes weiter auch als Dateien sichern (Vorschlag),
   oder später Einzeldateien aus dem Image anbieten und die Ordnersicherung beschränken.
6. **Lokale Erlaubnis für Rollback** (Vorgabe aus, Installer-Schalter; C1 vom Medium ohne;
   deutlich auf der Bewertungskarte) (Vorschlag). Alternative: Vorgabe an, abschaltbar.
7. **Ordner zurücksetzen (C4) und Restore an den Originalort** auch für Linux und macOS
   (Vorschlag), mit derselben Erlaubnis für alles, was überschreibt.
8. **VSS-Requester als Hilfsprozess `vss-hold`** (jetzt Vorgabe, 3.3). Begründung: Ein Absturz
   im COM-Code beendet sonst den Dienst, und `CoInitializeSecurity` gilt prozessweit.
   Alternative: im Dienstprozess, dann mit der offenen Grenze, dass ein Absturz den Dienst
   beendet und nur der SCM ihn neu startet.
9. **restics VSS-Code als Vorlage:** Reihenfolge und Konstanten übernehmen, eigenen Code
   schreiben (Vorschlag); eine Kopie mit BSD-2-Hinweis wäre lizenzrechtlich möglich, aber gegen
   die Regel "nichts kopieren" aus WA.
10. **Keine neuen Geheimnisklassen:** keine BitLocker-Wiederherstellungsschlüssel, keine
    TDE-Zertifikate, BitLocker nach der Wiederherstellung nicht automatisch einschalten
    (Vorschlag). Alternative: verschlüsselte Hinterlegung im Tresor des Mandanten.
11. **Größere Zielplatte:** Offsets bleiben, Platz frei, C: nur vergrößern, wenn es die letzte
    Partition ist (Vorschlag); Verschieben der WinRE-Partition erst später.
12. **Lizenzfragen** (Einschätzung, keine Rechtsberatung), **vor Beginn von W8 bzw. W5 zu
    entscheiden**, weil sonst der erste Weg keine Ende-zu-Ende-CI hat: Kit aus der WinRE des
    Kunden je Gerät (Vorschlag: ja, nur für dieses Gerät, Download nur für Admins); Start von
    Kunden-Windows in der Labor-VM zum Beweis (Vorschlag: ja, ohne Netz und ohne Aktivierung,
    abschaltbar je Mandant); Evaluierungsfassungen in der CI (Vorschlag: klären; bis dahin
    zeigt die Oberfläche die nur in der CI belegten Wege als "nicht bewiesen", 4.4.3).
13. **Grenze der Startprobe für Windows:** 256 GiB belegte Bytes (Vorschlag) statt der 64 GiB
    für Linux.
14. **Restore von Images ohne Server** (`restow-restore` mit Master-Key und Speicher): später
    (Vorschlag), wie BM 25.A7.
15. **SQL-Prüfung auf derselben Instanz** (Vorschlag) oder auf einer eigenen Prüfinstanz eines
    anderen Rechners (braucht Lesezugang über Rechnergrenzen, später).
16. **Exchange mit `VSS_BT_FULL`** als ausdrückliche Einstellung erst in W10 (Vorschlag); bis
    dahin Warnung.
17. **Privilegien:** `SeSystemEnvironmentPrivilege` ab W3 fest in die Liste, `SeShutdownPrivilege`
    erst mit C2 (W9) (Vorschlag), oder beide nur auf Rechnern in einem Ganz-Rechner-Job
    (Wechsel der Dienstkonfiguration zur Laufzeit).
18. **Neu: Welcher Weg zuerst?** Vorschlag: **B (WinRE-Medium) vor A (ISO)**. B hängt nur an M3,
    hat eine Microsoft-signierte Startkette, die Treiber des Rechners, `reg load` mit
    Log-Replay und kann BitLocker entsperren; die Startprobe beweist dann B, A wird der Rückfall
    für Rechner ohne Kit. Nachteil: Ein Rechner, der vor dem ersten Kit-Bau ausfällt, hat bis
    W5 keinen Weg; das Kit wird darum direkt nach dem ersten Image-Stand gebaut. Alternative:
    A zuerst, dann mit der Regel "W5 erst nach Merge von M4 und stabilem E1/E2" (Abschnitt 9).
19. **Neu: Sicherung vorher bei C1 vom Medium.** Die Sitzung bräuchte ein Anhängerecht in den
    Image-Speicher des Rechners (heute nur `reader`), um den jetzigen Stand vor dem Rollback
    vollständig hochzuladen (Vorschlag: ja, als Wahl im Plan, Vorgabe aus wegen der Dauer; bei
    Ransomware aus). Alternative: Grundregel 3 bleibt für C1 eingeschränkt ("nicht umkehrbar").
20. **Neu: Vorbereitung auf andere Hardware** (`storahci`/`stornvme` `Start = 0` im laufenden
    System über `reg.exe`, Opt-in, 4.1.5). Vorschlag: ja, als lokale Aktion mit Erlaubnis; WA
    1.3 wird für genau diese zwei Werte eingeschränkt. Alternative: nur Offline-Edit auf
    sauberer Hive bzw. Weg B.
21. **Neu: SYSVOL-Synchronisierung automatisch** nach jeder DC-Wiederherstellung (Vorschlag,
    abschaltbar je Rechner) oder nur als Schrittliste für den Admin.
22. **Neu: Quellsysteme:** Priorität Windows 11 24H2/25H2 und Server 2019, 2022, 2025;
    Windows 10 22H2 (Support seit Oktober 2025 beendet) und Server 2016 (Support endet Januar
    2027) als "nicht geprüft, mit Warnung" (Vorschlag); BIOS/MBR bleibt über H4 geprüft.

### 11.2 Entscheidungen zu den Reviews

Zwei Reviews (Windows-Interna und Datensicherheit; Umfang, Reihenfolge und Testbarkeit) sind in
diese Fassung eingearbeitet. **Übernommen** (mit Ort):

- Faktenkorrekturen: `syscall` hat `DeviceIoControl` und die lesenden Registry-Funktionen (1.4,
  6.1); `CoInitializeSecurity` (1.4, 3.3); echte Pfade `state`/`data`/`logs` (3.4, 3.9, WL9);
  Schwärzung nur der Geheimnisse, `hooks.d` und die lokale Erlaubnis bleiben (3.4,
  `local-policy.json`); Outbox (3.4, 4.1.7); Erkennung vor jedem `Save` (4.1.7, 6.1);
  `BuildLoadOption` als M4-Abhängigkeit (4.1.6); Server lehnt Windows-Layouts ab (6.3); RLS in
  `rls.sql` (6.4); Run-Lock und Sperrklassen (5.1.3); `hive_dirty` im Snapshot gemessen (3.4
  Punkt 8); Hilfsprozess statt Absturzschutz im Prozess (3.3); Tombstone 60 Tage (5.3);
  Hook-Doku an allen Stellen (6.6).
- Requester: Pflichtkomponenten, Systemzustand, `DisableWriterClasses`, fehlende Writer,
  zweites `GatherWriterStatus` (3.3).
- Lesen: Backup-Bootsektor (Blocker), `$BadClus`, ausgerichtete Puffer, BCD-Flush auf der ESP,
  SQL-Staging (3.4).
- BitLocker: C1 mit dem ISO (Blocker), FVE-Masken und Offsets, Geräteverschlüsselung (3.6).
- Startkette: Bootcode und EBR (Blocker), aktuelle ESP auch bei C1, CA-2023 in beide
  Richtungen, VBS-Anti-Rollback, UEFI mit MBR, MBR2GPT später (4.1.2, 4.1.3, C1).
- Hive und ntfs-3g: Mechanismus von hivex richtig beschrieben, Vorbereitung im laufenden System,
  Slot-Dateien statt schreibendem Einhängen (Blocker), Stufe-1-Prüfung von NTFS und Hive vor dem
  Löschen (4.1.5, 4.1.8, WL5, WL6, WL10).
- VMD/RST, VirtIO, Hyper-V-Generationen (4.1.5); Sperren und Aushängen im WinPE, UDF-Frage,
  RAM-Prüfung (4.2, C2).
- Rollback: DC-Wert bei jeder DC-Wiederherstellung (Blocker), C3 mit Aushängen und Löschen der
  Schattenkopien (Blocker), Volumes als Gruppe (Blocker), `source_alive`, Ransomware, Erlaubnis
  sichtbar, C2-Fortsetzen ehrlich, WIM außerhalb der Gruppe, Fernzugriff (4.3).
- Nach dem Start: LAPS, Aktivierung, SYSVOL nicht autoritativ (4.1.7, 5.3).
- SQL: Tail-Log-Reihenfolge (Blocker), COPY_ONLY-Tail-Log, Ketten-Schließen nach Image-Restore
  (Blocker), Ketten-Schema mit Forks und `family_guid`, fremde Logs über
  `last_log_backup_lsn`, `NO_COMPRESSION`, `FILELISTONLY`, `NEW_BROKER`, `QUOTENAME` auf dem
  Server, `CommandTimeout = 0`, AG, CLM/WDAC und TDS 8 (5.1); Exchange-DAG (5.2).
- Bewertung: Grün-Text eingeschränkt, nicht bewiesene Wege gekennzeichnet (4.4.3); Startprobe
  mit `hv-crash`, Ende durch das Labor, Kapazität (4.4.2).
- Umfang: Gates je Meilenstein (8.4), Meldungen nur auf vorhandene Wege (4), B zuerst als Frage
  18, ehrliche Schätzung mit Gate-Runden (0, 9), W7a/W7b, W2a/W2b, SQL-Restore auf einen
  anderen Rechner (5.1.4), Grundregel 3 eingeschränkt (Einleitung, 4.3), Notfall-Abläufe (4.5),
  Vorabprüfung, Zeitschätzung, Probewiederherstellung (4.6), W3 nur in der CI (3.3), Planer in
  W4 (4, 9), W4a (9), kein Image-Schalter vor einem Weg (9), W1 in der CI (8.2), Matrix
  (2.1, Frage 22), CI-Gegenstelle, keine Microsoft-Artefakte, Downloads (8.2), Frage 12 vor dem
  Start, Ressourcen, wöchentliche Laborläufe (8.3), neue H-Fälle (8.4), [CI] statt [Maschine]
  (8.5), Migrationsnummern (6.4).

**Abgelehnt oder anders gelöst** (mit Grund):

1. **C1-Sicherung vorher aus den beim Blockvergleich gelesenen abweichenden Blöcken** (Review
   Umfang, Kernbefund 8): abgelehnt. Der Vergleich liest nur Blöcke, die **im Stand** belegt
   sind; Blöcke, die erst seit dem Stand belegt wurden, liest er nie, und auf einem
   BitLocker-Volume mit dem ISO sind die gelesenen Blöcke Chiffretext. Ein so entstandener
   `pre_rollback`-Stand wäre unvollständig und würde Grün vortäuschen. Statt dessen: Grundregel 3
   für C1 eingeschränkt und eine **volle** Sicherung vorher als Wahl im Plan (Frage 19).
2. **`recoveryenabled no` in der Wegwerfkopie der Startprobe** (Review Umfang, §4.4.2):
   abgelehnt. Mit `hv-crash` meldet Windows einen Bluescreen über die Crash-MSRs, bevor es neu
   startet und den Wiederherstellungsbildschirm zeigt; die Änderung brächte keinen zusätzlichen
   Beleg und bräche den Grundsatz "Beweis ohne Änderung am Image". Fehler des Bootmanagers ohne
   Bluescreen bleiben in beiden Fällen "unvollständig".
3. **ODBC über das mitgelieferte `SQLSRV32` als Lösung für TDS 8** (Review Interna, 5.1):
   teilweise abgelehnt. `SQLSRV32` kann ebenfalls kein TDS 8; es hilft nur gegen WDAC und den
   Constrained Language Mode. Für Strict Encryption braucht es "ODBC Driver 18" (oder neuer),
   den der Agent nutzt, wenn er installiert ist (5.1.2), sonst meldet er
   `sql_strict_encryption`.
4. **Ab dem ersten Schreibzugriff den Restow-Eintrag zur BCD-Vorgabe machen** (Review Umfang,
   §4.3 C2) allgemein: nur übernommen, wenn die WIM auf einem Volume außerhalb der Gruppe liegt.
   Liegt sie auf C:, würde der Eintrag nach einem Stromausfall auf eine halb überschriebene WIM
   zeigen und den Rechner in einer Startschleife halten; dann bleibt der Fernzugriff (C2
   Schritt 1, 8).
5. **Log-Replay der Hives in Go als Vorgabe** (Review Interna, 4.1.5): auf später verschoben
   (W10). Die Vorbereitung im laufenden System und Weg B lösen die häufigen Fälle ohne eigenen
   Schreiber für ein nicht von Microsoft dokumentiertes Format; die CI misst, wie oft schmutzige
   Hives vorkommen (8.2), und entscheidet über den Bedarf.
6. **VMware (`pvscsi`) als geprüftes Quellsystem** (Review Umfang, §2.1): gestrichen statt
   ergänzt. Es gibt dafür weder Labor noch Fall; VMware-Gäste laufen mit der Warnung "nicht
   geprüft", eine Wiederherstellung auf andere Hardware nur über B mit dem Treiber im Kit.

## 12. Stand der Umsetzung

Stand: Zweig `wip/050-windows-sql` von `release/0.5.0`, nicht committet. Umgesetzt sind die
Meilensteine **W1** ("Ehrliche Grundlage") und **W2a** ("SQL, erste Stufe") aus Abschnitt 9,
nichts von W2b, W3 und später und nichts von Bare Metal. Kein Schalter für Images oder den
ganzen Rechner ist sichtbar.

### 12.1 Was der Entwurf voraussetzt und dieser Zweig nicht hat

- Die Code-Verweise des Entwurfs zeigen auf `wip/050-windows-bmr` (M1 bis M3: `internal/baremetal`,
  `internal/recovery`, `fsbackup.go`, Migrationen 0076 bis 0079 mit `endpoint_layouts`). Nichts
  davon liegt auf `release/0.5.0`; W1 und W2a brauchen keinen M-Meilenstein (Abschnitt 9) und sind
  gegen das gebaut, was es gibt. Nichts verweist auf `endpoint_layouts`, `wholeMachineApplies`
  oder `fsbackup.go`.
- Die W2a-Migration ist **`0089_endpoint_sql.sql`** (die nächste freie Nummer nach
  `0088_archive_capture_gap_spacing`); sie bekommt beim Merge die nächste freie Nummer und ist
  dafür in sich geschlossen.
- Die Hook-Empfehlung mit `sqlcmd` stand an anderen Zeilen als in 6.6 genannt:
  `agent/README.md:244`, `docs/AGENT.md:1442`, `docs/WINDOWS-AGENT.md:208` und `:1640`.
  `agent/internal/hooks/pwsh_test.go:26` nutzt `sqlcmd` nur als Testdaten des Parsers und
  bleibt.

### 12.2 Entscheidungen zu Widersprüchen und Lücken (C1 bis C24)

| # | Entwurf | Problem | Umsetzung |
| --- | --- | --- | --- |
| C1 | Migration W2a nur mit `sql_verify` und zwei Tabellen | Läufe und Aufgaben der neuen Arten brauchen Enum-Werte; das Skript für einen anderen Rechner braucht SHA-256 und FILELISTONLY, die der Server nicht selbst lesen kann; die TDE-Bestätigung braucht einen Ort | 0089 fügt auch die Laufarten `sql`, `sql_restore`, `sql_verify` und die Aufgabenarten `sql_restore`, `sql_verify`, `sql_inventory` hinzu, dazu `endpoint_sql_backups.endpoint_id`, `sha256`, `file_list`, `compressed`, `checksum` und `endpoint_sql_databases.last_seen_at`, `tde_confirmed_at`, `tde_confirmed_by`. Alle `ADD VALUE` vorn, keiner wird in derselben Migration benutzt |
| C2 | Tags und `--group-by host,tags` | Der Server benutzt restics Behalte-Regeln nicht (`apps/worker/src/endpoints/retention.ts`); ein Snapshot, den kein Lauf meldet, wird `unrecorded` | Die Aufbewahrung liest Läufe `backup` **und** `sql` sowie die aktiven Zeilen von `endpoint_sql_backups`, teilt in Gruppen (`files`, `sql:<INSTANZ>`) und wendet die Regeln des Rechners je Gruppe an (`@restow/core applyGroupedRetention`). Ein vergessener SQL-Snapshot setzt seine Zeilen auf `pruned` |
| C3 | W1: zwei Snapshot-Sätze "in den restic-Logs" | restic schreibt bei gelungenem VSS nichts | Beleg aus `Get-CimInstance Win32_ShadowCopy` (SetID, InstallDate, VolumeName), abgefragt während `restic.Runner.Backup` mit Schattenkopie läuft; Ergebnis in die Job-Zusammenfassung |
| C4 | "Variablen in BACKUP, RESTORE und DBCC **[CI]**" | Variablen in BACKUP und RESTORE sind dokumentiert, eine Variable als Datenbankname von DBCC CHECKDB nicht | BACKUP und RESTORE mit `SqlParameter`; `DBCC CHECKDB`, `ALTER DATABASE … SET NEW_BROKER` und `DROP DATABASE` als fester T-SQL-Text, der den Befehl auf dem Server mit `QUOTENAME(@db)` baut und mit `sp_executesql` ausführt |
| C5 | `CommandTimeout = 0`, Abbruch über `SqlCommand.Cancel` | PowerShell 5.1 liest kein stdin, während ein synchrones `ExecuteNonQuery` blockiert; Skriptblöcke als asynchrone Rückrufe scheitern außerhalb ihres Runspace | `CommandTimeout` = Grenze je Schritt, die der Agent sendet (der Treiber sendet dann ein Attention-Signal, wie `Cancel`); als Rückfall beendet Go das Job-Objekt bei Grenze + 5 Minuten. Ein Stopp in der Oberfläche beendet das Job-Objekt; der Server bricht die Anweisung ab, das Aufräumen entfernt Reste (C7) |
| C6 | Skript über `hooks/run_windows.go` | `hooks.Run` hat kein stdin und mischt stdout und stderr | Eigener Runner `internal/sqlserver/runner_windows.go` mit `hooks.PowerShellExe()`, `procctl`, `procenv.Base()` und `CREATE_NO_WINDOW` |
| C7 | Prüfname `<db>__restow_verify_<zeit>`, erkannt "am Präfix" | Das ist ein Infix; Namen haben höchstens 128 Zeichen; Löschen nur nach Muster könnte eine Kundendatenbank treffen | Name = erste 80 Zeichen der Datenbank + `__restow_verify_<yyyymmddThhmmssZ>`. Vor jedem RESTORE schreibt der Agent den geplanten Namen in ein Journal (`data\sql-verify-journal.json`); das Aufräumen löscht nur Namen, die **im Journal stehen und** dem Muster folgen |
| C8 | Die Dateisicherung schließt die Daten- und Log-Ordner der Instanzen aus | Diese Ordner können andere Daten enthalten | Ausgeschlossen werden die Datenbankdateien selbst (`sys.master_files.physical_name` aus dem Inventar des Agenten) und ein eigener `stagingDir` |
| C9 | `sql: {…, logIntervalMinutes, stagingDir, verify:{schedule,…}}` in der Agent-Konfiguration | Die Prüfung plant der Server, das Log-Intervall ist W2b | Die Agent-Konfiguration trägt `enabled, mode, instances, databases, exclude, stagingDir`. Die Prüfung steht in `endpoints.config.sql.verify` (Wochentag, Uhrzeit, `maxGiB`, `physicalOnly`), `agentFacingConfig` entfernt sie; `maxGiB` und `physicalOnly` gehen mit der Aufgabe |
| C10 | `FinishRequest.Sql` je Lauf, eigener Snapshot je Instanz und Lauf | `endpoint_runs.snapshot_id` hält einen Snapshot | **Ein `sql`-Lauf je Instanz**; seine `snapshotId` ist der Snapshot dieser Instanz |
| C11 | `/api/v1/endpoints/:id/sql/:db/restore-script` | Das Skript gilt je Datenbank **und Zeitpunkt** | `GET /api/v1/endpoints/:id/sql/backups/:backupId/restore-script` |
| C12 | Alarme `sql.red`, `sql.recovered`, `sql.overdue` | Der Katalog (`packages/core/src/reports/catalog.ts`) nutzt das Präfix `endpoint.*` | `endpoint.sql_red` (Fehler), `endpoint.sql_recovered` (Info), `endpoint.sql_overdue` (Warnung), Gruppe `jobs` |
| C13 | W1 "BitLocker-Zusammenfassung"; 3.2 liest die Signatur `-FVE-FS-` von der rohen Partition | Das rohe Lesen braucht die Plattenausdehnung (W3) | W1 nur über WMI (`Win32_EncryptableVolume`, feste eingebettete Abfrage, JSON, numerische Zustände ohne Übersetzung); das rohe Lesen bleibt in W3 |
| C14 | Kettenangaben aus `msdb.dbo.backupset` und HEADERONLY | In Verfügbarkeitsgruppen hat jede Replik ihr msdb, und Historie kann bereinigt sein | Kettenangaben nur aus `RESTORE HEADERONLY` der eigenen Datei; msdb nur für Anzeigefelder des Inventars |
| C15 | Restore-Skript für einen anderen Rechner "in der CI getestet" | Es entsteht in TypeScript auf dem Server; der Windows-Runner hat keinen Build des Monorepos | `packages/core/src/endpoints/sql/restore-script.ts` hat keine Imports (ein Test erzwingt das); die CI rendert mit `node --experimental-strip-types scripts/ci/render-sql-restore-script.mts` (Node 22 aus `.nvmrc`) |
| C16 | VHDX "D:" und "L:" | `D:` ist auf gehosteten Windows-Runnern belegt (Arbeitsordner `D:\a`) | `Q:` (Daten) und `L:` (Log) |
| C17 | "Keine Verkettung in `CommandText`" | Die Zahl der MOVE-Klauseln wechselt | Verkettet werden nur Platzhalter (`MOVE @l<n> TO @p<n>`) aus einer Ganzzahl-Schleife in genau einer Funktion (`New-RestowMoveClause`); der Test erlaubt genau diese |
| C18 | Das Inventar "verbindet alle 6 Stunden" | Ohne Anmeldung schreibt jede Verbindung einen Fehler 18456 in Fehlerprotokoll und Audit der Instanz | Alle 6 Stunden **nur, solange `sql.enabled`**; sonst einmal je Aufgabe `sql_inventory` (Knopf "Anmeldung prüfen"), die wie `update_config` mit der Zustellung erledigt ist |
| C19 | 6.2 nennt keine Fähigkeit | Der Server darf einem älteren Agenten keine SQL-Aktionen anbieten | Heartbeat und Enroll tragen `capabilities: ["sql_native_v1"]` (`settings.agent.capabilities`); jede SQL-Aktion antwortet sonst 409 `endpoint-sql-unsupported` |
| C20 | Anmeldeblock in der Oberfläche (5.1.2) | i18n-Texte dürfen kein wörtliches `Restow` enthalten | Den T-SQL-Block baut die API (`packages/core/src/endpoints/sql/login-script.ts`), die Oberfläche zeigt ihn als Code; Texte nutzen `{account}` |
| C21 | W2a ohne Sperrklassen (W2b) | Ein langes `sql_verify` verzögert die nächste geplante Sicherung, weil der Agent Aufträge nacheinander ausführt | Für W2a hingenommen. Der Editor und die API verlangen mindestens 1 Stunde zwischen Prüftermin (Vorgabe Sonntag 03:00 in der Zone des Jobs) und täglicher Sicherung |
| C22 | Systemdatenbanken in der Prüfung | `master`/`msdb` unter neuem Namen wiederherzustellen ist **[CI]** | Wie Benutzerdatenbanken geprüft; zeigt die CI, dass es nicht geht, ist das Ergebnis unvollständig mit `sql_verify_system_db`. **CI (2019 und 2022 Express):** `msdb` grün; `master` lässt sich unter dem Prüfnamen wiederherstellen, CHECKDB meldet aber 13 bis 16 Zeilen, angeführt von Katalogfehlern 8992 ("Check Catalog Msg 3851 … sys.syssingleobjrefs (class=60)"), weil die Kopie die Einträge der Serverebene trägt, die nur `master` haben darf. Darum ist `master` unvollständig mit `sql_verify_system_db`, wenn CHECKDB nur 8992 und die zählenden Schlusszeilen 8990/8991 meldet (`masterCatalogOnly` in `verify.go`); jeder andere Fehler bleibt Beleg, und 8992 in jeder anderen Datenbank auch. Dass außer 8992 nur 8990/8991 kommen, ist aus dem zweiten Lauf geschlossen (die Meldung nannte nur die erste Zeile); das Skript gibt jetzt jede Zeile aus |
| C23 | Mehr-Volume-Befund (8.2): "SQL Express mit Daten auf D: und Log auf L:, heutiger Agent" | Ein Lauf nur mit Zufallsdateien belegt den Befund für restic, nicht für Dateien einer Datenbank unter Last | Zweimal nachgestellt: `windows-multivolume` mit Zufallsdateien auf `Q:` und `L:` (der reine restic-Befund), und im Job `windows-sql` mit den Ordnern der Daten- und Log-Datei von `RestowCi` (`Q:\Data`, `L:\Log`), während die Last schreibt (`RESTOW_TEST_SOURCES`). Beide Male über `restic.Runner.Backup` des Agenten mit `--use-fs-snapshot`, also mit genau dem Aufruf, den die Dateisicherung des Agenten macht; ein ganzer Datei-Job mit Server läuft in der CI nicht |
| C24 | Editionen der CI (Express für alles) | Express hat keine Sicherungskomprimierung und keine Option `backup compression default` (`sp_configure` scheitert mit 15123); "`Compressed = 0` bei eingeschalteter Vorgabe" beweist dort nichts | Das Komprimierungs-Gate läuft im Linux-Container mit `MSSQL_PID=Developer` (`tsql-linux`); `windows-sql` bleibt bei Express, schaltet die Vorgabe dort nicht ein und meldet `Compressed = 0` nur als Tatsache |

### 12.3 Geliefert

**W1, Server und Oberfläche:**

- `machine.windows` im Heartbeat (Version, Build, UBR, DisplayVersion, Produkt- und
  Installationsart, Domäne, Rollen, SQL-Instanzen aus der Registry, BitLocker je Volume), geprüft
  und begrenzt in `@restow/core parseWindowsFacts`, nur für Windows-Rechner gespeichert. Die
  Rechnerseite zeigt eine Karte "Windows"; die Betriebssystemzeile kommt vom Agenten
  (`OSVersionText`).
- Feste Hinweise `app_files_not_app_backup` (SQL Server, Exchange, Active Directory, Hyper-V) auf
  der Rechnerseite (`appNotices` der Detail-API, `@restow/core appFilesNotices`) und als
  `notices` jedes Laufs (`stats.notices`, Lauf-Blatt); der SQL-Server-Teil entfällt, sobald die
  native Sicherung alle Datenbanken abdeckt.
- Hook-Doku korrigiert: docs/AGENT.md, docs/WINDOWS-AGENT.md (2.2 und 17.5), agent/README.md.
- Mehr-Volume-Befund (Abschnitt 8.2, C3, C16, C23): Job `windows-multivolume` mit Zufallsdateien
  auf `Q:` und `L:` und im Job `windows-sql` mit den Daten- und Log-Ordnern von `RestowCi` unter
  Last.

**W2a, Server:**

- Migration `0089_endpoint_sql.sql`: Enum-Werte (C1), `endpoint_sql_databases` (eindeutig nach
  Rechner, Instanz, Name und `family_guid`), `endpoint_sql_backups` mit den Kettenspalten für W2b
  (LSNs als `numeric(25,0)`, im Vertrag als Dezimal-Zeichenketten), beide in `tenant_tables`
  (`sql/rls.sql`). `pnpm generate --name check` meldet keine Änderung.
- Vertrag: gemeinsame Testdaten `agent/internal/api/testdata/contract/*.json`, gelesen vom
  Go-Test, von `packages/core/src/endpoints/sql/contract.test.ts` und vom Postgres-Test der API.
  Auch die Aufgaben `task-sql-verify.json` und `task-sql-restore.json` prüfen beide Seiten: Der
  Server baut aus der Sicherung der Fixture genau deren `params` (`sqlVerifyTaskParams` im
  Core-Test, `requestSqlVerify` und `requestSqlRestore` im Postgres-Test, Schlüssel für
  Schlüssel); der Agent dekodiert sie streng.
- `packages/core/src/endpoints/sql/`: Leser des Vertrags (`schemas.ts`, verwirft statt abzulehnen),
  Urteil (`judge.ts`: rot nur mit Beleg, grün nur mit `restore+checkdb`, sonst unvollständig mit
  dem Code des Agenten; `RESTORE VERIFYONLY` macht nie grün), Bewertung (`rating.ts`),
  Anmeldeblock (`login-script.ts`), Restore-Skript ohne Imports mit Golden-Datei
  (`restore-script.ts`, `testdata/restore-script.golden.ps1`), Namensregeln (`names.ts`),
  Aufbewahrungsgruppen, Prüfplan (`verify-plan.ts`), Einstellungen.
- API: Heartbeat schreibt Fähigkeit, Windows-Fakten und Inventar (`dropped_at` bei fehlenden
  Datenbanken eines vollständigen Inventars, `settings.sqlInstances` mit eigenem `jsonb_set`);
  `finish` der Läufe `sql`, `sql_verify` (Urteil und Bericht je Datenbank der Aufgabe) und
  `sql_restore` (Audit); `sql_inventory` mit der Zustellung erledigt; `sql_verify` während einer
  Update-Pause zurückgehalten; Session-Routen `GET /:id/sql`, Sicherungen je Datenbank, Restore
  unter neuem Namen, Prüfen jetzt, Anmeldung prüfen, Restore-Skript (auditiert), TDE-Bestätigung;
  Stopp erreicht SQL-Läufe; Fähigkeits- und Widerrufsprüfung (409).
- Worker: Aufbewahrung je Gruppe (C2), Prüfplanung am Termin des Jobs (je Instanz eine Aufgabe,
  keine, solange eine wartet, sieben Tage gültig), Alarme `endpoint.sql_red`,
  `endpoint.sql_recovered`, `endpoint.sql_overdue` je einmal; ein fehlgeschlagener `sql`-Lauf ist
  `backup.failed`, ein `sql_verify` meldet sich nur über seinen Bericht.
- Oberfläche (Vorschau): Reiter "SQL Server" für Windows-Rechner mit SQL Server (Instanzen mit
  Anmeldestand und T-SQL-Block mit Kopierknopf, "Anmeldung prüfen", Datenbanken mit Modell,
  letzter Sicherung, Bewertung, letzter Prüfung, "Jetzt prüfen", Restore-Dialog, Restore-Skript,
  TDE-Bestätigung), SQL-Ergebnisse und Hinweise im Lauf-Blatt, Abschnitt "SQL Server (Vorschau)"
  im Job-Editor (Datenbanken, Auslassen, Staging-Ordner, Prüftermin, `maxGiB`, PHYSICAL_ONLY,
  Abstandsprüfung C21). Texte de und en.
- CI `.github/workflows/sql-server.yml` (Jobs `tsql-linux`, `windows-multivolume`, `windows-sql`
  mit 2019 und 2022), aus `release.yml` mit `strict: true` aufgerufen, dazu bei Push und Pull
  Request auf die SQL-Pfade (Push auch auf Zweige ohne Pull Request, außer `dependabot/**`). `biome check` lässt die
  Testdaten unter `agent/**/testdata` aus: Die Golden-Dateien schreibt Go mit
  `json.MarshalIndent` und vergleicht sie Byte für Byte.

**W2a, Agent** (eigener Teil desselben Zweigs, `agent/`): `internal/sqlserver` (Skript
`sql.ps1`, `statements.go` als einzige T-SQL-Quelle, Planung, Runner, Abläufe Sicherung, Prüfung,
Restore, Inventar, Journal), Windows-Fakten in `internal/sysinfo`, Vertragstypen in
`internal/api`, `internal/core/sql.go` und `notices.go`, `scripts/test-sql-windows.ps1`,
Hinweis auf die SQL-Anmeldung im Installer.

### 12.4 CI und Editionen

- **Editionen je Prüfung:** SQL Server **Developer** im Linux-Container (`tsql-linux`,
  `MSSQL_PID=Developer`: T-SQL-Texte und das Komprimierungs-Gate, C24) und SQL Server **Express**
  auf dem Windows-Runner (`windows-sql`, 2019 und 2022: alles andere). Beide kosten nichts und
  sind für Entwicklung und Test gedacht; ihre Lizenz für diese Nutzung bestätigt der Maintainer.
  Das ist eine eigene Frage, getrennt von Frage 12 (Windows-Evaluierungsfassungen), und
  blockiert nichts. Der Container ist per Digest gepinnt
  (`mcr.microsoft.com/mssql/server:2022-CU22-ubuntu-22.04`); der Windows-Installer wird mit
  `/ACTION=Download` geladen und über die Authenticode-Signatur geprüft. Keine Caches und keine
  Artefakte mit Dateien von Microsoft.
- `tsql-linux` prüft die T-SQL-Texte (C4, `NO_COMPRESSION` gegen `backup compression default`,
  Spalten von FILELISTONLY und HEADERONLY, CHECKDB TABLERESULTS, NEW_BROKER, DROP mit Namen wie
  `a]b'c`, die Namensprüfung im Batch des RESTORE, `DropRestoring` mit einer Datenbank in
  `RESTORING` und einer `ONLINE`, CHECKDB einer fehlenden Datenbank als unvollständig). Lokal
  gegen den gepinnten Container mit `MSSQL_PID=Developer` gelaufen und grün.
- `windows-sql` prüft auf dem Runner: ohne Anmeldung `sql_login_missing`, die kleine
  Rechtevariante, Anmeldung über die Dienst-SID, Schreibrecht der SQL-Dienst-SID auf das
  Staging, Full unter Last, den Mehr-Volume-Befund mit den Dateien von `RestowCi` unter
  derselben Last (C23), Prüfung aus dem Repository grün und eine beschädigte Kopie rot, Restore
  unter neuem Namen mit CHECKDB, das gerenderte Restore-Skript auf der zweiten Instanz `RESTOWB`
  ohne `-StagingDir` und ohne von Hand gesetzte Rechte, und einmal mit `-StagingDir` auf einen
  Ordner mit einer fremden Datei, die bleiben muss; `is_copy_only = 1` in msdb.
- Ein fehlgeschlagener Download macht den Lauf "unvollständig" (Hinweis in der
  Zusammenfassung); aus dem Release (`strict: true`) ist er rot.

### 12.5 Offen

**Braucht die CI (noch nicht gelaufen, nur lokal gebaut):** alle **[CI]**-Punkte von 5.1 auf
Windows (Dienst-SID-Anmeldung über Shared Memory, Strict Encryption über Shared Memory,
Systemdatenbanken unter neuem Namen, C22), der Mehr-Volume-Befund (C3, C23), `sql.ps1` und das
Restore-Skript unter Windows PowerShell 5.1 (Rechte des eigenen Staging-Ordners, Lesen durch die
Dienst-SID), die Vertrauensprüfung eines eigenen `stagingDir` (`fs_windows.go`) und
`test-sql-windows.ps1` selbst. Lokal gibt es weder Windows noch PowerShell; der Windows-Code
ist über die Runner- und Fake-Abstraktionen mit aufgezeichneten Ausgaben und Golden-Dateien
getestet und für Windows gebaut (`go vet`, Testbinaries). Die T-SQL-Texte liefen lokal gegen den
Linux-Container (Developer). CHECKDB bei vollem tempdb ist nur über aufgezeichnete Läufe
(`verify-checkdb-tempdb-full.jsonl`, `verify-checkdb-8921-row.jsonl`) und die Tabelle in
`TestJudgeCheckdb` geprüft; der Container lässt sich dafür nicht verlässlich füllen.

**Braucht eine echte Windows- bzw. SQL-Maschine (Maintainer, vor dem Release):** H5 (Full,
Restore unter neuem Namen, Restore-Skript, CHECKDB auf 2019 Standard), H10 (deutsches und
englisches Windows, Constrained Language Mode, Strict Encryption), H22. Bis dahin sagt die
Oberfläche "Vorschau".

**Verschoben:**

- W2b: eigene Log-Kette, Point-in-Time, Tail-Log, Restore über die vorhandene Datenbank
  (`REPLACE`), Sperrklassen, ODBC-Rückfall, Alarme `sql.chain_*`.
- W3 und später: Images, das rohe Lesen von BitLocker, das Windows-Layout; kein Schalter für
  Images oder den ganzen Rechner ist sichtbar.
- Schwärzen des Staging-Ordners im Image (W4).
- Ein `stagingDir` je Instanz (W2a kennt einen für alle Instanzen).
- Eine Prüfinstanz auf einem anderen Rechner (Frage 15).
- Automatischer Restore von `master` (die Doku beschreibt den Weg, 5.1.6).
- Eigene SQL-Einstellungen je Rechner in einem Job (die API nimmt `sql` als Override an, die
  Oberfläche bietet es noch nicht an).

### 12.6 Review von W1 und W2a

| Befund | Entscheidung |
| --- | --- |
| CHECKDB, das nicht lief, wurde rot (tempdb voll 1105/8921, 701, 9002, 2520, 50001, Verbindungsabbruch) | Angenommen: Urteil im Agenten (`JudgeCheckdb`, 5.1.7), Beleg nur aus Zeilen und einer Liste von Konsistenzfehlern; aufgezeichnete Läufe für tempdb voll, 8921 als Zeile und Verbindungsabbruch (mit und ohne Ergebnis) ergeben unvollständig. **Abgelehnt** ist ein Teil des Vorschlags: 2533 auszunehmen. 2533 ("page … was not seen") ist ein Tabellenfehler von CHECKDB, also Beleg; ein aufgezeichneter Lauf mit ausgelöstem 2533 ergibt rot. Die Ausnahme im alten Code hatte keinen Grund; "Datenbank nicht gefunden" ist 2520 und steht bei den Abbrüchen |
| Restore-Skript löscht den Ordner von `-StagingDir` | Angenommen: immer ein neuer eigener Ordner, nur der wird gelöscht (5.1.4); Unit-Test und CI-Fall mit fremder Datei |
| Restore-Skript: Standard-Staging für SQL Server nicht lesbar | Angenommen: geschützte DACL mit Lesen für die Dienst-SID; CI-Lauf ohne `-StagingDir` und ohne `icacls` |
| Restore-Skript: restic stellt die gesicherten Security Descriptors über das Geholte; die `.bak` gibt nur der Dienst-SID der Quellinstanz Lesen, auf einer Instanz mit anderem Namen (`RESTOWB` aus einer Sicherung von `SQLEXPRESS`) scheitert `RESTORE FILELISTONLY` mit OS-Fehler 5 | Angenommen: `Set-RestowStagingAccess` direkt nach `restic restore` setzt auf jedes geholte Element die geschützte DACL des Ordners (SYSTEM, Administratoren, ausführender Benutzer, Lesen für die Dienst-SID der Zielinstanz), von oben nach unten, Links brechen ab. Vor dem Hash statt danach: Ohne Erhöhung (restic setzt dann nur die DACL, Administratoren gelten nur zum Verweigern) könnte der Benutzer die Datei sonst nicht einmal hashen, und `Get-FileHash` folgt keinem Link mehr. `icacls /reset /T` ist abgelehnt: es setzt auch den eigenen Ordner auf die geerbte DACL von TEMP zurück (oder braucht `*`), und Links ließen sich nur getrennt prüfen. Unit-Test prüft die Reihenfolge restic, Rechte, Hash, FILELISTONLY; der CI-Fall auf `RESTOWB` ist der Beleg |
| `sql-server.yml` lief auf Zweigen ohne Pull Request nie (schedule und workflow_dispatch nur auf dem Standardzweig) | Angenommen: `push` mit denselben `paths` und `branches-ignore: ["dependabot/**"]` wie `ci.yml`; die Concurrency-Gruppe enthält das Ereignis, damit Push, Zeitplan und Handstart einander nicht abbrechen |
| Platzprüfung von Restore und Prüfung ohne Reserve | Angenommen: Reserve je Volume (5.1.7); Flows-Tests mit frei = Bedarf + 1 MiB (abgelehnt), mit einem Zehntel eines großen Volumes und knapp darüber (angenommen) |
| Staging-Ordner bleibt nach gescheiterter Sicherung, Stopp, gescheitertem Snapshot | Angenommen: Löschen auf jedem Weg aus dem Lauf (5.1.3); Golden-Tests prüfen den leeren Ordner, neuer Fall "jede BACKUP gescheitert, eine halb geschrieben" |
| Aufräumen nach gescheitertem RESTORE konnte eine Kundendatenbank löschen | Angenommen: Namensprüfung im Batch, `DropRestoring` nur im Zustand `RESTORING`, Kollisionsfehler 50003, 1801, 3154 räumen nie auf |
| Abgebrochenes Restore-Skript lässt eine halbe Datenbank zurück | Angenommen: Aufräumen über `DropRestoring` (eigener kurzer Kontext bei Stopp); was bleibt, nennt der Lauf mit Zustand und Dateien |
| Eigener `stagingDir` ohne Prüfung von Eigentümer und Elternordnern | Angenommen: 5.1.3 und 7.6 |
| `pnpm lint` scheitert an den JSON-Testdaten des Agenten (zwei gleiche Befunde) | Angenommen: `!**/agent/**/testdata` in `biome.json`; die Dateien bleiben, wie Go sie schreibt |
| Erster CI-Lauf `windows-sql`: "ohne Anmeldung" meldete keinen Fehler. Das Setup machte `BUILTIN\Administrators` zu sysadmin, und die Probe läuft als LocalSystem, das dazugehört | Angenommen: sysadmin ist nur das Konto des Runners (`/SQLSYSADMINACCOUNTS`); so greift die kleine Rechtevariante nur über die Dienst-SID. **Zweiter Lauf:** auch ohne eigene Anmeldung (auch nachdem Schritt 1 eine etwaige Anmeldung `NT AUTHORITY\SYSTEM` entfernt hatte) meldet sich die Probe auf einer frischen Express-Instanz als `NT AUTHORITY\SYSTEM` an, über eine Anmeldung, die das Setup angelegt hat, mit Rechten von `public`: kein sysadmin, kein `CREATE ANY DATABASE`, keine Datenbank sicherbar. Das ist der Normalfall beim Kunden; der Server zeigt dann "Rechte fehlen" mit dem T-SQL-Block, eine Sicherung endet mit `sql_permission_missing`. Schritt 1 lässt die Instanz darum, wie sie ist, gibt ihre Windows-Anmeldungen aus und nimmt `sql_login_missing` oder genau diesen Zustand samt `sql_permission_missing` einer Sicherung an |
| Erster CI-Lauf: `DBCC WRITEPAGE` mit Nullen über dem Satzkopf scheiterte selbst (8944 "Test (offsetNull >= BASEOFFSET)") und beendete das Skript | Angenommen: die beschädigte Kopie entsteht über ein Byte der Daten (`V` der ersten Zeile wird `y`, der Index `IX_T_V` hält `z`); die Seite bleibt wohlgeformt, nur CHECKDB sieht den Widerspruch (8951/8952) |
| Zweiter CI-Lauf, Installertest: "a missing SQL Server key lists instances" und "SQL Server instances: System.Object[]". `Get-SqlInstanceNames` gab die Liste mit `return , @(...)` als ein Objekt zurück, `@(...)` beim Aufrufer machte daraus eine Liste mit einer Liste, nie leer; der Installer hätte auch ohne SQL Server den Anmeldeblock für "SQL Server: ." ausgegeben | Angenommen: die Namen gehen einzeln in die Pipeline, ohne Schlüssel nichts |
| Zweiter CI-Lauf, `go test -tags sqlintegration`: `RESTORE HEADERONLY` scheiterte mit 3057 (Gerätename über 259 Zeichen). Die Prüfung holt die Sicherung nach `<RestoreRoot>\<Lauf>\<n>\` und darunter den ganzen Pfad, den die Datei im Snapshot hatte; der Staging-Pfad steht also zweimal im Namen, und der Test lag unter dem TEMP des Benutzerprofils | Angenommen: der Test nimmt einen kurzen Ordner unter `RUNNER_TEMP`. Mit den Ordnern des Agenten (`C:\ProgramData\Restow\data`) bleibt der Name bei etwa 220 Zeichen; ein eigener `stagingDir` mit mehr als etwa 70 Zeichen kann die Grenze aber reißen (Prüfung und Restore unvollständig mit 3057). Offen: aus dem Snapshot nur den Ordner der Datei holen (`<snapshot>:<ordner>`) oder die Länge vorher prüfen |
| Erster CI-Lauf: der Mehr-Volume-Befund sah in beiden Jobs keine Schattenkopie (`map[]`). Die feste WMI-Abfrage ging über `-Command -` an PowerShell 5.1, das stdin wie die Konsole liest: eine Anweisung über mehrere Zeilen wartet auf eine Leerzeile, die nie kommt, die Abfrage schrieb nichts | Angenommen: `-EncodedCommand`; leere Ausgabe ist ein Fehler, fehlgeschlagene Abfragen und das, was restic über die Schattenkopien meldet, stehen im Beleg |
| Aufgaben-Fixtures nur von Go gelesen | Angenommen: Core- und Postgres-Test vergleichen die gebauten `params` mit den Fixtures |
| W1-Gate nicht wie 8.2 gebaut | Angenommen: C23 |
| Texte versprechen spätere Stufen | Angenommen: die Texte zu strikter Verschlüsselung, Constrained Language Mode, Failover-Clustern und die Notiz im Job-Editor nennen nur, was 0.5.0 kann (de und en) |
| `AS clustered` ist ein reserviertes Wort (Msg 156) | Angenommen: `AS [clustered]`; im Container geprüft |
| `EXEC (N'…' + QUOTENAME(…))` im Test (Msg 102) | Angenommen: Text erst in eine Variable |
| Express kennt `backup compression default` nicht | Angenommen: C24 |
| Spalte `FileID` heißt `FileId` | Angenommen: Test prüft `FileId` (das Skript liest ohne Rücksicht auf Groß- und Kleinschreibung) |
| `Set-StrictMode` und fehlende Felder (`omitempty`) in `test-sql-windows.ps1` | Angenommen: alle optionalen Felder über `Get-Field` |
