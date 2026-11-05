# Bare-Metal-Sicherung und -Wiederherstellung für Restow 0.5.0 (Entwurf)

Dieses Dokument beschreibt, wie Restow 0.5.0 einen ganzen Rechner sichert und auf neuer oder
leerer Hardware wiederherstellt: **Linux vollständig** (Kennzeichnung "Vorschau") mit einem
bootfähigen Recovery-ISO und `restow-agent recover`, **macOS** als "macOS neu installieren,
dann Daten und Einstellungen aus der Sicherung vom APFS-Snapshot zurückholen", **Windows Bare
Metal nicht in 0.5.0**. Dazu gehören die Dateisystem-Snapshots unter Linux (LVM, btrfs) und
macOS (APFS) mit derselben Richtlinie `snapshotOnFailure` und demselben Berichtsfeld
`consistency`, die mit dem Windows-Agenten (VSS) gebaut wurden. Die Grundentscheidungen hat
der Maintainer getroffen (Abschnitt 25.A). Dieses Dokument legt fest, wie. Es ergänzt
docs/AGENT.md (Vertrag Agent/Server), docs/WINDOWS-AGENT.md (Snapshot-Begriffe, Abschnitt 17)
und agent/README.md; alle drei werden mit der Umsetzung angepasst (Abschnitt 17).

Stand der Code-Verweise: Zweig `wip/050-baremetal`, Commit `d980860` (auf `release/0.5.0`
nach dem Merge von 0.4.12). restic-Fakten sind gegen das gepinnte restic 0.19.1
(`agent/tools.env`) geprüft (`restic backup --help`, `restic restore --help`,
`restic ls --help`, `restic diff --help`, globale Optionen). Was sich nur auf echter Hardware
klären lässt, ist mit **[Maschine]** markiert und steht im Testplan (Abschnitt 21.4) und
gesammelt in Abschnitt 27. Was nur in der CI mit KVM bzw. auf dem macOS-Runner geklärt werden
kann, trägt **[CI]**. Was gegen die Quellen von restic `v0.19.1` zu belegen ist, bevor der
betroffene Meilenstein als fertig gilt, trägt **[Quelle]** und steht in Abschnitt 1.2.

Überarbeitet nach drei Reviews (Wiederherstellung auf echter Hardware, Sicherheit, macOS und
Umfang). Die wichtigsten Änderungen gegenüber dem ersten Entwurf: Schutz vor doppelten
Identitäten, wenn alte Platten angeschlossen bleiben, und Übernahme intakter Datenplatten
statt Löschen; Treiberprüfung **vor** dem Löschen; vollständige Erfassung (verschachtelte
btrfs-Subvolumes, Automount, `noauto`, Plain-dm-crypt, LVM-Gerätedatei, Secure-Boot-Stand,
MOK, UKI, Tastaturbelegung im initramfs); Rechnen in Bytes und Ziel-LBA bei 4Kn; Code an die
Origin der Instanz gebunden, Freigabe nach dem Eintausch, Prüfwert des Zertifikats statt
Trust on first use; Programme aus der Sicherung laufen in eigenen Namensräumen ohne Netz und
nur mit den Zielgeräten; das Labor ist vom Worker getrennt und hat weder Datenbank noch
Master-Key; macOS sichert das ganze Data-Volume mit Ausschlüssen, bindet die Migration an
eine eigene Lese-Sitzung und hat eine eigene, belegte Prüfung; eine Migration je
Meilenstein; die Startprobe (M5) ist Pflicht für 0.5.0. Die Befunde, die nicht oder anders
übernommen wurden, stehen mit Grund in Abschnitt 25.C.

Der Maßstab des Maintainers ist: Es muss beim ersten Mal auf echten Maschinen funktionieren.
Daraus folgen vier Grundregeln, die sich durch das ganze Dokument ziehen:

1. **Identität bewahren statt umbauen.** Die Wiederherstellung baut denselben Speicherstapel
   wieder auf (Partitionstabelle, RAID, LUKS, LVM, Dateisysteme) mit denselben UUIDs,
   PARTUUIDs, Labels, Namen und Dateisystem-Funktionen. Dann stimmen `fstab`, `crypttab`,
   `mdadm.conf`, GRUB-Konfiguration und Kernel-Kommandozeile ohne Änderung. Nur Größen und
   die Zuordnung zu Platten dürfen sich ändern. Wer den Stapel ändern will (RAID weglassen,
   LVM entfernen, BIOS nach UEFI), installiert neu und holt Dateien zurück; das ist bewusst
   nicht Teil von 0.5.0 (Abschnitt 2.2). Weil die Identität gleich bleibt, darf **keine**
   zweite Kopie dieser Identität am Ziel angeschlossen sein (Abschnitt 10.7).
2. **Erst prüfen, dann zerstören.** Vor dem ersten Schreibzugriff auf eine Zielplatte steht
   ein vollständiger Plan (jeder Befehl mit Argumenten), den der Bediener sieht und bestätigt.
   Alles, was sich vor dem Löschen prüfen lässt, wird vor dem Löschen geprüft: Größen aus der
   tatsächlichen Restore-Größe, Treiber des gesicherten Kernels für die Zielhardware,
   Secure-Boot-Stand der Ziel-Firmware, doppelte Identitäten, Lese- und Schreibbarkeit der
   Zielplatten. Derselbe Planer läuft auf dem Server gegen jedes erfasste Layout
   (Abschnitt 12.1). Ein Layout, das der Planer nicht umsetzen kann, wird nie grün.
3. **Nichts löschen, was nicht gelöscht werden muss.** Intakte Datenplatten, Arrays und
   Volumes, deren Identität zum Manifest passt, werden übernommen statt neu angelegt
   (Abschnitt 10.7). Nicht gesicherte Rohgeräte (VM-Platten in einem Thin-Pool) werden nicht
   leer neu angelegt, als wären sie wiederhergestellt (Abschnitt 10.10).
4. **Grün ist Beweis.** "Bare Metal: grün" heißt, dass für genau dieses Layout und diese
   Startkette eine Wiederherstellung in einer virtuellen Maschine bis zum gestarteten System
   gelaufen ist (Abschnitt 12.3), auf einem anderen Controllertyp als die Quelle und mit dem
   Secure-Boot-Stand echter Firmware. Eine Prüfung, die nicht vollständig lief, bewertet
   nichts. Für macOS gilt dieselbe Regel mit einer eigenen Prüfung (Abschnitt 12.5).

Harte Randbedingungen, die für alles Folgende gelten:

- Der Go-Agent nutzt kein Go-Modul außer seinem eigenen (`agent/go.mod` ohne `require`,
  CI `scripts/ci/check-go-deps.mjs`). Linux-Systemaufrufe nur über das Standardpaket
  `syscall` (Rohaufrufe mit Nummer, wo eine Konstante fehlt), Plattenwerkzeuge (`sfdisk`,
  `mdadm`, `cryptsetup`, `lvm`, `mkfs.*`, `btrfs`) als eigener Prozess, immer mit
  Argumentliste, nie über eine Shell. PE- und Authenticode-Auswertung (Secure Boot,
  Abschnitt 4.1) mit `debug/pe` und `encoding/asn1` aus der Standardbibliothek.
- Neuer Linux-only-Code trägt `//go:build linux`, macOS-only-Code `//go:build darwin`
  (Regel aus docs/WINDOWS-AGENT.md, Abschnitt 4); reine Logik (Manifest, Planer, Fixups,
  Pfadabbildung) bleibt ohne Build-Tag und wird auf jedem System getestet.
- Das Recovery-ISO ist ein **eigenes GPL-Werk** unter `integrations/recovery`, getrennt vom
  Apache-2.0-Kern wie das Speicher-Plugin für Proxmox VE und geprüft von
  `scripts/ci/check-separate-works.mjs` (Abschnitt 8.1). Es enthält keinen Restow-Code im
  Quelltext; `restow-agent` und `restic` kommen als fertige Programme hinein. Es enthält
  **keine Geheimnisse und nichts Instanzbezogenes** (keine URL, kein Schlüssel, keine CA);
  es gibt nur das eine, signierte ISO je Release (Abschnitt 8.5).
- Nur ausgehende Verbindungen, Repository des Rechners append-only
  (`packages/core/src/endpoints/restic-authz.ts`, Prinzipal `agent`), signierte Releases
  (`scripts/release/sign-agent.sh`, `agent-SHA256SUMS.sig`). Die Wiederherstellung liest mit
  dem Prinzipal `reader` (nur lesen, nicht einmal Sperrdateien).
- Community-Edition, ohne Lizenzprüfung. Kein Code unter `ee/`, kein Import daraus.

## 0. Kurzfassung

- **Umfang 0.5.0:** Linux amd64 Bare Metal (Vorschau): UEFI und Legacy-BIOS, GPT und MBR,
  mdadm-RAID (0, 1, 4, 5, 6, 10), LVM (linear, striped, raid, thin), LUKS1/LUKS2, ext2/3/4,
  XFS, btrfs (Subvolumes, auch verschachtelte, Mehrgeräte-Profile), vfat (ESP), Swap
  (Partition, Datei, Plain-dm-crypt mit Zufallsschlüssel), getrenntes `/boot`, ESP, mehrere
  Platten, kleinere und größere Zielplatten, 512e/4Kn, NVMe statt SATA und umgekehrt,
  Secure Boot über shim (mit Prüfung von SBAT, DBX und CA der Ziel-Firmware vor dem
  Löschen), Übernahme intakter Datenplatten. macOS: neu installieren, dann Benutzerordner
  und per Drag-and-drop installierte Programme aus einem APFS-Snapshot-Backup zurück; der
  alte Mac kann ersetzt werden oder weiterlaufen. Windows: später.
- **Sicherung:** Ein Backup-Job bekommt den Schalter "Ganzer Rechner". Der Agent sichert dann
  alle lokalen Dateisysteme und jedes btrfs-Subvolume darunter (je Quelle mit
  `--one-file-system`), mit `--group-by host` und dem zusätzlichen Tag `restow-baremetal`,
  aus LVM- oder btrfs-Snapshots in einem privaten Mount-Namensraum (Pfade im Snapshot bleiben
  `/`, `/home`, ...), und erfasst vorher das **Layout-Manifest** (`restow-layout-v1`):
  Platten, Partitionstabellen, RAID, LUKS (nur Metadaten, nie Header-Sicherungen, keine
  Token-Inhalte), LVM, Dateisysteme mit ihren Funktionen, Einhängepunkte samt `fstab`,
  Firmware und Secure-Boot-Stand, Bootloader, initramfs-Erzeuger und dessen Tastaturbelegung,
  Treiberkette der Bootplatten. Das Manifest liegt **im Snapshot selbst**
  (`/var/lib/restow-agent/baremetal/layout.json`, bereinigte Rohausgaben daneben) und als
  Kopie in der Datenbank (`endpoint_layouts`). `state.json` und die Geheimnisse des Agenten
  werden auf keinem System mehr gesichert, auch nicht unter macOS.
- **Recovery-ISO** `restow-recovery_<version>_amd64.iso`: Debian 13 (trixie) Live,
  reproduzierbar gebaut aus einem festen Stand von snapshot.debian.org mit gesperrter
  Paketliste (`packages.lock`), zweimal auf verschiedenen Runnern und vor dem Signieren beim
  Maintainer nachgebaut, mit Debians signierter Startkette (shim, GRUB, Kernel) und damit
  unter Secure Boot startfähig, mit einer festen Liste nicht-freier Firmware (Abschnitt 8.4),
  ohne Auto-Aktivierung von RAID, LVM, btrfs und Swap, `restow-agent` und `restic` aus
  demselben Release. Die SHA-256 des ISO steht in `agent-SHA256SUMS`, die der Maintainer mit
  dem Release-Schlüssel signiert; geprüft wird wie beim Agenten
  (`scripts/release/verify-agent-signature.sh`), mit dem Schlüssel aus dem Git-Tag, nicht
  von der Instanz.
- **Wiederherstellungscode:** in der Oberfläche für einen Rechner ausgestellt, 4 Stunden
  gültig (wählbar 1 bis 48), einmal einlösbar, auditiert, nur Lesezugriff auf das Repository
  dieses Rechners. Form `RC-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX` (25 Zeichen aus einem
  tastaturfesten Alphabet, rund 122 Bit), **an die Origin der Instanz gebunden** (eine fremde
  Adresse bekommt nur einen wertlosen Hash). Nach dem Eintausch gibt ein Admin die Sitzung
  frei (Vergleich einer sechsstelligen Prüfzahl, Vorgabe an); erst dann gibt der Server
  Repository-Passwort und Lesezugang heraus. Solange eine Recovery-Sitzung lebt, laufen für
  diesen Rechner weder Aufbewahrung (Prune) noch Entfernen.
- **`restow-agent recover`** im ISO: Netz (DHCP, statisch, Proxy; kein VLAN, kein WLAN),
  Uhrzeit, TLS mit Prüfwert der Instanz, Code, Freigabe, Snapshot, Zielgeräte, Zuordnung mit
  Übernahme vorhandener Teile, Identitäts- und Treiberprüfung, Plan, Bestätigung,
  Partitionieren, RAID, LUKS (neue Schlüssel, gleiche Parameter, Passphrase des Bedieners in
  der Tastaturbelegung des Starts), LVM, `mkfs` mit den erfassten Funktionen,
  `restic restore --sparse --verify`, Ende des Repository-Zugangs, Fixups, initramfs und
  Bootloader mit Programmen des Zielsystems in eigenen Namensräumen ohne Netz, NVRAM durch
  `recover` selbst, Prüfung, Bericht an den Server, Neustart. Fortschritt und Abbruch auf der
  Konsole und in der Oberfläche; Fortsetzen nach Abbruch oder Stromausfall.
- **Restore-Prüfung auf dem Server:** Stufe 1 "Layout und Startkette" nach jeder
  Ganz-Rechner-Sicherung (Schema, Planer in Grenzen und ohne Umgebung, Manifest im Snapshot,
  Vollständigkeit gegen Manifest **und** `fstab`, Startkette, Restore-Größen). Stufe 2
  **Startprobe**: Wiederherstellung mit dem echten ISO in einer QEMU/KVM-Maschine im
  getrennten Labor bis zum gestarteten System, auf einem anderen Controller, mit einer
  NVRAM-Datei für beide Phasen und aktueller DBX; wöchentlich und bei jeder Änderung von
  Layout oder Startkette. Grün nur mit bestandener Startprobe für denselben Fingerabdruck.
  macOS: Prüfung `darwin_check` mit Belegen je Benutzer.
- **Schema:** eine Migration je Meilenstein, **0074** bis **0078** (Abschnitt 14.2).
- **Reihenfolge:** sechs Meilensteine, jeder einzeln mergebar, getestet und mit eigenem
  CHANGELOG-Eintrag (Abschnitt 22): M1 Sicherung des ganzen Rechners mit Snapshots und
  Manifest, M2 Planer und Stufe 1, M3 Code, Freigabe, Sitzung, Wiederanbindung (Oberfläche
  ausgeblendet bis M4), M4 ISO und `recover` mit QEMU-Ende-zu-Ende-Tests in der CI, M5
  Startprobe und Bewertung (Pflicht für 0.5.0), M6 macOS (darf als Ganzes nach 0.5.x).

## 1. Ausgangslage

### 1.1 Was es heute gibt

- Dateibasierte Sicherung mit restic, "keine Images, kein Bare-Metal-Restore"
  (docs/AGENT.md, Grundsätze; `agent/README.md` "Known limits";
  `apps/web/src/features/endpoints/endpoints-page.test.tsx` prüft den Satz).
- Ein Backup nimmt die `paths` der Konfiguration (Linux-Standard `/etc /home /root /srv
  /var/www`, Server zusätzlich `/opt /usr/local /var/lib /var/backups`; macOS `/Users`,
  `packages/core/src/endpoints/config.ts`, Zeile 142), filtert sie (`ownFormSources`,
  `splitSources` in `agent/internal/core/util.go`) und ruft `restic backup --files-from-raw
  ... --exclude-caches --retry-lock 15m --host <Hostname beim Enrollment> --tag restow-agent`
  (`backupArgs` in `agent/internal/restic/backup.go`). Kein `--one-file-system`, kein
  `--group-by`. Damit wählt restic den Elternsnapshot nach Host **und Pfaden**.
- `/etc/restow-agent/state.json` (Agent-Secret, Repository-Passwort) liegt unter `/etc`
  (`systemLayout()` in `agent/internal/paths/paths_unix.go`, auch unter macOS, wo `/etc` ein
  Link auf `/private/etc` ist) und wird heute mitgesichert, wenn ein Job `/etc` enthält,
  verschlüsselt im Repository des Rechners. Das hört mit 0.5.0 auf (Abschnitt 5.4).
- Ausschlüsse des Agenten in `backupStep` (`agent/internal/core/backup.go`, Zeile 239):
  `Layout.CacheDir()`, `Layout.TmpDir()`, `Restow-Restore-*`, als absolute Pfade der
  Linux-Schreibweise.
- Snapshot-Politik und Berichtsfeld sind betriebssystemneutral gebaut
  (`agent/internal/core/snapshot.go`: `snapshotPlan`, `consistencyOf`,
  `snapshotFailedErrors`, `snapshotUnavailableError`; `api.Consistency` mit
  `Method`/`State`/`LiveFilesystems`; Methoden `vss`, `lvm`, `btrfs`, `apfs`, `mixed`).
  Unter Linux und macOS plant `planSnapshot` in `snapshot_other.go` heute nichts.
  `backupStep` in `core/backup.go` trägt die Windows-Anbindung (`UseFSSnapshot`,
  `OnSnapshotFailed`, Rückfall ohne Snapshot); die Linux- und macOS-Snapshots hängen sich
  an dieselbe Stelle, aber anders: Der Snapshot entsteht beim Agenten, nicht in restic
  (Abschnitt 6). `--exclude-cloud-files` setzt nur `snapshot_windows.go` (Zeile 63).
- Ransomware-Signale: `collectActivity` (`agent/internal/core/activity.go`) ruft nach dem
  Backup `restic diff <vorher> <jetzt>` und misst Kandidaten mit `activity.MeasureAll(...,
  snapshotToLocalPath, ...)`, also an den **lokalen** Dateien nach der Sicherung.
- Restore auf den Rechner: `restic restore --json --target <neu> --overwrite never --verify
  --retry-lock 15m` (`agent/internal/restic/restore.go`), nie über vorhandene Dateien
  (docs/AGENT.md, "Restore"); `prepareRestoreTarget` (`agent/internal/core/util_unix.go`)
  lehnt `/` als Ziel ab und verlangt einen nicht vorhandenen oder leeren, root gehörenden
  Ordner unter vertrauenswürdigen Eltern. Für Dateifreigaben schließt
  `agent/internal/share/restore.go` (Zeile 166) xattrs mit `--exclude-xattr` aus.
- restic-REST-Zugang: `/agent/restic/:endpointId/*` mit dem Prinzipal `agent`
  (`apps/api/src/features/endpoints/restic-route.ts`). Für Läufe mit eigenem Zugang gibt es
  den Baustein `buildRunResticRoute` (`apps/api/src/lib/restic-run-route.ts`), heute für
  Proxmox-VE-Container und Dateifreigaben, mit den Prinzipalen `agent`, `reader` und
  `closing`. `reader` ist genau, was eine Wiederherstellung braucht (docs/FILESHARES.md
  5.3: nur `HEAD`/`GET`, keine Sperrdatei, restic mit `--no-lock`).
- Anmeldefehler: `authFailures = new FailureTracker()` in `agent-auth.ts` zählt für die
  Agent-Anmeldung **und** für die PVE-Knoten (`apps/api/src/features/pve/node-auth.ts`,
  `node-routes.ts`, `pve/restic-route.ts`); das Enrollment hat einen eigenen Zähler
  (`enrollFailures = new FailureTracker(20)` in `agent-service.ts`, ebenso
  `pveEnrollFailures`).
- Adresse der Instanz: `instanceUrl(c)` (`apps/api/src/features/endpoints/instance-url.ts`):
  `settings.public_url`, sonst `RESTOW_PUBLIC_URL`, sonst die Origin der Anfrage.
- Wartung: Jede Arbeit des Servers an einem Endpunkt-Repository hält eine Postgres-Sperre
  (`packages/db/src/repository-lock.ts`), Aufbewahrung und Prüfung exklusiv
  (docs/AGENT.md, "Aufbewahrung, Prüfung, Restore-Test").
- Bewertung: `packages/core/src/endpoints/readiness.ts` (`no_backup`, `unverified`, `green`,
  `yellow`, `red`), Restore-Test nach dem Grundsatz "Rot nur mit Beleg"
  (`restore-test.ts`, `isBackupFinding`).
- Getrennte Werke: `scripts/ci/license-policy.json` (`separateWorks`), heute nur
  das Speicher-Plugin für Proxmox VE (AGPL-3.0-or-later); `check-separate-works.mjs` verlangt
  LICENSE, SPDX-Kopf je Datei, keinen TypeScript-, JavaScript- oder Go-Code im Werk,
  Verweise nur aus `allowedReferences`, keine Kopie außerhalb. Lizenz-Marker kennt der
  Check nur für AGPL (`LICENSE_MARKERS`).
- Release: `release.yml` baut den Agenten (`agent`), prüft Windows (`agent-windows-check`),
  legt `agent-SHA256SUMS` auf den Entwurf (`agent-sums`), wartet auf die Signatur des
  Maintainers (`agent-signature`, `sign-agent.sh`), baut dann die Images. Die macOS-Binaries
  werden weder mit Developer ID signiert noch notarisiert (kein `codesign` in `release.yml`,
  `agent/build.sh`, `agent/install/macos.sh`); der Go-Linker signiert sie ad hoc.
- CI: In `.github/workflows/` läuft **kein** Job auf macOS; der darwin-Code wird nur
  übersetzt. Es gibt `agent` (Linux), `agent-windows` (Windows-Runner) und den TS-Job
  `test`, der kein Agent-Binary hat.
- Migrationen bis `0073_storage_samples.sql` (auch auf `origin/release/0.5.0`); die nächste
  freie Nummer ist **0074**.

### 1.2 Geprüfte restic-Fakten (0.19.1) und was noch zu belegen ist

| Fakt | Beleg |
| --- | --- |
| `backup -g, --group-by` (Standard `host,paths`) bestimmt den Elternsnapshot: "the latest snapshot in the group determined by --group-by". Mit `--group-by host` ist der Elternsnapshot der neueste des Hosts, gleich welche Pfade. | `restic backup --help` |
| `backup -x, --one-file-system`: "exclude other file systems, don't cross filesystem boundaries and subvolumes". Ausdrücklich genannte Quellen werden trotzdem gesichert; btrfs-Subvolumes sind Grenzen. | `restic backup --help` |
| restic hat **keine** Option, Pfade beim Sichern umzuschreiben (kein Präfix-Abschneiden). Ein Snapshot unter `/mnt/x` erscheint im Repository als `/mnt/x/...`. | `restic backup --help` (keine solche Option) |
| `restore <snapshotID>:<subfolder>` stellt nur einen Unterordner her, als wäre er die Wurzel. Dieselbe Syntax nimmt `diff`. | `restic restore --help`, `restic diff --help` |
| `restore --sparse` (dünn besetzte Dateien), `--verify` (Inhalt nach dem Schreiben prüfen), `--overwrite always\|if-changed\|if-newer\|never`, `--ownership-by-name` (Besitzer nach Name statt Nummer, außer POSIX-ACLs), `--exclude-xattr`, `--host`, `--tag`, `--path` für `latest`. | `restic restore --help` |
| Globale Optionen `--no-lock` ("allows some operations on read-only repositories"), `--no-cache`, `--cacert`, `--limit-download`. | `restic --help` |
| Exit-Codes `backup`: 0, 1 (kein Snapshot), 3 (unvollständig), 10, 11, 12; `restore`: 0, 1, 10, 11, 12. | `--help` beider Befehle |
| `ls <snapshot> <ordner>` listet nur unterhalb absoluter Ordner; `--recursive` steigt ab; `--json` liefert je Knoten Typ, Größe, Inode, Modus. | `restic ls --help` |
| `--exclude-cloud-files` wirkt nur unter Windows (OneDrive Files On-Demand). | `restic backup --help`, Agent `snapshot_windows.go` |
| `backup -x` nimmt den **Ordner** eines Einhängepunkts in den Baum des Eltern-Dateisystems auf und steigt nicht in das darunter eingehängte Dateisystem ab. Modus und Besitzer des Eintrags sind die der **Wurzel des eingehängten Dateisystems** (hier 0755, uid 0), nicht die des Ordners darunter im Eltern-Dateisystem (angelegt mit 0750, uid 1234). Für 10.12 heißt das: Modus und Besitzer der verdeckten Ordner stehen nicht im Snapshot, `recover` legt sie selbst an. ([Quelle] Punkt 2, M1) | `TestRootResticLiveTree` (`agent/internal/fssnap/agentroot_test.go`, als root mit restic 0.19.1): `QUELLE-1.2.2 restic -x records the mount point folder /var/tmp/restow-agentroot-…/mnt/live/sub: true (mode 20000000755, uid 0)` |

**[Quelle]** Zu belegen gegen die Quellen von `v0.19.1` (Ergebnis als Testdaten und als
Zeile in dieser Tabelle), bevor der jeweilige Meilenstein fertig ist:

1. Linux (M4): dass `restore` Gerätedateien, FIFOs, Hardlinks innerhalb des
   wiederhergestellten Satzes, POSIX-ACLs und erweiterte Attribute einschließlich
   `security.capability` und `security.selinux` als root wiederherstellt; dass `restore` die
   Linux-Dateiattribute (`chattr`: `+C`, `+i`) nicht kennt.
2. Linux (M1/M4): ob `backup -x` den **Ordner** eines Einhängepunkts (`/proc`, `/sys`, `/dev`,
   `/run`, `/tmp`, `/boot/efi`, `/home`) mit Modus und Besitzer in den Baum des
   Eltern-Dateisystems aufnimmt, wenn darunter ein anderes Dateisystem hängt. Unabhängig vom
   Ergebnis legt `recover` diese Ordner selbst an (Abschnitt 10.12). **Belegt in M1** (Zeile in
   der Tabelle oben): ja, aber mit Modus und Besitzer der Wurzel des eingehängten Dateisystems.
3. Fortsetzen (M4): woran `--overwrite if-changed` eine vorhandene Datei als gleich erkennt
   (Erwartung: Größe und mtime, kein Inhaltsvergleich) und ob `--verify` übersprungene
   Dateien liest. Darauf baut Abschnitt 10.18 nicht: Nach einem unsauberen Ende gilt
   `--overwrite always` und eine vollständige Inhaltsprüfung der Systempfade.
4. Größen (M2): ob `restic stats --mode restore-size` einen Unterordner kennt (Erwartung:
   nein, `stats` filtert nur Snapshots); Abschnitt 10.9 rechnet darum aus
   `restic ls --json --recursive`.
5. macOS (M6): was `backup`/`restore` unter darwin sichern und zurückschreiben: xattrs
   (einschließlich `com.apple.ResourceFork`, `com.apple.decmpfs`), macOS-ACLs (Erwartung:
   nicht), BSD-Flags (`uchg`, `hidden`; Erwartung: nicht), Erstellungsdatum (birthtime;
   Erwartung: nicht), HFS-/APFS-Kompression (Erwartung: kommt entpackt zurück), und wie
   `restore` sich bei den geschützten xattrs `com.apple.macl`, `com.apple.provenance`,
   `com.apple.rootless` verhält (Erwartung: EPERM je Datei, darum ausgeschlossen,
   Abschnitt 13.5). Dazu **[CI]**: was `backup` beim Lesen einer "dataless" Datei
   (SF_DATALESS) aus einem eingehängten APFS-Snapshot tut.

### 1.3 Was Go und das Standardpaket `syscall` unter Linux bieten

Vorhanden: `syscall.Mount`, `syscall.Unmount`, `syscall.Unshare`, `syscall.Chroot`,
`syscall.Exec`, `SysProcAttr.Unshareflags` (mit `CLONE_NEWNS` macht die Go-Laufzeit im Kind
die Wurzel rekursiv privat, bevor das Programm startet; dazu `CLONE_NEWPID`,
`CLONE_NEWNET`, `CLONE_NEWIPC`, `CLONE_NEWUTS`), `SysProcAttr.Chroot`,
`SysProcAttr.AmbientCaps`, `syscall.Setrlimit`, `syscall.Syscall` für Rohaufrufe
(`prctl(PR_CAPBSET_DROP)`, `prctl(PR_SET_NO_NEW_PRIVS)`, `prctl(PR_SET_SECCOMP)` mit einem
von Hand gebauten BPF-Programm, Abschnitt 10.14). Nicht als Konstante vorhanden und
als Rohaufruf zu bauen: `openat2` mit `RESOLVE_IN_ROOT` (Nummer 437 auf allen
Linux-Architekturen, Kernel ab 5.6; das ISO hat 6.12), `ioctl(BLKGETSIZE64)`,
`ioctl(BLKSSZGET)`, `ioctl(BLKPBSZGET)`, `ioctl(FS_IOC_GETFLAGS/SETFLAGS)` (efivarfs
`immutable`). Die UEFI-Variablen liest und schreibt der Agent als Dateien unter
`/sys/firmware/efi/efivars` (4 Byte Attribute, dann der Wert) und zerlegt bzw. baut
`Boot####` (`EFI_LOAD_OPTION`) selbst; `efibootmgr` braucht er dafür nicht.

## 2. Zielplattformen und Umfang

### 2.1 Was 0.5.0 kann

| Bereich | 0.5.0 | Anmerkung |
| --- | --- | --- |
| Quellsystem Linux amd64 | ja (Vorschau) | systemd als Init; Distributionen siehe unten |
| Quellsystem Linux arm64 | Sicherung und Manifest ja, Wiederherstellung nein | kein arm64-ISO in 0.5.0 (Offene Frage 6) |
| Rechner im Container (LXC, Docker) | nein | kein Speicherstapel; die Oberfläche sagt es (`machine.virtualization = container`) |
| Rechner als VM (KVM, VMware, Hyper-V, PVE-Gast mit Agent) | ja | Wiederherstellung in eine neue VM wie auf Hardware |
| Firmware | UEFI (mit und ohne Secure Boot), Legacy-BIOS (auch CSM) | Modus wie gesichert; GPT mit ESP **und** BIOS-Boot-Partition geht in beiden. BIOS-Sicherungen brauchen Ersatzhardware mit CSM (Warnung `bios_needs_csm`, Abschnitt 4.4) |
| Partitionstabellen | GPT, MBR (primär, erweitert, logisch), ganze Platte ohne Tabelle (PV, md-Mitglied, Dateisystem) | keine Umwandlung MBR/GPT |
| Software-RAID | mdadm, Metadaten 0.90, 1.0, 1.1, 1.2; RAID 0, 1, 4, 5, 6, 10; interne Bitmap; write-mostly | IMSM/DDF (Intel RST) nein; Journal/PPL nein; Reshape zur Sicherungszeit nein |
| Verschlüsselung | LUKS1, LUKS2 (Passphrase, Schlüsseldatei, Flags wie `allow-discards`), Plain-dm-crypt für Swap/tmp mit Zufallsschlüssel | TPM2-, FIDO2-, Clevis-Bindungen werden nicht übernommen (Abschnitt 10.10) |
| LVM | linear, striped, `raid1`/`raid5`/`raid6`/`raid10`, Thin-Pools und Thin-LVs, `system.devices`, System-ID | Cache, Writecache, VDO nein |
| Dateisysteme | ext2, ext3, ext4, XFS, btrfs (Subvolumes auch verschachtelt, Standard-Subvolume, Snapper-Wurzel wie bei openSUSE, Quota, `raid0/1/10/1c3/1c4`, `single`, `dup`), vfat (ESP, `/boot`), Swap-Partition, Swap-Datei | ZFS, bcachefs, F2FS, NTFS nein; XFS mit externem Log oder Realtime-Gerät nein |
| Bootloader | GRUB 2 (BIOS und UEFI, auch BLS wie Fedora/RHEL), systemd-boot (auch mit UKI), shim | LILO, syslinux, rEFInd, EFI-Stub ohne Bootloader, UKI ohne Erzeuger im System nein |
| initramfs | initramfs-tools, dracut, mkinitcpio | mkinitfs (Alpine), booster nein |
| Zielplatten | gleich groß, größer, kleiner (solange die Daten passen), andere Anzahl bei RAID (degradiert), NVMe/SATA/SAS/virtio gemischt, 512e und 4Kn, Hardware-RAID-VD (vorher im Controller angelegt) | SAN-LUNs (FC, iSCSI) nur auf ausdrückliche Freigabe |
| Vorhandene Teile | intakte md-Arrays, VGs, LUKS-Volumes, Dateisysteme mit passender Identität werden übernommen statt gelöscht | Abschnitt 10.7 |
| Netz im ISO | DHCP (IPv4, IPv6/SLAAC), statisch, HTTP(S)-Proxy ohne Zugangsdaten | kein VLAN, kein WLAN, kein 802.1X, kein Bonding/LACP |

Distributionen (Quellsystem): **geprüft in der CI** (Abschnitt 21.2) Debian 12 und 13,
Ubuntu 22.04 und 24.04 LTS, AlmaLinux 9 (stellvertretend für RHEL, Rocky, Oracle Linux 9),
Fedora (aktuelle Version), openSUSE Leap 15.6, Arch Linux (UKI); **auf echter Hardware im
Freigabetest** (Abschnitt 21.4) zusätzlich Ubuntu 26.04, RHEL 8/10-Familie, Proxmox VE 8/9
als Host. Andere systemd-Distributionen mit einem der drei initramfs-Erzeuger und GRUB oder
systemd-boot gelten als "sollte gehen" und zeigen das im Assistenten an ("nicht geprüfte
Distribution").

### 2.2 Nicht Teil von 0.5.0

- **Windows Bare Metal** (WinPE/WinRE-Medium, BCD, WIM/VHDX, Systemzustand). Wiederherstellung
  eines Windows-Rechners heißt in 0.5.0 weiter: Windows neu installieren, dann Dateien
  zurückholen (docs/WINDOWS-AGENT.md 2.2). Der Job-Schalter "Ganzer Rechner" lässt
  Windows-Mitglieder unverändert ihre Ordner sichern und sagt das. Ein Linux-Rechner mit
  Windows im Dual-Boot wird wiederhergestellt, Windows nicht (Warnung `dual_boot_windows`).
- **Umbau des Speicherstapels** bei der Wiederherstellung: RAID-Ebene ändern, RAID oder LVM
  oder LUKS weglassen oder hinzufügen, MBR nach GPT, BIOS nach UEFI, Dateisystem wechseln.
  Kandidat für 0.5.x: **BIOS+GPT nach UEFI** (ESP anlegen, `grub-install --target=x86_64-efi`
  mit shim aus dem Paketbestand des Zielsystems), weil neue Hardware oft kein CSM hat.
- **Wiederherstellung ohne Restow-Server**: nur vom Server (Entscheidung), keine lokalen
  Plattenabbilder, kein Lesen eines Repositorys von USB-Platte, NFS oder S3 im ISO.
  (`restow-restore` und `restic` bleiben für Dateien der Weg ohne Server, docs/AGENT.md
  "Restore ohne Restow".)
- Rohdaten in nicht eingehängten LVs (VM-Platten eines Proxmox-VE-Hosts, Datenbank-Rohgeräte,
  iSCSI-Targets): werden nicht gesichert und nicht als wiederhergestellt angelegt
  (Abschnitt 10.10). VMs eines PVE-Hosts kommen über die PVE-Integration zurück.
- ZFS (Kernelmodul nicht signiert, Lizenz), bcachefs, Stratis, VDO, LVM-Cache, dm-integrity
  und LUKS2 mit Authentifizierung (`--integrity`), losgelöste LUKS-Header, dm-verity,
  Multipath, iSCSI- und NFS-Root, FCoE, Intel RST/IMSM, Hybrid-MBR (alte Macs), bcache,
  md-Journal/PPL, XFS mit externem Log oder Realtime-Gerät.
- Snapper-, Timeshift- und LVM-Snapshots als Teil der Sicherung (sie werden leer bzw. gar
  nicht neu angelegt, Abschnitt 5.3; die laufende Wurzel eines openSUSE-Systems wird
  gesichert, Abschnitt 5.2).
- Aktualisieren von shim/GRUB des Zielsystems bei der Wiederherstellung (wenn die Ziel-Firmware
  die gesicherte Startkette sperrt, nennt der Plan den Weg, ändert aber nichts, Abschnitt 10.5).
- Ein neues Repository für einen bestehenden Rechner (nach Verdacht, dass das
  Repository-Passwort abgeflossen ist, Abschnitt 16.2): Kandidat für 0.5.x.
- arm64-ISO, Raspberry Pi, Netzboot (PXE) des ISO, WLAN, VLAN, Bonding im ISO.
- Nicht-systemd-Init (OpenRC, runit, SysV) als Quellsystem: Sicherung und Manifest ja,
  Startprobe nein, Wiederherstellung "nicht geprüft".
- macOS: Wiederherstellung des Systems, systemweiter Einstellungen (`/Library/Preferences`,
  Netzwerk, Drucker), Launch-Daemons und Systemerweiterungen anderer Hersteller, per `pkg`
  oder App Store installierter Programme (sie stehen auf der Liste "neu installieren"), der
  Data-Protection-Schlüsselbund, FileVault-Zustand, Benutzerkonten mit ihren Passwörtern,
  Cloud-Ordner (Abschnitt 13).

## 3. Begriffe und Gesamtablauf

- **Ganz-Rechner-Sicherung**: ein Backup eines Rechners in einem Job mit `wholeMachine`. Ihr
  Snapshot trägt die Tags `restow-agent` und `restow-baremetal`.
- **Layout-Manifest**: die JSON-Beschreibung des Speicherstapels und der Startkette zum
  Zeitpunkt der Sicherung (`restow-layout-v1`, Abschnitt 4), je Plattform (`linux`,
  `darwin`).
- **Plan**: die Liste der Schritte, mit denen `recover` aus einem Manifest und einer
  Zielhardware den Rechner baut (Abschnitt 10.4). Rein berechnet aus Manifest,
  Hardwarebeschreibung und Fakten aus dem Snapshot, ohne Werkzeugaufruf.
- **Übernahme**: ein Teil des Stapels (Array, VG, LUKS-Volume, Dateisystem), das am Ziel
  schon intakt mit derselben Identität existiert und weder gelöscht noch zurückgeholt wird
  (Abschnitt 10.7).
- **Recovery-Sitzung**: eingelöster Wiederherstellungscode; nach der Freigabe trägt sie den
  Lesezugang zum Repository und den Fortschritt (Abschnitt 9). Arten: `code` (ISO),
  `probe` (Labor), `migration` (neuer Mac liest das Repository des alten).
- **Stufe 1, Stufe 2**: die Restore-Prüfung auf dem Server (Abschnitt 12).
- **Fingerabdrücke**: `layoutFingerprint` (Struktur des Stapels) und
  `bootChainFingerprint` (Kernel, initramfs, Bootloader-Dateien, `fstab` und Co. im Snapshot),
  Abschnitt 12.4.

```
Rechner (Linux)                                   Restow-Instanz
restow-agent (Job: Ganzer Rechner)
  1 Manifest erfassen  -> /var/lib/restow-agent/baremetal/layout.json
  2 LVM/btrfs-Snapshots, privater Mount-Namensraum
  3 restic backup -x --group-by host  ------------> /agent/restic/<id> (agent, append-only)
  4 POST /runs/:id/finish { consistency, layout } -> endpoint_layouts, endpoint_runs.layout_id
                                                    Worker: Stufe 1 (Planer, restic ls/dump)
                                                    Labor:  Stufe 2 (ISO in QEMU, Startprobe)
Ersatzhardware
  ISO starten -> restow-agent recover
  5 Code-Hash eintauschen ---------------------> POST /agent/v1/recovery/sessions (202)
                                                    Admin gibt frei (Prüfzahl)
  6 Zugangsdaten holen ------------------------> GET .../sessions/current/credentials
  7 Manifest, Fakten aus dem Snapshot, Plan, Bestätigung
  8 restic restore --no-lock ------------------> /agent/recovery/restic/<sitzung> (reader)
  9 release, Fixups, initramfs, Bootloader (isoliert), NVRAM, Prüfung
 10 POST .../finish, Neustart
```

## 4. Layout-Manifest

### 4.1 Erfassung (`agent/internal/baremetal`)

Neues Paket. Aufteilung:

| Datei | Build-Tag | Inhalt |
| --- | --- | --- |
| `manifest.go` | keins | Typen (`Manifest` mit `Platform` und genau einem von `Linux *LinuxLayout` bzw. `Darwin *DarwinLayout`; darunter `Disk`, `PartitionTable`, `Partition`, `MDArray`, `LUKSVolume`, `PlainCrypt`, `LVM`, `VolumeGroup`, `LogicalVolume`, `Filesystem`, `Subvolume`, `Swap`, `Mount`, `FstabEntry`, `Firmware`, `SecureBoot`, `EFIEntry`, `Loader`, `Bootloader`, `Initramfs`, `Kernel`, `NetInterface`, `NetConfigRef`, `DriverChain`, `BlockRef`, `Unsupported`; darwin `MacUser`, `MacApp`), `Format = "restow-layout-v1"`, `SchemaVersion = 1`, `(*Manifest).Validate()`, Kodierung mit sortierten Schlüsseln |
| `assess.go` | keins | `Assess(*Manifest) (Verdict, []Unsupported)` je Plattform (Abschnitt 4.4) |
| `fingerprint.go` | keins | `LayoutFingerprint(*Manifest) string` je Plattform (Abschnitt 12.4) |
| `efi.go` | keins | `ParseLoadOption([]byte)`, `BuildLoadOption(...)` (`EFI_LOAD_OPTION`, Gerätepfad-Knoten HD und File), `ParseSignatureList` (`db`, `dbx`, `MokListRT`), `ParseSbatLevel` |
| `pe.go` | keins | `InspectLoader(io.ReaderAt) (LoaderInfo, error)`: PE-Sektionen (`.sbat`, `.linux`, `.cmdline`, `.initrd`, `.osrel`), Authenticode-Hash (SHA-256 nach PE-Regeln) und Signaturgeber (Aussteller, Subjekt, Seriennummer aus dem PKCS#7 in `WIN_CERTIFICATE`), mit `debug/pe` und `encoding/asn1` |
| `cmdline.go` | keins | Zerlegen der Kernel-Kommandozeile, `RedactCmdline` (Werte von Parametern mit `password`, `passwd`, `secret`, `key`, `token`, `psk` im Namen und Zugangsdaten in `netroot=`/`iscsi:`-URLs werden zu `<redacted>`) |
| `capture.go` | keins | Ablauf, Zusammenführen, Grenzen (Zeit, Größe), Fehler je Teil |
| `capture_linux.go` | linux | die Sammler je Schicht, siehe unten |
| `capture_darwin.go` | darwin | **M6**: macOS-Variante (Abschnitt 13.2) |
| `tools.go` | keins | `Runner`-Schnittstelle für Werkzeugaufrufe (Zeitlimit je Aufruf 30 s, Ausgabe höchstens 4 MiB, Umgebung `procenv.Base()` mit `LC_ALL=C`), Attrappe für Tests; die Attrappe **scheitert**, wenn je ein Aufruf `--dump-volume-key`, `--dump-master-key`, `luksHeaderBackup` oder `dmsetup table --showkeys` enthält |
| `sanitize.go` | keins | `checkString`: lehnt C0/C1-Steuerzeichen und ungültiges UTF-8 ab (von `Validate` für jede Zeichenkette benutzt) |
| `testdata/capture/<system>/` | | aufgezeichnete Ausgaben echter Systeme und der Loop-Geräte-Stapel aus der CI (Abschnitt 21.1) |

Sammler unter Linux (`capture_linux.go`), jeder mit eigener Funktion und eigenem Test gegen
aufgezeichnete Ausgaben:

| Funktion | Quelle | Was |
| --- | --- | --- |
| `captureBlockDevices` | `lsblk -J -b -O` | Baum aller Blockgeräte: Name, `KNAME`, Typ, Größe, `LOG-SEC`, `PHY-SEC`, Modell, Seriennummer, WWN, Transport (`nvme`, `sata`, `sas`, `virtio`, `usb`, `mmc`, `fc`, `iscsi`), `ROTA`, `RM`, `ZONED`, `RO`, `PKNAME`, `MAJ:MIN`; NVMe-Namensraum-ID, EUI-64 und NGUID aus `/sys/block/<n>/{eui,nguid,nsid}` |
| `captureDriverChains` | `/sys/block/<n>/device` und Elterngeräte bis zur PCI-Wurzel, `/sys/class/net/<n>/device` | je Bootplatte (Platten mit `/`, `/boot`, ESP, `/usr`) die Treiberkette (`nvme`, `ahci`, `vmd`, `megaraid_sas`, `mpt3sas`, ...) mit PCI-Modalias je Stufe; je physischer Netzwerkkarte Treiber und Modalias |
| `capturePartitionTables` | `sfdisk --json <disk>` und `sfdisk --dump <disk>` | Typ (`gpt`/`dos`), `label-id` (Disk-GUID bzw. MBR-Kennung), `sector-size`; je Partition Nummer, Start, Größe (in Sektoren **und** Bytes), Typ, PARTUUID, Name, Attribute, Boot-Flag. `first-lba`, `last-lba`, `table-length` nur zur Anzeige (Abschnitt 10.9) |
| `captureBootCode` | erste 512 Byte jeder Platte, BIOS-Boot-Partition | `grub` (GRUB-Kennung im MBR-Code), `none`, `other`; bei GPT das Aktiv-Flag des Schutz-MBR (Byte 446, `pmbrBoot`) |
| `captureMD` | `/proc/mdstat`, `mdadm --detail --export /dev/mdX`, `mdadm --examine --export <mitglied>` | Name, UUID, Ebene, Metadatenversion, Chunk, Layout, Mitglieder (als `BlockRef`, mit `writeMostly`), Ersatzplatten, Bitmap, `homehost`, Zustand (`clean`, `degraded`, `reshape`, `resync`), Journal/PPL |
| `captureLUKS` | `cryptsetup luksDump --dump-json-metadata <dev>` (LUKS2), sonst `cryptsetup luksDump <dev>` (Text, LUKS1) | Version, UUID, Label, Subsystem, Cipher, Schlüssellänge, Sektorgröße, PBKDF (Art, Iterationen bzw. Speicher), Anzahl belegter Keyslots, Token-**Typen** (`systemd-tpm2`, `systemd-fido2`, `clevis`, andere), Flags aus `config.flags` (`allow-discards`, `same-cpu-crypt`, `submit-from-crypt-cpus`, `no-read-workqueue`, `no-write-workqueue`), `requirements`, Integrity; `keyFile` aus `crypttab`. **Keine Header-Sicherung, keine Token-Inhalte, keine Digests oder Salts** (Abschnitt 4.2) |
| `capturePlainCrypt` | `dmsetup table` (Ziel `crypt`, ohne LUKS-Header am Quellgerät), `crypttab` (`swap`, `tmp`, `plain`, Schlüssel `/dev/urandom`) | `plainCryptSwap`/`plainCryptTmp` mit Quellgerät als `BlockRef` und PARTUUID, Cipher, Schlüssellänge (nie den Schlüssel: `dmsetup table` ohne `--showkeys` zeigt ihn nicht) |
| `captureLVM` | `lvm fullreport --reportformat json --units b --nosuffix`, `vgcfgbackup -f <raw>/%s.vg`, `lvmconfig --typeconfig full devices/use_devicesfile devices/filter devices/global_filter devices/allow_mixed_block_sizes` | PVs (Gerät, UUID), VGs (Name, Extentgröße, `vg_systemid`), LVs (Name, Typ, Größe, Stripes, Stripe-Größe, Raid-Typ, Pool, virtuelle Größe, Chunk-Größe, Metadatengröße, Tags, aktiv, `raw` wenn weder eingehängt noch Swap noch PV/LUKS-Träger), Gerätedatei vorhanden ja/nein und ihre `IDTYPE`s, Filter mit Gerätenamen ja/nein |
| `captureFilesystems` | `blkid -p -o export <dev>`, `dumpe2fs -h`, `xfs_info <mnt>`, `btrfs inspect-internal dump-super`, `btrfs filesystem show --raw`, `btrfs filesystem df --raw`, `btrfs subvolume list -a -p -u -q <mnt>`, `btrfs subvolume get-default`, `btrfs qgroup show` (nur ob Quota an), `statfs`, `lsattr -d` (Ordner bis vier Ebenen unter jedem btrfs-Einhängepunkt) | Typ, UUID, `UUID_SUB`, Label, Größe, belegte Bytes und Inodes, `mkfs`-Parameter je Typ (Abschnitt 10.11), `noCowDirs` (Ordner mit `+C`), XFS externes Log/Realtime; btrfs: jedes Subvolume mit Pfad, Eltern, ob eingehängt, ob Snapper/Timeshift/Docker, Standard-Subvolume mit Pfad, Quota an/aus |
| `captureMounts` | `/proc/self/mountinfo` (eigener Parser) | Ziel, Quelle, Typ, Optionen (darunter `compress`/`compress-force`), `subvol=`/`subvolid=`, Zuordnung zum Dateisystem; `autofs`-Einhängepunkte |
| `captureFstab` | `/etc/fstab` (eigener Parser, wie `parseFstab` in TS), systemd-Units `/etc/systemd/system/*.mount`, `*.swap`, `*.automount` | je Eintrag Quelle, Ziel, Typ, Optionen (`noauto`, `nofail`, `x-systemd.automount`), aufgelöst auf ein Gerät des Manifests oder "nicht auflösbar" |
| `captureSwap` | `/proc/swaps`, `blkid`, `filefrag -v`/`btrfs inspect-internal map-swapfile -r` für Dateien | Partition, Datei oder Plain-dm-crypt, UUID, Label, Größe, Priorität; bei Swap-Dateien der aktuelle `resume_offset` |
| `captureFirmware` | `/sys/firmware/efi`, efivars aus einer **Positivliste**: `Boot####`, `BootOrder`, `BootCurrent`, `SecureBoot`, `SetupMode`, `SbatLevelRT`, `MokListRT` (bzw. `/sys/firmware/efi/mok-variables/MokListRT`), `db` und `dbx` (nur SHA-256 und Zertifikats-Subjekte) | Modus, Secure Boot an/aus, Setup-Modus, Einträge mit Beschreibung, PARTUUID, Partitionsnummer und Loader-Pfad, SBAT-Stand, MOK-Fingerabdrücke, Zertifikate in `db` (u. a. "Microsoft Windows Production PCA 2011" und "Windows UEFI CA 2023" für Windows, "Microsoft Corporation UEFI CA 2011" und "Microsoft UEFI CA 2023" für Dritte, also shim) |
| `captureLoaders` | jede PE-Datei auf jeder ESP und in XBOOTLDR (`EFI/**/*.efi`, `EFI/Linux/*.efi`) über `InspectLoader` | Pfad, Größe, Authenticode-SHA-256, Signaturgeber, `.sbat`-Einträge, ob UKI (`.linux`-Sektion) mit eingebetteter Kommandozeile (geschwärzt) |
| `captureBootloader` | Dateien: `/etc/default/grub`, `/etc/default/grub.d/*`, `/boot/grub/grub.cfg`, `/boot/grub2/grub.cfg`, `<esp>/EFI/<vendor>/grub.cfg` (tatsächlicher Ort, RHEL 8 UEFI), `/boot/grub*/device.map`, `/etc/default/grub_installdevice` (SUSE), `/boot/loader/entries/*.conf`, `<esp>/loader/loader.conf`, `/efi`, `grubenv`; Debconf `grub-pc/install_devices`, `grub-efi/install_devices`; `/etc/kernel/proxmox-boot-uuids` | Art (`grub`, `systemd-boot`), Plattform (`i386-pc`, `x86_64-efi`), BLS ja/nein, shim ja/nein, ESP(s) und XBOOTLDR, EFI-Verzeichnis und Bootloader-ID, Ort von `grub.cfg`, BIOS-Zielplatten, mehrere ESPs, `proxmox-boot-tool` ja/nein, `fbx64.efi`/`BOOTX64.CSV` vorhanden |
| `captureInitramfs` | vorhandene Programme und Konfigurationen (`/etc/initramfs-tools`, `/etc/dracut.conf{,.d}`, `/etc/mkinitcpio.conf`, `/etc/mkinitcpio.d/*.preset`, `/etc/kernel/install.conf`, `/etc/kernel/cmdline`) | Erzeuger, `hostonly` (dracut), `MODULES=` (initramfs-tools), UKI-Presets (`default_uki`), `kernel-install`-Layout; **wirksame Tastaturbelegung im initramfs**: initramfs-tools `KEYMAP=y` und `/etc/default/keyboard` (`XKBLAYOUT`, `XKBVARIANT`), dracut `/etc/vconsole.conf` bzw. `rd.vconsole.keymap=`, mkinitcpio Hooks `keymap`/`sd-vconsole` und `/etc/vconsole.conf`, GRUB-cryptodisk fest `us`; `add_device+=` in `dracut.conf.d` |
| `captureKernels` | `/lib/modules/*`, `/boot/vmlinuz-*`, `/boot/initrd*`, `/boot/initramfs-*`, ESP-Einträge von systemd-boot, UKIs (`captureLoaders`) | Version, Pfad von Kernel und initramfs, Größe, Standard-Kernel des Bootloaders (GRUB `saved_entry`/`GRUB_DEFAULT`, `loader.conf` `default`), Signaturgeber des Kernels (Distribution oder MOK) |
| `captureDKMS` | `/var/lib/dkms/*/*/*/` und `/lib/modules/*/updates/dkms/*.ko*` (Modulsignatur am Dateiende), MOK-Dateien `/var/lib/shim-signed/mok/MOK.der`, `/var/lib/dkms/mok.pub` | Module mit Namen, Kernel, Signaturgeber, ob Netz- oder Speichertreiber (aus `modules.alias`), MOK-Datei vorhanden und Fingerabdruck |
| `captureOS` | `/etc/os-release`, `/proc/cmdline`, `uname -r`, `/etc/selinux/config`, `/etc/machine-id` (nur ob vorhanden) | `ID`, `ID_LIKE`, `VERSION_ID`, Kernel, Kommandozeile (über `RedactCmdline`), SELinux-Modus, Proxmox VE ja/nein (`/etc/pve`, Paket `pve-manager`) |
| `captureNetwork` | `/sys/class/net/*`; Konfigurationsdateien, die eine MAC nennen: netplan `match: macaddress:`, NetworkManager `mac-address=`, `ifcfg-*` `HWADDR=`, `/etc/udev/rules.d/70-persistent-net.rules`, networkd `[Match] MACAddress=`, `.link`-Dateien | Name, MAC, Treiber, PCI-Pfad, ob physisch; je Datei Pfad und genannte MACs (`NetConfigRef`) |
| `captureConfigFiles` | Dateien | Pfad und SHA-256 von `fstab`, `crypttab`, `mdadm.conf` (`/etc/mdadm/mdadm.conf`, `/etc/mdadm.conf`), `/etc/default/grub`, `/etc/kernel/cmdline`, `/etc/lvm/lvm.conf`, `/etc/lvm/devices/system.devices`, `/etc/initramfs-tools/conf.d/resume`, `/etc/vconsole.conf`, `/etc/default/keyboard`; der Inhalt steht im Snapshot, nicht im Manifest |
| `scanDeviceNames` | `/etc` (Textdateien bis 1 MiB) | jede Fundstelle von `/dev/(sd\|hd\|vd\|xvd\|nvme\|mmcblk)…` mit Pfad und Zeile, nur zur Anzeige (Abschnitt 10.13) |

Vor `Capture` löst der Agent jeden autofs-Einhängepunkt und jeden `fstab`-Eintrag mit
`x-systemd.automount` durch ein `stat` aus (Zeitlimit 10 s je Eintrag), damit z. B. eine
ESP, die `systemd-gpt-auto-generator` nach Leerlauf aushängt, eingehängt ist. `noauto`-
Einträge mit lokalem Gerät hängt erst der Snapshot-Helfer für die Dauer der Sicherung in
seinem privaten Namensraum nur lesend ein (Abschnitt 6.3); das Manifest kennt sie aus
`captureFstab`.

Was ein Sammler nicht lesen kann (Werkzeug fehlt, Zeitlimit, Fehler), kommt als
`Unsupported{Code: "capture_failed", Ref, Message}` ins Manifest; Werkzeuge einer Schicht,
die es auf dem Rechner gibt, sind fast immer installiert (wer LVM nutzt, hat `lvm`). Ein
Werkzeug fehlt nur bei Schichten, die das System nicht benutzt, und dann wird es nicht
aufgerufen. `lsblk`, `blkid`, `sfdisk` (util-linux bzw. `fdisk`) sind Voraussetzung; fehlen
sie, ist der Rechner nicht Bare-Metal-fähig (Hinweis in der Oberfläche).

### 4.2 Schema (Auszug, Linux)

```jsonc
{
  "format": "restow-layout-v1",
  "schemaVersion": 1,
  "platform": "linux",                 // "linux" | "darwin" (Abschnitt 13.2)
  "capturedAt": "2026-11-04T21:00:03Z",
  "agentVersion": "0.5.0",
  "hostname": "srv01",                 // Hostname beim Enrollment, wie --host
  "os": { "id": "debian", "idLike": [], "versionId": "12",
          "prettyName": "Debian GNU/Linux 12 (bookworm)", "arch": "amd64",
          "kernel": "6.1.0-27-amd64",
          "cmdline": "BOOT_IMAGE=/vmlinuz-... root=/dev/mapper/vg0-root ro quiet",
          "selinux": null, "init": "systemd", "proxmoxVE": false },
  "firmware": { "mode": "uefi", "secureBoot": true, "setupMode": false,
                "entries": [{ "num": 1, "label": "debian", "partuuid": "…", "partNumber": 1,
                              "loader": "\\EFI\\debian\\shimx64.efi", "active": true }],
                "bootOrder": [1, 0], "bootCurrent": 1,
                "sbatLevel": "sbat,1,2024010900\nshim,4\ngrub,3\n",
                "db": [{ "subject": "CN=Microsoft Corporation UEFI CA 2011,…", "sha256": "…" }],
                "dbxSha256": "…", "mok": [{ "sha256": "…", "subject": "CN=DKMS module signing key" }] },
  "loaders": [{ "path": "/boot/efi/EFI/debian/shimx64.efi", "bytes": 959904, "authenticodeSha256": "…",
                "signer": { "issuer": "CN=Microsoft Corporation UEFI CA 2011,…", "subject": "…" },
                "sbat": ["sbat,1", "shim,4", "shim.debian,1"], "uki": false }],
  "disks": [{ "id": "d0", "kname": "nvme0n1", "sizeBytes": 512110190592,
              "logicalSectorSize": 512, "physicalSectorSize": 512,
              "model": "…", "serial": "…", "wwn": null, "eui64": "…", "nsid": 1,
              "transport": "nvme", "rotational": false, "removable": false,
              "bootCode": "none", "pmbrBoot": false,
              "driverChain": ["nvme", "pcieport"],
              "table": { "type": "gpt", "id": "…", "sectorSize": 512,
                         "partitions": [
                           { "number": 1, "startBytes": 1048576, "sizeBytes": 536870912,
                             "type": "C12A7328-F81F-11D2-BA4B-00A0C93EC93B",
                             "uuid": "…", "name": "EFI System Partition", "attrs": "", "bootable": false },
                           { "number": 2, "startBytes": 537919488, "sizeBytes": 1023410176, "type": "0FC63DAF-…", "uuid": "…" },
                           { "number": 3, "startBytes": 1561329664, "sizeBytes": 510547755008, "type": "0FC63DAF-…",
                             "uuid": "…", "grow": true } ] } }],
  "md": [],
  "luks": [{ "id": "c0", "device": { "kind": "partition", "disk": "d0", "number": 3 },
             "version": 2, "uuid": "…", "label": null, "cipher": "aes-xts-plain64", "keyBits": 512,
             "sectorSize": 512, "pbkdf": { "type": "argon2id", "memoryKiB": 1048576, "time": 4, "parallel": 4 },
             "keyslots": 1, "tokenTypes": [], "flags": ["allow-discards"], "requirements": [],
             "integrity": null, "keyFile": null,
             "mappedName": "nvme0n1p3_crypt", "crypttabName": "nvme0n1p3_crypt" }],
  "plainCrypt": [],
  "lvm": { "useDevicesFile": false, "filterHasDeviceNames": false, "allowMixedBlockSizes": false,
           "pvs": [{ "device": { "kind": "luks", "id": "c0" }, "uuid": "…" }],
           "vgs": [{ "name": "vg0", "extentBytes": 4194304, "systemId": null,
                     "lvs": [{ "name": "root", "type": "linear", "sizeBytes": 53687091200 },
                             { "name": "swap", "type": "linear", "sizeBytes": 8589934592 },
                             { "name": "home", "type": "linear", "sizeBytes": 400000000000, "grow": true }] }] },
  "filesystems": [{ "id": "f0", "device": { "kind": "partition", "disk": "d0", "number": 1 },
                    "type": "vfat", "uuid": "1A2B-3C4D", "label": null, "sizeBytes": 536870912,
                    "usedBytes": 6291456, "vfat": { "fatBits": 32, "volumeId": "1A2B3C4D",
                    "sectorsPerCluster": 8, "logicalSectorSize": 512 } },
                  { "id": "f1", "device": { "kind": "lv", "vg": "vg0", "lv": "root" }, "type": "ext4",
                    "uuid": "…", "label": null, "sizeBytes": 53687091200, "usedBytes": 9123456789,
                    "inodesUsed": 312000,
                    "ext": { "blockSize": 4096, "inodeSize": 256, "inodeCount": 3276800,
                             "features": ["has_journal", "ext_attr", "resize_inode", "dir_index", "filetype",
                                          "extent", "64bit", "flex_bg", "sparse_super", "large_file",
                                          "huge_file", "dir_nlink", "extra_isize", "metadata_csum"],
                             "reservedPercent": 5, "flexBgSize": 16, "journalBytes": 268435456 } }],
  "swap": [{ "kind": "partition", "device": { "kind": "lv", "vg": "vg0", "lv": "swap" },
             "uuid": "…", "label": null, "sizeBytes": 8589934592 }],
  "mounts": [{ "target": "/", "fs": "f1", "options": "rw,relatime,errors=remount-ro" },
             { "target": "/boot", "fs": "f2" }, { "target": "/boot/efi", "fs": "f0" }],
  "fstab": [{ "source": "/dev/mapper/vg0-root", "target": "/", "type": "ext4", "options": "errors=remount-ro",
              "resolved": { "fs": "f1" } },
            { "source": "UUID=1A2B-3C4D", "target": "/boot/efi", "type": "vfat", "options": "umask=0077",
              "resolved": { "fs": "f0" } }],
  "bootloader": { "kind": "grub", "platform": "x86_64-efi", "bls": false, "shim": true,
                  "esps": ["f0"], "efiDirectory": "/boot/efi", "bootloaderId": "debian",
                  "grubCfg": "/boot/grub/grub.cfg", "biosDisks": [], "deviceMap": false,
                  "proxmoxBootTool": false, "fallbackChain": true },
  "initramfs": { "generator": "initramfs-tools", "modules": "most",
                 "keymap": { "layout": "de", "variant": "nodeadkeys", "source": "/etc/default/keyboard",
                             "inInitramfs": true } },
  "kernels": [{ "version": "6.1.0-27-amd64", "image": "/boot/vmlinuz-6.1.0-27-amd64",
                "initramfs": "/boot/initrd.img-6.1.0-27-amd64", "imageBytes": 8224448,
                "default": true, "signer": "Debian Secure Boot Signer 2022 - linux" }],
  "dkms": [],
  "configs": [{ "path": "/etc/fstab", "sha256": "…" }, { "path": "/etc/crypttab", "sha256": "…" }],
  "network": [{ "name": "enp3s0", "mac": "…", "driver": "igb", "modalias": "pci:v00008086d00001533…",
                "physical": true }],
  "netConfigs": [{ "path": "/etc/netplan/50-cloud-init.yaml", "macs": ["…"] }],
  "deviceNameRefs": [],
  "backup": { "sources": ["/", "/boot", "/boot/efi", "/home"],
              "excludes": ["…"], "fsSnapshots": { "f1": "lvm", "f2": "live", "f0": "live" } },
  "agent": { "hooks": "off" },
  "unsupported": [],
  "verdict": "supported",
  "raw": [{ "name": "sfdisk-d0.dump", "sha256": "…" }, { "name": "vg0.vg", "sha256": "…" }]
}
```

Regeln:

- `platform` steht auf oberster Ebene. Das Zod-Schema ist
  `layoutManifestSchema = z.discriminatedUnion("platform", [linuxLayoutSchema,
  darwinLayoutSchema])`, in Go trägt `Manifest` genau eines von `Linux`/`Darwin`
  (`Validate` lehnt beides oder keins ab). Linux-Felder sind im Linux-Schema Pflicht, nicht
  optional; `Validate`, `Assess`, `LayoutFingerprint` und die Prüfstufen gibt es je
  Plattform, der Planer (L3) nie für darwin.
- Platten, Arrays, LUKS-Volumes, Dateisysteme haben eine im Manifest eindeutige, kurze `id`;
  Verweise laufen nur über `BlockRef` (`disk`, `partition`, `md`, `luks`, `plain`, `lv`),
  nie über Gerätenamen. Der Gerätename zur Erfassungszeit (`kname`) ist nur Anzeige und
  Grundlage der Fixups (Abschnitt 10.13).
- Größen und Starts stehen in **Bytes** (`startBytes`, `sizeBytes`), dazu die Sektorgröße
  der Quellplatte; der Planer rechnet in LBA der Zielplatte um (Abschnitt 10.9).
- `grow` markiert je Platte höchstens eine Partition und je VG höchstens ein LV, das auf einer
  größeren Zielplatte wächst. Vorgabe beim Erfassen: die letzte Partition einer Platte, wenn
  sie ein PV, ein md-Mitglied, ein LUKS-Container oder ein Dateisystem trägt, das wachsen
  kann; im VG das größte LV, das nicht `root` heißt, nicht Swap und nicht `raw` ist, sonst
  `root`. Der Bediener kann es im Plan ändern.
- **Geheimnisse stehen nie im Manifest und nie in `raw/`:** keine Schlüssel, keine
  Keyslot-Daten, keine Digests, keine Salts, kein Tokeninhalt (Clevis-JWE, TPM2-Blob und
  -Policy, FIDO2-Credential-ID und -Salt), keine geheimen Kernel-Parameter (`RedactCmdline`;
  den Klartext gibt es nur in der jeweiligen Datei im Snapshot), keine efivars außerhalb der
  Positivliste. Seriennummern und MAC-Adressen stehen darin (für die Zuordnung); das
  Manifest liegt verschlüsselt im Repository und in der Datenbank des Mandanten.
- Alle Zeichenketten sind gültiges UTF-8 ohne C0/C1-Steuerzeichen (`checkString` in Go,
  `z.string().refine(noControlChars)` in TS). Ein Label mit `\x1b[` oder `\r` macht das
  Manifest ungültig, statt auf der Konsole Planzeilen zu überschreiben (Abschnitt 16).
- Schema-Entwicklung: neue Felder nur hinzufügen (`schemaVersion` 2, 3 ...), alte Leser
  übergehen sie. Ein Bruch erhöht `format` (`restow-layout-v2`); ein ISO, das das Format
  nicht kennt, lehnt mit "Dieses Recovery-ISO ist zu alt für diese Sicherung, bitte das
  aktuelle laden" ab. Alle in diesem Entwurf genannten Felder gehören zu `restow-layout-v1`
  (noch nichts ist ausgeliefert).
- Größe: höchstens 512 KiB kodiert (der Server lehnt größere ab; der Agent kürzt nichts,
  sondern meldet `layout_too_large`). Listen: höchstens 64 Platten, 256 Partitionen je
  Platte, 4096 Subvolumes, 1024 LVs, 256 Loader, 64 Netzwerkkarten.

Das Schema gibt es zweimal und beide werden gegen dieselben Testdaten geprüft: Go-Typen in
`agent/internal/baremetal/manifest.go` und ein Zod-Schema in
`packages/core/src/endpoints/baremetal/manifest.ts` (`layoutManifestSchema`,
`parseLayoutManifest`). Testdaten: `agent/internal/baremetal/testdata/manifests/*.json`
(Linux) und `testdata/manifests/darwin-*.json` (aus den Erfassungstests erzeugt,
eingecheckt); ein Vitest in `packages/core` liest dieselben Dateien und verlangt, dass jede
gültig ist und dass `layoutFingerprint` (TS) denselben Wert ergibt wie `LayoutFingerprint`
(Go, als `<name>.fingerprint` daneben gespeichert). Ungültige Beispiele
(`testdata/manifests/invalid-*.json`: Steuerzeichen, beide Plattformen, fehlende Pflicht-
felder, Zyklus in `BlockRef`) müssen in beiden Sprachen abgelehnt werden.

### 4.3 Ablage: im Snapshot und in der Datenbank

1. **Im Snapshot** (maßgeblich): Vor dem Anlegen der Dateisystem-Snapshots schreibt der Agent
   `Layout.BaremetalDir()` = `<DataDir>/baremetal/` neu (`paths.Layout`, neue Methode;
   Linux und macOS `/var/lib/restow-agent/baremetal/`, unter macOS also
   `/private/var/lib/restow-agent/baremetal/` auf dem Data-Volume): `layout.json` und `raw/`
   mit den Rohausgaben (`sfdisk-<disk>.dump`, `sgdisk-<disk>.backup` bei GPT, `lsblk.json`,
   `blkid.txt`, `mountinfo.txt`, `<vg>.vg` aus `vgcfgbackup`, `mdadm-detail-<md>.txt`,
   `luks-<id>.json`, `btrfs-subvolumes-<uuid>.txt`, `efivars.json`, `os-release`). Der Ordner
   gehört root, Modus 0700, und liegt im Wurzel-Dateisystem (bzw. in dem von `/var`), also
   im selben Snapshot wie das System, das er beschreibt. `raw/` dient der Fehlersuche und
   einer späteren Wiederherstellung von Hand; das ISO liest nur `layout.json`.
   **Auch `raw/` enthält keine Geheimnisse:** `luks-<id>.json` ist ein bereinigtes JSON
   (Version, UUID, Cipher, Schlüssellänge, Sektorgröße, KDF-Art und -Parameter, Belegung der
   Keyslots, Token-Typen, Flags), **nie** die Ausgabe von `--dump-json-metadata` selbst (sie
   enthält `digests`, Salts und Token-Inhalte, darunter bei Clevis/Tang ein JWE, mit dem
   jeder, der den Tang-Server erreicht, die Keyslot-Passphrase entschlüsselt);
   `efivars.json` nur aus der Positivliste (4.1); `proc-cmdline.txt` geschwärzt.
   Der Pfad des Manifests im Snapshot hängt von der Plattform ab:
   `manifestPathInSnapshot(platform, tags)` (`@restow/core`, Go-Gegenstück in
   `pathmap.go`): Linux `/var/lib/restow-agent/baremetal/layout.json`, darwin
   `<snapshotRoot>/private/var/lib/restow-agent/baremetal/layout.json` (Abschnitt 7).
2. **In der Datenbank** (für Oberfläche und Prüfung): Der Agent sendet das Manifest im
   Abschluss des Laufs mit (`POST /agent/v1/runs/:id/finish`, Feld `layout`). Der Server
   prüft es (`parseLayoutManifest`), speichert es dedupliziert nach SHA-256 der kanonischen
   Kodierung in `endpoint_layouts` und verweist vom Lauf darauf (`endpoint_runs.layout_id`).
   Ein ungültiges Manifest wird verworfen (der Lauf nicht), der Lauf bekommt dann den Hinweis
   `layout_rejected` und der Rechner ist für diesen Snapshot nicht Bare-Metal-fähig.

Kein drittes Exemplar im Speicherziel neben dem Repository (wie
`restow-repository-password.json`): Das Manifest enthält Hostnamen, Seriennummern und
Plattenbelegung im Klartext, und die Kopie im Snapshot überlebt einen Verlust der Datenbank
ohnehin (mit Master-Key und Speicher, docs/AGENT.md "Master-Key und Speicher genügen").

### 4.4 Bewertung beim Erfassen (`Assess`)

`verdict` ist `supported`, `supported_with_warnings` oder `unsupported`, mit der Liste
`unsupported[]` (Code, Verweis, Text).

`unsupported` (Code in Klammern): ZFS, bcachefs, F2FS, NTFS als einzuhängendes Dateisystem
eines Systempfads (`fs_type_unsupported`); LVM-Cache/-Writecache/VDO (`lvm_type_unsupported`);
IMSM/DDF (`md_container_unsupported`); md mit Journal oder PPL (`md_journal_unsupported`); ein
Array mitten in Reshape oder `--grow` (`md_reshape_in_progress`, gilt für diesen Snapshot);
Multipath (`multipath_unsupported`); dm-integrity (`integrity_unsupported`); losgelöster
LUKS-Header (`luks_detached_header`); iSCSI-/NFS-Root (`network_root_unsupported`); XFS mit
externem Log oder Realtime-Gerät (`xfs_external_log`); ein Bootloader oder initramfs-Erzeuger
außerhalb von 2.1 (`bootloader_unsupported`, `initramfs_unsupported`); eine UKI ohne Erzeuger
im System (`uki_without_generator`); ein unbekanntes Gerät im Weg zu `/`, `/boot` oder der
ESP (`unknown_device_in_boot_path`); ein Container (`container`); ein lokaler `fstab`-Eintrag
eines Systempfads, der sich nicht auflösen lässt (`fstab_unresolvable`).

`supported_with_warnings`: TPM2/FIDO2/Clevis-Token an einem LUKS-Volume (`luks_token`,
Abschnitt 10.10); Snapper-/Timeshift-Subvolumes (`snapshot_subvolumes`); LVM-Snapshot-LVs;
`raw`-LVs (`raw_lvs`, Abschnitt 10.10; bei Proxmox VE `pve_guest_volumes` mit Hinweis auf die
PVE-Integration); Docker mit btrfs-Treiber und mehr als 200 Subvolumes (`docker_btrfs_many`,
Abschnitt 5.2); ein Datendateisystem eines nicht unterstützten Typs abseits der Systempfade
(es wird gesichert, aber nicht neu angelegt; der Plan zeigt es als "nicht wiederhergestellt");
nicht geprüfte Distribution; Nicht-systemd-Init; Secure Boot an mit einem nicht von Microsoft
signierten Loader oder einem MOK-signierten Kernel (`secure_boot_own_keys`); DKMS-Module mit
MOK-Signatur (`dkms_mok`); BIOS-Start (`bios_needs_csm`: "Ersatzhardware braucht CSM bzw.
Legacy-Start; viele aktuelle Server und Arbeitsplätze haben das nicht"); Dual-Boot mit
Windows (`dual_boot_windows`); LVM-Gerätedatei oder Filter mit Gerätenamen
(`lvm_device_ids`, wird beim Wiederherstellen angepasst); Gerätenamen in Konfigurationen
außerhalb der bekannten Fixups (`device_name_refs`); md-Array zur Sicherungszeit degradiert
(`md_degraded`).

Das Urteil ist Anzeige und Vorfilter. Entscheidend sind der Planer (Abschnitt 10.4, auf dem
Server in Stufe 1) und die Startprobe.

## 5. Sicherung des ganzen Rechners

### 5.1 Job-Einstellung `wholeMachine`

- Neues Feld in den Job-Einstellungen der Art `endpoint` (`settings.wholeMachine: boolean`,
  Standard `false`; `BackupJobEndpointSettings` in `packages/db/src/schema/backup-jobs.ts`,
  JSONB, keine Migration). Pro Rechner nicht überschreibbar: Ein Job ist entweder ganz oder
  nicht.
- `packages/core/src/backup-jobs/endpoint-config.ts` schreibt es in die Konfiguration jedes
  Linux- und macOS-Mitglieds (`endpoints.config.wholeMachine`); Windows-Mitglieder
  bekommen es nicht. `GET /agent/v1/config` liefert `wholeMachine: true` und
  `fsSnapshot: "auto" | "off"` (Abschnitt 6.1), unter macOS zusätzlich `migrationPending`
  (Abschnitt 13.6). Ein älterer Agent kennt die Felder nicht und sichert weiter seine
  `paths`; die Oberfläche zeigt für Rechner mit Agent < 0.5.0 "Agent zu alt für Ganzer
  Rechner".
- Ein Container-Rechner (`settings.agent.machine.virtualization = container`) im Job bekommt
  das Feld nicht; die Job-Seite nennt ihn ("sichert seine Ordner, Bare Metal geht in einem
  Container nicht").
- Solange M5 nicht fertig ist, ist der Schalter hinter `RESTOW_BAREMETAL_PREVIEW`
  (Standard aus) verborgen (Abschnitt 22).

### 5.2 Quellen (Linux)

Mit `wholeMachine` ersetzt der Agent die `paths` des Jobs durch die Quellen aus dem eben
erfassten Manifest (`wholeMachineSources(m *baremetal.Manifest)` in neuem
`agent/internal/core/wholemachine.go`):

- jedes eingehängte Dateisystem der Typen aus 2.1, das auf einem lokalen Blockgerät des
  Manifests liegt (Platte, Partition, md, LUKS, LV), mit jedem Einhängepunkt einmal;
- jedes **lokale `fstab`-Eintrag** mit einem solchen Gerät, auch `noauto` und
  `x-systemd.automount` (vorher ausgelöst bzw. vom Helfer nur lesend eingehängt, 4.1, 6.3);
- bei btrfs jedes eingehängte Subvolume **und jedes Subvolume aus `btrfs subvolume list -a`,
  das unter einem eingehängten Pfad liegt**, als eigene, ausdrücklich genannte Quelle.
  Grund: `-x` überschreitet Subvolume-Grenzen nicht (1.2), und ein `-r`-Snapshot enthält
  verschachtelte Subvolumes nur als leere Ordner; ohne diese Regel fehlten Fedoras
  `/var/lib/machines` und `/var/lib/portables`, Docker mit dem btrfs-Treiber
  (`/var/lib/docker/btrfs/subvolumes/*`), LXD/Incus, Podman mit btrfs und von Hand angelegte
  Subvolumes stillschweigend. Ausgenommen sind nur Snapper- und Timeshift-Subvolumes
  (5.3). Bei openSUSE ist die Wurzel das Standard-Subvolume
  `@/.snapshots/<N>/snapshot`; es ist als `/` eingehängt und damit Quelle, die übrigen
  Snapper-Snapshots nicht (Abschnitt 10.11). Für den Docker-btrfs-Treiber mit mehr als
  200 Subvolumes bietet der Job die Wahl "Docker-Images neu laden statt sichern"
  (Ausschluss `/var/lib/docker/btrfs`, `/var/lib/docker/image`; Urteil
  `docker_btrfs_many`); Vorgabe bleibt "sichern".
- nicht: Pseudo- und Netzdateisysteme (`proc`, `sysfs`, `tmpfs`, `devtmpfs`, `overlay`,
  `squashfs` (Snap-Pakete, kommen mit dem Paket wieder), `nfs`, `cifs`, `fuse.*`, `autofs`
  selbst; das Dateisystem dahinter zählt), Bind-Mounts (gleiche Quelle, anderes Ziel: nur
  der erste Einhängepunkt);
- Wechseldatenträger (`RM=1`, Transport `usb`, `mmc`) **nur dann nicht**, wenn sie weder in
  `fstab` stehen noch im Weg zu `/`, `/boot` oder der ESP liegen. Ein System mit Wurzel auf
  USB-SSD oder eMMC wird damit vollständig gesichert;
- `restic backup -x` mit dieser Liste: Grenzen zu nicht genannten Dateisystemen werden nicht
  überschritten, eine vergessene Grenze kann also nichts doppelt sichern.

Prüfung in L5 (Abschnitt 12.1): Jeder lokale `fstab`-Eintrag und jedes Subvolume des
Manifests unter einem Systempfad ist Quelle oder ausdrücklich ausgeschlossen.

### 5.3 Ausschlüsse

- Die Job-Ausschlüsse gelten weiter. Beim Einschalten von `wholeMachine` ersetzt der
  Job-Editor die Standardausschlüsse des Profils (`DEFAULT_EXCLUDES` in `config.ts`, darunter
  `node_modules` und `/var/lib/docker`, die in einer Systemwiederherstellung fehlen würden)
  durch `DEFAULT_WHOLE_MACHINE_EXCLUDES` (neu, `packages/core/src/endpoints/whole-machine.ts`):
  `/tmp/*` (nur wenn `/tmp` kein eigenes tmpfs ist, sonst ohnehin außen vor),
  `/var/tmp/*`, `/var/cache/apt/archives/*.deb`, `/var/cache/dnf/*`, `/var/cache/yum/*`,
  `/var/cache/pacman/pkg/*`, `/var/cache/zypp/packages/*`, `/var/lib/systemd/coredump/*`,
  `lost+found` (Inhalt). Docker, Podman und containerd bleiben drin: Nach einer
  Wiederherstellung sollen die Dienste laufen. Der Bediener kann sie im Job ausschließen.
  macOS hat eine eigene Liste (`DEFAULT_DARWIN_WHOLE_MACHINE_EXCLUDES`, Abschnitt 13.2).
- Immer, für **jede** Sicherung (auch ohne `wholeMachine`) und auf jedem System:
  `Layout.StateFile()` und die Zwischendateien von `state.Save` (`state.json`,
  `.state.json.*`), `Layout.CacheDir()`, `Layout.TmpDir()`, `Restow-Restore-*` (heute
  schon). Unter macOS bildet
  `pathmap.go` (`expandDarwinExcludes`) jeden absoluten Ausschluss des Agenten **und des
  Jobs** auf alle Schreibweisen ab: erstens die Link-Form (`/etc`, `/var`, `/tmp` →
  `/private/...`), zweitens die Form auf dem Data-Volume (`/System/Volumes/Data` + Pfad, für
  Rückfall-Läufe), drittens die Snapshot-Form (`<APFSMountPoint>` + Data-Volume-Pfad). Die
  Tabelle der Firmlinks kommt zur Laufzeit aus `/usr/share/firmlinks` des Rechners (Zeilen
  `/<pfad>\t<data-relativ>`), nicht aus dem Code. Test `pathmap_test.go` mit aufgezeichneten
  `firmlinks`-Dateien aus macOS 14, 15 und 26; der darwin-Test in `harness_test.go`
  verlangt, dass `state.json` in keinem Snapshot vorkommt (`restic ls`).
- Swap-Dateien aus `/proc/swaps` (sie werden neu angelegt, Abschnitt 10.11).
- btrfs-Subvolumes von Snapper (`.snapshots`, `@snapshots`, `@/.snapshots`) und Timeshift
  (`timeshift-btrfs`) sind keine Quellen (ihr Inhalt würde vervielfacht); `recover` legt sie
  leer an, damit `fstab` und Snapper stimmen. Ausnahme openSUSE: das als `/` eingehängte
  Standard-Subvolume `@/.snapshots/<N>/snapshot` ist Quelle (5.2), und die Datei
  `@/.snapshots/<N>/info.xml` (Snapper-Metadaten des laufenden Stands, außerhalb des
  Subvolumes) sichert der Agent als eigene Quelle `/.snapshots/<N>/info.xml`.
- Das Manifest hält die geltenden Ausschlüsse fest (`backup.excludes`); der Plan zeigt sie
  ("nicht gesichert und darum leer: ...").

### 5.4 `state.json`, Schlüsseldateien und andere Geheimnisse

Ab 0.5.0 sichert kein Agent mehr seinen Zustand. Grund: Das Agent-Secret im Repository nützt
nach einer Wiederherstellung nichts (der Server soll ein neues ausstellen, Abschnitt 11),
schadet aber bei einer Kopie des Rechners (zwei Rechner mit demselben Secret). Umsetzung in
`backupStep`: die Ausschlussliste wie heute (`a.d.Layout.CacheDir()`, `TmpDir()`) um
`a.d.Layout.StateFile()` und das Muster der Zwischendateien erweitert, unter macOS über
`expandDarwinExcludes` (5.3).

Ältere Snapshots enthalten die Datei weiter, und jeder Snapshot kann LUKS-Schlüsseldateien
enthalten (`crypttab` nennt sie; typisch `/etc/luks-keys/*`, `/etc/cryptsetup-keys.d/*`,
`/root/*.key`). `@restow/core` `restoreSelectionIssue` (neu, `restore-target.ts`):

- `state.json` ist im Restore-Dialog und im Browser ausgeblendet und als Einzelauswahl
  abgelehnt, damit niemand einen Rechner versehentlich mit einem alten Secret zurücksetzt;
- für die Rolle `tenant_restore` sind `state.json` und jeder Pfad aus `luks[].keyFile` des
  zugehörigen Manifests gesperrt (Browser, ZIP-Download, Restore-Auswahl, `restic dump` über
  die API); Admins nur mit `assertRecentSignIn` und Audit
  (`endpoint.repository.secret_file_revealed`, wie `repositoryPasswordRevealed`).

Die Wiederherstellung erzeugt Schlüsseldateien neu, statt die gesicherte als Keyslot der
neuen Volumes zu übernehmen (Abschnitt 10.10).

### 5.5 restic-Aufruf

`restic.BackupOptions` (`agent/internal/restic/backup.go`) bekommt:

```go
// OneFileSystem: --one-file-system (whole machine).
OneFileSystem bool
// GroupBy: --group-by <v> (whole machine: "host"); empty keeps restic's default.
GroupBy string
// Exec, when set, runs restic through this argv prefix (the snapshot helper,
// section 6.3): argv = Exec + [restic binary] + restic args.
Exec []string
```

`backupArgs` ergänzt `--one-file-system --group-by host --tag restow-baremetal` und
`--files-from-raw` mit den Quellen. Warum `--group-by host`: Die Liste der Quellen ändert
sich (eine neue Platte, ein neues Subvolume, ein Wechsel aus einem Job ohne `wholeMachine`),
und mit dem Standard `host,paths` würde restic dann ohne Elternsnapshot jede Datei neu
lesen. Die Aufbewahrung des Servers gruppiert ohnehin nicht (docs/AGENT.md).
`--exclude-caches` bleibt (Ordner mit `CACHEDIR.TAG` sind per Definition entbehrlich).

### 5.6 Ablauf eines Ganz-Rechner-Backups

In `doBackup`/`backupStep` (`agent/internal/core/backup.go`), nach dem Pre-Hook:

1. Automount-Einhängepunkte auslösen (4.1), dann `baremetal.Capture` (Zeitlimit 2 Minuten
   insgesamt). Scheitert die Erfassung ganz, läuft die Sicherung als gewöhnliche Sicherung
   der Einhängepunkte aus `/proc/self/mountinfo` weiter; Lauf `partial` mit
   `layout_capture_failed`.
2. Manifest und bereinigtes `raw/` nach `Layout.BaremetalDir()` schreiben (atomar über
   `internal/atomicfile`, alte Rohdateien vorher löschen).
3. Snapshot-Plan (Abschnitt 6), Snapshots anlegen.
4. restic über den Snapshot-Helfer (Abschnitt 6.3).
5. Stichprobe (`collectSample`) und Ransomware-Messung (`activity.MeasureAll`) **aus dem
   Snapshot-Baum**, solange er besteht: Der Helfer bekommt dafür einen zweiten Aufruf
   (`restow-agent snapshot-exec --spec <datei> --measure <liste>`), der im selben Baum
   hasht und misst und das Ergebnis als JSON auf stdout gibt. Damit entspricht der Hash
   immer dem gesicherten Inhalt, und die Regel "nur unveränderte Dateien"
   (`agent/internal/core/sample.go`) entfällt für diese Läufe. `restic diff` läuft wie bisher
   gegen das Repository.
6. Snapshots entfernen (Abschnitt 6.5), `consistency` bilden.
7. Abschluss mit `layout` (Manifest), `consistency`, `stats` wie bisher.

Neue Lauf-Fehlercodes (`packages/core/src/endpoints/run-errors.ts`,
`ENDPOINT_RUN_ERROR_CODES`): `layout_capture_failed` (Lauf `partial`), `layout_too_large`
(`partial`), `layout_rejected` (vom Server gesetzt, Hinweis), `cloud_file_skipped`
(macOS, Hinweis, nie `partial`, Abschnitt 13.2). Die Kategorie "nicht unterstützt" ist
**kein** Lauf-Fehler: Die Sicherung ist richtig, nur die Wiederherstellung des ganzen
Rechners geht nicht; das zeigt die Rechnerseite (Abschnitt 14.6) und nicht jeder Lauf als
`partial`.

## 6. Dateisystem-Snapshots unter Linux

### 6.1 Wann

- Einstellung am Rechner `fsSnapshot: "auto" | "off"` (`endpoints.config`, JSONB, keine
  Migration), gesendet in `GET /config`. Vorgabe: `auto` für Rechner in einem Job mit
  `wholeMachine`, sonst `off` (Offene Frage 4). Ein Administrator kann es je Rechner ändern
  (Einstellungen, neben "Schattenkopie (VSS)" bei Windows); `useVss` bleibt das Windows-Feld.
- `auto` heißt: je Dateisystem ein Snapshot, wo es geht (Tabelle), sonst live. Was live
  gelesen wurde, steht in `consistency.liveFilesystems` (Einhängepunkte), `state` ist
  `used` (alle mit Snapshot), `partial` (einige live) oder `unavailable` (keiner).
- Richtlinie `snapshotOnFailure` unverändert (`agent-policy.ts`): `continue` (Standard)
  sichert ohne den gescheiterten Snapshot weiter und endet `partial` mit `snapshot_failed`
  bzw. `snapshot_unavailable`; `fail` endet `failed`. Ein Dateisystem, für das es gar kein
  Verfahren gibt (ext4 direkt auf einer Partition), ist **kein** Fehler: Es zählt in
  `liveFilesystems`, der Lauf bleibt `succeeded` (wie die vorab ausgeschlossenen Volumes
  unter Windows, docs/WINDOWS-AGENT.md 17.1). Ebenso **eine VG ohne freie Extents** für
  dicke Snapshots: Die geführten LVM-Installationen von Debian, Ubuntu und RHEL belegen die
  ganze VG; das ist "kein Verfahren", nicht "gescheitert" (6.2).

| Dateisystem liegt auf | Verfahren | `method` |
| --- | --- | --- |
| btrfs (jedes Subvolume, auch verschachtelte Quellen) | `btrfs subvolume snapshot -r` je Subvolume | `btrfs` |
| ext2/3/4, XFS auf einem LV (dick), VG mit freiem Platz | `lvcreate -s -L <cow> -n <lv>_restowsnap --addtag restow-agent-snapshot` | `lvm` |
| ext2/3/4, XFS auf einem Thin-LV | `lvcreate -s -n <lv>_restowsnap --addtag restow-agent-snapshot` (ohne Größe), Aktivierung mit `-K` | `lvm` |
| LVM auf LUKS (der übliche verschlüsselte Aufbau) | wie LV | `lvm` |
| LV in einer VG ohne freie Extents | kein Verfahren, live, `succeeded` | – |
| LUKS auf einem LV | live (Abschnitt 6.6) | – |
| Partition, md, LUKS auf Partition | live | – |
| vfat (ESP) | live (klein, ändert sich selten) | – |

Gibt es sowohl LVM- als auch btrfs-Snapshots in einem Lauf, ist `method` `mixed`.

Die Rechnerseite erklärt "kein Verfahren" einmal, nicht je Lauf: "vg0 hat keinen freien
Platz für Snapshots. Lassen Sie 10 Prozent der VG (hier 48 GiB) frei, dann sichert Restow
`/` und `/home` konsistent." (`baremetal.snapshotHint`, aus Manifest und letztem Lauf).

### 6.2 Schutz der Produktion

Ein Snapshot darf den Rechner nie gefährden. Regeln in `agent/internal/fssnap/lvm_linux.go`:

- **Dick:** COW-Größe je LV = 10 Prozent der LV-Größe, mindestens 1 GiB, höchstens 32 GiB;
  alle zusammen höchstens 90 Prozent des freien Platzes der VG. Hat die VG weniger als 1 GiB
  frei, gilt "kein Verfahren" (6.1, `succeeded`). Reicht der Platz nicht für alle,
  bekommen Snapshots in dieser Reihenfolge Platz: `/`, dann nach Tiefe des Einhängepunkts;
  der Rest wird live gelesen, ebenfalls ohne Fehler, aber mit Hinweis im Lauf-Log.
  `snapshot_failed` heißt nur noch: Platz war da und `lvcreate` scheiterte trotzdem, oder der
  Snapshot lief während des Laufs über. Ein überlaufender dicker Snapshot wird ungültig, das
  Original bleibt unberührt.
- **Thin:** nur, wenn Daten- und Metadatenbelegung des Pools unter 80 Prozent liegen.
  Während des Laufs prüft der Agent alle 30 Sekunden (`lvs -o data_percent,metadata_percent`);
  über 90 Prozent bricht er restic ab (eigene Ursache `errThinPoolPressure` über
  `context.WithCancelCause`, wie `errSnapshotFailed`), entfernt die Snapshots und sichert bei
  `continue` sofort live erneut (zweiter restic-Lauf wie der VSS-Rückfall in `backupStep`),
  bei `fail` endet der Lauf `failed`. Ein voller Thin-Pool legt alle Thin-LVs darin still; das
  darf eine Sicherung nie auslösen.
- **Dick, Überwachung:** derselbe Takt prüft `snap_percent`; über 95 Prozent gilt der Snapshot
  als gescheitert (restic bekommt danach Lesefehler), Behandlung wie Thin.
- **btrfs:** Snapshots kosten nur geänderte Blöcke; vor dem Anlegen prüft der Agent
  `btrfs filesystem usage --raw` und legt keinen an, wenn weniger als 5 Prozent oder 2 GiB
  frei sind (dann `snapshot_failed`, weil das Verfahren grundsätzlich da ist).
- Einfrieren: `lvcreate` friert ext4 und XFS über dm-suspend selbst ein; btrfs-Snapshots sind
  atomar je Subvolume (über Subvolumes hinweg nicht; das steht in der Erklärung von
  `consistency`). Kein `fsfreeze` durch den Agenten.

### 6.3 Pfade bleiben gleich: privater Mount-Namensraum und `chroot`

restic kann keine Pfade umschreiben (1.2). Würde der Agent den Snapshot unter
`/run/restow-agent/snap/...` sichern, stünden alle Dateien unter diesem Präfix, ein Rückfall
auf live (`continue`) erzeugte andere Pfade, und Restore, Browser, Stichprobe und
Ransomware-Auswertung müssten umrechnen. Darum baut der Agent den Snapshot-Baum in einem
privaten Mount-Namensraum unter der echten Wurzel und startet restic darin mit `chroot`:

- Neuer versteckter Befehl `restow-agent snapshot-exec --spec <datei> -- <restic> <args>`
  (`cmd/restow-agent/snapshotexec.go`, `//go:build linux`; Logik in
  `agent/internal/fssnap/nsexec_linux.go`). Der Agent startet ihn mit
  `SysProcAttr{Unshareflags: syscall.CLONE_NEWNS}`; die Go-Laufzeit macht `/` im Kind privat.
- Der Helfer liest die Spezifikation (JSON in `Layout.TmpDir()`, 0600): baut ein `tmpfs` unter
  `/run/restow-agent/snaptree`, hängt den Wurzel-Snapshot dort nur lesend ein, darunter je
  Quelle den Snapshot oder (live) einen nur lesenden Bind-Mount des echten Dateisystems, in
  der Reihenfolge der Pfadtiefe. Verschachtelte btrfs-Subvolumes bekommen je einen eigenen
  `-r`-Snapshot, eingehängt an ihrer Stelle im Baum (sonst wären es leere Ordner).
  `noauto`-Einträge aus `fstab` mit lokalem Gerät hängt der Helfer nur hier, nur lesend und
  nur für diesen Lauf ein (ext4 `ro,noload`, XFS `ro,norecovery`, vfat `ro`). Dann nur
  lesend `/proc`, `/sys`, `/dev`, `/run` (für `/etc/resolv.conf` als Link nach
  `/run/systemd/resolve`) als Bind; lesend und schreibend `Layout.CacheDir()` und
  `Layout.TmpDir()`; das restic-Programm als Datei-Bind an seinem Ort. Danach `chroot`,
  `chdir("/")`, `syscall.Exec(restic)`. restic sieht `/`, `/home`, ... wie auf dem Rechner,
  `-x` übergeht `/proc`, `/sys`, `/dev`, `/run`.
- Einhängeoptionen: ext3/ext4 `ro,noload` (kein Journal-Replay auf dem Snapshot), XFS
  `ro,nouuid,norecovery` (`nouuid`, weil Original und Snapshot dieselbe UUID tragen; ohne
  verweigert XFS das Einhängen), btrfs als Bind des Snapshot-Subvolumes, das der Helfer vorher
  über ein Einhängen der obersten Ebene (`subvolid=5`) unter
  `/run/restow-agent/btrfs/<uuid>` erreicht.
- Abbruch: SIGINT an den Helfer ist SIGINT an restic (nach `Exec` derselbe Prozess), wie
  heute (`configureProcess` in `runner_unix.go`). Stirbt der Agent oder der Helfer, verschwinden
  alle Einhängungen mit dem Namensraum; auf dem Rechner bleibt nichts eingehängt.
- Der Runner (`agent/internal/restic/runner.go`, `exec`) startet bei gesetztem
  `BackupOptions.Exec` das Präfix statt `r.Bin`; Umgebung, Ausgabeverarbeitung und
  Exit-Codes bleiben gleich.
- `--measure` (5.6): derselbe Baum, statt `Exec` liest der Helfer die Liste der Pfade von
  stdin, hasht bzw. misst sie mit `activity.MeasureAll` und `sample.go` und schreibt JSON.

Was der Agent im Baum nicht ändern kann, ist der Inhalt des Snapshots selbst: CA-Zertifikate,
`/etc/hosts`, `/etc/passwd` (für restics Namensauflösung) kommen aus dem Snapshot, der
Sekunden alt ist. Das ist gewollt.

### 6.4 Snapshot-Plan und Politik

`agent/internal/core/snapshot_linux.go` (neu, ersetzt `snapshot_other.go` für Linux;
`snapshot_darwin.go` kommt mit M6, `snapshot_other.go` bleibt für andere Unix-Systeme)
liefert `planSnapshot(cfg, sources)` mit den Dateisystemen und Verfahren,
`snapshotPlan.method` und `volumes` (hier: Einhängepunkte). `backupStep` bekommt einen
zweiten Zweig: Bei `plan.requested && plan.method != "vss"` legt `fssnap.Create(ctx, plan)`
die Snapshots an, liefert die Spezifikation für den Helfer und ein `fssnap.Outcome`
(gescheitert je Einhängepunkt mit Grund, live, kein Verfahren, aufgeräumt). Daraus bildet
`consistencyOf` wie bisher den Bericht; `restic.SnapshotOutcome` bleibt der Typ
(`FailedVolumes` enthält dann Einhängepunkte). `snapshotLogHint` und die Texte von
`snapshotUnavailableError`/`snapshotFailedErrors` werden je Verfahren formuliert (heute fest
"Volume Shadow Copy"): `lvs`, `vgs`, `journalctl -k` für LVM, `btrfs filesystem usage` für
btrfs, `diskutil apfs listSnapshots` für APFS. Schlägt das Anlegen fehl:

| Fall | `continue` | `fail` |
| --- | --- | --- |
| kein Verfahren (Partition, VG ohne freie Extents) | live, `succeeded` | live, `succeeded` |
| ein Snapshot scheitert (`lvcreate`-Fehler trotz Platz, btrfs unter der Schwelle) | dieses Dateisystem live, `partial`, `snapshot_failed` mit Pfad | `failed`, `snapshot_failed` |
| kein Snapshot möglich (Werkzeug fehlt, keine Rechte, Kernel ohne `dm_snapshot`) | alles live, `partial`, `snapshot_unavailable` | `failed`, `snapshot_unavailable` |
| Snapshot läuft während des Laufs voll | Abbruch, live neu, `partial`, `snapshot_failed` | `failed` |
| Entfernen scheitert | `snapshot_cleanup_failed` (Hinweis), Aufräumen beim nächsten Start | ebenso |

### 6.5 Aufräumen

- Nach jedem Lauf: Snapshot-LVs (`lvremove -y`), btrfs-Snapshots
  (`btrfs subvolume delete`), auch nach Abbruch und Zeitüberschreitung (eigener Kontext mit
  2 Minuten wie der Post-Hook).
- Beim Start des Agenten und vor jedem Lauf (`fssnap.CleanupStale`): jedes LV mit dem Tag
  `restow-agent-snapshot` und jedes Subvolume unter `<oberste Ebene>/.restow-snapshots/`, das
  zu keinem laufenden Lauf gehört. Name und Tag sind die einzige Kennung; der Agent entfernt
  nie etwas ohne beides.
- Das Ergebnis steht im Lauf-Log ("2 übrig gebliebene Snapshots vom 03.11. entfernt").

### 6.6 Bewusst live

LUKS auf einem LV (verschlüsseltes Dateisystem in einem LV statt LVM in LUKS): Der
Snapshot des LV wäre verschlüsselt, und ihn zu öffnen hieße, den Hauptschlüssel aus dem
Kernel zu lesen (`dmsetup table --showkeys`). Das tut der Agent nicht; diese Dateisysteme
werden live gelesen und stehen in `liveFilesystems`.

## 7. Dateisystem-Snapshots unter macOS (APFS)

- **Quelle:** Unter `wholeMachine` ist die Quelle die **ganze Data-Volume-Wurzel** mit `-x`
  und den Ausschlüssen aus 13.2, nicht eine Liste einzelner Ordner. Damit liegen auch
  `/private/var/root`, `/Users/Shared`, `/opt` und das Manifest
  (`private/var/lib/restow-agent/baremetal/layout.json`) im Snapshot.
- **Lebenszyklus** (`agent/internal/fssnap/apfs_darwin.go`):
  1. `diskutil apfs listSnapshots -plist /System/Volumes/Data` vorher, `tmutil localsnapshot`,
     `diskutil apfs listSnapshots -plist /System/Volumes/Data` nachher. Der eine neue Eintrag
     (Name `com.apple.TimeMachine.<datum>.local` und **UUID**) wird in
     `Layout.DataDir()/apfs-snapshots.json` geführt; ist es nicht genau einer, gilt der
     Snapshot als gescheitert (nichts wird gelöscht).
  2. `mount_apfs -o nobrowse,rdonly -s <name> /System/Volumes/Data
     /private/var/run/restow-agent/apfs` (Entscheidung).
  3. Während des Laufs `caffeinate -i -w <agent-pid>` (der Mac schläft nicht ein), und im
     30-Sekunden-Takt (wie 6.2) prüft der Agent, ob die UUID noch in `listSnapshots` steht
     und der Mount noch besteht. Fehlt eins (macOS dünnt lokale Snapshots nach 24 Stunden
     und bei Platzmangel aus), bricht er restic ab und behandelt das wie einen
     übergelaufenen Snapshot: Rückfall nach Richtlinie (`continue`: zweiter Lauf live,
     `partial`, `snapshot_failed`).
  4. `umount`, dann **nur** `diskutil apfs deleteSnapshot /System/Volumes/Data -uuid <uuid>`
     mit einer UUID aus `apfs-snapshots.json`. Nie `tmutil deletelocalsnapshots` (mit `/` als
     Argument löscht es alle lokalen Time-Machine-Snapshots, mit einem Datum auch einen von
     Time Machine im selben Augenblick angelegten). Ein Test in `apfs_darwin_test.go`
     erzwingt, dass kein Lösch-Aufruf ohne `-uuid` und ohne eigene, geführte UUID entsteht.
  5. Übrig gebliebene eigene Snapshots räumt der Agent beim Start auf, nur die aus
     `apfs-snapshots.json`.
- **Voraussetzung:** Festplattenvollzugriff für `restow-agent` (Abschnitt 13.3). Ohne ihn
  scheitert `mount_apfs` bzw. das Lesen; Behandlung `snapshot_unavailable` nach der
  Richtlinie, dazu der Heartbeat-Zustand `fullDiskAccess: "denied"`.
- **Pfade:** macOS kennt weder private Mount-Namensräume noch Bind-Mounts, ein `chroot` in den
  Data-Snapshot hätte keine Systembibliotheken. Snapshot-Pfade tragen darum ein Präfix:
  `/private/var/run/restow-agent/apfs` (Snapshot, Tag `restow-fsroot=apfs`) bzw.
  `/System/Volumes/Data` (Rückfall live, Tag `restow-fsroot=data`). Darunter liegen in
  beiden Fällen dieselben Data-Volume-relativen Pfade (`Users/anna/...`,
  `private/etc/...`). `@restow/core` `snapshotRootOf(tags)` liefert das Präfix; Browser,
  ZIP-Download, Restore-Auswahl und die Anzeige der Lauf-Pfade rechnen mit
  `toViewPath`/`fromViewPath` um (Präfix ab, Firmlink-Form `/Users/...`,
  `/private/etc` als `/etc` angezeigt); der Agent stellt mit
  `restic restore <id>:<präfix>/<data-relativ>` her (Unterordner-Syntax, 1.2) und rechnet
  Auswahlpfade ebenso um (`agent/internal/core/pathmap.go`, neu, ohne Build-Tag). Sicherungen
  ohne `wholeMachine` (heute `/Users`) bleiben ohne Präfix und ohne Tag; die Abbildung
  kennt drei Formen.
- **Elternsnapshot:** Ein Wechsel zwischen APFS- und Live-Lauf liest einmal alle Dateien neu
  (restic sucht Knoten im Elternbaum nach Pfad, und die Präfixe unterscheiden sich);
  Deduplizierung verhindert das Hochladen. `--group-by host` ändert daran nichts.
- **Ransomware-Signale:** `collectActivity` ruft
  `restic diff <vorher>:<rootVorher> <jetzt>:<rootJetzt>` mit `snapshotRootOf(tags)` beider
  Snapshots (Unterordner-Syntax, `restic diff --help` 0.19.1), damit ein Wechsel des Präfixes
  nicht als "alles gelöscht, alles neu" zählt. Stichprobe und Entropie-Messung laufen **vor**
  dem Aushängen gegen den Snapshot-Baum (wie 5.6 Punkt 5 für Linux), mit `snapshotToLocalPath`
  auf den Einhängepunkt statt auf den lokalen Pfad. Unit-Tests in `activity_test.go` für alle
  vier Kombinationen (APFS→APFS, APFS→live, live→APFS, live→live) und für `/Users` ohne
  Präfix → APFS.
- Der Snapshot ist absturzkonsistent für das ganze Data-Volume. Mail, Fotos, Datenbanken von
  Programmen sind im Zustand eines Stromausfalls, nicht im Zustand nach sauberem Beenden.
- `method: "apfs"`, sonst dieselben Regeln wie unter Linux (6.1, 6.4).
- [Maschine] Ob `tmutil localsnapshot` ohne eingerichtetes Time Machine auf allen
  unterstützten macOS-Versionen einen Snapshot des Data-Volumes anlegt; ob macOS einen
  **eingehängten** lokalen Snapshot ausdünnt; wie sich `tmutil localsnapshot` bei
  eingerichtetem Time Machine mit mehreren Volumes verhält; wie lange `tmutil` bei vollem
  Volume braucht.

## 8. Recovery-ISO

### 8.1 Eigenes Werk unter `integrations/recovery`

Entscheidung des Maintainers: getrennt vom Kern, GPL. Lizenz des Werks:
**GPL-3.0-or-later** (Vorschlag, Entscheidung 25.B18): Die Bauanleitung folgt live-build
(GPL-3.0-or-later) und darf dessen Beispiel-Hooks übernehmen; nichts darin muss mit
GPL-2.0-only-Code verbunden werden. Inhalt:

```
integrations/recovery/
  LICENSE                     GPL-3.0 (voller Text)
  README.md                   Bau, Prüfung, Lizenzen, Firmwareliste
  build.sh                    Einstieg: Container, live-build, Prüfsummen (SPDX-Kopf)
  snapshot.env                SNAPSHOT_TIMESTAMP, DEBIAN_IMAGE_DIGEST, LIVE_BUILD_VERSION
  packages.lock               Paket, Version, SHA-256 der .deb (jede Zeile, auch Abhängigkeiten)
  auto/config                 lb config ... (SPDX-Kopf)
  config/package-lists/recovery.list.chroot
  config/package-lists/firmware.list.chroot
  config/hooks/live/*.hook.chroot       (Shell, SPDX)
  config/includes.chroot/etc/lvm/lvmlocal.conf                     (keine Auto-Aktivierung)
  config/includes.chroot/etc/mdadm/mdadm.conf                      (AUTO -all)
  config/includes.chroot/etc/udev/rules.d/64-md-raid-assembly.rules   (leer: maskiert)
  config/includes.chroot/etc/udev/rules.d/64-btrfs.rules              (leer: maskiert)
  config/includes.chroot/etc/systemd/system/restow-recover.service
  config/includes.chroot/etc/systemd/network/80-restow-dhcp.network
  config/includes.chroot/usr/share/doc/restow-recovery/README
  config/bootloaders/grub-pc/*, grub-efi/*, isolinux/*   Menüs (Abschnitt 8.6)
  firmware.md                 die Liste aus 8.4 mit Begründung und Lizenzen
  sources.sh                  Quellpaket-Bündel (Abschnitt 8.7)
  test/machines/*.sh          Testmaschinen-Fabrik für die CI (Abschnitt 21.2)
  test/no-secrets.sh          Suche nach Schlüssel- und Token-Mustern im entpackten Abbild
```

Kein TypeScript, JavaScript oder Go darin (`check-separate-works.mjs`, `CORE_CODE`). Die
Programme `restow-agent` und `restic` legt `build.sh` aus einem übergebenen Ordner
(`agent/dist/linux-amd64/`) nach `/usr/lib/restow-recovery/` ins Abbild, mit
`THIRD_PARTY_NOTICES.txt`: Sie sind eigenständige Programme im Abbild, keine Bestandteile des
Werks. Änderungen an `scripts/ci/license-policy.json`: neuer Eintrag
`"integrations/recovery": { "license": "GPL-3.0-or-later", "reason": "...", "allowedReferences":
[".github/workflows/ci.yml", ".github/workflows/release.yml",
".github/workflows/recovery-nightly.yml", "docs/BAREMETAL.md", "docs/AGENT.md",
"docs/CI.md", "agent/README.md", "NOTICE", "THIRD_PARTY_NOTICES.md",
"scripts/recovery-e2e/run.mjs", "scripts/release/sign-agent.sh",
"scripts/ci/check-separate-works.mjs", "scripts/ci/check-separate-works.test.mjs",
"scripts/ci/license-policy.json"] }`; `check-separate-works.mjs` bekommt Marker für GPL-3.0
(`"GNU GENERAL PUBLIC LICENSE"`, `"Version 3, 29 June 2007"`) und einen Test dafür. Die
Testmaschinen-Fabrik (Shell) liegt im Werk, der Ende-zu-Ende-Treiber (Node, Apache-2.0)
außerhalb in `scripts/recovery-e2e/`.

### 8.2 Basis und Inhalt

- **Debian 13 (trixie), amd64, Kernel 6.12**, gebaut mit live-build aus einem festen Stand
  von `snapshot.debian.org` (`main`, `non-free-firmware`, dazu `debian-security` desselben
  Zeitpunkts). Grund für Debian: eine von Microsoft über shim signierte Startkette (shim,
  GRUB, Kernel, Module), die ohne eigene Schlüssel unter Secure Boot startet; reproduzierbare
  Live-Images sind bei Debian selbst ein laufendes Vorhaben; die Werkzeuge sind aktuell
  genug für alles aus 2.1 (lvm2 2.03.31 mit `--devices`, btrfs-progs mit `map-swapfile`).
- Pakete (`recovery.list.chroot`, ohne `Recommends`): `systemd`, `systemd-resolved`,
  `systemd-timesyncd`, `udev`, `kmod`, `util-linux` (`lsblk`, `blkid`, `wipefs`,
  `blkdiscard`, `findmnt`, `prlimit`), **`fdisk`** (`sfdisk`, `fdisk`; in Debian nicht in
  `util-linux`), `gdisk` (`sgdisk`), `parted` (nur `partprobe`), `mdadm`, `lvm2`,
  **`dmsetup`**, `thin-provisioning-tools`, `cryptsetup`, `cryptsetup-bin`, `dosfstools`,
  `e2fsprogs`, `xfsprogs`, `btrfs-progs`, `efibootmgr` (nur Anzeige, `recover` schreibt
  NVRAM selbst), `mokutil`, `grub-efi-amd64-signed`, `grub-pc-bin` (nur für das ISO selbst),
  `shim-signed`, `openssh-server` (aus, Abschnitt 10.2), `ca-certificates`, `kbd` und
  `console-setup` (Tastaturbelegung), `pciutils`, `usbutils`, `ethtool`, `iproute2`,
  `nvme-cli`, `sg3-utils` (4Kn/SAS-Diagnose), `smartmontools`, `less`, `nano`,
  `linux-image-amd64`, `live-boot`, `live-config`. Bewusst nicht: Desktop, WLAN-Werkzeuge,
  `os-prober`, ZFS, GPU-Firmware.
- Der CI-Job `recovery-iso` prüft jedes Programm, das `recover` aufruft, mit `command -v` im
  Abbild; die Liste erzeugt `restow-agent recover --list-tools` aus dem Go-Code
  (`agent/internal/recovery/tools.go`, eine Tabelle, die auch der Aufrufer nutzt), damit
  sie nicht veraltet.
- **Keine Auto-Aktivierung** im Live-System (alte Platten können angeschlossen sein,
  Abschnitt 10.7): `/etc/lvm/lvmlocal.conf` mit
  `activation { auto_activation_volume_list = [] }` und `global { event_activation = 0 }`;
  die udev-Regel `64-md-raid-assembly.rules` maskiert (leere Datei unter `/etc/udev/rules.d`),
  `mdadm.conf` mit `AUTO -all`; kein `btrfs device scan` (die udev-Regel
  `64-btrfs.rules` ebenfalls maskiert); Kernel-Parameter `noswap nopersistence` (live-boot)
  im Menü; `systemd-gpt-auto-generator` maskiert. live-build erzeugt das initramfs des ISO
  nach den Hooks, die Einstellungen gelten also auch dort. live-boot
  sucht sein Medium mit `live-media=removable-usb` bzw. dem ISO-Label
  (`live-media-label`) und `live-media-timeout=30` und hängt sonst keine fremden Medien ein.
  Ein Test im Job `recovery-iso` startet das ISO in QEMU mit einer zweiten Platte, die ein
  md-Array, eine VG und ein btrfs trägt, und verlangt, dass nach dem Start nichts davon
  aktiv ist (`/proc/mdstat` leer, `dmsetup ls` ohne LVM, `/proc/swaps` leer).
- Im Live-System: `restow-recover.service` startet `restow-agent recover --console /dev/tty1`
  (bei `restow.console=ttyS0` bzw. `ttyS1` auf der seriellen Konsole); ein Root-Login ohne
  Passwort gibt es nicht, eine Shell bekommt der Bediener über den Menüpunkt "Shell" in
  `recover` (Abschnitt 10.2).
- Arbeitsspeicher: mindestens 2 GiB, empfohlen 4 GiB und mehr für große Repositories (restic
  hält den Index im Speicher; `recover` schätzt den Bedarf aus der Indexgröße, die der Server
  mitteilt, und warnt). restic läuft mit `--no-cache` (der Cache läge im RAM).
- Größe: Ziel unter 900 MiB.
- **Keine Geheimnisse, nichts Instanzbezogenes:** keine URL, kein Schlüssel, keine CA, kein
  Token, keine Hostschlüssel (die erzeugt `sshd` erst beim Start). `test/no-secrets.sh`
  entpackt `filesystem.squashfs` und sucht nach privaten Schlüsseln (`-----BEGIN .*PRIVATE
  KEY-----`), `rset_`, `RC-`-Codes, `restow-`-URLs und `ssh_host_*_key`; der Job scheitert bei
  einem Fund. Instanzspezifische ISOs gibt es nicht: Sie brächen die eine Signatur.

### 8.3 Reproduzierbarer Bau

- `build.sh` läuft in `debian:trixie@sha256:<digest>` (Digest in `snapshot.env`) mit
  `--privileged` (live-build braucht `chroot` und `mount`), Spiegel
  `http://snapshot.debian.org/archive/debian/<SNAPSHOT_TIMESTAMP>/` (und `debian-security`),
  `SOURCE_DATE_EPOCH` = Zeitpunkt des Snapshots, fester Hostname, Zeitzone UTC, `umask 022`,
  Locale `C.UTF-8`, `--apt-recommends false`, keine `apt-get update`-Zeitstempel im Abbild
  (Hook entfernt `/var/lib/apt/lists`, `/var/cache`, `/var/log/*`, Maschinen-ID leer,
  SSH-Hostschlüssel werden erst beim Start erzeugt).
- **Lieferkette:** Die Signaturen der Paketlisten prüft apt mit dem `debian-archive-keyring`
  des gepinnten Basis-Images (`Check-Valid-Until=false` ist wegen des alten Zeitpunkts nötig
  und nur zusammen mit dem Lockfile erlaubt). `packages.lock` nennt jedes installierte Paket
  mit Version und SHA-256 der `.deb`; ein Hook vergleicht nach dem Installieren
  (`dpkg-query`, `/var/cache/apt/archives/*.deb`) und der Bau scheitert bei jeder
  Abweichung. Änderungen an der Paketmenge sind damit im Diff prüfbar
  (`build.sh --update-lock` erzeugt die Datei neu, nur von Hand). Verboten und per `grep`
  in der CI geprüft: `trusted=yes`, `--allow-unauthenticated`, `AllowInsecureRepositories`.
- Jedes Restow-Release nimmt einen neuen Zeitpunkt (Sicherheitsupdates); `snapshot.env` und
  `packages.lock` werden im Release-Commit gesetzt und sind damit Teil des Tags. Aus dem Tag
  ist das ISO bitgleich nachbaubar.
- CI (`.github/workflows/ci.yml`, neue Jobs `recovery-iso` und `recovery-iso-rebuild`,
  laufen, wenn sich `integrations/recovery/**`, `agent/**` oder `snapshot.env` ändern, sonst
  aus dem Cache): `recovery-iso` baut auf `ubuntu-24.04`, `recovery-iso-rebuild` in einem
  **eigenen Job auf einem anderen Runner-Image** (`ubuntu-22.04`) mit anderer `TZ` und
  `umask`; ein dritter Job vergleicht die SHA-256, bei Abweichung läuft `diffoscope` und der
  Vergleich scheitert. Beide Bau-Jobs haben `permissions: contents: read`, keine Secrets,
  und der `--privileged`-Container bekommt weder `GITHUB_TOKEN` noch andere Umgebung des
  Jobs (`docker run --env-file` mit genau den Bauvariablen). Zusätzlich prüft
  `recovery-iso`: Firmwareliste im Abbild gleich `firmware.list.chroot` (Abschnitt 8.4),
  Programme aus `--list-tools` vorhanden (8.2), keine Auto-Aktivierung (8.2),
  `no-secrets.sh`, `restow-agent version --short` im Abbild gleich der gebauten Version,
  `xorriso -indev ... -report_el_torito` zeigt BIOS- und UEFI-Starteintrag.
- [CI] Ob live-build in der gewählten Version mit diesen Einstellungen bitgleich baut; wenn
  nicht, die Abweichungen beheben (Hooks), bevor M4 als fertig gilt.

### 8.4 Nicht-freie Firmware (feste Liste)

Nur Firmware, ohne die eine verbreitete **kabelgebundene Netzwerkkarte oder ein
Speichercontroller** in Servern und Arbeitsplätzen nicht oder nur eingeschränkt läuft. Keine
WLAN-, Bluetooth-, Grafik- oder Sound-Firmware (kein WLAN im ISO; die Konsole läuft über
`efifb`/`simplefb` bzw. VGA-Text). **Weil es keine GPU-Firmware gibt, lädt das ISO auch keine
GPU-Treiber, die sie bräuchten:** `amdgpu`, `radeon`, `nouveau` und `xe` würden `efifb`
verdrängen und ohne Firmware scheitern, der Bildschirm bliebe schwarz (Abschnitt 8.6;
Begründung auch in `firmware.md`). Kein CPU-Microcode (für die Wiederherstellung nicht nötig,
hält das Abbild klein). Pakete aus Debians `non-free-firmware`; Debian liefert sie seit 12 in
den eigenen Installations- und Live-Medien aus.

| Paket | Wofür | Lizenz (aus `/usr/share/doc/<paket>/copyright`) |
| --- | --- | --- |
| `firmware-bnx2` | Broadcom NetXtreme II 1 GbE (`bnx2`: BCM5706/5708/5709/5716), in vielen Dell-, HP- und Lenovo-Servern | Broadcom, Weitergabe in unveränderter Form erlaubt, nicht frei |
| `firmware-bnx2x` | Broadcom/QLogic NetXtreme II 10 GbE (`bnx2x`: BCM57710/57711/57712/578xx) | wie oben |
| `firmware-qlogic` | QLogic `qed`/`qede` (25/40/100 GbE), `qla2xxx` (FC-HBAs, damit Platten an einem FC-HBA sichtbar sind; SAN-LUNs sind Zielgeräte nur auf ausdrückliche Freigabe, Abschnitt 10.6) | QLogic/Marvell, Weitergabe erlaubt, nicht frei |
| `firmware-realtek` | Realtek `r8169` (`rtl_nic/*`: RTL8125/8126/8168/8111-Varianten in Arbeitsplätzen und kleinen Servern) | Realtek, Weitergabe erlaubt, nicht frei |
| `firmware-misc-nonfree` | `tg3` (`tigon/*`, ältere Broadcom-Karten), weitere Netz- und Controller-Firmware | je Datei verschieden, alle zur Weitergabe freigegeben |
| Intel `ice`-DDP-Paket (`intel/ice/ddp/ice.pkg`, Intel E810) | ohne DDP startet `ice` nur im eingeschränkten "Safe Mode" | Intel, Weitergabe erlaubt, nicht frei; **Paketname in trixie bei der Umsetzung festlegen** (Debian hat `firmware-nonfree` in trixie in kleinere Pakete aufgeteilt) |

Nicht nötig (Treiber ohne nachzuladende Firmware): Intel `e1000e`, `igb`, `igc`, `ixgbe`,
`i40e`, Mellanox `mlx4`/`mlx5`, Broadcom `bnxt_en`, Aquantia `atlantic`, `virtio_net`,
`vmxnet3`, `hv_netvsc`; Speicher `ahci`, `nvme`, `vmd`, `megaraid_sas`, `mpt3sas`, `mpi3mr`,
`smartpqi`, `aacraid`, `hpsa`, `virtio_blk`/`virtio_scsi`, `vmw_pvscsi`, `hv_storvsc`.

Lizenzhinweise: `build.sh` erzeugt `/usr/share/doc/restow-recovery/FIRMWARE-LICENSES.txt` aus
den `copyright`-Dateien dieser Pakete und legt dieselbe Datei als Release-Anhang ab; die
Paketliste prüft der CI-Job gegen das Abbild (8.3). Eine Änderung der Liste ist eine Änderung
von `firmware.md` mit Begründung im CHANGELOG.

### 8.5 Signatur und Verteilung

- Release-Job `recovery-iso` (neu in `release.yml`) nach `agent` und vor `agent-sums`: baut
  das ISO aus dem eben gebauten `linux-amd64`-Agenten; ein zweiter Job
  `recovery-iso-rebuild` baut es auf einem anderen Runner-Image nach (wie 8.3). Beide laden
  `restow-recovery_<v>_amd64.iso` als Artefakt hoch, der erste zusätzlich
  `restow-recovery_<v>_FIRMWARE-LICENSES.txt` und das Quellbündel (8.7). `agent-sums` nimmt
  die Zeile `<sha256>  recovery/restow-recovery_<v>_amd64.iso` nur auf, wenn beide SHA-256
  gleich sind. Damit deckt die eine Signatur des Maintainers (`sign-agent.sh`, Namensraum
  `restow-agent-release`) auch das ISO.
- **Nachbau beim Maintainer vor dem Signieren** (Freigabe-Gate, Abschnitt 21.4 Punkt 20):
  `scripts/release/sign-agent.sh --iso <lokal gebautes ISO>` baut bzw. nimmt das lokal aus
  dem Tag gebaute ISO, vergleicht dessen SHA-256 mit der ISO-Zeile in `agent-SHA256SUMS` und
  **verweigert** die Signatur bei Abweichung. Ein kompromittierter Runner, der zweimal
  dasselbe manipulierte ISO erzeugt, fällt so spätestens hier auf.
- Prüfen: `scripts/release/verify-agent-signature.sh agent-SHA256SUMS agent-SHA256SUMS.sig
  release-signing.pub` und danach `sha256sum -c --ignore-missing agent-SHA256SUMS`, mit
  `release-signing.pub` **aus dem Git-Tag** (`agent/release-signing.pub` auf GitHub), nicht
  von der Instanz. `publish` hängt das ISO an das GitHub-Release.
- Vorher zu prüfen: dass `release.ParseSums` (`agent/internal/release/sums.go`), `linux.sh`,
  `macos.sh` und `windows.ps1` eine Zeile mit `/` im Namen übergehen bzw. annehmen; ein Test
  je Leser.
- Das ISO liegt **nicht** im Image (Größe). Die Instanz nennt es: `GET /api/v1/recovery-iso`
  gibt Version, URL des GitHub-Release-Anhangs, SHA-256 (aus dem signierten
  `SHA256SUMS` des Images, `/srv/agent/<v>/SHA256SUMS`), den Fingerabdruck des
  Release-Schlüssels, die Prüfbefehle und `verified: true|false` (ob die Instanz ein ISO
  dieser Version in `RESTOW_RECOVERY_ISO_DIR` gegen die Signatur geprüft hat bzw. die
  GitHub-URL samt Prüfsumme kennt). Die Oberfläche sagt dazu: "Vergleichen Sie den
  Fingerabdruck des Release-Schlüssels **außerhalb** dieser Instanz (README und
  Release-Notes auf GitHub, docs/AGENT.md); eine kompromittierte Instanz könnte ISO, Prüfsumme
  und Fingerabdruck zugleich fälschen."
- Für Installationen ohne Internet: Liegt das ISO in `RESTOW_RECOVERY_ISO_DIR` (Volume),
  liefert `GET /install/recovery/:version/:file` es aus, nachdem der Server die SHA-256 gegen
  das signierte `SHA256SUMS` geprüft hat. `:file` muss **wörtlich** einer Zeile in
  `SHA256SUMS` entsprechen (nach dem Präfix `recovery/`, ohne weiteren Pfadanteil, keine
  `..`, kein `/`), `:version` ist eine gültige SemVer-Version; eigene Ratenbegrenzung
  (`RECOVERY_ISO_DOWNLOAD_LIMIT`, 10 je Stunde und Adresse).
- Kompatibilität: Das ISO einer Version spricht `/agent/v1/recovery` (versioniert); der
  Server nennt in der Antwort auf den Code-Tausch `minRecoveryVersion` und lehnt ein zu altes
  ISO mit klarer Meldung ab. Ein neueres ISO mit älterem Server geht, solange das
  Manifestformat bekannt ist.

### 8.6 Start und Secure Boot

- Hybrid-ISO (`iso-hybrid`): auf USB-Stick mit `dd`, Rufus (Modus "DD-Image"), balenaEtcher,
  über BMC/iDRAC/iLO als virtuelles Medium, in VMs als CD. Ventoy: nicht unterstützt
  (verändert die Startkette).
- UEFI mit Secure Boot: shim (Microsoft-signiert) -> GRUB (Debian-signiert) -> Kernel
  (Debian-signiert), Module signiert; der Kernel läuft im Lockdown "integrity". Nichts in
  `recover` braucht unsignierte Module, `kexec` oder `/dev/mem`. **Secure Boot schützt die
  Startkette bis zum Kernel, nicht das Live-Dateisystem:** Debians Kette prüft weder
  `grub.cfg` noch `filesystem.squashfs`, also weder `recover` noch `restic`. Die Echtheit des
  ISO beweist allein die Prüfung von `agent-SHA256SUMS.sig` vor dem Schreiben auf den Stick
  (8.5). Gegen Beschädigung gibt es den Menüpunkt "Medium prüfen" (live-boot
  `verify-checksums`), nicht gegen Manipulation.
- Die shim des ISO (trixie) kann beim Start die SBAT-Sperrstufe der Firmware (`SbatLevel`)
  anheben; ältere shim/GRUB einer Sicherung werden danach abgelehnt. `recover` liest darum
  den Stand **nach** dem Start des ISO aus und prüft die gesicherte Startkette dagegen, bevor
  es etwas löscht (Abschnitt 10.5).
- UEFI ohne Secure Boot und Legacy-BIOS (isolinux bzw. GRUB `i386-pc`) starten dasselbe.
- GRUB-Konfiguration des ISO: `serial --unit=0 --speed=115200` bzw. `--unit=1`,
  `terminal_input console serial`, `terminal_output gfxterm serial`, damit das Menü auch auf
  einer SOL-Konsole erscheint.
- Menü: "Restow Recovery", "Restow Recovery (serielle Konsole ttyS0, 115200)",
  "Restow Recovery (serielle Konsole ttyS1, 115200)" (iDRAC, iLO-VSP und Supermicro-SOL
  liegen meist auf COM2), "Restow Recovery (einfacher Grafikmodus, nomodeset)",
  "Restow Recovery (mit Grafiktreibern)", "Medium prüfen", Untermenü "Erweitert" mit
  "Antworten von Medium lesen (unbeaufsichtigt)" (`restow.answers=media`, Abschnitt 10.20);
  je mit Tastaturbelegung `de`, `us`, `ch`, `at`, `fr` als Untermenü (Kernel-Parameter
  `restow.keymap=de`), Standard nach 10 Sekunden: Restow Recovery, `us`. Die
  Standard-Kommandozeile enthält `modprobe.blacklist=amdgpu,radeon,nouveau,xe` und die
  Parameter aus 8.2 gegen Auto-Aktivierung; "mit Grafiktreibern" lässt die Sperrliste weg.
  `recover` fragt die Belegung zu Beginn noch einmal und setzt sie mit `loadkeys`.
- Der Startmodus des ISO ist der Modus, den `recover` für das Ziel annimmt (Abschnitt 10.5):
  Ein im BIOS-Modus gesichertes System verlangt einen BIOS-/CSM-Start des ISO.

### 8.7 Quellcode der GPL-Pakete

Wer das ISO weitergibt, muss den Quellcode der GPL-Pakete darin anbieten. `sources.sh` lädt
für jedes Paket im Abbild das Quellpaket genau dieser Version vom selben
`snapshot.debian.org`-Zeitpunkt (`apt-get source --download-only`) und packt
`restow-recovery_<v>_sources.tar` (aufgeteilt in Teile unter 2 GiB, Grenze der
GitHub-Anhänge), dazu `restow-recovery_<v>_sources.txt` (Liste Paket, Version, URL). Beides
wird Release-Anhang. Ob das Bündel genügt oder zusätzlich ein schriftliches Angebot ins ISO
gehört, ist Offene Frage 1.

## 9. Wiederherstellungscode und Recovery-Sitzung

### 9.1 Format und Bindung an die Instanz

- 25 Zeichen aus dem Alphabet `0123456789ABCDEFGHJKMNPQRSTVWX` (30 Zeichen: Ziffern 0 bis 9
  und die Buchstaben A bis X ohne I, L, O, U), gleichverteilt aus
  `crypto.randomInt` (Zurückweisung, kein Modulo-Fehler), angezeigt als
  `RC-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX`. 25 · log2(30) = 122,7 Bit. Kein Y und kein Z
  (vertauscht auf deutscher Tastatur), keine Zeichen, die sich mit `O`/`0` oder `I`/`1`
  verwechseln lassen. Eingabe ohne Rücksicht auf Groß-/Kleinschreibung, Bindestriche und
  Leerzeichen werden ignoriert, `O` gilt als `0`, `I` und `L` als `1`
  (`normalizeRecoveryCode`).
- **Bindung an die Origin:** Der Code ist ein Bearer-Wert, und `recover` sendet ihn an die
  Adresse, die der Bediener eintippt. Damit ein Tippfehler oder eine Phishing-Domain mit
  gültigem Zertifikat ("restow-firma.de" statt "restow.firma.de") nichts erhält, verlässt
  der Code das ISO nie im Klartext. `recover` sendet
  `codeProof = SHA-256("restow-recovery-code:" || canonicalOrigin(o) || ":" || normalisierterCode)`
  (hex), mit `o` = der Origin, zu der es **tatsächlich** verbindet. Der Server speichert
  `code_hash = SHA-256(codeProof)` und die Origin beim Ausstellen (`instance_origin`). Eine
  fremde Origin bekommt einen Wert, der an der echten Instanz nichts öffnet (anderer
  Origin-Anteil, nicht umkehrbar); wer die Datenbank liest, hat nur den Hash des Beweises
  und kann damit nichts einlösen.
- `canonicalOrigin`: Schema `https` (bzw. `http` nur im Labor), Hostname klein und als
  Punycode (IDNA, `URL`-Parser in TS, `net/url` plus eigene Punycode-Kodierung in Go, kein
  Modul), Standardport entfernt, kein Pfad, kein abschließender Punkt. Testvektoren in TS
  (`packages/core/src/endpoints/baremetal/recovery-code.test.ts`) und Go
  (`agent/internal/recovery/code_test.go`), dieselbe Datei
  `packages/core/src/endpoints/baremetal/testdata/recovery-code-vectors.json` (Umlaut-Domain,
  Port 443 und 8443, Großschreibung, IPv6-Literal).
- Fehlermeldung bei falscher Adresse ist dieselbe wie bei falschem Code
  (`recovery-code-invalid`) mit dem Zusatz in `recover`: "Adresse genau wie im Code-Dialog
  eingeben: restow.firma.de".
- Geschwärzt werden in jedem Log (`packages/core/src/endpoints/run-redact.ts` und
  `agent/internal/redact`): `RC-…`-Codes, `rset_…`-Tokens, 64-stellige Hex-Werte nach
  `session`, `codeProof`, `secret` oder `password`.
- Code: `packages/core/src/endpoints/baremetal/recovery-code.ts` (`generateRecoveryCode`,
  `normalizeRecoveryCode`, `canonicalOrigin`, `recoveryCodeProof`, `hashRecoveryCodeProof`),
  gleiche Funktionen in Go (`agent/internal/recovery/code.go`).

### 9.2 Ausstellen

`POST /api/v1/endpoints/:id/recovery-codes` mit `{ snapshotId?, validityHours?,
requireApproval? }`, nur Mandanten-Admins, frische Anmeldung (`assertRecentSignIn`, wie das
Repository-Passwort), Audit `endpoint.recovery_code.created` (Ersteller, Gültigkeit,
Snapshot, `requireApproval`, nie der Code). `validityHours` 1 bis 48, Standard 4.
`requireApproval` Standard `true`; `false` nur ausdrücklich (nötig für unbeaufsichtigte
Läufe mit `--answers`), im Audit vermerkt.

- `instance_origin` = `canonicalOrigin(instanceUrl(c).url)`. Ist keine öffentliche Adresse
  konfiguriert (`configured: false`, die Origin der Anfrage), zeigt der Dialog die Warnung
  "Diese Adresse kommt aus Ihrem Browser; das ISO muss genau sie erreichen" und lässt das
  Ausstellen zu.
- **Prüfwert der Instanz:** `issueRecoveryCode` baut eine TLS-Verbindung zur eigenen
  `instance_origin` auf (`tls.connect` mit SNI, Zeitlimit 5 s, `rejectUnauthorized: false`,
  nur um das Zertifikat zu lesen) und speichert `spki_sha256 =
  SHA-256(getPeerCertificate().pubkey)` (DER der SubjectPublicKeyInfo). Gelingt die
  Verbindung nicht (Hairpin-NAT, geteiltes DNS) oder ist `RESTOW_PUBLIC_TLS_SPKI` gesetzt (für
  Installationen hinter einem Load-Balancer mit anderem Zertifikat), gilt der gesetzte Wert
  bzw. keiner. Ohne Prüfwert sagt der Dialog: "Prüfwert nicht ermittelbar; das ISO braucht
  dann ein Zertifikat, dem es vertraut (öffentliche CA oder CA-Datei)."
- Antwort einmalig `{ id, code, expiresAt, instanceOrigin, spkiCheck, snapshotId,
  requireApproval, iso: { version, url, sha256, verified } }`; `spkiCheck` ist der Prüfwert
  in Gruppen (`XXXX-XXXX-XXXX-XXXX`, Base32 der ersten 80 Bit) oder `null`.
- Bedingungen (sonst 409 mit eigenem Problemtyp `baremetal-not-available` und Grund):
  Rechner Linux (Art `code`; für darwin gibt es statt des Codes die Migrationssitzung, Art
  `migration`, Abschnitt 13.6) und nicht entfernt (gesperrt ist erlaubt: ein gesperrter
  Rechner ist oft genau der kaputte), mindestens ein Snapshot mit Manifest und Urteil nicht `unsupported`,
  ein geprüftes ISO bekannt (`GET /api/v1/recovery-iso` meldet `verified`; bis M4 ist darum
  der ganze Dialog ausgeblendet, Abschnitt 22). Höchstens drei offene Codes je Rechner
  (`recovery-limit-reached`).
- Ein offener Code lässt sich widerrufen (`POST .../recovery-codes/:codeId/revoke`, Audit
  `endpoint.recovery_code.revoked`) und verlängern (`POST .../extend` mit `validityHours`,
  frische Anmeldung, Audit `endpoint.recovery_code.extended`), höchstens bis 48 Stunden nach
  dem Ausstellen (CHECK in der Datenbank, Abschnitt 14.2), damit eine lange
  Wiederherstellung nicht mitten im Lesen endet. Eine Sitzung läuft immer genau bis
  `expires_at` des Codes; Verlängern verlängert beide.

### 9.3 Eintauschen

`POST /agent/v1/recovery/sessions` (ohne Basic-Auth) mit `{ codeProof, sessionSecretSha256,
recoveryVersion, hardware: { firmware: "uefi"|"bios", secureBoot, ramBytes, disks: [{
sizeBytes, logicalSectorSize, model, serial, wwn, transport }], nics: [{ mac, driver, link }]
} }`:

- Body höchstens 64 KiB, geprüft **vor** dem Parsen (Hono `bodyLimit`); `disks` und `nics`
  je höchstens 64 Einträge; alle Zeichenketten ohne Steuerzeichen (4.2).
- `recover` erzeugt das Sitzungsgeheimnis selbst (32 Byte) und schickt nur dessen SHA-256.
  Das Geheimnis geht nie über die Leitung zurück.
- Prüfung atomar wie beim Enrollment-Token (`UPDATE ... SET used_at = now(),
  session_secret_hash = $2, status = ... WHERE code_hash = SHA-256($codeProof) AND used_at IS
  NULL AND revoked_at IS NULL AND expires_at > now()`). Der Vergleich läuft über den
  eindeutigen Index; jeder weitere Vergleich von Hashes (Sitzungsgeheimnis) mit
  `crypto.timingSafeEqual`.
- **Idempotenz** (verlorene Antwort): Ein erneuter Aufruf mit demselben `codeProof` und
  demselben `sessionSecretSha256` liefert dieselbe Sitzung, aber nur solange ihr Status
  `pending_approval` oder `active` ist, höchstens 15 Minuten nach `used_at` und nie nach
  `release`. Ein anderer Hash für einen eingelösten Code ergibt 409 `recovery-code-used`.
  Damit ist der Code genau einmal einlösbar, ohne dass ein Netzfehler ihn verbraucht.
- Fehler je Fall mit eigenem Problemtyp: `recovery-code-invalid` (401),
  `recovery-code-expired`, `recovery-code-revoked`, `recovery-code-used`, `recovery-too-old`
  (`minRecoveryVersion`). Wer den Beweis kennt, darf wissen, warum er nicht geht.
- **Fehlversuche** zählen gegen die Adresse in einem eigenen Zähler
  `recoveryFailures = new FailureTracker(20)` (neu in `recovery-service.ts`, wie
  `enrollFailures`), nicht in `authFailures`: Fehlversuche am öffentlichen Tausch sollen
  weder Agenten noch PVE-Knoten hinter demselben NAT sperren, und Agentfehler sollen die
  Versuche des Bedieners nicht verbrauchen. Zusätzlich zählt ein instanzweiter Zähler; mehr
  als 500 Fehlversuche je 10 Minuten schreiben eine Warnung ins Server-Log, die Metrik
  `restow_recovery_exchange_failures_total{reason}` zählt immer.
- **Spur beim Mandanten:** Passt der Hash zu einem abgelaufenen, eingelösten oder
  widerrufenen Code, schreibt der Server `endpoint.recovery_code.rejected` (Adresse, Grund,
  ISO-Version) ins Audit des Mandanten und löst den gleichnamigen Alarm aus (12.6): Das ist
  das Zeichen eines Diebstahls.
- Antwort **202** ohne Geheimnisse: `{ sessionId, status: "pending_approval" | "active",
  matchCode, expiresAt, endpoint: { id, hostname, displayName, os } }`. `matchCode` sind
  sechs Ziffern aus `SHA-256("restow-recovery-match:" || sessionSecretSha256)` (die ersten
  vier Byte als Zahl modulo 10^6); `recover` berechnet sie aus seinem eigenen Geheimnis und
  zeigt sie an, die Oberfläche zeigt sie aus dem gespeicherten Hash. Audit
  `endpoint.recovery.started` (Adresse, ISO-Version, Hardware-Zusammenfassung) und Alarm
  (12.6, Mail und Webhook an die Mandanten-Admins).

### 9.4 Freigabe

Wer den Code zuerst einlöst (Foto des Ausdrucks, Chat, Ticket), bekäme ohne Freigabe
Repository-Passwort und Lesezugang, und der echte Bediener sähe nur `recovery-code-used`. Der
Admin sitzt ohnehin im Assistenten ("Warte auf das ISO"); er gibt die Sitzung darum frei:

- Status nach dem Tausch `pending_approval` (bei `requireApproval: false` sofort `active`).
  `recover` zeigt: "Warte auf Freigabe in Restow. Prüfzahl: 418 207".
- Die Oberfläche zeigt die Prüfzahl, die Adresse, ISO-Version und die gefundene Hardware
  (Platten mit Modell und Größe, Netzwerkkarten) mit den Knöpfen "Freigeben" und
  "Ablehnen".
- `POST /api/v1/endpoints/:id/recoveries/:recoveryId/approve`: Admin, `assertRecentSignIn`,
  Audit `endpoint.recovery.approved`; Status `active`. "Ablehnen" ist
  `POST .../cancel` (Status `cancelled`, Audit `endpoint.recovery.cancelled`); der Code ist
  verbraucht, der Admin stellt bei Bedarf einen neuen aus.
- Ohne Freigabe nach 30 Minuten: Status `failed` ("nicht freigegeben"), Monitor.
- `recover` fragt `GET /agent/v1/recovery/sessions/current` alle 5 Sekunden ab.

### 9.5 Zugangsdaten

`GET /agent/v1/recovery/sessions/current/credentials` (Basic `<sessionId>:<sessionSecret>`),
nur bei Status `active`: `{ repository: { url: "rest:https://<instanz>/agent/recovery/restic/<sessionId>/",
password }, snapshotId, layoutSha256, snapshots: [{ id, time, layoutSha256, check }],
indexBytes, restoreSizes, minRecoveryVersion }` mit `cache-control: no-store`. Das
Repository-Passwort geht an das ISO (restic entschlüsselt dort); das ist dasselbe Vertrauen
wie beim Anzeigen des Passworts und wird ebenso auditiert
(`endpoint.recovery.credentials_issued`). Abholung einmalig; geht die Antwort verloren, gibt
es bis 5 Minuten nach der ersten Abholung eine zweite (auditiert), nie nach `release`.
`restoreSizes` sind die in Stufe 1 berechneten Restore-Größen je Einhängepunkt des gewählten
Snapshots, falls vorhanden (Abschnitt 10.9).

Beim Freigeben (bzw. beim Tausch, wenn keine Freigabe verlangt ist) nimmt der Server kurz
die geteilte Wartungssperre des Repositorys (`repository-lock.ts`), damit kein Prune gerade
läuft; siehe 9.7.

### 9.6 Lesezugang (`reader`)

- Neue Route `/agent/recovery/restic/:sessionId/*` (`apps/api/src/features/endpoints/recovery-restic-route.ts`)
  mit `buildRunResticRoute` (`apps/api/src/lib/restic-run-route.ts`): Basic
  `<sessionId>:<sessionSecret>`. `resolve` verlangt `credentials.runId === repoId` (der
  Basic-Benutzer ist die Sitzung im Pfad), prüft den Hash mit `timingSafeEqual`, Zustand
  `active`, `expiresAt`, Mandant aktiv, Rechner nicht entfernt, und liefert `{ principal:
  "reader", prefix: endpointPrefix(endpointId) }` (bei Art `migration` das Präfix des
  **alten** Rechners, Abschnitt 13.6). Abgelaufen, freigegeben (`release`) oder beendet: 401
  "Credential expired" (`recovery-session-ended`). Verweigerte Zugriffe auditiert
  (`endpoint.repository.denied` mit `principal: "recovery"`, gedrosselt wie heute).
- Zwischenspeicherung des Sitzungszustands höchstens 5 Sekunden; Widerruf, Abbruch und
  `release` wirken also nach höchstens 5 Sekunden (Test "Cancel: 401 nach höchstens 5 s").
- Ratenbegrenzung je Sitzung 120.000 Anfragen je 10 Minuten (eine Wiederherstellung liest
  viele Pack-Bereiche; die 20.000 des Agenten würden große Restores bremsen).
- restic im ISO läuft mit `--no-lock --no-cache`. Der Prinzipal `reader` lässt weder eine
  Sperrdatei noch sonst etwas zu.
- Der Agent-Zugang des Rechners bleibt davon unberührt: Läuft der alte Rechner noch, sichert
  er weiter (nur anhängen); die Wiederherstellung liest den gewählten Snapshot.

### 9.7 Kein Prune während einer Sitzung

Weil `recover` keine Sperre schreibt, schützt der Server den Snapshot selbst:

- `apps/worker/src/endpoints/retention.ts`: Vor der exklusiven Wartungssperre und noch einmal
  danach prüft der Job, ob für den Rechner eine Sitzung `active` oder `finishing` (und nicht
  abgelaufen) ist; dann scheitert er mit `EndpointRepositoryBusyError` (kein Bericht, kein
  Zähler für "gesperrt", pg-boss wiederholt), Lauf-Log "wartet auf eine laufende
  Wiederherstellung". Die doppelte Prüfung zusammen mit der geteilten Sperre beim Freigeben
  (9.5) schließt beide Reihenfolgen aus. `pending_approval` blockiert Prune nicht (sonst
  könnte ein gestohlener Code ohne Freigabe Prune bis zu 48 Stunden aufhalten).
- `endpoint-removal` und `POST /api/v1/endpoints/:id/remove` (Modus `delete`): 409 bzw.
  aufgeschoben, solange eine Sitzung aktiv ist.
- `endpoint-check` liest nur und darf laufen.

### 9.8 Fortschritt, Ende, Ablauf

Mit Basic `<sessionId>:<sessionSecret>`:

| Aufruf | Zweck |
| --- | --- |
| `GET /agent/v1/recovery/sessions/current` | Zustand, `expiresAt`, `cancelRequested` (die Oberfläche hat "Abbrechen" gewählt) |
| `GET /agent/v1/recovery/sessions/current/credentials` | 9.5 |
| `GET /agent/v1/recovery/sessions/current/ssh-keys` | öffentliche SSH-Schlüssel, die der Admin im Assistenten eingefügt hat (Abschnitt 10.2) |
| `POST /agent/v1/recovery/sessions/current/progress` | `{ phase, step, stepsTotal, bytesDone, totalBytes, filesDone, totalFiles, message, sshHostKeys? }`, alle 5 s (wie `runs/:id/progress`) |
| `POST /agent/v1/recovery/sessions/current/log` | bis zu 200 Zeilen je Aufruf, gesamt höchstens 2 MiB, ANSI- und Steuerzeichen vor dem Speichern entfernt, geschwärzt gespeichert (`run-redact.ts`) |
| `POST /agent/v1/recovery/sessions/current/event` | `{ kind: "remote_access_enabled" \| "keyfile_regenerated", detail }` für die Audit-Ereignisse aus dem ISO |
| `POST /agent/v1/recovery/sessions/current/release` | Ende des Repository-Zugangs (Abschnitt 10.13): Zustand `finishing`, restic-Route und `credentials` antworten ab jetzt 401, nur `progress`, `log`, `event`, `finish` bleiben |
| `POST /agent/v1/recovery/sessions/current/finish` | `{ status: succeeded/failed/cancelled, verification, warnings, durationSeconds }`, Zustand endgültig, Audit `endpoint.recovery.finished` |
| `POST /agent/v1/recovery/sessions/current/rebind` | Wiederanbinden im ISO (Abschnitt 10.19), nur nach `finish` mit `succeeded`, höchstens 15 Minuten danach |

Phasen: `connected`, `waiting_approval`, `planning`, `confirmed`, `partitioning`,
`restoring`, `configuring`, `verifying`, `done`. Der Monitor
(`apps/worker/src/endpoints/monitor.ts`) setzt abgelaufene Codes auf `expired`, nicht
freigegebene Sitzungen nach 30 Minuten auf `failed` und Sitzungen ohne Meldung seit
30 Minuten nach `expiresAt` auf `failed` ("ISO meldet sich nicht mehr"), Audit
`endpoint.recovery.expired`. Eine Sitzung kann in der Oberfläche beendet werden
(`POST .../recoveries/:id/cancel`): Die restic-Route antwortet nach höchstens 5 Sekunden 401,
`recover` sieht `cancelRequested` beim nächsten Abruf.

### 9.9 Zustände

| Von | Nach | Auslöser | Audit |
| --- | --- | --- | --- |
| – | `issued` | Ausstellen | `endpoint.recovery_code.created` |
| `issued` | `pending_approval` / `active` | Tausch (mit / ohne Freigabe) | `endpoint.recovery.started` |
| `issued` | `revoked` | Widerruf | `endpoint.recovery_code.revoked` |
| `issued` | `expired` | Monitor | `endpoint.recovery.expired` |
| `pending_approval` | `active` | Freigabe | `endpoint.recovery.approved` |
| `pending_approval` | `cancelled` | Ablehnen | `endpoint.recovery.cancelled` |
| `pending_approval` | `failed` | 30 Minuten ohne Freigabe | `endpoint.recovery.expired` |
| `active` | `finishing` | `release` | `endpoint.recovery.released` |
| `active`, `finishing` | `succeeded`, `failed`, `cancelled` | `finish` | `endpoint.recovery.finished` |
| `active`, `finishing` | `cancelled` | Abbrechen in der Oberfläche | `endpoint.recovery.cancelled` |
| `active`, `finishing` | `failed` | Monitor (keine Meldung) | `endpoint.recovery.expired` |

Ein Postgres-Test (`recovery.pg.test.ts`) geht jeden Übergang durch und verlangt genau einen
Audit-Eintrag je Übergang und keinen ohne Übergang. `extend` ändert den Zustand nicht und
schreibt `endpoint.recovery_code.extended`.

## 10. `restow-agent recover`

### 10.1 Aufbau im Code

- `cmd/restow-agent/recover.go` (`//go:build linux`): Befehl `recover` mit
  `--console <tty>`, `--answers <datei>` (unbeaufsichtigt, Abschnitt 10.20), `--plan-only`,
  `--log <datei>`, `--list-tools` (Programme, die `recover` aufruft, für den CI-Job 8.2).
  Läuft nur als root und nur, wenn `/run/live/medium` oder `--i-know-this-is-not-the-iso`
  gesetzt ist (Schutz davor, es auf einem laufenden Server aufzurufen).
- `cmd/restow-agent/chrootexec.go` (`//go:build linux`): versteckter Helfer
  `restow-agent chroot-exec --spec <fd> -- <programm> <args>` für die Schritte im Zielsystem
  (Abschnitt 10.14).
- `cmd/restow-agent/baremetal.go` (ohne Tag): `baremetal plan --manifest <datei|-> --target
  <same|minimal|other-controller|datei> [--facts <datei>] --json` (reiner Planer, für Stufe 1
  auf dem Server und für Tests; setzt beim Start selbst `RLIMIT_AS` 512 MiB und
  `RLIMIT_CPU` 30 s), `baremetal capture [--raw-dir <ordner>]` (`//go:build linux`, für
  Fehlersuche und zum Aufzeichnen von Testdaten).
- `agent/internal/recovery/` (neu): `session.go` (Client der Recovery-API), `ui.go`
  (zeilenweise Dialoge; jede fremde Zeichenkette über `sanitizeForConsole`, nicht Druckbares
  als `\xNN`), `answers.go`, `network_linux.go`, `clock.go`, `tls.go` (Prüfwert der Instanz),
  `hardware_linux.go` (Zielhardware aus `/sys/block`, `/sys/firmware/efi`, `lsblk`, Lese- und
  Schreibprobe), `identity_linux.go` (Identitätskonflikte und Übernahme, 10.7),
  `holders_linux.go` (Halter freigeben, 10.10), `execute_linux.go` (Ausführung des Plans mit
  Protokoll und Abbruch), `isolate_linux.go` (10.14), `efivars_linux.go` (NVRAM schreiben,
  10.15), `rootfs_linux.go` (Dateizugriffe unter dem Ziel mit `openat2`/`RESOLVE_IN_ROOT`),
  `verify_linux.go`, `rebind.go`, `tools.go` (Tabelle der Programme), `text_de.go`,
  `text_en.go`.
- Planer und Fixups in `agent/internal/baremetal/` ohne Build-Tag: `plan.go`, `sizing.go`,
  `mapping.go`, `drivers.go` (Treiberabgleich, 10.8), `secureboot.go` (Startkette gegen
  `db`/`dbx`/SBAT, 10.5), `mkfs.go`, `fixups.go`, `cmdline.go`.

Bedienung **zeilenweise** (nummerierte Auswahl, Ja/Nein, Eingabe), keine Vollbild-Oberfläche:
Sie läuft gleich auf VGA-Konsole, serieller Konsole (IPMI SOL, iDRAC, iLO) und über SSH,
braucht kein Go-Modul (keine Bibliothek für Terminal-Oberflächen) und ist in der CI über
stdin testbar. Fortschritt als eine Zeile, die sich mit `\r` erneuert (auf seriellen
Konsolen alle 5 s eine neue Zeile).

### 10.2 Start, Tastatur, Konsole, Fernzugang

1. Tastaturbelegung (Vorgabe aus `restow.keymap`), Sprache der Texte `de`/`en` (aus der
   Belegung abgeleitet, änderbar).
2. Menü jederzeit über `?`: Netzwerk, Uhrzeit, Shell (startet `/bin/bash` auf der Konsole;
   `exit` kehrt zurück), Fernzugang, Protokoll anzeigen, Neustart, Ausschalten.
3. **Fernzugang (SSH)**, für Rechenzentren, in denen nur eine langsame BMC-Konsole
   erreichbar ist. Aus beim Start, endet mit dem Neustart.
   - **Vor dem Tausch** nur mit Einmalpasswort für root (zwölf Zeichen aus dem
     Code-Alphabet, rund 59 Bit) und `MaxAuthTries 3`, `MaxStartups 3:50:10`,
     `LoginGraceTime 30`.
   - **Nach dem Tausch** holt `recover` die öffentlichen Schlüssel, die der Admin im
     Assistenten eingefügt hat (`GET .../ssh-keys`), schreibt sie nach
     `/root/.ssh/authorized_keys` und startet `sshd` neu mit `PasswordAuthentication no`,
     `PubkeyAuthentication yes`. Ein schon laufender Passwort-Zugang endet damit.
   - `recover` zeigt Adresse und die Fingerabdrücke der eben erzeugten Hostschlüssel und
     meldet sie per `progress` (`sshHostKeys`); die Oberfläche zeigt sie, damit der Admin
     sie aus der Ferne prüfen kann. Audit `endpoint.recovery.remote_access_enabled` über
     `POST .../event`.
   - Die SSH-Shell ist root im Live-System und sieht Passwort, Sitzung und Passphrase im
     Speicher von `recover`; der Text beim Einschalten sagt das ("Jeder mit Zugang kann die
     Wiederherstellung lesen und steuern").

### 10.3 Netzwerk, Uhrzeit, TLS

- **Netz:** Vorgabe DHCP auf allen kabelgebundenen Schnittstellen mit Link
  (`80-restow-dhcp.network`, systemd-networkd, IPv4 DHCP und IPv6 RA, `UseNTP=yes`).
  DHCP läuft im Hintergrund weiter; die Anzeige je Schnittstelle (Name, MAC, Treiber, Link,
  Adressen) erneuert sich, die Meldung "keine Adresse" kommt erst nach 120 Sekunden (Ports
  mit klassischem STP brauchen 30 bis 50 Sekunden bis Forwarding, 10/25G-Karten wie `bnx2x`
  und `ice` handeln den Link langsam aus). Hat eine Schnittstelle Link, aber keine Adresse,
  sagt `recover`: "Port evtl. als LACP/Trunk konfiguriert; für die Wiederherstellung auf
  einen Access-Port umstellen" (VLAN bleibt nach Entscheidung außen vor). **Statisch:**
  Schnittstelle, Adresse/Präfix, Gateway, DNS-Server (bis zu drei), geschrieben als
  `/run/systemd/network/10-restow-static.network`, `networkctl reload`. **Proxy:**
  `http://host:port` ohne Zugangsdaten (wie der Windows-Agent, docs/WINDOWS-AGENT.md 12.5),
  gilt für die Recovery-API und restic (`HTTPS_PROXY`). Kein VLAN, kein WLAN, kein Bonding
  (Entscheidung, Grenze in der Oberfläche genannt). Fehlt eine Netzwerkkarte, nennt
  `recover` die PCI-Geräte ohne Treiber (`lspci -k`) und den Hinweis auf die Firmwareliste
  und USB-Netzwerkadapter.
- **Uhrzeit:** `systemd-timesyncd` mit NTP aus DHCP und Debians Pool. Scheitert TLS an
  "certificate not yet valid" oder "expired", zeigt `recover` genau das, dazu die Uhrzeit
  aus dem `Date`-Kopf der Antwort als Hinweis, und bietet an, die Uhrzeit **von Hand** zu
  setzen. Die Uhrzeit wird nie automatisch aus einem `Date`-Kopf übernommen (ein Angreifer
  im Netz könnte sonst abgelaufene Zertifikate wieder gültig machen).
- **TLS:** Systemzertifikate (`ca-certificates`). Eigene CA: `recover` fragt nach einer
  PEM-Datei auf einem zweiten USB-Stick (eingehängt nur lesend unter
  `/run/restow-recovery/media`) oder zum Einfügen. Ohne CA, als Rückfall: `recover` zeigt
  SHA-256 des Zertifikats und den SPKI-Wert und verlangt, dass der Bediener die **ersten
  acht Zeichen des Prüfwerts** aus dem Code-Dialog bzw. der Druckseite (`spkiCheck`, 9.2)
  **eintippt**; ein Ja/Nein gibt es nicht. Weicht der SPKI-Wert ab, bricht `recover` ab und
  sendet nichts. Kennt die Instanz keinen Prüfwert, gibt es den Rückfall nicht (nur CA).
  `http://` nur im Labor (Abschnitt 10.20).
- **Adresse der Instanz:** Eingabe des Hostnamens genügt (`https://` wird ergänzt); ein Pfad
  ist nicht erlaubt (wie beim Enrollment: reine Origin). Aus ihr wird `canonicalOrigin` für
  den Code-Beweis (9.1).

### 10.4 Code, Freigabe, Snapshot, Manifest, Plan

1. **Code** eingeben, `codeProof` bilden, eintauschen (9.3). Anzeige: Rechner (Anzeigename,
   Hostname, über `sanitizeForConsole`), Prüfzahl, "Warte auf Freigabe". Nach der Freigabe
   Zugangsdaten holen (9.5); Anzeige: Gültigkeit, Snapshot (Vorauswahl aus dem Code, Liste
   der Bare-Metal-Snapshots mit Datum und Prüfstand, Abschnitt 12).
2. **Manifest** lesen: `restic dump --no-lock --no-cache <snapshot>
   /var/lib/restow-agent/baremetal/layout.json`, SHA-256 gegen `layoutSha256` des Servers
   (Abweichung: Abbruch mit "Manifest im Snapshot und auf dem Server verschieden", Audit
   über `log`). Prüfung `Validate`, Format bekannt.
3. **Fakten aus dem Snapshot** (`baremetal.Facts`, noch mit Lesezugang, vor jeder
   Änderung): für jeden Kernel, dem der Bootloader standardmäßig folgt, und den nächsten
   Rückfall-Kernel `restic dump` von `/lib/modules/<kver>/modules.alias`,
   `modules.builtin` und `modules.builtin.modinfo` (10.8); die MOK-Dateien aus `dkms`
   (10.5); die Restore-Größen je Einhängepunkt, falls der Server keine mitgeschickt hat
   (`restic ls --json --recursive`, 10.9).
4. **Zielhardware** erfassen (10.6), Secure-Boot-Stand der Ziel-Firmware lesen (10.5).
5. **Zuordnung** (10.7) mit Identitätskonflikten und Übernahme, **Treiber** (10.8),
   **Größen** (10.9), Optionen (Passphrase, Schlüsseldateien, Umbenennung der
   Netzwerkschnittstellen, Rückfallpfad der ESP, `raw`-LVs).
6. **Plan** (`baremetal.Plan(m, target, facts, choices) (*RestorePlan, []Problem)`): Liste
   von Schritten mit Art, Ziel, Argumentliste und Begründung. Probleme (kein Ziel groß genug,
   Firmwaremodus passt nicht, Speichertreiber fehlt im gesicherten Kernel, Startkette von der
   Ziel-Firmware gesperrt, Identitätskonflikt, Format eines Dateisystems mit dem ISO nicht
   erzeugbar, Sektorgröße unvereinbar, Multipath, SED-gesperrte Platte) verhindern die
   Ausführung und werden mit Abhilfe genannt. Warnungen (NIC-Treiber fehlt, `raw`-LVs,
   Windows im Dual-Boot, degradierter Erststart) stehen im Plan und im Bericht.
7. Anzeige des Plans als Zusammenfassung ("Platte nvme0n1 (Samsung …, 1,0 TB, WWN …4f2a)
   erhält: GPT, 1 ESP 512 MiB, 2 /boot 1 GiB, 3 LUKS2 -> LVM vg0: root 50 GiB, swap 8 GiB,
   home 875 GiB (gewachsen)"; "Platten sdb, sdc, sdd (RAID5 md1, vg data): übernommen, nichts
   wird gelöscht") und auf Wunsch jeder Befehl (`p`). Alle Namen aus dem Manifest gehen durch
   `sanitizeForConsole`.
8. **Bestätigung:** Für jede Zielplatte, die gelöscht wird und Daten trägt (Signaturen
   gefunden), muss der Bediener die letzten vier Zeichen ihrer **Kennung** eintippen
   (10.6: WWN/EUI-64/NGUID, sonst Seriennummer + Namensraum, sonst `by-path`), angezeigt mit
   Modell und Größe; danach `LÖSCHEN` (bzw. `ERASE`). Unbeaufsichtigt nur mit
   `answers.confirmErase` und genau passenden Kennungen.

### 10.5 Firmwaremodus und Startkette

- Gesichert UEFI, ISO im UEFI-Modus gestartet: ok. Gesichert BIOS, ISO im BIOS-Modus: ok.
  Gesichert BIOS auf GPT mit BIOS-Boot-Partition **und** ESP: beide Modi ok, `recover`
  richtet beide ein.
- Sonst Abbruch vor dem Plan: "Das System wurde im BIOS-Modus gesichert; dieser Rechner hat
  das ISO im UEFI-Modus gestartet. Im Firmware-Setup CSM/Legacy-Start einschalten und das
  ISO im BIOS-Modus starten. Hat die Firmware kein CSM (viele Server und Arbeitsplätze ab
  etwa 2020), lässt sich dieses System in 0.5.0 auf dieser Hardware nicht
  wiederherstellen." (und umgekehrt). Dieselbe Warnung (`bios_needs_csm`) steht schon auf
  der Rechnerseite und in Schritt 2 des Assistenten.
- **BIOS und 4Kn:** BIOS startet nicht von Platten mit 4096 Byte logischer Sektorgröße
  (INT13h). Problem im Plan mit Hinweis: "Platte auf 512-Byte-Format umstellen, z. B.
  `nvme format --lbaf=<512er-Format>` (löscht die Platte) oder eine 512e-Platte nehmen".
- **BIOS und Startplatte:** Bei mehreren Platten bzw. Hardware-RAID entscheidet die
  BIOS-Startreihenfolge bzw. das "Boot VD" des Controllers; `recover` kann sie nicht setzen.
  Der Abschluss nennt genau die Platte (Modell und Kennung), die im BIOS bzw. als
  Controller-Boot-VD gewählt werden muss.
- **Secure Boot** (`baremetal/secureboot.go`, `CheckChain(loaders, kernels, target)`):
  `recover` liest nach dem Start des ISO aus efivarfs des Ziels `SecureBoot`, `SetupMode`,
  `db`, `dbx` und `SbatLevelRT` (der Stand, den die shim des ISO womöglich gerade angehoben
  hat, 8.6) und prüft **vor dem Löschen**, ob die Startkette aus der Sicherung darauf
  startet:
  1. Der Signaturgeber der gesicherten shim (bzw. von systemd-boot/des Kernels ohne shim)
     muss zu einem Zertifikat in `db` passen ("Microsoft Corporation UEFI CA 2011" oder
     "Microsoft UEFI CA 2023" für Dritte). Fehlt es (Secured-core-Geräte von Lenovo, Dell, HP,
     Surface haben die "3rd Party UEFI CA" ab Werk aus; neue shims sind nur mit der CA 2023
     signiert, alte Firmware kennt nur 2011): Problem `secure_boot_ca_missing`.
  2. Weder Authenticode-Hash noch Zertifikat eines Loaders stehen in `dbx`
     (`secure_boot_revoked`).
  3. Jede `.sbat`-Generation von shim und GRUB ist mindestens so hoch wie der Eintrag für
     diese Komponente in `SbatLevelRT` (`secure_boot_sbat_revoked`, typisch eine nicht
     aktualisierte Ubuntu 22.04).
  Bei einem Problem bietet der Plan: "Secure Boot im Firmware-Setup ausschalten und danach
  ohne Secure Boot starten" (Bestätigung durch den Bediener, dann Warnung statt Problem),
  "im Setup die Microsoft 3rd Party UEFI CA erlauben" (Hinweis, danach ISO neu starten).
  shim und GRUB des Zielsystems aus dessen Paketspiegel zu aktualisieren ist in 0.5.0 nicht
  erlaubt (2.2) und steht nur als Hinweis für nach dem Start da.
- Ziel mit Secure Boot, Quelle ohne shim (systemd-boot unsigniert, eigene Kernel): Warnung
  "startet nur mit abgeschaltetem Secure Boot oder eigenen Schlüsseln".
- **MOK:** Die MOK-Liste der Quelle ist im Manifest (`firmware.mok`, 4.1), der Schlüssel liegt
  in der Sicherung (`/var/lib/shim-signed/mok/MOK.der` bei Ubuntu, `/var/lib/dkms/mok.pub`
  bei Debian 12 und neuer). Ist ein Kernel oder ein DKMS-Modul (`dkms`) mit einer MOK signiert,
  die in der `MokListRT` des Ziels fehlt, und ist Secure Boot an, stellt `recover` die MOK
  bereit: `mokutil --import <datei> --hash-file <datei>` mit dem `mokutil` des ISO, der
  Datei über `rootfs_linux.go` aus dem Ziel und einem angezeigten Einmalpasswort (acht
  Ziffern, `mokutil --generate-hash`). Der Abschluss sagt: "Beim ersten Start erscheint der
  MokManager (blauer Bildschirm): Enroll MOK, Continue, Yes, Passwort 4711 0815." Ist der
  Kernel mit einer MOK signiert, deren Datei nicht in der Sicherung liegt: Problem
  `mok_key_missing`. Fehlt nur die Datei für ein DKMS-Modul, das ein Netz- oder
  Speichertreiber ist: Problem; sonst Warnung.
- **Dual-Boot:** `Boot####`-Einträge, deren Loader zu einem nicht wiederhergestellten System
  gehört (`\EFI\Microsoft\…`), werden nicht angelegt; das Urteil trägt `dual_boot_windows`
  ("Windows wird nicht wiederhergestellt").

### 10.6 Zielgeräte erkennen

`hardware_linux.go` listet Blockgeräte und bestimmt je Gerät eine **Kennung** in dieser
Reihenfolge: WWN, EUI-64 oder NGUID (NVMe), sonst Seriennummer plus NVMe-Namensraum-ID (die
Namensräume `nvme0n1`, `nvme0n2` teilen die Seriennummer des Controllers), sonst
`/dev/disk/by-path/...`. Ausgeschlossen bzw. besonders behandelt:

| Gerät | Behandlung |
| --- | --- |
| Startmedium des ISO (`/run/live/medium`) | nie Ziel |
| versteckte NVMe-Multipath-Knoten `nvme*c*n*` | übergangen |
| `mmcblk*boot*`, `*rpmb` | übergangen |
| `zoned != none` (Host-managed SMR, ZNS), `ro=1`, Größe 0 | übergangen, im Plan genannt |
| Transport `fc`, `iscsi` (SAN-LUNs, auch anderer Server) | Ziel nur auf ausdrückliche Freigabe je Gerät ("SAN-LUN erlauben"), nie in der automatischen Zuordnung |
| zwei Knoten mit derselben WWN (`sdc` und `sdk`) | Problem "Multipath erkannt; nur einen Pfad anschließen oder Multipath im Speicher abschalten" |
| Wechseldatenträger | Ziel nur auf ausdrückliche Auswahl |
| Hardware-RAID-VD (PERC, Smart Array) | Kennung aus WWN bzw. `by-path`; der Assistent hat dafür den Schritt "VD im Controller anlegen, Mindestgröße X GiB" |
| virtio ohne Seriennummer | Kennung `by-path` |

Vor dem Plan liest und schreibt `recover` je möglicher Zielplatte das erste und letzte MiB
(Lesen, dann denselben Inhalt mit `O_DIRECT` zurückschreiben; bei Platten mit Daten nur
lesen und erst nach der Bestätigung schreiben). Ein I/O-Fehler ergibt das Problem "Platte
liefert I/O-Fehler; evtl. ist eine selbstverschlüsselnde SSD (TCG Opal) gesperrt: entsperren
oder mit PSID-Revert zurücksetzen". Findet `recover` gar keine Platte, sagt es: "Keine Platte
gefunden. Steht der SATA-Modus im Firmware-Setup auf RAID/Intel RST/VMD, auf AHCI stellen."

### 10.7 Zuordnung, Übernahme vorhandener Teile, Identitätskonflikte

**Übernahme.** Der häufigste echte Fall ist "System-SSD tot, das RAID mit den Daten lebt".
Je Quellplatte bzw. je Array, VG, LUKS-Volume und Dateisystem bietet die Zuordnung die Wahl
"vorhanden übernehmen", wenn am Ziel genau diese Identität intakt existiert:

- md: `mdadm --examine` der Kandidaten zeigt dieselbe Array-UUID, und genug Mitglieder für
  einen lauffähigen Verbund sind da;
- VG: `pvs --devices <kandidaten> -o pv_uuid,vg_name,vg_uuid` zeigt alle PV-UUIDs der VG;
- LUKS: `blkid -p` zeigt dieselbe LUKS-UUID;
- Dateisystem: `blkid -p` zeigt dieselbe UUID und denselben Typ.

`recover` setzt einen übernommenen Teil zusammen bzw. öffnet ihn (`mdadm --assemble --uuid`,
`vgchange -ay --devices …`, LUKS mit der **alten** Passphrase, die der Bediener eingibt;
`cryptsetup open --test-passphrase` vorher), löscht nichts darauf und nimmt seine
Einhängepunkte aus dem `restic restore` aus (`--exclude` je Einhängepunkt; auf Wunsch
"übernommene Dateisysteme mit der Sicherung abgleichen" mit `--overwrite if-changed` nur für
diese Pfade, Vorgabe aus). Der Plan zeigt übernommene Teile grün ("bleibt, wird nicht
gelöscht"). **Automatisch** ordnet `recover` nie eine Platte zum Löschen zu, die Signaturen
trägt, die zum Manifest passen; die Vorgabe ist dann "übernehmen".

**Automatische Zuordnung** nur, wenn die Zahl der Zielplatten gleich der Zahl der
Quellplatten ist, jede Zuordnung passt und keine Zielplatte Signaturen des Manifests trägt:
zuerst gleiche Kennung (gleiche Hardware), dann gleiche Größe und Transport, dann nach Größe
absteigend gegen den Mindestbedarf absteigend; nie SAN-LUNs (10.6). Sonst fragt `recover` je
Quellplatte ("d0 war nvme0n1, 512 GB, trug /, /boot, ESP; Mindestgröße 61 GiB"), Auswahl aus
den freien Zielplatten, "vorhanden übernehmen" oder "fehlt".

**Weniger Zielplatten als Quellplatten** nur, wenn jede fehlende Platte

- Mitglied von md-Arrays ist, die ohne sie laufen (RAID 1 und 10 mit verbleibender Kopie,
  RAID 5 mit einer, RAID 6 mit bis zu zwei fehlenden), und
- ihre übrigen Partitionen nur **redundante Startpartitionen** sind: BIOS-Boot-Partition,
  eine weitere ESP, die nicht in `fstab` steht oder `nofail` trägt (Ubuntu mit mehreren ESPs
  über `grub-efi/install_devices`, `proxmox-boot-tool`, eine Kopie je Platte).

Die Arrays entstehen dann **degradiert** (`missing` in `mdadm --create`), Stapel und
Konfiguration bleiben gleich, eine Platte lässt sich später mit `mdadm --add` ergänzen. Der
Plan sagt das deutlich, dazu für Ubuntu (`BOOT_DEGRADED`) und dracut (`rd.retry`-Zeitlimit):
"Der erste Start mit degradiertem RAID kann verzögert sein oder nachfragen." Die Fixups für
`grub-efi/install_devices` und die `uuids` von `proxmox-boot-tool` nehmen die fehlende ESP
heraus (10.13). LVM-`raid`-LVs ohne alle PVs: Problem (LVM legt sie nicht degradiert an).
btrfs-RAID-Profile degradiert anzulegen geht nicht (`mkfs.btrfs` verlangt alle Geräte):
Problem.

**War die Quelle schon degradiert**, legt `recover` das Array mit der vollen
`raid-devices`-Zahl aus dem Manifest an und vervollständigt es mit allen Zielplatten, die der
Bediener zuordnet. Lief zur Sicherungszeit ein Reshape oder `--grow`, ist der Snapshot für
Bare Metal `unsupported` (4.4).

**Identitätskonflikte.** Weil die neuen Platten dieselben UUIDs bekommen (Grundregel 1),
darf keine zweite Kopie am Ziel angeschlossen sein: Die alte Platte steckt noch, eine neue
SSD kam dazu und die defekte blieb, oder Datenplatten bleiben, die nicht übernommen werden.
Sonst gäbe es zwei `vg0`, zwei md-Arrays mit derselben UUID und zwei btrfs mit derselben
fsid; `vgcreate` bricht ab, `mdadm --create` meldet "busy", btrfs nimmt ein Gerät des alten
Dateisystems, XFS lehnt das Einhängen ab, und nach dem Neustart wählen Firmware (doppelte
PARTUUID im NVRAM-Eintrag), initramfs und udev zufällig zwischen alt und neu.

- Das ISO aktiviert nichts von selbst (8.2), alle LVM-Befehle in `recover` laufen mit
  `--devices <nur die Zielgeräte und übernommenen Geräte>` (lvm2 2.03.12 und neuer), btrfs
  wird mit `device=`-Optionen eingehängt und nie gescannt.
- Planer-Schritt "Identitätskonflikt" (`identity_linux.go`): `blkid -p` auf allen Geräten,
  die weder Ziel noch übernommen sind. Trägt eines dieselbe FS-, PART-, md-, PV- oder
  LUKS-UUID oder Disk-GUID wie das Manifest, zeigt der Plan eine deutliche Warnung mit Gerät,
  Modell und Kennung und den Wegen "Platte abziehen" oder "mit `wipefs -a` leeren" (auf
  ausdrückliche Wahl führt `recover` das selbst aus, nach Eingabe der Kennung).
- Prüfung 10.17 Punkt 8: Bleibt ein Konflikt bis zum Ende bestehen, bietet `recover` keinen
  Neustart an, sondern sagt: "Platte X (Modell, Kennung) abziehen oder mit wipefs leeren;
  sonst startet das System womöglich von der alten Platte."

### 10.8 Treiberprüfung vor dem Löschen

Ob der Kernel der Sicherung den Speichercontroller und die Netzwerkkarte der Ersatzhardware
kennt, prüft `recover` **vor** dem Löschen. Das ISO hat Kernel 6.12 und sieht die Platten; ein
RHEL-8-Kernel (4.18) oder Ubuntu 22.04 (5.15) hat für neue Hardware oft keinen Treiber
(`mpi3mr` für Broadcom 96xx, neue `smartpqi`-Varianten, RTL8126, i226-Revisionen, E830).

- Für jede Zielplatte, die `/`, `/boot`, `/usr` oder die ESP trägt, ermittelt
  `hardware_linux.go` die Treiberkette von der Platte über den Controller bis zur PCI-Wurzel
  (also auch `vmd`, `nvme`, `ahci`, HBA, `virtio_pci`) mit dem Modalias je Stufe, für jede
  physische Netzwerkkarte den Modalias.
- `baremetal/drivers.go` (`CheckDrivers(facts, target)`) gleicht jeden Modalias mit
  `modules.alias` jedes Kernels ab, dem der Bootloader standardmäßig folgt (und dem
  nächsten Rückfall-Kernel), und berücksichtigt `modules.builtin` (bei Fedora und Arch sind
  `ahci` bzw. `nvme` teils eingebaut) sowie DKMS-Module aus `dkms` (4.1).
- Fehlt ein Treiber der Speicherkette: **Problem**, Ausführung gesperrt ("Der gesicherte
  Kernel 4.18.0-553 kennt den Controller Broadcom 9600 (mpi3mr) nicht; das System würde nicht
  starten. Andere Hardware wählen oder vorher einen neueren Kernel im System installieren und
  neu sichern."). Fehlt ein NIC-Treiber: **Warnung** im Plan ("das System startet ohne Netz
  über diese Karte").

### 10.9 Größen und Sektorgrößen

`baremetal.MinimumDiskSizes(m, facts)` und `sizing.go`; intern wird **in Bytes** gerechnet
und erst beim Schreiben des sfdisk-Skripts in LBA der **Zielplatte** umgerechnet.

- **Mindestgröße eines Dateisystems:** die Restore-Größe je Einhängepunkt (Summe der
  Dateigrößen aus `restic ls --json --recursive <snap> <einhängepunkt>`, ohne die Bäume
  darunterliegender anderer Einhängepunkte, Hardlinks einmal je Inode) · 1,10 plus feste
  Reserve je Typ (ext4: Journal + 2 Prozent Metadaten + reservierte Blöcke; XFS: Log +
  1 Prozent; btrfs: 1 GiB Metadaten je Gerät; vfat: unverändert), mindestens die Größe, die
  `mkfs` des Typs verlangt. Grund: Die belegten Bytes laut `statfs` sind bei btrfs mit
  Kompression (Fedora-Standard `compress=zstd:1`), Reflinks und Deduplizierung (XFS
  `reflink=1`, Podman, `cp --reflink`) und geteilten Extents deutlich kleiner als das, was
  `restic restore` schreibt; ENOSPC mitten im Restore, Stunden nach dem Löschen, wäre der
  schlimmste Fall. Stufe 1 berechnet die Restore-Größen auf dem Server und speichert sie im
  Bericht (12.1), `recover` bekommt sie mit den Zugangsdaten (9.5) und berechnet sie selbst,
  wenn sie fehlen. `-N` (Inodes) ist mindestens `inodesUsed` · 1,2.
- **Thin-Pools:** mindestens die Summe der Restore-Größen seiner LVs · 1,15 plus Metadaten
  (`--poolmetadatasize` aus dem Manifest, mindestens 1 Prozent). Ein voller Pool beim Restore
  legte alle Thin-LVs still. `raw`-LVs zählen nur mit, wenn der Bediener sie leer anlegen
  lässt (10.10).
- Eine ESP, ein `/boot` und Swap behalten ihre Größe (Swap schrumpft auf Wunsch). `/boot`
  darf auf einer größeren Zielplatte wachsen (für den initramfs-Neubau, 10.15). Eine ESP auf
  einer 4Kn-Platte wächst auf mindestens 260 MiB (FAT32 mit 4K-Sektoren), der Platz kommt von
  der `grow`-Partition.
- **Größere Platte:** Partitionen und LVs behalten ihre Größe, die mit `grow` markierte
  Partition wächst bis zum Ende, darin das mit `grow` markierte LV bis zum Ende der VG.
  Thin-Pools wachsen nicht von selbst (der Bediener kann im Plan den Pool statt eines LV
  wählen). Wächst bei MBR die letzte logische Partition, wächst die erweiterte mit.
- **Kleinere Platte:** "Gleich groß" heißt byte-gleich; schon ein Sektor weniger ist
  "kleiner" (Herstellerunterschiede bei 480/500 GB). Die `grow`-Partition bzw. das `grow`-LV
  schrumpft so weit wie nötig, nie unter seine Mindestgröße; reicht das nicht, schlägt der
  Planer vor, welche weiteren LVs schrumpfen (größter Überschuss zuerst), und der Bediener
  bestätigt. XFS kann man nicht verkleinern, muss man hier auch nicht: Jedes Dateisystem wird
  neu angelegt.
- **Ausrichtung:** Starts auf 1 MiB. Partitionsnummern und Reihenfolge bleiben (wichtig für
  `Boot####`-Einträge und Verweise wie `/dev/sda2`). Gleich große Zielplatte gleicher
  Sektorgröße: Start und Größe exakt wie gesichert, **außer** eine Partition beginnt vor
  Sektor 2048 oder nicht auf 1 MiB (alte Systeme mit Start bei 63): Sie wird neu
  ausgerichtet, die PARTUUID bleibt, das Dateisystem wird ohnehin neu angelegt (sonst passt
  GRUBs `core.img` mit lvm+mdraid+cryptodisk nicht hinter den MBR, "embedding is not
  possible").
- **MBR-Grenze:** 2^32 Sektoren der Zielplatte (512er: 2 TiB, 4Kn: 16 TiB). Partitionen
  enden spätestens dort, der Rest bleibt frei, Warnung im Plan. Keine Umwandlung nach GPT.
- **Sektorgrößen:** Je Schicht bestimmt der Planer die wirksame logische Blockgröße (Maximum
  über die Mitglieder eines md-Arrays bzw. die PVs einer VG und die LUKS-`sector_size`) und
  erzwingt daraus: ext2/3/4 `-b` mindestens diese Größe (ein `/boot` mit `-b 1024` wird auf
  4Kn mit `-b 4096` angelegt), XFS `-s size=<blockgröße>`, vfat `-S` **immer** gleich der
  logischen Sektorgröße der Zielplatte (ein vfat mit 4096-Byte-BPB auf einer 512er-Platte
  lesen viele UEFI-Firmwares nicht), LUKS `--sector-size` bleibt, wenn es auf dem Ziel geht,
  sonst die Blockgröße des Ziels. Gemischte Blockgrößen in einer VG oder einem Array
  (512e und 4Kn): Problem, außer alle Dateisysteme darüber sind 4K-fähig; dann
  `--config devices/allow_mixed_block_sizes=1` in `recover` und im Ziel-`lvm.conf` (Fixup).
- Golden Files des Planers: 512 nach 4Kn, 4Kn nach 512, gemischt, Start bei 63, MBR über
  2 TiB, 480 GB nach 500 GB und umgekehrt.

### 10.10 Halter freigeben, Partitionieren, RAID, LUKS, LVM

Reihenfolge je Platte und Schicht:

1. **Halter freigeben** (`holders_linux.go`): Für jede Zielplatte, die gelöscht wird, rekursiv
   alle Halter aus `/sys/block/*/holders` und alle Einhängungen und Swaps darauf: `swapoff`,
   `umount`, `vgchange -an --devices …`, `mdadm --stop`, `cryptsetup close`,
   `dmsetup remove`, IMSM-Container mit `mdmon` beenden. Danach prüfen, dass keine Halter
   mehr da sind; sonst Abbruch mit Liste ("Device or resource busy" käme sonst später, und
   der Kernel behielte die alte Partitionstabelle).
2. **Signaturen entfernen:** `wipefs -a` zuerst auf jeder **vorhandenen** Partition, dann auf
   der Platte, dazu die ersten und letzten 16 MiB nullen (alte md-1.0-Superblöcke am Ende
   alter Partitionen, LVM-Label, GPT-Kopie). `blkdiscard` auf Wunsch (Standard aus, auf SSDs
   angeboten).
3. **Partitionstabelle** mit `sfdisk` aus einem erzeugten Skript (`sfdisk --dump`-Format):
   `label: gpt|dos`, `label-id:` (Disk-GUID bzw. MBR-Kennung, damit PARTUUIDs gleich
   bleiben; bei MBR ist die PARTUUID `<kennung>-<nummer>`), `unit: sectors`,
   `sector-size: <logische Sektorgröße der Zielplatte>`, je Partition `start=`, `size=`,
   `type=`, `uuid=`, `name=`, `attrs=`, `bootable`. **Nie** `first-lba`, `last-lba` oder
   `table-length` aus der Quelle (sonst wächst nichts, und auf einer wenige Sektoren
   kleineren Platte läge `last-lba` hinter dem Ende); `sfdisk` berechnet sie. Danach wartet
   `recover`, bis jede `/dev/disk/by-partuuid/<uuid>` existiert (Zeitlimit 30 s, nicht nur
   `udevadm settle`), liest `sfdisk --dump` zurück und vergleicht mit dem Plan. Bei GPT mit
   gesetztem `pmbrBoot` (manche BIOS von Lenovo, HP, älteren Dell starten GPT nur so) setzt
   `recover` das Aktiv-Flag im Schutz-MBR (Byte 446) wieder, weil `sfdisk` es nicht erhält.
4. **mdadm:** `mdadm --create /dev/md/<name> --run --level=<l> --raid-devices=<n>
   --metadata=<v> --uuid=<uuid> --name=<name> --homehost=<host> [--chunk=<k>]
   [--layout=<l>] [--bitmap=internal] <mitglieder|missing>` mit `--write-mostly` vor den
   Mitgliedern, die es in der Quelle waren. Kein `--assume-clean`: Bei RAID 5/6 machte das
   die Parität falsch, bei RAID 1 bleiben ungeschriebene Bereiche ungleich. Der Resync läuft
   im Hintergrund während der Wiederherstellung (langsamer, aber richtig); `recover` begrenzt
   ihn nicht. Übernommene Arrays: `mdadm --assemble --uuid=<uuid> <kandidaten>`.
5. **LUKS:** Für jedes neue Volume `cryptsetup luksFormat --type luks1|luks2 --uuid <uuid>
   --cipher <c> --key-size <k> --sector-size <s> [--label <l>] [--subsystem <s>]
   --pbkdf <art> [--pbkdf-memory/--iter-time] --batch-mode --key-file - <dev>` mit der
   Passphrase über stdin, dann `cryptsetup open` unter dem **`crypttabName`** (fehlt der
   Eintrag in `crypttab`, unter `mappedName`), damit der Debian-Hook `cryptsetup-initramfs`
   im `chroot` die Wurzel findet (sonst "WARNING: target … not found"), und
   `cryptsetup refresh --persistent --allow-discards|...` mit den Flags aus dem Manifest
   (LUKS2; LUKS1 kennt keine dauerhaften Flags, sie stehen dort in `crypttab`).
   - **Neue Schlüssel:** Jedes neue Volume bekommt einen neuen Hauptschlüssel (die Daten
     kommen dateiweise aus der Sicherung, nicht blockweise). Header-Sicherungen gibt es nicht
     (Entscheidung 25.B1).
   - **Gleiche Parameter:** Version, Cipher, Schlüssellänge, Sektorgröße (10.9), PBKDF-Art,
     Flags. Grund: GRUB entsperrt ein verschlüsseltes `/boot` nur mit LUKS1 oder LUKS2 mit
     PBKDF2; Argon2-Parameter werden auf der neuen Hardware neu gemessen
     (`--iter-time 2000`), höchstens mit dem Speicher, den der kleinere von Quell- und
     Ziel-RAM zulässt.
   - **Wie der Bediener entsperrt, Tastaturbelegung:** `recover` fragt einmal nach der neuen
     Passphrase (zweimal eingeben), Vorgabe "dieselbe für alle Volumes", auf Wunsch je
     Volume. Es kann die alte Passphrase sein; `recover` kennt sie nicht und prüft sie
     nicht. Die Passphrase wird beim Start in der Belegung eingegeben, die **im initramfs**
     gilt, nicht in der des ISO. `recover` lädt für die Eingabe genau diese Belegung
     (`loadkeys` aus `initramfs.keymap`, 4.1) und sagt das an: "Eingabe mit der Belegung,
     die beim Start gilt: us (GRUB entsperrt /boot immer mit us)". Bei GRUB-cryptodisk (E7)
     und bei Systemen, deren initramfs keine Belegung mitnimmt (initramfs-tools ohne
     `KEYMAP=y`, dracut ohne `vconsole.conf` im Abbild, mkinitcpio ohne Hook `keymap` bzw.
     `sd-vconsole`), ist das `us`. Alternativ bietet `recover` an, eine Passphrase aus
     belegungsfesten Zeichen zu erzeugen (Code-Alphabet ohne Y/Z, 6 Gruppen zu 5 Zeichen) und
     anzuzeigen. Der dracut-Aufruf nimmt `/etc/vconsole.conf` ausdrücklich mit (10.15), damit
     ein RHEL- oder Fedora-System, das bisher `de` hatte, auch nach der Wiederherstellung
     mit `de` fragt.
   - **Schlüsseldateien:** Nennt `/etc/crypttab` für ein **neues** Volume eine
     Schlüsseldatei (`luks[].keyFile`, z. B. `/etc/luks-keys/data.key`), erzeugt `recover`
     sie nach dem Restore **neu** (gleicher Pfad, gleicher Modus und Besitzer, 64 Zufallsbytes
     aus `crypto/rand`, Schreiben über `openat2` ins Ziel) und fügt sie als zweiten Keyslot
     hinzu (`cryptsetup luksAddKey <dev> /dev/fd/N` mit der Passphrase über stdin), **vor**
     dem initramfs-Neubau, damit ein initramfs-Hook (`KEYFILE_PATTERN`, dracut
     `install_items`) die neue Datei einbaut. Grund: Jeder mit Leserecht auf die Sicherung
     könnte die alte Datei herunterladen; sie öffnete sonst die alten **und** die neuen
     Platten. Übernahme der alten Datei nur auf ausdrückliche Wahl, mit Hinweis "Wer die
     Sicherung lesen kann, kann damit diese Platten öffnen". Übernommene Volumes (10.7)
     behalten ihre Schlüsseldatei (sie öffnet sie ja). Audit
     `endpoint.recovery.keyfile_regenerated` über `POST .../event`.
   - **TPM2, FIDO2, Clevis:** werden nicht übernommen (an die alte Hardware bzw. den alten
     Hauptschlüssel gebunden). `crypttab`-Optionen wie `tpm2-device=auto` bleiben stehen;
     systemd fällt dann auf die Passphrase zurück. Der Abschluss nennt den Befehl zum neu
     Einrichten (`systemd-cryptenroll --tpm2-device=auto <dev>`, `clevis luks bind ...`).
   - **Plain-dm-crypt** (Swap oder tmp mit Zufallsschlüssel aus `/dev/urandom`): `recover`
     legt nur die Partition an (sie wird bei jedem Start überschrieben). Pflicht-Fixup: Die
     Quelle in `crypttab` wird auf `PARTUUID=` umgeschrieben (bei MBR `<kennung>-<nr>`,
     erhalten), bei einer Platte ohne Tabelle auf `/dev/disk/by-id/wwn-…`. Ohne diesen
     Fixup formatierte der erste Start auf neuer Hardware womöglich ein Datendateisystem, das
     jetzt `/dev/sdb2` heißt, als Swap.
6. **LVM:** alle Aufrufe mit `--devices <zielgeräte>` und, falls nötig,
   `--config devices/allow_mixed_block_sizes=1`. `pvcreate --uuid <pvuuid> --norestorefile
   <dev>` (gleiche PV-UUID), `vgcreate -s <extent> [--systemid <id>] <vg> <pvs>`, je LV
   `lvcreate` mit Typ und Größe aus dem Plan (`-L`, `--type striped -i -I`, `--type raid1 -m`,
   `--type thin-pool --chunksize --poolmetadatasize`, Thin-LVs mit `-V` und `--thinpool`),
   Tags, Aktivierung. Bewusst **nicht** `vgcfgrestore`: Es kann Thin-Pool-Metadaten nicht
   wiederherstellen und passt nicht zu geänderten Größen. Folge: VG- und LV-UUIDs sind neu.
   Verweise darauf (`/dev/disk/by-id/dm-uuid-LVM-…`, `lvm2-pvscan`) kommen in
   Konfigurationen selten vor; `fixups.go` findet und ersetzt sie (10.13). Namen von VG und
   LV bleiben, damit stimmen `/dev/mapper/vg0-root`, `rd.lvm.lv=vg0/root` und
   `root=/dev/vg0/root`. Gerätedatei und Filter des Zielsystems passt 10.15 an.
   - **`raw`-LVs** (weder eingehängt noch Swap noch Träger, 4.1): Auf einem Proxmox-VE-Host
     liegen im Thin-Pool `pve/data` Dutzende `vm-<id>-disk-<n>`, die nicht gesichert sind.
     Der Plan zeigt sie als "nicht gesichert (Rohgerät)". Vorgabe: **nicht** anlegen;
     wahlweise leer anlegen (mit Hinweis, dass sie leer sind). Bei Proxmox-VE-Hosts sagt
     der Plan: "VMs und Container über die PVE-Integration von Restow wiederherstellen."
     Thin-Pools mit Platz für diese LVs sind in der Größenrechnung optional.

### 10.11 Dateisysteme anlegen

`baremetal/mkfs.go` baut die Argumente nur aus erfassten Werten, nie aus Vorgaben des
`mkfs` im ISO. Grund: Neuere `mkfs`-Versionen schalten Funktionen standardmäßig ein, die
ältere Kernel oder GRUB-Versionen nicht lesen (bekanntes Beispiel: e2fsprogs 1.47 mit
`metadata_csum_seed` und `orphan_file`, die GRUB vor 2.12 bzw. Kernel vor 5.15 nicht
verstehen; bei XFS `bigtime`, `inobtcount`, `nrext64` gegenüber älteren Enterprise-Kerneln).
Ein im ISO erzeugtes Dateisystem, das das wiederhergestellte System nicht einhängen kann,
wäre der schlimmste Fehler dieses Entwurfs.

| Typ | Befehl | aus dem Manifest |
| --- | --- | --- |
| ext2/3/4 | `mkfs.ext4 -F -U <uuid> [-L <label>] -b <bs> -I <inodesize> -N <inodes> -m <reserved> -O none,<features> [-G <flexbg>] [-J size=<MiB>] [-E stride=,stripe_width=]` (ext2/3 über `-t`) | Funktionsliste aus `dumpe2fs -h` wörtlich, `-b` mindestens die wirksame Blockgröße (10.9), Inode-Zahl im Verhältnis zur neuen Größe, mindestens `inodesUsed` · 1,2 |
| XFS | `mkfs.xfs -f -m uuid=<uuid>,crc=,finobt=,rmapbt=,reflink=,bigtime=,inobtcount= -i sparse=,nrext64= -n ftype= -b size= -s size=<blockgröße> [-L <label>] [-l size=]` | aus `xfs_info`; eine Option, die das `mkfs.xfs` des ISO nicht kennt, ist nur zulässig, wenn ihr Wert der Kernel-Standard alter Versionen ist (`0`) |
| btrfs | `mkfs.btrfs -f -U <uuid> [-L <label>] -n <nodesize> -s <sectorsize> --csum <crc32c\|xxhash\|sha256\|blake2> -O <features>,^<abgeschaltete> -d <profil> -m <profil> <geräte>` | aus `dump-super` (`incompat_flags`, `compat_ro_flags`), Geräte in Reihenfolge der `devid` |
| vfat | `mkfs.vfat -F <12\|16\|32> -i <volumeid> [-n <label>] -S <logische Sektorgröße des Ziels> [-s <cluster>]` | `-S` nie aus der Quelle (10.9) |
| Swap | `mkswap -U <uuid> [-L <label>] <dev>` | Swap-Dateien: nach dem Restore `fallocate` (btrfs: `chattr +C` auf leere Datei, dann `dd`), `chmod 600`, `mkswap -U`; danach `resume_offset` neu (10.13) |

Danach je Dateisystem `blkid -p` zurücklesen: UUID, Typ, Label müssen dem Manifest gleichen,
bei ext4 die Funktionsliste (`dumpe2fs -h`), sonst Abbruch vor dem Restore.

**btrfs-Subvolumes:** oberste Ebene einhängen (mit `device=` je Gerät), je Subvolume aus dem
Manifest `btrfs subvolume create <pfad>` in Reihenfolge der Eltern (Snapper/Timeshift leer),
Standard-Subvolume setzen (`btrfs subvolume set-default <id-im-neuen-fs>`), Eigenschaften
(`btrfs property set ro`, Kompression) setzen. Subvolume-IDs werden neu vergeben; Verweise
mit `subvolid=` in `fstab` ersetzt `fixups.go` durch `subvol=<pfad>`. Ordner mit `+C`
(nodatacow) bis vier Ebenen unter jedem Einhängepunkt erfasst der Agent (`lsattr -d`,
Abschnitt 4.1, Feld `noCowDirs`) und `recover` setzt `chattr +C` vor dem Restore (restic
stellt Dateiattribute nicht her, 1.2).

**openSUSE (Snapper-Wurzel):** Das Standard-Subvolume ist `@/.snapshots/<N>/snapshot`, `/`
wird ohne `subvol=` eingehängt und liegt innerhalb von `@/.snapshots`. Das Manifest kennzeichnet
Standard-Subvolume und Pfad. `recover` legt `@`, `@/.snapshots` und
`@/.snapshots/<N>/snapshot` (beschreibbar) in dieser Reihenfolge an, setzt es als Standard,
stellt `@/.snapshots/<N>/info.xml` aus der Sicherung her (5.3; fehlt sie, erzeugt `recover`
eine mit Typ `single`, Beschreibung "restored by Restow" und dem Zeitpunkt des Snapshots) und
legt die übrigen Snapper-Snapshots nicht an. **Quota:** Meldet das Manifest Quota an,
schaltet `recover` sie erst **nach** dem Restore ein (`btrfs quota enable`, dann
`btrfs quota rescan -w`); aktivierte qgroups machten einen großen Restore sehr langsam.

### 10.12 Einhängen und Dateien zurückholen

- Ziel unter `/mnt/restow-target`: in der Reihenfolge der Pfadtiefe jedes Dateisystem des
  Manifests an seinem Einhängepunkt (btrfs mit `subvol=`, `device=` je Gerät und den
  `compress`/`compress-force`-Optionen aus `mountinfo`, damit die Daten wieder komprimiert
  landen und die Größenrechnung stimmt), vfat mit `quiet` (sonst scheitern `chown`/`chmod`
  von restic auf FAT), alles andere mit den Standardoptionen. Übernommene Dateisysteme
  werden eingehängt, aber vom Restore ausgenommen (10.7).
- `restic restore --json --no-lock --no-cache --target /mnt/restow-target --sparse --verify
  --overwrite never [--exclude <übernommene Einhängepunkte>] <snapshot>` (neue Felder in
  `restic.RestoreOptions`: `Sparse`, `NoLock`, `NoCache`, `Overwrite`, `Subfolder`,
  `OwnershipByName`, `Excludes`, `ExcludeXattrs`; heute fest `--overwrite never --verify`).
  Besitzer numerisch (restics Standard; richtig, weil `/etc/passwd` mitkommt), Hardlinks,
  ACLs, `security.capability`, `security.selinux` (1.2, [Quelle]).
- **Einhängepunkte und API-Ordner:** Unabhängig davon, ob restic sie mitbringt (1.2 Punkt 2),
  legt `recover` nach dem Restore jeden Einhängepunkt aus `mounts` und `fstab` und die
  API-Ordner mit festen Modi an, wenn sie fehlen: `/proc` 0555, `/sys` 0555, `/dev` 0755,
  `/run` 0755, `/tmp` 1777, `/boot/efi` und übrige Einhängepunkte 0755, alle `root:root`.
  Fehlt `/proc` oder `/sys`, scheitert initramfs-tools bzw. dracut beim `mount --move` in die
  neue Wurzel; fehlt `/boot/efi`, geht das System in den Notfallmodus.
- Fortschritt aus restics `status`-Zeilen (wie `Restore` heute), an die Konsole und an
  `progress`.
- Fehler einzelner Dateien: gesammelt (wie `itemErrors`). Mehr als null Fehler bei
  Dateien unter `/boot`, `/usr`, `/etc`, `/lib*`, `/bin`, `/sbin` oder der ESP ist ein
  Abbruch vor den Fixups ("System unvollständig"); sonst eine Warnung mit Liste.

### 10.13 Ende des Repository-Zugangs, Schlüsseldateien, Fixups

Nach dem Restore, in dieser Reihenfolge:

1. restic ist beendet; `recover` ruft `release` (9.8). Ab hier hat das ISO keinen Zugang mehr
   zum Repository, und die restic-Route antwortet nach höchstens 5 Sekunden 401.
2. Repository-Passwort und Sitzungsgeheimnis liegen in `[]byte` und werden genullt (in Go nur
   für diese Puffer garantiert; der eigentliche Schutz ist die Isolation in 10.14).
3. Schlüsseldateien neu erzeugen und mit `luksAddKey` einschreiben (10.10 Punkt 5), MOK
   bereitstellen (10.5), danach die Passphrase-Puffer nullen. Ab hier hält `recover` kein
   Geheimnis mehr außer dem Sitzungsgeheimnis für `progress`/`log`/`finish`, das nur noch
   diese Aufrufe öffnet.
4. Fixups (reine Textumformungen in `baremetal/fixups.go`, jede mit Tabellentests; Lesen und
   atomares Schreiben unter dem Ziel in `recovery/rootfs_linux.go`, Links werden unter dem
   Ziel aufgelöst, nie außerhalb). Jede Änderung legt die vorige Datei als
   `<datei>.restow-<zeit>` daneben und steht im Abschlussbericht.
5. Erst danach laufen Programme aus der Sicherung (10.14, 10.15).

| Datei | Fixup | Wann |
| --- | --- | --- |
| `/etc/fstab` | Gerätenamen (`/dev/sda2`, `/dev/nvme0n1p2`, `/dev/md127`, `/dev/disk/by-path/...`, `/dev/disk/by-id/...`) durch `UUID=` bzw. `PARTUUID=` ersetzen; `subvolid=` durch `subvol=`; Einträge für nicht wiederhergestellte Dateisysteme mit `nofail` versehen und kommentieren | wenn solche Verweise vorkommen |
| `/etc/crypttab` | Quellgeräte wie oben auf `UUID=`; Plain-dm-crypt (`swap`, `tmp`, `plain`) auf `PARTUUID=` bzw. `by-id/wwn-…` (Pflicht, 10.10) | ebenso; Plain immer |
| `/etc/mdadm/mdadm.conf`, `/etc/mdadm.conf` | `DEVICE`-Zeilen mit Gerätenamen auf `DEVICE partitions containers`; `ARRAY` behalten (UUID gleich), `spares=` und `num-devices=` an die tatsächliche Zahl anpassen | ebenso |
| Kernel-Kommandozeile (`/etc/default/grub` `GRUB_CMDLINE_LINUX*`, `/etc/default/grub.d/*`, `/etc/kernel/cmdline`, BLS-Einträge `options`, systemd-boot `loader/entries`) | `root=/dev/...` und `resume=/dev/...` auf `UUID=`; ebenso `cryptdevice=/dev/sda2:root` (mkinitcpio), `cryptkey=`, `md=0,/dev/sda1,/dev/sdb1`, `rd.luks.key=…:/dev/…`; `rd.md.uuid`, `rd.luks.uuid`, `rd.lvm.lv` bleiben (gleich); `resume_offset=` neu (siehe unten) | ebenso |
| `grubenv` `kernelopts` (RHEL 8) | **nie** als Text bearbeiten (1024-Byte-Format); im `chroot` `grub2-editenv - set kernelopts=…` (10.15) | ebenso |
| `/boot/grub/device.map`, `/boot/grub2/device.map` | löschen (GRUB erzeugt bei Bedarf neu; sonst "disk hd0 not found") | wenn vorhanden |
| `/etc/default/grub_installdevice` (SUSE), Debconf `grub-pc/install_devices`, `grub-efi/install_devices` | BIOS-Zielplatten bzw. ESPs auf die neuen `/dev/disk/by-id/...`; fehlende ESPs entfernen (10.7) | BIOS bzw. mehrere ESPs |
| `/etc/kernel/proxmox-boot-uuids` | UUIDs der vorhandenen ESPs, fehlende entfernen | Proxmox VE |
| `/etc/initramfs-tools/conf.d/resume` | `RESUME=/dev/…` auf `UUID=` | ebenso |
| `/etc/systemd/system/*.mount`, `*.swap` | `What=/dev/sdX` auf `/dev/disk/by-uuid/…` | ebenso |
| `/etc/dracut.conf.d/*.conf` | `add_device+=" /dev/… "` auf `/dev/disk/by-uuid/…` | ebenso |
| `/etc/lvm/lvm.conf` | `filter`/`global_filter` mit Gerätenamen: Annahmelisten auf `/dev/disk/by-id/lvm-pv-uuid-<pvuuid>` umschreiben (`a\|...\|`), sonst Problem im Plan; `allow_mixed_block_sizes = 1`, wenn 10.9 es verlangt | wenn Filter Gerätenamen nennen |
| `/etc/lvm/devices/system.devices` | beiseitelegen; neu in 10.15 (`vgimportdevices`) | wenn vorhanden |
| Netzkonfigurationen mit MAC (10.16) | alte MAC durch zugeordnete neue ersetzen; `70-persistent-net.rules`-Einträge alter MACs entfernen | bei anderer Hardware |
| `/etc/systemd/network/10-restow-<alt>.link` | `MACAddress=<neu>`, `Name=<alt>` | Umbenennung (10.16) |
| `/.autorelabel` | nur als Rückfall (siehe unten) | SELinux |
| `/etc/machine-id` | bleibt | – |

- **`resume_offset`** für Swap-Dateien wird neu berechnet, weil sich der Offset bei der
  Neuanlage ändert: btrfs mit `btrfs inspect-internal map-swapfile -r <datei>`, ext4/XFS mit
  `filefrag -v` (erster physischer Block), jeweils mit dem Werkzeug des ISO auf dem
  eingehängten Ziel; dann in Kommandozeile bzw. `conf.d/resume` eingetragen.
- **Suchlauf nach Gerätenamen:** Ein Suchlauf über `/etc` des Ziels nach
  `/dev/(sd|hd|vd|xvd|nvme|mmcblk)…` ändert nichts, nennt aber jede Fundstelle außerhalb der
  Tabelle im Abschluss (und L6 in Stufe 1, aus `deviceNameRefs`).
- **SELinux:** restic stellt `security.selinux` wieder her (1.2). Ein vollständiges Relabel
  setzte Kontexte zurück, die nur mit `chcon` bzw. von Podman mit `:Z`/`:z`
  (`container_file_t`, MCS-Kategorien) gesetzt wurden, und dauerte auf großen Systemen
  Stunden. Darum: Stichprobe nach dem Restore (`getfattr -n security.selinux` auf `/etc`,
  `/usr/bin`, `/var` und zehn zufälligen Dateien darunter). Sind die Kontexte da, kein
  `/.autorelabel`, sondern `restorecon -F` (im `chroot`, 10.14) nur für die von `recover`
  angelegten bzw. geänderten Pfade: Einhängepunkte und API-Ordner, Swap-Dateien,
  Schlüsseldateien, Fixup-Dateien, `.link`-Dateien. Fehlen die Kontexte, `/.autorelabel` als
  Rückfall und Warnung "der erste Start dauert länger und startet einmal neu".

### 10.14 Isolation der Programme aus der Sicherung

Die Schritte in 10.15 laufen mit Programmen des **Zielsystems**, nicht des ISO (so passen
Versionen und Konfiguration). Diese Programme stammen von einem möglicherweise
kompromittierten Rechner. Liefe ein initramfs-Hook oder `grub-install` aus der Sicherung als
root in einem einfachen `chroot`, könnte er über `/proc/<pid>/mem` bzw. `environ` von
`recover` Geheimnisse lesen, sie über das Netz des ISO ausleiten, jede andere Platte
überschreiben (die alte, die der Bediener behalten wollte, oder übernommene Datenplatten
fremder Teile) und die NVRAM beschädigen. Darum läuft jeder dieser Schritte über
`restow-agent chroot-exec` (`isolate_linux.go`):

- `SysProcAttr.Unshareflags = CLONE_NEWNS|CLONE_NEWPID|CLONE_NEWNET|CLONE_NEWIPC|CLONE_NEWUTS`;
  im neuen PID-Namensraum ein frisches `/proc` (sieht nur die eigenen Prozesse), `/sys` nur
  lesend, kein efivarfs, ein Netz-Namensraum nur mit `lo`.
- `/dev` ist ein neues `tmpfs` mit `nodev`, darin als einzelne Bind-Mounts aus dem `/dev`
  des ISO genau `null`, `zero`, `full`, `random`, `urandom`, `tty`, `pts` (eigene Instanz)
  und die Knoten der **Zielgeräte** des Plans samt ihrer Partitionen, md-, dm- und
  `mapper`-Knoten und der zugehörigen `/dev/disk/by-*`-Links. Ein mit `mknod` neu angelegter
  Knoten auf dem `nodev`-tmpfs lässt sich nicht öffnen; übernommene Datenplatten sind nur
  dabei, wenn der Schritt sie braucht (initramfs mit `crypttab`-Einträgen: nur deren
  dm-Knoten).
- Vor dem `exec` setzt der Helfer `PR_SET_NO_NEW_PRIVS` und entfernt aus der
  Bounding-Menge `CAP_SYS_MODULE`, `CAP_SYS_RAWIO`, `CAP_SYS_BOOT`, `CAP_SYS_PTRACE`,
  `CAP_NET_ADMIN`, `CAP_MKNOD`, `CAP_SYS_TIME`; `CAP_SYS_ADMIN` nur für die Schritte, die
  device-mapper-ioctls brauchen (`grub-install`/`grub-probe` auf LVM oder LUKS,
  `grub2-mkconfig`, `vgimportdevices`), sonst ebenfalls weg. Zusätzlich ein seccomp-Filter
  (von Hand gebautes BPF-Programm, `prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER)` als
  Rohaufruf, kein Modul), der `mount`, `umount2`, `pivot_root`, `open_tree`, `move_mount`,
  `fsopen`, `fsmount`, `fsconfig`, `mknod`, `mknodat`, `init_module`, `finit_module`,
  `kexec_load`, `kexec_file_load`, `reboot`, `ptrace`, `process_vm_readv`,
  `process_vm_writev`, `bpf`, `perf_event_open` und `unshare`/`setns` mit `EPERM`
  beantwortet. Damit kann auch ein Schritt mit `CAP_SYS_ADMIN` weder ein `devtmpfs` mit allen
  Platten einhängen noch Module laden oder fremde Prozesse lesen. [CI] Ob jeder der drei
  initramfs-Erzeuger, `grub-install`, `grub2-mkconfig`, `bootctl`, `vgimportdevices`,
  `restorecon` und `kernel-install` mit dieser Menge läuft; was einer zusätzlich braucht,
  steht mit Begründung in `isolate_linux.go` und in diesem Abschnitt.
- Umgebung leer bis auf `PATH`, `LANG=C.UTF-8`, `SYSTEMD_OFFLINE=1`.
- Vor dem ersten Schritt ist restic beendet und alles aus 10.13 Punkt 1 bis 3 erledigt.
- NVRAM schreibt nicht das Zielsystem: `grub-install --no-nvram`, `bootctl install
  --no-variables`; `Boot####` und `BootOrder` schreibt `recover` selbst
  (`efivars_linux.go` mit `BuildLoadOption`, Attribut `NV|BS|RT`, `immutable` über
  `FS_IOC_SETFLAGS` nur für die eigene Datei aufheben).
- CI-Test im Job `agent-root`: Ein initramfs-Hook im Testsystem versucht `ping 1.1.1.1`,
  `cat /proc/1/environ`, `ls /proc` (erwartet nur eigene PIDs), Schreiben auf eine nicht
  ausgewählte Loop-Platte, `mknod` und Öffnen eines neuen Knotens und `mount -t tmpfs`; alles
  muss scheitern, der Hook schreibt das Ergebnis in eine Datei, die der Test prüft.

### 10.15 initramfs, Bootloader, NVRAM

- **LVM-Gerätedatei** (RHEL 9 und Alma 9: `use_devicesfile=1` ist Standard, die Datei nennt
  die PVs über `sys_wwid`/`sys_serial` der **alten** Platten): im `chroot` mit nur den
  Zielgeräten `vgimportdevices --all --config devices/obtain_device_list_from_udev=0` neu
  erzeugen, **vor** dem initramfs-Neubau (dracut nimmt die Datei mit). Ohne diesen Schritt
  übergeht LVM die PVs auf neuer Hardware, `home`, `swap` und weitere VGs bleiben aus, das
  System geht in den Notfallmodus.
- **initramfs neu**, zuerst für den **Standard-Kernel** des Bootloaders, die übrigen erst
  nach einer Platzprüfung (frei auf `/boot` ≥ 1,5 × geschätzte Größe des allgemeinen
  Abbilds, Schätzung aus der Größe des vorhandenen Abbilds × 3 bzw. 130 MiB, das Größere);
  sonst bleiben sie unverändert und stehen im Bericht als "nicht angepasst". Ein allgemeines
  Abbild ist 70 bis 130 MB groß, ältere Ubuntu- und Debian-Installationen haben ein `/boot`
  von 256 bis 512 MB mit zwei bis drei Kerneln.
  - initramfs-tools: `update-initramfs -u -k <v>` (`-c` nur für fehlende Abbilder; `-c`
    bricht bei vorhandenem ab); für diesen Lauf `/etc/initramfs-tools/conf.d/zz-restow-recovery`
    mit `MODULES=most`, danach entfernt (ein initramfs mit `MODULES=dep` vom alten
    Controller startet auf neuer Hardware nicht). Hat das System `KEYMAP=y` nicht gesetzt,
    bleibt das so (die Eingabe ist dann `us`, 10.10).
  - dracut: `dracut --force --no-hostonly --include /etc/crypttab /etc/crypttab --include
    /etc/vconsole.conf /etc/vconsole.conf --kver <v>`. Grund: `hostonly` (Standard bei
    Fedora/RHEL) enthielte nur die Treiber des Rechners, auf dem es gebaut wird, und im
    `chroot` erkennt dracut die neue Hardware nur unvollständig. Ohne `--include` nähme
    dracut ohne Hostonly `crypttab` nicht mit: LUKS-Volumes hießen `luks-<uuid>` statt nach
    dem `crypttab`-Namen, Optionen und Schlüsseldateien fehlten, und `root=/dev/mapper/<name>`
    würde nicht gefunden. Das nächste Kernel-Update baut wieder `hostonly` (25.B6).
  - mkinitcpio: `mkinitcpio -p <preset>` für das Preset des Standard-Kernels (das
    `fallback`-Abbild ohne `autodetect` entsteht mit); weitere Presets nach Platzprüfung.
  - **UKI** (`<esp>/EFI/Linux/*.efi` bzw. XBOOTLDR, `captureLoaders`): Der Neubau in `/boot`
    änderte die UKI nicht, und ihre eingebettete Kommandozeile lässt sich nicht als Text
    reparieren. `recover` baut sie mit dem Erzeuger des Ziels neu, nachdem
    `/etc/kernel/cmdline` den Fixup bekommen hat: mkinitcpio `-p` mit UKI-Preset,
    `kernel-install add <v> /usr/lib/modules/<v>/vmlinuz` bei `layout=uki`, `dracut --uefi`
    (mit denselben `--include`). Fehlt der Erzeuger, ist das Urteil schon beim Sichern
    `unsupported` (`uki_without_generator`).
- **GRUB-Konfiguration** neu, wenn ein Fixup die Kommandozeile geändert hat oder BIOS:
  `update-grub` bzw. `grub2-mkconfig -o <grubCfg aus dem Manifest>` (der tatsächliche Ort:
  bei RHEL/Alma 8 UEFI `/boot/efi/EFI/<vendor>/grub.cfg`, sonst `/boot/grub2/grub.cfg`;
  ein neues `grub.cfg` am falschen Ort wirkte nicht) mit `GRUB_DISABLE_OS_PROBER=true` in der
  Umgebung; RHEL 8 zusätzlich `grub2-editenv - set kernelopts=<neue Kommandozeile>`.
- **UEFI:** Die ESP-Dateien (shim, GRUB, systemd-boot, ggf. Kernel) kommen aus der
  Sicherung. `recover` legt je erfasstem aktiven `Boot####`-Eintrag, dessen Loader auf eine
  wiederhergestellte ESP zeigt und zu einem wiederhergestellten System gehört (nicht
  `\EFI\Microsoft\…`, 10.5), einen neuen Eintrag an (eigener Code, 10.14; vorhandene
  Einträge mit gleichem Pfad und gleicher PARTUUID werden nicht doppelt angelegt) und setzt
  `BootOrder` mit diesen vorn. Liegt die ESP auf md RAID1 mit Metadaten 1.0, entsteht je
  Mitglied ein Eintrag (die Firmware sieht die Mitglieder, nicht `/dev/mdX`).
- **Rückfallpfad:** Fehlt auf der ESP `\EFI\BOOT\BOOTX64.EFI`, richtet `recover` ihn ein
  (Option, Vorgabe an), weil manche Firmware NVRAM-Einträge vergisst oder nicht schreiben
  lässt. Liegt `fbx64.efi` samt `BOOTX64.CSV` im Herstellerordner, nutzt `recover` die
  shim-Fallback-Kette (`shimx64.efi` als `\EFI\BOOT\BOOTX64.EFI`, `fbx64.efi` daneben; fb
  liest `BOOTX64.CSV` und legt den Eintrag beim ersten Start selbst an). Sonst kopiert es
  den erfassten Loader samt Nachbardateien (`shimx64.efi` als `BOOTX64.EFI`, `grubx64.efi`,
  `mmx64.efi`) **und** den `grub.cfg`-Stub des Herstellerordners nach `\EFI\BOOT\`; ein
  signierter GRUB, der aus `\EFI\BOOT\` startet, sucht `grub.cfg` je nach Distribution unter
  `$cmdpath` oder im fest eingebauten Herstellerpfad, ohne den Stub landete er in der
  `grub>`-Shell. Ein `grub-install` für UEFI ist nicht nötig und unterbleibt (es könnte den
  shim-Weg der Distribution verändern).
- **BIOS:** `grub-install --target=i386-pc --no-nvram <platte>` (Debian, Ubuntu, Arch) bzw.
  `grub2-install` (RHEL, Fedora, SUSE) für jede Zielplatte, die eine Quellplatte mit
  GRUB-Bootcode ersetzt (bei RAID 1 alle Mitglieder), nachdem `device.map` entfernt ist;
  danach PMBR-Aktiv-Flag (10.10).
- **systemd-boot:** `bootctl --esp-path=<esp> install --no-variables` nur, wenn die
  ESP-Dateien fehlen; sonst nur NVRAM wie oben; Kommandozeilen in `loader/entries` wie in
  10.13.
- **Secure Boot und MOK:** nichts zu tun, wenn shim und signierter Kernel aus der Sicherung
  kommen und die Prüfung in 10.5 bestanden ist; MOK-Bereitstellung siehe 10.5.

### 10.16 Netzwerkschnittstellen

Die Namen (`enp3s0`) hängen an der Hardware, und viele Konfigurationen suchen ihre
Schnittstelle über die **MAC**: netplan `match: macaddress:` mit `set-name:` (Standard bei
Ubuntu-Cloud- und Server-Images), NetworkManager `mac-address=`, RHEL `ifcfg-*` `HWADDR=`,
`/etc/udev/rules.d/70-persistent-net.rules` (Debian mit ifupdown, CentOS 7), networkd
`[Match] MACAddress=`. Kommt das System auf neuer Hardware hoch, findet eine solche
Konfiguration ihre Schnittstelle nicht, und ein Server ohne Konsole ist nicht erreichbar.

`recover` vergleicht `network` aus dem Manifest mit den physischen Schnittstellen des Ziels.
Gibt es genau eine physische Schnittstelle vorher und nachher, schlägt es die Zuordnung vor;
bei mehreren fragt es je alter Schnittstelle (mit Treiber, Link und Geschwindigkeit als
Hilfe). Vorgabe an bei gleicher Anzahl, sonst aus. Für jede Zuordnung:

1. In genau den Dateien aus `netConfigs` (4.1) ersetzt der Fixup die alte MAC durch die neue
   und entfernt Einträge alter MACs aus `70-persistent-net.rules`.
2. Die `.link`-Umbenennung (`Name=<alt>` für `MACAddress=<neu>`) legt `recover` nur an, wenn
   keine **andere** neue Karte den alten Namen von selbst bekäme (sonst scheiterte die
   Umbenennung mit "File exists"); in diesem Fall Warnung und Zuordnung nur über die MAC in
   den Konfigurationen.

Gleiche MAC (gleiche Hardware): nichts zu tun. Testfall in E2: netplan mit `macaddress`.

### 10.17 Prüfung nach der Wiederherstellung

`recovery/verify_linux.go`, Ergebnis als `verification` im Abschluss und auf der Konsole:

1. restic `--verify` ohne Fehler (10.12).
2. Jedes Dateisystem des Plans mit UUID, Typ, Label (`blkid -p`), md-Arrays aktiv
   (`mdadm --detail`), LVs vorhanden (`lvs --devices …`), LUKS geöffnet; übernommene Teile
   unverändert (UUIDs wie vorher).
3. `findmnt --verify --tab-file /mnt/restow-target/etc/fstab` ohne Fehler; jeder Eintrag
   ohne `noauto`/`nofail` zeigt auf ein Gerät, das es gibt.
4. Jeder `crypttab`-Eintrag zeigt auf ein LUKS-Volume des Plans; jeder Plain-Eintrag
   (`swap`, `tmp`, `plain`) löst sich auf **genau** die geplante Partition auf, sonst
   `failed`.
5. Für den Standard-Kernel (und jeden weiteren, der neu gebaut wurde) gibt es ein
   initramfs bzw. eine UKI, neuer als der Start der Wiederherstellung, **vollständig
   lesbar** (Exitcode von `lsinitramfs`/`lsinitrd`/`lsinitcpio`), und es enthält jeden
   Treiber der Speicherkette der Zielplatten (10.8, die ganze Kette, nicht nur
   `device/driver`; eingebaute Treiber aus `modules.builtin` zählen als vorhanden) sowie
   `cryptsetup`, `mdadm`, `lvm` bzw. `btrfs`, wenn der Stapel sie braucht, und die
   LVM-Gerätedatei, wenn das System sie nutzt. Freier Platz auf `/boot` mindestens
   10 Prozent.
6. UEFI: Der neue `Boot####`-Eintrag steht in `BootOrder` und sein Loader liegt auf der ESP
   (Datei vorhanden, Authenticode-Hash gleich dem gesicherten); der Rückfallpfad ist
   vollständig (Loader, Nachbarn, `grub.cfg`-Stub bzw. `fbx64.efi` und `BOOTX64.CSV`).
   BIOS: GRUB-Bootcode im MBR jeder Zielplatte (Kennung wie in `captureBootCode`),
   `core.img` in der BIOS-Boot-Partition bzw. hinter dem MBR, PMBR-Flag wie gesichert.
7. GRUB-Konfiguration bzw. Loader-Einträge nennen nur UUIDs, die es gibt.
8. **Keine doppelte Identität** auf angeschlossenen Geräten (10.7). Sonst kein Neustart,
   sondern die Anweisung "Platte X abziehen oder mit wipefs leeren".
9. Alle Einhängepunkte und API-Ordner existieren im Ziel mit den Modi aus 10.12.
10. Secure Boot an: Die Startkette auf der ESP besteht die Prüfung aus 10.5 gegen den
    aktuellen Stand der Firmware; eine bereitgestellte MOK steht in `MokNew`.

Jede Prüfung ist `ok`, `warning` oder `failed` mit Beleg. Ein `failed` heißt: kein Neustart
angeboten, sondern die Shell und das Protokoll; der Bericht an den Server ist `failed`.
Vor dem angebotenen Neustart: `sync` und `blockdev --flushbufs` je Zielplatte, alles
aushängen, LUKS schließen.

### 10.18 Fortschritt, Abbruch, Fortsetzen

- Abbruch mit Strg+C oder `a` (mit Rückfrage), oder aus der Oberfläche (`cancelRequested`):
  restic bekommt SIGINT, `recover` hängt alles aus, schließt LUKS, stoppt Arrays nicht (ein
  laufender Resync schadet nicht), schreibt in den Marker "sauber angehalten" und sagt: "Die
  Zielplatten sind unvollständig."
- Marker `/.restow-recovery.json` im Ziel-Wurzeldateisystem (Snapshot, Planprüfsumme, Zeit,
  zuletzt erreichter Schritt, `cleanStop: true|false`; geschrieben nach dem Anlegen der
  Dateisysteme, nach jedem Schritt erneuert, gelöscht ganz am Ende).
- **Fortsetzen in derselben Sitzung** nach sauberem Anhalten: Menüpunkt "Fortsetzen": öffnet
  und hängt wieder ein (ohne Partitionieren) und ruft `restic restore --overwrite if-changed`
  (vorhandene, richtige Dateien werden nur gelesen, nicht neu geladen).
- **Fortsetzen nach Neustart oder Stromausfall:** Der Code ist verbraucht, das
  Sitzungsgeheimnis war nur im Speicher. Der Admin stellt einen neuen Code aus. `recover`
  erkennt die angefangene Wiederherstellung am Marker und bietet an, mit demselben Snapshot
  ohne Partitionieren fortzusetzen (LUKS mit der Passphrase öffnen, Arrays zusammensetzen,
  `vgchange -ay --devices …`, einhängen). Nach einem **unsauberen** Ende (`cleanStop` nicht
  gesetzt) gilt immer `--overwrite always`: Nach einem Stromausfall gibt es auf XFS und bei
  verzögerter Allokation Dateien mit richtiger Größe und mtime, aber genullten Blöcken, die
  `if-changed` voraussichtlich nicht erkennt (1.2 Punkt 3). restic vergleicht dann den Inhalt
  und schreibt nur abweichende Blöcke. Danach prüft `recover` die Systempfade (`/boot`,
  `/usr`, `/etc`, `/lib*`, `/bin`, `/sbin`, ESP) vollständig gegen den Snapshot (Inhalt über
  `restic restore --verify` mit `--include` dieser Pfade in einen zweiten Durchlauf mit
  `--overwrite always`).
- Zugang abgelaufen während des Restores (restic bekommt 401): `recover` hält an und fragt
  nach einem neuen Code, dann weiter wie bei einem sauberen Anhalten.

### 10.19 Wiederanbinden am Ende (optional)

Nach der Prüfung bietet `recover` an, den wiederhergestellten Rechner gleich wieder mit
Restow zu verbinden, mit einem **Wiederanbindungs-Token** (Abschnitt 11), das der Admin in
einem eigenen Dialog ausgestellt hat. `recover` ruft `POST
/agent/v1/recovery/sessions/current/rebind` (nur nach `finish` mit `succeeded`, höchstens
15 Minuten danach) mit dem Token und den Daten des Zielsystems (Hostname aus `/etc/hostname`
im Ziel, `os`, `arch`, Agent-Version des Ziels, Hook-Regel aus dem Manifest `agent.hooks`)
und schreibt die Antwort als `/mnt/restow-target/etc/restow-agent/state.json` (0600, root)
über `state.Save` mit umgelenktem Pfad. Ohne Token startet der Agent im wiederhergestellten
System und wartet ("not enrolled yet", `waitForEnrollment` in `cmd/restow-agent/run.go`), bis
jemand `restow-agent enroll` mit einem Token aufruft (`POST /agent/v1/enroll`).

### 10.20 Unbeaufsichtigt (`--answers`)

Für CI, Startprobe und Massenwiederherstellungen. Inhalt (JSON): `instanceUrl`, `code`,
`caFile?`, `spkiCheck?`, `snapshotId?`, `network?`, `diskMapping: "auto" | {...}`,
`adopt?`, `passphrase`, `keyFiles: "regenerate" | "keep"`, `confirmErase: [<kennungen>]`,
`renameNics`, `rawLvs: "skip" | "create"`, `afterSuccess: "reboot" | "poweroff"`, `probe?`
(Abschnitt 12.3).

- Antworten werden nur gelesen, wenn die Quelle ausdrücklich gewählt ist:
  - `restow.answers=media` auf der Kernel-Kommandozeile (nur der Eintrag
    "Erweitert > Antworten von Medium lesen", kein Standard-Menüeintrag), dann vom Medium
    mit dem Label `RESTOWANS`;
  - `fw_cfg` (`/sys/firmware/qemu_fw_cfg/by_name/opt/restow/answers/raw`) nur, wenn DMI
    `sys_vendor` `QEMU` ist. `fw_cfg` gibt es nur in einer VM, und wer es setzt, kontrolliert
    den Hypervisor; ein fremder USB-Stick kann es nicht.
  - eine Datei nur mit `--answers` von Hand in der Shell.
- `probe` und `http://` nur bei `fw_cfg` **und** `sys_vendor=QEMU`.
- `code` und `passphrase` im Klartext lehnt `--answers` ab, außer bei `fw_cfg`; vom Medium
  gelesen fragt `recover` beides interaktiv.
- Vom Medium gelesen zeigt `recover` vor dem ersten Löschen 30 Sekunden lang Zielplatten
  (Modell, Größe, Kennung) und Instanz an, abbrechbar mit jeder Taste.
- Ohne `confirmErase` mit genau den Kennungen löscht auch der unbeaufsichtigte Modus nichts.
  Ein Code mit `requireApproval: true` braucht auch unbeaufsichtigt die Freigabe (der
  CI-Treiber gibt sie über die API).

## 11. Wiederanbindung eines wiederhergestellten Rechners

Weil `state.json` nicht mehr gesichert wird (5.4) und der Wiederherstellungscode nur lesen
darf (Entscheidung), braucht der Rechner danach einen eigenen, getrennten Weg zurück. Das
Token gibt **dauerhaften** Zugang wie ein installierter Agent (Lesen aller Sicherungen über
`agent`, Anhängen, Konfiguration, Aufgaben) und ist darum bewusst vom Code getrennt:

- `POST /api/v1/endpoints/:id/rebind-token` mit `{ validityHours?, purpose, unrevoke? }`
  (Mandanten-Admin, frische Anmeldung, Audit `endpoint.rebind_token.created`), **eigener
  Dialog** mit der Warnung "Dieses Token gibt dauerhaften Zugang wie ein installierter
  Agent. Wer es einlöst, wird zu diesem Rechner; der bisherige verliert seine Verbindung."
  Nicht im Code-Dialog. Ein Token wie beim Enrollment (`rset_`, einmal, nur SHA-256
  gespeichert) in `endpoint_enrollment_tokens` mit gesetzter neuer Spalte `endpoint_id`.
  Gültigkeit Standard **1 Stunde**, höchstens 24 (CHECK in 0076). `purpose`: `baremetal`
  (nach `recover`), `reinstall` (Linux neu installiert), `mac_setup` (Abschnitt 13). Antwort
  mit den Befehlen wie beim Enrollment (Linux, macOS).
- Einlösung:
  - im ISO nur über `POST /agent/v1/recovery/sessions/current/rebind` einer freigegebenen
    Sitzung desselben Rechners nach `finish` mit `succeeded` (10.19);
  - sonst über `POST /agent/v1/enroll` (`agent-service.ts`, Zweig "rebind").
  Beides legt keinen Rechner an, sondern stellt für den bestehenden ein neues Agent-Secret
  aus (`secret_hash` ersetzt), behält Repository, Passwort, Job, Einstellungen, Läufe; `os`
  muss gleich sein (sonst 422), ein anderer Hostname wird angenommen und vermerkt.
- **Widerrufene Rechner** (`POST /:id/revoke`, etwa nach Diebstahl oder Kompromittierung)
  werden nur reaktiviert, wenn beim Ausstellen `unrevoke: true` gewählt wurde (eigener
  Hinweis im Dialog, Audit `endpoint.unrevoked` bei der Einlösung); sonst antwortet die
  Einlösung 409 `endpoint-revoked`.
- Audit `endpoint.rebound` (alter und neuer Hostname, Adresse) und Alarm (12.6).
- Folge: Ein noch laufender alter Rechner mit demselben Endpunkt bekommt ab jetzt 401. Der
  Dialog sagt das vorher. Für "neuer Mac, alter läuft weiter" gibt es darum einen eigenen Weg
  ohne Token (Abschnitt 13.6).
- `purpose: "mac_setup"` setzt bei der Einlösung `endpoints.config.migrationPending = true`
  (Abschnitt 13.6).
- Derselbe Weg ist die Grundlage der geplanten Klonerkennung ("Neues Agent-Secret
  ausstellen"); beide nutzen dieselbe Funktion `rotateEndpointSecret` (neu,
  `apps/api/src/features/endpoints/rebind.ts`).
- Der Snapshot-Verlauf geht weiter: Der nächste Lauf findet über `--group-by host` den
  letzten Snapshot als Elternsnapshot (nach einer Wiederherstellung sind Inode und ctime neu,
  restic liest also alles einmal, lädt aber dank Deduplizierung kaum etwas hoch). Der Server
  markiert den ersten Lauf nach einer Wiederanbindung als neue Basis der Ransomware-Signale
  (`endpoint_runs.activity_baseline`, kein Vergleich über die Wiederanbindung hinweg;
  docs/RANSOMWARE.md wird ergänzt).

## 12. Restore-Prüfung auf dem Server ("Grün ist Beweis")

### 12.1 Stufe 1: Layout und Startkette (Linux)

Neue Queue `endpoint-baremetal-check` (`packages/core/src/endpoints/queues.ts`), Job
`apps/worker/src/endpoints/baremetal-check.ts`, geplant vom Abschluss jedes Laufs mit neuem
Layout-Verweis (sofort) und vom Scheduler, falls einer fehlt. Hält die geteilte
Wartungssperre wie der Restore-Test. Prüfungen, jede mit Ergebnis und Beleg:

| Nr. | Prüfung | Wie | Rot nur bei |
| --- | --- | --- | --- |
| L1 | Schema und Verweise | `parseLayoutManifest`, Verweise auflösbar, keine Zyklen, Größen plausibel, keine Steuerzeichen | ungültigem Manifest |
| L2 | Unterstützt | `verdict`, `unsupported[]` | `unsupported` |
| L3 | Plan erstellbar | `restow-agent baremetal plan --manifest - --facts <datei> --json` mit `--target same`, `--target minimal` (Mindestgrößen) und `--target other-controller` (NVMe↔AHCI, Treiberabgleich gegen `modules.alias` des Standard-Kernels; fehlende Treiber nur Warnung, weil die echte Ersatzhardware unbekannt ist); isoliert nach 12.2 | einem Problem des Planers bei `same` oder `minimal` |
| L4 | Manifest im Snapshot | `restic dump <snap> <manifestPathInSnapshot>`, SHA-256 gleich `endpoint_layouts.sha256` | Abweichung oder fehlender Datei (mit `isBackupFinding`-Beleg) |
| L5 | Vollständigkeit | Snapshot-`paths` enthalten jede Quelle aus `backup.sources`; **jeder lokale `fstab`-Eintrag** (auch `noauto`, Automount) und jedes Subvolume des Manifests unter einem Systempfad ist Quelle oder ausdrücklich ausgeschlossen; `restic ls <snap> <einhängepunkt>` je Quelle nicht leer; kein Einhängepunkt eines Systemdateisystems (`/`, `/boot`, ESP, `/usr`, `/var`) durch einen Ausschluss getroffen | fehlender Quelle, leerer Systemquelle |
| L6 | Startkette im Snapshot | über `restic dump` (je Datei höchstens 1 MiB, höchstens 80 Dateien): `/etc/fstab` (jeder Eintrag ohne `noauto`/`nofail` löst sich gegen das Manifest auf, über `UUID=`, `LABEL=`, `PARTUUID=`, `PARTLABEL=` oder Gerätenamen), `/etc/crypttab` (jeder Plain-Eintrag zeigt auf eine Partition mit PARTUUID, 10.10), `mdadm.conf`, `lvm.conf` (Filter) und `system.devices`, GRUB-Konfiguration am Ort aus `grubCfg` bzw. BLS- und Loader-Einträge (Kernel- und initramfs-Pfade vorhanden), Tastaturbelegung im initramfs (`initramfs.keymap`) gegen `vconsole.conf`/`keyboard`; über `restic ls`: Kernel und initramfs aus `kernels` mit gleicher Größe, Loader-Datei jedes aktiven `Boot####`-Eintrags auf der ESP, `modules.alias` und `modules.builtin` des Standard-Kernels, initramfs-Erzeuger (`update-initramfs`, `dracut`, `mkinitcpio`, bei UKI `kernel-install`) und `grub-install`/`grub2-install`/`bootctl` im Snapshot; Fundstellen aus `deviceNameRefs` als Hinweis | einem nicht auflösbaren `fstab`-Eintrag, fehlendem Kernel, Loader oder Erzeuger, Plain-dm-crypt mit Gerätenamen ohne PARTUUID |
| L7 | Konsistenz | `consistency` des Laufs | nie rot; `/` live gelesen ist eine Warnung |
| L8 | Restore-Größen | Summe der Dateigrößen je Einhängepunkt aus `restic ls --json --recursive` (Hardlinks einmal), gespeichert im Bericht (`restoreSizes`) für `recover` und die Mindestgrößen der Rechnerseite | nie rot |

Die Fakten für L3 (`--facts`: `modules.alias`, `modules.builtin`, Restore-Größen) sammelt der
Job vorher über `restic dump`/`ls`. Ergebnis als Bericht `endpoint_reports` der neuen Art
`baremetal_check` (grün/rot/unvollständig wie der Restore-Test: Ein Lesefehler, der nichts
über die Sicherung beweist, macht die Prüfung unvollständig, sie wird wiederholt). Zum
Bericht gehören die Fingerabdrücke (12.4).

### 12.2 Warum das Binary des Agenten auf dem Server, und wie es läuft

Der Planer ist die eine Stelle, die entscheidet, ob ein Layout umsetzbar ist. Ihn in
TypeScript nachzubauen hieße, zwei Planer gleich zu halten. Das Agenten-Binary liegt ohnehin
im Image (`/srv/agent/<v>/linux-<arch>/`); der Worker bekommt eine Kopie des Binarys seiner
Architektur (`/usr/local/lib/restow/restow-agent`, `RESTOW_PLANNER_BIN`). Eingabe ist das
(vom Server schon geprüfte, höchstens 512 KiB große) Manifest eines womöglich
kompromittierten Rechners, Ausgabe JSON; das Binary ruft kein Werkzeug auf. Damit ein Fehler
im Planer weder Geheimnisse des Workers preisgibt noch ihn ausbremst:

- `execFile` mit `env: { PATH: "/usr/bin:/bin", LC_ALL: "C" }` (keine `RESTOW_*`, keine
  DB-URL, kein Master-Key), `cwd` ein frischer leerer Ordner unter `os.tmpdir()`, stdin als
  einzige Eingabe (Manifest und Fakten), keine weiteren Dateideskriptoren.
- Grenzen: `prlimit --as=536870912 --cpu=30 --nofile=16 --` (util-linux, im Image) und
  zusätzlich setzt `baremetal plan` sie selbst (10.1); `timeout` 45 s, `maxBuffer` 4 MiB
  (größere Ausgabe: unvollständig, nicht rot).
- Test (`baremetal-check.test.ts`): ein Test-Binary an `RESTOW_PLANNER_BIN`, das seine
  Umgebung ausgibt, darf keine Variable `RESTOW_*` und kein `DATABASE_URL` sehen.

### 12.3 Stufe 2: Startprobe im Labor

Die Startprobe beweist, was Stufe 1 nur folgert: dass aus diesem Snapshot mit diesem ISO ein
startendes System wird, auf anderer Hardware als der Quelle und gegen den Secure-Boot-Stand
echter Firmware.

**Trennung von Worker und Labor.** Das Labor startet von Mandanten kommende, möglicherweise
kompromittierte Systeme in QEMU; ein QEMU-Escape (regelmäßige CVEs in Gerätemodellen) darf
nicht zur Übernahme aller Mandanten werden. Darum:

- Der **Worker** (vertraut, mit Datenbank und Master-Key) plant die Probe (Queue
  `endpoint-boot-probe`, `apps/worker/src/endpoints/boot-probe.ts`), legt die Zeile in
  `endpoint_recoveries` an (Art `probe`, kein Code, Audit `endpoint.boot_probe.started`,
  damit die Sperre gegen Prune greift, 9.7) und öffnet einen **Probe-Listener** für genau
  diese Probe (`packages/core/src/endpoints/loopback.ts`, der Prinzipal wird dafür ein
  Parameter, heute fest `maintenance`; hier `reader`, Präfix des einen Rechners), gebunden
  nur an seine Adresse im internen Netz `lab-net`, mit Einmal-Zugangsdaten (ein Rechner,
  Ablauf 2 Stunden).
- Eine schmale **Labor-API** im Worker (eigener Listener auf `lab-net`, Rolle `lab-broker`,
  Anmeldung mit `RESTOW_LAB_TOKEN`): `POST /internal/lab/next` liefert die nächste Probe
  (Probe-ID, Listener-URL, Zugangsdaten, Repository-Passwort, Snapshot, `layoutSha256`,
  Manifest, Plattengrößen, Firmware), `POST /internal/lab/:probeId/event` (Phasen, z. B.
  `released`), `POST /internal/lab/:probeId/result` (Ergebnis, serielle Ausgabe,
  `screendump` als PNG, höchstens 8 MiB).
- Das **Labor** (`restow-recovery-lab`, eigenes Image, Compose-Profil `recovery-lab`) ist
  nicht das Worker-Image: Node mit nur dem Labor-Bündel (`apps/worker/src/lab.ts` und
  `endpoints/lab/*`, ein Test verlangt, dass es nichts aus `@restow/db` und nichts aus der
  Konfiguration mit Geheimnissen importiert), dazu Debians `qemu-system-x86`, `qemu-utils`,
  `ovmf`, `seabios`, `python3-virt-firmware`. Es bekommt **keine DB-URL und keinen
  Master-Key**, nur `RESTOW_LAB_TOKEN`, die Adresse der Labor-API und `/dev/kvm`.
- QEMU läuft als unprivilegierter Benutzer mit `-sandbox
  on,obsolete=deny,elevateprivileges=deny,spawn=deny,resourcecontrol=deny`, `-nodefaults`,
  ohne USB und Audio, nur mit den Geräten, die die Probe braucht.
- Plattendateien sind `qcow2` mit `encrypt.format=luks` und einem Zufallsschlüssel, der nur im
  Speicher des Labors liegt (`-object secret,id=…,file=/proc/self/fd/N`); nach einem Absturz
  liegt kein Klartext von Mandantendaten in `RESTOW_LAB_DIR`. Nach der Probe werden sie
  gelöscht.

**ISO:** dieselbe Version wie die Instanz, aus `RESTOW_RECOVERY_ISO_DIR` oder vom
GitHub-Release geladen, SHA-256 gegen das signierte `SHA256SUMS` des Images geprüft (8.5;
die Prüfung macht der Worker, das Labor bekommt die erwartete SHA-256 und prüft vor dem
Start noch einmal). Ein ungeprüftes ISO startet das Labor nicht.

**Hardware der Probe** (bewusst anders als die Quelle, damit Gerätenamen- und
Treiberfehler auffallen):

- Controller: Quelle NVMe → Probe AHCI (SATA); Quelle SATA, virtio oder SCSI → Probe NVMe.
  Seriennummern an allen Platten (`serial=`), damit z. B. die LVM-Gerätedatei echte IDs
  enthält und ihr Fixup bewiesen ist.
- Plattenanzahl, -größe und logische Sektorgröße wie gesichert; Netzwerkkarte `e1000e`,
  wenn die Quelle `virtio` hatte, sonst `virtio-net`.
- Firmware wie gesichert: OVMF mit Microsoft-Schlüsseln und Secure Boot, wenn die Quelle
  Secure Boot hatte, sonst OVMF ohne, bzw. SeaBIOS. **Eine** `OVMF_VARS`-Datei für den Start
  des ISO **und** den Start der wiederhergestellten Platten (wie echte Hardware: Die shim des
  ISO kann `SbatLevel` anheben, und die wiederhergestellte Kette muss danach starten), mit
  eingespielter aktueller DBX (`virt-fw-vars --set-dbx`, Datei `dbxupdate_x64.bin` im
  Labor-Image, SHA-256 gepinnt, mit jedem Release aktualisiert). Einmal je Woche startet die
  Probe die wiederhergestellten Platten zusätzlich mit **leeren** NVRAM-Variablen (frische
  `OVMF_VARS` mit DBX), damit der Rückfallpfad `\EFI\BOOT\BOOTX64.EFI` bewiesen ist.

**Ablauf:**

- Restore-VM: ISO mit `--answers` über `fw_cfg` (Passphrase der Probe zufällig, Code
  entfällt, `probe: { fullRestore: [...], emptyFilesystems: [...], emptyDirs: [...] }`),
  Benutzernetz mit `restrict=on` und nur einer `guestfwd`-Regel zum Probe-Listener des
  Workers. Wiederhergestellt werden vollständig: `/`, `/boot`, ESP, `/usr`, `/var` (wenn
  eigene Dateisysteme); alle übrigen Dateisysteme werden mit ihrer Identität **leer**
  angelegt (sie hängen sich ein, das System startet, die Daten beweisen Restore-Test und
  Prüfung).
- **Größengrenze** `RESTOW_LAB_MAX_RESTORE_GIB` (Standard 64): Ist die volle Menge größer,
  werden die größten Ordner unterhalb von `/var/lib`, `/srv`, `/home` (aus den
  Restore-Größen von L8) leer angelegt und nicht geladen, bis die Grenze eingehalten ist; nie
  Paket- und Systemdatenbanken (`/var/lib/dpkg`, `/var/lib/rpm`, `/var/lib/pacman`,
  `/var/lib/systemd`, `/var/lib/selinux`, `/var/lib/dkms`, `/var/lib/shim-signed`,
  `/var/lib/restow-agent`). Die Probe bleibt gültig für die Startkette, der Bericht nennt
  die leeren Ordner. Nur wenn auch das nicht reicht, ist die Probe "nicht möglich (zu groß)".
- Sobald `recover` `RESTOW-PROBE phase=released` auf die serielle Konsole schreibt, meldet
  das Labor `released` an die Labor-API; der Worker schließt den Probe-Listener, das Labor
  entfernt das Netz der VM (`set_link off`, `netdev_del` über QMP). `recover` wartet im
  Probemodus nach `release`, bis keine Schnittstelle außer `lo` mehr Link hat (höchstens
  60 s), bevor die Schritte aus 10.14 beginnen.
- **Start der wiederhergestellten Platten:** zweite QEMU-Maschine nur mit den Zielplatten,
  gleiche Firmware und dieselbe `OVMF_VARS`-Datei, kein Netz, kein `fw_cfg` mit Antworten,
  nur serielle Konsole und VGA. Damit das Ergebnis lesbar ist, ändert `recover` im
  Probemodus auf der Wegwerfkopie genau drei Dinge: Es hängt `console=tty0
  console=ttyS0,115200` an die Kommandozeile der Loader-Einträge an, entfernt `splash`,
  `rhgb` und `quiet` daraus (sonst lenkt Plymouth die Passphrase-Abfrage um) und legt eine
  systemd-Unit `restow-probe.service` an (`WantedBy=multi-user.target`, schreibt
  `RESTOW-PROBE-OK <boot-id> <kernel>` nach `/dev/ttyS0` und schaltet aus). Die Passphrase
  der Probe gibt das Labor an der seriellen Eingabeaufforderung ein (`Please enter
  passphrase`, `Enter passphrase for`); die GRUB-cryptodisk-Abfrage (verschlüsseltes
  `/boot`, E7) erscheint nur auf dem VGA-Terminal, dort tippt das Labor über QMP `send-key`.
  Erfolg: die Zeile `RESTOW-PROBE-OK` innerhalb von 10 Minuten (KVM). Belege: Protokoll von
  `recover`, serielle Ausgabe, bei Misserfolg ein Bild des VGA-Schirms (`screendump`, als
  PNG am Bericht).
- **Wann:** sofort, wenn sich `layoutFingerprint` oder `bootChainFingerprint` gegenüber der
  letzten bestandenen Probe ändern; sonst wöchentlich für den neuesten Bare-Metal-Snapshot;
  auf Anforderung (`POST /api/v1/endpoints/:id/baremetal/probe`). Höchstens eine Probe
  gleichzeitig je Labor (`RESTOW_LAB_CONCURRENCY`, Standard 1). Zeitgrenze insgesamt
  2 Stunden. Ohne `/dev/kvm` (nur TCG) läuft die Probe mit zehnfacher Zeitgrenze, der
  Hinweis steht am Bericht.
- **Bewertung:** Bericht `boot_probe`: grün mit der Zeile `RESTOW-PROBE-OK`; rot nur mit
  Beleg (der Plan scheiterte an einem Problem der Sicherung, `recover`-Prüfung `failed`,
  Kernel-Panik, initramfs findet die Wurzel nicht, Notfallmodus von systemd, Secure-Boot-
  Ablehnung, alles erkannt an festen Mustern der seriellen Ausgabe); alles andere
  (Labor-Fehler, Zeitgrenze ohne Muster, ISO nicht ladbar) unvollständig, wiederholt.
- Nicht-systemd-Systeme: keine Probe ("nicht möglich").
- Ohne Labor gibt es keine Startprobe, und Bare Metal kann nicht grün werden (Offene
  Frage 2).

### 12.4 Fingerabdrücke und Bewertung (Linux)

- `layoutFingerprint`: SHA-256 über die kanonische Struktur des Manifests ohne
  veränderliche Werte (`capturedAt`, `usedBytes`, `inodesUsed`, Seriennummern,
  `network`, Agent-Version): Platten (Anzahl, Tabellenart, Partitionen mit Typ, Größe,
  PARTUUID), md, LUKS (ohne PBKDF-Messwerte), Plain-dm-crypt, LVM, Dateisysteme (Typ, UUID,
  Funktionen), Subvolumes, Einhängepunkte und `fstab`, Firmwaremodus, Bootloader-Art,
  initramfs-Erzeuger und Belegung.
- `bootChainFingerprint`: aus Stufe 1 (L6): SHA-256 über die Liste (Pfad, Größe,
  Änderungszeit) von Kernel, initramfs, Loader-Dateien (mit Authenticode-Hash und SBAT),
  GRUB-Konfiguration, BLS- und Loader-Einträgen und die SHA-256 von `fstab`, `crypttab`,
  `mdadm.conf`, `/etc/default/grub`, `/etc/kernel/cmdline`, `lvm.conf`, `system.devices`.
- **Bare-Metal-Bewertung** (`packages/core/src/endpoints/baremetal/readiness.ts`,
  `baremetalReadiness`), eigene Anzeige neben der Recovery Readiness der Dateien:

| Zustand | Bedeutung |
| --- | --- |
| `not_enabled` | Rechner in keinem Job mit `wholeMachine` |
| `not_possible` | Container, Windows, arm64 (in 0.5.0), Urteil `unsupported` (mit Grund) |
| `no_layout` | noch kein Snapshot mit Manifest |
| `unverified` | Stufe 1 für den neuesten Bare-Metal-Snapshot fehlt oder läuft |
| `layout_checked` | Stufe 1 grün, aber keine bestandene Startprobe für diese Fingerabdrücke (Labor fehlt, Probe ausstehend) |
| `green` | Stufe 1 des neuesten Bare-Metal-Snapshots grün **und** eine grüne Startprobe mit beiden gleichen Fingerabdrücken, höchstens 8 Tage alt |
| `red` | Stufe 1 des neuesten rot, oder die letzte Startprobe mit diesen Fingerabdrücken rot |
| `overdue` | letzte grüne Startprobe mit diesen Fingerabdrücken älter als 8 Tage, keine neuere |

Die Regel "die Bewertung gehört zu dem Backup, das sie geprüft hat" (docs/AGENT.md) bleibt
gewahrt: Grün sagt "ein Snapshot mit genau diesem Layout und genau dieser Startkette ist in
den letzten 8 Tagen nachweislich gestartet", und Stufe 1 belegt für den neuesten, dass er
dieselben Fingerabdrücke hat. Ein Kernel-Update ändert `bootChainFingerprint` und setzt den
Zustand auf `layout_checked`, bis die sofort geplante Probe läuft. Warnungen der Probe
(leere Ordner wegen Größe, NIC-Treiber) stehen an der grünen Bewertung.

### 12.5 macOS: Prüfung `darwin_check`

Stufe 1 und 2 sind Linux-spezifisch (Planer, ISO). Für macOS gibt es eine eigene Prüfung mit
Belegen, damit ein Mac weder ewig `unverified` bleibt noch ohne Beleg grün wird. Queue
`endpoint-darwin-check`, Job `apps/worker/src/endpoints/darwin-check.ts`, Bericht der neuen
Art `darwin_check` (Migration 0078), geplant nach jedem Ganz-Rechner-Lauf eines Macs:

| Nr. | Prüfung | Wie | Rot nur bei |
| --- | --- | --- | --- |
| D1 | Manifest gültig | `parseLayoutManifest` mit `platform: "darwin"` | ungültigem Manifest |
| D2 | Manifest im Snapshot | `restic dump <snap> <manifestPathInSnapshot("darwin", tags)>`, SHA-256 gleich | Abweichung oder fehlender Datei |
| D3 | Benutzerdaten | jeder Benutzer des Manifests hat im Snapshot einen nicht leeren Home-Ordner mit `Library/Preferences` (`restic ls`) | fehlendem oder leerem Home |
| D4 | Schlüsselbund | `Library/Keychains/login.keychain-db` je Benutzer vorhanden, die ersten 4 Byte über `restic dump` sind `kych` | fehlender oder falscher Datei |
| D5 | Restore-Test | der vorhandene Restore-Test ist für diesen Snapshot grün | rotem Restore-Test |
| D6 | Konsistenz | `consistency.method = apfs`, `state = used` | nie rot; sonst Warnung |

Zustände für darwin in `baremetalReadiness`: `not_enabled`, `no_layout`, `unverified`,
`green` (D1 bis D5 grün für den neuesten Snapshot), `red`, `overdue` (D5 älter als 8 Tage).
Text bei grün: "Daten für ein Neuaufsetzen geprüft; die Neuinstallation von macOS selbst kann
Restow nicht prüfen." Tests: je Zeile ein Vitest in `readiness.test.ts`, je Prüfung ein Test
in `darwin-check.test.ts` gegen ein Repository mit `rest-server`.

### 12.6 Alarme

Neue Ereignisse (Gruppe Wiederherstellbarkeit bzw. Sicherheit, gleiche Regeln und Ausgänge
wie die übrigen, docs/AGENT.md "Alarme"): `baremetal.red` (Fehler, je Episode einmal),
`baremetal.recovered`, `baremetal.overdue` (Warnung), `endpoint.recovery.failed` (eine
Wiederherstellung mit `failed`), und als **Sicherheitsereignisse**, die sofort an die
Mandanten-Admins gehen (Mail und Webhook), nicht nur ins Audit:
`endpoint.recovery.started` (ein Code wurde eingetauscht), `endpoint.recovery_code.rejected`
(ein toter Code wurde versucht), `endpoint.rebound` (ein Rechner hat ein neues Secret),
`endpoint.fda_missing` (macOS ohne Festplattenvollzugriff, Warnung, Abschnitt 13.3). Webhook
`job.failed` mit `queue: endpoint_baremetal_check`, `endpoint_boot_probe` bzw.
`endpoint_darwin_check` für rote Berichte (nicht für unvollständige).

## 13. macOS: Mac neu aufsetzen

### 13.1 Grundsatz

Entscheidung: macOS neu installieren, dann Daten und Einstellungen aus der
APFS-Snapshot-Sicherung zurückholen. Kein ISO, kein Systemabbild (das versiegelte
Systemvolume lässt sich ohnehin nur von Apple installieren). Zurückgeholt werden die
Home-Ordner ausgewählter Benutzer und per Drag-and-drop installierte Programme; alles
andere nennt der Assistent ("neu installieren", "kommt über iCloud", "neu erteilen").

### 13.2 Sicherung

- **Quelle** unter `wholeMachine`: das ganze Data-Volume vom APFS-Snapshot (Abschnitt 7),
  `<APFSMountPoint>` mit `-x`, dazu neu `DEFAULT_DARWIN_WHOLE_MACHINE_EXCLUDES` in
  `packages/core/src/endpoints/whole-machine.ts` (Data-Volume-relativ, `pathmap.go` setzt das
  Präfix davor). Jede Zeile mit Begründung im Code; abgeleitet aus Apples
  `/System/Library/CoreServices/backupd.bundle/Contents/Resources/StdExclusions.plist`:

| Ausschluss | Grund |
| --- | --- |
| `private/var/vm` | `sleepimage` und Swap-Dateien, mehrere GiB je Lauf |
| `private/var/folders` | Caches und temporäre Dateien je Benutzer, von macOS neu angelegt |
| `private/var/tmp`, `private/tmp` | temporär |
| `.Spotlight-V100`, `.fseventsd`, `.DocumentRevisions-V100`, `.TemporaryItems`, `.MobileBackups*` | Index- und Verwaltungsdaten des Systems, teils auch mit Festplattenvollzugriff nicht lesbar |
| `Library/Caches`, `Library/Logs`, `Library/Updates` | entbehrlich bzw. von macOS neu geladen |
| `Users/*/Library/Caches`, `Users/*/.Trash` | Caches, Papierkorb |
| `Users/*/Library/Mobile Documents`, `Users/*/Library/CloudStorage` | Cloud-Ordner (iCloud Drive, OneDrive, Dropbox, Google Drive); siehe unten |
| `private/var/db/uuidtext`, `private/var/db/diagnostics` | Unified Logging |
| `System/Library/Caches`, `System/Library/Assets*`, `System/Library/PreinstalledAssets*` | Firmlink-Ziele mit Systemressourcen, die macOS selbst lädt |

  Gesichert werden damit u. a. `/Users` (auch `/Users/Shared`), `/Applications`, `/Library`,
  `/usr/local`, `/opt` (auch `/opt/homebrew`), `/private/etc`, `/private/var/root` und das
  Manifest. `/Library`, `/private/etc` und `/private/var/root` werden in 0.5.0 nicht
  zurückgespielt, aber gesichert, damit eine spätere Version es kann und von Hand nichts
  fehlt. Freigabe-Gate (21.4 Punkt 29): Zwei Läufe hintereinander auf einem frischen Mac mit
  Festplattenvollzugriff enden `succeeded`, nicht `partial`; welche Pfade sonst unlesbar
  sind, zeigt der CI-Job `agent-macos` ([CI]) und ergänzt die Liste.
- **Cloud-Ordner:** Unter macOS gibt es keine `--exclude-cloud-files`-Entsprechung (1.2), und
  "dataless" Dateien (SF_DATALESS) in `~/Library/Mobile Documents`, `~/Library/CloudStorage`
  und bei "Schreibtisch & Dokumente in iCloud" auch in `~/Desktop` und `~/Documents` würden
  live gelesen heruntergeladen (die Platte läuft voll) und aus dem nur lesbaren Snapshot
  gelesen fehlschlagen. Darum der Standardausschluss oben, UI-Text: "Cloud-Ordner (iCloud
  Drive, OneDrive, Dropbox, Google Drive) werden nicht gesichert; sie kommen über den
  Anbieter zurück." Lesefehler an dataless Dateien außerhalb dieser Ordner (Desktop und
  Dokumente in iCloud) bekommen den eigenen Code `cloud_file_skipped` (Hinweis mit Anzahl)
  und machen den Lauf nicht `partial`; erkannt am Flag `SF_DATALESS` (`stat -f %Xf`, bzw.
  `syscall.Stat_t.Flags`) des fehlgeschlagenen Pfads im Snapshot. [CI] wie restic eine
  dataless Datei aus dem Snapshot liest (1.2 Punkt 5).
- **Manifest** `restow-layout-v1` mit `platform: "darwin"` (`capture_darwin.go`, M6):
  - System: macOS-Version und Build (`sw_vers`), `arch` (`uname -m`), `model`
    (`sysctl hw.model`), `sip` (`csrutil status`), `ssv` (`csrutil authenticated-root
    status`), `fileVault` (`fdesetup status`), `activationLock` (`system_profiler
    SPHardwareDataType`), `mdm` und `ade` (`profiles status -type enrollment`),
    `bootstrapToken` (`profiles status -type bootstraptoken`), `systemExtensions`
    (`systemextensionsctl list`, Bundle-IDs), `icloudDesktopDocuments` (ob
    "Schreibtisch & Dokumente in iCloud" an ist, aus `defaults read` von `com.apple.bird`
    bzw. den xattrs der Ordner; [Maschine]).
  - Benutzer (`dscl . -list /Users UniqueID`, UID ab 501): Kurzname, UID, `RealName`,
    `NFSHomeDirectory`, `UserShell`, `admin` (Gruppe `admin`), `secureToken`
    (`sysadminctl -secureTokenStatus <n>`), `hidden` (`dscl . -read /Users/<n> IsHidden`),
    `mdmManaged` (Kennzeichen des MDM-Verwaltungskontos), Größe des Home-Ordners. Versteckte
    und MDM-Konten bietet der Assistent nicht zur Migration an.
  - Programme in `/Applications` (Name, Bundle-ID, Version) mit Klasse: `appstore`
    (`Contents/_MASReceipt` vorhanden), `pkg` (`pkgutil --file-info <pfad>` nennt ein
    Paket), `cask` (unter `/opt/homebrew/Caskroom` bzw. `/usr/local/Caskroom` geführt),
    sonst `dragdrop`; `archs` des Hauptbinarys (`lipo -archs`).
  - Kein Plattenlayout (nicht gebraucht).

### 13.3 Festplattenvollzugriff und Signatur des Agenten

- TCC bindet den Festplattenvollzugriff eines ad hoc signierten Programms an dessen cdhash.
  Das macOS-Binary ist heute nur ad hoc signiert (1.1); nach jedem Selbst-Update ist die
  Freigabe still weg (der Schalter in den Systemeinstellungen bleibt an, wirkt aber nicht),
  und ab dann scheitert `mount_apfs` bzw. das Lesen auf allen Macs gleichzeitig. Ein
  MDM-PPPC-Profil (Flottenweg) braucht eine stabile Code-Requirement, die es so nicht gibt.
- **Vorschlag (25.B19, Offene Frage 11):** macOS-Binaries werden mit Developer ID signiert
  und notarisiert (`release.yml`, neuer Job `agent-macos-sign` auf einem macOS-Runner mit dem
  Zertifikat des Maintainers als Secret, `codesign --options runtime --timestamp`,
  `xcrun notarytool submit --wait`; die SHA-256 in `agent-SHA256SUMS` gilt für das
  signierte Binary). Dann bleibt die Freigabe über Updates erhalten, und die Oberfläche bietet
  ein PPPC-Profil (`SystemPolicyAllFiles` für die Code-Requirement `identifier
  "<Code-Kennung des Agenten>" and anchor apple generic and certificate leaf[subject.OU] =
  "<Team-ID>"`, beide legt der Maintainer mit dem Zertifikat fest) zum Herunterladen.
- **Falls abgelehnt:** bekannte Grenze "Festplattenvollzugriff nach jedem Update neu
  erteilen"; der Selbst-Update-Pfad (`agent/internal/update`) prüft nach dem Neustart den
  Zugriff und meldet `fda_lost` im Heartbeat, die Oberfläche zeigt es am Rechner.
- **Heartbeat** `fullDiskAccess: "granted" | "denied" | "unknown"`
  (`agent/internal/sysinfo/sysinfo_darwin.go`): `open(O_RDONLY)` auf
  `/Library/Application Support/com.apple.TCC/TCC.db`; `EPERM` heißt `denied`, Erfolg
  `granted`, alles andere `unknown`. Alarm `endpoint.fda_missing` (Warnung), wenn ein Mac in
  einem Job mit `wholeMachine` `denied` meldet.
- Text im Assistenten: "Öffnen Sie Systemeinstellungen > Datenschutz & Sicherheit >
  Festplattenvollzugriff, klicken Sie +, drücken Sie Cmd+Shift+G und geben Sie
  `/Library/Application Support/Restow/bin/restow-agent` ein." mit dem Link
  `x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles`; der Zustand
  aus dem Heartbeat wird live angezeigt.

### 13.4 Assistent "Mac neu aufsetzen"

`apps/web/src/features/endpoints/components/mac-setup-wizard.tsx`, Route
`/inventory/<id>/mac-setup` (`<id>` ist der alte Mac):

1. **Sicherungsstand:** Snapshot **fest** wählen (Vorauswahl: neuester mit grüner
  `darwin_check`, sonst neuester; `snapshotId` geht in die Params, nie `latest`), Benutzer
  mit Größe, Programme mit Klasse, Quell-Version und -Architektur, Konsistenz (live:
  Warnung).
2. **Neuen Mac vorbereiten:** je Ziel-Architektur der Weg in die macOS-Wiederherstellung
  (Apple Silicon: Ein/Aus gedrückt halten → Optionen; Intel: Cmd-R, bzw. Option-Cmd-R für
  die neueste kompatible Version). Text: "Ist macOS danach älter als <Version>, zuerst
  Softwareupdate ausführen." Aktivierungssperre ("ohne die Apple-ID des Vorbesitzers geht es
  nicht weiter"), bei ADE: "Der Setup-Assistent folgt Ihrem MDM; legen Sie das Hilfskonto
  nach dessen Regeln an." Im Setup-Assistenten Migrationsassistent überspringen, einen
  **Hilfsadministrator** anlegen (Vorschlag "Restow Setup", Kurzname `restowsetup`; er bekommt
  meist UID 501), **keinen** Benutzer mit einem Kurznamen aus der Sicherung. Empfehlung:
  FileVault einschalten und den Wiederherstellungsschlüssel sicher aufbewahren.
3. **Alter Mac:** "wird ersetzt" (Wiederanbindung, der alte verliert seine Verbindung) oder
  "läuft weiter" (der neue wird ein eigener Rechner, liest das Repository des alten nur),
  Abschnitt 13.6.
4. **Agent installieren und Festplattenvollzugriff:** Wiederanbindungs-Token
  (`purpose: "mac_setup"`) bzw. Enrollment-Token (`purpose: "mac_setup"`) mit
  Installationsbefehl; Live-Status aus dem Heartbeat (verbunden, `fullDiskAccess`),
  Anleitung aus 13.3.
5. **Konten anlegen:** Für jeden zurückzuholenden Benutzer legt der Administrator auf dem Mac
  in Systemeinstellungen > Benutzer & Gruppen ein Konto mit **demselben Kurznamen** an und
  meldet sich damit nicht an. Text: "Vergeben Sie dasselbe Passwort wie auf dem alten Mac;
  dann öffnet sich der Anmeldeschlüsselbund ohne Rückfrage." Live-Liste aus dem Heartbeat
  `macUsers` (Kurzname, UID, angemeldet ja/nein, `secureToken`, `volumeOwner`): fehlt,
  vorhanden, angemeldet, SecureToken.
6. **Prüfen (Trockenlauf):** Aufgabe `restore` mit `mode: "darwin_migration"` und
  `dryRun: true`: je Benutzer Bytes (mit Faktor aus 13.5), freier Platz
  (`statfs /System/Volumes/Data`), Konflikte (Home nicht frisch, Konto fehlt, angemeldet),
  Architekturhinweise, Programme je Klasse; es wird nichts geschrieben.
7. **Zurückholen** mit Fortschritt je Benutzer.
8. **Abschluss-Checkliste:** Anmeldung je Benutzer, Schlüsselbund, iCloud anmelden,
  TCC-Rückfragen (Kamera, Bedienungshilfen) neu erteilen, Liste "neu installieren"
  (App Store, `pkg`, Intel-only ohne Rosetta, Homebrew bei Architekturwechsel), Cloud-Ordner
  über den Anbieter, Hilfsadministrator löschen (nur unter der Bedingung aus 13.5),
  "Sicherungen wieder aufnehmen" (13.6).

### 13.5 Zurückholen (`darwin_migration`)

Aufgabe `restore` mit `params = { mode: "darwin_migration", snapshotId, users: [kurznamen],
applications: true|false, rosetta: true|false, skip: [...], dryRun, recoveryId? }`
(`RestoreParams` in `agent/internal/api/types.go` und
`apps/api/src/features/endpoints/schemas.ts`). Der Agent
(`agent/internal/core/migrate_darwin.go`):

- lehnt ab, wenn ein Benutzer angemeldet ist (`stat -f%Su /dev/console`, `who`, auch über
  schnellen Benutzerwechsel) oder sein Konto fehlt;
- verschiebt einen schon vorhandenen Ordner `/Users/<n>` nach
  `/Users/.restow-fresh-<n>-<zeit>` (nichts wird gelöscht oder überschrieben, die Regel der
  Restores bleibt). Existiert der Home-Ordner noch nicht (Konto angelegt, Home entsteht erst
  bei der ersten Anmeldung), ist nichts beiseitezulegen;
- stellt `/Users/<n>` her mit `restic restore <id>:<präfix>/Users/<n> --target /Users/<n>
  --ownership-by-name --sparse --verify --overwrite never --exclude-xattr com.apple.macl
  --exclude-xattr com.apple.provenance --exclude-xattr com.apple.rootless [--exclude …]`
  (Unterordner-Syntax, `restic restore --help` 0.19.1; gleiches Muster für xattrs wie
  `share/restore.go`). `prepareRestoreTarget` greift unverändert, weil das Ziel nach dem
  Beiseitelegen nicht existiert und `/Users` root gehört. Besitzer nach Name, weil die UIDs
  auf dem neuen Mac andere sind;
- danach Fixups mit Prüfung des Exit-Codes: `chown <n>:staff /Users/<n>`,
  `diskutil resetUserPermissions / <uid>` (setzt u. a. die Standard-ACLs "everyone deny
  delete" auf `~/Desktop`, `~/Documents`, `~/Library`), `chflags hidden /Users/<n>/Library`;
- lässt standardmäßig aus (`DARWIN_MIGRATION_SKIP` in `migrate_darwin.go`, je Zeile mit
  Begründung, im Assistenten unter "Erweitert" abwählbar):
  `Library/Application Support/com.apple.TCC` (Freigaben mit alten Code-Requirements),
  `Library/Keychains/*-*-*-*-*` (UUID-Ordner: Data-Protection-Daten der alten Hardware),
  `Library/Mobile Documents`, `Library/CloudStorage` (brächen die File-Provider-Domänen);
  Hinweis bei `Pictures/*.photoslibrary`: "Wenn iCloud-Fotos an ist, nicht zurückholen
  (Dubletten)". [Maschine] ob `containermanagerd` zurückgeholte `~/Library/Containers`
  verwirft;
- **Programme** (`applications: true`): zurückgeholt wird nur Klasse `dragdrop`, auf Apple
  Silicon nur mit `arm64` in `archs` (bzw. universal), `x86_64`-only nur, wenn
  `rosetta: true` (dann vorher `softwareupdate --install-rosetta --agree-to-license`; die
  Frage stellt der Assistent), nur wenn `/Applications/<x>.app` noch nicht existiert
  (`--overwrite never`). `appstore`, `pkg` (Helfer in `/Library/LaunchDaemons`,
  `/Library/PrivilegedHelperTools` und Systemerweiterungen werden nicht zurückgespielt,
  halb funktionierende VPN-Clients, Virenscanner und Treiber wären die Folge) und `cask`
  stehen auf der Liste "neu installieren". Homebrew (`/opt/homebrew`, `/usr/local`) nie über
  Architekturen hinweg. Besitzer, die es auf dem neuen Mac nicht gibt, werden zu
  `root:admin`; das steht im Bericht;
- **Platz:** Der Trockenlauf rechnet mit der Restore-Größe je Home-Ordner und Faktor 1,3 auf
  die gesicherte Größe von `/Applications` (HFS-/APFS-Kompression kommt entpackt zurück, 1.2
  Punkt 5);
- meldet je Benutzer Dateien, Bytes, Fehler, ausgelassene Pfade.
- **Ältere Snapshots ohne Manifest** (jeder Mac-Kunde hat heute `/Users`-Sicherungen,
  `config.ts` Zeile 142): `darwin_migration` nimmt auch sie. Die Benutzerliste kommt dann aus
  `restic ls <snap> /Users` (ohne `Shared`, `Guest`, `.localized`), `admin` und
  `secureToken` gelten als "unbekannt" (der Assistent fragt), Programme gibt es nicht, und die
  Konsistenz "live" steht als Warnung da. Unit- und Integrationstest mit einem 0.4-Snapshot.
- **Hilfsadministrator löschen** bietet der Assistent erst an, wenn mindestens ein
  zurückgeholter Benutzer Admin mit SecureToken ist (Apple Silicon: zusätzlich Volume Owner,
  `diskutil apfs listUsers /`) und in `fdesetup list` steht. Sonst: "Mindestens ein
  Administrator mit SecureToken fehlt; löschen Sie 'Restow Setup' noch nicht." Ohne das
  schlösse sich der Kunde von FileVault-Entsperrung und Softwareupdates aus.

### 13.6 Alter Mac: ersetzen oder weiterlaufen

Der häufigste Fall ist "neuer Mac, der alte läuft noch". Würde der neue über ein
Wiederanbindungs-Token zum alten Rechner, verlöre der alte seine Sicherung, bevor die Daten
drüben sind, und der neue bekäme volle Agent-Rechte auf das alte Repository. Darum wählt der
Assistent in Schritt 3:

- **(a) ersetzt:** Wiederanbinden mit `purpose: "mac_setup"` (Abschnitt 11). Der neue Mac ist
  der alte Endpunkt, `darwin_migration` liest mit seinem eigenen Zugang (`agent`).
- **(b) läuft weiter:** Der neue Mac wird mit einem gewöhnlichen Enrollment-Token
  (`purpose: "mac_setup"`) als **eigener** Rechner angebunden. Für das Zurückholen legt der
  Server eine Zeile in `endpoint_recoveries` an, Art `migration` (Migration 0078):
  `endpoint_id` = alter Mac, `target_endpoint_id` = neuer Mac, Gültigkeit 4 Stunden,
  höchstens 48, einmal einlösbar, ausgestellt vom Admin im Assistenten mit frischer
  Anmeldung (die Freigabe ist damit erteilt), auditiert wie ein Code
  (`endpoint.recovery_code.created` mit `kind: "migration"`, `endpoint.recovery.started`).
  Die Aufgabe `darwin_migration` an den neuen Mac trägt `params.recoveryId`. Der Agent des
  neuen Macs erzeugt das Sitzungsgeheimnis, schickt nur den Hash
  (`POST /agent/v1/recovery/migrations/:recoveryId/claim`, angemeldet als **neuer** Mac; der
  Server prüft `target_endpoint_id`) und liest mit Basic `<sessionId>:<sessionSecret>` über
  `/agent/recovery/restic/:sessionId` mit dem Prinzipal `reader` auf dem Repository des
  **alten** Rechners (9.6). Danach `release` und `finish` wie im ISO. Der alte Mac sichert
  unverändert weiter.
- **Sicherungspause:** Ein Enrollment bzw. eine Wiederanbindung mit `purpose: "mac_setup"`
  setzt `endpoints.config.migrationPending = true`. Der Agent sichert dann nicht planmäßig,
  bis `darwin_migration` `succeeded` ist (der Server setzt das Feld zurück) oder ein Admin
  "Sicherungen wieder aufnehmen" wählt (Audit `endpoint.config.changed`). Grund: Die erste
  Sicherung des fast leeren neuen Macs würde sonst neuester Snapshot, der Ransomware-Vergleich
  meldete eine Massenlöschung, und die Aufbewahrung behielte den leeren Snapshot statt
  älterer guter. Der erste Lauf nach der Wiederanbindung ist zudem neue Basis der
  Ransomware-Signale (11). Postgres-Test "rebind mac_setup → kein Lauf bis Migration".

### 13.7 Meldungen

Codes mit Ort und Text; ein Test in `packages/i18n` verlangt jeden Code in de und en
(`packages/i18n/resources/{de,en}/endpoints.json`, `macSetup.messages.*`):

| Code | Ort | Text (de) |
| --- | --- | --- |
| `fda_missing` | Schritt 4, Rechnerseite | "Restow hat keinen Festplattenvollzugriff. Systemeinstellungen > Datenschutz & Sicherheit > Festplattenvollzugriff." |
| `fda_lost` | Rechnerseite | "Nach dem Update fehlt der Festplattenvollzugriff; bitte neu erteilen." |
| `mac_user_logged_in` | Schritt 5 bis 7 | "<n> ist angemeldet; bitte abmelden (auch über schnellen Benutzerwechsel)." |
| `mac_user_missing` | Schritt 5 bis 7 | "Konto <n> fehlt auf diesem Mac." |
| `macos_too_old` | Schritt 2, 6 | "macOS <ist> ist älter als <gesichert>; zuerst Softwareupdate." |
| `arch_changed` | Schritt 1, 6 | "Gesichert auf Intel, dieser Mac hat Apple Silicon: Homebrew und Intel-Programme werden nicht zurückgeholt." |
| `rosetta_needed` | Schritt 6 | "<k> Programme laufen nur mit Rosetta; Rosetta installieren und zurückholen?" |
| `insufficient_space` | Schritt 6 | "Es fehlen <x> GB auf diesem Mac." |
| `home_not_fresh` | Schritt 6, 7 | "/Users/<n> enthält schon eigene Dateien (<k>); beiseitegelegt nach /Users/.restow-fresh-<n>-<zeit>." |
| `secure_token_missing` | Schritt 8 | "Mindestens ein Administrator mit SecureToken fehlt; löschen Sie 'Restow Setup' noch nicht." |
| `activation_lock` | Schritt 2 | "Die Aktivierungssperre ist an; ohne die Apple-ID des Vorbesitzers geht es nicht weiter." |
| `snapshot_without_manifest` | Schritt 1 | "Diese Sicherung stammt von vor 0.5.0; Benutzer aus /Users, Adminrechte unbekannt." |
| `migration_pending` | Rechnerseite | "Sicherungen pausiert bis zum Zurückholen der Daten." |

### 13.8 Grenzen (macOS, 0.5.0)

Kein Zurückspielen von `/Library`, Systemeinstellungen, Netzwerk, Druckern, Launch-Daemons
und Systemerweiterungen anderer Hersteller, App-Store-, `pkg`- und Cask-Programmen
(Liste "neu installieren"), Cloud-Ordnern; keine Konten, Passwörter, SecureTokens oder
FileVault-Wiederherstellungsschlüssel; keine Wiederherstellung auf ein älteres macOS. ACLs
außer den Standard-ACLs des Home-Ordners, BSD-Flags und Erstellungsdaten werden nicht
wiederhergestellt (1.2 Punkt 5, [Quelle]). Vorschau bis zum Freigabetest auf einem
Apple-Silicon- und einem Intel-Mac (Abschnitt 21.4).

## 14. Server-Änderungen

### 14.1 `packages/core`

- `endpoints/baremetal/manifest.ts` (neu): `layoutManifestSchema`
  (`z.discriminatedUnion("platform", [linuxLayoutSchema, darwinLayoutSchema])`),
  `parseLayoutManifest`, `canonicalLayoutJson`, `layoutSha256`, `noControlChars`, Grenzen
  (512 KiB, Listenlängen).
- `endpoints/baremetal/fingerprint.ts`: `layoutFingerprint`, `bootChainFingerprint`.
- `endpoints/baremetal/summary.ts`: `summarizeLayout` (für die Oberfläche: Platten mit
  Größe und Inhalt, Stapel als Baum, Firmware, Bootloader, Distribution, Verschlüsselung;
  darwin: Benutzer, Programme nach Klasse, System).
- `endpoints/baremetal/check.ts`: reine Bewertung der Stufe 1 aus den gesammelten Fakten
  (`judgeLayoutCheck`), `fstab`/`crypttab`-Zerleger (`parseFstab`, `parseCrypttab`),
  Auflösung gegen das Manifest (`resolveFstabSource`), `judgeDarwinCheck`.
- `endpoints/baremetal/probe.ts`: Muster der seriellen Ausgabe, `judgeBootProbe`.
- `endpoints/baremetal/readiness.ts`: `baremetalReadiness` (12.4, 12.5).
- `endpoints/baremetal/recovery-code.ts`: 9.1 (mit `canonicalOrigin`, Testvektoren).
- `endpoints/baremetal/paths.ts`: `manifestPathInSnapshot`.
- `endpoints/whole-machine.ts`: `DEFAULT_WHOLE_MACHINE_EXCLUDES`,
  `DEFAULT_DARWIN_WHOLE_MACHINE_EXCLUDES`, `wholeMachineConfigWire`.
- `endpoints/config.ts`: `EndpointConfig.wholeMachine?`, `fsSnapshot?`, `migrationPending?`,
  `activityBaselinePending?`; `GET /config`-Draht.
- `endpoints/run-errors.ts`: `layout_capture_failed`, `layout_too_large`, `layout_rejected`,
  `cloud_file_skipped`.
- `endpoints/run-failures.ts`, `failures/types.ts`, `failures/catalog.ts`: Codes
  `endpoint.layout_capture_failed`, `endpoint.baremetal_check_failed`,
  `endpoint.boot_probe_failed`, `endpoint.darwin_check_failed`, `endpoint.recovery_failed`,
  `endpoint.fda_missing`; Schritte `check_endpoint_layout_tools`, `read_baremetal_report`,
  `run_boot_probe_again`, `grant_full_disk_access`.
- `endpoints/run-redact.ts`: Muster `RC-…`, `rset_…`, 64-stellige Hex-Werte nach `session`,
  `codeProof`, `secret`, `password`; `stripAnsi` für Recovery-Logs.
- `endpoints/queues.ts`: `endpoint-baremetal-check`, `endpoint-boot-probe`,
  `endpoint-darwin-check`.
- `endpoints/restore-target.ts`: `restoreSelectionIssue` (5.4).
- `endpoints/pathmap.ts` (neu): `snapshotRootOf`, `toViewPath`, `fromViewPath`
  (Abschnitt 7, drei Formen).

### 14.2 `packages/db`: eine Migration je Meilenstein

Jeder Meilenstein bringt seine eigene Migration mit (`packages/db/drizzle/<nnnn>_*.sql`,
`meta/_journal.json`, Schema in `packages/db/src/schema/endpoints.ts`), damit das Schema von
M3 bis M6 nicht festgelegt ist, bevor deren Entwurf in der Umsetzung geprüft ist (`ADD VALUE`
lässt sich nicht zurücknehmen). Die Nummern sind die nächsten freien beim Merge (heute ab
0074); kommt auf `release/0.5.0` vorher eine andere Migration dazu, rücken sie nach.
`ADD VALUE` steht in jeder Migration vorn und ohne Verwendung in derselben Migration (wie
0056).

**0074_baremetal_layouts** (M1):

```sql
CREATE TABLE "endpoint_layouts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "endpoint_id" uuid NOT NULL REFERENCES "endpoints"("id") ON DELETE CASCADE,
  "sha256" text NOT NULL,
  "format" text NOT NULL,
  "schema_version" integer NOT NULL,
  "platform" text NOT NULL CHECK ("platform" IN ('linux', 'darwin')),
  "manifest" jsonb NOT NULL,
  "summary" jsonb NOT NULL,
  "verdict" text NOT NULL,
  "layout_fingerprint" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE UNIQUE INDEX "endpoint_layouts_endpoint_sha_uq" ON "endpoint_layouts" ("endpoint_id", "sha256");--> statement-breakpoint
ALTER TABLE "endpoint_runs" ADD COLUMN "layout_id" uuid REFERENCES "endpoint_layouts"("id") ON DELETE SET NULL;
```

**0075_baremetal_check** (M2):

```sql
ALTER TYPE "public"."endpoint_report_kind" ADD VALUE 'baremetal_check';
```

**0076_endpoint_recoveries** (M3):

```sql
CREATE TYPE "public"."endpoint_recovery_status" AS ENUM
  ('issued', 'pending_approval', 'active', 'finishing', 'succeeded', 'failed', 'cancelled',
   'expired', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."endpoint_recovery_kind" AS ENUM ('code');--> statement-breakpoint
CREATE TABLE "endpoint_recoveries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "endpoint_id" uuid NOT NULL REFERENCES "endpoints"("id") ON DELETE CASCADE,
  "kind" "endpoint_recovery_kind" NOT NULL,
  "status" "endpoint_recovery_status" NOT NULL DEFAULT 'issued',
  "code_hash" text,                        -- SHA-256(codeProof), nur bei kind = code
  "instance_origin" text,                  -- canonicalOrigin beim Ausstellen
  "spki_sha256" text,                      -- Prüfwert der Instanz oder NULL
  "require_approval" boolean NOT NULL DEFAULT true,
  "snapshot_id" text,
  "issued_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz NOT NULL,
  "created_by" text REFERENCES "user"("id") ON DELETE SET NULL,
  "revoked_at" timestamptz, "revoked_by" text REFERENCES "user"("id") ON DELETE SET NULL,
  "used_at" timestamptz, "used_ip" text,
  "session_secret_hash" text,
  "approved_at" timestamptz, "approved_by" text REFERENCES "user"("id") ON DELETE SET NULL,
  "credentials_issued_at" timestamptz,
  "released_at" timestamptz,
  "recovery_version" text,
  "hardware" jsonb,
  "ssh_keys" jsonb,
  "ssh_host_keys" jsonb,
  "progress" jsonb,
  "verification" jsonb,
  "warnings" jsonb,
  "log_bytes" integer NOT NULL DEFAULT 0,
  "cancel_requested_at" timestamptz,
  "finished_at" timestamptz,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "endpoint_recoveries_max_48h" CHECK ("expires_at" <= "issued_at" + interval '48 hours')
);--> statement-breakpoint
CREATE UNIQUE INDEX "endpoint_recoveries_code_uq" ON "endpoint_recoveries" ("code_hash") WHERE "code_hash" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "endpoint_recoveries_endpoint_idx" ON "endpoint_recoveries" ("endpoint_id", "issued_at");--> statement-breakpoint
CREATE INDEX "endpoint_recoveries_active_idx" ON "endpoint_recoveries" ("endpoint_id") WHERE "status" IN ('active', 'finishing');--> statement-breakpoint
CREATE TABLE "endpoint_recovery_log" (
  "id" bigserial PRIMARY KEY,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "recovery_id" uuid NOT NULL REFERENCES "endpoint_recoveries"("id") ON DELETE CASCADE,
  "at" timestamptz NOT NULL DEFAULT now(),
  "lines" text NOT NULL
);--> statement-breakpoint
ALTER TABLE "endpoint_enrollment_tokens" ADD COLUMN "endpoint_id" uuid REFERENCES "endpoints"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "endpoint_enrollment_tokens" ADD COLUMN "purpose" text CHECK ("purpose" IN ('baremetal', 'reinstall', 'mac_setup'));--> statement-breakpoint
ALTER TABLE "endpoint_enrollment_tokens" ADD COLUMN "unrevoke" boolean NOT NULL DEFAULT false;--> statement-breakpoint
ALTER TABLE "endpoint_enrollment_tokens" ADD CONSTRAINT "endpoint_enrollment_tokens_rebind_24h"
  CHECK ("endpoint_id" IS NULL OR "expires_at" <= "created_at" + interval '24 hours');--> statement-breakpoint
ALTER TABLE "endpoint_runs" ADD COLUMN "activity_baseline" boolean NOT NULL DEFAULT false;
```

**0077_boot_probe** (M5):

```sql
ALTER TYPE "public"."endpoint_report_kind" ADD VALUE 'boot_probe';--> statement-breakpoint
ALTER TYPE "public"."endpoint_recovery_kind" ADD VALUE 'probe';
```

**0078_darwin_check** (M6):

```sql
ALTER TYPE "public"."endpoint_report_kind" ADD VALUE 'darwin_check';--> statement-breakpoint
ALTER TYPE "public"."endpoint_recovery_kind" ADD VALUE 'migration';--> statement-breakpoint
ALTER TABLE "endpoint_recoveries" ADD COLUMN "target_endpoint_id" uuid REFERENCES "endpoints"("id") ON DELETE CASCADE;
```

- Row Level Security für `endpoint_layouts`, `endpoint_recoveries`, `endpoint_recovery_log`
  wie für die übrigen Mandantentabellen (`packages/db/sql/rls.sql`, Liste bei
  `endpoint_downloads`), jeweils in der Migration, die die Tabelle anlegt. Der Code-Tausch
  läuft vor dem Festlegen eines Mandanten und sucht über `code_hash` mit der
  Installationsrolle (wie die Agent-Anmeldung, `agent-auth.ts`), danach alles in der
  Mandanten-Transaktion.
- Aufbewahrung: `endpoint_recovery_log` 90 Tage (Monitor), Layouts solange ein Lauf auf sie
  zeigt oder sie das neueste des Rechners sind (Monitor räumt täglich).
- `endpoint_runs.layout_id` statt einer eigenen Snapshot-Tabelle: Snapshot-ID und Lauf
  gehören schon zusammen (`endpoint_runs.snapshot_id`).
- `endpoint_enrollment_tokens.endpoint_id`: `NULL` = Enrollment wie bisher, gesetzt =
  Wiederanbindung (Abschnitt 11). `purpose` gilt für beide Arten (`mac_setup` auch beim
  Enrollment des neuen Macs, 13.6). `GET /api/v1/endpoints/tokens` zeigt Art und Zweck.
- Ein Test (`migrations.pg.test.ts`) spielt jede der Migrationen einzeln auf den Stand davor
  ein, damit jeder Meilenstein für sich mergebar bleibt.

### 14.3 `apps/api`

Neue Dateien in `apps/api/src/features/endpoints/`:

| Datei | Inhalt |
| --- | --- |
| `baremetal.ts` | `getBaremetalState` (Karte der Rechnerseite), `getLayout`, `requestBootProbe` |
| `recovery-codes.ts` | `issueRecoveryCode` (mit Prüfwert der Instanz), `revokeRecoveryCode`, `extendRecoveryCode`, `listRecoveries`, `getRecovery`, `approveRecovery`, `cancelRecovery`, `setRecoverySshKeys`, `issueMigrationRecovery` (M6) |
| `recovery-routes.ts` | `/agent/v1/recovery/*` (eigene Anmeldung über Sitzung, vor `agentRoutes` gemountet, damit dessen Agent-Anmeldung nicht greift; `bodyLimit` 64 KiB für den Tausch) |
| `recovery-service.ts` | Tausch, `recoveryFailures`, Freigabe, Zugangsdaten, Fortschritt, Log, Ereignisse, `release`, Abschluss, Sperren gegen Prune, Zwischenspeicher (höchstens 5 s) |
| `recovery-restic-route.ts` | `/agent/recovery/restic/:sessionId/*` über `buildRunResticRoute`, `reader`, `runId === repoId` |
| `rebind.ts` | `createRebindToken`, `rotateEndpointSecret`, Zweig in `enroll`, `/agent/v1/recovery/sessions/current/rebind` |
| `recovery-iso.ts` | `GET /api/v1/recovery-iso`, `GET /install/recovery/:version/:file` |
| `instance-tls.ts` | `measureInstanceSpki(origin)` (TLS-Verbindung, SPKI-SHA-256, Zeitlimit) |

Routen der Session-API (in `routes.ts`, Kommentar-Tabelle oben ergänzen):

| Aufruf | Rolle | Zweck |
| --- | --- | --- |
| `GET /api/v1/endpoints/:id/baremetal` | restorer | Zustand, Zusammenfassung des neuesten Layouts, Bewertung, Prüfberichte, Bare-Metal-Snapshots |
| `GET /api/v1/endpoints/:id/baremetal/layouts/:layoutId` | admin | volles Manifest (Seriennummern) |
| `POST /api/v1/endpoints/:id/baremetal/probe` | admin | Startprobe anfordern (202) |
| `POST /api/v1/endpoints/:id/recovery-codes` | admin, frische Anmeldung | Code ausstellen |
| `POST /api/v1/endpoints/:id/recovery-codes/:codeId/revoke` | admin | widerrufen |
| `POST /api/v1/endpoints/:id/recovery-codes/:codeId/extend` | admin, frische Anmeldung | verlängern |
| `GET /api/v1/endpoints/:id/recoveries` | admin | Liste (Codes, Sitzungen, Proben, Migrationen) |
| `GET /api/v1/endpoints/:id/recoveries/:recoveryId` | admin | Zustand, Prüfzahl, Hardware, Fortschritt, SSH-Hostschlüssel, Prüfung, Log (seitenweise) |
| `POST /api/v1/endpoints/:id/recoveries/:recoveryId/approve` | admin, frische Anmeldung | Sitzung freigeben |
| `POST /api/v1/endpoints/:id/recoveries/:recoveryId/cancel` | admin | ablehnen bzw. beenden |
| `PUT /api/v1/endpoints/:id/recoveries/:recoveryId/ssh-keys` | admin, frische Anmeldung | öffentliche SSH-Schlüssel für den Fernzugang |
| `POST /api/v1/endpoints/:id/rebind-token` | admin, frische Anmeldung | Wiederanbindungs-Token (eigener Dialog) |
| `POST /api/v1/endpoints/:id/migrations` | admin, frische Anmeldung | M6: Migrationssitzung für den neuen Mac (13.6) |
| `POST /api/v1/endpoints/:id/resume-backups` | admin | `migrationPending` zurücksetzen |
| `GET /api/v1/recovery-iso` | admin | ISO: Version, URL, SHA-256, Prüfbefehle, `verified` |

Weitere Änderungen: `schemas.ts` (Abschluss mit `layout` bis 512 KiB, Job-Einstellung
`wholeMachine`, `fsSnapshot` am Rechner, Restore-Modus `darwin_migration`, Heartbeat
`macUsers` und `fullDiskAccess`); `agent-service.ts` (`finishRun` speichert Layout, plant
Stufe 1 bzw. `darwin_check`, setzt `activity_baseline`; `agentConfig` liefert
`wholeMachine`, `fsSnapshot`, `migrationPending`; `enroll` mit Wiederanbindung und `purpose`;
Heartbeat `macUsers`, `fullDiskAccess`); `audit.ts` (`ENDPOINT_AUDIT_ACTIONS` um
`recoveryCodeCreated` `endpoint.recovery_code.created`, `recoveryCodeRevoked`,
`recoveryCodeExtended`, `recoveryCodeRejected` `endpoint.recovery_code.rejected`,
`recoveryStarted`, `recoveryApproved`, `recoveryCredentialsIssued`,
`recoveryRemoteAccessEnabled`, `recoveryKeyfileRegenerated`, `recoveryReleased`,
`recoveryFinished`, `recoveryExpired`, `recoveryCancelled`, `bootProbeStarted`,
`rebindTokenCreated`, `rebound`, `unrevoked` `endpoint.unrevoked`,
`secretFileRevealed` `endpoint.repository.secret_file_revealed`); `problems.ts`
(`recovery-code-invalid`, `recovery-code-expired`, `recovery-code-revoked`,
`recovery-code-used`, `recovery-too-old`, `recovery-session-ended`,
`recovery-not-approved`, `baremetal-not-available`, `recovery-limit-reached`,
`endpoint-recovery-active`, `endpoint-revoked`); `removal.ts` (409 bei aktiver Sitzung);
`app.ts` (Mounts: `recoveryRoutes` unter `/agent/v1/recovery` vor `agentRoutes`,
`recoveryResticRoutes` unter `/agent/recovery/restic`); `rate-limits.ts`
(`RECOVERY_RESTIC_LIMIT`, `RECOVERY_ISO_DOWNLOAD_LIMIT`); Metrik
`restow_recovery_exchange_failures_total`; Caddy braucht nichts (`/agent/*` geht schon an die
API); `scripts/ci/check-edge-headers.mjs` um die neuen Pfade ergänzen, falls er Pfadlisten
führt.

### 14.4 `apps/worker` und `apps/scheduler`

- `endpoints/baremetal-check.ts` (Stufe 1, Planer nach 12.2), `endpoints/darwin-check.ts`
  (12.5), `endpoints/boot-probe.ts` (Planung der Probe, Probe-Listener, Labor-API
  `lab-broker`), `endpoints/lab/qemu.ts` (QEMU-Aufrufe: Platten, Firmware, NVRAM-Datei mit
  DBX, `fw_cfg`, serielle Konsole als Datei und Socket, QMP `send-key`/`netdev_del`/
  `screendump`, Sandbox-Argumente, Zeitgrenzen; läuft nur im Labor), `lab.ts` (Einstieg des
  Labors).
- `endpoints/retention.ts`, `endpoints/removal.ts`: Sperre bei aktiver Sitzung (9.7).
- `endpoints/monitor.ts`: Ablauf von Codes und Sitzungen, Freigabe-Zeitgrenze, Alarme 12.6,
  Aufräumen der Logs.
- `endpoints/register.ts`: neue Queues; `boot-probe` und `lab-broker` nur, wenn
  `RESTOW_LAB_TOKEN` gesetzt ist.
- `apps/scheduler/src/endpoints.ts`: Stufe 1 bzw. `darwin_check` nachholen (Layout ohne
  Bericht), Startprobe wöchentlich bzw. bei geänderten Fingerabdrücken, wöchentliche Probe
  mit leerer NVRAM, Singleton je Rechner und Art.

### 14.5 Image, Compose

- `Dockerfile`: Worker-Image bekommt `/usr/local/lib/restow/restow-agent` (eigene
  Architektur, aus der Agent-Stufe); neue, vom Worker getrennte Stufe `recovery-lab` (Node
  mit dem Labor-Bündel, Debian-Pakete `qemu-system-x86`, `qemu-utils`, `ovmf`, `seabios`,
  `python3-virt-firmware`, gepinnte `dbxupdate_x64.bin`; ohne `@restow/db`). Das ist das
  siebte Image (`release.yml` "tags all six images", cosign, Smoke `scripts/smoke/images.json`).
- `docker-compose.yml`: Dienst `recovery-lab` im Profil `recovery-lab`, `devices:
  ["/dev/kvm:/dev/kvm"]`, `user` ohne root, nur im Netz `lab-net` (intern, `internal: true`)
  zusammen mit dem Worker, ohne `DATABASE_URL` und `RESTOW_MASTER_KEY`, mit
  `RESTOW_LAB_TOKEN`; Volume `recovery-lab` für `RESTOW_LAB_DIR` und das ISO,
  `RESTOW_LAB_MAX_RESTORE_GIB`, `RESTOW_LAB_CONCURRENCY`. Der Worker kommt zusätzlich in
  `lab-net`. Der Installer (`deploy/`) fragt, ob das Labor eingerichtet werden soll, wenn
  `/dev/kvm` existiert, und erzeugt `RESTOW_LAB_TOKEN`.
- docs/SIZING.md: Platz und RAM für das Labor (eine Probe: RAM 2 GiB für das ISO plus
  Plattenbedarf der vollständig wiederhergestellten Dateisysteme, dünn, verschlüsselt).

### 14.6 `apps/web`: Oberfläche

- **Job-Editor** (`apps/web/src/features/backup-jobs/`, Endpunkt-Jobs): Schalter "Ganzer
  Rechner (Bare Metal, Vorschau)". Text darunter: "Sichert alle lokalen Dateisysteme samt
  Plattenlayout, damit sich Linux-Rechner auf neuer Hardware wiederherstellen lassen.
  macOS: Daten und Einstellungen für einen neu installierten Mac; Cloud-Ordner werden nicht
  gesichert. Windows-Rechner sichern weiter ihre Ordner." Eingeschaltet: Ordnerliste
  ausgegraut ("Alle lokalen Dateisysteme"), Ausschlüsse auf `DEFAULT_WHOLE_MACHINE_EXCLUDES`
  bzw. die macOS-Liste gesetzt (mit "Vorherige Ausschlüsse wiederherstellen"), Wahl "Docker
  mit btrfs-Treiber: Images neu laden statt sichern" (5.2), Hinweise je Mitglied
  (Container, Windows, Agent zu alt, arm64 "Wiederherstellung kommt später", BIOS
  `bios_needs_csm`, macOS ohne Festplattenvollzugriff).
- **Rechnerseite** (`endpoint-detail-page.tsx`, neue Karte
  `components/baremetal-card.tsx`): Linux "Bare-Metal-Wiederherstellung", macOS "Mac neu
  aufsetzen". Inhalt: Bewertung (12.4, 12.5) als Abzeichen mit Erklärung, letzte Stufe 1 und
  Startprobe bzw. `darwin_check` (Datum, Snapshot, Ergebnis, Beleg aufklappbar, VGA-Bild bei
  Misserfolg, leere Ordner der Probe), Layout-Zusammenfassung
  (`components/layout-summary.tsx`: Platten als Balken mit Partitionen, darunter der Stapel
  als Baum, Firmware und Secure-Boot-Stand, Bootloader, Distribution, Verschlüsselung, nicht
  unterstützte Teile rot mit Grund, Warnungen gelb), Mindestgrößen je Platte aus den
  Restore-Größen, der Hinweis aus 6.1 bei VG ohne freien Platz. Knöpfe "Wiederherstellen…"
  (Assistent), "Recovery-ISO", "Startprobe jetzt". Laufende Wiederherstellung: Fortschritt
  oben auf der Seite und in der Rechnerliste ("Wird wiederhergestellt").
- **Assistent "Bare-Metal-Wiederherstellung"** (`components/baremetal-wizard.tsx`, Route
  `/inventory/<id>/bare-metal`), ausgeblendet, solange `GET /api/v1/recovery-iso` kein
  geprüftes ISO meldet:
  1. *Sicherungsstand:* Liste der Bare-Metal-Snapshots mit Datum, Prüfstand je Stufe,
     Layout gleich/anders als der neueste; Vorauswahl der neueste grüne, sonst der neueste.
  2. *Ersatzhardware:* was sie braucht (Firmwaremodus; bei BIOS: "braucht CSM/Legacy, viele
     aktuelle Modelle haben das nicht"; Secure Boot und welche CA; Anzahl und Mindestgröße
     der Platten; RAM; Netz per Kabel an einem Access-Port), Controller, für die der
     gesicherte Kernel Treiber hat (aus L3 `other-controller`), was sich ändern darf und was
     nicht (Abschnitt 2.2), Hardware-RAID: "VD im Controller anlegen, Mindestgröße X GiB",
     Hinweise auf verschlüsselte Volumes ("Sie vergeben beim Wiederherstellen eine
     Passphrase; beim Start gilt die Tastaturbelegung <x>"), TPM, und: "Alte Platten
     abziehen, außer Sie wollen sie übernehmen."
  3. *Recovery-ISO:* Version, Download, SHA-256, Prüfbefehle (Linux/macOS:
     `verify-agent-signature.sh` mit `release-signing.pub` aus dem Git-Tag, und
     `sha256sum -c`; Windows: `Get-FileHash`), Schreiben auf USB (dd, Rufus im DD-Modus),
     Fingerabdruck des Release-Schlüssels mit dem Satz "außerhalb dieser Instanz vergleichen:
     README und Release-Notes auf GitHub" (8.5).
  4. *Wiederherstellungscode:* Dialog `components/recovery-code-dialog.tsx`: Gültigkeit
     (Auswahl 1, 2, 4, 8, 12, 24, 48 Stunden; Vorschlag aus der Datenmenge bei angenommenen
     50 MB/s, mindestens 4), Schalter "Freigabe nach dem Eintausch" (an; aus nur mit
     Bestätigung), frische Anmeldung, dann **einmalig** Code (große Schrift, Gruppen),
     Adresse der Instanz ("genau so im ISO eingeben"), Prüfwert der Instanz
     (`XXXX-XXXX-…`, 9.2), Ablaufzeit, "Kopieren", "Drucken" (eine Seite mit Code, Adresse,
     Prüfwert, Rechnername, Ablauf, ohne weitere Daten); Hinweis "Der Code gibt nach Ihrer
     Freigabe Lesezugriff auf alle Sicherungen dieses Rechners, bis er abläuft oder beendet
     ist". Kein Wiederanbindungs-Token in diesem Dialog.
  5. *Live:* "Warte auf das ISO" -> eingetauscht: **Freigabe** mit Prüfzahl, Adresse,
     ISO-Version und gefundener Hardware, Knöpfe "Freigeben"/"Ablehnen" -> verbunden ->
     Phasen mit Fortschritt, Bytes, Dateien, Restzeit -> Prüfung (Liste 10.17) -> fertig oder
     fehlgeschlagen (mit Log). Knöpfe "Code widerrufen", "Verlängern", "Abbrechen",
     "SSH-Schlüssel hinterlegen" (Feld für öffentliche Schlüssel, danach die
     Hostschlüssel-Fingerabdrücke aus dem ISO).
  6. *Danach:* "Rechner wieder anbinden" öffnet den eigenen Token-Dialog (Abschnitt 11, mit
     Warnung, Gültigkeit 1 Stunde, `unrevoke` nur bei widerrufenen Rechnern), Hinweise aus
     dem Abschluss (TPM, MOK-Einschreibung mit Passwort, Netzwerknamen, Startplatte bei BIOS,
     alte Platten abziehen, degradierter Erststart, nicht angepasste Kernel).
- **Assistent "Mac neu aufsetzen"** (`components/mac-setup-wizard.tsx`, Route
  `/inventory/<id>/mac-setup`): Abschnitt 13.4.
- **Rechner-Einstellungen** (`settings-tab.tsx`): "Dateisystem-Snapshot (LVM, btrfs, APFS)"
  `auto`/`off` für Linux und macOS; macOS: Zustand Festplattenvollzugriff, PPPC-Profil (wenn
  signiert), "Sicherungen wieder aufnehmen" bei `migrationPending`.
- **Lauf-Details** (`run-sheet.tsx`): "Konsistenz" zeigt LVM/btrfs/APFS wie VSS heute
  (mit "kein Verfahren" statt Fehler, 6.1); "Layout erfasst" mit Link zur Karte;
  `cloud_file_skipped` als Hinweis.
- **Recovery Readiness** (`GET /api/v1/verify/latest`): Spalte "Bare Metal" für Rechner mit
  `wholeMachine`, eigene Zählung, nicht mit der Datei-Bewertung vermischt.
- **Restore-Dialog** (`restore-dialog.tsx`): `state.json` ausgeblendet, Schlüsseldateien für
  `tenant_restore` gesperrt (5.4); macOS-Pfade in Firmlink-Form (7).
- **Recovery-Log** in der Live-Ansicht: Zeilen kommen ohne ANSI (9.8) und werden als Text
  dargestellt, nie als HTML.
- `presenters.ts`, `api.ts`: neue Typen und Fehlercodes.

### 14.7 i18n

`packages/i18n/resources/{de,en}/endpoints.json`: `baremetal.*` (Karte, Bewertung, Assistent,
Hardware-Anforderungen, Warnungen und Probleme des Planers je Code), `recovery.*`
(Code-Dialog, Freigabe, Live-Ansicht, Phasen, Prüfungen), `rebind.*`, `macSetup.*`
(Assistent und Meldungen 13.7), `runErrors.layout_*`, `runErrors.cloud_file_skipped`,
Job-Editor-Texte. `…/failures.json`: die neuen Codes und Schritte. `recover` selbst hat
seine Texte in Go (`agent/internal/recovery/text_de.go`, `text_en.go`), weil das ISO ohne
die i18n-Dateien läuft; ein Test verlangt für jeden Schlüssel beide Sprachen, ebenso für
jeden Code von `Problem` und Warnung des Planers.

## 15. Agent: weitere Änderungen

- `internal/api/types.go`: `Config.WholeMachine`, `Config.FSSnapshot`,
  `Config.MigrationPending`, `FinishRequest.Layout json.RawMessage`,
  `RestoreParams.Mode/SnapshotID/Users/Applications/Rosetta/Skip/DryRun/RecoveryID`,
  `HeartbeatRequest.MacUsers` (mit `SecureToken`, `VolumeOwner`),
  `HeartbeatRequest.FullDiskAccess`, Typen der Recovery-API.
- `internal/paths`: `Layout.BaremetalDir()`, Konstanten `RecoveryTargetRoot =
  "/mnt/restow-target"`, `APFSMountPoint = "/private/var/run/restow-agent/apfs"`,
  `SnapTreeDir = "/run/restow-agent/snaptree"`.
- `internal/core/backup.go`: Zweig Ganzer Rechner (5.6), Ausschluss von `state.json` (5.4,
  macOS über `expandDarwinExcludes`), Snapshot-Zweig für LVM/btrfs/APFS (6.4), keine
  planmäßige Sicherung bei `migrationPending`.
- `internal/core/sample.go`, `internal/core/activity.go`: Messung aus dem Snapshot-Baum (5.6,
  7), `restic diff` mit Unterordnern (7).
- `internal/core/verify.go`, `restore.go`: Pfadabbildung macOS (7).
- `internal/core/pathmap.go`: `snapshotRootOf`, `toViewPath`, `fromViewPath`,
  `expandDarwinExcludes`, `manifestPathInSnapshot`, Firmlinks aus `/usr/share/firmlinks`.
- `internal/restic/backup.go`, `restore.go`, `runner.go`, `diff.go`: Optionen aus 5.5 und
  10.12, `Exec`, Unterordner bei `diff`.
- `internal/redact`: Code-, Token- und Sitzungsmuster.
- `internal/sysinfo`: `macUsers`, `fullDiskAccess` (darwin).
- `internal/update`: unter darwin nach dem Neustart Festplattenvollzugriff prüfen,
  `fda_lost` melden (13.3).
- `cmd/restow-agent/main.go`: Hilfetext um `recover` (nur Linux), `baremetal`,
  versteckt `snapshot-exec`, `chroot-exec`.
- `agent/README.md`, "Known limits": neu formuliert (Abschnitt 17).

## 16. Sicherheit

### 16.1 Bausteine

- **Code:** 122 Bit, an die Origin gebunden (9.1), einmal einlösbar, höchstens 48 Stunden
  (CHECK), nur als Hash des Beweises gespeichert, Fehlversuche je Adresse in einem eigenen
  Zähler begrenzt und tote Codes beim Mandanten auditiert und alarmiert, geschwärzt in Logs.
  Ausstellen nur durch Mandanten-Admins mit frischer Anmeldung, auditiert; Widerruf
  jederzeit; Freigabe nach dem Eintausch (Vorgabe an).
- **Sitzungsgeheimnis** entsteht im ISO, nur der Hash geht zum Server; Vergleiche mit
  `timingSafeEqual`; Zustand höchstens 5 Sekunden zwischengespeichert.
- **Repository-Passwort** im ISO nur im Speicher und in restics Umgebung, nie auf Platte;
  der Zugang endet vor dem ersten Programm aus der Sicherung (10.13), und diese Programme
  laufen in eigenen Namensräumen ohne Netz, ohne fremde Platten und ohne Zugriff auf andere
  Prozesse (10.14).
- **TLS:** Systemzertifikate oder CA-Datei; Rückfall nur mit eingetipptem Prüfwert der
  Instanz, kein Trust on first use (10.3); Uhrzeit nie aus einem `Date`-Kopf.
- **Manifest von einem möglicherweise kompromittierten Rechner:** Es kann die
  Wiederherstellung nicht über die bestätigten Zielplatten hinaus lenken (Löschen nur nach
  Eingabe der Kennungen), alle Werte laufen als Argumente ohne Shell und werden vorher
  geprüft (Namen gegen Muster, Größen gegen die Zielplatte, keine Steuerzeichen, Konsole nur
  über `sanitizeForConsole`), Dateizugriffe im Ziel bleiben im Ziel
  (`openat2`/`RESOLVE_IN_ROOT`). Auf dem Server läuft der Planer ohne Umgebung, ohne Rechte
  und mit Grenzen (12.2).
- **Geheimnisse in der Sicherung:** `state.json` nie mehr gesichert, Schlüsseldateien für
  `tenant_restore` gesperrt und bei der Wiederherstellung neu erzeugt (5.4, 10.10), `raw/`
  ohne Geheimnisse (4.3).
- **ISO:** signiert über `agent-SHA256SUMS`, reproduzierbar mit gesperrter Paketliste,
  zweimal auf verschiedenen Runnern und beim Maintainer vor dem Signieren nachgebaut, ohne
  Geheimnisse und ohne Instanzbezug, ohne Root-Passwort; SSH nur auf ausdrücklichen Wunsch,
  nach dem Tausch nur mit Schlüssel. Secure Boot schützt die Startkette bis zum Kernel, nicht
  das Live-Dateisystem (8.6); die Echtheit beweist die Signaturprüfung mit dem Schlüssel aus
  dem Git-Tag.
- **Unbeaufsichtigt:** nur mit ausdrücklich gewählter Quelle; `fw_cfg` nur in QEMU (10.20).
- **Labor:** getrennt vom Worker, ohne Datenbank und Master-Key, QEMU unprivilegiert mit
  Sandbox, verschlüsselte Plattendateien, Netz nur bis `release` und nur zum
  Probe-Listener (12.3).
- **Wiederanbindung:** eigenes Token in eigenem Dialog, 1 Stunde (höchstens 24), reaktiviert
  widerrufene Rechner nur ausdrücklich, Alarm bei Einlösung.

### 16.2 Bedrohungsmodell

| Angreifer hat … | kann … | kann nicht … | Gegenmaßnahme |
| --- | --- | --- | --- |
| nur das ISO | nichts | irgendetwas lesen; das ISO enthält nichts Instanzbezogenes | 8.2 |
| einen gestohlenen Code vor der Freigabe | eine Sitzung `pending_approval` anlegen (der echte Bediener sieht danach `recovery-code-used`) | Passwort oder Lesezugang erhalten; Prune blockieren | Freigabe mit Prüfzahl (9.4), Alarm `endpoint.recovery.started`, Ablehnen |
| einen Code, aber eine Phishing-Adresse | – | den Code an der echten Instanz einlösen (der Beweis ist an die falsche Origin gebunden) | 9.1 |
| einen eingelösten, freigegebenen Code | alle Snapshots des einen Rechners lesen, das Repository-Passwort und damit den Hauptschlüssel des Repositorys kennen (eine später erbeutete Kopie des Speichers bleibt damit entschlüsselbar), Prune und Entfernen bis zum Ablauf blockieren, falsche `progress`- und `finish`-Berichte senden | schreiben, löschen, andere Rechner oder Mandanten lesen, nach Ablauf oder Abbruch weiterlesen (höchstens 5 s) | Freigabe, Alarm, Abbrechen, kurze Gültigkeit; Berichte aus dem ISO sind als "vom ISO gemeldet" gekennzeichnet |
| ein verändertes ISO und einen gültigen Code | zusätzlich die bestätigten Zielplatten löschen, eine Hintertür ins wiederhergestellte System legen | ohne Freigabe etwas lesen | Signaturprüfung mit dem Schlüssel aus dem Git-Tag (8.5), Prüfzahl |
| einen kompromittierten Rechner (Manifest, Programme im chroot) | das eigene wiederhergestellte System kompromittieren (wie bei jeder Sicherung) | Geheimnisse von `recover` lesen, Netz nutzen, fremde Platten schreiben, NVRAM schreiben, Konsole fälschen | 4.2 (Steuerzeichen), 10.14, 12.2 |
| eine Datenbank-Kopie (nur lesen) | Hashes von Codes und Sitzungen sehen | einen Code einlösen (nur `SHA-256(codeProof)` gespeichert), eine Sitzung übernehmen (nur Hash des Geheimnisses) | 9.1, 9.3 |
| ein Wiederanbindungs-Token | die Identität des Rechners dauerhaft übernehmen | einen widerrufenen Rechner reaktivieren (ohne `unrevoke`) | eigener Dialog, 1 Stunde, Alarm `endpoint.rebound` |
| einen QEMU-Escape im Labor | die Plattendateien der laufenden Probe und deren Zugangsdaten lesen | Datenbank, Master-Key, andere Mandanten | Trennung 12.3 |
| einen kompromittierten Server | alles | – | inhärent |

**Reaktion nach Verdacht:** Code widerrufen bzw. Sitzung abbrechen (wirkt nach höchstens
5 Sekunden), Audit und Recovery-Log prüfen; ist das Repository-Passwort abgeflossen, ist der
Hauptschlüssel bekannt: Für den Rechner ein neues Repository anlegen und die alten Snapshots
nach Ablauf der Aufbewahrung verwerfen. Das Anlegen eines neuen Repositorys für einen
bestehenden Rechner (Wiederanbindung mit neuem Repository) ist ein späterer Schritt nach
0.5.0 und steht als Kandidat in 2.2 bzw. 0.5.x.

## 17. Dokumentation

- docs/AGENT.md: Grundsätze (Satz "Keine Images, kein Bare-Metal-Restore" ersetzen:
  "Dateibasierte Sicherung mit restic; Linux-Rechner lassen sich als Ganzes auf neuer
  Hardware wiederherstellen (Vorschau, docs/BAREMETAL.md), keine Plattenabbilder"),
  Tabelle `/agent/v1` (`GET /config` mit `wholeMachine`, `fsSnapshot`, `migrationPending`;
  Abschluss mit `layout`; Heartbeat `macUsers`, `fullDiskAccess`; Recovery-API), neuer
  Abschnitt "Ganzer Rechner und Wiederherstellung", Fehlercodes, Alarme, Datenmodell
  (Migrationen 0074 bis 0078), Sicherheitsmodell (16.2), Tests; Fingerabdruck des
  Release-Schlüssels (Vergleich außerhalb der Instanz, 8.5).
- agent/README.md (Englisch): "Whole machine", "Recovery ISO", "Set up a Mac again",
  "Known limits".
- docs/WINDOWS-AGENT.md 2.2 und 21: Verweis hierher.
- docs/RANSOMWARE.md: kein Vergleich über eine Wiederanbindung hinweg, erster Lauf danach
  ist neue Basis (11); Vergleich über Präfixe unter macOS (7).
- docs/GLOSSARY.md: Bare Metal, Layout-Manifest, Recovery-ISO, Wiederherstellungscode,
  Prüfzahl, Prüfwert der Instanz, Übernahme, Startprobe, Labor, Wiederanbindung,
  Migrationssitzung.
- docs/SIZING.md (Labor), docs/CI.md (Jobs `recovery-iso`, `recovery-iso-rebuild`,
  `recovery-e2e`, `agent-root`, `agent-macos`), SECURITY.md (Meldeweg bleibt, Verweis auf
  16.2), README.md (Funktionsliste, Fingerabdruck des Release-Schlüssels),
  `integrations/recovery/README.md`.
- Dieses Dokument wird nach der Umsetzung um "Stand der Umsetzung" ergänzt und später
  gekürzt.

## 18. CHANGELOG-Plan

Einträge unter `[Unreleased]` (Englisch, wie der CHANGELOG), je Meilenstein beim Merge:

- **M1, Added:** "Whole machine backups (preview, Linux): a backup job switch backs up every
  local file system, every btrfs subvolume and every local fstab entry, with its disk
  layout. The agent records the layout (partition tables, RAID, LUKS metadata without
  secrets, LVM, file systems and their features, mounts and fstab, firmware and Secure Boot
  state, boot loader, initramfs generator and its keyboard layout, driver chain of the boot
  disks) as a layout manifest inside the snapshot and reports it; backups run with
  `--one-file-system` and `--group-by host`." / "File system snapshots on Linux: LVM (thick
  and thin) and btrfs snapshots under the policy 'When the file system snapshot fails';
  snapshot paths stay the real paths. Thin pools above 80 % get no snapshot, and a backup
  stops its snapshot before a pool runs full. A volume group without free space is read
  live without a warning on every run." **Changed:** "The agent no longer backs up its own
  state file (`/etc/restow-agent/state.json`) with the agent secret and the repository
  password, on any system; the restore dialog hides it in older snapshots, and LUKS key
  files are no longer downloadable for the restore role." Migration 0074.
- **M2, Added:** "Layout check after every whole machine backup: the server validates the
  layout, plans the restore with the agent's own planner (sandboxed, without the server's
  environment), computes restore sizes, and checks that the snapshot holds the layout,
  every mounted file system and fstab entry and the boot chain (kernels, initramfs, boot
  loader, fstab, crypttab and LVM device entries)." Migration 0075.
- **M3, Added:** "Recovery codes: a one-time code for one machine, bound to this instance's
  address, valid 4 hours (up to 48), audited, approved by an admin after it is redeemed,
  read-only access to that machine's backups for a bare-metal restore." / "Rebind a
  restored machine: a separate, short-lived token that gives an existing machine a new agent
  secret and keeps its backups and history; revoked machines stay revoked unless chosen."
  **Security:** "Repository pruning waits while a recovery runs; redeeming a code, trying a
  dead code and rebinding a machine alert the tenant admins." Migration 0076. (Code dialog
  and wizard stay hidden until M4 ships a verified ISO.)
- **M4, Added:** "Recovery ISO (preview): a signed, reproducible Debian 13 live image
  (`restow-recovery_<v>_amd64.iso`, GPL-3.0-or-later build recipe in `integrations/recovery`)
  that boots with UEFI Secure Boot and legacy BIOS and restores a Linux machine from Restow
  onto new disks: GPT and MBR, mdadm, LVM including thin, LUKS, ext4, XFS, btrfs, separate
  /boot and EFI system partition, smaller and larger disks, 4Kn; intact data disks can be
  kept; the boot chain, drivers and Secure Boot state are checked before anything is
  erased; initramfs and boot loader are set up again with the restored system's own tools
  in an isolated environment. Firmware packages: …" (Liste aus 8.4) / CI: "Recovery
  end-to-end tests in QEMU/KVM".
- **M5, Added:** "Boot probe: a restore of the newest whole machine backup into a virtual
  machine on the server (optional `recovery-lab` service with KVM, separated from the
  database) on a different disk controller and with current Secure Boot revocations proves
  that it boots; bare metal is green only then." Alarme. Migration 0077.
- **M6, Added:** "macOS (preview): backups from a read-only APFS snapshot; 'Set up a Mac
  again' restores user folders and drag-installed apps onto a reinstalled Mac. The old Mac
  can be replaced (rebind) or keep running (read-only recovery session, 4 h, audited).
  Cloud folders and App Store or pkg apps are listed for reinstall. A server check proves
  every user's data is restorable." Migration 0078.
- **Known limits** (bei M4): Windows bare metal later; no change of the storage stack
  (BIOS to UEFI is a 0.5.x candidate); no Wi-Fi, VLAN or bonding in the ISO; TPM2/FIDO2
  bindings must be enrolled again; raw LVs (VM disks of a Proxmox VE host) are not backed
  up; amd64 only.

## 19. Dateien, die sich ändern

Agent (`agent/`):

- neu `internal/baremetal/` (`manifest.go`, `assess.go`, `fingerprint.go`, `efi.go`,
  `pe.go`, `cmdline.go`, `sanitize.go`, `capture.go`, `capture_linux.go`, `capture_darwin.go`,
  `tools.go`, `plan.go`, `sizing.go`, `mapping.go`, `drivers.go`, `secureboot.go`, `mkfs.go`,
  `fixups.go`, Tests, `testdata/`)
- neu `internal/fssnap/` (`fssnap.go`, `lvm_linux.go`, `btrfs_linux.go`, `nsexec_linux.go`,
  `apfs_darwin.go`, `cleanup_linux.go`, `cleanup_darwin.go`, Tests)
- neu `internal/recovery/` (Abschnitt 10.1)
- `internal/core/backup.go`, `sample.go`, `activity.go`, `verify.go`, `restore.go`,
  `snapshot.go` (Texte je Verfahren), neu `snapshot_linux.go`, `snapshot_darwin.go`,
  `snapshot_other.go` (nur noch für andere Unix-Systeme), neu `wholemachine.go`,
  `pathmap.go`, `migrate_darwin.go`, Tests (`harness_test.go`, `activity_test.go`,
  `pathmap_test.go`)
- `internal/restic/backup.go`, `restore.go`, `runner.go`, `diff.go`, `restic_test.go`
- `internal/api/types.go`, `internal/paths/paths.go`, `internal/redact/`,
  `internal/sysinfo/sysinfo_darwin.go`, `internal/update/`
- `cmd/restow-agent/main.go`, neu `recover.go`, `baremetal.go`, `snapshotexec.go`,
  `chrootexec.go`
- `README.md`

Separates Werk: neu `integrations/recovery/` (8.1).

Server und Web: wie in 14.1 bis 14.7, dazu `packages/db/drizzle/0074_baremetal_layouts.sql`
bis `0078_darwin_check.sql`, `packages/db/drizzle/meta/_journal.json`,
`packages/db/sql/rls.sql`, `packages/db/src/schema/endpoints.ts`,
`packages/db/src/schema/backup-jobs.ts`, `packages/core/src/backup-jobs/endpoint-config.ts`,
`deploy/` (Labor, `RESTOW_LAB_TOKEN`), `deploy/demo/seed/` (ein Demorechner mit Layout und
grüner Startprobe, ein Mac mit grüner `darwin_check` für Bildschirmfotos).

Build, CI, Lizenzen, Doku: `.github/workflows/ci.yml` (`agent-root`, `agent-macos`,
`recovery-iso`, `recovery-iso-rebuild`, `recovery-e2e`, `test` mit `needs: agent`, `passed`),
`.github/workflows/release.yml` (`recovery-iso`, `recovery-iso-rebuild`, `agent-sums`,
`publish`, siebtes Image, `agent-macos-sign` falls 25.B19 angenommen), neu
`.github/workflows/recovery-nightly.yml` (volle Matrix), `Dockerfile`,
`docker-compose.yml`, `scripts/ci/license-policy.json`, `scripts/ci/check-separate-works.mjs`
und Test, `scripts/ci/check-release.mjs` (ISO-Zeile), `scripts/release/sign-agent.sh`
(`--iso`), neu `scripts/recovery-e2e/` (`run.mjs`, Fälle), `scripts/smoke/images.json`,
`NOTICE`, `THIRD_PARTY_NOTICES.md`, Dokumente aus Abschnitt 17, `CHANGELOG.md`.

## 20. Risiken

| Risiko | Wirkung | Gegenmaßnahme |
| --- | --- | --- |
| Alte Platte mit gleicher Identität bleibt angeschlossen | falsches Gerät aktiviert, Start von der alten Platte, Datenverlust | keine Auto-Aktivierung im ISO (8.2), `--devices`, Konfliktprüfung vor und nach (10.7, 10.17), Checkliste 31 |
| Intakte Datenplatten würden gelöscht | Datenverlust bei unvollständig gesicherten Daten | Übernahme statt Löschen, nie automatisch zum Löschen zugeordnet (10.7), E9 |
| Gesicherter Kernel kennt die neue Hardware nicht | Start bleibt im initramfs stehen, nach dem Löschen | Treiberprüfung vor dem Löschen (10.8), L3 `other-controller`, Startprobe auf anderem Controller |
| `mkfs` im ISO erzeugt Funktionen, die das Zielsystem nicht kennt | System startet nicht oder hängt Dateisysteme nicht ein | Funktionen nur aus dem Manifest (10.11), Rücklesen, Startprobe |
| ENOSPC mitten im Restore auf kleinerer Platte | Abbruch Stunden nach dem Löschen | Restore-Größen statt `usedBytes`, Kompression beim Einhängen, Thin-Pool-Reserve (10.9) |
| Secure-Boot-Firmware mit aktueller DBX/SBAT oder ohne 3rd Party CA | wiederhergestelltes System startet nicht unter Secure Boot | Prüfung gegen `db`/`dbx`/`SbatLevelRT` vor dem Löschen (10.5), Startprobe mit einer NVRAM-Datei und aktueller DBX, Checkliste 35 |
| Passphrase beim Start in anderer Tastaturbelegung | Rechner wiederhergestellt, aber nicht zu öffnen | Belegung des initramfs erfasst und bei der Eingabe geladen, belegungsfeste Passphrase, dracut mit `vconsole.conf` (10.10), Checkliste 34 |
| dracut ohne Hostonly übernimmt `crypttab` nicht | Start hängt, Volumes bleiben zu | `--include /etc/crypttab` (10.15), E3 |
| LVM-Gerätedatei nennt alte Platten (RHEL 9) | VGs werden nicht aktiviert, Notfallmodus | `vgimportdevices` vor dem initramfs (10.15), E3 mit Seriennummern, Checkliste 33 |
| Plain-dm-crypt-Swap mit Gerätenamen | erster Start formatiert ein Datendateisystem | Pflicht-Fixup auf `PARTUUID=`, Prüfung 10.17/4, L6, E10 |
| Verschachtelte btrfs-Subvolumes fehlen in der Sicherung | Container und Daten leer nach dem Restore | jedes Subvolume als Quelle (5.2), L5, E4 |
| initramfs zu groß für `/boot` | abgeschnittenes Abbild, Start scheitert | nur Standard-Kernel neu, Platzprüfung, Lesbarkeitsprüfung (10.15, 10.17/5), Checkliste 43 |
| Snapshot füllt Thin-Pool | Produktionsausfall | Schwellen 80/90 Prozent, Überwachung, Abbruch (6.2) |
| Dicker Snapshot läuft über | Lesefehler, `partial` | Überwachung, Rückfall live (6.2) |
| VG ohne freie Extents (Standardinstallationen) | jeder Lauf gelb, echte Fehler gehen unter | "kein Verfahren" statt Fehler, einmalige Erklärung (6.1) |
| NVRAM-Einträge gehen verloren | Rechner findet keinen Bootloader | Rückfallpfad mit `grub.cfg`-Stub bzw. `fbx64.efi` (10.15), wöchentliche Probe mit leerer NVRAM |
| Gerätenamen in Konfigurationen | Start hängt beim Einhängen | Fixups (10.13), Suchlauf, L6 in Stufe 1 |
| Netzkonfiguration sucht die alte MAC | Server ohne Netz, ohne Konsole nicht erreichbar | MAC-Fixups in allen bekannten Formaten (10.16), E2 |
| Netzwerkkarte ohne Treiber/Firmware im ISO | keine Wiederherstellung möglich | Firmwareliste (8.4), Anzeige fehlender Treiber, Maintainer-Matrix; Ersatz: USB-Netzwerkadapter (`r8152`, `ax88179_178a`, `cdc_ether` sind frei) |
| SAN-LUNs anderer Server sichtbar | fremde Datenspeicher gelöscht | FC/iSCSI nur auf Freigabe, nie automatisch, Multipath als Problem (10.6) |
| Gestohlener Code | Datenabfluss | Origin-Bindung, Freigabe mit Prüfzahl, Alarm, kurze Gültigkeit (9) |
| MITM bei eigener CA | Datenabfluss | kein Trust on first use, eingetippter Prüfwert (10.3) |
| Kompromittiertes System im `chroot` | Geheimnisse abgeflossen, fremde Platten überschrieben | Isolation 10.14, CI-Test |
| QEMU-Escape im Labor | Übernahme aller Mandanten | Labor ohne DB und Master-Key, Sandbox (12.3) |
| Prune während der Wiederherstellung | fehlende Packs, Abbruch | Sperre 9.7 |
| Langsame Leitung, großer Rechner | Code läuft ab | Verlängern, Fortsetzen mit neuem Code (10.18) |
| Stromausfall beim Restore | Dateien mit Nullblöcken | `--overwrite always` nach unsauberem Ende, Inhaltsprüfung der Systempfade (10.18) |
| live-build nicht bitgleich | Signatur ohne Nachbau-Beweis | CI-Doppelbau auf zwei Runner-Images, Diffoscope, Nachbau beim Maintainer vor dem Signieren; M4 erst fertig, wenn bitgleich |
| Untergeschobene Paketversion im ISO | manipuliertes ISO mit gültiger Signatur | `packages.lock`, Signaturprüfung von apt, Nachbau (8.3, 8.5) |
| Labor nicht verfügbar | nie grün | Zustand `layout_checked` klar benannt, Offene Frage 2 |
| Startprobe-Eingriff (Konsole, `splash`/`rhgb`/`quiet` entfernt, Unit) verfälscht | Probe grün, echter Start nicht | Eingriff nur Kommandozeilen-Änderung und eine Unit; echte Hardware im Freigabetest |
| QEMU-Hardware weicht von echter ab | Treiber-, Firmware-Effekte unentdeckt | anderer Controller in der Probe, Maintainer-Checkliste 21.4 |
| BIOS-System, Ersatzhardware ohne CSM | Wiederherstellung unmöglich | Warnung `bios_needs_csm` schon auf der Rechnerseite, BIOS→UEFI als 0.5.x-Kandidat |
| APFS-Snapshot wird während des Laufs ausgedünnt | Lesefehler | Überwachung im 30-s-Takt, Rückfall nach Richtlinie (7) |
| Festplattenvollzugriff nach Update weg (unsigniertes Binary) | alle Macs `snapshot_unavailable` | Signierung (25.B19) oder `fda_lost` mit Alarm (13.3) |
| Große Repositories, wenig RAM im Ersatzrechner | restic bricht ab | Schätzung aus `indexBytes`, Warnung |
| Zeit falsch im Ersatzrechner | TLS scheitert | NTP aus DHCP, Hinweis aus `Date`, manuelles Setzen (10.3) |
| Tastaturbelegung beim Code | Code nicht eingebbar | Belegung im Startmenü und in `recover`, Alphabet ohne Y/Z |
| Umfang | Termin 0.5.0 | Meilensteine einzeln mergebar; M5 Pflicht, sonst Bare Metal verborgen; nur M6 darf nach 0.5.x (Abschnitt 22) |

## 21. Testplan

### 21.1 Unit-Tests (jedes System, Job `agent` und `test`)

Go, ohne Build-Tag, Tabellentests:

- Erfassung gegen aufgezeichnete Ausgaben (`testdata/capture/<system>/`): mindestens Debian
  12 UEFI LUKS+LVM, Ubuntu 22.04 BIOS mdadm, Ubuntu 24.04 Standard, Ubuntu mit ZFS (muss
  `unsupported` ergeben), Alma 9 XFS+LVM mit `system.devices`, Fedora btrfs mit
  verschachtelten Subvolumes und `compress=zstd:1`, openSUSE btrfs+Snapper mit Wurzel
  `@/.snapshots/<N>/snapshot` und Quota, Arch systemd-boot mit UKI, BIOS+MBR+mdadm RAID1,
  RAID5 mit Ersatzplatte, degradiertes RAID1, LVM thin, Proxmox VE mit `pve/data` und
  `raw`-LVs, 4Kn-NVMe, NVMe mit zwei Namensräumen, Mehrgeräte-btrfs RAID1, LUKS1 mit
  verschlüsseltem `/boot`, LUKS2 mit TPM2- und Clevis-Token (Token-Inhalte dürfen nirgends
  erscheinen), Plain-dm-crypt-Swap, Swap-Datei auf btrfs, ESP mit `x-systemd.automount`,
  `noauto`-ESP, Dual-Boot mit Windows, Docker mit btrfs-Treiber, Container (kein Stapel). Die
  Aufzeichnungen nimmt `restow-agent baremetal capture --raw-dir` in der CI auf den
  Loop-Geräte-Stapeln (21.2) und auf echten Maschinen und VMs auf (Abschnitt 21.4
  Punkt 1); die Maintainer-Aufzeichnungen ergänzen die aus der CI, ersetzen sie nicht.
- Je neuem Manifest-Feld aus 4.1 ein Sammler-Test mit aufgezeichneter Ausgabe.
- `tools.go`: Die `Runner`-Attrappe scheitert bei `--dump-volume-key`, `--dump-master-key`,
  `luksHeaderBackup`, `--showkeys`; ein Test ruft jeden Sammler auf und verlangt, dass das
  nie vorkommt. `captureLUKS`: `raw/luks-<id>.json` enthält weder `digests` noch `salt` noch
  Token-Inhalte. `RedactCmdline`: Tabellentests (`rd.iscsi.password=`,
  `netroot=iscsi:user:pass@…`, `cryptkey=`).
- `efi.go`, `pe.go`: Zerlegen und Bauen von `EFI_LOAD_OPTION` mit echten efivars-Bytes;
  `db`/`dbx`/`MokListRT`/`SbatLevelRT` aus echten Dumps; `.sbat` und Signaturgeber echter
  shim-, GRUB-, systemd-boot- und UKI-Dateien (Debian, Ubuntu 22.04 alt und neu, Fedora,
  Arch).
- `secureboot.go`: Startkette gegen `db` ohne 3rd Party CA, mit CA 2023 statt 2011, mit
  gesperrtem Hash in `dbx`, mit angehobenem `SbatLevel`.
- `drivers.go`: Modalias-Abgleich gegen `modules.alias`/`modules.builtin` (RHEL 8 ohne
  `mpi3mr`, Fedora mit eingebautem `ahci`).
- Planer: jede Testdatei gegen "gleiche Hardware", "größer", "kleiner", "ein Sektor kleiner",
  "eine Platte weniger" (RAID degradiert, mit redundanten Startpartitionen), "zu klein"
  (Problem), "BIOS vs. UEFI" (Problem), "BIOS auf 4Kn" (Problem), 512 nach 4Kn, 4Kn nach
  512, gemischte Blockgrößen, Start bei 63, MBR über 2 TiB, Übernahme eines Daten-RAID,
  Identitätskonflikt, `raw`-LVs, Thin-Pool-Reserve; erwartete Pläne als Golden Files.
- `mkfs.go`: Argumente je Typ und Funktionsliste; `-b`/`-s`/`-S` nach Blockgröße; Ablehnung
  unbekannter Funktionen.
- `fixups.go`: `fstab`, `crypttab` (auch Plain), `mdadm.conf` (`spares=`), Kommandozeilen
  (`cryptdevice=`, `md=`, `rd.luks.key=`, `resume_offset=`), BLS-Einträge mit Kommentaren,
  Tabs, Fortsetzungen, `subvolid`, Gerätenamen aller Arten, `lvm.conf`-Filter, netplan,
  NetworkManager, `ifcfg`, `70-persistent-net.rules`, `.mount`/`.swap`-Units,
  `add_device+=`, `grub_installdevice`, `proxmox-boot-uuids`; unveränderte Dateien bleiben
  bytegleich.
- Fingerabdruck: gleiche Werte in Go und TS (4.2), für Linux und darwin.
- Code: Normalisierung, `canonicalOrigin`, `codeProof`, Prüfzahl (Testvektoren, gleich in TS).
- `consistencyOf` mit LVM/btrfs/APFS-Ausgängen und "kein Verfahren"; Politik
  `continue`/`fail` mit dem falschen restic und falschen Werkzeugen (`harness_test.go`).
- Pfadabbildung macOS (`pathmap_test.go`, drei Formen, Firmlinks aus macOS 14, 15, 26,
  `expandDarwinExcludes`), `activity_test.go` (vier Kombinationen).
- `apfs_darwin_test.go` (ohne Build-Tag-Logik ausgelagert): Lösch-Aufrufe nur mit eigener UUID.
- `recovery/ui.go` mit Skript auf stdin (Bestätigung, Abbruch, Fortsetzen, Prüfwert,
  Freigabe); `sanitizeForConsole` mit ANSI, `\r`, C1, ungültigem UTF-8.

TypeScript (Vitest): Schema (beide Plattformen, ungültige Beispiele), Zusammenfassung,
Stufe-1-Bewertung mit gesammelten Fakten, `fstab`-Zerleger, Probe-Muster,
`baremetalReadiness` (jede Zeile der Tabellen 12.4 und 12.5), `judgeDarwinCheck`,
Code-Erzeugung (Gleichverteilung grob, Alphabet), `canonicalOrigin`, Pfadabbildung,
`restoreSelectionIssue`, Schwärzung, i18n-Vollständigkeit der neuen Codes.

### 21.2 Integration in der CI

- **Job `agent-root`** (neu, Ubuntu-Runner mit `sudo`): Loop-Geräte mit LVM (dick, thin,
  VG ohne freien Platz), md RAID1, LUKS2, btrfs mit verschachtelten Subvolumes, ext4, XFS;
  `restow-agent baremetal capture --raw-dir` auf diesen Stapeln, Vergleich mit eingecheckten
  Testdaten; echte Snapshots mit `internal/fssnap`, Helfer mit Namensraum und `chroot`,
  `noauto`-Einhängung im Helfer, restic gegen `rest-server`, Pfade im Snapshot gleich den
  echten, keine Einhängung bleibt nach `kill -9` des Agenten, Aufräumen übrig gebliebener
  Snapshots, Thin-Pool-Schwelle (Pool absichtlich füllen); dazu der Planer und die
  Ausführungsschritte bis einschließlich Restore auf Loop-Geräte (ohne Bootloader), die
  Halter-Freigabe (aktivierte md, VG, Swap auf der Zielplatte) und der Isolations-Test aus
  10.14.
- **Job `test`** (TS) lädt das Artefakt `agent-linux-amd64` aus dem Job `agent`
  (`needs: agent`); `RESTOW_PLANNER_BIN` zeigt darauf. Fehlt es, scheitert die Suite (kein
  Überspringen).
- **Server (Postgres-Tests):** Code ausstellen (Origin, Prüfwert, `requireApproval`),
  eintauschen (Beweis mit falscher Origin 401, idempotent nur 15 Minuten und nur vor
  `release`, zweiter Hash 409, abgelaufen, widerrufen, toter Code schreibt
  `recovery_code.rejected`, Fehlversuche je Adresse im eigenen Zähler und ohne Wirkung auf
  `authFailures`, Body über 64 KiB 413), Freigabe (ohne Freigabe keine Zugangsdaten,
  30 Minuten → `failed`), Zugangsdaten (einmal plus eine Wiederholung in 5 Minuten,
  `no-store`), restic-Route `reader` (jede Schreib- und Löschoperation 403, `runId` ≠
  Sitzung 401, Ende und Abbruch 401 nach höchstens 5 s), Sperre gegen Retention in beiden
  Reihenfolgen (`pending_approval` sperrt nicht), Entfernen 409, CHECK-Constraints (48 h,
  Wiederanbindungs-Token 24 h), Zustandsautomat mit genau einem Audit-Eintrag je Übergang
  (9.9), Layout im Abschluss (gültig, ungültig, Steuerzeichen, zu groß, dedupliziert),
  Stufe 1 gegen ein echtes Repository mit `rest-server` mit dem echten Planer-Binary,
  Planer ohne `RESTOW_*`-Umgebung (12.2), Wiederanbindung (Secret gewechselt, altes 401,
  Repository gleich, widerrufen ohne `unrevoke` 409, mit `unrevoke` `endpoint.unrevoked`,
  `mac_setup` → `migrationPending`, kein Lauf bis Migration, `activity_baseline` beim ersten
  Lauf), Migrationssitzung (nur der Ziel-Mac darf sie einlösen, liest nur das alte
  Repository), Audit-Einträge, Alarme, RLS, jede Migration einzeln (14.2).
- **Jobs `recovery-iso` und `recovery-iso-rebuild`** (8.3), mit dem Test "keine
  Auto-Aktivierung" und `no-secrets.sh`.
- **Job `recovery-e2e`** [CI] (Ubuntu-Runner mit `/dev/kvm`; die Runner von GitHub stellen
  KVM bereit, Rechte über eine udev-Regel im Job): Treiber `scripts/recovery-e2e/run.mjs`
  startet eine Testinstanz (wie `scripts/smoke`), baut die Quellmaschine, sichert, löscht
  die Platten, stellt einen Code aus, startet das ISO in QEMU mit `--answers` über `fw_cfg`,
  gibt die Sitzung über die API frei, wartet auf den Abschluss über die API, startet die
  wiederhergestellten Platten und erwartet auf der seriellen Konsole `E2E-BOOT <hostname>
  <sha256 der Markerdatei>` (eine Unit, die die Quellmaschine beim Bau bekam). Er nutzt
  dieselbe QEMU-Schicht wie das Labor (`apps/worker/src/endpoints/lab/qemu.ts`), testet sie
  also mit. Alle QEMU-Platten mit `serial=`; wo die Quelle virtio hatte, ist das Ziel ein
  anderer Controller. Fälle:

| Fall | Quelle | Ziel | Bei |
| --- | --- | --- | --- |
| E1 | Debian 12, BIOS, MBR, mdadm RAID1 aus zwei Platten, ext4 `/` und `/boot`, Swap-Partition, initramfs-tools | eine Platte, größer (RAID1 degradiert) | jedem PR mit Änderungen an `agent/internal/{baremetal,recovery,fssnap}`, `integrations/recovery`, Recovery-API |
| E1b | Ubuntu 22.04, BIOS, GPT mit BIOS-Boot-Partition je Platte, mdadm RAID1 | eine Platte fehlt (redundante Startpartition entfällt) | nachts |
| E2 | Ubuntu 24.04, UEFI mit Secure Boot (OVMF mit Microsoft-Schlüsseln, eine `OVMF_VARS` für beide Phasen, aktuelle DBX), GPT, ESP, `/boot`, LUKS2 + LVM (`root`, `swap`, `home`), shim, netplan mit `macaddress` | NVMe statt virtio, kleiner, andere MAC; einmal zusätzlich mit leeren NVRAM-Variablen | jedem solchen PR |
| E3 | AlmaLinux 9, UEFI, LVM mit `system.devices` (Platten mit `serial=`), XFS, dracut `hostonly`, SELinux `enforcing`, BLS, `vconsole.conf` mit `de` | SATA (AHCI) statt virtio, andere Seriennummern | nachts |
| E4 | Fedora (aktuell), UEFI, btrfs mit Subvolumes `root`, `home`, verschachteltem `/var/lib/machines` und Docker mit btrfs-Treiber, `compress=zstd:1`, zram | größer | nachts |
| E5 | openSUSE Leap 15.6, btrfs mit Snapper nach `snapper rollback` (Wurzel = Snapshot N ≠ 1), Quota an, GRUB2 | gleich | nachts |
| E6 | Debian 13, UEFI ohne Secure Boot, LVM thin, systemd-boot (selbst eingerichtet) | 4Kn-Platte | nachts |
| E6b | Arch Linux, systemd-boot mit UKI (mkinitcpio `default_uki`), ESP mit `x-systemd.automount` | NVMe statt virtio | nachts |
| E7 | Debian 12, LUKS1 mit verschlüsseltem `/boot` (GRUB entsperrt, Eingabe über QMP `send-key`), BIOS + GPT + BIOS-Boot-Partition, Passphrase mit `z`, `y` und `-` | gleich | nachts |
| E8 | Abbruch mitten im Restore und Fortsetzen; zweiter Code nach "Stromausfall" (QEMU hart beendet), `--overwrite always` | – | nachts |
| E9 | System-SSD plus Daten-RAID5 aus drei Platten mit LVM | neue Systemplatte, Daten-RAID **übernommen**, alte Systemplatte bleibt angeschlossen (Identitätskonflikt erkannt, mit `wipefs` geleert) | nachts |
| E10 | Debian 12 mit Plain-dm-crypt-Swap `cswap /dev/vdb2 /dev/urandom swap` und Datendateisystem auf `vdc1` | Platten in anderer Reihenfolge | nachts |

  Quellmaschinen: für E3 bis E6b die offiziellen Cloud-Images (SHA-256 gepinnt) mit
  cloud-init (Agent installieren über `linux.sh` der Testinstanz, Marker-Unit); für E1, E1b,
  E2, E6, E7, E9, E10 baut die Testmaschinen-Fabrik (`integrations/recovery/test/machines/*.sh`)
  die Maschine in einer QEMU-VM, die vom ISO selbst gestartet wird (es hat alle Werkzeuge):
  partitionieren, verschlüsseln, `debootstrap` aus demselben snapshot.debian.org-Stand bzw.
  Ubuntus Archiv, Kernel, Bootloader, cloud-init. Dauer je Fall etwa 10 bis 20 Minuten mit
  KVM. Die volle Matrix läuft in `recovery-nightly.yml` und vor jedem Release (`release.yml`
  wartet darauf).
- **Startprobe** einmal in `recovery-e2e` (E2 zusätzlich über die Queue `endpoint-boot-probe`
  mit dem getrennten Labor-Container), damit Labor, Labor-API und Bewertung Ende zu Ende
  laufen.
- **Job `agent-macos`** (neu in `ci.yml`, `macos-15` arm64, dazu ein Intel-Image, solange
  GitHub eines anbietet; sonst bekannte Grenze): `go test ./...` unter darwin; vorher
  `csrutil status` (bei aktivem SIP **scheitert** der Job mit klarer Meldung), dann
  Festplattenvollzugriff für das Test-Binary per Eintrag in die System-`TCC.db`;
  `tmutil localsnapshot`, `mount_apfs`, Überwachung und Aufräumen echt (die
  Time-Machine-Snapshots des Runners bleiben unberührt); Ende zu Ende gegen `rest-server`:
  Fixture-Benutzer mit `sysadminctl -addUser` (UID 600) anlegen, Dateien mit Resource Fork,
  xattrs, ACL, `uchg`, einer dataless-Attrappe und Kompression (`ditto --hfsCompression`)
  sichern, Benutzer löschen und mit UID 601 neu anlegen, `darwin_migration` ausführen,
  Vergleich mit `ls -le@O`, `xattr -l`, `stat -f '%u %g %Sf'` gegen die erwarteten
  Abweichungen aus 1.2 Punkt 5; `state.json` in keinem Snapshot. Auslöser: Pfadfilter wie
  E1 und E2, also jeder PR mit Änderungen an `internal/fssnap/*darwin*`, `migrate_darwin.go`,
  `pathmap.go`, `sysinfo_darwin.go`.

### 21.3 Grenzen der CI

QEMU zeigt keine echte Firmware (NVRAM-Eigenheiten, CSM, Hersteller-Secure-Boot mit eigener
DB/DBX außer der eingespielten), keine echten Netzwerkkarten außer `e1000e`/`virtio`, keine
Hardware-RAID-Controller, keine USB-Sticks, keine BMC-Konsolen, keine 4Kn-Eigenheiten echter
Platten, keine SED, keine SAN-LUNs, keine Stromausfälle echter Platten. Ob die gehosteten
Runner KVM in jedem Lauf bereitstellen, ist zu beobachten; ohne KVM bricht `recovery-e2e` mit
klarer Meldung ab (TCG wäre zu langsam). Der macOS-Runner hat SIP aus und keine echte
Neuinstallation; die Schritte "macOS neu installieren" und FileVault prüft nur die Checkliste.

### 21.4 Auf echter Hardware (Maintainer, vor dem Release)

Testsysteme (Vorschlag): ein Rack-Server mit UEFI und Secure Boot und Broadcom- oder
Intel-Netz (z. B. Dell PowerEdge mit PERC oder HPE ProLiant mit Smart Array, iDRAC/iLO), ein
älterer Server oder Arbeitsplatz mit Legacy-BIOS und zwei SATA-Platten, ein neuer Rechner
ohne CSM, ein Laptop mit NVMe, UEFI, Secure Boot, TPM2 und VMD/RST, ein Secured-core-Gerät
(3rd Party CA ab Werk aus), ein Arbeitsplatz mit Realtek-Netz und AMD-GPU, ein Server mit
FC-HBA, ein Apple-Silicon-Mac und ein Intel-Mac, ein Proxmox-VE-Host.

**Freigabe-Gate** (Pflicht vor dem Release): Punkte 1, 2, 3, 4, 5, 6, 8, 11, 12, 15, 18, 20,
22, 23, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 37, 40. Die übrigen folgen und gehen in 0.5.x
ein.

1. Auf jedem System `restow-agent baremetal capture --raw-dir` ausführen, Ausgaben als
   Testdaten einchecken (geschwärzt: Seriennummern), Manifest gegen die Wirklichkeit
   prüfen (`lsblk`, `efibootmgr -v`, `mokutil --list-enrolled`).
2. Rack-Server, Debian 12, UEFI + Secure Boot, ext4 auf LVM auf Hardware-RAID: Ganz-Rechner-
   Sicherung, Stufe 1 grün; Wiederherstellung auf demselben Server mit neuen Platten (VD im
   Controller angelegt); startet mit Secure Boot, Netz kommt hoch (gleiche MAC), Dienste
   laufen.
3. BIOS-Rechner, Ubuntu 22.04, mdadm RAID1 auf zwei SATA-Platten: Wiederherstellung auf
   **andere** Hardware mit CSM und einer SATA-SSD (degradiertes RAID1); startet; `mdadm --add`
   der zweiten Platte danach.
4. Laptop, Ubuntu 24.04 mit LUKS2+LVM (Standard-Verschlüsselung des Installers), TPM2 per
   `systemd-cryptenroll` eingeschrieben: Wiederherstellung auf eine größere SSD; neue
   Passphrase; Start fragt nach ihr; TPM2 neu einschreiben nach Hinweis.
5. Alma/Rocky 9, UEFI, XFS auf LVM, SELinux `enforcing`: auf andere Hardware (AHCI nach
   NVMe); Kontexte erhalten, kein vollständiges Relabel; Anmeldung, Dienste, `ausearch` ohne
   neue AVCs.
6. Fedora mit btrfs-Subvolumes auf kleinere Platte; Snapper-Fall mit openSUSE
   (Snapper-Subvolumes leer, `snapper list` geht, GRUB-Menü ohne alte Snapshots).
7. Arch mit systemd-boot und ESP als `/boot`, mit UKI.
8. Getrenntes `/boot` (ext4) + ESP + LUKS-Wurzel, BIOS + GPT mit BIOS-Boot-Partition.
9. Mehrere Platten: System auf SSD, Daten auf mdadm RAID5 mit LVM thin; Thin-Pool während
   einer Sicherung auf 85 Prozent füllen: kein Snapshot bzw. Abbruch nach 6.2, Pool nie voll.
10. 4Kn-Platte als Ziel; MBR-System auf eine Platte über 2 TiB (Warnung, Rest frei).
11. Netz: DHCP, statisch, Proxy; NTP gesperrt mit falscher RTC (Uhrzeit von Hand);
    Netzwerkkarte ohne Firmware im ISO (Meldung verständlich), USB-Netzwerkadapter als
    Ersatz; eigene CA über Datei und über eingetippten Prüfwert.
12. Konsole: serielle Konsole über IPMI SOL/iDRAC/iLO; SSH-Fernzugang (Passwort vor dem
    Tausch, danach nur Schlüssel, Hostschlüssel in der Oberfläche); deutsche
    Tastaturbelegung beim Code.
13. Abbruch mitten im Restore und Fortsetzen; Strom aus mitten im Restore, neuer Code,
    Fortsetzen mit `--overwrite always`.
14. Code läuft während des Restores ab, Verlängern in der Oberfläche; danach neuer Code.
15. Firmwaremodus falsch (BIOS-Sicherung, ISO im UEFI gestartet): Meldung und Weg.
16. Netzwerkschnittstellen umbenennen auf neuer Hardware mit statischer Konfiguration
    (netplan mit `macaddress`, NetworkManager, `ifcfg` mit `HWADDR`).
17. Wiederanbindung im ISO und danach in der Oberfläche; der alte Rechner (noch an)
    verliert die Verbindung; nächste Sicherung nutzt den alten Snapshot als Eltern; ein
    widerrufener Rechner bleibt ohne `unrevoke` widerrufen.
18. Startprobe im Labor (Server mit KVM) für die Systeme 2 bis 8: grün; Kernel-Update auf
    einem: Zustand `layout_checked`, Probe läuft, wieder grün.
19. Stufe 1 rot erzwingen: `/boot` per Job-Ausschluss weglassen; Beleg verständlich.
20. ISO: Schreiben mit `dd` und Rufus (DD-Modus), Start mit Secure Boot an und aus, CSM,
    über virtuelles Medium des BMC; Signatur mit `verify-agent-signature.sh` und dem
    Schlüssel aus dem Git-Tag unter Linux und macOS prüfen; Nachbau des ISO aus dem Tag auf
    einem anderen Rechner ergibt dieselbe SHA-256, und `sign-agent.sh --iso` signiert erst
    dann.
21. LVM-Snapshot läuft während einer schreiblastigen Sicherung über: `snapshot_failed`,
    Politik `continue` und `fail`.
22. macOS: Sicherung vom APFS-Snapshot mit geöffneter Mail und Fotos-Mediathek; ohne
    Festplattenvollzugriff (`snapshot_unavailable`, Alarm `endpoint.fda_missing`); Mac neu
    aufsetzen auf einem anderen Modell (Apple Silicon), Benutzer mit gleichem Kurznamen und
    gleichem Passwort, Daten und Programme zurück, Anmeldung, Schlüsselbund öffnet ohne
    Rückfrage.
23. macOS: Intel-Mac, FileVault an; Benutzer mit anderer UID als vorher
    (`--ownership-by-name`), Standard-ACLs des Home-Ordners stimmen (`ls -le`).
24. Wiederherstellung einer VM (PVE-Gast mit Agent) in eine neue VM mit anderer
    Plattengröße und anderem Controller (virtio-scsi statt SATA).
25. macOS Intel → Apple Silicon: Rosetta-Frage, Homebrew ausgelassen, Liste "neu
    installieren" vollständig.
26. macOS Apple Silicon mit FileVault: nach dem Löschen des Hilfsadmins Neustart, Entsperren
    durch den zurückgeholten Benutzer, Softwareupdate geht (Volume Owner).
27. macOS Selbst-Update des Agenten: Der Festplattenvollzugriff bleibt, der nächste Lauf ist
    `used` (bei signiertem Binary); sonst erscheint `fda_lost` und der Weg ist verständlich.
28. macOS mit aktivem Time Machine und lokalen Snapshots: nach 10 Läufen sind die
    TM-Snapshots unberührt (`tmutil listlocalsnapshots /` vorher und nachher gleich bis auf
    eigene).
29. macOS: zwei Läufe auf frischem Mac mit Festplattenvollzugriff enden `succeeded`, nicht
    `partial`.
30. macOS Option "alter Mac läuft weiter": Der alte sichert weiter, der neue liest über die
    Migrationssitzung, beide erscheinen getrennt.
31. Alte Platte bleibt angeschlossen (neue SSD dazu, alte steckt noch): Identitätskonflikt
    erkannt, Weg verständlich, nach `wipefs` kein Konflikt, Start von der neuen Platte.
32. Nur die Systemplatte ersetzt, Daten-RAID übernommen: nichts darauf gelöscht, Daten
    unverändert (Prüfsummen vorher und nachher), System startet und hängt es ein.
33. Alma/RHEL 9 mit `system.devices` auf andere Hardware: alle VGs aktiv, kein Notfallmodus.
34. Passphrase mit `z`, `y` und Sonderzeichen auf `de`-Tastatur, mit und ohne
    GRUB-cryptodisk: nach dem Neustart eingebbar, wie von `recover` angesagt.
35. Secure Boot auf Firmware mit ausgeschalteter 3rd Party CA bzw. aktueller DBX und SBAT;
    Sicherung einer nicht aktualisierten Ubuntu 22.04: Problem vor dem Löschen, Wege
    verständlich.
36. DKMS-NIC-Treiber (z. B. `r8125`) mit MOK: MokManager beim ersten Start mit dem
    angezeigten Passwort, danach Netz.
37. BIOS-System auf Hardware ohne CSM: Warnung schon auf der Rechnerseite, Meldung im ISO,
    nichts gelöscht.
38. Zwei Platten mit BIOS-Boot-Partition bzw. ESP je Platte, eine fehlt: Plan erlaubt es,
    Start von der verbleibenden.
39. Laptop mit VMD/RST (Hinweis AHCI), SED-gesperrte SSD (I/O-Fehler, Hinweis PSID), NVMe mit
    zwei Namensräumen (Kennung eindeutig), Server mit FC-HBA und sichtbaren SAN-LUNs (nicht
    zugeordnet, nur auf Freigabe).
40. SOL auf `ttyS1` bei iDRAC und iLO (Menü und `recover` lesbar); Arbeitsplatz mit AMD-GPU
    (Bild ohne Grafiktreiber).
41. openSUSE nach Rollback (Wurzel = Snapshot N ≠ 1): `snapper list` und `snapper rollback`
    gehen, GRUB-Snapshot-Menü intakt.
42. Proxmox-VE-Host mit LVM-thin: `raw`-LVs nicht angelegt, Hinweis auf die PVE-Integration,
    Host startet, VMs danach über die PVE-Integration zurück.
43. Ubuntu 22.04 mit `/boot` 512 MB und drei Kerneln: Standard-Kernel neu, übrige "nicht
    angepasst", kein volles `/boot`, Start geht.
44. Switch-Port mit STP ohne Portfast: Adresse kommt nach bis zu 50 Sekunden, keine
    Fehlmeldung vorher.

## 22. Reihenfolge und Meilensteine

Jeder Meilenstein ist einzeln mergebar, mit eigenen Tests, eigener Migration und eigenem
CHANGELOG-Eintrag (Abschnitt 18), und lässt die vorigen unverändert gelten. Getaggt wird
0.5.0 erst nach M5 (und M6, wenn fertig).

- **M1: Ganz-Rechner-Sicherung (Linux).** `state.json`-Ausschluss für alle Sicherungen auf
  allen Systemen (macOS über `expandDarwinExcludes`); Sperre der Schlüsseldateien für
  `tenant_restore`; `fssnap` (LVM, btrfs je Subvolume, Namensraum-Helfer mit `noauto`,
  Aufräumen, Schutz, "kein Verfahren" bei voller VG); `consistency` unter Linux;
  `wholeMachine` im Job und in `GET /config` (hinter `RESTOW_BAREMETAL_PREVIEW`); Quellen
  (Subvolumes, `fstab`, Automount), Ausschlüsse, `-x`, `--group-by host`, Tags; Messung aus
  dem Snapshot-Baum; `baremetal.Capture` mit allen Feldern aus 4.1 und Manifest im Snapshot
  und im Abschluss; Schema in Go und TS (diskriminiert nach Plattform) mit gemeinsamen
  Testdaten; Migration 0074; Rechnerseite zeigt "Layout erfasst" und die Zusammenfassung.
  Tests: 21.1 Erfassung, 21.2 `agent-root`. Wert für sich: konsistente Linux-Sicherungen.
- **M2: Planer und Stufe 1.** `baremetal.Plan`, `mkfs`, Größen (Bytes, LBA, Restore-Größen),
  Zuordnung mit Übernahme, Treiber- und Secure-Boot-Prüfung (rein), Fixups (rein);
  `restow-agent baremetal plan` mit Grenzen; Worker `baremetal-check` mit isoliertem Planer;
  Bewertung bis `layout_checked`; Karte mit Mindestgrößen und Prüfbericht; Migration 0075.
  Tests: Golden Files, Stufe 1 gegen `rest-server` mit dem echten Binary (`needs: agent`).
- **M3: Code, Freigabe, Sitzung, Wiederanbindung.** Codes mit Origin-Bindung und Prüfwert,
  Tausch, Freigabe, Zugangsdaten, Recovery-API, `reader`-Route, eigener Fehlerzähler, Sperre
  gegen Prune, Audit, Alarme, Problemtypen; Wiederanbindungs-Token in eigenem Dialog und
  `enroll`-Zweig; Migration 0076. Code-Dialog und Assistent sind ausgeblendet, solange
  `GET /api/v1/recovery-iso` kein geprüftes ISO meldet; die API ist da und durch die
  Postgres-Suiten getestet. Für sich nutzbar: Wiederanbindung (`purpose: "reinstall"`, etwa
  nach einer Neuinstallation).
- **M4: ISO und `recover`.** `integrations/recovery` mit reproduzierbarem Bau, Lockfile,
  Doppelbau, Firmware, Signatur im Release mit Nachbau beim Maintainer, Quellbündel;
  `recover` vollständig (10.2 bis 10.20) mit Isolation; `recovery-e2e` E1/E2 je PR, E1b und
  E3 bis E10 nachts. Ab hier sind Code-Dialog und Assistent sichtbar und Linux Bare Metal
  (Vorschau) benutzbar.
- **M5: Startprobe und "Grün ist Beweis" (Pflicht für 0.5.0).** Getrenntes Labor-Image,
  Labor-API, Probe-Listener, Compose-Profil, `boot-probe` mit anderem Controller, einer
  NVRAM-Datei und DBX, Fingerabdrücke, Bewertung `green`/`overdue`/`red`, Alarme,
  Readiness-Spalte; Migration 0077.
- **M6: macOS.** APFS-Snapshot mit UUID-Lebenszyklus (`fssnap/apfs_darwin.go`),
  Data-Volume-Quelle mit Ausschlüssen, Pfadabbildung (drei Formen), Manifest `darwin`,
  Heartbeat `macUsers` und `fullDiskAccess`, Restore-Modus `darwin_migration` (auch aus
  0.4-Snapshots), Migrationssitzung, Sicherungspause, `darwin_check`, Assistent "Mac neu
  aufsetzen", Job `agent-macos`; Migration 0078; Signierung, falls 25.B19 angenommen.

Rutscht der Plan: **M5 ist Pflicht für 0.5.0.** Rutscht M5, bleibt Linux Bare Metal in 0.5.0
verborgen (`RESTOW_BAREMETAL_PREVIEW` aus, Job-Schalter und Assistent nicht sichtbar), statt
ohne Beweis ausgeliefert zu werden; die Linux-Dateisystem-Snapshots (`fsSnapshot`) bleiben,
sie sind für sich geprüft. Nur M6 darf als Ganzes nach 0.5.x. Das Freigabe-Gate (21.4) gilt
für das, was ausgeliefert wird (ohne M6 entfallen die macOS-Punkte).

## 23. Bekannte Grenzen (Zusammenfassung)

Für agent/README.md "Known limits" und docs/AGENT.md: Abschnitt 2.2 (Umfang), Speicherstapel
wird nicht umgebaut (Grundregel 1; BIOS→UEFI ist Kandidat für 0.5.x), BIOS-Sicherungen
brauchen Ersatzhardware mit CSM, TPM2/FIDO2/Clevis neu einrichten (10.10), LVM-VG- und
LV-UUIDs neu (10.10), btrfs-Subvolume-IDs neu (10.11), Dateiattribute (`chattr`) außer `+C`
nicht wiederhergestellt (1.2), LUKS auf LV live gesichert (6.6), `raw`-LVs nicht gesichert
(10.10), nicht angepasste initramfs älterer Kernel bei wenig Platz auf `/boot` (10.15),
Secure Boot mit gesperrter Startkette verlangt Abschalten oder ein Update nach dem Start
(10.5), Startprobe stellt Datendateisysteme leer her und lässt bei Größe große Datenordner
leer (12.3), kein Labor ohne KVM-fähigen Server (12.3), macOS nur Benutzerordner und
Drag-and-drop-Programme, ohne ACLs außer den Standard-ACLs, BSD-Flags und Erstellungsdaten
(13.8), Festplattenvollzugriff nach jedem Update neu (falls nicht signiert, 13.3),
Quellcode-Bündel als eigener Download (8.7), nur amd64.

## 24. Offene Fragen

Diese Punkte hat der Maintainer nicht entschieden; der Entwurf schlägt vor und setzt den
Vorschlag um, wenn keine andere Entscheidung kommt.

1. **GPL-Quellcode:** Quellbündel als Release-Anhang (Vorschlag) oder zusätzlich ein
   schriftliches Angebot im ISO? Das Bündel ist einige GiB groß.
2. **Labor:** eigenes optionales Image und Compose-Profil (Vorschlag) mit der Folge, dass
   ohne Labor Bare Metal nie grün wird. Alternative: Startprobe nur in der CI und auf dem
   Rechner des Maintainers, dann wäre "grün" auf Installationen nur "Layout geprüft".
3. **Übertragung der grünen Startprobe** über gleiche Fingerabdrücke, höchstens 8 Tage
   (Vorschlag, 12.4), statt einer Probe für jeden Snapshot.
4. **Vorgabe `fsSnapshot`** für Sicherungen ohne `wholeMachine`: `off` in 0.5.0
   (Vorschlag), `auto` nach Erfahrungen aus 0.5.x.
5. **Wiederanbindungs-Token** in 0.5.0 (Vorschlag, M3) und als Grundlage der
   Klonerkennung.
6. **arm64-ISO** erst nach 0.5.0 (Vorschlag).
7. **Liste der geprüften Distributionen** (2.1) und ob "nicht geprüft" die Wiederherstellung
   erlaubt (Vorschlag: ja, mit Warnung im Plan).
8. **Grenze der Startprobe** `RESTOW_LAB_MAX_RESTORE_GIB` = 64 (Vorschlag), mit leeren
   großen Datenordnern darüber (12.3).
9. *(geschlossen: Der Code-Dialog zeigt den Prüfwert der Instanz, 9.2, 10.3.)*
10. **Lizenz des Werks** GPL-3.0-or-later (Vorschlag) oder GPL-2.0-or-later.
11. **Developer-ID-Signierung und Notarisierung der macOS-Binaries** (Vorschlag: ja, 25.B19).
    Braucht eine Mitgliedschaft im Apple Developer Program, ein Developer-ID-Zertifikat als
    Secret der Release-Pipeline (oder Signieren beim Maintainer wie `sign-agent.sh`) und eine
    Team-ID; ohne sie geht der Festplattenvollzugriff nach jedem Update verloren.
12. **Freigabe nach dem Eintausch standardmäßig an** (Vorschlag, 9.4), abschaltbar beim
    Ausstellen.
13. **Schwelle für Docker mit btrfs-Treiber** 200 Subvolumes für die Wahl "Images neu laden"
    (Vorschlag, 5.2).

## 25. Entscheidungen

### 25.A Entscheidungen des Maintainers (endgültig)

1. **Umfang 0.5.0:** Linux Bare Metal vollständig (Kennzeichnung "Vorschau"); macOS als
   "macOS neu installieren, dann Daten und Einstellungen aus der APFS-Snapshot-Sicherung
   zurückholen"; **Windows Bare Metal später, nicht in 0.5.0.**
2. **Edition:** Community, ohne Lizenzprüfung.
3. **Linux-Wiederherstellung:** bootfähiges Recovery-ISO als eigenes GPL-Werk unter
   `integrations/recovery`, getrennt vom Kern wie das Speicher-Plugin für Proxmox VE, geprüft von
   `check-separate-works`; feste Liste nicht-freier Firmware (benannt, begründet,
   Lizenzhinweise, Abschnitt 8.4); reproduzierbarer Bau in der CI; signiert wie das
   Agent-Release (Release-Schlüssel, Prüfung wie `verify-agent-signature.sh`); Modus
   `recover` des Agenten darin.
4. **Autorisierung:** Einmal-Wiederherstellungscode, in der Oberfläche für einen Rechner
   ausgestellt, Standard 4 Stunden, höchstens 48, einmal einlösbar, auditiert; er gibt nur
   Lesezugriff auf das Repository dieses Rechners für die Wiederherstellung, nichts sonst.
5. **Snapshots** einer Bare-Metal-fähigen Sicherung werden je Host gruppiert
   (`restic --group-by host`); `state.json` und die Geheimnisse des Agenten sind von
   Sicherungen ausgeschlossen.
6. **macOS:** Der APFS-Snapshot wird für die Sicherung nur lesend unter
   `/private/var/run/restow-agent/apfs` eingehängt (`tmutil localsnapshot`,
   `mount_apfs -s`), damit die Sicherung konsistent ist; die gemeinsame Richtlinie
   `snapshotOnFailure` (Standard `continue`) und das Berichtsfeld `consistency` gelten.
   Linux nutzt LVM- oder btrfs-Snapshots, wo vorhanden, unter derselben Richtlinie und
   demselben Feld.
7. **Maßstab:** Es muss beim ersten Mal auf echten Maschinen funktionieren; Entwurf für echte
   Hardware (UEFI und BIOS, GPT und MBR, mdadm, LVM inkl. thin, LUKS, btrfs, ext4, XFS,
   Swap, `/boot`, ESP, mehrere Platten, andere Plattengröße, NVMe/SATA, Fixups, initramfs,
   Secure Boot, Netz im ISO mit DHCP, statisch, Proxy, **kein VLAN**, Wiederherstellung
   **nur vom Restow-Server**, keine lokalen Plattenabbilder, Fortschritt und Abbruch,
   Prüfung danach, eine Restore-Prüfung, die der Server regelmäßig ausführt: **Grün ist
   Beweis**).
8. **Erfasst zur Sicherungszeit:** das Plattenlayout (sfdisk/sgdisk, `lsblk -J`, `blkid`,
   LVM-Metadaten `vgcfgbackup`, `mdadm --detail --scan`, LUKS-Angaben, btrfs-Subvolumes,
   Einhängetabelle, Bootloader-Fakten), als versioniertes JSON-Layout-Manifest neben dem
   Snapshot, mit Schema und Tests.

Keine dieser Entscheidungen ist durch die Reviews geändert. Die Freigabe nach dem Eintausch
(9.4) und die Migrationssitzung für macOS (13.6) halten 25.A4 ein: Beide geben nur
Lesezugriff auf das Repository des einen Rechners, einmal, höchstens 48 Stunden, auditiert.
Das Wiederanbindungs-Token gehört nicht zur Wiederherstellung, sondern ersetzt das nicht
mehr gesicherte `state.json` (25.A5) und ist darum ein eigener Vorgang mit eigenem Dialog.

### 25.B Entscheidungen dieses Entwurfs (Vorschläge, siehe Offene Fragen)

1. **LUKS: nur Metadaten, keine Header-Sicherung** (die Frage "luksDump headers?" aus dem
   Auftrag): bereinigte `luksDump`-Angaben (Version, Cipher, PBKDF, UUID, Flags,
   Token-**Typen**) ja, `luksHeaderBackup` nein, die rohe `--dump-json-metadata`-Ausgabe
   nein (Digests, Salts, Token-Inhalte; bei Clevis/Tang entschlüsselt das JWE mit dem
   Tang-Server die Keyslot-Passphrase). Eine Header-Sicherung enthält die verschlüsselten
   Keyslots; mit ihr und der alten Passphrase ließe sich eine weggeworfene alte Platte
   entschlüsseln. Für die Wiederherstellung wird sie nicht gebraucht, weil neue Volumes neue
   Hauptschlüssel bekommen und die Daten dateiweise zurückkommen.
2. **Identität bewahren** (UUIDs, PARTUUIDs, Labels, Namen, Funktionen) statt Konfigurationen
   umzuschreiben; Fixups nur für Gerätenamen, MACs und das, was sich nicht bewahren lässt
   (LVM- und Subvolume-IDs, Netzwerknamen, Gerätedatei, `resume_offset`). Folge: keine zweite
   Kopie der Identität am Ziel (10.7).
3. **Kein Umbau des Stapels** in 0.5.0; weniger Platten nur als degradiertes RAID mit
   redundanten Startpartitionen.
4. **LVM neu anlegen statt `vgcfgrestore`** (Thin-Pools, Größen).
5. **`mkfs` nur mit erfassten Funktionen**, Rücklesen danach; Block- und Sektorgrößen aus der
   Zielplatte.
6. **initramfs allgemein** (`--no-hostonly` mit `crypttab` und `vconsole.conf`,
   `MODULES=most`) für den ersten Start, nur für den Standard-Kernel sicher, für die übrigen
   nach Platz. **Keine** Unit, die beim ersten Start wieder Hostonly baut: Das nächste
   Kernel-Update baut mit der eigenen Konfiguration des Systems wieder Hostonly (die
   Datei `zz-restow-recovery` ist entfernt, dracut liest wieder `hostonly=yes`), und eine
   Restow-Unit auf Kundensystemen wäre ein weiterer Teil, der beim ersten Start schiefgehen
   kann.
7. **UEFI ohne `grub-install`**, NVRAM-Einträge schreibt `recover` selbst, Rückfallpfad mit
   `grub.cfg`-Stub bzw. shim-Fallback; BIOS mit `grub-install --no-nvram` je Platte.
8. **Linux-Snapshots im privaten Mount-Namensraum mit `chroot`**, damit Snapshot-Pfade den
   echten gleichen; macOS mit Präfix und Tag `restow-fsroot=apfs` bzw. `data`.
9. **Manifest im Snapshot maßgeblich**, Kopie in der Datenbank, keine Klartextdatei im
   Speicherziel.
10. **Planer im Agenten, auch auf dem Server** (Stufe 1) statt eines zweiten Planers in
    TypeScript, ohne Umgebung und mit Grenzen.
11. **Zeilenweise Bedienung** statt Vollbild-Oberfläche (kein Go-Modul, serielle Konsole,
    testbar).
12. **Repository-Zugang endet vor dem ersten Programm aus der Sicherung**, und diese
    Programme laufen isoliert (10.14).
13. **Debian 13 als ISO-Basis**, live-build, snapshot.debian.org mit `packages.lock`,
    Signatur über `agent-SHA256SUMS`, ISO nicht im Image, keine Auto-Aktivierung.
14. **Wiederherstellungscode** mit 30-Zeichen-Alphabet ohne Y/Z, an die Origin gebunden,
    Sitzungsgeheimnis aus dem ISO (nur Hash zum Server, idempotentes Eintauschen mit
    Zeitgrenze).
15. **Kein Prune und kein Entfernen** während einer aktiven Sitzung (nicht bei
    `pending_approval`).
16. **Grün nur mit Startprobe** für dieselben Fingerabdrücke, auf anderem Controller, mit
    einer NVRAM-Datei und aktueller DBX.
17. **macOS-Wiederherstellung in Konten, die der Administrator anlegt**, mit demselben
    Passwort; frische Ordner werden beiseitegelegt, nichts überschrieben, Besitzer nach
    Name; der Hilfsadministrator wird erst gelöscht, wenn ein Admin mit SecureToken da ist.
18. **Lizenz GPL-3.0-or-later** für `integrations/recovery`.
19. **macOS-Binaries mit Developer ID signiert und notarisiert** (`release.yml`, Job
    `agent-macos-sign`, Schlüssel des Maintainers); sonst bekannte Grenze und `fda_lost`
    (Offene Frage 11).
20. **Migrationssitzung `migration`** für "alter Mac läuft weiter": Lesezugang wie der Code,
    an den neuen Mac gebunden (13.6).
21. **Sicherungspause bis zur Migration** (`migrationPending`) und neue Basis der
    Ransomware-Signale nach jeder Wiederanbindung.
22. **darwin-Bewertung** mit eigener Prüfung `darwin_check` (12.5).
23. **Cloud-Ordner und TCC-Datenbank ausgelassen**, beim Sichern bzw. beim Zurückholen
    (13.2, 13.5); App-Store-, `pkg`- und Cask-Programme werden neu installiert.
24. **Freigabe nach dem Eintausch** mit Prüfzahl, Vorgabe an (Offene Frage 12).
25. **Prüfwert der Instanz statt Trust on first use**; die Uhrzeit nie aus einem `Date`-Kopf.
26. **Labor getrennt vom Worker**, ohne Datenbank und Master-Key.
27. **Eine Migration je Meilenstein** (0074 bis 0078) statt einer gemeinsamen.
28. **Übernahme statt Löschen** intakter Teile mit passender Identität; nie automatisch eine
    Platte mit passenden Signaturen zum Löschen zuordnen.
29. **Schlüsseldateien neu erzeugen** statt die gesicherte als Keyslot neuer Volumes zu
    übernehmen.
30. **`raw`-LVs nicht anlegen** (Vorgabe), statt leer neu anzulegen, als wären sie
    wiederhergestellt.
31. **M5 Pflicht für 0.5.0**; sonst Bare Metal verborgen.

### 25.C Review-Befunde, die anders oder nicht übernommen wurden

Alle übrigen Befunde der drei Reviews sind wie vorgeschlagen eingearbeitet.

1. **Code-Beweis (Review 2, Punkt 2) geändert:** Gespeichert wird nicht der Beweis selbst,
   sondern `SHA-256(codeProof)`. Sonst könnte jeder, der die Datenbank liest, mit dem
   gespeicherten Wert den Code einlösen; der erste Entwurf schützte davor, indem er nur den
   Hash des Codes speicherte, und das bleibt so erhalten.
2. **Prüfwert der Instanz (Review 2, Punkt 1) ergänzt:** Die eigene TLS-Verbindung der API
   kann scheitern (Hairpin-NAT, geteiltes DNS) oder hinter einem Load-Balancer ein anderes
   Zertifikat sehen als das ISO. Darum `RESTOW_PUBLIC_TLS_SPKI` als Vorgabe von Hand, und ohne
   Prüfwert gibt es keinen Rückfall, nur CA (statt eines falschen Werts).
3. **Reihenfolge Schlüsseldateien (Review 2, Punkte 4 und 7) geändert:** Neue
   Schlüsseldateien werden **vor** den `chroot`-Schritten erzeugt und eingeschrieben, nicht
   danach: Der initramfs-Neubau muss die neue Datei einbauen, und die Passphrase für
   `luksAddKey` soll vor dem ersten Programm aus der Sicherung aus dem Speicher sein. Beides
   ginge mit "nach den chroot-Schritten" nicht.
4. **Isolation (Review 2, Punkt 4) ergänzt:** `CAP_SYS_ADMIN` lässt sich für `grub-install`
   und `vgimportdevices` auf LVM/LUKS nicht ganz entfernen (device-mapper-ioctls); statt
   dessen verbietet ein seccomp-Filter Einhängen, `mknod`, Module, `kexec` und `ptrace`, und
   `/dev` ist ein `nodev`-tmpfs mit einzeln eingebundenen Knoten (10.14).
5. **Zugangsdaten "einmalig" (Review 2, Punkt 3/10) gelockert:** eine zweite, auditierte
   Abholung bis 5 Minuten nach der ersten, nie nach `release`. Grund: Eine verlorene Antwort
   ließe den Bediener sonst mit einem verbrauchten Code zurück; nur der Inhaber des
   Sitzungsgeheimnisses kann abholen, der Zugang wird also nicht breiter.
6. **Unbeaufsichtigt über `fw_cfg` (Review 2, Punkt 13) ohne Kernel-Parameter:** `fw_cfg`
   gibt es nur in einer VM, und wer es setzt, kontrolliert den Hypervisor; ein fremder
   USB-Stick kann es nicht. Ein Pflicht-Parameter hätte CI und Startprobe auf einen
   besonderen Startweg gezwungen und damit weniger von der echten Startkette geprüft. Für
   Antworten vom Medium gilt der Parameter wie vorgeschlagen.
7. **Labor-API (Review 2, Punkt 5) im Worker statt in der API:** Der Worker hält ohnehin den
   Probe-Listener und die Queue; eine weitere Route in der öffentlichen API wäre unnötige
   Angriffsfläche.
8. **Restore-Größen (Review 1, Punkt 20) über `restic ls` statt
   `restic stats --mode restore-size --path`:** `stats` filtert mit `--path` Snapshots, nicht
   Unterordner (zu belegen, 1.2 Punkt 4); je Einhängepunkt braucht es die Summe unterhalb des
   Pfads ohne darunterliegende Einhängepunkte.
9. **Hostonly-Unit beim ersten Start (Review 1, Punkt 10) nicht übernommen:** Begründung in
   25.B6.
10. **Leere Ordner der Startprobe (Review 1, Punkt 31) eingeschränkt:** nie Paket- und
    Systemdatenbanken unter `/var/lib` (sonst startete die Probe ein System ohne Paket- oder
    systemd-Zustand und bewiese das Falsche).
11. **Migrationen (Review 3, Punkt 22):** gewählt ist "eine Migration je Meilenstein", nicht
    "kein Tag vor 0.5.0, 0074 darf sich ändern"; der Wert `probe` kommt mit M5 und
    `migration` mit M6 statt mit M3, damit auch sie nicht vorab festgelegt werden.
12. **Migrationssitzung (Review 3, Punkt 8) ohne zusätzliche Freigabe:** Der Admin stellt sie
    im Assistenten mit frischer Anmeldung für einen bestimmten Ziel-Mac aus, der sich als
    Agent anmeldet; die Freigabe ist damit erteilt, und kein Code geht über Papier oder Chat.
13. **Signierung der macOS-Binaries (Review 3, Punkt 4):** als Vorschlag 25.B19 und Offene
    Frage 11 aufgenommen, nicht als entschieden, weil sie eine kostenpflichtige
    Apple-Mitgliedschaft und einen weiteren Schlüssel des Maintainers braucht.
14. **Leere VG (Review 1, Punkt 32) mit Schwelle:** "kein Verfahren" gilt unter 1 GiB freiem
    Platz in der VG, nicht nur bei null Extents, weil ein kleinerer Snapshot sofort überliefe.

## 26. Stand der Umsetzung

**M1 (Ganz-Rechner-Sicherung, Linux) ist umgesetzt**, hinter `RESTOW_BAREMETAL_PREVIEW`
(Standard aus). M2 bis M6 sind offen; für sie bleibt dieses Dokument der Entwurf.

### 26.1 Was M1 liefert

Server (`packages/`, `apps/`):

- `packages/core/src/endpoints/baremetal/`: `canonical.ts` (kanonische Kodierung nach 4.2,
  Schlüssel nach UTF-8-Bytes sortiert, `noControlChars`, `layoutSha256`), `manifest.ts`
  (`layoutManifestSchema` als `z.discriminatedUnion("platform", ...)`, Linux vollständig mit
  Referenzen, Zyklen, ID-Mustern und Grenzen, darwin vorläufig; `parseLayoutManifest`,
  `MAX_LAYOUT_BYTES`), `fingerprint.ts` (`layoutFingerprint`, nur Linux), `summary.ts`
  (`summarizeLayout`), `paths.ts` (`manifestPathInSnapshot`, `keyFilesOf`).
  `endpoints/whole-machine.ts` (`DEFAULT_WHOLE_MACHINE_EXCLUDES`, `CONTAINER_IMAGE_EXCLUDES`,
  `wholeMachineNote`, `wholeMachineApplies`, `resolveFsSnapshot`), `config.ts`
  (`wholeMachine`, `fsSnapshot`), `backup-jobs/endpoint-config.ts` (Schalter nur in Linux-Rechner
  ohne Container), `restore-target.ts` (`AGENT_STATE_SNAPSHOT_PATTERNS`, `isAgentStatePath`,
  `restoreSelectionIssue`, `selectionCovers`), `zip.ts` (`skip`), neue Lauf-Codes
  `layout_capture_failed`, `layout_too_large`, `layout_rejected` und der Fehlerkatalog
  `endpoint.layout_capture_failed` mit Schritt `check_endpoint_layout_tools`; die Texte zu
  `snapshot_failed`/`snapshot_unavailable` sind nicht mehr nur VSS. Die TS-Tests lesen die
  Testdaten des Go-Pakets (`agent/internal/baremetal/testdata/manifests`): kanonische Bytes,
  SHA-256 und Fingerabdruck stimmen mit Go überein, jedes `invalid-*` wird abgelehnt.
- `packages/db`: Tabelle `endpoint_layouts`, Spalte `endpoint_runs.layout_id` mit Teilindex,
  Migration **0076_baremetal_layouts** (mit drizzle erzeugt), Row Level Security über
  `sql/rls.sql`; Job-Einstellung `wholeMachine` (JSONB).
- `apps/api`: `RESTOW_BAREMETAL_PREVIEW` (`config.baremetalPreview`); `GET /agent/v1/config` mit
  `wholeMachine` und `fsSnapshot` (C2); `finish` speichert das Layout (`storeRunLayout`,
  dedupliziert, sonst Hinweis `layout_rejected`); `GET /api/v1/endpoints/:id/baremetal`
  (ab Restore-Rolle) und `.../baremetal/layouts/:layoutId` (Admin); `fsSnapshot` am Rechner (nur
  Linux, 422 `linux_only`); Sperre von `state.json` und Schlüsseldateien in Browser, Download und
  Restore-Auftrag (5.4); Job-Schalter mit 409 `baremetal-preview-off`, Standardwerte und
  `wholeMachineNote` je Mitglied; Audit `endpoint.repository.secret_file_revealed`; Regeln für
  Provider-Teams (Karte: Lesen, volles Manifest: Konfigurieren).
- `apps/worker`: der Monitor entfernt Layouts ohne Lauf, die nicht das neueste ihres Rechners sind.
- `apps/web`: Schalter "Ganzer Rechner (Bare Metal, Vorschau)" im Job-Editor (Ordner ausgegraut,
  Ausschlüsse ersetzt mit "Vorherige Ausschlüsse wiederherstellen", Container-Images), Hinweise je
  Mitglied, Karte "Bare-Metal-Wiederherstellung (Vorschau)" mit Zusammenfassung
  (`baremetal-card.tsx`, `layout-summary.tsx`), Einstellung "Dateisystem-Snapshot (LVM, btrfs)",
  "Layout erfasst" im Lauf, Konsistenz-Texte für LVM, btrfs und gemischt; Texte de/en.
- CI: Job `agent-root` (Loop-Geräte, LVM, btrfs, md, LUKS, XFS; Build-Tag `agentroot` und
  `RESTOW_AGENT_ROOT=1`), in `passed.needs`. `.env.example`: `RESTOW_BAREMETAL_PREVIEW`.
  CHANGELOG unter `[Unreleased]`, docs/AGENT.md ("Ganzer Rechner", Konsistenz, Fehlercodes,
  Datenmodell, Geheimnisse in Snapshots).

Agent (`agent/`): `internal/cmdrun` (Werkzeugaufrufe mit Zeit- und Größengrenze, verbotene
Argumente, Attrappe für Tests), `internal/sysparse` (Zerleger), `internal/baremetal` (Manifest,
kanonische Kodierung, Validierung, `Assess`, Fingerabdruck, EFI und PE, Sammler aus 4.1, Ablage
nach `Layout.BaremetalDir()`), `internal/fssnap` (Planung, LVM dick und dünn, btrfs je Subvolume,
Namensraum-Helfer mit `chroot` und `noauto`, Überwachung, Aufräumen), Ganz-Rechner-Zweig in
`backupStep`, Ausschluss der Agent-Zustandsdatei bei jeder Sicherung auf allen Systemen (macOS über
`expandDarwinExcludes`), `restow-agent baremetal capture` und das versteckte `snapshot-exec`.

Nachgebessert nach dem Review von M1:

- **LVM-Befehle werden nie getötet:** `lvcreate`, `lvchange` und `lvremove` laufen über
  `cmdrun.RunNoKill` (`ExecRunner.RunNoKill`): ohne den Abbruch des Laufs
  (`context.WithoutCancel`), mit eigener Grenze je Aufruf (`cmdrun.StateChangeTimeout`, 10 Minuten),
  an der Grenze `SIGTERM` und dann Warten, nie `SIGKILL` (ein `SIGKILL` zwischen Suspend und Resume
  kann das Ursprungs-LV, oft `/`, angehalten lassen). Der Abbruch wird nur zwischen zwei Befehlen
  geprüft. Scheitert `lvcreate` (oder erreicht es die Grenze), fragt der Agent mit `lvs` nach
  `<lv>_restowsnap` und entfernt einen Snapshot mit dem Tag `restow-agent-snapshot` und der Endung
  sofort.
- **Sicherung ohne `wholeMachine` mit `fsSnapshot: "auto"`:** restic läuft ohne `-x`, darum nimmt
  `Discover` jede Einhängung unterhalb einer Quelle (alle Typen außer `autofs`, nicht unter
  `/proc`, `/sys`, `/dev`, `/run`) und jedes nicht anderweitig eingehängte btrfs-Subvolume
  darunter als `Nested`-Quelle in den Baum: mit eigenem Snapshot, sonst als nur lesender Bind des
  echten Pfads, und dann in `liveFilesystems`. Nur lesende Snapshots von snapper und Timeshift
  werden live gebunden (alles darunter kommt mit dem Bind), die eigenen Snapshots des Agenten
  ausgelassen. Eine Einhängung, deren Eltern-Einhängung nicht im Baum ist (unter einem indirekten
  Automount-Punkt), bekommt einen Hinweis im Lauf-Log. Liegt das Subvolume einer Quelle unterhalb
  des Einhängepunkts seines Dateisystems, kommt dieser Einhängepunkt vorher als nur lesender Bind
  in den Baum. Tests: `TestTreeMountsNested` (Quelle `/` mit dem Fixture von `TestDiscover`),
  `TestTreeMountsSubvolBelowMount`, `TestCreateNeverKillsLVM`,
  `TestCreateRemovesLeftoverAfterFailedLVCreate`, `TestExecRunnerNoKill`.
- **Vorschau aus, Job mit `wholeMachine`:** Der Editor zeigt den Schalter nur zum Ausschalten
  (mit dem Hinweis, dass die Rechner die Ordner sichern), die Ordner bleiben bearbeitbar, "Alle
  lokalen Dateisysteme" entfällt. Das Ein- oder Ausschalten allein speichert jetzt auch (vorher
  verglich der Editor `wholeMachine` nicht und schickte nichts). Die Rechner-Details tragen
  `config.wholeMachineActive` (was `GET /agent/v1/config` sendet, `wholeMachineSent`); danach
  richtet sich der angezeigte Standard von "Dateisystem-Snapshot".
- **Root-Tests hier gelaufen** (als root, `RESTOW_AGENT_ROOT=1`, restic 0.19.1, ohne
  rest-server): `TestRootHelperLiveTree`, `TestRootKill9LeavesNothingMounted` und
  `TestRootResticLiveTree` bestanden; das Ergebnis zu [Quelle] 1.2 Punkt 2 steht in der Tabelle
  in 1.2.

### 26.2 Abweichungen vom Entwurf (in M1 entschieden)

- **Migrationsnummer:** 0074 und 0075 waren schon vergeben, M1 ist **0076**; M2 bis M6 rücken auf
  0077 bis 0081.
- **RLS** steht nach Konvention in `sql/rls.sql` (`tenant_tables`), nicht in der Migration.
- **Zwischendateien:** `state.Save` schreibt `.state-*.tmp`, nicht `.state.json.*`; ausgeschlossen
  und gesperrt sind beide Formen, unter Linux auch `/etc/restow-pve/state.json` und
  `/etc/restow-pve/.state.json.*`.
- **Mehrzeilige Daten** sind Listen von Zeilen: `firmware.sbatLevel` ist `string[]`, weil
  Steuerzeichen (auch `\n`) in keiner Zeichenkette erlaubt sind; abgelehnt werden zusätzlich
  U+2028/U+2029 (Go kodiert sie immer als Escape) und U+007F bis U+009F. Zahlen nur als ganze
  Zahlen 0 bis 2^53-1; eine Swap-Priorität ist darum Text (`priority`).
- **Reihenfolge 5.6:** Der Plan der Snapshots entsteht vor dem Manifest, das Manifest trägt das
  geplante Verfahren (`backup.fsSnapshots`, nach Quellpfad statt nach Dateisystem-ID, dazu
  `backup.liveReasons`), danach werden die Snapshots angelegt; das Ergebnis steht nur in
  `consistency`. So bleibt der SHA-256 in Datenbank und Snapshot gleich (L4).
- **VG-Größen** (`lvm.vgs[].sizeBytes`, `freeBytes`) sind Felder des Manifests, für den Hinweis aus
  6.1; sie gehen nicht in den Fingerabdruck.
- **Zustand der Konsistenz:** `used` (keiner gescheitert, einer hielt), `partial` (einer
  gescheitert, einer hielt), `unavailable` (keiner hielt). "Kein Verfahren" ist nie ein Fehler; der
  Lauf wird nur mit `snapshot_failed` oder `snapshot_unavailable` `partial`.
- **macOS** bekommt `wholeMachine` erst mit M6; M1 schreibt es nur in Linux-Rechner ohne Container.
  Ein darwin-Manifest ist im Schema vorläufig vorhanden, der Server lehnt es bis M6 mit
  `layout_rejected` ab.
- **Vorschau-Schalter:** nur der Job-Schalter (und später der Assistent) hängt an
  `RESTOW_BAREMETAL_PREVIEW`; `fsSnapshot` wirkt immer. Ist die Vorschau aus, sendet
  `GET /config` kein `wholeMachine`, und Einschalten wird abgelehnt; ein Job, der es schon hat,
  behält es.
- **btrfs:** Snapshots und ihr Löschen laufen immer über den Helfer in einem privaten
  Namensraum, der die oberste Ebene (`subvolid=5`) einhängt; auf dem Rechner bleibt nichts
  eingehängt. Der Snapshot-Baum enthält immer das Wurzel-Dateisystem (restic braucht `/etc` und die
  CA-Zertifikate), und bei `wholeMachine` läuft der Helfer immer, auch mit `fsSnapshot: "off"`.
- **Gleiche Bytes in Go und TS:** Go sortiert über `map`/`[]any` nach UTF-8-Bytes, ohne
  HTML-Escape, `nil`-Listen werden `[]`; TS sortiert mit `Buffer.compare`.
- **Beide Plattformen** erkennt das Schema an den reservierten Schlüsseln der jeweils anderen;
  unbekannte Schlüssel gehen durch und bleiben in der Datenbank wie gesendet.
- **Abschnitt 17** (Satz "kein Bare-Metal-Restore" ersetzen) ist nicht Teil von M1, die
  Wiederherstellung kommt mit M4.
- **Testdaten:** Aufzeichnungen echter Systeme und echte shim/GRUB/UKI-Dateien gibt es in dieser
  Umgebung nicht; M1 liefert **synthetische** Daten nach den dokumentierten Formaten
  (`"synthetic": true` in `meta.json`), PE-Dateien entstehen im Test. Sie sind durch Aufzeichnungen
  zu ersetzen ([Maschine] 27.1, 21.4 Punkt 1).
- **Sperre der Schlüsseldateien (5.4):** Die Zustandsdatei ist für alle Rollen im Browser
  ausgeblendet, als Einzelauswahl abgelehnt (422) und im Ordner-ZIP immer ausgelassen.
  Schlüsseldateien (`luks[].keyFile` des Layouts des Snapshots und des neuesten des Rechners) sind
  für `tenant_restore` ausgeblendet, gesperrt (403) und im ZIP ausgelassen; Admins bekommen sie mit
  frischer Anmeldung und Audit. Ein Ordner, der auf den Rechner zurückgeschrieben wird, wird nicht
  gefiltert (die Daten bleiben auf demselben Rechner, der Agent hat keinen Ausschluss-Parameter).
- **Texte** nennen keine Produkte anderer Hersteller ("Container-Images (btrfs-Speichertreiber)"
  statt eines Produktnamens).
- **Ordner des Jobs** bleiben bei `wholeMachine` erhalten (Agenten vor 0.5.0 sichern sie); der
  Editor graut sie nur aus, solange die Vorschau an ist. Ist sie aus, sichern die Rechner die
  Ordner, und der Editor zeigt sie bearbeitbar (siehe 26.1, Nachbesserungen).
- **systemd-Unit:** `RestrictNamespaces=mnt` statt `RestrictNamespaces=yes`, damit der
  Snapshot-Helfer seinen privaten Mount-Namensraum anlegen kann (6.3); alle anderen
  Namensraum-Arten bleiben gesperrt (`agent/internal/svc/systemd.go`, docs/AGENT.md,
  CHANGELOG unter "Changed").
- **`Pdeathsig`:** Helfer und restic im Baum starten mit `Pdeathsig: SIGKILL`; sie sterben mit dem
  Agenten, und mit ihnen der Namensraum samt Einhängungen, so dass nach `kill -9` kein Snapshot
  offen bleibt (6.5, `TestRootKill9LeavesNothingMounted`). Für `lvcreate` und `lvremove` gilt
  das ausdrücklich nicht (sie laufen ohne Namensraum über `RunNoKill`).
- **Sicherung ohne `wholeMachine`:** Der Entwurf beschreibt den Baum nur für die Quellen selbst;
  M1 nimmt die Einhängungen und Subvolumes unterhalb der Quellen mit auf (26.1), weil restic dort
  ohne `-x` läuft.

### 26.3 Zurückgestellt

- macOS: Erfassung unter darwin, APFS-Snapshots, `DEFAULT_DARWIN_WHOLE_MACHINE_EXCLUDES`,
  Snapshot-Form der Pfadabbildung, `layoutFingerprint` für darwin (M6).
- `BuildLoadOption` (M4).
- `bootChainFingerprint` und eine Bewertung über `unverified` hinaus (M2, M5).
- Ein Layout im Demo-Datensatz.
- Aufzeichnungen echter Systeme für die Testdaten ([Maschine] 27.1).
- Die Root-Tests mit LVM, btrfs, md, LUKS und der Erfassung (`TestRootThickLVM`,
  `TestRootFullVG`, `TestRootThinPool`, `TestRootBtrfsNested`, `TestRootCleanupStaleLVM`,
  `TestRootResticThroughHelper`, `TestRootCaptureStacks`, `TestRootCaptureCommand`) liefen hier
  nicht (keine LVM- und btrfs-Werkzeuge im Container; ohne `RESTOW_AGENT_ROOT=1` werden sie
  übersprungen); sie brauchen den CI-Job `agent-root` [CI].
- Ein Lauf, der LVM-Befehle beim Beenden des Dienstes noch abwartet, kann an `TimeoutStopSec=120`
  der Unit stoßen; dann beendet systemd mit `KillMode=mixed` alle Prozesse der Unit mit `SIGKILL`.
  Ob `lvremove` in diese Zeit fällt, ist [Maschine] 27.13 zu prüfen.
- Filtern beim Zurückschreiben eines Ordners auf den Rechner (siehe 26.2, Sperre).
- Aus Abschnitt 27 offen für M1: 27.1 (Ausgaben echter Systeme), 27.13 (LVM-Snapshots unter Last),
  27.14 (Thin-Pool-Schwellen mit `thin_pool_autoextend_threshold`), 27.15 (btrfs mit sehr vielen
  Subvolumes).

## 27. Nur auf echter Hardware zu prüfen

Gesammelt aus den Markierungen; nichts davon lässt sich in dieser Umgebung oder in QEMU
abschließend klären. Ergebnisse gehen in dieses Dokument und in die Testdaten.

1. Ausgaben von `lsblk -J -O`, `sfdisk --json`, `lvm fullreport`, `cryptsetup luksDump
   --dump-json-metadata` (nur zum Bau des Bereinigers), `btrfs inspect-internal dump-super`,
   `xfs_info`, efivars, `mokutil`, `/sys/firmware/efi/mok-variables` auf echten Systemen
   aller Distributionen aus 2.1 (Feldnamen und Formate je Version).
2. NVRAM: ob die Firmware der Testserver neue `Boot####`-Einträge annimmt, behält und in
   `BootOrder` respektiert; ob sie ohne Eintrag `\EFI\BOOT\BOOTX64.EFI` startet und ob
   `fbx64.efi` den Eintrag anlegt.
3. Secure Boot auf Herstellerfirmware mit aktueller DBX/SBAT und auf Secured-core-Geräten
   ohne 3rd Party CA: startet das ISO (shim aus trixie), hebt es `SbatLevel` an, stimmt die
   Vorhersage von `CheckChain` für die wiederhergestellte Kette.
4. CSM/Legacy-Start des ISO von USB auf Servern und Arbeitsplätzen; Verhalten neuer Hardware
   ohne CSM; BIOS-Start von NVMe; PMBR-Aktiv-Flag auf Lenovo, HP, älteren Dell.
5. Treiber und Firmware: jede Netzwerkkarte der Testsysteme kommt im ISO hoch (auch Intel
   E810 mit DDP, Broadcom bnx2x, Realtek RTL8125/8126); die Treiberprüfung (10.8) sagt für
   ältere Kernel richtig voraus, ob sie fehlen.
6. Hardware-RAID-Controller (PERC, Smart Array) im ISO und im wiederhergestellten System
   (Treiber im allgemeinen initramfs, Boot-VD).
7. Dauer und Belastung eines mdadm-Resyncs während des Restores auf HDDs.
8. Argon2-Parameter auf schwacher Hardware (Laptop mit 8 GiB) und Start mit der Passphrase.
9. Verhalten von `dracut --no-hostonly --include …` und `update-initramfs -u` mit
   `MODULES=most` auf RHEL 8/9 und Ubuntu 22.04/24.04 im isolierten `chroot` (Warnungen,
   Größe, Startzeit, nötige Rechte).
10. SELinux nach dem Restore: Kontexte erhalten (Stichprobe), `restorecon` der geänderten
    Pfade genügt; Relabel-Dauer im Rückfall.
11. Serielle Konsole über IPMI SOL/iDRAC/iLO auf `ttyS0` und `ttyS1`: Menü, Lesbarkeit der
    zeilenweisen Bedienung, Passphrase-Eingabe.
12. Tastaturbelegungen `de`, `ch`, `fr` beim Code und bei der Passphrase (Sonderzeichen), im
    initramfs jedes Erzeugers und bei GRUB-cryptodisk.
13. LVM-Snapshots auf ausgelasteten Produktionssystemen: Leistungseinbruch, COW-Größen,
    Überwachung im 30-Sekunden-Takt reicht.
14. Thin-Pool-Schwellen im Zusammenspiel mit `thin_pool_autoextend_threshold`.
15. btrfs-Snapshots bei sehr vielen Subvolumes (Docker mit btrfs-Treiber), Dauer und Platz.
16. APFS: `tmutil localsnapshot` ohne Time Machine, Ausdünnen eines eingehängten Snapshots,
    `tmutil` mit Time Machine und mehreren Volumes, Einhängen mit `mount_apfs -s` unter
    macOS 13, 14, 15, 26, Festplattenvollzugriff des Dienstes und seine Prüfung über
    `TCC.db`, Verhalten nach einem Selbst-Update mit und ohne Developer-ID-Signatur.
17. macOS: Wiederherstellung in ein frisch angelegtes, nie angemeldetes Konto; TCC-Schutz
    beim Schreiben in `~/Library` als root mit Festplattenvollzugriff; Schlüsselbund bei
    gleichem Passwort; `diskutil resetUserPermissions`; `containermanagerd` und
    zurückgeholte `~/Library/Containers`; Erkennung von "Schreibtisch & Dokumente in
    iCloud"; SecureToken und Volume Owner nach dem Löschen des Hilfsadmins.
18. Nachbau des ISO auf einem zweiten Rechner (anderer Docker-Host) bitgleich.
19. Startprobe-Muster gegen echte Fehlerausgaben (Notfallmodus, `dracut-initqueue`-Timeout,
    `ALERT! UUID=... does not exist`, Secure-Boot-Ablehnung).
20. Zeitbedarf einer Wiederherstellung über 1-GbE- und 10-GbE-Netz und über einen Proxy;
    Grundlage für den Vorschlag der Gültigkeit im Code-Dialog.
21. Zielgeräte: VMD/RST-Laptops, TCG-Opal-gesperrte SSDs, NVMe mit mehreren Namensräumen,
    FC-HBA mit SAN-LUNs und Multipath, eMMC; Lese- und Schreibprobe ohne Nebenwirkungen.
22. Netz: Link-Dauer von `bnx2x` und `ice`, STP ohne Portfast, LACP-Port, NTP aus DHCP.
23. Arbeitsplätze mit AMD- bzw. neuer Intel-GPU: Bild mit der Sperrliste, "mit
    Grafiktreibern" als Ausweg.
24. MOK: Einschreiben über MokManager mit dem angezeigten Passwort auf echter Firmware;
    DKMS-NIC-Treiber danach geladen.
25. Identitätskonflikte mit echten alten Platten (Firmware wählt beim Start welche?),
    Übernahme eines echten Daten-RAID samt LUKS mit alter Passphrase.
