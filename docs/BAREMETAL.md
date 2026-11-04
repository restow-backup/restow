# Bare-Metal-Sicherung und -Wiederherstellung für Restow 0.5.0 (Entwurf)

Dieses Dokument beschreibt, wie Restow 0.5.0 einen ganzen Rechner sichert und auf neuer oder
leerer Hardware wiederherstellt: **Linux vollständig** (Kennzeichnung "Vorschau") mit einem
bootfähigen Recovery-ISO und `restow-agent recover`, **macOS** als "macOS neu installieren,
dann Daten und Einstellungen aus der Sicherung vom APFS-Snapshot zurückholen", **Windows Bare
Metal nicht in 0.5.0**. Dazu gehören die Dateisystem-Snapshots unter Linux (LVM, btrfs) und
macOS (APFS) mit derselben Richtlinie `snapshotOnFailure` und demselben Berichtsfeld
`consistency`, die mit dem Windows-Agenten (VSS) gebaut wurden. Die Grundentscheidungen hat
der Maintainer getroffen (Abschnitt 25). Dieses Dokument legt fest, wie. Es ergänzt
docs/AGENT.md (Vertrag Agent/Server), docs/WINDOWS-AGENT.md (Snapshot-Begriffe, Abschnitt 17)
und agent/README.md; alle drei werden mit der Umsetzung angepasst (Abschnitt 17).

Stand der Code-Verweise: Zweig `wip/050-baremetal`, Commit `5f5d6d0` (auf `release/0.5.0`
nach dem Merge von 0.4.12). restic-Fakten sind gegen das gepinnte restic 0.19.1
(`agent/tools.env`) geprüft (`restic backup --help`, `restic restore --help`,
`restic ls --help`, globale Optionen). Was sich nur auf echter Hardware klären lässt, ist mit
**[Maschine]** markiert und steht im Testplan (Abschnitt 21.4) und gesammelt in Abschnitt 27.
Was nur in der CI mit KVM geklärt werden kann, trägt **[CI]**.

Der Maßstab des Maintainers ist: Es muss beim ersten Mal auf echten Maschinen funktionieren.
Daraus folgen drei Grundregeln, die sich durch das ganze Dokument ziehen:

1. **Identität bewahren statt umbauen.** Die Wiederherstellung baut denselben Speicherstapel
   wieder auf (Partitionstabelle, RAID, LUKS, LVM, Dateisysteme) mit denselben UUIDs,
   PARTUUIDs, Labels, Namen und Dateisystem-Funktionen. Dann stimmen `fstab`, `crypttab`,
   `mdadm.conf`, GRUB-Konfiguration und Kernel-Kommandozeile ohne Änderung. Nur Größen und
   die Zuordnung zu Platten dürfen sich ändern. Wer den Stapel ändern will (RAID weglassen,
   LVM entfernen, BIOS nach UEFI), installiert neu und holt Dateien zurück; das ist bewusst
   nicht Teil von 0.5.0 (Abschnitt 2.2).
2. **Erst prüfen, dann zerstören.** Vor dem ersten Schreibzugriff auf eine Zielplatte steht
   ein vollständiger Plan (jeder Befehl mit Argumenten), den der Bediener sieht und bestätigt.
   Derselbe Planer läuft auf dem Server gegen jedes erfasste Layout (Abschnitt 12.1). Ein
   Layout, das der Planer nicht umsetzen kann, wird nie grün.
3. **Grün ist Beweis.** "Bare Metal: grün" heißt, dass für genau dieses Layout und diese
   Startkette eine Wiederherstellung in einer virtuellen Maschine bis zum gestarteten System
   gelaufen ist (Abschnitt 12.3). Eine Prüfung, die nicht vollständig lief, bewertet nichts.

Harte Randbedingungen, die für alles Folgende gelten:

- Der Go-Agent nutzt kein Go-Modul außer seinem eigenen (`agent/go.mod` ohne `require`,
  CI `scripts/ci/check-go-deps.mjs`). Linux-Systemaufrufe nur über das Standardpaket
  `syscall` (Rohaufrufe mit Nummer, wo eine Konstante fehlt), Plattenwerkzeuge (`sfdisk`,
  `mdadm`, `cryptsetup`, `lvm`, `mkfs.*`, `btrfs`, `efibootmgr`) als eigener Prozess, immer
  mit Argumentliste, nie über eine Shell.
- Neuer Linux-only-Code trägt `//go:build linux`, macOS-only-Code `//go:build darwin`
  (Regel aus docs/WINDOWS-AGENT.md, Abschnitt 4); reine Logik (Manifest, Planer, Fixups)
  bleibt ohne Build-Tag und wird auf jedem System getestet.
- Das Recovery-ISO ist ein **eigenes GPL-Werk** unter `integrations/recovery`, getrennt vom
  Apache-2.0-Kern wie `integrations/pve/plugin` und geprüft von
  `scripts/ci/check-separate-works.mjs` (Abschnitt 8.1). Es enthält keinen Restow-Code im
  Quelltext; `restow-agent` und `restic` kommen als fertige Programme hinein.
- Nur ausgehende Verbindungen, Repository des Rechners append-only
  (`packages/core/src/endpoints/restic-authz.ts`, Prinzipal `agent`), signierte Releases
  (`scripts/release/sign-agent.sh`, `agent-SHA256SUMS.sig`). Die Wiederherstellung liest mit
  dem Prinzipal `reader` (nur lesen, nicht einmal Sperrdateien).
- Community-Edition, ohne Lizenzprüfung. Kein Code unter `ee/`, kein Import daraus.

## 0. Kurzfassung

- **Umfang 0.5.0:** Linux amd64 Bare Metal (Vorschau): UEFI und Legacy-BIOS, GPT und MBR,
  mdadm-RAID (0, 1, 4, 5, 6, 10), LVM (linear, striped, raid, thin), LUKS1/LUKS2, ext2/3/4,
  XFS, btrfs (Subvolumes, Mehrgeräte-Profile), vfat (ESP), Swap (Partition und Datei),
  getrenntes `/boot`, ESP, mehrere Platten, kleinere und größere Zielplatten, NVMe statt
  SATA und umgekehrt, Secure Boot über shim. macOS: neu installieren, dann Benutzerordner
  (und auf Wunsch Programme) aus einem APFS-Snapshot-Backup zurück. Windows: später.
- **Sicherung:** Ein Backup-Job bekommt den Schalter "Ganzer Rechner". Der Agent sichert dann
  alle lokalen Dateisysteme (je Einhängepunkt mit `--one-file-system`), mit `--group-by host`
  und dem zusätzlichen Tag `restow-baremetal`, aus LVM- oder btrfs-Snapshots in einem
  privaten Mount-Namensraum (Pfade im Snapshot bleiben `/`, `/home`, ...), und erfasst
  vorher das **Layout-Manifest** (`restow-layout-v1`): Platten, Partitionstabellen, RAID,
  LUKS (nur Metadaten, nie Header-Sicherungen), LVM, Dateisysteme mit ihren Funktionen,
  Einhängepunkte, Firmware, Bootloader, initramfs-Erzeuger. Das Manifest liegt **im
  Snapshot selbst** (`/var/lib/restow-agent/baremetal/layout.json`, mit den Rohausgaben der
  Werkzeuge daneben) und als Kopie in der Datenbank (`endpoint_layouts`).
  `state.json` und die Geheimnisse des Agenten werden nie mehr gesichert.
- **Recovery-ISO** `restow-recovery_<version>_amd64.iso`: Debian 13 (trixie) Live,
  reproduzierbar gebaut aus einem festen Stand von snapshot.debian.org, mit Debians
  signierter Startkette (shim, GRUB, Kernel) und damit unter Secure Boot startfähig, mit
  einer festen Liste nicht-freier Firmware (Abschnitt 8.4), `restow-agent` und `restic` aus
  demselben Release. Die SHA-256 des ISO steht in `agent-SHA256SUMS`, die der Maintainer mit
  dem Release-Schlüssel signiert; geprüft wird wie beim Agenten
  (`scripts/release/verify-agent-signature.sh`).
- **Wiederherstellungscode:** in der Oberfläche für einen Rechner ausgestellt, 4 Stunden
  gültig (wählbar 1 bis 48), einmal einlösbar, auditiert, nur Lesezugriff auf das Repository
  dieses Rechners. Form `RC-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX` (25 Zeichen aus einem
  tastaturfesten Alphabet, rund 122 Bit). Solange eine Recovery-Sitzung lebt, laufen für
  diesen Rechner weder Aufbewahrung (Prune) noch Entfernen.
- **`restow-agent recover`** im ISO: Netz (DHCP, statisch, Proxy; kein VLAN, kein WLAN),
  Uhrzeit, Code, Snapshot, Zielplatten-Zuordnung, Plan, Bestätigung, Partitionieren, RAID,
  LUKS (neue Schlüssel, gleiche Parameter, Passphrase des Bedieners), LVM, `mkfs` mit den
  erfassten Funktionen, `restic restore --sparse --verify`, Fixups, initramfs neu
  (dracut, initramfs-tools, mkinitcpio), Bootloader (NVRAM-Eintrag bzw. `grub-install` je
  BIOS-Platte), Prüfung, Bericht an den Server, Neustart. Fortschritt und Abbruch auf der
  Konsole und in der Oberfläche; Fortsetzen nach Abbruch oder Stromausfall.
- **Restore-Prüfung auf dem Server:** Stufe 1 "Layout und Startkette" nach jeder
  Ganz-Rechner-Sicherung (Schema, Planer, Manifest im Snapshot, Vollständigkeit, Startkette
  im Snapshot). Stufe 2 **Startprobe**: Wiederherstellung mit dem echten ISO in einer
  QEMU/KVM-Maschine auf dem Server bis zum gestarteten System, wöchentlich und bei jeder
  Änderung von Layout oder Startkette. Grün nur mit bestandener Startprobe für denselben
  Fingerabdruck.
- **Schema:** Migration **0074** (`0074_baremetal.sql`): Tabellen `endpoint_layouts` und
  `endpoint_recoveries`, Spalte `endpoint_runs.layout_id`, Spalte
  `endpoint_enrollment_tokens.endpoint_id` (Wiederanbindung), neue Werte für
  `endpoint_report_kind`.
- **Reihenfolge:** sechs Meilensteine, jeder mit eigenen Tests auslieferbar (Abschnitt 22):
  M1 Sicherung des ganzen Rechners mit Snapshots und Manifest, M2 Planer und Stufe 1,
  M3 Code, Sitzung, Wiederanbindung, M4 ISO und `recover` mit QEMU-Ende-zu-Ende-Tests in der
  CI, M5 Startprobe und Bewertung, M6 macOS.

## 1. Ausgangslage

### 1.1 Was es heute gibt

- Dateibasierte Sicherung mit restic, "keine Images, kein Bare-Metal-Restore"
  (docs/AGENT.md, Grundsätze; `agent/README.md` "Known limits";
  `apps/web/src/features/endpoints/endpoints-page.test.tsx` prüft den Satz).
- Ein Backup nimmt die `paths` der Konfiguration (Linux-Standard `/etc /home /root /srv
  /var/www`, Server zusätzlich `/opt /usr/local /var/lib /var/backups`,
  `packages/core/src/endpoints/config.ts`), filtert sie (`ownFormSources`, `splitSources`
  in `agent/internal/core/util.go`) und ruft `restic backup --files-from-raw ...
  --exclude-caches --retry-lock 15m --host <Hostname beim Enrollment> --tag restow-agent`
  (`backupArgs` in `agent/internal/restic/backup.go`). Kein `--one-file-system`, kein
  `--group-by`. Damit wählt restic den Elternsnapshot nach Host **und Pfaden**.
- `/etc/restow-agent/state.json` (Agent-Secret, Repository-Passwort) liegt unter `/etc` und
  wird heute mitgesichert, verschlüsselt im Repository des Rechners. Das hört mit 0.5.0
  auf (Abschnitt 5.4).
- Snapshot-Politik und Berichtsfeld sind betriebssystemneutral gebaut
  (`agent/internal/core/snapshot.go`: `snapshotPlan`, `consistencyOf`,
  `snapshotFailedErrors`, `snapshotUnavailableError`; `api.Consistency` mit
  `Method`/`State`/`LiveFilesystems`; Methoden `vss`, `lvm`, `btrfs`, `apfs`, `mixed`).
  Unter Linux und macOS plant `planSnapshot` in `snapshot_other.go` heute nichts.
  `backupStep` in `core/backup.go` trägt die Windows-Anbindung (`UseFSSnapshot`,
  `OnSnapshotFailed`, Rückfall ohne Snapshot); die Linux- und macOS-Snapshots hängen sich
  an dieselbe Stelle, aber anders: Der Snapshot entsteht beim Agenten, nicht in restic
  (Abschnitt 6).
- Restore auf den Rechner: `restic restore --json --target <neu> --overwrite never --verify
  --retry-lock 15m` (`agent/internal/restic/restore.go`), nie über vorhandene Dateien
  (docs/AGENT.md, "Restore").
- restic-REST-Zugang: `/agent/restic/:endpointId/*` mit dem Prinzipal `agent`
  (`apps/api/src/features/endpoints/restic-route.ts`). Für Läufe mit eigenem Zugang gibt es
  den Baustein `buildRunResticRoute` (`apps/api/src/lib/restic-run-route.ts`), heute für
  Proxmox-VE-Container und Dateifreigaben, mit den Prinzipalen `agent`, `reader` und
  `closing`. `reader` ist genau, was eine Wiederherstellung braucht (docs/FILESHARES.md
  5.3: nur `HEAD`/`GET`, keine Sperrdatei, restic mit `--no-lock`).
- Wartung: Jede Arbeit des Servers an einem Endpunkt-Repository hält eine Postgres-Sperre
  (`packages/db/src/repository-lock.ts`), Aufbewahrung und Prüfung exklusiv
  (docs/AGENT.md, "Aufbewahrung, Prüfung, Restore-Test").
- Bewertung: `packages/core/src/endpoints/readiness.ts` (`no_backup`, `unverified`, `green`,
  `yellow`, `red`), Restore-Test nach dem Grundsatz "Rot nur mit Beleg"
  (`restore-test.ts`, `isBackupFinding`).
- Getrennte Werke: `scripts/ci/license-policy.json` (`separateWorks`), heute nur
  `integrations/pve/plugin` (AGPL-3.0-or-later); `check-separate-works.mjs` verlangt
  LICENSE, SPDX-Kopf je Datei, keinen TypeScript-, JavaScript- oder Go-Code im Werk,
  Verweise nur aus `allowedReferences`, keine Kopie außerhalb. Lizenz-Marker kennt der
  Check nur für AGPL (`LICENSE_MARKERS`).
- Release: `release.yml` baut den Agenten (`agent`), prüft Windows (`agent-windows-check`),
  legt `agent-SHA256SUMS` auf den Entwurf (`agent-sums`), wartet auf die Signatur des
  Maintainers (`agent-signature`, `sign-agent.sh`), baut dann die Images.
- Migrationen bis `0073_storage_samples.sql`; die nächste freie Nummer ist **0074**.

### 1.2 Geprüfte restic-Fakten (0.19.1)

| Fakt | Beleg |
| --- | --- |
| `backup -g, --group-by` (Standard `host,paths`) bestimmt den Elternsnapshot: "the latest snapshot in the group determined by --group-by". Mit `--group-by host` ist der Elternsnapshot der neueste des Hosts, gleich welche Pfade. | `restic backup --help` |
| `backup -x, --one-file-system`: "exclude other file systems, don't cross filesystem boundaries and subvolumes". Ausdrücklich genannte Quellen werden trotzdem gesichert; btrfs-Subvolumes sind Grenzen. | `restic backup --help` |
| restic hat **keine** Option, Pfade beim Sichern umzuschreiben (kein Präfix-Abschneiden). Ein Snapshot unter `/mnt/x` erscheint im Repository als `/mnt/x/...`. | `restic backup --help` (keine solche Option) |
| `restore <snapshotID>:<subfolder>` stellt nur einen Unterordner her, als wäre er die Wurzel. | `restic restore --help` |
| `restore --sparse` (dünn besetzte Dateien), `--verify` (Inhalt nach dem Schreiben prüfen), `--overwrite always|if-changed|if-newer|never`, `--ownership-by-name` (Besitzer nach Name statt Nummer, außer POSIX-ACLs), `--host`, `--tag`, `--path` für `latest`. | `restic restore --help` |
| Globale Optionen `--no-lock` ("allows some operations on read-only repositories"), `--no-cache`, `--cacert`, `--limit-download`. | `restic --help` |
| Exit-Codes `backup`: 0, 1 (kein Snapshot), 3 (unvollständig), 10, 11, 12; `restore`: 0, 1, 10, 11, 12. | `--help` beider Befehle |
| `ls <snapshot> <ordner>` listet nur unterhalb absoluter Ordner; `--recursive` steigt ab. | `restic ls --help` |

Was zusätzlich bei der Umsetzung gegen die Quellen von `v0.19.1` zu belegen ist (und in den
Unit-Tests als Testdaten festgehalten wird): dass `restore` Gerätedateien, FIFOs, Hardlinks
innerhalb des wiederhergestellten Satzes, POSIX-ACLs und erweiterte Attribute einschließlich
`security.capability` und `security.selinux` als root wiederherstellt; dass `restore` die
Linux-Dateiattribute (`chattr`: `+C`, `+i`) nicht kennt; dass `--overwrite if-changed` den
Inhalt vorhandener Dateien vergleicht und nur Abweichendes lädt (Grundlage für "Fortsetzen",
Abschnitt 10.15).

### 1.3 Was Go und das Standardpaket `syscall` unter Linux bieten

Vorhanden: `syscall.Mount`, `syscall.Unmount`, `syscall.Unshare`, `syscall.Chroot`,
`syscall.Exec`, `SysProcAttr.Unshareflags` (mit `CLONE_NEWNS` macht die Go-Laufzeit im Kind
die Wurzel rekursiv privat, bevor das Programm startet), `SysProcAttr.Chroot`,
`syscall.Syscall` für Rohaufrufe. Nicht als Konstante vorhanden und als Rohaufruf zu bauen:
`openat2` mit `RESOLVE_IN_ROOT` (Nummer 437 auf allen Linux-Architekturen, Kernel ab 5.6;
das ISO hat 6.12), `ioctl(BLKGETSIZE64)`, `ioctl(BLKSSZGET)`, `ioctl(BLKPBSZGET)`. Die
UEFI-Variablen liest der Agent als Dateien aus `/sys/firmware/efi/efivars` (4 Byte Attribute,
dann der Wert) und zerlegt `Boot####` (`EFI_LOAD_OPTION`) selbst; `efibootmgr` braucht er
dafür nicht.

## 2. Zielplattformen und Umfang

### 2.1 Was 0.5.0 kann

| Bereich | 0.5.0 | Anmerkung |
| --- | --- | --- |
| Quellsystem Linux amd64 | ja (Vorschau) | systemd als Init; Distributionen siehe unten |
| Quellsystem Linux arm64 | Sicherung und Manifest ja, Wiederherstellung nein | kein arm64-ISO in 0.5.0 (Offene Frage 6) |
| Rechner im Container (LXC, Docker) | nein | kein Speicherstapel; die Oberfläche sagt es (`machine.virtualization = container`) |
| Rechner als VM (KVM, VMware, Hyper-V, PVE-Gast mit Agent) | ja | Wiederherstellung in eine neue VM wie auf Hardware |
| Firmware | UEFI (mit und ohne Secure Boot), Legacy-BIOS (auch CSM) | Modus wie gesichert; GPT mit ESP **und** BIOS-Boot-Partition geht in beiden |
| Partitionstabellen | GPT, MBR (primär, erweitert, logisch), ganze Platte ohne Tabelle (PV, md-Mitglied, Dateisystem) | keine Umwandlung MBR/GPT |
| Software-RAID | mdadm, Metadaten 0.90, 1.0, 1.1, 1.2; RAID 0, 1, 4, 5, 6, 10; interne Bitmap | IMSM/DDF (Intel RST) nein |
| Verschlüsselung | LUKS1, LUKS2 (Passphrase, Schlüsseldatei aus der Sicherung) | TPM2-, FIDO2-, Clevis-Bindungen werden nicht übernommen (Abschnitt 10.8) |
| LVM | linear, striped, `raid1`/`raid5`/`raid6`/`raid10`, Thin-Pools und Thin-LVs | Cache, Writecache, VDO nein |
| Dateisysteme | ext2, ext3, ext4, XFS, btrfs (Subvolumes, Standard-Subvolume, `raid0/1/10/1c3/1c4`, `single`, `dup`), vfat (ESP, `/boot`), Swap-Partition, Swap-Datei | ZFS, bcachefs, F2FS, NTFS nein |
| Bootloader | GRUB 2 (BIOS und UEFI, auch BLS wie Fedora/RHEL), systemd-boot, shim | LILO, syslinux, rEFInd, EFI-Stub ohne Bootloader nein |
| initramfs | initramfs-tools, dracut, mkinitcpio | mkinitfs (Alpine), booster nein |
| Zielplatten | gleich groß, größer, kleiner (solange die Daten passen), andere Anzahl bei RAID (degradiert), NVMe/SATA/SAS/virtio gemischt, 512e und 4Kn | |
| Netz im ISO | DHCP (IPv4, IPv6/SLAAC), statisch, HTTP(S)-Proxy ohne Zugangsdaten | kein VLAN, kein WLAN, kein 802.1X, kein Bonding |

Distributionen (Quellsystem): **geprüft in der CI** (Abschnitt 21.2) Debian 12 und 13,
Ubuntu 24.04 LTS, AlmaLinux 9 (stellvertretend für RHEL, Rocky, Oracle Linux 9),
Fedora (aktuelle Version), openSUSE Leap 15.6; **auf echter Hardware im Freigabetest**
(Abschnitt 21.4) zusätzlich Ubuntu 22.04 und 26.04, RHEL 8/10-Familie, Arch Linux. Andere
systemd-Distributionen mit einem der drei initramfs-Erzeuger und GRUB oder systemd-boot
gelten als "sollte gehen" und zeigen das im Assistenten an ("nicht geprüfte Distribution").

### 2.2 Nicht Teil von 0.5.0

- **Windows Bare Metal** (WinPE/WinRE-Medium, BCD, WIM/VHDX, Systemzustand). Wiederherstellung
  eines Windows-Rechners heißt in 0.5.0 weiter: Windows neu installieren, dann Dateien
  zurückholen (docs/WINDOWS-AGENT.md 2.2). Der Job-Schalter "Ganzer Rechner" lässt
  Windows-Mitglieder unverändert ihre Ordner sichern und sagt das.
- **Umbau des Speicherstapels** bei der Wiederherstellung: RAID-Ebene ändern, RAID oder LVM
  oder LUKS weglassen oder hinzufügen, MBR nach GPT, BIOS nach UEFI, Dateisystem wechseln.
- **Wiederherstellung ohne Restow-Server**: nur vom Server (Entscheidung), keine lokalen
  Plattenabbilder, kein Lesen eines Repositorys von USB-Platte, NFS oder S3 im ISO.
  (`restow-restore` und `restic` bleiben für Dateien der Weg ohne Server, docs/AGENT.md
  "Restore ohne Restow".)
- ZFS (Kernelmodul nicht signiert, Lizenz), bcachefs, Stratis, VDO, LVM-Cache, dm-integrity
  und LUKS2 mit Authentifizierung (`--integrity`), losgelöste LUKS-Header, dm-verity,
  Multipath, iSCSI- und NFS-Root, FCoE, Intel RST/IMSM, Hybrid-MBR (alte Macs), bcache.
- Snapper-, Timeshift- und LVM-Snapshots als Teil der Sicherung (sie werden leer bzw. gar
  nicht neu angelegt, Abschnitt 5.3).
- arm64-ISO, Raspberry Pi, Netzboot (PXE) des ISO, WLAN, VLAN, Bonding im ISO.
- Nicht-systemd-Init (OpenRC, runit, SysV) als Quellsystem: Sicherung und Manifest ja,
  Startprobe nein, Wiederherstellung "nicht geprüft".
- macOS: Wiederherstellung des Systems, systemweiter Einstellungen (`/Library/Preferences`,
  Netzwerk, Drucker), der Data-Protection-Schlüsselbund, FileVault-Zustand, Benutzerkonten
  mit ihren Passwörtern (Abschnitt 13).

## 3. Begriffe und Gesamtablauf

- **Ganz-Rechner-Sicherung**: ein Backup eines Rechners in einem Job mit `wholeMachine`. Ihr
  Snapshot trägt die Tags `restow-agent` und `restow-baremetal`.
- **Layout-Manifest**: die JSON-Beschreibung des Speicherstapels und der Startkette zum
  Zeitpunkt der Sicherung (`restow-layout-v1`, Abschnitt 4).
- **Plan**: die Liste der Schritte, mit denen `recover` aus einem Manifest und einer
  Zielhardware den Rechner baut (Abschnitt 10.4). Rein berechnet, ohne Werkzeugaufruf.
- **Recovery-Sitzung**: eingelöster Wiederherstellungscode; trägt den Lesezugang zum
  Repository und den Fortschritt (Abschnitt 9).
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
  5 Code eintauschen --------------------------> POST /agent/v1/recovery/sessions
  6 Manifest lesen, Plan, Bestätigung
  7 restic restore --no-lock ------------------> /agent/recovery/restic/<sitzung> (reader)
  8 Ende des Repository-Zugangs, Fixups, initramfs, Bootloader, Prüfung
  9 POST .../finish, Neustart
```

## 4. Layout-Manifest

### 4.1 Erfassung (`agent/internal/baremetal`)

Neues Paket. Aufteilung:

| Datei | Build-Tag | Inhalt |
| --- | --- | --- |
| `manifest.go` | keins | Typen (`Manifest`, `Disk`, `PartitionTable`, `Partition`, `MDArray`, `LUKSVolume`, `LVM`, `VolumeGroup`, `LogicalVolume`, `Filesystem`, `Subvolume`, `Swap`, `Mount`, `Firmware`, `EFIEntry`, `Bootloader`, `Initramfs`, `Kernel`, `NetInterface`, `BlockRef`, `Unsupported`), `Format = "restow-layout-v1"`, `SchemaVersion = 1`, `(*Manifest).Validate()`, Kodierung mit sortierten Schlüsseln |
| `assess.go` | keins | `Assess(*Manifest) (Verdict, []Unsupported)`: unterstützt, mit Hinweisen, nicht unterstützt (Abschnitt 4.4) |
| `fingerprint.go` | keins | `LayoutFingerprint(*Manifest) string` (Abschnitt 12.4) |
| `efi.go` | keins | `ParseLoadOption([]byte)`, `BuildLoadOption(...)` (`EFI_LOAD_OPTION`, Gerätepfad-Knoten HD und File) |
| `capture.go` | keins | Ablauf, Zusammenführen, Grenzen (Zeit, Größe), Fehler je Teil |
| `capture_linux.go` | linux | die Sammler je Schicht, siehe unten |
| `capture_darwin.go` | darwin | macOS-Variante (Abschnitt 13.2) |
| `tools.go` | keins | `Runner`-Schnittstelle für Werkzeugaufrufe (Zeitlimit je Aufruf 30 s, Ausgabe höchstens 4 MiB, Umgebung `procenv.Base()` mit `LC_ALL=C`), Attrappe für Tests |
| `testdata/capture/<system>/` | | aufgezeichnete Ausgaben echter Systeme (Abschnitt 21.1) |

Sammler unter Linux (`capture_linux.go`), jeder mit eigener Funktion und eigenem Test gegen
aufgezeichnete Ausgaben:

| Funktion | Quelle | Was |
| --- | --- | --- |
| `captureBlockDevices` | `lsblk -J -b -O` | Baum aller Blockgeräte: Name, `KNAME`, Typ, Größe, `LOG-SEC`, `PHY-SEC`, Modell, Seriennummer, WWN, Transport (`nvme`, `sata`, `sas`, `virtio`, `usb`), `ROTA`, `PKNAME`, `MAJ:MIN` |
| `capturePartitionTables` | `sfdisk --json <disk>` und `sfdisk --dump <disk>` | Typ (`gpt`/`dos`), `label-id` (Disk-GUID bzw. MBR-Kennung), `first-lba`, `last-lba`, `sector-size`; je Partition Nummer, Start, Größe, Typ, PARTUUID, Name, Attribute, Boot-Flag |
| `captureBootCode` | erste 512 Byte jeder Platte, BIOS-Boot-Partition | `grub` (GRUB-Kennung im MBR-Code), `none`, `other` |
| `captureMD` | `/proc/mdstat`, `mdadm --detail --export /dev/mdX`, `mdadm --examine --export <mitglied>` | Name, UUID, Ebene, Metadatenversion, Chunk, Layout, Mitglieder (als `BlockRef`), Ersatzplatten, Bitmap, `homehost` |
| `captureLUKS` | `cryptsetup luksDump --dump-json-metadata <dev>` (LUKS2), sonst `cryptsetup luksDump <dev>` (Text, LUKS1) | Version, UUID, Label, Subsystem, Cipher, Schlüssellänge, Sektorgröße, PBKDF (Art, Iterationen bzw. Speicher), Anzahl belegter Keyslots, Tokens (Arten: `systemd-tpm2`, `systemd-fido2`, `clevis`), Integrity; **keine Header-Sicherung** (Entscheidung, Abschnitt 25) |
| `captureLVM` | `lvm fullreport --reportformat json --units b --nosuffix`, `vgcfgbackup -f <raw>/%s.vg` | PVs (Gerät, UUID), VGs (Name, Extentgröße), LVs (Name, Typ, Größe, Stripes, Stripe-Größe, Raid-Typ, Pool, virtuelle Größe, Chunk-Größe, Metadatengröße, Tags, aktiv) |
| `captureFilesystems` | `blkid -p -o export <dev>`, `dumpe2fs -h`, `xfs_info <mnt>`, `btrfs inspect-internal dump-super`, `btrfs filesystem show --raw`, `btrfs filesystem df --raw`, `btrfs subvolume list -a -p -u -q <mnt>`, `btrfs subvolume get-default`, `statfs`, `lsattr -d` (Ordner bis vier Ebenen unter jedem btrfs-Einhängepunkt) | Typ, UUID, `UUID_SUB`, Label, Größe, belegte Bytes und Inodes, `mkfs`-Parameter je Typ (Abschnitt 10.9), `noCowDirs` (Ordner mit `+C`) |
| `captureMounts` | `/proc/self/mountinfo` (eigener Parser) | Ziel, Quelle, Typ, Optionen, `subvol=`/`subvolid=`, Zuordnung zum Dateisystem |
| `captureSwap` | `/proc/swaps`, `blkid` | Partition oder Datei, UUID, Label, Größe, Priorität |
| `captureFirmware` | `/sys/firmware/efi`, efivars `Boot####`, `BootOrder`, `BootCurrent`, `SecureBoot`, `SetupMode` | Modus, Secure Boot an/aus, Einträge mit Beschreibung, PARTUUID, Partitionsnummer und Loader-Pfad |
| `captureBootloader` | Dateien: `/etc/default/grub`, `/boot/grub/grub.cfg`, `/boot/grub2/grub.cfg`, `/boot/loader/entries/*.conf`, `/boot/efi/loader/loader.conf`, `/efi`, `<esp>/EFI/*/shimx64.efi`, `grubenv`; Debconf `grub-pc/install_devices` | Art (`grub`, `systemd-boot`), Plattform (`i386-pc`, `x86_64-efi`), BLS ja/nein, shim ja/nein, ESP und XBOOTLDR, EFI-Verzeichnis und Bootloader-ID, BIOS-Zielplatten |
| `captureInitramfs` | vorhandene Programme und Konfigurationen (`/etc/initramfs-tools`, `/etc/dracut.conf{,.d}`, `/etc/mkinitcpio.conf`) | Erzeuger, `hostonly` (dracut), `MODULES=` (initramfs-tools) |
| `captureKernels` | `/lib/modules/*`, `/boot/vmlinuz-*`, `/boot/initrd*`, `/boot/initramfs-*`, ESP-Einträge von systemd-boot | Version, Pfad von Kernel und initramfs, Größe |
| `captureOS` | `/etc/os-release`, `/proc/cmdline`, `uname -r`, `/etc/selinux/config`, `/etc/machine-id` (nur ob vorhanden) | `ID`, `ID_LIKE`, `VERSION_ID`, Kernel, Kommandozeile, SELinux-Modus |
| `captureNetwork` | `/sys/class/net/*` | Name, MAC, Treiber, PCI-Pfad, ob physisch (für die Umbenennung, Abschnitt 10.13) |
| `captureConfigFiles` | Dateien | Pfad und SHA-256 von `fstab`, `crypttab`, `mdadm.conf` (`/etc/mdadm/mdadm.conf`, `/etc/mdadm.conf`), `/etc/default/grub`, `/etc/kernel/cmdline`; der Inhalt steht im Snapshot, nicht im Manifest |

Was ein Sammler nicht lesen kann (Werkzeug fehlt, Zeitlimit, Fehler), kommt als
`Unsupported{Code: "capture_failed", Ref, Message}` ins Manifest; Werkzeuge einer Schicht,
die es auf dem Rechner gibt, sind fast immer installiert (wer LVM nutzt, hat `lvm`). Ein
Werkzeug fehlt nur bei Schichten, die das System nicht benutzt, und dann wird es nicht
aufgerufen. `lsblk`, `blkid`, `sfdisk` (util-linux) sind Voraussetzung; fehlen sie, ist der
Rechner nicht Bare-Metal-fähig (Hinweis in der Oberfläche).

### 4.2 Schema (Auszug)

```jsonc
{
  "format": "restow-layout-v1",
  "schemaVersion": 1,
  "capturedAt": "2026-11-04T21:00:03Z",
  "agentVersion": "0.5.0",
  "hostname": "srv01",                 // Hostname beim Enrollment, wie --host
  "os": { "kind": "linux", "id": "debian", "idLike": [], "versionId": "12",
          "prettyName": "Debian GNU/Linux 12 (bookworm)", "arch": "amd64",
          "kernel": "6.1.0-27-amd64", "cmdline": "BOOT_IMAGE=/vmlinuz-... root=/dev/mapper/vg0-root ro quiet",
          "selinux": null, "init": "systemd" },
  "firmware": { "mode": "uefi", "secureBoot": true,
                "entries": [{ "num": 1, "label": "debian", "partuuid": "…", "partNumber": 1,
                              "loader": "\\EFI\\debian\\shimx64.efi", "active": true }],
                "bootOrder": [1, 0], "bootCurrent": 1 },
  "disks": [{ "id": "d0", "kname": "nvme0n1", "sizeBytes": 512110190592,
              "logicalSectorSize": 512, "physicalSectorSize": 512,
              "model": "…", "serial": "…", "wwn": null, "transport": "nvme", "rotational": false,
              "bootCode": "none",
              "table": { "type": "gpt", "id": "…", "firstLba": 2048, "lastLba": 1000215182,
                         "partitions": [
                           { "number": 1, "start": 2048, "size": 1048576, "type": "C12A7328-F81F-11D2-BA4B-00A0C93EC93B",
                             "uuid": "…", "name": "EFI System Partition", "attrs": "", "bootable": false },
                           { "number": 2, "start": 1050624, "size": 1998848, "type": "0FC63DAF-…", "uuid": "…" },
                           { "number": 3, "start": 3049472, "size": 997165056, "type": "0FC63DAF-…", "uuid": "…",
                             "grow": true } ] } }],
  "md": [],
  "luks": [{ "id": "c0", "device": { "kind": "partition", "disk": "d0", "number": 3 },
             "version": 2, "uuid": "…", "label": null, "cipher": "aes-xts-plain64", "keyBits": 512,
             "sectorSize": 512, "pbkdf": { "type": "argon2id", "memoryKiB": 1048576, "time": 4, "parallel": 4 },
             "keyslots": 1, "tokens": [], "integrity": null,
             "mappedName": "nvme0n1p3_crypt", "crypttabName": "nvme0n1p3_crypt" }],
  "lvm": { "pvs": [{ "device": { "kind": "luks", "id": "c0" }, "uuid": "…" }],
           "vgs": [{ "name": "vg0", "extentBytes": 4194304,
                     "lvs": [{ "name": "root", "type": "linear", "sizeBytes": 53687091200 },
                             { "name": "swap", "type": "linear", "sizeBytes": 8589934592 },
                             { "name": "home", "type": "linear", "sizeBytes": 400000000000, "grow": true }] }] },
  "filesystems": [{ "id": "f0", "device": { "kind": "partition", "disk": "d0", "number": 1 },
                    "type": "vfat", "uuid": "1A2B-3C4D", "label": null, "sizeBytes": 536870912,
                    "usedBytes": 6291456, "vfat": { "fatBits": 32, "volumeId": "1A2B3C4D",
                    "sectorsPerCluster": 8 } },
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
  "bootloader": { "kind": "grub", "platform": "x86_64-efi", "bls": false, "shim": true,
                  "efiDirectory": "/boot/efi", "bootloaderId": "debian", "biosDisks": [] },
  "initramfs": { "generator": "initramfs-tools", "modules": "most" },
  "kernels": [{ "version": "6.1.0-27-amd64", "image": "/boot/vmlinuz-6.1.0-27-amd64",
                "initramfs": "/boot/initrd.img-6.1.0-27-amd64", "imageBytes": 8224448 }],
  "configs": [{ "path": "/etc/fstab", "sha256": "…" }, { "path": "/etc/crypttab", "sha256": "…" }],
  "network": [{ "name": "enp3s0", "mac": "…", "driver": "igb", "physical": true }],
  "backup": { "sources": ["/", "/boot", "/boot/efi", "/home"],
              "excludes": ["…"], "fsSnapshots": { "f1": "lvm", "f2": "live", "f0": "live" } },
  "agent": { "hooks": "off" },
  "unsupported": [],
  "verdict": "supported",
  "raw": [{ "name": "sfdisk-d0.dump", "sha256": "…" }, { "name": "vg0.vg", "sha256": "…" }]
}
```

Regeln:

- Platten, Arrays, LUKS-Volumes, Dateisysteme haben eine im Manifest eindeutige, kurze `id`;
  Verweise laufen nur über `BlockRef` (`disk`, `partition`, `md`, `luks`, `lv`), nie über
  Gerätenamen. Der Gerätename zur Erfassungszeit (`kname`) ist nur Anzeige und Grundlage der
  Fixups (Abschnitt 10.11).
- `grow` markiert je Platte höchstens eine Partition und je VG höchstens ein LV, das auf einer
  größeren Zielplatte wächst. Vorgabe beim Erfassen: die letzte Partition einer Platte, wenn
  sie ein PV, ein md-Mitglied, ein LUKS-Container oder ein Dateisystem trägt, das wachsen
  kann; im VG das größte LV, das nicht `root` heißt und nicht Swap ist, sonst `root`. Der
  Bediener kann es im Plan ändern.
- Geheimnisse stehen nie im Manifest: keine Schlüssel, keine Keyslot-Daten, kein
  Tokeninhalt. Seriennummern und MAC-Adressen stehen darin (für die Zuordnung); das Manifest
  liegt verschlüsselt im Repository und in der Datenbank des Mandanten.
- Schema-Entwicklung: neue Felder nur hinzufügen (`schemaVersion` 2, 3 ...), alte Leser
  übergehen sie. Ein Bruch erhöht `format` (`restow-layout-v2`); ein ISO, das das Format
  nicht kennt, lehnt mit "Dieses Recovery-ISO ist zu alt für diese Sicherung, bitte das
  aktuelle laden" ab.
- Größe: höchstens 512 KiB kodiert (der Server lehnt größere ab, der Agent kürzt vorher die
  Liste `network` und die Rohdateien nicht, sondern meldet `layout_too_large`).

Das Schema gibt es zweimal und beide werden gegen dieselben Testdaten geprüft: Go-Typen in
`agent/internal/baremetal/manifest.go` und ein Zod-Schema in
`packages/core/src/endpoints/baremetal/manifest.ts` (`layoutManifestSchema`,
`parseLayoutManifest`). Testdaten: `agent/internal/baremetal/testdata/manifests/*.json` (aus
den Erfassungstests erzeugt, eingecheckt); ein Vitest in `packages/core` liest dieselben
Dateien und verlangt, dass jede gültig ist und dass `layoutFingerprint` (TS) denselben Wert
ergibt wie `LayoutFingerprint` (Go, als `<name>.fingerprint` daneben gespeichert).

### 4.3 Ablage: im Snapshot und in der Datenbank

1. **Im Snapshot** (maßgeblich): Vor dem Anlegen der Dateisystem-Snapshots schreibt der Agent
   `Layout.BaremetalDir()` = `/var/lib/restow-agent/baremetal/` neu (`paths.Layout`, neue
   Methode): `layout.json` und `raw/` mit den Rohausgaben (`sfdisk-<disk>.dump`,
   `sgdisk-<disk>.backup` bei GPT, `lsblk.json`, `blkid.txt`, `mountinfo.txt`, `<vg>.vg` aus
   `vgcfgbackup`, `mdadm-detail-<md>.txt`, `luksdump-<id>.json`, `btrfs-subvolumes-<uuid>.txt`,
   `efivars.txt`, `os-release`). Der Ordner gehört root, Modus 0700, und liegt im
   Wurzel-Dateisystem (bzw. in dem von `/var`), also im selben Snapshot wie das System, das er
   beschreibt. `raw/` dient der Fehlersuche und einer späteren Wiederherstellung von Hand; das
   ISO liest nur `layout.json`.
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
`unsupported[]` (Code, Verweis, Text). `unsupported` setzen: ZFS, bcachefs, F2FS, NTFS
(als einzuhängendes Dateisystem eines Systempfads), LVM-Cache/-Writecache/VDO, IMSM/DDF,
Multipath, dm-integrity, losgelöster LUKS-Header, iSCSI-/NFS-Root, ein Bootloader oder
initramfs-Erzeuger außerhalb von 2.1, ein unbekanntes Gerät im Weg zu `/`, `/boot` oder der ESP,
ein Container. `supported_with_warnings`: TPM2/FIDO2/Clevis-Token an einem LUKS-Volume
(Abschnitt 10.8), Snapper-/Timeshift-Subvolumes, LVM-Snapshot-LVs, ein Datendateisystem
eines nicht unterstützten Typs abseits der Systempfade (es wird gesichert, aber nicht neu
angelegt; der Plan zeigt es als "nicht wiederhergestellt"), nicht geprüfte Distribution,
Nicht-systemd-Init, Secure Boot an mit einem nicht von Microsoft signierten Bootloader
(eigene MOK-Schlüssel, Abschnitt 10.12).

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
  `fsSnapshot: "auto" | "off"` (Abschnitt 6.1). Ein älterer Agent kennt die Felder nicht und
  sichert weiter seine `paths`; die Oberfläche zeigt für Rechner mit Agent < 0.5.0 "Agent zu
  alt für Ganzer Rechner".
- Ein Container-Rechner (`settings.agent.machine.virtualization = container`) im Job bekommt
  das Feld nicht; die Job-Seite nennt ihn ("sichert seine Ordner, Bare Metal geht in einem
  Container nicht").

### 5.2 Quellen

Mit `wholeMachine` ersetzt der Agent die `paths` des Jobs durch die Einhängepunkte aus dem
eben erfassten Manifest (`wholeMachineSources(m *baremetal.Manifest)` in neuem
`agent/internal/core/wholemachine.go`):

- jedes eingehängte Dateisystem der Typen aus 2.1, das auf einem lokalen Blockgerät des
  Manifests liegt (Platte, Partition, md, LUKS, LV), mit jedem Einhängepunkt einmal (bei
  btrfs jedes eingehängte Subvolume);
- nicht: Pseudo- und Netzdateisysteme (`proc`, `sysfs`, `tmpfs`, `devtmpfs`, `overlay`,
  `squashfs` (Snap-Pakete, kommen mit dem Paket wieder), `nfs`, `cifs`, `fuse.*`),
  Wechseldatenträger (`RM=1` oder Transport `usb`), Bind-Mounts (gleiche Quelle, anderes
  Ziel: nur der erste Einhängepunkt);
- `restic backup -x` mit dieser Liste: Grenzen zu nicht genannten Dateisystemen werden nicht
  überschritten, eine vergessene Grenze kann also nichts doppelt sichern.

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
- Immer, für **jede** Sicherung (auch ohne `wholeMachine`): `Layout.StateFile()` und die
  Zwischendateien von `state.Save` (`/etc/restow-agent/state.json`, `.state.json.*`),
  `Layout.CacheDir()`, `Layout.TmpDir()`, `Restow-Restore-*` (heute schon). Unter macOS
  dieselben Pfade.
- Swap-Dateien aus `/proc/swaps` (sie werden neu angelegt, Abschnitt 10.9).
- btrfs-Subvolumes von Snapper (`.snapshots`, `@snapshots`, `@/.snapshots`) und Timeshift
  (`timeshift-btrfs`) sind keine Quellen (ihr Inhalt würde vervielfacht); `recover` legt sie
  leer an, damit `fstab` und Snapper stimmen.
- Das Manifest hält die geltenden Ausschlüsse fest (`backup.excludes`); der Plan zeigt sie
  ("nicht gesichert und darum leer: ...").

### 5.4 `state.json` und Geheimnisse

Ab 0.5.0 sichert kein Agent mehr seinen Zustand. Grund: Das Agent-Secret im Repository nützt
nach einer Wiederherstellung nichts (der Server soll ein neues ausstellen, Abschnitt 11),
schadet aber bei einer Kopie des Rechners (zwei Rechner mit demselben Secret). Umsetzung in
`backupStep`: die Ausschlussliste wie heute (`a.d.Layout.CacheDir()`, `TmpDir()`) um
`a.d.Layout.StateFile()` und das Muster der Zwischendateien erweitert. Ältere Snapshots
enthalten die Datei weiter; der Restore-Dialog blendet `/etc/restow-agent/state.json` aus und
lehnt den Pfad als Einzelauswahl ab (`@restow/core` `restoreSelectionIssue`, neu), damit
niemand einen Rechner versehentlich mit einem alten Secret zurücksetzt.

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
`--files-from-raw` mit den Einhängepunkten. Warum `--group-by host`: Die Liste der
Einhängepunkte ändert sich (eine neue Platte, ein Wechsel aus einem Job ohne
`wholeMachine`), und mit dem Standard `host,paths` würde restic dann ohne Elternsnapshot
jede Datei neu lesen. Die Aufbewahrung des Servers gruppiert ohnehin nicht (docs/AGENT.md).
`--exclude-caches` bleibt (Ordner mit `CACHEDIR.TAG` sind per Definition entbehrlich).

### 5.6 Ablauf eines Ganz-Rechner-Backups

In `doBackup`/`backupStep` (`agent/internal/core/backup.go`), nach dem Pre-Hook:

1. `baremetal.Capture` (Zeitlimit 2 Minuten insgesamt). Scheitert die Erfassung ganz, läuft
   die Sicherung als gewöhnliche Sicherung der Einhängepunkte aus `/proc/self/mountinfo`
   weiter; Lauf `partial` mit `layout_capture_failed`.
2. Manifest und `raw/` nach `Layout.BaremetalDir()` schreiben (atomar über
   `internal/atomicfile`, alte Rohdateien vorher löschen).
3. Snapshot-Plan (Abschnitt 6), Snapshots anlegen.
4. restic über den Snapshot-Helfer (Abschnitt 6.3).
5. Stichprobe (`collectSample`) **aus dem Snapshot-Baum**, solange er besteht: Der Helfer
   bekommt dafür einen zweiten Aufruf (`restow-agent snapshot-exec --hash <liste>`), der im
   selben Baum hasht. Damit entspricht der Hash immer dem gesicherten Inhalt, und die Regel
   "nur unveränderte Dateien" (`agent/internal/core/sample.go`) entfällt für diese Läufe.
6. Snapshots entfernen (Abschnitt 6.5), `consistency` bilden.
7. Abschluss mit `layout` (Manifest), `consistency`, `stats` wie bisher.

Neue Lauf-Fehlercodes (`packages/core/src/endpoints/run-errors.ts`,
`ENDPOINT_RUN_ERROR_CODES`): `layout_capture_failed` (Lauf `partial`), `layout_too_large`
(`partial`), `layout_rejected` (vom Server gesetzt, Hinweis). Die Kategorie "nicht
unterstützt" ist **kein** Lauf-Fehler: Die Sicherung ist richtig, nur die Wiederherstellung
des ganzen Rechners geht nicht; das zeigt die Rechnerseite (Abschnitt 14.6) und nicht jeder
Lauf als `partial`.

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
  unter Windows, docs/WINDOWS-AGENT.md 17.1).

| Dateisystem liegt auf | Verfahren | `method` |
| --- | --- | --- |
| btrfs (jedes Subvolume) | `btrfs subvolume snapshot -r` | `btrfs` |
| ext2/3/4, XFS auf einem LV (dick) | `lvcreate -s -L <cow> -n <lv>_restowsnap --addtag restow-agent-snapshot` | `lvm` |
| ext2/3/4, XFS auf einem Thin-LV | `lvcreate -s -n <lv>_restowsnap --addtag restow-agent-snapshot` (ohne Größe), Aktivierung mit `-K` | `lvm` |
| LVM auf LUKS (der übliche verschlüsselte Aufbau) | wie LV | `lvm` |
| LUKS auf einem LV | live (Abschnitt 6.6) | – |
| Partition, md, LUKS auf Partition | live | – |
| vfat (ESP) | live (klein, ändert sich selten) | – |

Gibt es sowohl LVM- als auch btrfs-Snapshots in einem Lauf, ist `method` `mixed`.

### 6.2 Schutz der Produktion

Ein Snapshot darf den Rechner nie gefährden. Regeln in `agent/internal/fssnap/lvm_linux.go`:

- **Dick:** COW-Größe je LV = 10 Prozent der LV-Größe, mindestens 1 GiB, höchstens 32 GiB;
  alle zusammen höchstens 90 Prozent des freien Platzes der VG. Reicht der Platz nicht für
  alle, bekommen Snapshots in dieser Reihenfolge Platz: `/`, dann nach Tiefe des
  Einhängepunkts; der Rest wird live gelesen (`partial`, Lauf-Fehler `snapshot_failed` mit
  "kein freier Platz in der VG vg0"). Ein überlaufender dicker Snapshot wird ungültig, das
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
  frei sind.
- Einfrieren: `lvcreate` friert ext4 und XFS über dm-suspend selbst ein; btrfs-Snapshots sind
  atomar. Kein `fsfreeze` durch den Agenten.

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
  Einhängepunkt den Snapshot oder (live) einen nur lesenden Bind-Mount des echten
  Dateisystems, in der Reihenfolge der Pfadtiefe. Dann nur lesend `/proc`, `/sys`, `/dev`,
  `/run` (für `/etc/resolv.conf` als Link nach `/run/systemd/resolve`) als Bind; lesend und
  schreibend `Layout.CacheDir()` und `Layout.TmpDir()`; das restic-Programm als Datei-Bind an
  seinem Ort. Danach `chroot`, `chdir("/")`, `syscall.Exec(restic)`. restic sieht `/`,
  `/home`, ... wie auf dem Rechner, `-x` übergeht `/proc`, `/sys`, `/dev`, `/run`.
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

Was der Agent im Baum nicht ändern kann, ist der Inhalt des Snapshots selbst: CA-Zertifikate,
`/etc/hosts`, `/etc/passwd` (für restics Namensauflösung) kommen aus dem Snapshot, der
Sekunden alt ist. Das ist gewollt.

### 6.4 Snapshot-Plan und Politik

`agent/internal/core/snapshot_linux.go` (neu, ersetzt `snapshot_other.go` für Linux;
`snapshot_other.go` bleibt für macOS bis M6) liefert `planSnapshot(cfg, sources)` mit den
Dateisystemen und Verfahren, `snapshotPlan.method` und `volumes` (hier: Einhängepunkte).
`backupStep` bekommt einen zweiten Zweig: Bei `plan.requested && plan.method != "vss"` legt
`fssnap.Create(ctx, plan)` die Snapshots an, liefert die Spezifikation für den Helfer und
ein `fssnap.Outcome` (gescheitert je Einhängepunkt mit Grund, live, aufgeräumt). Daraus
bildet `consistencyOf` wie bisher den Bericht; `restic.SnapshotOutcome` bleibt der Typ
(`FailedVolumes` enthält dann Einhängepunkte). `snapshotLogHint` und die Texte von
`snapshotUnavailableError`/`snapshotFailedErrors` werden je Verfahren formuliert (heute fest
"Volume Shadow Copy"): `lvs`, `vgs`, `journalctl -k` für LVM, `btrfs filesystem usage` für
btrfs. Schlägt das Anlegen fehl:

| Fall | `continue` | `fail` |
| --- | --- | --- |
| ein Snapshot scheitert (Platz, `lvcreate`-Fehler) | dieses Dateisystem live, `partial`, `snapshot_failed` mit Pfad | `failed`, `snapshot_failed` |
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

- Ablauf (`agent/internal/fssnap/apfs_darwin.go`): `tmutil localsnapshot` (gibt das Datum aus,
  der Name ist `com.apple.TimeMachine.<datum>.local`), dann
  `mount_apfs -o nobrowse,rdonly -s <name> /System/Volumes/Data /private/var/run/restow-agent/apfs`
  (Entscheidung), sichern, `umount`, `tmutil deletelocalsnapshots <datum>`. Der Agent führt
  die von ihm angelegten Snapshots in `Layout.DataDir()/apfs-snapshots.json` und räumt
  übrig gebliebene beim Start auf, nur diese.
- Voraussetzung: Festplattenvollzugriff für `restow-agent` (wie heute für geschützte Ordner,
  `backup.go` gibt den Hinweis). Ohne ihn scheitert `mount_apfs` bzw. das Lesen; Behandlung
  `snapshot_unavailable` nach der Richtlinie.
- Quellen auf dem Data-Volume werden auf den Einhängepunkt umgeschrieben (`/Users` ->
  `/private/var/run/restow-agent/apfs/Users`), Quellen anderer Volumes (`/Volumes/Extern`)
  live (`liveFilesystems`).
- **Pfade:** macOS kennt weder private Mount-Namensräume noch Bind-Mounts, ein `chroot` in den
  Data-Snapshot hätte keine Systembibliotheken. Snapshot-Pfade tragen darum das Präfix
  `/private/var/run/restow-agent/apfs`. Der Snapshot bekommt das Tag `restow-fsroot=apfs`.
  `@restow/core` `snapshotRootOf(tags)` liefert das Präfix; Browser, ZIP-Download,
  Restore-Auswahl und die Anzeige der Lauf-Pfade rechnen mit `toViewPath`/`fromViewPath` um;
  der Agent stellt mit `restic restore <id>:/private/var/run/restow-agent/apfs` her
  (Unterordner-Syntax, 1.2) und rechnet Auswahlpfade ebenso um
  (`agent/internal/core/pathmap.go`, neu, ohne Build-Tag). Die Stichprobe meldet
  Snapshot-Pfade (mit Präfix), damit `restic dump` auf dem Server ohne Umrechnung trifft.
  Ein Lauf im Rückfall (live) hat kein Tag und keine Umrechnung; durch `--group-by host` ist
  der Elternsnapshot trotzdem der vorige.
- Der Snapshot ist absturzkonsistent für das ganze Data-Volume. Mail, Fotos, Datenbanken von
  Programmen sind im Zustand eines Stromausfalls, nicht im Zustand nach sauberem Beenden.
- `method: "apfs"`, sonst dieselben Regeln wie unter Linux (6.1, 6.4).
- [Maschine] Ob `tmutil localsnapshot` ohne eingerichtetes Time Machine auf allen
  unterstützten macOS-Versionen einen Snapshot des Data-Volumes anlegt; ob macOS einen
  eingehängten lokalen Snapshot bei Platzmangel löscht (macOS räumt lokale Snapshots unter
  Druck ab); wie lange `tmutil` bei vollem Volume braucht.

## 8. Recovery-ISO

### 8.1 Eigenes Werk unter `integrations/recovery`

Entscheidung des Maintainers: getrennt vom Kern, GPL. Lizenz des Werks:
**GPL-3.0-or-later** (Vorschlag, Entscheidung 25.B1): Die Bauanleitung folgt live-build
(GPL-3.0-or-later) und darf dessen Beispiel-Hooks übernehmen; nichts darin muss mit
GPL-2.0-only-Code verbunden werden. Inhalt:

```
integrations/recovery/
  LICENSE                     GPL-3.0 (voller Text)
  README.md                   Bau, Prüfung, Lizenzen, Firmwareliste
  build.sh                    Einstieg: Container, live-build, Prüfsummen (SPDX-Kopf)
  snapshot.env                SNAPSHOT_TIMESTAMP, DEBIAN_IMAGE_DIGEST, LIVE_BUILD_VERSION
  auto/config                 lb config ... (SPDX-Kopf)
  config/package-lists/recovery.list.chroot
  config/package-lists/firmware.list.chroot
  config/hooks/live/*.hook.chroot       (Shell, SPDX)
  config/includes.chroot/etc/systemd/system/restow-recover.service
  config/includes.chroot/etc/systemd/network/80-restow-dhcp.network
  config/includes.chroot/usr/share/doc/restow-recovery/README
  config/bootloaders/grub-pc/*, grub-efi/*, isolinux/*   Menüs (Abschnitt 8.6)
  firmware.md                 die Liste aus 8.4 mit Begründung und Lizenzen
  sources.sh                  Quellpaket-Bündel (Abschnitt 8.7)
  test/machines/*.sh          Testmaschinen-Fabrik für die CI (Abschnitt 21.2)
```

Kein TypeScript, JavaScript oder Go darin (`check-separate-works.mjs`, `CORE_CODE`). Die
Programme `restow-agent` und `restic` legt `build.sh` aus einem übergebenen Ordner
(`agent/dist/linux-amd64/`) nach `/usr/lib/restow-recovery/` ins Abbild, mit
`THIRD_PARTY_NOTICES.txt`: Sie sind eigenständige Programme im Abbild, keine Bestandteile des
Werks. Änderungen an `scripts/ci/license-policy.json`: neuer Eintrag
`"integrations/recovery": { "license": "GPL-3.0-or-later", "reason": "...", "allowedReferences":
[".github/workflows/ci.yml", ".github/workflows/release.yml", "docs/BAREMETAL.md",
"docs/AGENT.md", "agent/README.md", "NOTICE", "THIRD_PARTY_NOTICES.md",
"scripts/recovery-e2e/run.mjs", "scripts/ci/check-separate-works.mjs",
"scripts/ci/check-separate-works.test.mjs", "scripts/ci/license-policy.json"] }`;
`check-separate-works.mjs` bekommt Marker für GPL-3.0 (`"GNU GENERAL PUBLIC LICENSE"`,
`"Version 3, 29 June 2007"`) und einen Test dafür. Die Testmaschinen-Fabrik (Shell) liegt im
Werk, der Ende-zu-Ende-Treiber (Node, Apache-2.0) außerhalb in `scripts/recovery-e2e/`.

### 8.2 Basis und Inhalt

- **Debian 13 (trixie), amd64, Kernel 6.12**, gebaut mit live-build aus einem festen Stand
  von `snapshot.debian.org` (`main`, `non-free-firmware`, dazu `debian-security` desselben
  Zeitpunkts). Grund für Debian: eine von Microsoft über shim signierte Startkette (shim,
  GRUB, Kernel, Module), die ohne eigene Schlüssel unter Secure Boot startet; reproduzierbare
  Live-Images sind bei Debian selbst ein laufendes Vorhaben; die Werkzeuge sind aktuell
  genug für alles aus 2.1.
- Pakete (`recovery.list.chroot`, ohne `Recommends`): `systemd`, `systemd-resolved`,
  `systemd-timesyncd`, `udev`, `kmod`, `util-linux` (`sfdisk`, `lsblk`, `blkid`, `wipefs`,
  `blkdiscard`, `findmnt`), `gdisk` (`sgdisk`), `parted` (nur `partprobe`), `mdadm`, `lvm2`,
  `thin-provisioning-tools`, `cryptsetup`, `cryptsetup-bin`, `dosfstools`, `e2fsprogs`,
  `xfsprogs`, `btrfs-progs`, `efibootmgr`, `mokutil`, `grub-efi-amd64-signed`,
  `grub-pc-bin` (nur für das ISO selbst), `shim-signed`, `openssh-server` (aus, Abschnitt
  10.2), `ca-certificates`, `kbd` und `console-setup` (Tastaturbelegung), `pciutils`,
  `usbutils`, `ethtool`, `iproute2`, `nvme-cli`, `smartmontools`, `less`, `nano`,
  `linux-image-amd64`, `live-boot`, `live-config`. Bewusst nicht: Desktop, WLAN-Werkzeuge,
  `os-prober`, ZFS.
- Im Live-System: `restow-recover.service` startet `restow-agent recover --console /dev/tty1`
  (bei `restow.console=ttyS0` auf der seriellen Konsole); ein Root-Login ohne Passwort gibt es
  nicht, eine Shell bekommt der Bediener über den Menüpunkt "Shell" in `recover`
  (Abschnitt 10.2).
- Arbeitsspeicher: mindestens 2 GiB, empfohlen 4 GiB und mehr für große Repositories (restic
  hält den Index im Speicher; `recover` schätzt den Bedarf aus der Indexgröße, die der Server
  mitteilt, und warnt). restic läuft mit `--no-cache` (der Cache läge im RAM).
- Größe: Ziel unter 900 MiB.

### 8.3 Reproduzierbarer Bau

- `build.sh` läuft in `debian:trixie@sha256:<digest>` (Digest in `snapshot.env`) mit
  `--privileged` (live-build braucht `chroot` und `mount`), Spiegel
  `http://snapshot.debian.org/archive/debian/<SNAPSHOT_TIMESTAMP>/` (und `debian-security`),
  `SOURCE_DATE_EPOCH` = Zeitpunkt des Snapshots, fester Hostname, Zeitzone UTC, `umask 022`,
  Locale `C.UTF-8`, `--apt-recommends false`, keine `apt-get update`-Zeitstempel im Abbild
  (Hook entfernt `/var/lib/apt/lists`, `/var/cache`, `/var/log/*`, Maschinen-ID leer,
  SSH-Hostschlüssel werden erst beim Start erzeugt).
- Jedes Restow-Release nimmt einen neuen Zeitpunkt (Sicherheitsupdates); `snapshot.env`
  wird im Release-Commit gesetzt und ist damit Teil des Tags. Aus dem Tag ist das ISO
  bitgleich nachbaubar.
- CI (`.github/workflows/ci.yml`, neuer Job `recovery-iso`, läuft wenn sich
  `integrations/recovery/**`, `agent/**` oder `snapshot.env` ändern, sonst aus dem Cache):
  baut zweimal in getrennten Arbeitsordnern mit unterschiedlicher `TZ` und `umask` und
  vergleicht die SHA-256; bei Abweichung läuft `diffoscope` und der Job scheitert.
  Zusätzlich prüft er: Firmwareliste im Abbild gleich `firmware.list.chroot` (Abschnitt 8.4),
  `restow-agent version --short` im Abbild gleich der gebauten Version, `xorriso -indev ...
  -report_el_torito` zeigt BIOS- und UEFI-Starteintrag.
- [CI] Ob live-build in der gewählten Version mit diesen Einstellungen bitgleich baut; wenn
  nicht, die Abweichungen beheben (Hooks), bevor M4 als fertig gilt.

### 8.4 Nicht-freie Firmware (feste Liste)

Nur Firmware, ohne die eine verbreitete **kabelgebundene Netzwerkkarte oder ein
Speichercontroller** in Servern und Arbeitsplätzen nicht oder nur eingeschränkt läuft. Keine
WLAN-, Bluetooth-, Grafik- oder Sound-Firmware (kein WLAN im ISO; die Konsole läuft über
`efifb`/`simplefb` bzw. VGA-Text ohne GPU-Firmware), kein CPU-Microcode (für die
Wiederherstellung nicht nötig, hält das Abbild klein). Pakete aus Debians
`non-free-firmware`; Debian liefert sie seit 12 in den eigenen Installations- und
Live-Medien aus.

| Paket | Wofür | Lizenz (aus `/usr/share/doc/<paket>/copyright`) |
| --- | --- | --- |
| `firmware-bnx2` | Broadcom NetXtreme II 1 GbE (`bnx2`: BCM5706/5708/5709/5716), in vielen Dell-, HP- und Lenovo-Servern | Broadcom, Weitergabe in unveränderter Form erlaubt, nicht frei |
| `firmware-bnx2x` | Broadcom/QLogic NetXtreme II 10 GbE (`bnx2x`: BCM57710/57711/57712/578xx) | wie oben |
| `firmware-qlogic` | QLogic `qed`/`qede` (25/40/100 GbE), `qla2xxx` (FC-HBAs, damit Platten sichtbar sind) | QLogic/Marvell, Weitergabe erlaubt, nicht frei |
| `firmware-realtek` | Realtek `r8169` (`rtl_nic/*`: RTL8125/8126/8168/8111-Varianten in Arbeitsplätzen und kleinen Servern) | Realtek, Weitergabe erlaubt, nicht frei |
| `firmware-misc-nonfree` | `tg3` (`tigon/*`, ältere Broadcom-Karten), weitere Netz- und Controller-Firmware | je Datei verschieden, alle zur Weitergabe freigegeben |
| Intel `ice`-DDP-Paket (`intel/ice/ddp/ice.pkg`, Intel E810) | ohne DDP startet `ice` nur im eingeschränkten "Safe Mode" | Intel, Weitergabe erlaubt, nicht frei; **Paketname in trixie bei der Umsetzung festlegen** (Debian hat `firmware-nonfree` in trixie in kleinere Pakete aufgeteilt) |

Nicht nötig (Treiber ohne nachzuladende Firmware): Intel `e1000e`, `igb`, `igc`, `ixgbe`,
`i40e`, Mellanox `mlx4`/`mlx5`, Broadcom `bnxt_en`, Aquantia `atlantic`, `virtio_net`,
`vmxnet3`, `hv_netvsc`; Speicher `ahci`, `nvme`, `megaraid_sas`, `mpt3sas`, `smartpqi`,
`aacraid`, `hpsa`, `virtio_blk`/`virtio_scsi`, `vmw_pvscsi`, `hv_storvsc`.

Lizenzhinweise: `build.sh` erzeugt `/usr/share/doc/restow-recovery/FIRMWARE-LICENSES.txt` aus
den `copyright`-Dateien dieser Pakete und legt dieselbe Datei als Release-Anhang ab; die
Paketliste prüft der CI-Job gegen das Abbild (8.3). Eine Änderung der Liste ist eine Änderung
von `firmware.md` mit Begründung im CHANGELOG.

### 8.5 Signatur und Verteilung

- Release-Job `recovery-iso` (neu in `release.yml`) nach `agent` und vor `agent-sums`: baut
  das ISO aus dem eben gebauten `linux-amd64`-Agenten, baut es ein zweites Mal und vergleicht,
  lädt `restow-recovery_<v>_amd64.iso`, `restow-recovery_<v>_FIRMWARE-LICENSES.txt` und das
  Quellbündel (8.7) als Artefakt hoch. `agent-sums` nimmt die Zeile
  `<sha256>  recovery/restow-recovery_<v>_amd64.iso` in `agent-SHA256SUMS` auf. Damit
  deckt die eine Signatur des Maintainers (`sign-agent.sh`, Namensraum
  `restow-agent-release`) auch das ISO; geprüft wird mit
  `scripts/release/verify-agent-signature.sh agent-SHA256SUMS agent-SHA256SUMS.sig
  agent/release-signing.pub` und danach `sha256sum -c --ignore-missing agent-SHA256SUMS`.
  `publish` hängt das ISO an das GitHub-Release.
- Vorher zu prüfen: dass `release.ParseSums` (`agent/internal/release/sums.go`), `linux.sh`,
  `macos.sh` und `windows.ps1` eine Zeile mit `/` im Namen übergehen bzw. annehmen; ein Test
  je Leser.
- Das ISO liegt **nicht** im Image (Größe). Die Instanz nennt es: `GET /api/v1/recovery-iso`
  gibt Version, URL des GitHub-Release-Anhangs, SHA-256 (aus dem signierten
  `SHA256SUMS` des Images, `/srv/agent/<v>/SHA256SUMS`), den Fingerabdruck des
  Release-Schlüssels und die Prüfbefehle. Für Installationen ohne Internet: Liegt das ISO in
  `RESTOW_RECOVERY_ISO_DIR` (Volume), liefert `GET /install/recovery/<v>/<datei>` es aus,
  nachdem der Server die SHA-256 gegen das signierte `SHA256SUMS` geprüft hat.
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
  `recover` braucht unsignierte Module, `kexec` oder `/dev/mem`.
- UEFI ohne Secure Boot und Legacy-BIOS (isolinux bzw. GRUB `i386-pc`) starten dasselbe.
- Menü: "Restow Recovery", "Restow Recovery (serielle Konsole ttyS0, 115200)",
  "Restow Recovery (einfacher Grafikmodus, nomodeset)", je mit Tastaturbelegung `de`, `us`,
  `ch`, `at`, `fr` als Untermenü (Kernel-Parameter `restow.keymap=de`), Standard nach 10
  Sekunden: Restow Recovery, `us`. `recover` fragt die Belegung zu Beginn noch einmal und
  setzt sie mit `loadkeys`.
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

### 9.1 Format

- 25 Zeichen aus dem Alphabet `0123456789ABCDEFGHJKMNPQRSTVWX` (30 Zeichen: Ziffern 0 bis 9
  und die Buchstaben A bis X ohne I, L, O, U), gleichverteilt aus
  `crypto.randomInt` (Zurückweisung, kein Modulo-Fehler), angezeigt als
  `RC-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX`. 25 · log2(30) = 122,7 Bit. Kein Y und kein Z
  (vertauscht auf deutscher Tastatur), keine Zeichen, die sich mit `O`/`0` oder `I`/`1`
  verwechseln lassen. Eingabe ohne Rücksicht auf Groß-/Kleinschreibung, Bindestriche und
  Leerzeichen werden ignoriert, `O` gilt als `0`, `I` und `L` als `1`
  (`normalizeRecoveryCode`).
- Gespeichert wird nur `SHA-256("restow-recovery-code:" || normalisierter Code)`.
- Geschwärzt wird das Muster in jedem Log (`packages/core/src/endpoints/run-redact.ts` und
  `agent/internal/redact`).
- Code: `packages/core/src/endpoints/baremetal/recovery-code.ts` (`generateRecoveryCode`,
  `normalizeRecoveryCode`, `hashRecoveryCode`), gleiche Normalisierung in Go
  (`agent/internal/recovery/code.go`), Testvektoren in beiden Sprachen.

### 9.2 Ausstellen

`POST /api/v1/endpoints/:id/recovery-codes` mit `{ snapshotId?, validityHours? }`, nur
Mandanten-Admins, frische Anmeldung (`assertRecentSignIn`, wie das Repository-Passwort),
Audit `endpoint.recovery_code.created` (Ersteller, Gültigkeit, Snapshot, nie der Code).
`validityHours` 1 bis 48, Standard 4. Antwort einmalig `{ id, code, expiresAt, instanceUrl,
snapshotId, iso: { version, url, sha256 } }`. Bedingungen (sonst 409 mit eigenem
Problemtyp): Rechner Linux und nicht entfernt (gesperrt ist erlaubt: ein gesperrter
Rechner ist oft genau der kaputte), mindestens ein Snapshot mit Manifest und Urteil nicht
`unsupported`. Höchstens drei offene Codes je Rechner. Ein offener Code lässt sich
widerrufen (`POST .../recovery-codes/:codeId/revoke`, Audit `endpoint.recovery_code.revoked`)
und verlängern (`POST .../extend` mit `validityHours`, höchstens bis 48 Stunden nach dem
Ausstellen, frische Anmeldung, Audit `endpoint.recovery_code.extended`), damit eine lange
Wiederherstellung nicht mitten im Lesen endet.

### 9.3 Eintauschen

`POST /agent/v1/recovery/sessions` (ohne Basic-Auth) mit `{ code, sessionSecretSha256,
recoveryVersion, hardware: { firmware: "uefi"|"bios", secureBoot, ramBytes, disks: [{ sizeBytes,
logicalSectorSize, model, serial, transport }], nics: [{ mac, driver, link }] } }`:

- `recover` erzeugt das Sitzungsgeheimnis selbst (32 Byte) und schickt nur dessen SHA-256.
  Das Geheimnis geht nie über die Leitung zurück; ein erneuter Aufruf mit demselben Code und
  demselben Hash (verlorene Antwort) liefert dieselbe Sitzung (idempotent). Ein anderer Hash
  für einen eingelösten Code ergibt 409 `recovery-code-used`. Damit ist der Code genau einmal
  einlösbar, ohne dass ein Netzfehler ihn verbraucht.
- Prüfung atomar wie beim Enrollment-Token (`UPDATE ... WHERE used_at IS NULL AND
  revoked_at IS NULL AND expires_at > now()`), Fehler je Fall mit eigenem Problemtyp:
  `recovery-code-invalid` (401, zählt gegen die Adresse: 30 Fehlversuche je 10 Minuten,
  `authFailures` aus `agent-auth.ts`), `recovery-code-expired`, `recovery-code-revoked`,
  `recovery-code-used`, `recovery-too-old` (`minRecoveryVersion`). Wer den Code kennt, darf
  wissen, warum er nicht geht.
- Antwort 201: `{ sessionId, expiresAt, endpoint: { id, hostname, displayName, os },
  repository: { url: "rest:https://<instanz>/agent/recovery/restic/<sessionId>/",
  password }, snapshotId, layoutSha256, snapshots: [{ id, time, layoutSha256, check }],
  indexBytes, minRecoveryVersion }`. Das Repository-Passwort geht an das ISO (restic
  entschlüsselt dort); das ist dasselbe Vertrauen wie beim Anzeigen des Passworts und wird
  ebenso auditiert: `endpoint.recovery.started` mit Adresse, ISO-Version und
  Hardware-Zusammenfassung.
- Beim Eintauschen nimmt der Server kurz die geteilte Wartungssperre des Repositorys
  (`repository-lock.ts`), damit kein Prune gerade läuft; siehe 9.5.

### 9.4 Lesezugang (`reader`)

- Neue Route `/agent/recovery/restic/:sessionId/*` (`apps/api/src/features/endpoints/recovery-restic-route.ts`)
  mit `buildRunResticRoute` (`apps/api/src/lib/restic-run-route.ts`): Basic
  `<sessionId>:<sessionSecret>`, `resolve` prüft Hash, Zustand `active`, `expiresAt`, Mandant
  aktiv, Rechner nicht entfernt, und liefert `{ principal: "reader", prefix:
  endpointPrefix(endpointId) }`. Abgelaufen oder beendet: 401 "Credential expired"
  (`recovery-session-ended`). Verweigerte Zugriffe auditiert
  (`endpoint.repository.denied` mit `principal: "recovery"`, gedrosselt wie heute).
- Ratenbegrenzung je Sitzung 120.000 Anfragen je 10 Minuten (eine Wiederherstellung liest
  viele Pack-Bereiche; die 20.000 des Agenten würden große Restores bremsen).
- restic im ISO läuft mit `--no-lock --no-cache`. Der Prinzipal `reader` lässt weder eine
  Sperrdatei noch sonst etwas zu.
- Der Agent-Zugang des Rechners bleibt davon unberührt: Läuft der alte Rechner noch, sichert
  er weiter (nur anhängen); die Wiederherstellung liest den gewählten Snapshot.

### 9.5 Kein Prune während einer Sitzung

Weil `recover` keine Sperre schreibt, schützt der Server den Snapshot selbst:

- `apps/worker/src/endpoints/retention.ts`: Vor der exklusiven Wartungssperre und noch einmal
  danach prüft der Job, ob für den Rechner eine Sitzung `active` (und nicht abgelaufen) ist;
  dann scheitert er mit `EndpointRepositoryBusyError` (kein Bericht, kein Zähler für
  "gesperrt", pg-boss wiederholt), Lauf-Log "wartet auf eine laufende Wiederherstellung".
  Die doppelte Prüfung zusammen mit der geteilten Sperre beim Eintauschen (9.3) schließt
  beide Reihenfolgen aus.
- `endpoint-removal` und `POST /api/v1/endpoints/:id/remove` (Modus `delete`): 409 bzw.
  aufgeschoben, solange eine Sitzung aktiv ist.
- `endpoint-check` liest nur und darf laufen.

### 9.6 Fortschritt, Ende, Ablauf

Mit Basic `<sessionId>:<sessionSecret>`:

| Aufruf | Zweck |
| --- | --- |
| `GET /agent/v1/recovery/sessions/current` | Zustand, `expiresAt`, `cancelRequested` (die Oberfläche hat "Abbrechen" gewählt) |
| `POST /agent/v1/recovery/sessions/current/progress` | `{ phase, step, stepsTotal, bytesDone, totalBytes, filesDone, totalFiles, message }`, alle 5 s (wie `runs/:id/progress`) |
| `POST /agent/v1/recovery/sessions/current/log` | bis zu 200 Zeilen je Aufruf, gesamt höchstens 2 MiB, geschwärzt gespeichert (`run-redact.ts`) |
| `POST /agent/v1/recovery/sessions/current/release` | Ende des Repository-Zugangs (Abschnitt 10.11): Zustand `finishing`, restic-Route antwortet ab jetzt 401, nur `progress`, `log`, `finish` bleiben |
| `POST /agent/v1/recovery/sessions/current/finish` | `{ status: succeeded/failed/cancelled, verification, warnings, durationSeconds }`, Zustand endgültig, Audit `endpoint.recovery.finished` |

Phasen: `connected`, `planning`, `confirmed`, `partitioning`, `restoring`, `configuring`,
`verifying`, `done`. Der Monitor (`apps/worker/src/endpoints/monitor.ts`) setzt abgelaufene
Codes auf `expired` und Sitzungen ohne Meldung seit 30 Minuten nach `expiresAt` auf
`failed` ("ISO meldet sich nicht mehr"), Audit `endpoint.recovery.expired`. Eine Sitzung
kann in der Oberfläche beendet werden (`POST .../recoveries/:id/cancel`): Die restic-Route
antwortet sofort 401, `recover` sieht `cancelRequested` beim nächsten Abruf.

## 10. `restow-agent recover`

### 10.1 Aufbau im Code

- `cmd/restow-agent/recover.go` (`//go:build linux`): Befehl `recover` mit
  `--console <tty>`, `--answers <datei>` (unbeaufsichtigt, Abschnitt 10.17), `--plan-only`,
  `--log <datei>`. Läuft nur als root und nur, wenn `/run/live/medium` oder
  `--i-know-this-is-not-the-iso` gesetzt ist (Schutz davor, es auf einem laufenden Server
  aufzurufen).
- `cmd/restow-agent/baremetal.go` (ohne Tag): `baremetal plan --manifest <datei|-> --target
  <same|minimal|datei> --json` (reiner Planer, für Stufe 1 auf dem Server und für Tests),
  `baremetal capture [--raw-dir <ordner>]` (`//go:build linux`, für Fehlersuche und zum
  Aufzeichnen von Testdaten).
- `agent/internal/recovery/` (neu): `session.go` (Client der Recovery-API), `ui.go`
  (zeilenweise Dialoge), `answers.go`, `network_linux.go`, `clock.go`, `hardware_linux.go`
  (Zielhardware aus `/sys/block`, `/sys/firmware/efi`, `lsblk`), `execute_linux.go`
  (Ausführung des Plans mit Protokoll und Abbruch), `chroot_linux.go`, `rootfs_linux.go`
  (Dateizugriffe unter dem Ziel mit `openat2`/`RESOLVE_IN_ROOT`), `verify_linux.go`,
  `rebind.go`.
- Planer und Fixups in `agent/internal/baremetal/` ohne Build-Tag: `plan.go`, `sizing.go`,
  `mapping.go`, `mkfs.go`, `fixups.go`, `cmdline.go`.

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
3. **Fernzugang (SSH):** startet `sshd` mit einem zufälligen Einmalpasswort für root (zwölf
   Zeichen aus dem Code-Alphabet), zeigt Adresse, Passwort und die Fingerabdrücke der eben
   erzeugten Hostschlüssel. Für Rechenzentren, in denen nur eine langsame BMC-Konsole
   erreichbar ist. Aus beim Start, endet mit dem Neustart.

### 10.3 Netzwerk, Uhrzeit, TLS

- **Netz:** Vorgabe DHCP auf allen kabelgebundenen Schnittstellen mit Link
  (`80-restow-dhcp.network`, systemd-networkd, IPv4 DHCP und IPv6 RA). `recover` wartet bis
  zu 30 Sekunden auf eine Adresse und zeigt dann je Schnittstelle Name, MAC, Treiber, Link,
  Adressen. **Statisch:** Schnittstelle, Adresse/Präfix, Gateway, DNS-Server (bis zu drei),
  geschrieben als `/run/systemd/network/10-restow-static.network`, `networkctl reload`.
  **Proxy:** `http://host:port` ohne Zugangsdaten (wie der Windows-Agent,
  docs/WINDOWS-AGENT.md 12.5), gilt für die Recovery-API und restic (`HTTPS_PROXY`). Kein
  VLAN, kein WLAN, kein Bonding (Entscheidung, Grenze in der Oberfläche genannt). Fehlt
  eine Netzwerkkarte, nennt `recover` die PCI-Geräte ohne Treiber (`lspci -k`) und den
  Hinweis auf die Firmwareliste.
- **Uhrzeit:** `systemd-timesyncd` mit Debians Pool; ist NTP nicht erreichbar und weicht
  die Uhr um mehr als 5 Minuten von der Zeit im `Date`-Kopf der ersten Antwort des Servers ab
  (die Anfrage selbst prüft TLS normal; scheitert sie an "certificate not yet valid" oder
  "expired", zeigt `recover` genau das), bietet `recover` an, die Uhrzeit von Hand zu setzen.
- **TLS:** Systemzertifikate (`ca-certificates`). Eigene CA: `recover` fragt nach einer
  PEM-Datei auf einem zweiten USB-Stick (eingehängt nur lesend unter
  `/run/restow-recovery/media`) oder zum Einfügen; alternativ zeigt es SHA-256 des
  Serverzertifikats und SPKI und verlangt die Bestätigung (Vergleich mit dem Wert, den die
  Oberfläche im Code-Dialog nennt, wenn die Installation ihn kennt: `settings.public_url`
  mit eigenem Zertifikat, Offene Frage 9). `http://` nur zu Loopback und im Labor
  (Abschnitt 12.3).
- **Adresse der Instanz:** Eingabe des Hostnamens genügt (`https://` wird ergänzt); ein Pfad
  ist nicht erlaubt (wie beim Enrollment: reine Origin).

### 10.4 Code, Snapshot, Manifest, Plan

1. Code eingeben, eintauschen (9.3). Anzeige: Rechner (Anzeigename, Hostname), Mandant,
   Gültigkeit, Snapshot (Vorauswahl aus dem Code, Liste der Bare-Metal-Snapshots mit Datum
   und Prüfstand, Abschnitt 12).
2. Manifest lesen: `restic dump --no-lock --no-cache <snapshot>
   /var/lib/restow-agent/baremetal/layout.json`, SHA-256 gegen `layoutSha256` des Servers
   (Abweichung: Abbruch mit "Manifest im Snapshot und auf dem Server verschieden", Audit
   über `log`). Prüfung `Validate`, Format bekannt.
3. Zielhardware erfassen (`hardware_linux.go`): Platten (ohne das Startmedium des ISO,
   ohne Wechseldatenträger außer auf ausdrückliche Auswahl), Größe, Sektorgrößen, Modell,
   Seriennummer, Transport, vorhandene Signaturen (`wipefs -n`), Firmwaremodus, Secure Boot.
4. Zuordnung (10.6), Größen (10.7), Optionen (Passphrase, Umbenennung der
   Netzwerkschnittstellen, Rückfallpfad der ESP).
5. **Plan** (`baremetal.Plan(m, target, choices) (*RestorePlan, []Problem)`): Liste von
   Schritten mit Art, Ziel, Argumentliste und Begründung. Probleme (kein Ziel groß genug,
   Firmwaremodus passt nicht, Format eines Dateisystems mit dem ISO nicht erzeugbar,
   Sektorgröße unvereinbar) verhindern die Ausführung und werden mit Abhilfe genannt.
6. Anzeige des Plans als Zusammenfassung ("Platte nvme0n1 (Samsung …, 1,0 TB) erhält:
   GPT, 1 ESP 512 MiB, 2 /boot 1 GiB, 3 LUKS2 -> LVM vg0: root 50 GiB, swap 8 GiB,
   home 875 GiB (gewachsen)") und auf Wunsch jeder Befehl (`p`).
7. **Bestätigung:** Für jede Zielplatte, die Daten trägt (Signaturen gefunden), muss der
   Bediener die letzten vier Zeichen ihrer Seriennummer eintippen; danach `LÖSCHEN`
   (bzw. `ERASE`). Unbeaufsichtigt nur mit `answers.confirmErase` und genau passenden
   Seriennummern.

### 10.5 Firmwaremodus und Startkette

- Gesichert UEFI, ISO im UEFI-Modus gestartet: ok. Gesichert BIOS, ISO im BIOS-Modus: ok.
  Gesichert BIOS auf GPT mit BIOS-Boot-Partition **und** ESP: beide Modi ok, `recover`
  richtet beide ein.
- Sonst Abbruch vor dem Plan: "Das System wurde im BIOS-Modus gesichert; dieser Rechner hat
  das ISO im UEFI-Modus gestartet. Im Firmware-Setup CSM/Legacy-Start einschalten und das
  ISO im BIOS-Modus starten." (und umgekehrt).
- Secure Boot: Gesichert mit shim und Secure Boot, Ziel mit Secure Boot: ok (die Dateien
  auf der ESP kommen aus der Sicherung). Ziel mit Secure Boot, Quelle ohne shim
  (systemd-boot unsigniert, eigene Kernel): Warnung "startet nur mit abgeschaltetem Secure
  Boot oder eigenen Schlüsseln". Eigene MOK-Schlüssel (`mokutil --list-enrolled` im Manifest
  nicht erfassbar, aber ein Kernel mit eigener Signatur): Hinweis, die MOK nach dem Start
  neu einzuschreiben.

### 10.6 Zuordnung der Platten

- Automatisch, wenn die Zahl der Zielplatten gleich der Zahl der Quellplatten ist und jede
  Zuordnung passt: zuerst gleiche Seriennummer (gleiche Hardware, Platten noch da), dann
  gleiche Größe und Transport, dann nach Größe absteigend gegen den Mindestbedarf
  absteigend. Sonst fragt `recover` je Quellplatte ("d0 war nvme0n1, 512 GB, trug /, /boot,
  ESP; Mindestgröße 61 GiB"), Auswahl aus den freien Zielplatten oder "fehlt".
- **Weniger Zielplatten als Quellplatten** nur, wenn jede fehlende Platte ausschließlich
  Mitglied von RAID-Arrays ist, die ohne sie laufen (RAID 1 und 10 mit verbleibender Kopie,
  RAID 5 mit einer, RAID 6 mit bis zu zwei fehlenden): Die Arrays entstehen **degradiert**
  (`missing` in `mdadm --create`), Stapel und Konfiguration bleiben gleich, eine Platte lässt
  sich später mit `mdadm --add` ergänzen. Der Plan sagt das deutlich. btrfs-RAID-Profile
  degradiert anzulegen geht nicht (`mkfs.btrfs` verlangt alle Geräte): Dann ist die
  Zuordnung unvollständig und der Plan nennt das Problem.
- Gerätenamen spielen keine Rolle: Ziel ist das Gerät, das `recover` gerade sieht
  (`/dev/disk/by-id/...`), NVMe statt SATA oder umgekehrt ist gleichgültig, weil alle
  Verweise im System über UUIDs laufen (Fixups für die Ausnahmen in 10.11).

### 10.7 Größen

`baremetal.MinimumDiskSizes(m)` und `sizing.go`:

- Mindestgröße eines Dateisystems: `usedBytes` · 1,10 + feste Reserve je Typ (ext4: Journal
  + 2 Prozent Metadaten + reservierte Blöcke; XFS: Log + 1 Prozent; btrfs: 1 GiB Metadaten
  je Gerät; vfat: unverändert), mindestens die Größe, die `mkfs` des Typs verlangt (vfat
  FAT32 mit 4Kn-Sektoren: 260 MiB). Eine ESP, ein `/boot` und Swap behalten ihre Größe
  (Swap schrumpft auf Wunsch).
- **Größere Platte:** Partitionen und LVs behalten ihre Größe, die mit `grow` markierte
  Partition wächst bis zum Ende, darin das mit `grow` markierte LV bis zum Ende der VG.
  Thin-Pools wachsen nicht von selbst (der Bediener kann im Plan den Pool statt eines LV
  wählen).
- **Kleinere Platte:** Die `grow`-Partition bzw. das `grow`-LV schrumpft so weit wie nötig,
  nie unter seine Mindestgröße; reicht das nicht, schlägt der Planer vor, welche weiteren LVs
  schrumpfen (größter Überschuss zuerst), und der Bediener bestätigt. XFS kann man nicht
  verkleinern, muss man hier auch nicht: Jedes Dateisystem wird neu angelegt.
- Ausrichtung auf 1 MiB, Partitionsnummern bleiben (wichtig für `efibootmgr` und für
  Verweise wie `/dev/sda2`), Reihenfolge bleibt. Gleich große Zielplatte: Start und Größe
  exakt wie gesichert.
- MBR und Platten über 2 TiB: Partitionen enden spätestens bei 2 TiB, der Rest bleibt
  frei, Warnung im Plan. Keine Umwandlung nach GPT.
- Sektorgrößen: Zielplatte mit 4096 Byte logisch und Quelle mit 512: Start und Größe auf
  4096 gerundet, XFS bekommt `-s size=4096`, vfat `-S 4096`, LUKS `--sector-size 4096`
  bleibt oder wird gesetzt; umgekehrt bleiben 4096-Byte-Sektoren in LUKS und XFS erhalten
  (auf 512e-Platten erlaubt).

### 10.8 Partitionieren, RAID, LUKS, LVM

Reihenfolge je Platte und Schicht, jeweils mit `udevadm settle` danach:

1. `wipefs -a` auf jeder Zielplatte und danach auf jeder neuen Partition (alte RAID-, LVM-,
   LUKS-Signaturen würden sonst von udev erkannt und aktiviert), `blkdiscard` auf Wunsch
   (Standard aus, auf SSDs angeboten).
2. **Partitionstabelle** mit `sfdisk` aus einem erzeugten Skript (`sfdisk --dump`-Format):
   `label: gpt|dos`, `label-id:` (Disk-GUID bzw. MBR-Kennung, damit PARTUUIDs gleich
   bleiben; bei MBR ist die PARTUUID `<kennung>-<nummer>`), `unit: sectors`,
   `sector-size:`, je Partition `start=`, `size=`, `type=`, `uuid=`, `name=`, `attrs=`,
   `bootable`. Danach `sfdisk --dump` zurücklesen und gegen den Plan vergleichen.
3. **mdadm:** `mdadm --create /dev/md/<name> --run --level=<l> --raid-devices=<n>
   --metadata=<v> --uuid=<uuid> --name=<name> --homehost=<host> [--chunk=<k>]
   [--layout=<l>] [--bitmap=internal] <mitglieder|missing>`. Kein `--assume-clean`: Bei
   RAID 5/6 machte das die Parität falsch, bei RAID 1 bleiben ungeschriebene Bereiche
   ungleich. Der Resync läuft im Hintergrund während der Wiederherstellung (langsamer, aber
   richtig); `recover` begrenzt ihn nicht.
4. **LUKS:** Für jedes Volume `cryptsetup luksFormat --type luks1|luks2 --uuid <uuid>
   --cipher <c> --key-size <k> --sector-size <s> [--label <l>] [--subsystem <s>]
   --pbkdf <art> [--pbkdf-memory/--iter-time] --batch-mode <dev>` mit der Passphrase über
   stdin (`--key-file -`), dann `cryptsetup open <dev> <mappedName>`.
   - **Neue Schlüssel:** Jedes Volume bekommt einen neuen Hauptschlüssel (die Daten kommen
     dateiweise aus der Sicherung, nicht blockweise). Header-Sicherungen gibt es nicht
     (Entscheidung).
   - **Gleiche Parameter:** Version, Cipher, Schlüssellänge, Sektorgröße, PBKDF-Art. Grund:
     GRUB entsperrt ein verschlüsseltes `/boot` nur mit LUKS1 oder LUKS2 mit PBKDF2;
     Argon2-Parameter werden auf der neuen Hardware neu gemessen (`--iter-time 2000`),
     höchstens mit dem Speicher, den der kleinere von Quell- und Ziel-RAM zulässt.
   - **Wie der Bediener entsperrt:** `recover` fragt einmal nach der Passphrase (zweimal
     eingeben), Vorgabe "dieselbe für alle Volumes", auf Wunsch je Volume. Es kann die alte
     Passphrase sein; `recover` kennt sie nicht und prüft sie nicht. Beim ersten Start fragt
     das System wie gewohnt danach.
   - **Schlüsseldateien:** Nennt `/etc/crypttab` für ein Volume eine Schlüsseldatei, die in
     der Sicherung liegt (z. B. `/etc/luks-keys/data.key`), fügt `recover` sie nach der
     Wiederherstellung als zweiten Keyslot hinzu (`cryptsetup luksAddKey`, Datei über
     `rootfs_linux.go` aus dem Ziel gelesen), damit das automatische Entsperren weiter geht.
     Liegt sie in einem initramfs-Hook (`KEYFILE_PATTERN`, dracut `install_items`), wird sie
     mit dem neuen initramfs (10.12) wieder eingebaut.
   - **TPM2, FIDO2, Clevis:** werden nicht übernommen (an die alte Hardware bzw. den alten
     Hauptschlüssel gebunden). `crypttab`-Optionen wie `tpm2-device=auto` bleiben stehen;
     systemd fällt dann auf die Passphrase zurück. Der Abschluss nennt den Befehl zum neu
     Einrichten (`systemd-cryptenroll --tpm2-device=auto <dev>`, `clevis luks bind ...`).
5. **LVM:** `pvcreate --uuid <pvuuid> --norestorefile <dev>` (gleiche PV-UUID), `vgcreate
   -s <extent> <vg> <pvs>`, je LV `lvcreate` mit Typ und Größe aus dem Plan (`-L`,
   `--type striped -i -I`, `--type raid1 -m`, `--type thin-pool --chunksize
   --poolmetadatasize`, Thin-LVs mit `-V` und `--thinpool`), Tags, Aktivierung. Bewusst
   **nicht** `vgcfgrestore`: Es kann Thin-Pool-Metadaten nicht wiederherstellen und passt
   nicht zu geänderten Größen. Folge: VG- und LV-UUIDs sind neu. Verweise darauf
   (`/dev/disk/by-id/dm-uuid-LVM-…`, `lvm2-pvscan`) kommen in Konfigurationen selten vor;
   `fixups.go` findet und ersetzt sie (10.11). Namen von VG und LV bleiben, damit stimmen
   `/dev/mapper/vg0-root`, `rd.lvm.lv=vg0/root` und `root=/dev/vg0/root`.

### 10.9 Dateisysteme anlegen

`baremetal/mkfs.go` baut die Argumente nur aus erfassten Werten, nie aus Vorgaben des
`mkfs` im ISO. Grund: Neuere `mkfs`-Versionen schalten Funktionen standardmäßig ein, die
ältere Kernel oder GRUB-Versionen nicht lesen (bekanntes Beispiel: e2fsprogs 1.47 mit
`metadata_csum_seed` und `orphan_file`, die GRUB vor 2.12 bzw. Kernel vor 5.15 nicht
verstehen; bei XFS `bigtime`, `inobtcount`, `nrext64` gegenüber älteren Enterprise-Kerneln).
Ein im ISO erzeugtes Dateisystem, das das wiederhergestellte System nicht einhängen kann,
wäre der schlimmste Fehler dieses Entwurfs.

| Typ | Befehl | aus dem Manifest |
| --- | --- | --- |
| ext2/3/4 | `mkfs.ext4 -F -U <uuid> [-L <label>] -b <bs> -I <inodesize> -N <inodes> -m <reserved> -O none,<features> [-G <flexbg>] [-J size=<MiB>] [-E stride=,stripe_width=]` (ext2/3 über `-t`) | Funktionsliste aus `dumpe2fs -h` wörtlich, Inode-Zahl im Verhältnis zur neuen Größe |
| XFS | `mkfs.xfs -f -m uuid=<uuid>,crc=,finobt=,rmapbt=,reflink=,bigtime=,inobtcount= -i sparse=,nrext64= -n ftype= -b size= -s size= [-L <label>] [-l size=]` | aus `xfs_info`; eine Option, die das `mkfs.xfs` des ISO nicht kennt, ist nur zulässig, wenn ihr Wert der Kernel-Standard alter Versionen ist (`0`) |
| btrfs | `mkfs.btrfs -f -U <uuid> [-L <label>] -n <nodesize> -s <sectorsize> --csum <crc32c|xxhash|sha256|blake2> -O <features>,^<abgeschaltete> -d <profil> -m <profil> <geräte>` | aus `dump-super` (`incompat_flags`, `compat_ro_flags`), Geräte in Reihenfolge der `devid` |
| vfat | `mkfs.vfat -F <12|16|32> -i <volumeid> [-n <label>] [-S <sektor>] [-s <cluster>]` | |
| Swap | `mkswap -U <uuid> [-L <label>] <dev>` | Swap-Dateien: nach dem Restore `fallocate` (btrfs: `chattr +C` auf leere Datei, dann `dd`), `chmod 600`, `mkswap -U` |

Danach je Dateisystem `blkid -p` zurücklesen: UUID, Typ, Label müssen dem Manifest gleichen,
bei ext4 die Funktionsliste (`dumpe2fs -h`), sonst Abbruch vor dem Restore.

**btrfs-Subvolumes:** oberste Ebene einhängen, je Subvolume aus dem Manifest
`btrfs subvolume create <pfad>` in Reihenfolge der Eltern (Snapper/Timeshift leer),
Standard-Subvolume setzen (`btrfs subvolume set-default <id-im-neuen-fs>`), Eigenschaften
(`btrfs property set ro`, Kompression) setzen. Subvolume-IDs werden neu vergeben; Verweise
mit `subvolid=` in `fstab` ersetzt `fixups.go` durch `subvol=<pfad>`. Ordner mit `+C`
(nodatacow) bis vier Ebenen unter jedem Einhängepunkt erfasst der Agent (`lsattr -d`,
Abschnitt 4.1, Feld `noCowDirs`) und `recover` setzt `chattr +C` vor dem Restore (restic
stellt Dateiattribute nicht her, 1.2).

### 10.10 Einhängen und Dateien zurückholen

- Ziel unter `/mnt/restow-target`: in der Reihenfolge der Pfadtiefe jedes Dateisystem des
  Manifests an seinem Einhängepunkt (btrfs mit `subvol=`), vfat mit `quiet` (sonst scheitern
  `chown`/`chmod` von restic auf FAT), alles andere mit den Standardoptionen.
- `restic restore --json --no-lock --no-cache --target /mnt/restow-target --sparse --verify
  --overwrite never <snapshot>` (neue Felder in `restic.RestoreOptions`: `Sparse`,
  `NoLock`, `NoCache`, `Overwrite`, `Subfolder`, `OwnershipByName`; heute fest
  `--overwrite never --verify`). Besitzer numerisch (restics Standard; richtig, weil
  `/etc/passwd` mitkommt), Hardlinks, ACLs, `security.capability`, `security.selinux`.
- Fortschritt aus restics `status`-Zeilen (wie `Restore` heute), an die Konsole und an
  `progress`.
- Fehler einzelner Dateien: gesammelt (wie `itemErrors`). Mehr als null Fehler bei
  Dateien unter `/boot`, `/usr`, `/etc`, `/lib*`, `/bin`, `/sbin` oder der ESP ist ein
  Abbruch vor den Fixups ("System unvollständig"); sonst eine Warnung mit Liste.

### 10.11 Ende des Repository-Zugangs, Fixups

Nach dem Restore ruft `recover` `release` (9.6): Ab hier hat das ISO keinen Zugang mehr zum
Repository. Erst danach laufen Programme aus der Sicherung (Schritte 10.12), damit ein
Programm des wiederhergestellten Systems weder Repository-Passwort noch Sitzung zu sehen
bekommt (es läuft außerdem mit leerer Umgebung, `procenv.Base()` ohne `RESTIC_*`).

`baremetal/fixups.go` (reine Textumformungen, jede mit Tabellentests) und
`recovery/rootfs_linux.go` (Lesen und atomares Schreiben unter dem Ziel, Links werden unter
dem Ziel aufgelöst, nie außerhalb). Jede Änderung legt die vorige Datei als
`<datei>.restow-<zeit>` daneben und steht im Abschlussbericht.

| Datei | Fixup | Wann |
| --- | --- | --- |
| `/etc/fstab` | Gerätenamen (`/dev/sda2`, `/dev/nvme0n1p2`, `/dev/md127`, `/dev/disk/by-path/...`, `/dev/disk/by-id/...`) durch `UUID=` bzw. `PARTUUID=` ersetzen; `subvolid=` durch `subvol=`; Einträge für nicht wiederhergestellte Dateisysteme mit `nofail` versehen und kommentieren | wenn solche Verweise vorkommen |
| `/etc/crypttab` | Quellgeräte wie oben auf `UUID=` | ebenso |
| `/etc/mdadm/mdadm.conf`, `/etc/mdadm.conf` | `DEVICE`-Zeilen mit Gerätenamen auf `DEVICE partitions containers`; `ARRAY` behalten (UUID gleich) | ebenso |
| Kernel-Kommandozeile (`/etc/default/grub` `GRUB_CMDLINE_LINUX*`, `/etc/kernel/cmdline`, BLS-Einträge `options`, `grubenv` `kernelopts`, systemd-boot `loader/entries`) | `root=/dev/...` und `resume=/dev/...` auf `UUID=`; `rd.md.uuid`, `rd.luks.uuid`, `rd.lvm.lv` bleiben (gleich) | ebenso |
| `/etc/default/grub.d`, Debconf `grub-pc/install_devices` | BIOS-Zielplatten auf die neuen `/dev/disk/by-id/...` | BIOS |
| `/etc/systemd/network/10-restow-<alt>.link` | `MACAddress=<neu>`, `Name=<alt>` | Umbenennung der Schnittstellen (10.13) |
| `/.autorelabel` | anlegen | SELinux `enforcing`/`permissive` |
| `/etc/machine-id` | bleibt | – |

### 10.12 initramfs, Bootloader, NVRAM

Im Ziel per `chroot` mit eingebundenem `/dev`, `/dev/pts`, `/proc`, `/sys`, `/run`,
`/sys/firmware/efi/efivars` (UEFI), Umgebung leer bis auf `PATH`, `LANG=C.UTF-8`.
Programme des **Zielsystems**, nicht des ISO: so passen Versionen und Konfiguration.

- **initramfs neu**, für jeden installierten Kernel:
  - initramfs-tools: `update-initramfs -c -k all` bzw. `-u -k all`; für diesen Lauf
    `/etc/initramfs-tools/conf.d/zz-restow-recovery` mit `MODULES=most`, danach entfernt
    (ein initramfs mit `MODULES=dep` vom alten Controller startet auf neuer Hardware nicht).
  - dracut: `dracut --force --regenerate-all --no-hostonly`. Grund: `hostonly` (Standard bei
    Fedora/RHEL) enthielte nur die Treiber des Rechners, auf dem es gebaut wird; im `chroot`
    wäre das zwar die neue Hardware, aber nur, soweit dracut sie aus dem `chroot` richtig
    erkennt. Ein allgemeines initramfs startet sicher; das nächste Kernel-Update baut wieder
    `hostonly`.
  - mkinitcpio: `mkinitcpio -P` (das `fallback`-Abbild ohne `autodetect` entsteht mit).
- **UEFI:** Die ESP-Dateien (shim, GRUB, systemd-boot, ggf. Kernel) kommen aus der Sicherung.
  `recover` legt je erfasstem aktiven `Boot####`-Eintrag, dessen Loader auf eine
  wiederhergestellte ESP zeigt, einen neuen Eintrag an (`efibootmgr --create --disk <ziel>
  --part <nummer> --label <label> --loader <pfad>`; vorhandene Einträge mit gleichem Pfad
  und gleicher PARTUUID werden nicht doppelt angelegt) und setzt `BootOrder` mit diesen
  vorn. Fehlt auf der ESP `\EFI\BOOT\BOOTX64.EFI`, kopiert `recover` (Option, Vorgabe an)
  den erfassten Loader samt Nachbardateien (`shimx64.efi` als `BOOTX64.EFI`, `grubx64.efi`,
  `mmx64.efi`, `fbx64.efi`) dorthin; manche Firmware vergisst NVRAM-Einträge oder lässt sie
  nicht schreiben. Ein `grub-install` für UEFI ist dann nicht nötig und unterbleibt
  (es könnte den shim-Weg der Distribution verändern).
- **BIOS:** `grub-install --target=i386-pc <platte>` (Debian, Ubuntu, Arch) bzw.
  `grub2-install` (RHEL, Fedora, SUSE) für jede Zielplatte, die eine Quellplatte mit
  GRUB-Bootcode ersetzt (bei RAID 1 alle Mitglieder), danach GRUB-Konfiguration neu:
  `update-grub` bzw. `grub2-mkconfig -o /boot/grub2/grub.cfg` mit
  `GRUB_DISABLE_OS_PROBER=true` in der Umgebung. Unter UEFI wird die Konfiguration nur
  neu erzeugt, wenn ein Fixup die Kommandozeile geändert hat.
- **systemd-boot:** `bootctl --esp-path=<esp> install` nur, wenn die ESP-Dateien fehlen;
  sonst nur NVRAM wie oben; Kommandozeilen in `loader/entries` wie in 10.11.
- **Secure Boot und MOK:** nichts zu tun, wenn shim und signierter Kernel aus der Sicherung
  kommen. Ein DKMS-Modul mit eigener MOK (z. B. NVIDIA) braucht nach dem Start die MOK neu
  (`mokutil --import`), Hinweis im Abschluss.

### 10.13 Netzwerkschnittstellen

Die Namen (`enp3s0`) hängen an der Hardware. Kommt das System auf neuer Hardware hoch, findet
eine statische Konfiguration (netplan, NetworkManager, ifupdown, networkd) ihre
Schnittstelle nicht. `recover` vergleicht `network` aus dem Manifest mit den physischen
Schnittstellen des Ziels. Gibt es genau eine physische Schnittstelle vorher und nachher,
schlägt es vor, die neue unter dem alten Namen zu führen (systemd `.link`-Datei, 10.11);
bei mehreren fragt es je alter Schnittstelle. Vorgabe an bei gleicher Anzahl, sonst aus.
Gleiche MAC (gleiche Hardware): nichts zu tun.

### 10.14 Prüfung nach der Wiederherstellung

`recovery/verify_linux.go`, Ergebnis als `verification` im Abschluss und auf der Konsole:

1. restic `--verify` ohne Fehler (10.10).
2. Jedes Dateisystem des Plans mit UUID, Typ, Label (`blkid -p`), md-Arrays aktiv
   (`mdadm --detail`), LVs vorhanden (`lvs`), LUKS geöffnet.
3. `findmnt --verify --tab-file /mnt/restow-target/etc/fstab` im `chroot` ohne Fehler;
   jeder Eintrag ohne `noauto`/`nofail` zeigt auf ein Gerät, das es gibt.
4. Jeder `crypttab`-Eintrag zeigt auf ein LUKS-Volume des Plans.
5. Für jeden Kernel gibt es ein initramfs, neuer als der Start der Wiederherstellung, und es
   enthält den Treiber des Ziel-Controllers (aus `/sys/block/<platte>/device/driver` bzw.
   dem Treiber des PCI-Elterngeräts; Liste mit `lsinitramfs`, `lsinitrd`, `lsinitcpio`) sowie
   `cryptsetup`, `mdadm`, `lvm` bzw. `btrfs`, wenn der Stapel sie braucht.
6. UEFI: Der neue `Boot####`-Eintrag steht in `BootOrder` und sein Loader liegt auf der ESP
   (Datei vorhanden, Größe gleich der gesicherten). BIOS: GRUB-Bootcode im MBR jeder
   Zielplatte (Kennung wie in `captureBootCode`), `core.img` in der BIOS-Boot-Partition bzw.
   hinter dem MBR.
7. GRUB-Konfiguration bzw. Loader-Einträge nennen nur UUIDs, die es gibt.

Jede Prüfung ist `ok`, `warning` oder `failed` mit Beleg. Ein `failed` heißt: kein Neustart
angeboten, sondern die Shell und das Protokoll; der Bericht an den Server ist `failed`.

### 10.15 Fortschritt, Abbruch, Fortsetzen

- Abbruch mit Strg+C oder `a` (mit Rückfrage), oder aus der Oberfläche (`cancelRequested`):
  restic bekommt SIGINT, `recover` hängt alles aus, schließt LUKS, stoppt Arrays nicht (ein
  laufender Resync schadet nicht) und sagt: "Die Zielplatten sind unvollständig."
- **Fortsetzen in derselben Sitzung:** Menüpunkt "Fortsetzen": öffnet und hängt wieder ein
  (ohne Partitionieren) und ruft `restic restore --overwrite if-changed` (vorhandene,
  richtige Dateien werden nur gelesen, nicht neu geladen).
- **Fortsetzen nach Neustart oder Stromausfall:** Der Code ist verbraucht, das
  Sitzungsgeheimnis war nur im Speicher. Der Admin stellt einen neuen Code aus. `recover`
  erkennt eine angefangene Wiederherstellung an der Datei
  `/.restow-recovery.json` im Ziel-Wurzeldateisystem (Snapshot, Planprüfsumme, Zeit,
  zuletzt erreichter Schritt; geschrieben nach dem Anlegen der Dateisysteme, gelöscht ganz
  am Ende) und bietet an, mit demselben Snapshot ohne Partitionieren fortzusetzen (LUKS mit
  der Passphrase öffnen, Arrays zusammensetzen, `vgchange -ay`, einhängen, `if-changed`).
- Zugang abgelaufen während des Restores (restic bekommt 401): `recover` hält an und fragt
  nach einem neuen Code, dann weiter mit `if-changed`.

### 10.16 Wiederanbinden am Ende (optional)

Nach der Prüfung bietet `recover` an, den wiederhergestellten Rechner gleich wieder mit
Restow zu verbinden: Eingabe eines **Wiederanbindungs-Tokens** (Abschnitt 11, in der
Oberfläche im selben Assistenten ausgestellt). `recover` ruft `POST /agent/v1/enroll` mit dem
Token und den Daten des Zielsystems (Hostname aus `/etc/hostname` im Ziel, `os`, `arch`,
Agent-Version des Ziels, Hook-Regel aus dem Manifest `agent.hooks`) und schreibt die Antwort
als `/mnt/restow-target/etc/restow-agent/state.json` (0600, root) über `state.Save` mit
umgelenktem Pfad. Ohne Token startet der Agent im wiederhergestellten System und wartet
("not enrolled yet", `waitForEnrollment` in `cmd/restow-agent/run.go`), bis jemand
`restow-agent enroll` mit einem Token aufruft.

### 10.17 Unbeaufsichtigt (`--answers`)

Für CI und Startprobe. Quelle: Datei, oder `restow.answers=fwcfg` (QEMU `fw_cfg`,
`/sys/firmware/qemu_fw_cfg/by_name/opt/restow/answers/raw`), oder ein zweites Medium mit dem
Label `RESTOWANS`. Inhalt (JSON): `instanceUrl`, `code`, `caFile?`, `snapshotId?`,
`network?`, `diskMapping: "auto" | {...}`, `passphrase`, `confirmErase: [<seriennummern>]`,
`renameNics`, `rebindToken?`, `afterSuccess: "reboot" | "poweroff"`, `probe?` (Abschnitt
12.3). Ohne `confirmErase` mit genau den Seriennummern löscht auch der unbeaufsichtigte
Modus nichts.

## 11. Wiederanbindung eines wiederhergestellten Rechners

Weil `state.json` nicht mehr gesichert wird (5.4) und der Wiederherstellungscode nur lesen
darf (Entscheidung), braucht der Rechner danach einen eigenen, getrennten Weg zurück:

- `POST /api/v1/endpoints/:id/rebind-token` (Mandanten-Admin, frische Anmeldung, Audit
  `endpoint.rebind_token.created`): ein Token wie beim Enrollment (`rset_`, 24 Stunden,
  einmal, nur SHA-256 gespeichert) in `endpoint_enrollment_tokens` mit gesetzter neuer Spalte
  `endpoint_id`. Antwort mit den Befehlen wie beim Enrollment (Linux, macOS).
- `POST /agent/v1/enroll` mit so einem Token (`agent-service.ts`, Zweig "rebind"): legt
  keinen Rechner an, sondern stellt für den bestehenden ein neues Agent-Secret aus
  (`secret_hash` ersetzt), behält Repository, Passwort, Job, Einstellungen, Läufe; `os` muss
  gleich sein (sonst 422), ein anderer Hostname wird angenommen und vermerkt. Ein gesperrter
  Rechner wird wieder aktiv. Audit `endpoint.rebound` (alter und neuer Hostname, Adresse).
- Folge: Ein noch laufender alter Rechner mit demselben Endpunkt bekommt ab jetzt 401. Der
  Dialog sagt das vorher ("Der bisherige Rechner verliert damit seine Verbindung").
- Derselbe Weg dient macOS (Abschnitt 13) und ist die Grundlage der geplanten
  Klonerkennung ("Neues Agent-Secret ausstellen"); beide nutzen dieselbe Funktion
  `rotateEndpointSecret` (neu, `apps/api/src/features/endpoints/rebind.ts`).
- Der Snapshot-Verlauf geht weiter: Der nächste Lauf findet über `--group-by host` den
  letzten Snapshot als Elternsnapshot und liest nur Geändertes (nach einer Wiederherstellung
  sind Inode und ctime neu, restic liest also alles einmal, lädt aber dank Deduplizierung
  kaum etwas hoch).

## 12. Restore-Prüfung auf dem Server ("Grün ist Beweis")

### 12.1 Stufe 1: Layout und Startkette

Neue Queue `endpoint-baremetal-check` (`packages/core/src/endpoints/queues.ts`), Job
`apps/worker/src/endpoints/baremetal-check.ts`, geplant vom Abschluss jedes Laufs mit neuem
Layout-Verweis (sofort) und vom Scheduler, falls einer fehlt. Hält die geteilte
Wartungssperre wie der Restore-Test. Prüfungen, jede mit Ergebnis und Beleg:

| Nr. | Prüfung | Wie | Rot nur bei |
| --- | --- | --- | --- |
| L1 | Schema und Verweise | `parseLayoutManifest`, Verweise auflösbar, keine Zyklen, Größen plausibel | ungültigem Manifest |
| L2 | Unterstützt | `verdict`, `unsupported[]` | `unsupported` |
| L3 | Plan erstellbar | `restow-agent baremetal plan --manifest - --target same --json` und `--target minimal` (Mindestgrößen), mit dem Agenten-Binary der eigenen Architektur im Worker-Image (`/usr/local/lib/restow/restow-agent`, aus dem Agent-Build kopiert; reiner Planer, ohne Rechte, Zeitlimit 30 s) | einem Problem des Planers |
| L4 | Manifest im Snapshot | `restic dump <snap> /var/lib/restow-agent/baremetal/layout.json`, SHA-256 gleich `endpoint_layouts.sha256` | Abweichung oder fehlender Datei (mit `isBackupFinding`-Beleg) |
| L5 | Vollständigkeit | Snapshot-`paths` enthalten jeden Einhängepunkt aus `backup.sources`; `restic ls <snap> <einhängepunkt>` je Quelle nicht leer; kein Einhängepunkt eines Systemdateisystems (`/`, `/boot`, ESP, `/usr`, `/var`) durch einen Ausschluss getroffen | fehlender Quelle, leerer Systemquelle |
| L6 | Startkette im Snapshot | über `restic dump` (je Datei höchstens 1 MiB, höchstens 50 Dateien): `/etc/fstab` (jeder Eintrag ohne `noauto`/`nofail` löst sich gegen das Manifest auf, über `UUID=`, `LABEL=`, `PARTUUID=`, `PARTLABEL=` oder Gerätenamen), `/etc/crypttab`, `mdadm.conf`, GRUB-Konfiguration bzw. BLS- und Loader-Einträge (Kernel- und initramfs-Pfade vorhanden); über `restic ls`: Kernel und initramfs aus `kernels` mit gleicher Größe, Loader-Datei jedes aktiven `Boot####`-Eintrags auf der ESP, initramfs-Erzeuger (`update-initramfs`, `dracut`, `mkinitcpio`) und `grub-install`/`grub2-install`/`bootctl` im Snapshot | einem nicht auflösbaren `fstab`-Eintrag, fehlendem Kernel, Loader oder Erzeuger |
| L7 | Konsistenz | `consistency` des Laufs | nie rot; `/` live gelesen ist eine Warnung |

Ergebnis als Bericht `endpoint_reports` der neuen Art `baremetal_check`
(grün/rot/unvollständig wie der Restore-Test: Ein Lesefehler, der nichts über die Sicherung
beweist, macht die Prüfung unvollständig, sie wird wiederholt). Zum Bericht gehören die
Fingerabdrücke (12.4).

### 12.2 Warum das Binary des Agenten auf dem Server

Der Planer ist die eine Stelle, die entscheidet, ob ein Layout umsetzbar ist. Ihn in
TypeScript nachzubauen hieße, zwei Planer gleich zu halten. Das Agenten-Binary liegt ohnehin
im Image (`/srv/agent/<v>/linux-<arch>/`); der Worker bekommt eine Kopie des Binarys seiner
Architektur. Eingabe ist das (vom Server schon geprüfte, höchstens 512 KiB große) Manifest,
Ausgabe JSON; das Binary ruft kein Werkzeug auf und läuft als Benutzer des Workers.

### 12.3 Stufe 2: Startprobe im Labor

Die Startprobe beweist, was Stufe 1 nur folgert: dass aus diesem Snapshot mit diesem ISO ein
startendes System wird.

- **Labor:** eigener Dienst `recovery-lab` (Compose-Profil `recovery-lab` in
  `docker-compose.yml`, Image `restow-recovery-lab` = Worker-Image mit Debians
  `qemu-system-x86`, `qemu-utils`, `ovmf`, `seabios`), mit `/dev/kvm` durchgereicht. Er
  verarbeitet nur die Queue `endpoint-boot-probe` (`apps/worker/src/endpoints/boot-probe.ts`,
  Einstieg `apps/worker/src/lab.ts`). Ohne Labor gibt es keine Startprobe, und Bare Metal
  kann nicht grün werden (Offene Frage 2). Ohne `/dev/kvm` (nur TCG) läuft die Probe mit
  zehnfacher Zeitgrenze und der Hinweis steht am Bericht.
- **ISO:** dieselbe Version wie die Instanz, aus `RESTOW_RECOVERY_ISO_DIR` oder vom
  GitHub-Release geladen, SHA-256 gegen das signierte `SHA256SUMS` des Images geprüft
  (8.5). Ein ungeprüftes ISO startet das Labor nicht.
- **Zugang:** Das Labor legt eine Zeile in `endpoint_recoveries` an (Art `probe`, kein Code,
  Audit `endpoint.boot_probe.started`), damit die Sperre gegen Prune (9.5) greift, und öffnet
  im eigenen Prozess einen Loopback-Listener nur für diese Probe wie der Wartungszugang
  (`packages/core/src/endpoints/loopback.ts`; der Prinzipal wird dafür ein Parameter, heute
  fest `maintenance`), hier mit dem Prinzipal `reader`. Die VM erreicht ihn über QEMUs
  Benutzernetz (`guestfwd`) unter einer festen Adresse. Statt des Codes stehen Repository-URL,
  Zugangsdaten des Listeners, Passwort, Snapshot und `layoutSha256` in den Antworten
  (`probe`); `http://` ist nur in diesem Modus und nur zu dieser Adresse erlaubt.
  Fortschritt und Ergebnis liest das Labor von der seriellen Konsole (`recover` schreibt im
  Probemodus jede Phase und die Prüfung als Zeilen `RESTOW-PROBE <json>`), die Recovery-API
  wird nicht gebraucht.
- **Ablauf:** Zielplatten als dünne `qcow2` in `RESTOW_LAB_DIR` mit der Größe der
  Quellplatten (Plattenanzahl und Sektorgröße wie gesichert); Firmware wie gesichert (OVMF
  mit Microsoft-Schlüsseln und Secure Boot, wenn die Quelle Secure Boot hatte, sonst OVMF ohne,
  bzw. SeaBIOS). ISO mit `--answers` über `fw_cfg` (Passphrase der Probe zufällig, Code
  entfällt, `probe: { fullRestore: [...], emptyFilesystems: [...] }`). Wiederhergestellt werden
  vollständig: `/`, `/boot`, ESP, `/usr`, `/var` (wenn eigene Dateisysteme); alle übrigen
  Dateisysteme werden mit ihrer Identität **leer** angelegt (sie hängen sich ein, das System
  startet, die Daten beweisen Restore-Test und Prüfung). Ist die volle Menge größer als
  `RESTOW_LAB_MAX_RESTORE_GIB` (Standard 64), ist die Probe "nicht möglich (zu groß)" und
  bewertet nichts.
- **Start der wiederhergestellten Platten:** zweite QEMU-Maschine nur mit den Zielplatten, gleiche
  Firmware, Netz aus. Damit das Ergebnis lesbar ist, ändert `recover` im Probemodus auf der
  Wegwerfkopie genau zwei Dinge: Es hängt `console=tty0 console=ttyS0,115200` an die
  Kommandozeile der Loader-Einträge an und legt eine systemd-Unit
  `restow-probe.service` an (`WantedBy=multi-user.target`, schreibt
  `RESTOW-PROBE-OK <boot-id> <kernel>` nach `/dev/ttyS0` und schaltet aus). Die Passphrase der
  Probe gibt das Labor an der seriellen Eingabeaufforderung ein (`Please enter passphrase`,
  `Enter passphrase for`). Erfolg: die Zeile `RESTOW-PROBE-OK` innerhalb von 10 Minuten
  (KVM). Belege: Protokoll von `recover`, serielle Ausgabe, bei Misserfolg ein Bild des
  VGA-Schirms (`screendump`, als PNG am Bericht).
- **Wann:** sofort, wenn sich `layoutFingerprint` oder `bootChainFingerprint` gegenüber der
  letzten bestandenen Probe ändern; sonst wöchentlich für den neuesten Bare-Metal-Snapshot;
  auf Anforderung (`POST /api/v1/endpoints/:id/baremetal/probe`). Höchstens eine Probe
  gleichzeitig je Labor (`RESTOW_LAB_CONCURRENCY`, Standard 1). Zeitgrenze insgesamt
  2 Stunden.
- **Bewertung:** Bericht `boot_probe`: grün mit der Zeile `RESTOW-PROBE-OK`; rot nur mit
  Beleg (der Plan scheiterte an einem Problem der Sicherung, `recover`-Prüfung `failed`,
  Kernel-Panik, initramfs findet die Wurzel nicht, Notfallmodus von systemd, alles erkannt an
  festen Mustern der seriellen Ausgabe); alles andere (Labor-Fehler, Zeitgrenze ohne
  Muster, ISO nicht ladbar) unvollständig, wiederholt.
- Nicht-systemd-Systeme: keine Probe ("nicht möglich").

### 12.4 Fingerabdrücke und Bewertung

- `layoutFingerprint`: SHA-256 über die kanonische Struktur des Manifests ohne
  veränderliche Werte (`capturedAt`, `usedBytes`, `inodesUsed`, Seriennummern,
  `network`, Agent-Version): Platten (Anzahl, Tabellenart, Partitionen mit Typ, Größe,
  PARTUUID), md, LUKS (ohne PBKDF-Messwerte), LVM, Dateisysteme (Typ, UUID, Funktionen),
  Einhängepunkte, Firmwaremodus, Bootloader-Art, initramfs-Erzeuger.
- `bootChainFingerprint`: aus Stufe 1 (L6): SHA-256 über die Liste (Pfad, Größe,
  Änderungszeit) von Kernel, initramfs, Loader-Dateien, GRUB-Konfiguration, BLS- und
  Loader-Einträgen und die SHA-256 von `fstab`, `crypttab`, `mdadm.conf`,
  `/etc/default/grub`, `/etc/kernel/cmdline`.
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
Zustand auf `layout_checked`, bis die sofort geplante Probe läuft.

### 12.5 Alarme

Neue Ereignisse (Gruppe Wiederherstellbarkeit, gleiche Regeln und Ausgänge wie die übrigen,
docs/AGENT.md "Alarme"): `baremetal.red` (Fehler, je Episode einmal), `baremetal.recovered`,
`baremetal.overdue` (Warnung), `endpoint.recovery.failed` (eine Wiederherstellung mit
`failed`). Webhook `job.failed` mit `queue: endpoint_baremetal_check` bzw.
`endpoint_boot_probe` für rote Berichte (nicht für unvollständige).

## 13. macOS: Mac neu aufsetzen

### 13.1 Grundsatz

Entscheidung: macOS neu installieren, dann Daten und Einstellungen aus der
APFS-Snapshot-Sicherung zurückholen. Kein ISO, kein Systemabbild (das versiegelte
Systemvolume lässt sich ohnehin nur von Apple installieren).

### 13.2 Sicherung

- `wholeMachine` unter macOS sichert vom APFS-Snapshot (Abschnitt 7): `/Users`,
  `/Applications`, `/Library` (ohne `Caches`, `Logs`, `Updates`), `/usr/local`,
  `/opt/homebrew`, `/private/etc`, dazu das Manifest. `/Library` und `/private/etc` werden
  in 0.5.0 nicht zurückgespielt, aber gesichert, damit eine spätere Version es kann und von
  Hand nichts fehlt.
- Manifest `restow-layout-v1` mit `os.kind: "darwin"`: macOS-Version und Build
  (`sw_vers`), Modell und Architektur (`sysctl hw.model`, `uname -m`), Benutzer
  (`dscl . -list /Users UniqueID`, UID ab 501, mit `RealName`, `NFSHomeDirectory`,
  `UserShell`, Admin ja/nein, `dscl . -read /Users/<n> AuthenticationAuthority` nur auf
  "SecureToken vorhanden" ausgewertet), FileVault an/aus (`fdesetup status`), Programme in
  `/Applications` (Name, Bundle-ID, Version, ob App-Store), Größe der Benutzerordner. Kein
  Plattenlayout (nicht gebraucht).

### 13.3 Ablauf

1. Mac neu installieren (macOS-Wiederherstellung). Version gleich oder neuer als im
   Manifest (älter: Abbruch mit Hinweis). Im Setup-Assistenten: Migrationsassistent
   überspringen, einen **Hilfsadministrator** anlegen (Vorschlag: "Restow Setup",
   Kurzname `restowsetup`), **keinen** Benutzer mit einem Kurznamen aus der Sicherung.
2. In der Oberfläche: Rechnerseite des alten Macs > "Mac neu aufsetzen" > Wiederanbindungs-
   Token (Abschnitt 11) und Installationsbefehl. Auf dem Mac installieren; Festplattenvollzugriff
   für `restow-agent` erteilen (der Assistent zeigt den Weg und prüft ihn über den Heartbeat).
3. Für jeden zurückzuholenden Benutzer legt der Administrator auf dem Mac in
   Systemeinstellungen > Benutzer & Gruppen ein Konto mit **demselben Kurznamen** an (neues
   Passwort) und meldet sich damit nicht an. Der Assistent listet die Benutzer aus dem
   Manifest und zeigt per Heartbeat, welche Konten es schon gibt (`dataFolders`-artig, neues
   Feld `macUsers` im Heartbeat: Kurzname, UID, angemeldet ja/nein).
4. "Daten zurückholen": Aufgabe `restore` mit `params.mode = "darwin_migration"`,
   `users: [kurznamen]`, `applications: true|false` (`RestoreParams` in
   `agent/internal/api/types.go` und `apps/api/src/features/endpoints/schemas.ts`). Der
   Agent (`agent/internal/core/migrate_darwin.go`):
   - lehnt ab, wenn ein Benutzer angemeldet ist (`stat -f%Su /dev/console`, `who`) oder sein
     Konto fehlt;
   - verschiebt den frischen Ordner `/Users/<n>` nach `/Users/.restow-fresh-<n>-<zeit>`
     (nichts wird gelöscht oder überschrieben, die Regel der Restores bleibt);
   - stellt `/Users/<n>` her mit `restic restore <id>:/private/var/run/restow-agent/apfs
     --include /Users/<n> --target / --ownership-by-name --sparse --verify --overwrite never`
     (Besitzer nach Name, weil die UIDs auf dem neuen Mac andere sein können);
   - Programme: `/Applications/<x>.app` nur für Programme, die es dort noch nicht gibt
     (`--overwrite never`), App-Store-Programme nicht (sie hängen an der Apple-ID und kommen
     über den App Store);
   - meldet je Benutzer Dateien, Bytes, Fehler.
5. Benutzer melden sich an. Hinweise im Abschluss: Anmeldeschlüsselbund fragt nach dem alten
   Passwort ("Schlüsselbundpasswort aktualisieren"); der Data-Protection-Schlüsselbund und
   iCloud-Schlüsselbund-Daten sind an die alte Hardware gebunden und kommen über iCloud
   wieder; iCloud-Drive-Dateien, die nur online lagen, wurden nicht gesichert
   (`--exclude-cloud-files`) und laden neu; Programme mit Lizenz an die Hardware wollen neu
   aktiviert werden; TCC-Freigaben (Kamera, Bedienungshilfen) fragen neu. Danach kann der
   Hilfsadministrator gelöscht werden.

### 13.4 Grenzen (macOS, 0.5.0)

Kein Zurückspielen von `/Library`, Systemeinstellungen, Netzwerk, Druckern, Launch-Daemons
anderer Hersteller; keine Konten, Passwörter, SecureTokens oder FileVault-Wiederherstellungs-
schlüssel; keine Wiederherstellung auf ein älteres macOS. Vorschau bis zum Freigabetest auf
einem Apple-Silicon- und einem Intel-Mac (Abschnitt 21.4).

## 14. Server-Änderungen

### 14.1 `packages/core`

- `endpoints/baremetal/manifest.ts` (neu): `layoutManifestSchema` (Zod), `parseLayoutManifest`,
  `canonicalLayoutJson`, `layoutSha256`, Grenzen (512 KiB, Listenlängen).
- `endpoints/baremetal/fingerprint.ts`: `layoutFingerprint`, `bootChainFingerprint`.
- `endpoints/baremetal/summary.ts`: `summarizeLayout` (für die Oberfläche: Platten mit
  Größe und Inhalt, Stapel als Baum, Firmware, Bootloader, Distribution, Verschlüsselung).
- `endpoints/baremetal/check.ts`: reine Bewertung der Stufe 1 aus den gesammelten Fakten
  (`judgeLayoutCheck`), `fstab`/`crypttab`-Zerleger (`parseFstab`, `parseCrypttab`),
  Auflösung gegen das Manifest (`resolveFstabSource`).
- `endpoints/baremetal/probe.ts`: Muster der seriellen Ausgabe, `judgeBootProbe`.
- `endpoints/baremetal/readiness.ts`: `baremetalReadiness` (12.4).
- `endpoints/baremetal/recovery-code.ts`: 9.1.
- `endpoints/whole-machine.ts`: `DEFAULT_WHOLE_MACHINE_EXCLUDES`, `wholeMachineConfigWire`.
- `endpoints/config.ts`: `EndpointConfig.wholeMachine?`, `fsSnapshot?`; `GET /config`-Draht.
- `endpoints/run-errors.ts`: `layout_capture_failed`, `layout_too_large`, `layout_rejected`.
- `endpoints/run-failures.ts`, `failures/types.ts`, `failures/catalog.ts`: Codes
  `endpoint.layout_capture_failed`, `endpoint.baremetal_check_failed`,
  `endpoint.boot_probe_failed`, `endpoint.recovery_failed`; Schritte
  `check_endpoint_layout_tools`, `read_baremetal_report`, `run_boot_probe_again`.
- `endpoints/run-redact.ts`: Muster `RC-…`.
- `endpoints/queues.ts`: `endpoint-baremetal-check`, `endpoint-boot-probe`.
- `endpoints/restore-target.ts`: `restoreSelectionIssue` (5.4).
- `endpoints/pathmap.ts` (neu): `snapshotRootOf`, `toViewPath`, `fromViewPath` (Abschnitt 7).

### 14.2 `packages/db`: Migration 0074

`packages/db/drizzle/0074_baremetal.sql` (und `meta/_journal.json`), Schema in
`packages/db/src/schema/endpoints.ts`:

```sql
ALTER TYPE "public"."endpoint_report_kind" ADD VALUE 'baremetal_check';--> statement-breakpoint
ALTER TYPE "public"."endpoint_report_kind" ADD VALUE 'boot_probe';--> statement-breakpoint
CREATE TYPE "public"."endpoint_recovery_status" AS ENUM
  ('issued', 'active', 'finishing', 'succeeded', 'failed', 'cancelled', 'expired', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."endpoint_recovery_kind" AS ENUM ('code', 'probe');--> statement-breakpoint
CREATE TABLE "endpoint_layouts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "endpoint_id" uuid NOT NULL REFERENCES "endpoints"("id") ON DELETE CASCADE,
  "sha256" text NOT NULL,
  "format" text NOT NULL,
  "schema_version" integer NOT NULL,
  "manifest" jsonb NOT NULL,
  "summary" jsonb NOT NULL,
  "verdict" text NOT NULL,
  "layout_fingerprint" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE UNIQUE INDEX "endpoint_layouts_endpoint_sha_uq" ON "endpoint_layouts" ("endpoint_id", "sha256");--> statement-breakpoint
ALTER TABLE "endpoint_runs" ADD COLUMN "layout_id" uuid REFERENCES "endpoint_layouts"("id") ON DELETE SET NULL;--> statement-breakpoint
CREATE TABLE "endpoint_recoveries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "endpoint_id" uuid NOT NULL REFERENCES "endpoints"("id") ON DELETE CASCADE,
  "kind" "endpoint_recovery_kind" NOT NULL,
  "status" "endpoint_recovery_status" NOT NULL DEFAULT 'issued',
  "code_hash" text,                       -- nur bei kind = code
  "snapshot_id" text,
  "issued_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz NOT NULL,
  "created_by" text REFERENCES "user"("id") ON DELETE SET NULL,
  "revoked_at" timestamptz, "revoked_by" text REFERENCES "user"("id") ON DELETE SET NULL,
  "used_at" timestamptz, "used_ip" text,
  "session_secret_hash" text,
  "recovery_version" text,
  "hardware" jsonb,
  "progress" jsonb,
  "verification" jsonb,
  "warnings" jsonb,
  "log_bytes" integer NOT NULL DEFAULT 0,
  "cancel_requested_at" timestamptz,
  "finished_at" timestamptz,
  "updated_at" timestamptz NOT NULL DEFAULT now()
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
ALTER TABLE "endpoint_enrollment_tokens" ADD COLUMN "endpoint_id" uuid REFERENCES "endpoints"("id") ON DELETE CASCADE;
```

- Row Level Security für `endpoint_layouts`, `endpoint_recoveries`, `endpoint_recovery_log`
  wie für die übrigen Mandantentabellen (`packages/db/sql/rls.sql`, Liste bei
  `endpoint_downloads`). Der Code-Tausch läuft vor dem Festlegen eines Mandanten und sucht
  über `code_hash` mit der Installationsrolle (wie die Agent-Anmeldung, `agent-auth.ts`),
  danach alles in der Mandanten-Transaktion.
- `ADD VALUE` steht vorn und ohne Verwendung in derselben Migration (wie 0056).
- Aufbewahrung: `endpoint_recovery_log` 90 Tage (Monitor), Layouts solange ein Lauf auf sie
  zeigt oder sie das neueste des Rechners sind (Monitor räumt täglich).
- `endpoint_runs.layout_id` statt einer eigenen Snapshot-Tabelle: Snapshot-ID und Lauf
  gehören schon zusammen (`endpoint_runs.snapshot_id`).
- Neue Spalte `endpoint_enrollment_tokens.endpoint_id`: `NULL` = Enrollment wie bisher,
  gesetzt = Wiederanbindung (Abschnitt 11). `GET /api/v1/endpoints/tokens` zeigt die Art.

### 14.3 `apps/api`

Neue Dateien in `apps/api/src/features/endpoints/`:

| Datei | Inhalt |
| --- | --- |
| `baremetal.ts` | `getBaremetalState` (Karte der Rechnerseite), `getLayout`, `requestBootProbe` |
| `recovery-codes.ts` | `issueRecoveryCode`, `revokeRecoveryCode`, `extendRecoveryCode`, `listRecoveries`, `getRecovery`, `cancelRecovery` |
| `recovery-routes.ts` | `/agent/v1/recovery/*` (eigene Anmeldung über Sitzung, vor `agentRoutes` gemountet, damit dessen Agent-Anmeldung nicht greift) |
| `recovery-service.ts` | Tausch, Fortschritt, Log, `release`, Abschluss, Sperren gegen Prune |
| `recovery-restic-route.ts` | `/agent/recovery/restic/:sessionId/*` über `buildRunResticRoute`, `reader` |
| `rebind.ts` | `createRebindToken`, `rotateEndpointSecret`, Zweig in `enroll` |
| `recovery-iso.ts` | `GET /api/v1/recovery-iso`, `GET /install/recovery/:version/:file` |

Routen der Session-API (in `routes.ts`, Kommentar-Tabelle oben ergänzen):

| Aufruf | Rolle | Zweck |
| --- | --- | --- |
| `GET /api/v1/endpoints/:id/baremetal` | restorer | Zustand, Zusammenfassung des neuesten Layouts, Bewertung, Prüfberichte, Bare-Metal-Snapshots |
| `GET /api/v1/endpoints/:id/baremetal/layouts/:layoutId` | admin | volles Manifest (Seriennummern) |
| `POST /api/v1/endpoints/:id/baremetal/probe` | admin | Startprobe anfordern (202) |
| `POST /api/v1/endpoints/:id/recovery-codes` | admin, frische Anmeldung | Code ausstellen |
| `POST /api/v1/endpoints/:id/recovery-codes/:codeId/revoke` | admin | widerrufen |
| `POST /api/v1/endpoints/:id/recovery-codes/:codeId/extend` | admin, frische Anmeldung | verlängern |
| `GET /api/v1/endpoints/:id/recoveries` | admin | Liste (Codes, Sitzungen, Proben) |
| `GET /api/v1/endpoints/:id/recoveries/:recoveryId` | admin | Zustand, Fortschritt, Prüfung, Log (seitenweise) |
| `POST /api/v1/endpoints/:id/recoveries/:recoveryId/cancel` | admin | Sitzung beenden |
| `POST /api/v1/endpoints/:id/rebind-token` | admin, frische Anmeldung | Wiederanbindungs-Token |
| `GET /api/v1/recovery-iso` | admin | ISO: Version, URL, SHA-256, Prüfbefehle |

Weitere Änderungen: `schemas.ts` (Abschluss mit `layout` bis 512 KiB, Job-Einstellung
`wholeMachine`, `fsSnapshot` am Rechner, Restore-Modus `darwin_migration`); `agent-service.ts`
(`finishRun` speichert Layout und plant Stufe 1; `agentConfig` liefert `wholeMachine` und
`fsSnapshot`; `enroll` mit Wiederanbindung; Heartbeat `macUsers`); `audit.ts`
(`ENDPOINT_AUDIT_ACTIONS` um `recoveryCodeCreated`, `recoveryCodeRevoked`,
`recoveryCodeExtended`, `recoveryStarted`, `recoveryReleased`, `recoveryFinished`,
`recoveryExpired`, `recoveryCancelled`, `bootProbeStarted`, `rebindTokenCreated`,
`rebound`); `problems.ts` (`recovery-code-invalid`, `recovery-code-expired`,
`recovery-code-revoked`, `recovery-code-used`, `recovery-too-old`,
`recovery-session-ended`, `baremetal-not-available`, `recovery-limit-reached`,
`endpoint-recovery-active`); `removal.ts` (409 bei aktiver Sitzung); `app.ts` (Mounts:
`recoveryRoutes` unter `/agent/v1/recovery` vor `agentRoutes`, `recoveryResticRoutes` unter
`/agent/recovery/restic`); `rate-limits.ts` (`RECOVERY_RESTIC_LIMIT`); Caddy braucht
nichts (`/agent/*` geht schon an die API); `scripts/ci/check-edge-headers.mjs` um die neuen
Pfade ergänzen, falls er Pfadlisten führt.

### 14.4 `apps/worker` und `apps/scheduler`

- `endpoints/baremetal-check.ts` (Stufe 1), `endpoints/boot-probe.ts` (Stufe 2, nur im
  Labor registriert), `endpoints/lab/qemu.ts` (QEMU-Aufrufe: Platten, Firmware, `fw_cfg`,
  serielle Konsole als Datei und Socket, `screendump`, Zeitgrenzen), `lab.ts` (Einstieg).
- `endpoints/retention.ts`, `endpoints/removal.ts`: Sperre bei aktiver Sitzung (9.5).
- `endpoints/monitor.ts`: Ablauf von Codes und Sitzungen, Alarme 12.5, Aufräumen der Logs.
- `endpoints/register.ts`: neue Queues; `boot-probe` nur, wenn `RESTOW_WORKER_ROLE=lab`.
- `apps/scheduler/src/endpoints.ts`: Stufe 1 nachholen (Layout ohne Bericht), Startprobe
  wöchentlich bzw. bei geänderten Fingerabdrücken, Singleton je Rechner und Art.

### 14.5 Image, Compose

- `Dockerfile`: Worker-Image bekommt `/usr/local/lib/restow/restow-agent` (eigene
  Architektur, aus der Agent-Stufe); neue Stufe `recovery-lab` (Worker + Debian-Pakete
  `qemu-system-x86`, `qemu-utils`, `ovmf`, `seabios`). Das ist das siebte Image
  (`release.yml` "tags all six images", cosign, Smoke `scripts/smoke/images.json`).
- `docker-compose.yml`: Dienst `recovery-lab` im Profil `recovery-lab`, `devices:
  ["/dev/kvm:/dev/kvm"]`, Volume `recovery-lab` für `RESTOW_LAB_DIR` und das ISO,
  `RESTOW_LAB_MAX_RESTORE_GIB`, `RESTOW_LAB_CONCURRENCY`. Der Installer
  (`deploy/`) fragt, ob das Labor eingerichtet werden soll, wenn `/dev/kvm` existiert.
- docs/SIZING.md: Platz und RAM für das Labor (eine Probe: RAM 2 GiB für das ISO plus
  Plattenbedarf der vollständig wiederhergestellten Dateisysteme, dünn).

### 14.6 `apps/web`: Oberfläche

- **Job-Editor** (`apps/web/src/features/backup-jobs/`, Endpunkt-Jobs): Schalter "Ganzer
  Rechner (Bare Metal, Vorschau)". Text darunter: "Sichert alle lokalen Dateisysteme samt
  Plattenlayout, damit sich Linux-Rechner auf neuer Hardware wiederherstellen lassen.
  macOS: Daten und Einstellungen für einen neu installierten Mac. Windows-Rechner sichern
  weiter ihre Ordner." Eingeschaltet: Ordnerliste ausgegraut ("Alle lokalen
  Dateisysteme"), Ausschlüsse auf `DEFAULT_WHOLE_MACHINE_EXCLUDES` gesetzt (mit "Vorherige
  Ausschlüsse wiederherstellen"), Hinweise je Mitglied (Container, Windows, Agent zu alt,
  arm64 "Wiederherstellung kommt später").
- **Rechnerseite** (`endpoint-detail-page.tsx`, neue Karte
  `components/baremetal-card.tsx`): Linux "Bare-Metal-Wiederherstellung", macOS "Mac neu
  aufsetzen". Inhalt: Bewertung (12.4) als Abzeichen mit Erklärung, letzte Stufe 1 und
  Startprobe (Datum, Snapshot, Ergebnis, Beleg aufklappbar, VGA-Bild bei Misserfolg),
  Layout-Zusammenfassung (`components/layout-summary.tsx`: Platten als Balken mit
  Partitionen, darunter der Stapel als Baum, Firmware, Bootloader, Distribution,
  Verschlüsselung, nicht unterstützte Teile rot mit Grund), Mindestgrößen je Platte.
  Knöpfe "Wiederherstellen…" (Assistent), "Recovery-ISO", "Startprobe jetzt". Laufende
  Wiederherstellung: Fortschritt oben auf der Seite und in der Rechnerliste ("Wird
  wiederhergestellt").
- **Assistent "Bare-Metal-Wiederherstellung"** (`components/baremetal-wizard.tsx`, Route
  `/inventory/<id>/bare-metal`):
  1. *Sicherungsstand:* Liste der Bare-Metal-Snapshots mit Datum, Prüfstand je Stufe,
     Layout gleich/anders als der neueste; Vorauswahl der neueste grüne, sonst der neueste.
  2. *Ersatzhardware:* was sie braucht (Firmwaremodus, Secure Boot, Anzahl und Mindestgröße
     der Platten, RAM, Netz per Kabel), was sich ändern darf und was nicht (Abschnitt 2.2),
     Hinweis auf verschlüsselte Volumes ("Sie vergeben beim Wiederherstellen eine
     Passphrase") und TPM.
  3. *Recovery-ISO:* Version, Download, SHA-256, Prüfbefehle (Linux/macOS:
     `verify-agent-signature.sh` und `sha256sum -c`; Windows: `Get-FileHash`), Schreiben
     auf USB (dd, Rufus im DD-Modus), Fingerabdruck des Release-Schlüssels.
  4. *Wiederherstellungscode:* Dialog `components/recovery-code-dialog.tsx`: Gültigkeit
     (Auswahl 1, 2, 4, 8, 12, 24, 48 Stunden; Vorschlag aus der Datenmenge bei angenommenen
     50 MB/s, mindestens 4), frische Anmeldung, dann **einmalig** Code (große Schrift,
     Gruppen), Adresse der Instanz, Ablaufzeit, "Kopieren", "Drucken" (eine Seite mit Code,
     Adresse, Rechnername, Ablauf, ohne weitere Daten); Hinweis "Der Code gibt Lesezugriff auf
     alle Sicherungen dieses Rechners, bis er abläuft oder eingelöst und beendet ist".
     Optional "Wiederanbindungs-Token mit ausstellen" (Abschnitt 11, eigener Hinweis).
  5. *Live:* "Warte auf das ISO" -> verbunden (Adresse, ISO-Version, gefundene Hardware) ->
     Phasen mit Fortschritt, Bytes, Dateien, Restzeit -> Prüfung (Liste 10.14) -> fertig
     oder fehlgeschlagen (mit Log). Knöpfe "Code widerrufen", "Verlängern", "Abbrechen".
  6. *Danach:* "Rechner wieder anbinden" (falls nicht im ISO geschehen) und Hinweise aus dem
     Abschluss (TPM, MOK, Netzwerknamen).
- **Rechner-Einstellungen** (`settings-tab.tsx`): "Dateisystem-Snapshot (LVM, btrfs, APFS)"
  `auto`/`off` für Linux und macOS.
- **Lauf-Details** (`run-sheet.tsx`): "Konsistenz" zeigt LVM/btrfs/APFS wie VSS heute;
  "Layout erfasst" mit Link zur Karte.
- **Recovery Readiness** (`GET /api/v1/verify/latest`): Spalte "Bare Metal" für Rechner mit
  `wholeMachine`, eigene Zählung, nicht mit der Datei-Bewertung vermischt.
- **Restore-Dialog** (`restore-dialog.tsx`): `state.json` ausgeblendet (5.4); macOS-Modus
  "Daten zurückholen" mit Benutzerauswahl (13.3).
- `presenters.ts`, `api.ts`: neue Typen und Fehlercodes.

### 14.7 i18n

`packages/i18n/resources/{de,en}/endpoints.json`: `baremetal.*` (Karte, Bewertung, Assistent,
Hardware-Anforderungen), `recovery.*` (Code-Dialog, Live-Ansicht, Phasen, Prüfungen),
`rebind.*`, `runErrors.layout_*`, Job-Editor-Texte, macOS-Texte.
`…/failures.json`: die neuen Codes und Schritte. `recover` selbst hat seine Texte in Go
(`agent/internal/recovery/text_de.go`, `text_en.go`), weil das ISO ohne die i18n-Dateien
läuft; ein Test verlangt für jeden Schlüssel beide Sprachen.

## 15. Agent: weitere Änderungen

- `internal/api/types.go`: `Config.WholeMachine`, `Config.FSSnapshot`, `FinishRequest.Layout
  json.RawMessage`, `RestoreParams.Mode/Users/Applications`, `HeartbeatRequest.MacUsers`,
  Typen der Recovery-API.
- `internal/paths`: `Layout.BaremetalDir()`, Konstanten `RecoveryTargetRoot =
  "/mnt/restow-target"`, `APFSMountPoint = "/private/var/run/restow-agent/apfs"`,
  `SnapTreeDir = "/run/restow-agent/snaptree"`.
- `internal/core/backup.go`: Zweig Ganzer Rechner (5.6), Ausschluss von `state.json` (5.4),
  Snapshot-Zweig für LVM/btrfs/APFS (6.4).
- `internal/core/sample.go`: Hash aus dem Snapshot-Baum (5.6).
- `internal/core/activity.go`, `verify.go`, `restore.go`: Pfadabbildung macOS (7).
- `internal/restic/backup.go`, `restore.go`, `runner.go`: Optionen aus 5.5 und 10.10, `Exec`.
- `internal/redact`: Code-Muster.
- `internal/sysinfo`: `macUsers` (darwin).
- `cmd/restow-agent/main.go`: Hilfetext um `recover` (nur Linux) und `baremetal`.
- `agent/README.md`, "Known limits": neu formuliert (Abschnitt 17).

## 16. Sicherheit

- **Code:** 122 Bit, einmal einlösbar, höchstens 48 Stunden, nur als Hash gespeichert,
  Fehlversuche je Adresse begrenzt, geschwärzt in Logs. Wer den Code hat, liest alle
  Sicherungen dieses einen Rechners (nicht anderer, nicht des Mandanten), bis Ablauf oder
  Ende; er kann nichts schreiben oder löschen. Ausstellen nur durch Mandanten-Admins mit
  frischer Anmeldung, auditiert; Widerruf jederzeit.
- **Sitzungsgeheimnis** entsteht im ISO, nur der Hash geht zum Server.
- **Repository-Passwort** im ISO nur im Speicher und in restics Umgebung, nie auf Platte;
  der Zugang endet vor dem ersten Programm aus der Sicherung (10.11).
- **Manifest von einem möglicherweise kompromittierten Rechner:** Es kann die
  Wiederherstellung nicht über die bestätigten Zielplatten hinaus lenken (Löschen nur nach
  Eingabe der Seriennummern), alle Werte laufen als Argumente ohne Shell und werden vorher
  geprüft (Namen gegen Muster, Größen gegen die Zielplatte), Dateizugriffe im Ziel bleiben
  im Ziel (`openat2`/`RESOLVE_IN_ROOT`). Auf dem Server läuft der Planer ohne Rechte und
  mit Grenzen. Wer den Rechner kompromittiert hat, kompromittiert ohnehin das
  wiederhergestellte System; das ist dieselbe Grenze wie bei jeder Sicherung.
- **ISO:** signiert über `agent-SHA256SUMS`, reproduzierbar, Secure Boot über Debians
  Kette; ohne Root-Passwort, SSH nur auf ausdrücklichen Wunsch mit Einmalpasswort.
- **Labor:** QEMU ohne Netz für den Start der wiederhergestellten Platten; beim Restore nur
  das Benutzernetz zum Loopback-Listener; Plattendateien werden nach der Probe gelöscht.
- **Wiederanbindung:** eigenes Token, eigene Berechtigung, macht den alten Agenten
  unbrauchbar.

## 17. Dokumentation

- docs/AGENT.md: Grundsätze (Satz "Keine Images, kein Bare-Metal-Restore" ersetzen:
  "Dateibasierte Sicherung mit restic; Linux-Rechner lassen sich als Ganzes auf neuer
  Hardware wiederherstellen (Vorschau, docs/BAREMETAL.md), keine Plattenabbilder"),
  Tabelle `/agent/v1` (`GET /config` mit `wholeMachine`, `fsSnapshot`; Abschluss mit
  `layout`; Recovery-API), neuer Abschnitt "Ganzer Rechner und Wiederherstellung",
  Fehlercodes, Alarme, Datenmodell (Migration 0074), Sicherheitsmodell, Tests.
- agent/README.md (Englisch): "Whole machine", "Recovery ISO", "Known limits".
- docs/WINDOWS-AGENT.md 2.2 und 21: Verweis hierher.
- docs/GLOSSARY.md: Bare Metal, Layout-Manifest, Recovery-ISO, Wiederherstellungscode,
  Startprobe, Wiederanbindung.
- docs/SIZING.md (Labor), docs/CI.md (Jobs `recovery-iso`, `recovery-e2e`), README.md
  (Funktionsliste), `integrations/recovery/README.md`.
- Dieses Dokument wird nach der Umsetzung um "Stand der Umsetzung" ergänzt und später
  gekürzt.

## 18. CHANGELOG-Plan

Einträge unter `[Unreleased]` (Englisch, wie der CHANGELOG), je Meilenstein beim Merge:

- **M1, Added:** "Whole machine backups (preview, Linux): a backup job switch backs up every
  local file system with its disk layout. The agent records the layout (partition tables,
  RAID, LUKS metadata, LVM, file systems and their features, mounts, firmware, boot loader,
  initramfs generator) as a layout manifest inside the snapshot and reports it; backups run
  with `--one-file-system` and `--group-by host`." / "File system snapshots on Linux: LVM
  (thick and thin) and btrfs snapshots under the policy 'When the file system snapshot
  fails'; snapshot paths stay the real paths. Thin pools above 80 % get no snapshot, and a
  backup stops its snapshot before a pool runs full." **Changed:** "The agent no longer backs
  up its own state file (`/etc/restow-agent/state.json`) with the agent secret and the
  repository password; the restore dialog hides it in older snapshots."
- **M2, Added:** "Layout check after every whole machine backup: the server validates the
  layout, plans the restore with the agent's own planner, and checks that the snapshot holds
  the layout, every mounted file system and the boot chain (kernels, initramfs, boot loader,
  fstab and crypttab entries)." Migration 0074.
- **M3, Added:** "Recovery codes: a one-time code for one machine, valid 4 hours (up to 48),
  audited, read-only access to that machine's backups for a bare-metal restore." / "Rebind a
  restored machine: a token that gives an existing machine a new agent secret and keeps its
  backups and history." **Security:** Repository pruning waits while a recovery runs.
- **M4, Added:** "Recovery ISO (preview): a signed, reproducible Debian 13 live image
  (`restow-recovery_<v>_amd64.iso`, GPL-3.0-or-later build recipe in `integrations/recovery`)
  that boots with UEFI Secure Boot and legacy BIOS and restores a Linux machine from Restow
  onto new disks: GPT and MBR, mdadm, LVM including thin, LUKS, ext4, XFS, btrfs, separate
  /boot and EFI system partition, smaller and larger disks; initramfs and boot loader are set
  up again. Firmware packages: …" (Liste aus 8.4) / CI: "Recovery end-to-end tests in QEMU/KVM".
- **M5, Added:** "Boot probe: a restore of the newest whole machine backup into a virtual
  machine on the server (optional `recovery-lab` service with KVM) proves that it boots; bare
  metal is green only then." Alarme.
- **M6, Added:** "macOS: backups from an APFS snapshot; 'Set up a Mac again': reinstall macOS,
  rebind, restore user folders and apps."
- **Known limits** (bei M4): Windows bare metal later; no change of the storage stack; no
  Wi-Fi or VLAN in the ISO; TPM2/FIDO2 bindings must be enrolled again; amd64 only.

## 19. Dateien, die sich ändern

Agent (`agent/`):

- neu `internal/baremetal/` (`manifest.go`, `assess.go`, `fingerprint.go`, `efi.go`,
  `capture.go`, `capture_linux.go`, `capture_darwin.go`, `tools.go`, `plan.go`, `sizing.go`,
  `mapping.go`, `mkfs.go`, `fixups.go`, `cmdline.go`, Tests, `testdata/`)
- neu `internal/fssnap/` (`fssnap.go`, `lvm_linux.go`, `btrfs_linux.go`, `nsexec_linux.go`,
  `apfs_darwin.go`, `cleanup_linux.go`, `cleanup_darwin.go`, Tests)
- neu `internal/recovery/` (Abschnitt 10.1)
- `internal/core/backup.go`, `sample.go`, `activity.go`, `verify.go`, `restore.go`,
  `snapshot.go` (Texte je Verfahren), neu `snapshot_linux.go`, `snapshot_darwin.go`,
  `snapshot_other.go` (nur noch für andere Unix-Systeme), neu `wholemachine.go`,
  `pathmap.go`, `migrate_darwin.go`, Tests
- `internal/restic/backup.go`, `restore.go`, `runner.go`, `restic_test.go`
- `internal/api/types.go`, `internal/paths/paths.go`, `internal/redact/`,
  `internal/sysinfo/` (darwin)
- `cmd/restow-agent/main.go`, neu `recover.go`, `baremetal.go`, `snapshotexec.go`
- `README.md`

Separates Werk: neu `integrations/recovery/` (8.1).

Server und Web: wie in 14.1 bis 14.7, dazu `packages/db/drizzle/0074_baremetal.sql`,
`packages/db/drizzle/meta/_journal.json`, `packages/db/sql/rls.sql`,
`packages/db/src/schema/endpoints.ts`, `packages/db/src/schema/backup-jobs.ts`,
`packages/core/src/backup-jobs/endpoint-config.ts`, `deploy/demo/seed/` (ein Demorechner mit
Layout und grüner Startprobe für Bildschirmfotos).

Build, CI, Lizenzen, Doku: `.github/workflows/ci.yml` (`recovery-iso`, `recovery-e2e`,
`passed`), `.github/workflows/release.yml` (`recovery-iso`, `agent-sums`, `publish`, siebtes
Image), neu `.github/workflows/recovery-nightly.yml` (volle Matrix), `Dockerfile`,
`docker-compose.yml`, `scripts/ci/license-policy.json`, `scripts/ci/check-separate-works.mjs`
und Test, `scripts/ci/check-release.mjs` (ISO-Zeile), neu `scripts/recovery-e2e/`
(`run.mjs`, Fälle), `scripts/smoke/images.json`, `NOTICE`, `THIRD_PARTY_NOTICES.md`,
Dokumente aus Abschnitt 17, `CHANGELOG.md`.

## 20. Risiken

| Risiko | Wirkung | Gegenmaßnahme |
| --- | --- | --- |
| `mkfs` im ISO erzeugt Funktionen, die das Zielsystem nicht kennt | System startet nicht oder hängt Dateisysteme nicht ein | Funktionen nur aus dem Manifest (10.9), Rücklesen, Startprobe |
| Snapshot füllt Thin-Pool | Produktionsausfall | Schwellen 80/90 Prozent, Überwachung, Abbruch (6.2) |
| Dicker Snapshot läuft über | Lesefehler, `partial` | Überwachung, Rückfall live (6.2) |
| initramfs ohne Treiber der neuen Hardware | Start bleibt im initramfs hängen | `--no-hostonly`, `MODULES=most`, Prüfung 10.14 Punkt 5 |
| NVRAM-Einträge gehen verloren | Rechner findet keinen Bootloader | Rückfallpfad `\EFI\BOOT\BOOTX64.EFI` (10.12) |
| Gerätenamen in Konfigurationen | Start hängt beim Einhängen | Fixups (10.11), L6 in Stufe 1 |
| Netzwerkkarte ohne Treiber/Firmware im ISO | keine Wiederherstellung möglich | Firmwareliste (8.4), Anzeige fehlender Treiber, Maintainer-Matrix; Ersatz: USB-Netzwerkadapter (`r8152`, `ax88179_178a`, `cdc_ether` sind frei) |
| Prune während der Wiederherstellung | fehlende Packs, Abbruch | Sperre 9.5 |
| Langsame Leitung, großer Rechner | Code läuft ab | Verlängern, Fortsetzen mit neuem Code (10.15) |
| live-build nicht bitgleich | Signatur ohne Nachbau-Beweis | CI-Doppelbau, Diffoscope; M4 erst fertig, wenn bitgleich |
| Secure-Boot-Firmware mit veralteter DBX/SBAT | shim wird abgelehnt | aktueller Debian-Stand je Release; Hinweis "Secure Boot vorübergehend aus" |
| Labor nicht verfügbar | nie grün | Zustand `layout_checked` klar benannt, Offene Frage 2 |
| Startprobe-Eingriff (Konsole, Unit) verfälscht | Probe grün, echter Start nicht | Eingriff nur Kommandozeilen-Zusatz und eine Unit; echte Hardware im Freigabetest |
| QEMU-Hardware weicht von echter ab | Treiber-, Firmware-Effekte unentdeckt | Maintainer-Checkliste 21.4 |
| APFS-Snapshot wird bei Platzmangel gelöscht | Lesefehler | [Maschine] prüfen; Lesefehler -> `snapshot_failed` |
| Große Repositories, wenig RAM im Ersatzrechner | restic bricht ab | Schätzung aus `indexBytes`, Warnung |
| Zeit falsch im Ersatzrechner | TLS scheitert | NTP, `Date`-Abgleich, manuelles Setzen (10.3) |
| Tastaturbelegung | Code nicht eingebbar | Belegung im Startmenü und in `recover`, Alphabet ohne Y/Z |
| Umfang | Termin 0.5.0 | Meilensteine einzeln auslieferbar; Rückfall: M5/M6 nach 0.5.x (Abschnitt 22) |

## 21. Testplan

### 21.1 Unit-Tests (jedes System, Job `agent` und `test`)

Go, ohne Build-Tag, Tabellentests:

- Erfassung gegen aufgezeichnete Ausgaben (`testdata/capture/<system>/`): mindestens Debian
  12 UEFI LUKS+LVM, Ubuntu 24.04 Standard, Ubuntu mit ZFS (muss `unsupported` ergeben),
  Alma 9 XFS+LVM, Fedora btrfs, openSUSE btrfs+Snapper, Arch systemd-boot, BIOS+MBR+mdadm
  RAID1, RAID5 mit Ersatzplatte, LVM thin, 4Kn-NVMe, Mehrgeräte-btrfs RAID1, LUKS1 mit
  verschlüsseltem `/boot`, LUKS2 mit TPM2-Token, Swap-Datei auf btrfs, Container (kein
  Stapel). Die Aufzeichnungen nimmt `restow-agent baremetal capture --raw-dir` auf echten
  Maschinen und VMs auf (Abschnitt 21.4 Punkt 1).
- `efi.go`: Zerlegen und Bauen von `EFI_LOAD_OPTION` mit echten efivars-Bytes.
- Planer: jede Testdatei gegen "gleiche Hardware", "größer", "kleiner", "eine Platte
  weniger" (RAID degradiert), "zu klein" (Problem), "BIOS vs. UEFI" (Problem), 4Kn-Ziel;
  erwartete Pläne als Golden Files.
- `mkfs.go`: Argumente je Typ und Funktionsliste; Ablehnung unbekannter Funktionen.
- `fixups.go`: `fstab`, `crypttab`, `mdadm.conf`, Kommandozeilen, BLS-Einträge mit
  Kommentaren, Tabs, Fortsetzungen, `subvolid`, Gerätenamen aller Arten; unveränderte
  Dateien bleiben bytegleich.
- Fingerabdruck: gleiche Werte in Go und TS (4.2).
- Code-Normalisierung (Testvektoren, gleich in TS).
- `consistencyOf` mit LVM/btrfs/APFS-Ausgängen; Politik `continue`/`fail` mit dem falschen
  restic und falschen Werkzeugen (`harness_test.go`).
- Pfadabbildung macOS.
- `recovery/ui.go` mit Skript auf stdin (Bestätigung, Abbruch, Fortsetzen).

TypeScript (Vitest): Schema, Zusammenfassung, Stufe-1-Bewertung mit gesammelten Fakten,
`fstab`-Zerleger, Probe-Muster, `baremetalReadiness` (jede Zeile der Tabelle 12.4),
Code-Erzeugung (Gleichverteilung grob, Alphabet), Pfadabbildung.

### 21.2 Integration in der CI

- **Job `agent-root`** (neu, Ubuntu-Runner mit `sudo`): Loop-Geräte mit LVM (dick, thin),
  btrfs, ext4, XFS; echte Snapshots mit `internal/fssnap`, Helfer mit Namensraum und
  `chroot`, restic gegen `rest-server`, Pfade im Snapshot gleich den echten, keine
  Einhängung bleibt nach `kill -9` des Agenten, Aufräumen übrig gebliebener Snapshots,
  Thin-Pool-Schwelle (Pool absichtlich füllen), Erfassung `baremetal.Capture` auf diesen
  Geräten; dazu der Planer und die Ausführungsschritte bis einschließlich Restore auf
  Loop-Geräte (ohne Bootloader).
- **Server (Postgres-Tests):** Code ausstellen, eintauschen (idempotent, zweiter Hash 409,
  abgelaufen, widerrufen, Fehlversuche je Adresse), restic-Route `reader` (jede Schreib- und
  Löschoperation 403, Ende 401), Sperre gegen Retention in beiden Reihenfolgen, Entfernen
  409, Layout im Abschluss (gültig, ungültig, zu groß, dedupliziert), Stufe 1 gegen ein
  echtes Repository mit `rest-server`, Wiederanbindung (Secret gewechselt, altes 401,
  Repository gleich), Audit-Einträge, RLS.
- **Job `recovery-iso`** (8.3).
- **Job `recovery-e2e`** [CI] (Ubuntu-Runner mit `/dev/kvm`; die Runner von GitHub stellen
  KVM bereit, Rechte über eine udev-Regel im Job): Treiber `scripts/recovery-e2e/run.mjs`
  startet eine Testinstanz (wie `scripts/smoke`), baut die Quellmaschine, sichert, löscht
  die Platten, startet das ISO in QEMU mit `--answers` über `fw_cfg`, wartet auf den Abschluss
  über die API, startet die wiederhergestellten Platten und erwartet auf der seriellen
  Konsole `E2E-BOOT <hostname> <sha256 der Markerdatei>` (eine Unit, die die Quellmaschine
  beim Bau bekam). Er nutzt dieselbe QEMU-Schicht wie das Labor
  (`apps/worker/src/endpoints/lab/qemu.ts`), testet sie also mit. Fälle:

| Fall | Quelle | Ziel | Bei |
| --- | --- | --- | --- |
| E1 | Debian 12, BIOS, MBR, mdadm RAID1 aus zwei Platten, ext4 `/` und `/boot`, Swap-Partition, initramfs-tools | eine Platte, größer (RAID1 degradiert) | jedem PR mit Änderungen an `agent/internal/{baremetal,recovery,fssnap}`, `integrations/recovery`, Recovery-API |
| E2 | Ubuntu 24.04, UEFI mit Secure Boot (OVMF mit Microsoft-Schlüsseln), GPT, ESP, `/boot`, LUKS2 + LVM (`root`, `swap`, `home`), shim | NVMe statt virtio, kleiner | jedem solchen PR |
| E3 | AlmaLinux 9, UEFI, LVM, XFS, dracut `hostonly`, SELinux `enforcing`, BLS | SATA (AHCI) statt virtio | nachts |
| E4 | Fedora (aktuell), UEFI, btrfs mit Subvolumes `root`, `home`, zram | größer | nachts |
| E5 | openSUSE Leap 15.6, btrfs mit Snapper-Subvolumes, GRUB2 | gleich | nachts |
| E6 | Debian 13, UEFI ohne Secure Boot, LVM thin, systemd-boot (selbst eingerichtet) | 4Kn-Platte | nachts |
| E7 | Debian 12, LUKS1 mit verschlüsseltem `/boot` (GRUB entsperrt), BIOS + GPT + BIOS-Boot-Partition | gleich | nachts |
| E8 | Abbruch mitten im Restore und Fortsetzen; zweiter Code nach "Stromausfall" (QEMU hart beendet) | – | nachts |

  Quellmaschinen: für E3 bis E5 die offiziellen Cloud-Images (SHA-256 gepinnt) mit
  cloud-init (Agent installieren über `linux.sh` der Testinstanz, Marker-Unit); für E1, E2,
  E6, E7 baut die Testmaschinen-Fabrik (`integrations/recovery/test/machines/*.sh`) die
  Maschine in einer QEMU-VM, die vom ISO selbst gestartet wird (es hat alle Werkzeuge):
  partitionieren, verschlüsseln, `debootstrap` aus demselben snapshot.debian.org-Stand bzw.
  Ubuntus Archiv, Kernel, Bootloader, cloud-init. Dauer je Fall etwa 10 bis 20 Minuten mit
  KVM. Die volle Matrix läuft in `recovery-nightly.yml` und vor jedem Release (`release.yml`
  wartet darauf).
- **Startprobe** einmal in `recovery-e2e` (E2 zusätzlich über die Queue `endpoint-boot-probe`
  mit dem Labor-Container), damit Labor und Bewertung Ende zu Ende laufen.
- **macOS-Runner** (`agent`-Job auf `macos-14`): `tmutil localsnapshot` und `mount_apfs`
  versuchen; gelingt es auf dem gehosteten Runner nicht (Festplattenvollzugriff), meldet der
  Test einen Hinweis statt zu scheitern (wie VSS auf dem Windows-Runner). Pfadabbildung und
  Migrationslogik mit falschem restic.

### 21.3 Grenzen der CI

QEMU zeigt keine echte Firmware (NVRAM-Eigenheiten, CSM, Hersteller-Secure-Boot mit eigener
DB/DBX), keine echten Netzwerkkarten außer `e1000e`/`virtio`, keine Hardware-RAID-Controller,
keine USB-Sticks, keine BMC-Konsolen, keine 4Kn-Eigenheiten echter Platten, keine
Stromausfälle echter Platten. Ob die gehosteten Runner KVM in jedem Lauf bereitstellen, ist
zu beobachten; ohne KVM bricht `recovery-e2e` mit klarer Meldung ab (TCG wäre zu langsam).

### 21.4 Auf echter Hardware (Maintainer, vor dem Release)

Testsysteme (Vorschlag): ein Rack-Server mit UEFI und Secure Boot und Broadcom- oder
Intel-Netz (z. B. Dell PowerEdge mit PERC oder HPE ProLiant mit Smart Array), ein älterer
Server oder Arbeitsplatz mit Legacy-BIOS und zwei SATA-Platten, ein Laptop mit NVMe, UEFI,
Secure Boot und TPM2, ein Arbeitsplatz mit Realtek-Netz, ein Apple-Silicon-Mac und ein
Intel-Mac, ein Proxmox-VE-Host für VMs.

**Freigabe-Gate** (Pflicht vor dem Release): Punkte 1, 2, 3, 4, 5, 6, 8, 11, 12, 15, 18, 20,
22. Die übrigen folgen und gehen in 0.5.x ein.

1. Auf jedem System `restow-agent baremetal capture --raw-dir` ausführen, Ausgaben als
   Testdaten einchecken (geschwärzt: Seriennummern), Manifest gegen die Wirklichkeit
   prüfen (`lsblk`, `efibootmgr -v`).
2. Rack-Server, Debian 12, UEFI + Secure Boot, ext4 auf LVM auf Hardware-RAID: Ganz-Rechner-
   Sicherung, Stufe 1 grün; Wiederherstellung auf demselben Server mit neuen Platten; startet
   mit Secure Boot, Netz kommt hoch (gleiche MAC), Dienste laufen.
3. BIOS-Rechner, Ubuntu 22.04, mdadm RAID1 auf zwei SATA-Platten: Wiederherstellung auf
   **andere** Hardware mit einer NVMe (degradiertes RAID1); startet; `mdadm --add` der
   zweiten Platte danach.
4. Laptop, Ubuntu 24.04 mit LUKS2+LVM (Standard-Verschlüsselung des Installers), TPM2 per
   `systemd-cryptenroll` eingeschrieben: Wiederherstellung auf eine größere SSD; neue
   Passphrase; Start fragt nach ihr; TPM2 neu einschreiben nach Hinweis.
5. Alma/Rocky 9, UEFI, XFS auf LVM, SELinux `enforcing`: auf andere Hardware (AHCI nach
   NVMe); `/.autorelabel` läuft einmal; Anmeldung, Dienste, `ausearch` ohne neue AVCs.
6. Fedora mit btrfs-Subvolumes auf kleinere Platte; Snapper/Timeshift-Fall mit openSUSE
   (Snapper-Subvolumes leer, `snapper list` geht, GRUB-Menü ohne alte Snapshots).
7. Arch mit systemd-boot und ESP als `/boot`.
8. Getrenntes `/boot` (ext4) + ESP + LUKS-Wurzel, BIOS + GPT mit BIOS-Boot-Partition.
9. Mehrere Platten: System auf SSD, Daten auf mdadm RAID5 mit LVM thin; Thin-Pool während
   einer Sicherung auf 85 Prozent füllen: kein Snapshot bzw. Abbruch nach 6.2, Pool nie voll.
10. 4Kn-Platte als Ziel; MBR-System auf eine Platte über 2 TiB (Warnung, Rest frei).
11. Netz: DHCP, statisch, Proxy; NTP gesperrt mit falscher RTC (Uhrzeit von Hand);
    Netzwerkkarte ohne Firmware im ISO (Meldung verständlich), USB-Netzwerkadapter als
    Ersatz.
12. Konsole: serielle Konsole über IPMI SOL/iDRAC/iLO; SSH-Fernzugang; deutsche
    Tastaturbelegung beim Code.
13. Abbruch mitten im Restore und Fortsetzen; Strom aus mitten im Restore, neuer Code,
    Fortsetzen.
14. Code läuft während des Restores ab, Verlängern in der Oberfläche; danach neuer Code.
15. Firmwaremodus falsch (BIOS-Sicherung, ISO im UEFI gestartet): Meldung und Weg.
16. Netzwerkschnittstellen umbenennen auf neuer Hardware mit statischer Konfiguration.
17. Wiederanbindung im ISO und danach in der Oberfläche; der alte Rechner (noch an)
    verliert die Verbindung; nächste Sicherung nutzt den alten Snapshot als Eltern.
18. Startprobe im Labor (Server mit KVM) für die Systeme 2 bis 8: grün; Kernel-Update auf
    einem: Zustand `layout_checked`, Probe läuft, wieder grün.
19. Stufe 1 rot erzwingen: `/boot` per Job-Ausschluss weglassen; Beleg verständlich.
20. ISO: Schreiben mit `dd` und Rufus (DD-Modus), Start mit Secure Boot an und aus, CSM,
    über virtuelles Medium des BMC; Signatur mit `verify-agent-signature.sh` unter Linux und
    macOS prüfen; Nachbau des ISO aus dem Tag auf einem anderen Rechner ergibt dieselbe
    SHA-256.
21. LVM-Snapshot läuft während einer schreiblastigen Sicherung über: `snapshot_failed`,
    Politik `continue` und `fail`.
22. macOS: Sicherung vom APFS-Snapshot mit geöffneter Mail und Fotos-Mediathek; ohne
    Festplattenvollzugriff (`snapshot_unavailable`); Mac neu aufsetzen auf einem anderen
    Modell (Apple Silicon), Benutzer mit gleichem Kurznamen, Daten und Programme zurück,
    Anmeldung, Schlüsselbund-Frage.
23. macOS: Intel-Mac, FileVault an; Benutzer mit anderer UID als vorher
    (`--ownership-by-name`).
24. Wiederherstellung einer VM (PVE-Gast mit Agent) in eine neue VM mit anderer
    Plattengröße und anderem Controller (virtio-scsi statt SATA).

## 22. Reihenfolge und Meilensteine

Jeder Meilenstein ist für sich auslieferbar, mit eigenen Tests und eigenem CHANGELOG-Eintrag
(Abschnitt 18), und lässt die vorigen unverändert gelten.

- **M1: Ganz-Rechner-Sicherung.** `state.json`-Ausschluss für alle Sicherungen; `fssnap`
  (LVM, btrfs, Namensraum-Helfer, Aufräumen, Schutz); `consistency` unter Linux;
  `wholeMachine` im Job und in `GET /config`; Quellen, Ausschlüsse, `-x`, `--group-by host`,
  Tags; `baremetal.Capture` und Manifest im Snapshot und im Abschluss; Schema in Go und TS mit
  gemeinsamen Testdaten; Migration 0074 (Tabellen `endpoint_layouts`, Spalte
  `endpoint_runs.layout_id`; die übrigen Teile der Migration kommen mit, damit es eine
  Migration bleibt); Rechnerseite zeigt "Layout erfasst" und die Zusammenfassung. Tests:
  21.1 Erfassung, 21.2 `agent-root`. Wert für sich: konsistente Linux-Sicherungen.
- **M2: Planer und Stufe 1.** `baremetal.Plan`, `mkfs`, Größen, Zuordnung, Fixups (rein);
  `restow-agent baremetal plan`; Worker `baremetal-check`; Bewertung bis `layout_checked`;
  Karte mit Mindestgrößen und Prüfbericht. Tests: Golden Files, Stufe 1 gegen
  `rest-server`.
- **M3: Code, Sitzung, Wiederanbindung.** Codes, Tausch, Recovery-API, `reader`-Route,
  Sperre gegen Prune, Audit, Problemtypen; Code-Dialog und Live-Ansicht im Assistenten;
  Wiederanbindungs-Token und `enroll`-Zweig. Tests: Postgres-Suiten 21.2. Für sich nutzbar:
  Wiederanbindung (auch ohne Bare Metal, etwa nach einer Neuinstallation).
- **M4: ISO und `recover`.** `integrations/recovery` mit reproduzierbarem Bau, Firmware,
  Signatur im Release, Quellbündel; `recover` vollständig (10.2 bis 10.17);
  `recovery-e2e` E1/E2 je PR, E3 bis E8 nachts. Ab hier Linux Bare Metal (Vorschau)
  benutzbar.
- **M5: Startprobe und "Grün ist Beweis".** Labor-Image, Compose-Profil, `boot-probe`,
  Fingerabdrücke, Bewertung `green`/`overdue`/`red`, Alarme, Readiness-Spalte.
- **M6: macOS.** APFS-Snapshot (`fssnap/apfs_darwin.go`), Pfadabbildung, Manifest
  `darwin`, Heartbeat `macUsers`, Restore-Modus `darwin_migration`, Assistent "Mac neu
  aufsetzen".

Rutscht der Plan: M6 und M5 gehen nach 0.5.x; dann gilt für Linux höchstens
`layout_checked`, nie `green` (die Oberfläche sagt "Startprobe kommt mit 0.5.x"). M1 bis M4
sind der Kern von 0.5.0 für Linux. Das Freigabe-Gate (21.4) gilt für das, was ausgeliefert
wird.

## 23. Bekannte Grenzen (Zusammenfassung)

Für agent/README.md "Known limits" und docs/AGENT.md: Abschnitt 2.2 (Umfang), Speicherstapel
wird nicht umgebaut (Grundregel 1), TPM2/FIDO2/Clevis neu einrichten (10.8), LVM-VG- und
LV-UUIDs neu (10.8), btrfs-Subvolume-IDs neu (10.9), Dateiattribute (`chattr`) außer `+C`
nicht wiederhergestellt (1.2), LUKS auf LV live gesichert (6.6), Startprobe stellt
Datendateisysteme leer her (12.3), kein Labor ohne KVM-fähigen Server (12.3), macOS nur
Benutzerordner und Programme (13.4), Quellcode-Bündel als eigener Download (8.7), nur amd64.

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
8. **Grenze der Startprobe** `RESTOW_LAB_MAX_RESTORE_GIB` = 64 (Vorschlag).
9. **Eigene CA im ISO:** reicht Datei vom USB-Stick plus Bestätigung des Fingerabdrucks
   (Vorschlag), oder soll der Code-Dialog den SPKI-Fingerabdruck der Instanz anzeigen (die
   API kennt das Zertifikat hinter Caddy nicht ohne weiteres)?
10. **Lizenz des Werks** GPL-3.0-or-later (Vorschlag) oder GPL-2.0-or-later.

## 25. Entscheidungen

### 25.A Entscheidungen des Maintainers (endgültig)

1. **Umfang 0.5.0:** Linux Bare Metal vollständig (Kennzeichnung "Vorschau"); macOS als
   "macOS neu installieren, dann Daten und Einstellungen aus der APFS-Snapshot-Sicherung
   zurückholen"; **Windows Bare Metal später, nicht in 0.5.0.**
2. **Edition:** Community, ohne Lizenzprüfung.
3. **Linux-Wiederherstellung:** bootfähiges Recovery-ISO als eigenes GPL-Werk unter
   `integrations/recovery`, getrennt vom Kern wie `integrations/pve/plugin`, geprüft von
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

### 25.B Entscheidungen dieses Entwurfs (Vorschläge, siehe Offene Fragen)

1. **LUKS: nur Metadaten, keine Header-Sicherung** (die Frage "luksDump headers?" aus dem
   Auftrag): `luksDump` (Version, Cipher, PBKDF, UUID) ja, `luksHeaderBackup` nein. Eine
   Header-Sicherung enthält die verschlüsselten Keyslots; mit ihr und der alten Passphrase
   ließe sich eine weggeworfene alte Platte entschlüsseln. Für die Wiederherstellung wird sie
   nicht gebraucht, weil neue Volumes neue Hauptschlüssel bekommen und die Daten dateiweise
   zurückkommen.
2. **Identität bewahren** (UUIDs, PARTUUIDs, Labels, Namen, Funktionen) statt Konfigurationen
   umzuschreiben; Fixups nur für Gerätenamen und das, was sich nicht bewahren lässt (LVM-
   und Subvolume-IDs, Netzwerknamen).
3. **Kein Umbau des Stapels** in 0.5.0; weniger Platten nur als degradiertes RAID.
4. **LVM neu anlegen statt `vgcfgrestore`** (Thin-Pools, Größen).
5. **`mkfs` nur mit erfassten Funktionen**, Rücklesen danach.
6. **initramfs allgemein** (`--no-hostonly`, `MODULES=most`) für den ersten Start.
7. **UEFI ohne `grub-install`**, NVRAM-Einträge neu plus Rückfallpfad; BIOS mit
   `grub-install` je Platte.
8. **Linux-Snapshots im privaten Mount-Namensraum mit `chroot`**, damit Snapshot-Pfade den
   echten gleichen; macOS mit Präfix und Tag `restow-fsroot=apfs`.
9. **Manifest im Snapshot maßgeblich**, Kopie in der Datenbank, keine Klartextdatei im
   Speicherziel.
10. **Planer im Agenten, auch auf dem Server** (Stufe 1) statt eines zweiten Planers in
    TypeScript.
11. **Zeilenweise Bedienung** statt Vollbild-Oberfläche (kein Go-Modul, serielle Konsole,
    testbar).
12. **Repository-Zugang endet vor dem ersten Programm aus der Sicherung.**
13. **Debian 13 als ISO-Basis**, live-build, snapshot.debian.org, Signatur über
    `agent-SHA256SUMS`, ISO nicht im Image.
14. **Wiederherstellungscode** mit 30-Zeichen-Alphabet ohne Y/Z und Sitzungsgeheimnis aus dem
    ISO (nur Hash zum Server, idempotentes Eintauschen).
15. **Kein Prune und kein Entfernen** während einer aktiven Sitzung.
16. **Grün nur mit Startprobe** für dieselben Fingerabdrücke.
17. **macOS-Wiederherstellung in Konten, die der Administrator anlegt**, frische Ordner werden
    beiseitegelegt, nichts überschrieben, Besitzer nach Name.
18. **Lizenz GPL-3.0-or-later** für `integrations/recovery`.

## 26. Stand der Umsetzung

Noch nichts umgesetzt. Dieses Dokument ist der Entwurf für M1 bis M6.

## 27. Nur auf echter Hardware zu prüfen

Gesammelt aus den Markierungen; nichts davon lässt sich in dieser Umgebung oder in QEMU
abschließend klären. Ergebnisse gehen in dieses Dokument und in die Testdaten.

1. Ausgaben von `lsblk -J -O`, `sfdisk --json`, `lvm fullreport`, `cryptsetup luksDump
   --dump-json-metadata`, `btrfs inspect-internal dump-super`, `xfs_info`, efivars auf
   echten Systemen aller Distributionen aus 2.1 (Feldnamen und Formate je Version).
2. NVRAM: ob die Firmware der Testserver neue `Boot####`-Einträge annimmt, behält und in
   `BootOrder` respektiert; ob sie ohne Eintrag `\EFI\BOOT\BOOTX64.EFI` startet.
3. Secure Boot auf Herstellerfirmware mit aktueller DBX/SBAT: startet das ISO (shim aus
   trixie), startet das wiederhergestellte System.
4. CSM/Legacy-Start des ISO von USB auf Servern und Arbeitsplätzen.
5. Treiber und Firmware: jede Netzwerkkarte der Testsysteme kommt im ISO hoch (auch Intel
   E810 mit DDP, Broadcom bnx2x, Realtek RTL8125).
6. Hardware-RAID-Controller (PERC, Smart Array) im ISO und im wiederhergestellten System
   (Treiber im allgemeinen initramfs).
7. Dauer und Belastung eines mdadm-Resyncs während des Restores auf HDDs.
8. Argon2-Parameter auf schwacher Hardware (Laptop mit 8 GiB) und Start mit der Passphrase.
9. Verhalten von `dracut --no-hostonly` und `update-initramfs` mit `MODULES=most` auf RHEL 8/9
   und Ubuntu 22.04/24.04 im `chroot` (Warnungen, Größe, Startzeit).
10. SELinux-Relabel nach `/.autorelabel` auf großen Systemen (Dauer, zweiter Neustart).
11. Serielle Konsole über IPMI SOL/iDRAC/iLO: Lesbarkeit der zeilenweisen Bedienung,
    Passphrase-Eingabe.
12. Tastaturbelegungen `de`, `ch`, `fr` beim Code und bei der Passphrase (Sonderzeichen).
13. LVM-Snapshots auf ausgelasteten Produktionssystemen: Leistungseinbruch, COW-Größen,
    Überwachung im 30-Sekunden-Takt reicht.
14. Thin-Pool-Schwellen im Zusammenspiel mit `thin_pool_autoextend_threshold`.
15. btrfs-Snapshots bei sehr vielen Subvolumes (Docker mit btrfs-Treiber).
16. APFS: `tmutil localsnapshot` ohne Time Machine, Verhalten bei Platzmangel, Einhängen mit
    `mount_apfs -s` unter macOS 13, 14, 15, 26, Festplattenvollzugriff des Dienstes.
17. macOS: Wiederherstellung in ein frisch angelegtes, nie angemeldetes Konto; TCC-Schutz
    beim Schreiben in `~/Library` als root mit Festplattenvollzugriff; Schlüsselbund-Frage
    bei der ersten Anmeldung.
18. Nachbau des ISO auf einem zweiten Rechner (anderer Docker-Host) bitgleich.
19. Startprobe-Muster gegen echte Fehlerausgaben (Notfallmodus, `dracut-initqueue`-Timeout,
    `ALERT! UUID=... does not exist`).
20. Zeitbedarf einer Wiederherstellung über 1-GbE- und 10-GbE-Netz und über einen Proxy;
    Grundlage für den Vorschlag der Gültigkeit im Code-Dialog.
