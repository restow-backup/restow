# Bare-Metal-Wiederherstellung auf einen frischen Rechner ohne ISO (Entwurf für 0.5.1)

Dieses Dokument beschreibt, wie Restow einen Linux-Rechner aus einer Ganz-Rechner-Sicherung auf
einen **frisch angelegten Rechner ohne Startmedium** zurückholt: Viele Server lassen sich nicht
von einem ISO starten (virtuelle Server mit geteilten vCPUs bei Hetzner Cloud, Instanzen bei
AWS EC2 und vergleichbare Angebote). Der Admin legt einen neuen Rechner an, meldet sich als root
an und fügt **einen Befehl** aus der Oberfläche ein. Der Befehl prüft den Rechner, lädt die
Recovery-Umgebung, lässt sich in der Oberfläche bestätigen, startet die Recovery-Umgebung im
Arbeitsspeicher (`kexec`) und stellt dort die gewählte Sicherung auf genau diesen Rechner her,
mit demselben Ablauf wie das Recovery-ISO. Es ergänzt docs/BAREMETAL.md (Bare Metal unter
Linux, im Folgenden **BM**) und ändert nichts an dessen Entscheidungen; Begriffe wie Plan,
Übernahme, Recovery-Sitzung, Stufe 1 und Prüfzahl haben die Bedeutung aus BM Abschnitt 3.

Stand der Code-Verweise: Zweig `wip/051-oneshot` auf `release/0.5.0`, Commit `9db647fa`.
Markierungen wie in BM: **[Maschine]** ist nur auf echten Rechnern bei echten Anbietern zu
klären (gesammelt in Abschnitt 19.4), **[CI]** nur in der CI mit KVM. **[Spike]** heißt: in der
Machbarkeitsprobe dieses Entwurfs gemessen bzw. beobachtet (Abschnitt 4).

Die Grundentscheidungen hat der Maintainer getroffen (Abschnitt 23.A). Dieses Dokument legt
fest, wie. Die offenen Fragen des Entwurfs hat der Maintainer entschieden (Abschnitt 22). Die
Grundregeln aus BM gelten unverändert: **Identität bewahren statt umbauen, erst prüfen, dann
zerstören, nichts löschen, was nicht gelöscht werden muss, grün ist Beweis.** Dazu kommen für
diesen Weg zwei eigene:

1. **Der Link allein öffnet nichts.** Der Befehl trägt nur einen kurzlebigen Einmalcode; das
   Repository-Passwort bekommt erst die Recovery-Umgebung, nachdem ein Admin in der Oberfläche
   bestätigt hat, dass genau dieser Rechner (Adresse, Platten, Prüfzahl) das Ziel ist.
2. **Nichts geschieht mit dem Rechner, bevor er bestätigt ist.** Bis zur Bestätigung liest der
   Befehl nur und schreibt nur in `/run`. Wird er versehentlich auf einem laufenden
   Produktionsserver eingefügt, warnt er, und ohne Bestätigung an der Konsole **und** in der
   Oberfläche passiert nichts.

Harte Randbedingungen aus BM gelten weiter: Der Go-Agent nutzt kein fremdes Go-Modul,
Linux-Systemaufrufe nur über `syscall` (Rohaufrufe mit Nummer, wo eine Konstante fehlt),
Werkzeuge als eigener Prozess mit Argumentliste; das Recovery-ISO bleibt ein eigenes GPL-Werk
ohne Geheimnisse und ohne Instanzbezug, mit **einer** Signatur je Release; nur ausgehende
Verbindungen; Community-Edition ohne Lizenzprüfung, kein Code unter `ee/`.

## 0. Kurzfassung

- **Umfang:** Linux amd64 als Quelle und als Ziel, Ziel ein Rechner, der von seiner eigenen
  Platte ein gewöhnliches Linux mit systemd gestartet hat (frisches Abbild des Anbieters) oder
  das Rettungssystem des Anbieters. **Windows nicht** (es gibt kein Windows Bare Metal,
  BM 2.2), macOS nicht, arm64 nicht (kein arm64-ISO, BM Offene Frage 6).
- **Bedienung:** Restore › Bare Metal › "Auf einen frischen Rechner (Link)". Restow stellt einen
  **Einmalcode** aus, 30 Minuten einlösbar, und zeigt den Befehl für eine root-Shell (`sudo -i`
  vorher)
  `curl -fsSL 'https://<instanz>/install/oneshot.sh' | RESTOW_ONESHOT_CODE='OS-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX' sh`.
  Kein Schlüssel, kein Token für etwas anderes, kein Code in einer URL oder auf einer
  Kommandozeile.
- **Vor dem Umschalten** (`restow-agent oneshot`, signiert geladen wie beim Installer `linux.sh`):
  root, Architektur, Arbeitsspeicher, kexec möglich (echte Probeladung, nicht geraten), Secure
  Boot und Lockdown, Firmwaremodus, Platten, Netz (Adressen v4/v6, Präfixe, Gateways auch
  "on-link" wie `172.31.1.1` und `fe80::1`, DNS, MTU, DHCP oder statisch), cloud-init und
  Anbieter; Eintausch des Codes gegen eine Recovery-Sitzung (`pending_approval`), Anzeige von
  Prüfzahl und Hardware. Bestätigung an der SSH-Konsole (Platten, `LÖSCHEN`/`ERASE`) und danach
  in der Oberfläche (Freigabe mit Prüfzahl, Adresse, Platten, Vorplan des Servers).
- **Recovery-Umgebung im RAM:** Kernel und initrd **aus dem signierten ISO des Release**, dazu
  ein angehängtes, unkomprimiertes cpio-Archiv mit dem `filesystem.squashfs` aus demselben ISO
  und den Sitzungsdaten. Geladen mit `kexec_file_load` aus einem `memfd` (nichts Geheimes auf
  der Platte), gestartet über `systemctl kexec`. **[Spike]** Das ISO-initrd startet so ohne
  Medium (live-boot `live-media=/restow/medium`), die Daten kommen in `/run` an, `recover`
  startet: 556 MiB belegt nach dem Start, 364,5 MiB initrd.
- **Wiederherstellung:** der bestehende Ablauf von `recover` (BM 10) mit neuer Antwortquelle
  `oneshot`: Sitzung schon eingetauscht, Entscheidungen aus der Oberfläche, Löschbestätigung
  von der SSH-Konsole, Ausgabe auf allen Konsolen des Rechners, Neustart nach Erfolg.
- **Netz:** gleicher Anbieter: öffentliche Adresse umziehen und die alte Konfiguration behalten;
  sonst Vorgabe **"Netz des Zielrechners übernehmen"**: was auf dem frischen Rechner
  funktionierte, wird im Format des wiederhergestellten Systems geschrieben (netplan, ifupdown,
  NetworkManager, systemd-networkd), DHCP, wo das Ziel DHCP nutzte, Zuordnung über Art bzw.
  Namensmuster statt alter MAC; die alte Konfiguration bleibt unverändert unter
  `/etc/restow/network-before-restore/`. cloud-init darf im wiederhergestellten System nur noch
  das Netz einrichten.
- **Alte Adresse:** Suche in `/etc` und üblichen Dienstkonfigurationen; Liste mit Datei und Zeile
  in der Oberfläche; Ersetzen nur nach Bestätigung je Datei. Checkliste für außerhalb des
  Rechners (DNS mit TTL, PTR, SPF, Freigabelisten, Lizenzen, Firewall des Anbieters).
- **Anbieterwechsel:** initramfs wird ohnehin für die Zielhardware neu gebaut (BM 10.15);
  fehlender Netzwerktreiber wird hier zum Problem statt Warnung; Firmwaremodus des Ziels wird
  erkannt; neu: UEFI-Sicherung auf BIOS-Ziel für hybride Abbilder (BIOS-Boot-Partition und ESP).
- **Rückfall:** kexec unmöglich (Secure Boot mit Lockdown, `kexec_load_disabled`): Rettungssystem
  des Anbieters starten und denselben Befehl dort einfügen. Anbieter ohne Rettungssystem (AWS):
  in 0.5.1 nicht unterstützt, Weg über ein Hilfssystem als Ausblick.
- **Schema:** eine Migration `0105_recovery_oneshot` (neuer Wert `oneshot` der Art, eine
  `jsonb`-Spalte); Begründung in Abschnitt 7.
- **Meilensteine:** 0.5.1 = O1 bis O5 mit UEFI → BIOS und knapper Oberfläche, 0.5.2 = Suche nach
  der alten Adresse, Vorplan, Feinschliff, echte Anbieter; zusammen rund 59 Personentage
  (Abschnitt 20).

## 1. Ausgangslage

### 1.1 Was es gibt (0.5.0)

- **Recovery-ISO** `restow-recovery_<v>_amd64.iso` (BM 8): Debian 13 Live, gebaut mit
  live-build, signiert über `agent-SHA256SUMS` (`scripts/release/sign-agent.sh`, Namensraum
  `restow-agent-release`, Ed25519), reproduzierbar, ohne Geheimnisse. Die Instanz lädt das ISO
  ihres Release selbst, prüft die SSHSIG-Signatur von `SHA256SUMS` mit dem Release-Schlüssel des
  Images (`packages/core/src/release/sshsig.ts`) und liefert es aus: angemeldet über
  `GET /api/v1/recovery-iso/file/:file`, öffentlich über `GET /install/recovery/:version/:file`
  (Ratenbegrenzung 10 je Stunde und Adresse; BM 26.13).
- **Installer** `GET /install/linux.sh` (`apps/api/src/features/endpoints/install-routes.ts`,
  Vorlage `agent/install/linux.sh`): je Anfrage mit Instanz-URL, Version und Release-Schlüssel
  gefüllt, lädt `restow-agent` und `restic`, prüft die Signatur über `SHA256SUMS`
  (`ssh-keygen -Y verify`, sonst OpenSSL) und die SHA-256 der Programme, bevor etwas läuft.
  Das ist der heutige `curl | sh`-Vertrauensanker.
- **Wiederherstellungscode und Sitzung** (BM 9, `apps/api/src/features/endpoints/recovery-*.ts`,
  Tabelle `endpoint_recoveries`, Migrationen 0102 bis 0104): Code an die Origin gebunden
  (`codeProof`), einmal einlösbar; Sitzungsgeheimnis entsteht beim Client, nur der Hash geht
  zum Server; Freigabe mit sechsstelliger Prüfzahl; Zugangsdaten (`reader`) erst nach der
  Freigabe; Fortschritt, Log, Ereignisse, `release`, `finish`; Zustände aus BM 9.9.
- **`restow-agent recover`** (`agent/internal/recovery`, Planer und Fixups in
  `agent/internal/baremetal`): Netz, TLS, Code, Freigabe, Plan, Bestätigung, Ausführung,
  initramfs und Bootloader im isolierten `chroot`, Prüfung, Bericht, Neustart; unbeaufsichtigt
  mit `--answers` aus Quellen, die ausdrücklich gewählt sind (Medium `RESTOWANS`, `fw_cfg` nur
  in QEMU, Datei von Hand; BM 10.20). Exit-Code 4 (`ExitSessionEnded`, `exitcode.go`) verhindert,
  dass `restow-recover.service` (`Restart=on-failure`, `RestartPreventExitStatus=4`) einen
  verbrauchten Code endlos neu versucht.

### 1.2 Was fehlt

Ein Rechner ohne ISO-Start hat heute keinen Weg: Das ISO muss als Medium starten. Die
Bausteine sind fast alle da (signiertes ISO bei der Instanz, Sitzung mit Freigabe, `recover`
mit unbeaufsichtigtem Modus). Es fehlen: ein Weg vom laufenden Rechner in die
Recovery-Umgebung, ein Eintausch vor dem Umschalten, Entscheidungen aus der Oberfläche statt von
der Konsole, und alles, was ein **anderes Netz** am Ziel mit sich bringt (BM 10.16 passt nur MAC
und Namen an; Adressen, Gateways und DNS behandelt 0.5.0 nicht, und das Manifest erfasst sie
nicht).

## 2. Umfang

| Bereich | 0.5.1 | Anmerkung |
| --- | --- | --- |
| Ziel: frischer Rechner mit Linux (systemd), amd64, als root | ja | Abbild des Anbieters; das Betriebssystem des Ziels ist egal, es wird gelöscht |
| Ziel im Rettungssystem des Anbieters | ja | derselbe Befehl, Abschnitt 17 |
| Ziel ohne kexec und ohne Rettungssystem (AWS mit Secure Boot und Lockdown) | nein | Ausblick Hilfssystem, Abschnitt 17.3 |
| Firmware des Ziels gleich der Sicherung (BIOS/BIOS, UEFI/UEFI) | ja | wie BM 10.5 |
| BIOS-Sicherung auf UEFI-Ziel | wie BM | nur hybrides GPT (BIOS-Boot-Partition und ESP) |
| UEFI-Sicherung auf BIOS-Ziel | **neu** (O7) | nur hybrides GPT mit BIOS-Boot-Partition und GRUB für `i386-pc` in der Sicherung |
| Secure Boot am Ziel an | nur, wenn die Probeladung gelingt | Abschnitt 16 |
| Netz am Ziel: DHCP, statisch, /32 mit On-link-Gateway, IPv6 statisch mit `fe80::1` | ja | Abschnitt 10 |
| VLAN, Bonding, WLAN, mehrere Routing-Tabellen am Ziel | nein | wie BM 2.2; der Befehl nennt es und bricht ab |
| Xen-PV und ältere Xen-HVM-Instanzen | nein | kexec dort unzuverlässig; **[Maschine]** |
| Windows, macOS | nein | Windows Bare Metal gibt es nicht (BM 2.2) |
| arm64 | nein | kein arm64-ISO |

Alles aus BM 2.1 (Speicherstapel, Dateisysteme, Bootloader, initramfs-Erzeuger) gilt unverändert,
denn die Wiederherstellung selbst ist dieselbe.

## 3. Ablauf

```
Admin (Browser)         Restow-Instanz                     frischer Rechner (root, SSH)
1 "Auf einen frischen
  Rechner (Link)"  ---> Code OS-…, 30 min, Befehl
                                                           2 curl …/oneshot.sh | RESTOW_ONESHOT_CODE=OS-… sh
                        GET /install/oneshot.sh <--------    lädt restow-agent, prüft Signatur
                                                             restow-agent oneshot:
                                                               Prüfungen, Hardware, Netz, cloud-init
                        POST /agent/v1/recovery/oneshot <--    codeProof, Hash des Sitzungsgeheimnisses,
                        (pending_approval, Vorplan)  -------> Prüfzahl 418 207, Kurzbericht
                        GET …/sessions/current/iso <---------  ISO laden, SHA-256 gegen SHA256SUMS,
                                                               Signatur mit Release-Schlüssel,
                                                               Kernel, initrd, squashfs entnehmen,
                                                               Probeladung kexec_file_load
                                                               Bestätigung an der Konsole (Platten,
                                                               LÖSCHEN), ggf. LUKS-Passphrase
3 Freigabe: Prüfzahl,
  Adresse, Platten,
  Vorplan, Netzwahl --> active                              (fragt alle 5 s current ab)
                                                             memfd: initrd + cpio, kexec_file_load
                        progress phase=kexec <-------------  4 systemctl kexec   (SSH bricht ab)
                                                           Recovery-Umgebung im RAM
                        progress phase=booted <------------  recover (Quelle oneshot)
                        GET …/credentials <-----------------  5 Plan, Löschen, restic restore,
                        /agent/recovery/restic/<id> <-------     release, Fixups, Netz übernehmen,
                                                               cloud-init, initramfs, Bootloader,
                        POST …/oneshot/ip-scan <------------     Suche nach alter Adresse
6 Prüfen und Ersetzen
  je Datei          --> Entscheidungen     ---------------->     Ersetzen nach Freigabe je Datei
                        POST …/finish <----------------------    Prüfung, Bericht, Neustart
7 Checkliste außerhalb
  (DNS, PTR, …)                                            wiederhergestelltes System startet
```

Schritte im Einzelnen:

1. **Ausstellen** (Abschnitt 6.1): Admin mit frischer Anmeldung wählt Sicherungsstand und
   Gültigkeit der Sitzung; Restow zeigt den Befehl einmalig. Der Code ist 30 Minuten
   einlösbar; danach verfällt er (`expired`).
2. **Befehl auf dem Ziel** (Abschnitt 8): `oneshot.sh` lädt und prüft `restow-agent`, startet
   `restow-agent oneshot`. Der prüft, erfasst, tauscht den Code ein, lädt und prüft das ISO,
   lädt dessen Kernel probeweise mit `kexec_file_load` und zeigt Prüfzahl und Kurzbericht. An
   der SSH-Konsole bestätigt der Admin, dass die Platten dieses Rechners gelöscht werden
   dürfen.
3. **Freigabe in der Oberfläche** (Abschnitt 6.3): Prüfzahl, öffentliche Adresse, wie der Server
   sie sieht, Adressen am Rechner, Platten, Anbieter, Firmwaremodus, Vorplan des Servers, Wahl des
   Netzwegs. Erst danach gibt der Server Zugangsdaten heraus, und zwar an die Sitzung, deren
   Geheimnis nur der Rechner kennt.
4. **Umschalten** (Abschnitt 8.6): initrd zusammensetzen, `kexec`. Die
   SSH-Verbindung bricht ab; die Oberfläche zeigt "Recovery-Umgebung startet", die Konsole des
   Anbieters zeigt den Start.
5. **Wiederherstellung** (Abschnitt 9): `recover` meldet sich mit derselben Sitzung (`booted`),
   holt die Zugangsdaten und läuft wie BM 10, nur ohne Fragen an der Konsole.
6. **Netz und alte Adresse** (Abschnitte 10 bis 12): vor dem Neustart.
7. **Danach** (Abschnitt 13): Checkliste in der Oberfläche; optional Wiederanbinden (BM 10.19).

## 4. Machbarkeitsprobe (Spike)

Gemacht in dieser Umgebung ohne KVM, mit QEMU 8.2 und TCG, gegen das ISO-Artefakt des CI-Laufs
von `release/0.5.0` bei Commit `9db647fa` (Artefakt `recovery-iso`, Version `0.0.0-dev`, SHA-256
geprüft). Die Werkzeuge liegen außerhalb des Repositorys (Python ohne Abhängigkeiten: ein
ISO9660-Leser mit Rock-Ridge-Namen, ein cpio-Leser und -Schreiber); der Weg ist so beschrieben,
dass O1 ihn als CI-Test nachbaut (19.2).

### 4.1 Größen (gemessen)

| Datei im ISO | Bytes | MiB |
| --- | ---: | ---: |
| ISO gesamt | 408 944 640 | 390,0 |
| `/live/vmlinuz` (6.12.113+deb13-amd64, bzImage) | 12 154 816 | 11,6 |
| `/live/initrd.img` | 52 428 481 | 50,0 |
| davon unkomprimiertes cpio (Module, schon `.ko.xz`) | 30 926 336 | 29,5 |
| davon gzip-Teil (entpackt 58 018 816 Byte) | 21 502 145 | 20,5 |
| `/live/filesystem.squashfs` | 329 814 016 | 314,5 |
| initrd für kexec (initrd + cpio mit squashfs und Daten) | 382 245 888 | 364,5 |

Der Kernel meldet beim Start `Freeing initrd memory: 373288K`: Das zusammengesetzte initrd liegt
nur bis zum Entpacken doppelt im Speicher.

### 4.2 Was die Probe zeigt

1. **Direkter Start ohne Medium geht.** QEMU mit `-kernel vmlinuz -initrd <zusammengesetzt>`
   (genau das, was `kexec` übergibt: Kernel, initrd, Kommandozeile), Kommandozeile wie im Menü
   des ISO mit `live-media=/restow/medium` statt eines Mediums. live-boot findet das Verzeichnis
   im initramfs (`check_dev` bindet ein Verzeichnis ein, `is_live_path` findet
   `live/filesystem.squashfs`), hängt das squashfs über `/dev/loop0` ein, systemd startet,
   `restow-recover.service` startet, und `recover` zeigt seinen ersten Dialog auf `ttyS0`
   ("Restow Recovery 0.0.0-dev", "Keyboard layout"). Netz per DHCP über systemd-networkd wie
   vom ISO. [Spike]
2. **Daten kommen an.** Ein Skript in `scripts/init-bottom` (Probe: über das angehängte cpio
   samt `ORDER`; im Entwurf fest im ISO, 9.1) kopiert `/restow/oneshot.json` nach
   `/run/restow-oneshot/oneshot.json` (0600). `/run` zieht initramfs-tools in das neue System
   um; `run-init` löscht danach alles im alten rootfs, auch `/restow` (geprüft: "No such file
   or directory"). Das squashfs bleibt über das Loop-Gerät im Speicher
   (`losetup -a`: `/run/live/medium/live/filesystem.squashfs (deleted)`). [Spike]
3. **`fromiso=` mit einer ISO-Datei im initramfs geht nicht ohne Zusatz:** "failed to setup loop
   device", weil das Modul `loop` zu dem Zeitpunkt nicht geladen ist. Mit dem Verzeichnisweg
   braucht es das Modul erst für das squashfs, und das lädt live-boot selbst. Darum
   `live-media=<verzeichnis>`, nicht `fromiso=`. [Spike]
4. **Speicher nach dem Start** (3 GiB, `free -m`, `recover` wartet im ersten Dialog): 556 MiB
   belegt, davon 319 MiB "shared" (rootfs mit dem squashfs und `/run`); `MemAvailable`
   2 419 MiB. `findmnt /run/live/medium` zeigt `rootfs[/restow/medium]`. [Spike]
5. **Fund am ISO selbst:** Mit `console=ttyS0` startet systemd zusätzlich `serial-getty@ttyS0`.
   Login-Aufforderung und `recover` teilen sich die Schnittstelle; Eingaben gehen an den
   Login, und nach jedem abgelaufenen Login begann `recover` seinen Dialog von vorn. Mit
   `systemd.mask=serial-getty@ttyS0.service` war es weg (`is-active`: `inactive`), der Dialog
   lief. Dieselbe Kommandozeile haben die Menüeinträge "serielle Konsole" des ISO; der Fehler
   betrifft also auch 0.5.0 (Abschnitt 21, Befund 1). [Spike]
6. **Nicht geprüft** (keine Rechte für `kexec` in dieser Umgebung, kein KVM): `kexec_file_load`
   selbst, Secure Boot, EFI-Laufzeitdienste nach kexec, ein ganzer Restore. Das ist bewusst die
   Grenze der Probe: kexec übergibt dem neuen Kernel genau Kernel, initrd und Kommandozeile;
   das Neue an diesem Weg war, ob das ISO ohne sein Medium startet und wie Daten hineinkommen.

### 4.3 Warum nicht `fetch=` (squashfs über HTTP im initramfs)

live-boot kann das squashfs mit `fetch=<url>` beim Start laden. Das wurde verworfen:

- Geladen wird mit `wget` aus busybox; eine Prüfung des Inhalts gibt es nicht (nur
  `verify-checksums` gegen eine Datei auf dem Medium), und nach unserem Kenntnisstand prüft
  busybox-wget bei https kein Zertifikat.
- Netz im initramfs heißt `ipconfig` aus klibc (`9990-networking.sh`, `configure_networking`):
  IPv4 per DHCP oder `ip=` statisch, **kein IPv6**, kein On-link-Gateway außerhalb des Präfixes.
  Reine IPv6-Rechner und Rechner mit /32 ohne DHCP blieben ohne Netz.
- Die URL muss auf `.squashfs` enden, das Ziel ist `ramfs` (ohne Grenze).

Das squashfs im angehängten cpio braucht kein Netz im initramfs, und seine Echtheit ist schon
vor dem Umschalten geprüft (Abschnitt 5.4). Der Preis sind rund 315 MiB, die der alte Kernel
vor dem Umschalten im Speicher hält (Abschnitt 15).

## 5. Vertrauensmodell und Bedrohungen

### 5.1 Vertrauensanker

- **Der Befehl** holt `oneshot.sh` per TLS von der Instanz (`curl -fsSL`, Systemzertifikate).
  Wie beim Installer `linux.sh` füllt die Instanz Instanz-URL, Version und Release-Schlüssel in
  die Vorlage; das Skript lädt `restow-agent` und prüft ihn gegen das signierte `SHA256SUMS`, bevor
  er läuft. Wer der Instanz und ihrem TLS-Zertifikat vertraut, vertraut damit dem Skript. Eine
  **kompromittierte Instanz** kann ein anderes Skript ausliefern; dagegen hilft keine Prüfung, die
  das Skript selbst durchführt (inhärent wie beim Installer und wie bei BM 16.2, letzte Zeile).
- **Wer der Instanz nicht blind trauen will**, nutzt den Weg aus `linux.sh`: Skript erst laden
  und lesen, `RESTOW_SHA256SUMS_SHA256` mit der SHA-256 eines `SHA256SUMS`, dessen Signatur er
  anderswo mit `release-signing.pub` aus dem Git-Tag geprüft hat. Das Skript nimmt diesen Wert und
  übergibt ihn an `restow-agent oneshot`, der dann auch das ISO nur gegen genau diese Datei
  annimmt. Der Fingerabdruck des Release-Schlüssels steht in der Oberfläche mit dem Satz aus BM 8.5
  ("außerhalb dieser Instanz vergleichen").
- **Die Recovery-Umgebung** ist das signierte ISO des Release: Kernel, initrd und squashfs werden
  **aus dem ISO** entnommen, dessen SHA-256 in `agent-SHA256SUMS` (bzw. `recovery-SHA256SUMS` eines
  Neubaus, BM 26.13) steht, nachdem `restow-agent oneshot` die Signatur dieser Datei mit dem
  Release-Schlüssel geprüft hat (dieselbe Prüfung wie `agent/internal/release/sshsig.go`). Kein
  neuer Release-Anhang, keine zweite Signatur, keine vom Server entpackten Dateien.
- **TLS in der Recovery-Umgebung:** wie im ISO Systemzertifikate. Zusätzlich übergibt
  `restow-agent oneshot` den SPKI-Prüfwert der Verbindung, die er **mit gültigem Zertifikat**
  aufgebaut hat, und eine CA-Datei, wenn der Befehl mit `RESTOW_CA_FILE` lief (private CA);
  `recover` nimmt dieselbe Instanz nur mit gültigem Zertifikat **oder** genau diesem Prüfwert an
  (BM 10.3, Rückfall ohne Eintippen, weil der Wert nicht vom Bediener kommt, sondern aus einer
  geprüften Verbindung).

### 5.2 Ablauf der Freigabe

- Der Einmalcode wird nur gegen eine Sitzung im Zustand `pending_approval` getauscht; das
  Sitzungsgeheimnis entsteht in `restow-agent oneshot`, nur dessen Hash geht zum Server (wie
  BM 9.3). Die Prüfzahl stammt aus dem Hash (BM 9.3) und steht an der SSH-Konsole und in der
  Oberfläche.
- Die Freigabe (`approve`, frische Anmeldung, Audit) nennt, was der Rechner gemeldet hat
  (gekennzeichnet "vom Rechner gemeldet") und was der Server selbst sieht (Absenderadresse des
  Tauschs). Erst danach gibt `GET …/credentials` Repository-Passwort und Lesezugang heraus, wie
  BM 9.5.
- Zwischen Freigabe und Umschalten hält `restow-agent oneshot` das Geheimnis im Speicher und im
  `memfd` des initrd, nie in einer Datei auf der Platte. Die Zugangsdaten holt erst `recover` in
  der Recovery-Umgebung; `restow-agent oneshot` ruft `credentials` nie auf (Test).

### 5.3 Bedrohungen

| Angreifer hat … | kann … | kann nicht … | Gegenmaßnahme |
| --- | --- | --- | --- |
| den Befehl (Link-Diebstahl: Chat, Ticket, Bildschirmfoto), noch nicht eingelöst | auf **seinem** Rechner einlösen: Sitzung `pending_approval`; der echte Admin sieht danach `recovery-code-used` | Zugangsdaten bekommen, ohne dass ein Admin **seinen** Rechner (Adresse, Platten, Prüfzahl) freigibt | Freigabe mit Prüfzahl und Adressen, Alarm `endpoint.recovery.started` (BM 12.6), 30 Minuten Gültigkeit, Ablehnen |
| den Befehl nach dem Einlösen | – | ein zweites Mal einlösen (409 `recovery-code-used`), die Sitzung übernehmen (Geheimnis unbekannt) | BM 9.3 |
| den Netzweg (MITM) | – | Skript, Agent oder ISO unterschieben (TLS, Signatur), den Code an der echten Instanz einlösen, wenn er auf eine falsche Origin umleitet (Beweis an die Origin gebunden) | 5.1, BM 9.1 |
| eine Wiederholung (Replay) der Anfragen | – | einen zweiten Tausch (einmal, idempotent nur mit demselben Hash und nur 15 Minuten, BM 9.3), eine Freigabe (Oberfläche, frische Anmeldung) | BM 9.3, 9.4 |
| einen Admin, der den Befehl auf dem **falschen Rechner** einfügt (laufender Produktionsserver) | – | etwas löschen, ohne Warnung an der Konsole, Bestätigung `LÖSCHEN`/`ERASE` mit Plattenkennungen **und** Freigabe in der Oberfläche | 8.4 (Anzeichen eines benutzten Rechners: Agent eingerichtet, Laufzeit, Dienste, belegte Platten) |
| Root auf dem frischen Rechner (bösartiges Abbild des Anbieters, Mitbenutzer mit root) | Sitzungsgeheimnis und LUKS-Passphrase lesen, den Ablauf fälschen | – | inhärent: der Rechner wird zum wiederhergestellten System; wer ihn kontrolliert, kontrolliert das Ergebnis (wie ein verändertes ISO, BM 16.2). Nur Abbilder des Anbieters nehmen; Hinweis in der Oberfläche |
| den Admin, der den Befehl nach der Freigabe abbrechen will (Strg+C, die SSH-Verbindung bricht, SIGTERM) | – | einen halb geladenen Rechner hinterlassen | **Punkt ohne Rückkehr** ist der Aufruf von `systemctl kexec`. Bis dahin entlädt ein Abbruch, was geladen ist, und der Befehl endet mit 4, der Rechner unverändert (die freigegebene Sitzung endet nach 30 Minuten ohne `booted`). Danach fährt systemd den Rechner geordnet herunter; ein Abbruch wirkt nicht mehr. Das rohe `reboot(LINUX_REBOOT_CMD_KEXEC)` ohne geordnetes Herunterfahren nur, wenn `systemctl` fehlt oder aus einem anderen Grund als dem Abbruch scheitert |
| Zugriff auf die Konsole des Anbieters | Fortschritt lesen | Geheimnisse lesen (nichts davon auf der Kommandozeile oder der Konsole), eingreifen (keine Eingabe nötig; Strg+C fragt nach) | 9.4 |
| eine Datenbank-Kopie | Hashes und gemeldete Netzdaten sehen | einen Code einlösen | BM 9.1 |
| eine kompromittierte Instanz | alles | – | inhärent |
| ein altes ISO mit bekanntem Fehler (Downgrade) | – | es unterschieben: angeboten wird nur das neueste geprüfte ISO der Instanz (BM 26.13), `recover` meldet seine Version, der Server lehnt unter `minRecoveryVersion` ab | BM 8.5 |

### 5.4 Echtheit von Kernel, initrd und squashfs

1. `restow-agent oneshot` lädt das ISO (`GET /agent/v1/recovery/sessions/current/iso`, 6.4) in
   eine Datei unter `/var/tmp/restow-oneshot/` (öffentliche Daten; die Platte wird ohnehin
   gelöscht) und lädt `SHA256SUMS` und `SHA256SUMS.sig` dazu.
2. Er prüft die Signatur mit dem Release-Schlüssel (aus dem Skript, also von der Instanz; siehe
   5.1) bzw. die SHA-256 von `SHA256SUMS` gegen `RESTOW_SHA256SUMS_SHA256`, dann die SHA-256 des
   ISO gegen dessen Zeile. Erst danach liest er es.
3. Er liest das ISO mit einem eigenen ISO9660-Leser (Standardbibliothek, Rock-Ridge-Namen,
   Grenzen für Verzeichnisgröße und Tiefe; Test mit dem echten ISO in der CI): `/live/vmlinuz`,
   `/live/initrd.img`, `/live/filesystem.squashfs`. Nur diese drei Pfade; jede andere Struktur
   bricht ab. Er prüft zusätzlich die SHA-256 der drei Dateien gegen `/sha256sum.txt` des
   ISO (live-build legt sie an), als Schutz gegen Fehler im eigenen Leser, nicht als
   Echtheitsbeweis.
4. Unter Secure Boot mit Lockdown prüft der laufende Kernel bei `kexec_file_load` die Signatur
   des Kernels (Debian-signiert). initrd und squashfs prüft er nicht; das ist dieselbe Grenze wie
   beim ISO (BM 8.6: Secure Boot schützt die Startkette bis zum Kernel, nicht das Live-System).
   Die Echtheit beweist allein Schritt 2.

## 6. Protokoll und API

### 6.1 Ausstellen

`POST /api/v1/endpoints/:id/recovery-codes` mit `{ kind: "oneshot", snapshotId?, validityHours? }`
(Mandanten-Admin, `assertRecentSignIn`, Audit `endpoint.recovery_code.created` mit `kind`):

- Bedingungen wie BM 9.2 (Linux, Snapshot mit Manifest, Urteil nicht `unsupported`, geprüftes
  ISO bekannt, höchstens drei offene Codes je Rechner).
- `requireApproval` ist immer `true` (ein Wert `false` wird mit 422 abgelehnt).
- Code-Form `OS-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX` (Alphabet und Länge wie BM 9.1, 122 Bit); der
  Beweis nimmt eine eigene Trennung:
  `codeProof = SHA-256("restow-oneshot-code:" || canonicalOrigin(o) || ":" || code)`. Ein
  `OS-`-Code taugt damit nicht im ISO und ein `RC-`-Code nicht im Befehl.
- **Zwei Fristen:** einlösbar bis `issued_at + 30 min` (`expires_at` beim Ausstellen); beim
  Tausch setzt der Server `expires_at = issued_at + validityHours` (Vorgabe 12, wählbar 4 bis 48;
  CHECK 48 h aus 0102 hält). Ein nicht eingelöster Code endet nach 30 Minuten `expired`.
- Antwort einmalig: `{ id, code, command, expiresAt, sessionValidityHours, instanceOrigin,
  spkiCheck, releaseKeyFingerprint, iso: { version, sha256 } }`; `command` ist
  `curl -fsSL '<origin>/install/oneshot.sh' | RESTOW_ONESHOT_CODE='<code>' sh`. Eine Origin, die
  nicht nur aus Schema, Host und Port besteht (ein Anführungszeichen, `$`, ein Backtick), wird
  nicht in den Befehl geschrieben: Das Ausstellen endet mit 503 `instance-url-unsafe`.
- Ein Code `oneshot` lässt sich vor dem Tausch nicht verlängern (409; die 30 Minuten bleiben).
  Beim Tausch endet die Sitzung `validityHours` nach dem Ausstellen, nie vor dem Ende des Codes
  selbst und nie später als 48 Stunden nach dem Ausstellen; eine laufende Sitzung lässt sich wie
  bisher verlängern.

### 6.2 Skript und Eintausch

| Aufruf | Anmeldung | Zweck |
| --- | --- | --- |
| `GET /install/oneshot.sh` | keine | Vorlage `agent/install/oneshot.sh`, gefüllt wie `linux.sh` (URL, Version, Release-Schlüssel); kein Code darin |
| `GET /install/agent/<v>/linux-amd64/restow-agent`, `…/SHA256SUMS[.sig]` | keine | vorhanden; das Skript lädt nur den Agenten (restic braucht es vor dem Umschalten nicht) |
| `POST /agent/v1/recovery/oneshot` | keine (Beweis im Body) | Tausch: `{ codeProof, sessionSecretSha256, agentVersion, hardware, target, checks }` → 202 wie BM 9.3 plus `iso`, `needs`, `prePlan` |

Der Tausch ist `exchangeRecoveryCode` (`recovery-service.ts`) mit `kind = 'oneshot'` und eigener
Beweis-Trennung: dieselbe atomare Prüfung, dieselbe Idempotenz (15 Minuten, nur gleicher Hash),
dieselben Problemtypen, derselbe Fehlerzähler `recoveryFailures`, dieselbe Spur toter Codes. Neu
im Body:

- `hardware` wie BM 9.3 (Firmware, Secure Boot, RAM, Platten, Netzwerkkarten), erfasst mit
  `HardwareCollector` (`hardware_linux.go`) auf dem laufenden Rechner.
- `target` (Abschnitt 10.1): Netz, Anbieter, cloud-init, Konsolen, Laufzeit, Hinweise auf einen
  benutzten Rechner. Grenzen wie BM 9.3 (64 KiB Body, Listen ≤ 64, keine Steuerzeichen).
- `checks`: Ergebnis der Prüfungen aus 8.2 einschließlich der Probeladung.

Die Antwort (202) trägt zusätzlich `iso: { version, file, sha256 }` (das ISO, das die Instanz
anbietet) und `needs: { passphrase: bool, ramBytes }` (LUKS im Manifest; geschätzter Bedarf, 15).
Den Vorplan (6.3) rechnet der Worker danach; er steht in `GET …/current` unter `oneshot.prePlan`,
sobald er fertig ist.

### 6.3 Vorplan und Freigabe

- Nach dem Tausch plant der Worker den Plan des gewählten Snapshots gegen die gemeldete Hardware,
  mit dem isolierten Planer der Stufe 1 (`restow-agent baremetal plan --target <datei>`, BM 12.2;
  Queue `endpoint-oneshot-plan`, neu). Ergebnis in `oneshot.prePlan`: Zuordnung, Probleme,
  Warnungen, Schrumpfen, Firmwaremodus. Ein Problem (etwa `firmware_mode_mismatch`) steht damit
  **vor** dem Umschalten in der Oberfläche und an der SSH-Konsole, und der Befehl endet ohne
  Änderung am Rechner.
- Der Vorplan kommt mit 0.5.2 (Abschnitt 20). In 0.5.1 zeigt die Freigabe statt seiner Ergebnisse
  die Kästchen ohne Vorauswahl; ein Plan, der eine nicht erteilte Erlaubnis braucht, endet in
  `recover` vor dem ersten Schreiben mit dem Befund des Planers.
- `POST /api/v1/endpoints/:id/recoveries/:rid/approve` bekommt für `oneshot` einen Body
  `{ matchCode, networkMode: "takeover" | "keep", confirmShrink: bool,
  secureBootWarningsOnly: bool, remoteAccess: bool }` (alle `bool` mit Vorgabe `false`).
  `matchCode` sind die sechs Ziffern, die der Rechner an seiner Konsole zeigt; der Server
  vergleicht sie in konstanter Zeit mit der Prüfzahl der Sitzung und lehnt eine andere mit 422
  `recovery-match-code-mismatch` ab (Audit `endpoint.recovery.match_code_mismatch`). Die Prüfzahl
  wird nicht gespeichert. Die Entscheidungen landen in
  `oneshot.decided` und sind die Antworten auf die Fragen, die `recover` sonst an der Konsole
  stellt (BM 10.4 Punkt 5). Mit Vorplan (0.5.2) ist die Freigabe ohne `confirmShrink` bei einem
  Vorplan mit Schrumpfen 422.
- Freigabe und Ablehnung, Zeitgrenze 30 Minuten ohne Freigabe, Audit: wie BM 9.4.

### 6.4 Sitzung nach der Freigabe

Mit Basic `<sessionId>:<sessionSecret>` wie BM 9.8, neu bzw. erweitert:

| Aufruf | Zweck |
| --- | --- |
| `GET /agent/v1/recovery/sessions/current` | zusätzlich `oneshot: { decided, ipReview }` (nur bei `kind = oneshot`) |
| `GET /agent/v1/recovery/sessions/current/iso` | das angebotene ISO (dieselbe Auswahl wie `servableRecoveryIso`), nur in `pending_approval` und `active`, höchstens dreimal je Sitzung; dazu `…/iso/SHA256SUMS` und `…/iso/SHA256SUMS.sig` |
| `POST /agent/v1/recovery/sessions/current/progress` | neue Phasen `registered`, `downloading`, `kexec`, `booted`, `ip_review` |
| `POST /agent/v1/recovery/sessions/current/oneshot/booted` | `recover` meldet sich nach dem Umschalten mit der neu erfassten Hardware; der Server vergleicht mit der gemeldeten (Platten nach Kennung und Größe, MACs) und beendet die Sitzung bei Abweichung (`failed`, Grund `hardware_changed`) |
| `POST /agent/v1/recovery/sessions/current/oneshot/ip-scan` | Funde der Suche nach alter Adresse (Abschnitt 12), höchstens 500, je Zeile gekürzt und geschwärzt |
| `GET /agent/v1/recovery/sessions/current/credentials` | unverändert; zusätzlich 409 `recovery-not-booted`, solange `booted` fehlt |

Die ISO-Route über die Sitzung statt der öffentlichen Route `/install/recovery/…`: kein Teilen
der Ratenbegrenzung (10 je Stunde und Adresse), Download nur für eine eingelöste Sitzung, Audit
am Vorgang. Ausgeliefert werden dieselben Bytes nach derselben Prüfung (BM 26.13).

Admin-Seite:

| Aufruf | Rolle | Zweck |
| --- | --- | --- |
| `GET /api/v1/endpoints/:id/recoveries/:rid` | admin | zusätzlich `oneshot.reported`, `oneshot.prePlan`, `oneshot.decided`, `oneshot.ipScan` |
| `PUT /api/v1/endpoints/:id/recoveries/:rid/ip-review` | admin, frische Anmeldung | `{ files: [{ path, action: "replace" \| "keep" }], mapping: [{ from, to }], extraOldAddresses? }` |
| `POST …/approve`, `…/cancel`, `…/extend`, `…/ssh-keys` | wie BM | |

### 6.5 Zustände

Keine neuen Zustände. Der Zustandsautomat aus BM 9.9 gilt; der Unterschied liegt im Zeitpunkt:

| Von | Nach | Auslöser (oneshot) |
| --- | --- | --- |
| – | `issued` | Ausstellen, `expires_at` = +30 min |
| `issued` | `pending_approval` | Tausch durch `restow-agent oneshot`, `expires_at` = +`validityHours` |
| `issued` | `expired` | 30 Minuten ohne Tausch |
| `pending_approval` | `active` | Freigabe mit Entscheidungen |
| `active` | `failed` | Monitor: 30 Minuten nach der Freigabe kein `booted` (Grund `oneshot_no_boot`); `booted` mit anderer Hardware (`hardware_changed`) |
| `active` … | wie BM 9.9 | |

Die Phasen (`progress.phase`) zeigen den Weg dazwischen: `registered` → `waiting_approval` →
`downloading` → `kexec` → `booted` → `connected` → … (BM 9.8) → `ip_review` → `verifying` →
`done`. Ein Postgres-Test geht die neuen Übergänge mit genau einem Audit-Eintrag je Übergang
durch (wie BM 9.9).

## 7. Datenmodell

**Entscheidung dieses Entwurfs: eine Migration** `0105_recovery_oneshot` für 0.5.1.

```sql
-- 0.5.1, bare metal onto a fresh machine (docs/BAREMETAL-ONESHOT.md 7): a recovery code that a
-- command on the target machine redeems before it switches into the recovery environment.
ALTER TYPE "public"."endpoint_recovery_kind" ADD VALUE 'oneshot';--> statement-breakpoint
ALTER TABLE "endpoint_recoveries" ADD COLUMN "oneshot" jsonb;
```

- `ADD VALUE` steht vorn und wird in derselben Migration nicht benutzt (Regel aus BM 14.2, wie
  0056). Darum auch kein CHECK `oneshot IS NULL OR kind = 'oneshot'` in der Migration (er
  bräuchte den neuen Wert); die Regel hält der Code (`recovery-codes.ts`) und ein Postgres-Test.
- `oneshot` (nullable, keine Tabelle wird umgeschrieben): `{ validityHours, reported: { target,
  checks, bootedHardware }, prePlan, decided: { networkMode, confirmShrink,
  secureBootWarningsOnly, at, by }, ipScan: { findings, status }, ipReview: { files, mapping,
  extraOldAddresses, at, by } }`. Was der Rechner meldet, steht nur unter `reported`, `prePlan`
  und `ipScan` und wird nur von Sitzungsrouten geschrieben; was der Admin entscheidet, steht nur
  unter `decided` und `ipReview` und wird nur von Admin-Routen geschrieben. Der TS-Typ
  `EndpointRecoveryOneshot` in `packages/db/src/schema/endpoints.ts`.
- **Nummer und Journal:** 0.6.0 (`wip/060`) hat schon `0105_databases` (`when` 1794943124789) bis
  0108. Drizzle überspringt eine Migration, deren `when` nicht größer als das der zuletzt
  angewandten ist. Die Migration für 0.5.1 heißt darum `0105_recovery_oneshot` mit `when`
  **1794750829758** (0104 `boot_probe` plus 60 000 wie die Abstände 0102 → 0103 → 0104), also
  echt zwischen 1794750769758 und 1794943124789. 0.6.0 nummeriert seine eigenen auf 0106 ff. um,
  wenn 0.5.1 dort hineingemergt wird.
- **Warum nicht ohne Migration:** Die Art lässt sich ohne `ADD VALUE` nur als Markierung in einer
  bestehenden `jsonb`-Spalte führen; die einzige, die passt, ist `hardware` ("was der Rechner
  meldet"). Darin müssten auch die Entscheidungen des Admins (Netzweg, Schrumpfen, Ersetzen je
  Datei) stehen, also Werte des Admins in einem Feld, das die Oberfläche und der Server als
  "vom Rechner gemeldet" behandeln (BM 9.8). Das verwischt die Grenze, auf die sich die
  Freigabe stützt. Die 30-Minuten-Frist braucht dagegen **keine** Spalte (zwei Werte von
  `expires_at`, 6.1), Phasen keine (`progress` ist `jsonb`), Zustände keine (6.5).
- `endpoint_recovery_log` und Audit bleiben, wie sie sind; RLS deckt die neue Spalte.

## 8. Der Befehl und `restow-agent oneshot`

### 8.1 `oneshot.sh`

Vorlage `agent/install/oneshot.sh` (POSIX-sh, shellcheck), gefüllt wie `linux.sh`. Sie teilt die
Signaturprüfung mit `linux.sh` (eine gemeinsame Datei `agent/install/lib/verify.sh`, die
`renderInstallScript` beim Ausliefern einsetzt, oder eine Kopie mit Test auf Gleichheit;
entschieden in O3). Ablauf:

1. root (`id -u` = 0), sonst Abbruch mit "als root ausführen". `uname -m` = `x86_64`, sonst
   Abbruch. Code aus der Umgebung (`RESTOW_ONESHOT_CODE`, nur für root lesbar), sofort aus der
   Umgebung entfernt, Form geprüft, nie in einer Datei gespeichert. Ein Code in den Argumenten
   (früher `sh -s -- OS-…`) wird mit einem Hinweis auf den richtigen Befehl abgelehnt: Argumente
   liest jeder Benutzer des Rechners (`ps`), und `sudo` protokolliert sie. Der Befehl ist für eine
   root-Shell gedacht (`sudo -i` vorher; mit `sudo` vor `sh` stünde der Code in dessen Argumenten).
2. Arbeitsordner `/run/restow-oneshot` (tmpfs, 0700). `restow-agent`, `SHA256SUMS`,
   `SHA256SUMS.sig` laden, prüfen wie `linux.sh`, starten:
   `restow-agent oneshot --instance <url> --code-stdin` (Code über stdin, nicht in der
   Prozessliste), dazu `RESTOW_SHA256SUMS_SHA256` und `RESTOW_CA_FILE`, falls gesetzt.
3. Das Skript installiert nichts, legt keinen Dienst an und ändert keine Paketquellen. Der Code
   steht in der Shell-Historie von root auf dem frischen Rechner; der Rechner wird gelöscht, der
   Code ist einmalig und nach dem Tausch wertlos.

### 8.2 Prüfungen vor allem anderen

Alle lesen nur. Ergebnis als Tabelle an der Konsole und als `checks` an den Server.

| Prüfung | Wie | Folge |
| --- | --- | --- |
| Architektur, root | Go `runtime.GOARCH`, `os.Geteuid` | Abbruch |
| Arbeitsspeicher | `/proc/meminfo` `MemTotal`, `MemAvailable` | unter 2 GiB Abbruch; Warnung unter 4 GiB bzw. unter dem Bedarf aus 15 |
| kexec abgeschaltet | `/proc/sys/kernel/kexec_load_disabled` = 1 | Rückfall (17) |
| Lockdown | `/sys/kernel/security/lockdown` (`[integrity]`, `[confidentiality]`) | Hinweis; entscheidend ist die Probeladung |
| Secure Boot | efivar `SecureBoot-8be4df61-…` | Hinweis |
| Firmwaremodus | `/sys/firmware/efi` vorhanden | an den Server (Vorplan) |
| **Probeladung** | `kexec_file_load` (amd64: Rohaufruf 320) mit dem Kernel und einem **kleinen** initrd (nur das initrd des ISO), sofort danach `KEXEC_FILE_UNLOAD`; erst nach dem Laden des ISO, vor der Bestätigung | Fehler `EKEYREJECTED`, `EPERM`, `ENOSYS`, `EBADMSG`: Rückfall (17) mit dem Grund; sonst ok |
| Virtualisierung | `/sys/class/dmi/id/sys_vendor`, `product_name`, `/sys/hypervisor/type` | Xen PV: Abbruch; Xen HVM: Warnung **[Maschine]** |
| Konsolen | `console=` aus `/proc/cmdline` | übernommen für den neuen Kernel (8.6) |
| Netz unterstützt | 10.1: VLAN, Bond, Bridge mit Adresse, mehrere Tabellen | Abbruch mit Grund |
| Anzeichen eines benutzten Rechners | 8.4 | Warnung bzw. Abbruch |

Die Probeladung ist die einzige verlässliche Antwort auf "geht kexec hier?": Ob der laufende
Kernel den Debian-signierten Kernel unter Lockdown annimmt, hängt von seinen Schlüsselringen ab
(Abschnitt 16). Sie braucht das ISO; darum lädt der Befehl das ISO schon vor der Freigabe
(`pending_approval` darf es laden, 6.4).

### 8.3 Erfassen

- Hardware wie das ISO (`HardwareCollector`), mit `lsblk`, `blkid` des Rechners (auf jedem
  Abbild vorhanden; fehlt eines, Abbruch mit dem Namen). Die laufende Wurzel ist eingehängt; das
  ist nur Anzeige, maßgeblich ist der Scan nach dem Umschalten (9.3).
- Netz und Anbieter (10.1), cloud-init (11.1).

### 8.4 Bestätigung an der Konsole, falscher Rechner

`restow-agent oneshot` zeigt nach dem Tausch:

```
Restow: Wiederherstellung von "web01" (Sicherung vom 12.11.2026 03:10 UTC) auf DIESEN Rechner
Prüfzahl:          418 207   (vergleichen Sie sie in Restow)
Dieser Rechner:    203.0.113.7/32, 2001:db8:1::7/64, Gateway 172.31.1.1 (on-link), fe80::1
Firmware:          BIOS        Arbeitsspeicher: 3,7 GiB
Platten:           sda  40,0 GB  QEMU HARDDISK  Kennung …0-0-0  (wird gelöscht)
Netz danach:       wird in Restow gewählt
```

Dann für jede Platte die letzten vier Zeichen der Kennung und `LÖSCHEN` bzw. `ERASE`, wie BM 10.4
Punkt 8; die bestätigten Kennungen gehen als `confirmErase` in die Daten für `recover` (9.2), nie
an den Server. Unbeaufsichtigt (CI, Massenwiederherstellung) mit `--answers <datei>`, die
`confirmErase` trägt (wie BM 10.20; `code` darin wird abgelehnt, er kommt über stdin).

**Anzeichen eines benutzten Rechners** (Schutz gegen Einfügen auf dem falschen Server):
`/etc/restow-agent/state.json` vorhanden (Abbruch: "Auf diesem Rechner ist ein Restow-Agent
eingerichtet; das ist kein frischer Rechner"; nur mit `--this-is-not-production` weiter),
Laufzeit über 24 Stunden, mehr als ein Benutzer mit Heimatordner, laufende Datenbank- oder
Webserverdienste, mehr als 5 GB belegt außerhalb von `/usr` und `/var/cache`. Jedes Anzeichen
steht rot in der Anzeige und in `checks`, und die Oberfläche wiederholt es in der Freigabe.

LUKS im Manifest (`needs.passphrase`): Abfrage der neuen Passphrase hier (zweimal, verdeckt),
mit dem Hinweis aus BM 10.10 zur Tastaturbelegung beim Start und dem Satz "Ein Server mit
verschlüsselter Wurzel braucht bei jedem Start die Konsole des Anbieters". Die Passphrase geht
nur in die Daten für `recover` (RAM), nie an den Server.

Optional **Fernzugang** zur Recovery-Umgebung mit den Schlüsseln aus `/root/.ssh/authorized_keys`
dieses Rechners, **nur über ein Kästchen in der Freigabe, Vorgabe aus** (Entscheidung 22.3):
`restow-agent oneshot` liest die öffentlichen Schlüssel (höchstens 16, nur gültige Zeilen ohne
`command=`-Optionen), meldet ihre Fingerabdrücke an den Server (`reported.sshKeys`, die Oberfläche
zeigt sie neben dem Kästchen) und legt die Schlüssel selbst in die Daten für `recover`. `recover`
schaltet `sshd` damit nur ein, wenn `decided.remoteAccess` gesetzt ist (BM 10.2 Punkt 3, nach dem
Tausch: nur Schlüssel), und meldet die Hostschlüssel-Fingerabdrücke wie bisher. Der Admin kommt so
nach dem Abbruch der SSH-Verbindung wieder auf den Rechner, sieht aber eine Warnung zum
Hostschlüssel; die Oberfläche zeigt den neuen Fingerabdruck.

### 8.5 Warten auf die Freigabe

`GET …/current` alle 5 Sekunden (wie `recover`), mit Anzeige der Prüfzahl. Abgelehnt, abgelaufen
oder abgebrochen: Ende ohne Änderung, `/run/restow-oneshot` und `/var/tmp/restow-oneshot`
gelöscht. Vorplan mit Problem: Ende ohne Änderung, mit dem Text des Problems.

### 8.6 Umschalten

1. Das ISO ist schon geladen und geprüft (5.4, vor der Probeladung in 8.2); die drei Dateien
   werden noch einmal gegen ihre SHA-256 von vorhin gelesen (die Datei liegt auf der Platte).
2. **Daten für `recover`** (`oneshot.json`, Abschnitt 9.2) in den Speicher.
3. **initrd zusammensetzen** in einem `memfd` (`memfd_create` mit `MFD_CLOEXEC`, amd64
   Rohaufruf 319): `initrd.img` des ISO, Nullbytes
   bis zur 4-Byte-Grenze, dann **ein** unkomprimiertes newc-Archiv mit
   `restow/medium/live/filesystem.squashfs` (direkt aus dem ISO gelesen) und
   `restow/oneshot.json` (0600), Abschluss `TRAILER!!!`, Auffüllen auf 512 Byte. Der Kernel
   entpackt verkettete Archive, komprimierte und unkomprimierte, nacheinander. [Spike]
4. **Kommandozeile** (unter 2048 Byte, Grenze auf x86): `boot=live components
   live-media=/restow/medium live-media-timeout=30 noswap nopersistence
   modprobe.blacklist=amdgpu,radeon,nouveau,xe restow.oneshot=1 restow.keymap=us`, dazu die
   `console=`-Werte des laufenden Kernels (8.2) und `restow.console=` für die serielle, falls
   vorhanden. **Nichts Geheimes** auf der Kommandozeile (jeder Prozess liest `/proc/cmdline`).
5. `kexec_file_load(kernel_fd, initrd_memfd, cmdline)`; Prüfung `/sys/kernel/kexec_loaded` = 1.
6. Fortschritt `phase=kexec`, dann `systemctl kexec`: geordnetes Herunterfahren (Dienste,
   Dateisysteme), dann springt systemd in den geladenen Kernel. Scheitert der Aufruf, `sync` und
   `reboot(LINUX_REBOOT_CMD_KEXEC)` (`syscall.Reboot`, Konstante vorhanden).
7. Die SSH-Sitzung endet. Der letzte Text davor: "Die Verbindung bricht jetzt ab. Fortschritt in
   Restow und auf der Konsole Ihres Anbieters."

## 9. Recovery-Umgebung und `recover` im Modus `oneshot`

### 9.1 Änderungen am ISO (`integrations/recovery`)

- `config/includes.chroot/etc/initramfs-tools/scripts/init-bottom/restow-oneshot` (neu, Shell,
  SPDX) und ein Hook, der es ins initramfs bringt: Liegt `/restow/oneshot.json` im initramfs, wird
  es nach `/run/restow-oneshot/oneshot.json` (Ordner 0700, Datei 0600) kopiert und im initramfs
  gelöscht. Nichts sonst; ein ISO-Start hat die Datei nie. [Spike: dieselbe Logik über ein
  angehängtes `ORDER`; im ISO fest eingebaut, damit das angehängte Archiv nur Daten, nie Code
  trägt.]
- `serial-getty@ttyS0.service` und `serial-getty@ttyS1.service` sind seit `release/0.5.0`
  (`a3198bd6`) im Hook 0100 maskiert (Befund 1); nichts mehr zu tun.
- `recover --list-tools` und `no-secrets.sh` unverändert gültig; der Test "keine
  Auto-Aktivierung" läuft zusätzlich im Direktstart.
- Keine neue Datei als Release-Anhang, kein zweites Abbild.

### 9.2 Daten `oneshot.json`

```json
{
  "format": "restow-oneshot-v1",
  "instanceUrl": "https://restow.example.com",
  "lang": "de",
  "spkiSha256": "…", "caPem": null,
  "session": { "id": "…", "secret": "…" },
  "confirmErase": ["…0-0-0"],
  "passphrase": null,
  "sshKeys": ["ssh-ed25519 AAAA… admin@laptop"],
  "consoles": ["tty1", "ttyS0"],
  "network": { "…": "gemessenes Netz des Ziels, 10.1" },
  "hardware": { "…": "wie beim Tausch gemeldet" }
}
```

`recover` liest die Datei als neue Antwortquelle `SourceOneshot` (`answers.go`): nur, wenn
`restow.oneshot=1` auf der Kommandozeile steht **und** die Datei in `/run/restow-oneshot` liegt
(root, 0600, kein Link). Wer beides setzen kann, hat den Kernel gestartet (kexec braucht
`CAP_SYS_BOOT`) und damit dieselbe Macht wie über `fw_cfg` (BM 10.20). Darum darf diese Quelle,
wie `fw_cfg`, eine Passphrase im Klartext tragen; einen Code trägt sie nie (die Sitzung ist
schon eingetauscht). Geheimnisse liest `recover` in `[]byte`, registriert sie beim Schwärzer und
überschreibt die Datei nach dem Lesen nicht: Ein Neustart von `recover`
(`Restart=on-failure`) braucht sie; nach `finish` löscht `recover` sie.

### 9.3 Ablauf in `recover`

Gegenüber BM 10 ändern sich nur die Quellen der Antworten:

| Schritt (BM) | im Modus `oneshot` |
| --- | --- |
| Tastatur, Sprache (10.2) | Vorgabe `us`, Sprache aus der Oberfläche des Ausstellers (`de`/`en` in `oneshot.json`), keine Frage |
| Netz (10.3) | aus `network`: dieselbe Konfiguration wie auf dem frischen Rechner, Zuordnung über **MAC** (dieselbe Hardware), 10.2 |
| Instanz, TLS (10.3) | `instanceUrl`, Prüfwert bzw. CA aus 5.1 |
| Code, Tausch (10.4 Punkt 1) | entfällt; `Session` mit `id` und `secret`, dann `oneshot/booted` mit der neu erfassten Hardware; Abweichung zur gemeldeten: Ende (`hardware_changed`) |
| Freigabe | ist erteilt; `GET current` liefert `oneshot.decided` |
| Snapshot | der des Codes, keine Auswahl |
| Schrumpfen, Secure-Boot-Frage (10.4 Punkt 5) | aus `decided` |
| Bestätigung (10.4 Punkt 8) | `confirmErase` aus der SSH-Konsole; eine Platte, die der Plan löschen will und die nicht bestätigt ist, beendet den Lauf vor dem ersten Schreiben (wie unbeaufsichtigt) |
| Countdown | 30 Sekunden auf allen Konsolen, abbrechbar mit jeder Taste (BM 10.20) |
| nach dem Restore | Netz (10), cloud-init (11), Suche nach alter Adresse und Warten auf die Entscheidung (12), dann initramfs und Bootloader wie BM 10.15 |
| Ende | Erfolg: `finish`, Neustart nach 60 Sekunden, abbrechbar mit jeder Taste auf einer Konsole und mit "Abbrechen" in der Oberfläche (Entscheidung 22.11). Fehler **vor** dem ersten Schreiben auf eine Platte: Angebot "neu starten" (das System des frischen Rechners ist unberührt). Fehler danach: kein Neustart, Fernzugang bleibt, die Oberfläche sagt "Rechner im Rettungssystem starten oder neu anlegen und erneut versuchen" |

Ausgabe auf **allen** Konsolen aus `consoles` (Erweiterung des Spiegels, den BM 10.20 für
`fw_cfg` auf `ttyS0` schon hat): Die Konsole eines Anbieters ist bei dem einen der Bildschirm
(`tty1`), beim anderen die serielle Schnittstelle. Eingaben nimmt `recover` nur von der ersten an
(Abbruch, Shell über das Menü).

`ExitCode` (`exitcode.go`): Die Quelle `oneshot` zählt als unbeaufsichtigt; eine beendete Sitzung
endet mit 4, damit `restow-recover.service` nicht dieselbe Sitzung neu versucht. Ein Neustart
**vor** dem Ende (Absturz) setzt mit derselben Sitzung fort, denn `booted` ist idempotent und das
Geheimnis noch in `/run`.

`liveMedium()` (`hardware_linux.go`) liest `findmnt -o SOURCE /run/live/medium`; im Direktstart
steht dort `rootfs[/restow/medium]` [Spike]. Heute ergibt das den Namen `medium]`, der keine Platte
trifft (unschädlich); O1 erkennt die Form ausdrücklich ("kein Startmedium auf einer Platte") mit
Test.

## 10. Netzwerk

### 10.1 Erfassen auf dem frischen Rechner

`restow-agent oneshot` liest mit `ip -j addr`, `ip -j -4 route show table all`,
`ip -j -6 route show table all`, `ip -j link` (iproute2 ist auf jedem Abbild; Prozess mit
Argumentliste) und aus Dateien:

| Wert | Quelle |
| --- | --- |
| Schnittstellen: Name, MAC, Treiber, MTU, Art (`ether`, `vlan`, `bond`, `bridge`) | `ip -j link`, `/sys/class/net` |
| Adressen v4/v6 mit Präfix, `dynamic` (DHCP/SLAAC) oder statisch, `scope` | `ip -j addr` (Flag `dynamic`, `valid_lft`) |
| Standardrouten v4/v6, Gateway, `onlink`, Metrik | `ip -j route` (Flag `onlink`; ein Gateway außerhalb aller Präfixe der Schnittstelle gilt als on-link) |
| DNS-Server, Suchdomänen | `resolvectl dns`/`domain`, sonst `/run/systemd/resolve/resolv.conf`, sonst `/etc/resolv.conf` (nicht `127.0.0.53`) |
| Herkunft der Konfiguration | netplan (`/etc/netplan`, `/run/netplan`), NetworkManager, networkd, ifupdown, `dhclient`/`dhcpcd`-Leases |
| cloud-init | `/run/cloud-init/instance-data.json` (`v1.cloud_name`, `v1.platform`, `v1.instance_id`, `v1.region`), `cloud-init status`, `ds-identify`-Ergebnis |
| Anbieter | DMI `sys_vendor`, `product_name`, `chassis_asset_tag`, cloud-init `cloud_name` |
| öffentliche Adresse | die Absenderadresse des Tauschs, wie der Server sie sieht (`used_ip`), getrennt angezeigt; bei NAT (AWS) liegt sie nicht am Rechner |

Nicht unterstützt (Abbruch mit Grund): Adressen auf VLAN-, Bond- oder Bridge-Schnittstellen,
Richtlinienrouting (Regeln außer den Standardregeln), mehr als eine Schnittstelle mit
Standardroute je Familie. Ein Rechner mit mehreren Schnittstellen ohne diese Besonderheiten geht.

### 10.2 Netz der Recovery-Umgebung

Die Recovery-Umgebung läuft auf derselben Hardware; die MAC ist dieselbe, der Name kann es nicht
sein (anderes udev). Darum schreibt `recover` je Schnittstelle mit Adresse eine networkd-Datei
`/run/systemd/network/10-restow-oneshot-<n>.network` mit `[Match] MACAddress=` und:

- DHCP, wo das Ziel DHCP nutzte (`DHCP=ipv4`/`yes`), `IPv6AcceptRA=yes`, wo das Ziel SLAAC
  hatte;
- statische Adressen mit Präfix; Gateway mit `[Route] Gateway=… GatewayOnLink=yes`, wenn on-link
  (`172.31.1.1` für ein /32, `fe80::1` für IPv6), `LinkLocalAddressing=ipv6` (ohne Link-local
  kein `fe80::1`), `MTUBytes=`, `DNS=`.

`StaticNetworkFile` (`agent/internal/recovery/network.go`) kann heute **eine** Adresse, ein
Gateway ohne on-link, setzt `IPv6AcceptRA=no` und `LinkLocalAddressing=no` (Befund 2). Der neue
Schreiber ist eine eigene reine Funktion mit Tabellentests (Hetzner-Form, AWS-Form, reines IPv6,
DHCP mit statischem IPv6). Die Vorgabedatei `80-restow-dhcp.network` bleibt für Schnittstellen
ohne eigene Datei.

### 10.3 Wahl in der Oberfläche

Die Freigabe zeigt das alte Netz (aus dem Manifest bzw. den Konfigurationsdateien der Sicherung,
10.6) neben dem gemessenen und schlägt vor:

- **gleiches Netz** (eine alte Adresse liegt am Ziel, oder gleicher Anbieter und der Admin hat
  die öffentliche Adresse umgezogen): Vorgabe "alte Konfiguration behalten". Text: "Ziehen Sie
  die öffentliche Adresse des alten Servers auf diesen um (beim gleichen Anbieter meist möglich:
  Haupt- oder Zusatzadresse), dann bleibt die Konfiguration des Systems, wie sie ist." Die
  MAC-Anpassung aus BM 10.16 läuft wie bisher.
- **anderes Netz** (Vorgabe): "Netz dieses Rechners übernehmen".

### 10.4 "Netz übernehmen"

Nach dem Restore, nach `release`, in `recover` über `rootfs_linux.go` (Pfade bleiben im Ziel,
BM 10.13), reine Textumformungen in `agent/internal/baremetal/netwrite.go` (neu, ohne Build-Tag):

1. **Stapel des wiederhergestellten Systems bestimmen** (nicht raten aus Paketen, sondern aus dem,
   was beim Start läuft): aktivierte Units in `/etc/systemd/system/*.wants/`
   (`NetworkManager.service`, `systemd-networkd.service`, `networking.service`), netplan mit
   `renderer:` (netplan schreibt dann für networkd oder NetworkManager), RHEL
   `/etc/sysconfig/network-scripts/ifcfg-*` mit NetworkManager. Mehrere aktiv: der, der die
   Standardroute der Sicherung trug (aus den Konfigurationen); unklar: Problem im Plan, kein
   Raten.
2. **Alte Konfiguration sichern:** jede Datei, die der Schritt ändert oder wegnimmt, kommt mit
   Pfad und Rechten unverändert nach `/etc/restow/network-before-restore/<pfad>` (0700 für den
   Ordner, NetworkManager-Verbindungen bleiben 0600), dazu `README` mit Zeitpunkt, Sitzung und
   Rückweg. Nichts wird gelöscht.
3. **Neue Konfiguration** im Format des Stapels, Zuordnung **nicht über die alte MAC**:

   | Stapel | Datei | Zuordnung |
   | --- | --- | --- |
   | netplan | `/etc/netplan/60-restow.yaml` (0600), alte Dateien mit Adressen bzw. `match` weggenommen | eine Schnittstelle: `match: { name: "en*" }` bzw. `"eth*"` nach dem Namensschema des Systems; mehrere: `match: { macaddress: <MAC des Ziels> }` |
   | systemd-networkd | `/etc/systemd/network/10-restow-<n>.network` | eine: `[Match] Type=ether` und `Kind=!*`; mehrere: MAC des Ziels |
   | NetworkManager | `/etc/NetworkManager/system-connections/restow-<n>.nmconnection` (0600) | eine: ohne `interface-name` und ohne `mac-address`, `autoconnect-priority=100`; mehrere: `mac-address=` des Ziels |
   | ifupdown | `/etc/network/interfaces.d/restow` und `/etc/network/interfaces` mit `source` | Namen werden nach dem Start feststehen: `allow-hotplug` mit dem **vorhergesagten** Namen, dazu eine `.link`-Datei, die genau diesen Namen der MAC des Ziels gibt |

   DHCP, wo das Ziel DHCP nutzte; statisch mit on-link-Gateway in der Schreibweise des Stapels
   (netplan `routes: [{ to: default, via: 172.31.1.1, on-link: true }]`, NetworkManager
   `route1=0.0.0.0/0,172.31.1.1` mit `onlink=true` in `route1_options`, networkd
   `GatewayOnLink=yes`, ifupdown `post-up ip route add 172.31.1.1 dev $IFACE` und
   `gateway`); MTU; DNS im Format des Stapels, und wo `/etc/resolv.conf` eine gewöhnliche Datei
   ist (kein Link auf `stub-resolv.conf`), wird sie neu geschrieben (alte gesichert).
4. **Alte Bindungen an Hardware** abschalten: `70-persistent-net.rules`-Einträge, `.link`-Dateien
   und `ifcfg`-`HWADDR=` mit MACs der alten Schnittstellen (aus `netConfigs` des Manifests) werden
   gesichert und auskommentiert bzw. weggenommen.
5. Ein Bericht im Abschluss nennt jede geschriebene und jede weggenommene Datei.

"Alte Konfiguration behalten" macht nur Schritt 4 aus BM 10.16 (MAC ersetzen), nichts sonst.

Der Namensabgleich mit `en*`/`eth*` ist bewusst grob: Er gilt nur bei **einer** physischen
Schnittstelle (der übliche Fall bei virtuellen Servern) und überlebt jeden Namenswechsel zwischen
Kernel- und udev-Versionen. Bei mehreren Schnittstellen ist die MAC des **Ziels** die einzige
stabile Angabe; sie ändert sich erst, wenn der Rechner selbst neu angelegt wird. **[Maschine]**:
Bleibt die MAC einer Instanz bei Anbietern über Stopp/Start und Umzug gleich (bei den bekannten
Angeboten ja)?

### 10.5 Prüfung

Die Prüfung nach BM 10.17 bekommt einen Befund `network` (kein elfter Prüfpunkt, damit
`restow-verify-v1` gleich bleibt, sondern ein Beleg unter Punkt 9): geschriebene Dateien parsebar
(netplan mit `netplan generate --root-dir` im isolierten `chroot`, NetworkManager-Keyfile und
networkd als INI), jede Adresse des Ziels kommt in genau einer Datei vor.

### 10.6 Alte Adressen kennen

Das Manifest kennt heute nur Schnittstellen, MACs und Dateien mit MACs (`captureNetwork`), keine
Adressen. Neu im Manifest (optionales Feld auf oberster Ebene, `restow-layout-v1` bleibt: Go liest
unbekannte Felder ohne Fehler, TS `looseObject`):
`netState: { interfaces: [{ name, mac, addresses: ["192.0.2.10/24", …] }], routes: [{ family,
gateway, onlink, dev }], dns: [], hostname, fqdn, cloud: { name, instanceId, region } }`. Für
Sicherungen ohne `netState` liest `recover` die statischen Adressen aus den Konfigurationsdateien
der Sicherung (netplan, ifupdown, NetworkManager, networkd, ifcfg); mit DHCP bleibt die alte Adresse
unbekannt, und die Oberfläche fragt sie ab ("alte öffentliche Adresse"; Entscheidung 22.9: keine
zweite Migration, der Server hält keine Absenderadresse je Sicherung fest).

## 11. cloud-init im wiederhergestellten System

### 11.1 Problem

Auf dem neuen Rechner sieht cloud-init des wiederhergestellten Systems eine neue Instanz-ID und
behandelt den Start als ersten Start einer neuen Instanz: neue SSH-Hostschlüssel
(`ssh_deletekeys`), Standardbenutzer mit dem Schlüssel aus den Metadaten, Passwörter
(`set_passwords`), Hostname, `growpart`, `disk_setup`, `mounts`, `runcmd` aus den Benutzerdaten der
neuen Instanz. Gewollt ist nach Entscheidung des Maintainers: **nur das Netz**.

### 11.2 Umsetzung

`recover` legt `/etc/cloud/cloud.cfg.d/99-restow-restored.cfg` an (cloud.cfg.d wird in
Namensreihenfolge gemischt, spätere Schlüssel gewinnen, Listen werden ersetzt):

```yaml
# Restow: this system was restored onto a new instance (<zeit>, recovery <id>).
# cloud-init may set up the network of this instance; everything else stays as restored.
# Delete this file to give cloud-init its usual role back.
cloud_init_modules: []
cloud_config_modules: []
cloud_final_modules: []
ssh_deletekeys: false
ssh_genkeytypes: []
preserve_hostname: true
```

Das Netz richtet cloud-init in der Phase `init-local` aus den Metadaten ein, unabhängig von den
Modullisten. Ob das geschieht, hängt an zwei Dingen, die `recover` prüft:

| wiederhergestelltes System | Netz |
| --- | --- |
| cloud-init aktiv, Netz nicht abgeschaltet, und seine `datasource_list` (bzw. `ds-identify`-Vorgaben) enthält die Datenquelle des Ziels (aus 10.1) | cloud-init richtet das Netz aus den Metadaten ein; "Netz übernehmen" schreibt **keine** eigene Datei, nimmt nur die alten statischen Dateien weg (gesichert) und lässt die von cloud-init erzeugte (`50-cloud-init.yaml`) neu entstehen |
| cloud-init aktiv, aber die Datenquelle des Ziels fehlt (Anbieterwechsel: das System kennt nur die alte) | "Netz übernehmen" schreibt die eigene Datei (10.4) und zusätzlich `network: { config: disabled }` in die Datei oben; Hinweis im Bericht |
| cloud-init mit abgeschaltetem Netz oder ohne cloud-init | 10.4 |

Kein Eingriff in `/var/lib/cloud` (kein Vortäuschen der alten Instanz-ID): Das hinge an der
inneren Ablage von cloud-init. Die Datei bleibt dauerhaft; die Oberfläche und der Abschluss sagen,
dass die Anmeldung danach mit den Zugängen des **gesicherten** Systems geht, nicht mit dem
Schlüssel, der beim Anlegen des neuen Rechners angegeben wurde; die Checkliste (13, Punkt 11)
nennt die Datei und wie man sie entfernt (Entscheidung 22.5). **[CI]**: Verhalten auf Debian 12
(cloud-init 22.4), Ubuntu 22.04 und 24.04, AlmaLinux 9 in O-E1 bis O-E3; **[Maschine]**: mit den
Datenquellen echter Anbieter.

## 12. Suche nach der alten Adresse

- **Wann:** nach Netz und cloud-init, vor initramfs und Bootloader, mit dem Ziel eingehängt und ohne
  Programm aus der Sicherung (reines Lesen über `rootfs_linux.go`).
- **Wo:** `/etc` (ohne `/etc/ssl`, `/etc/pki`, `/etc/restow`, `/etc/restow-agent` und die
  Ausnahmen aus `skipEtcDirs`), `/usr/local/etc`, `/opt/*/` und `/srv/*/` bis Tiefe 4 nur Dateien
  mit den Endungen `.conf`, `.cfg`, `.cnf`, `.ini`, `.yml`, `.yaml`, `.json`, `.toml`, `.xml`,
  `.properties`, `.env`, `.service`, dazu `docker-compose*.yml`/`compose*.yaml` überall dort;
  Grenzen wie `scanDeviceNames` (20 000 Dateien, 1 MiB je Datei, keine Binärdateien, keine
  Links aus dem Ziel heraus).
- **Was:** jede alte Adresse aus 10.6, IPv4 mit Wortgrenzen (nicht als Teil einer längeren Zahl,
  auch in CIDR-Form), IPv6 über Kandidaten (Regex) und Vergleich nach `net.ParseIP` (verschiedene
  Schreibweisen derselben Adresse). Kommentarzeilen werden mit Kennzeichnung gemeldet, nicht
  ausgelassen.
- **Bericht:** `POST …/oneshot/ip-scan` mit Datei, Zeile, Adresse und einem Ausschnitt von
  höchstens 120 Zeichen um den Fund, geschwärzt (`redact`, dazu Muster `password=`, `secret`,
  URL-Zugangsdaten `://user:pass@`): Konfigurationszeilen tragen oft Zugangsdaten. Höchstens 500
  Funde; mehr steht als Zahl da.
- **Entscheidung:** Phase `ip_review`; die Oberfläche zeigt die Liste je Datei mit den Zeilen und
  einer Zuordnung alt → neu (Vorschlag: alte Adresse → Adresse des Ziels derselben Familie; bei
  NAT die private Adresse des Ziels, weil Dienste nur an Adressen am Rechner binden können).
  Je Datei "ersetzen" oder "lassen". `recover` fragt `current` alle 5 Sekunden ab und wartet
  höchstens 60 Minuten (Entscheidung 22.10); ohne Entscheidung bleibt alles, wie es ist, mit Hinweis
  im Bericht.
- **Ersetzen:** nur in den bestätigten Dateien, nur die gemeldeten Zeilen, nur die gemeldete
  Adresse; vorher `<datei>.restow-<zeit>` daneben (wie die Fixups, BM 10.13); atomar, mit Rechten,
  Besitzer und SELinux-Kontext der alten Datei (`restorecon` für geänderte Pfade wie BM 10.13).
  Hat sich die Zeile seit dem Bericht geändert (Hash je Zeile), wird die Datei übergangen.
- Was nicht in Dateien steht (Datenbankinhalte, Anwendungsdaten, Lizenzdateien in Binärform),
  findet die Suche nicht; die Checkliste (13) sagt das.

## 13. Checkliste außerhalb des Rechners

In der Oberfläche nach dem Ende (und schon beim Ausstellen als "vorher erledigen" der erste
Punkt), abhakbar nur im Browser (keine Daten am Server), Texte ohne Herstellernamen:

1. **Vorher:** TTL der DNS-Einträge senken (etwa auf 300 Sekunden), einen Tag vor dem Umzug.
2. DNS A und AAAA auf die neue Adresse; die alte Adresse in anderen Zonen (Nebennamen, MX-Ziele).
3. Reverse-DNS (PTR) der neuen Adresse beim Anbieter setzen; für Mailserver Pflicht.
4. SPF (`ip4:`/`ip6:`), DKIM bleibt, DMARC-Berichte beobachten; ausgehender Port 25 ist bei
   manchen Anbietern für neue Rechner gesperrt.
5. Freigabelisten bei Partnern, Banken, Zahlungsdienstleistern, Monitoring, Backup-Zielen.
6. An Adressen gebundene Lizenzen und Zertifikate (auch ACME-Erneuerung über HTTP, die erst mit
   neuem DNS gelingt).
7. Firewall-Regeln und Sicherheitsgruppen des Anbieters für den neuen Rechner; Regeln anderer
   Systeme, die die alte Adresse erlauben.
8. Anmeldung: mit den Zugängen des gesicherten Systems; neuer SSH-Hostschlüssel der Recovery-
   Umgebung war nur vorübergehend, der Hostschlüssel des Systems ist der alte.
11. cloud-init darf im wiederhergestellten System nur das Netz einrichten
    (`/etc/cloud/cloud.cfg.d/99-restow-restored.cfg`, 11.2). Die Datei bleibt dauerhaft; wer
    cloud-init seine gewohnte Rolle zurückgeben will (neue Benutzer, Schlüssel und Skripte aus den
    Daten des Anbieters), löscht sie: `rm /etc/cloud/cloud.cfg.d/99-restow-restored.cfg`, danach
    gilt beim nächsten Start einer neuen Instanz wieder alles.
9. Bei NAT (keine öffentliche Adresse am Rechner): Dienste, die an die alte öffentliche Adresse
   gebunden waren (Liste aus 12).
10. Den alten Rechner abschalten, bevor DNS umgestellt ist, wenn beide dieselben Daten schreiben;
    die Sicherung des alten Rechners läuft weiter, bis er abgeschaltet oder entfernt ist, und
    das Wiederanbinden des neuen (BM 11) trennt den alten.

## 14. Wechsel des Anbieters: Treiber, initramfs, Firmware

- **initramfs** baut `recover` schon heute für die Zielhardware neu: initramfs-tools mit
  `MODULES=most`, dracut `--no-hostonly`, mkinitcpio mit `fallback` (BM 10.15). Damit kommen NVMe
  (AWS Nitro), virtio-scsi und andere Speichertreiber hinein, wenn der gesicherte Kernel sie hat;
  das prüft die Treiberprüfung vor dem Löschen (BM 10.8) gegen `modules.alias` des gesicherten
  Kernels.
- **Netzwerktreiber** (ENA bei AWS, `virtio_net`, `vmxnet3`): heute nur Warnung im Plan. Für
  diesen Weg wird ein fehlender Treiber für **jede** Netzwerkkarte des Ziels ein Problem
  (`oneshot_nic_driver_missing`): Ein Cloud-Server ohne Netz ist nur über die Konsole des
  Anbieters erreichbar. Der Vorplan des Servers sagt es vor dem Umschalten.
- **Firmwaremodus:** `restow-agent oneshot` meldet BIOS oder UEFI; der Vorplan prüft wie BM 10.5
  (`checkFirmwareMode`, `plan.go`). Heute geht BIOS-Sicherung auf UEFI-Ziel nur mit hybridem GPT
  (BIOS-Boot-Partition **und** ESP), UEFI-Sicherung auf BIOS-Ziel gar nicht. Bei Cloud-Abbildern
  ist das hybride Layout üblich (Debian- und Ubuntu-Cloud-Abbilder tragen BIOS-Boot-Partition und
  ESP), und Anbieter unterscheiden sich im Modus (nach unserem Kenntnisstand startet Hetzner Cloud
  x86 im BIOS-Modus, AWS je Abbild BIOS oder UEFI; **[Maschine]**). **O7** erlaubt darum
  UEFI → BIOS, wenn (a) GPT mit BIOS-Boot-Partition, (b) `/usr/lib/grub/i386-pc` in der
  Sicherung (neuer Fakt aus dem Snapshot wie BM 10.4 Punkt 3) und (c) `grub-install` bzw.
  `grub2-install` im System. Der Plan bekommt dann `bootloader_bios` für die Platte mit der
  BIOS-Boot-Partition (heute nur für `BootCode == "grub"` oder `BIOSDisks`), `device.map` weg wie
  bisher; ESP und NVRAM bleiben unangetastet (es gibt keinen NVRAM). Ein UEFI-only-Layout auf
  BIOS-Ziel bleibt `firmware_mode_mismatch` mit dem Text "Der neue Rechner startet im BIOS-Modus;
  diese Sicherung braucht UEFI" (Umbau bleibt außerhalb, BM 2.2).
- **NVRAM nach kexec:** Auf UEFI-Zielen schreibt `recover` `Boot####` über efivarfs. Nach kexec
  übergibt der Kernel die EFI-Laufzeitdienste an den neuen (x86, `kexec_file_load` reicht die
  Zuordnung als `setup_data` weiter); **[Maschine]** ob das bei den Anbietern geht. Der
  Rückfallpfad `\EFI\BOOT\BOOTX64.EFI` (BM 10.15, Vorgabe an) startet auch ohne Eintrag; bleibt
  efivarfs leer, ist das eine Warnung, kein Fehler (wie `nvram_added`).
- **Plattennamen:** `/dev/sda` (virtio-scsi), `/dev/vda`, `/dev/nvme0n1`; die Kennungen aus BM
  10.6 (bei NVMe-Volumes die Seriennummer, sonst `by-path`) gelten unverändert.
- **Kleinere Platte** am Ziel: Schrumpfen wie BM 10.9, Bestätigung über die Freigabe (6.3).

## 15. Arbeitsspeicher

| Abschnitt | Bedarf |
| --- | --- |
| vor dem Umschalten (alter Kernel) | `memfd` mit dem initrd 365 MiB und die Kopie, die `kexec_file_load` als Segmente hält, 377 MiB; zusammen rund 750 MiB über dem, was das System selbst braucht |
| beim Start (neuer Kernel) | initrd 365 MiB plus entpacktes rootfs (squashfs 315 MiB und 58 MiB initramfs) bis `Freeing initrd memory` [Spike]; Spitze rund 750 MiB |
| nach dem Start, `recover` wartet | 556 MiB belegt [Spike] |
| während des Restores | dazu restic (Index im Speicher; `recover` schätzt aus `indexBytes`, BM 8.2) und Seitencache |

Darum: **mindestens 2 GiB** (`MemTotal`; wie das ISO, BM 8.2) und vor dem Umschalten
`MemAvailable` ≥ 1 GiB, sonst Abbruch ohne Änderung; **Warnung unter 4 GiB** oder wenn
`600 MiB + 2 × indexBytes + 512 MiB` (der Server schickt `indexBytes` in `needs.ramBytes`) über
`MemTotal` liegt. Kleine Rechner (2 GiB) lassen sich nach der Wiederherstellung beim Anbieter
meist verkleinern; der Hinweis steht beim Ausstellen ("für die Wiederherstellung einen Rechner
mit mindestens 4 GiB anlegen, danach verkleinern").

## 16. Secure Boot und kexec

- Läuft das System des frischen Rechners mit Secure Boot, setzen Debian, Ubuntu und RHEL den
  Kernel in Lockdown `integrity`. `kexec_load` ist dann verboten, `kexec_file_load` verlangt einen
  Kernel, dessen Signatur einer der Schlüsselringe des **laufenden** Kernels annimmt (eingebaute
  Schlüssel, `.secondary_trusted_keys`, `.platform`/`.machine` mit `db` und MOK).
- Der Kernel des ISO ist von Debian signiert. Nach unserem Kenntnisstand nimmt ihn ein laufender
  Debian-Kernel an (shim legt sein Herstellerzertifikat in `MokListRT`, das im Schlüsselring
  landet), ein Ubuntu- oder RHEL-Kernel nicht (deren shim trägt ein anderes
  Herstellerzertifikat, `db` enthält die CA, die shim signiert, nicht den Debian-Schlüssel).
  **[Maschine]** und **[CI]** (O-E3 mit Ubuntu und Secure Boot: erwartet Rückfall).
- Darum entscheidet nicht eine Tabelle, sondern die **Probeladung** (8.2): Gelingt sie, geht es;
  scheitert sie mit `EKEYREJECTED`/`EPERM`, nennt der Befehl den Rückfall (17), bevor etwas
  geändert ist. Weitere Gründe, die dieselbe Probe findet: `kexec_load_disabled`, IMA-Richtlinien,
  ein Kernel ohne `CONFIG_KEXEC_FILE` (selten), `kexec_load_limit_reboot` (ab 6.6).
- Ob der wiederhergestellte Rechner danach unter Secure Boot startet, prüft wie bisher BM 10.5
  vor dem Löschen, gegen die Variablen, die `recover` nach dem Umschalten aus efivarfs liest.

## 17. Rückfallwege

### 17.1 Rettungssystem des Anbieters

Der Admin startet das Rettungssystem (bei vielen Anbietern ein Linux im RAM, per SSH erreichbar)
und fügt **denselben Befehl** dort ein (ein neuer Code, wenn der alte verbraucht ist). Im
Rettungssystem ist die Platte des Rechners nicht in Gebrauch, und Secure Boot ist dort in der
Regel aus.

- Vorgabe: **derselbe Weg** (Probeladung, kexec in die Recovery-Umgebung). Die Umgebung ist dann
  dieselbe wie überall, mit den Werkzeugversionen des ISO und der Abschaltung der
  Auto-Aktivierung (BM 8.2).
- Wenn auch dort kexec nicht geht (Secure Boot): **Direktmodus** (`restow-agent oneshot --direct`,
  Entscheidung 22.7: der Rückfall für Secure Boot): `restow-agent` und `restic` laufen im
  Rettungssystem selbst, `recover` mit
  `--i-know-this-is-not-the-iso` und der Quelle `oneshot` ohne Umschalten. Voraussetzungen, die
  der Befehl prüft: alle Programme aus `recover --list-tools`, keine Platte des Rechners
  eingehängt, keine aktivierte VG/md/LUKS auf ihnen. Grenzen, die die Oberfläche nennt: andere
  Werkzeugversionen als im ISO (etwa `mkfs`-Funktionen), keine Garantie gegen Auto-Aktivierung.
- Netz: Das Rettungssystem hat die Adressen des Rechners meist ebenfalls (gleiche Schnittstelle,
  DHCP); bei statischer IPv6-Konfiguration nicht immer. Der Befehl erfasst, was dort
  funktioniert, und zeigt in der Freigabe den Hinweis "Netz im Rettungssystem gemessen: nur das,
  was dort konfiguriert ist". "Netz übernehmen" nimmt das gemessene, mit der Möglichkeit, in der
  Oberfläche die IPv6-Adresse des Rechners nachzutragen.

### 17.2 Kein Rettungssystem, kexec gesperrt

Bei AWS EC2 gibt es kein Rettungssystem. kexec scheitert dort fast nur an Secure Boot mit
Lockdown (UEFI-Abbilder mit eingeschaltetem Secure Boot, nicht die Vorgabe). Weg in 0.5.1: Rechner
mit einem Abbild **ohne** Secure Boot (bzw. mit Secure Boot aus) neu anlegen; der Befehl sagt das.
Sonst: nicht unterstützt.

### 17.3 Ausblick: Hilfssystem

Platte des neuen Rechners abhängen, an einen Hilfsrechner hängen, dort im Direktmodus mit
`--target-disk <gerät>` wiederherstellen, zurückhängen. Das braucht eine eigene Absicherung (die
eigene Platte des Hilfsrechners darf nie Ziel sein, Firmwaremodus und Treiber des eigentlichen
Ziels sind am Hilfsrechner nicht messbar) und ist **nicht Teil von 0.5.1**; dokumentiert als
Ausblick.

## 18. Oberfläche

Route `/inventory/<id>/bare-metal`, im Assistenten (BM 14.6) ein zweiter Weg neben "Recovery-ISO".
Texte de/en in `packages/i18n/resources/{de,en}/endpoints.json` unter `recovery.oneshot.*`,
**ohne Produktnamen anderer Hersteller**; "Sie".

1. **Weg wählen:** "Mit Startmedium (Recovery-ISO)" | "Auf einen frischen Rechner (Link)".
   Erklärung: "Für Server, die kein ISO starten können. Legen Sie einen neuen Linux-Server an,
   melden Sie sich als root an und fügen Sie den Befehl ein. Er lädt die Recovery-Umgebung und
   stellt diese Sicherung auf genau diesen Rechner her."
2. **Anforderungen:** Firmwaremodus der Sicherung ("Der neue Server muss im UEFI-Modus starten"
   bzw. "BIOS oder UEFI"), mindestens 2 GiB RAM, empfohlen 4 GiB, Plattengröße mindestens X GB
   (Restore-Größen), Secure Boot aus empfohlen, "Senken Sie vorher die TTL Ihrer DNS-Einträge".
3. **Befehl:** Sicherungsstand, Gültigkeit der Sitzung, frische Anmeldung, dann einmalig der Befehl
   mit "Kopieren", Ablauf ("einlösbar bis 14:32"), Fingerabdruck des Release-Schlüssels mit dem Satz
   aus BM 8.5, Hinweis "Der Befehl enthält keinen Schlüssel. Wer ihn zuerst einlöst, braucht
   trotzdem Ihre Freigabe."
4. **Warte auf den Rechner** → **Freigabe:** Prüfzahl groß, "Vom Rechner gemeldet": Adressen,
   Gateway, Anbieter, Firmware, Platten mit Kennung ("werden gelöscht"), RAM, Anzeichen eines
   benutzten Rechners rot; "Vom Server gesehen": Absenderadresse. Vorplan (Zuordnung, Probleme,
   Schrumpfen mit Bestätigung). **Netz danach:** "Netz dieses Rechners übernehmen" (Vorgabe bei
   anderem Netz) | "Bisherige Konfiguration behalten (öffentliche Adresse wurde umgezogen)".
   Kästchen (alle ohne Vorauswahl): "Verkleinern erlauben", "Secure-Boot-Befunde nur als
   Warnung", "Fernzugang zur Recovery-Umgebung mit diesen SSH-Schlüsseln" (die Fingerabdrücke aus
   `authorized_keys` des Rechners daneben). Knöpfe "Freigeben", "Ablehnen".
5. **Live:** Phasen "Lädt die Recovery-Umgebung", "Schaltet um (die SSH-Verbindung bricht ab)",
   "Recovery-Umgebung gestartet", dann wie BM; SSH-Hostschlüssel, falls Fernzugang an.
6. **Alte Adresse:** Liste je Datei mit Zeilen, Zuordnung alt → neu, "ersetzen"/"lassen" je Datei,
   "Weiter ohne Änderungen"; Restzeit bis zur Vorgabe.
7. **Fertig:** Prüfung, geschriebene Netzdateien, Ort der alten Konfiguration
   (`/etc/restow/network-before-restore/`), cloud-init-Hinweis, Checkliste (13), "Rechner wieder
   anbinden" (BM 11).

Hinweis in Schritt 1 für nicht unterstützte Ziele: "Windows-Server lassen sich so nicht
wiederherstellen."

## 19. Testplan

### 19.1 Unit-Tests (Job `agent` und `test`)

- Go, ohne Build-Tag: Netzschreiber je Stapel (Golden Files: Hetzner-Form mit /32 und
  `172.31.1.1`, statisches IPv6 mit `fe80::1`, AWS-Form mit DHCP und MTU 9001, reines IPv6, zwei
  Schnittstellen), Stapelerkennung, Sicherung der alten Dateien (Pfade bleiben im Ziel),
  cloud-init-Entscheidung (Tabelle 11.2), Adresssuche (Wortgrenzen, CIDR, IPv6-Schreibweisen,
  Schwärzung, Grenzen), Ersetzen (nur bestätigte Zeilen, geänderte Zeile übergangen),
  `oneshot.json` lesen (Rechte, Link, fehlende Kommandozeile), cpio-Schreiber (Ausrichtung, gegen
  den Leser des Kernels: Test entpackt mit `cpio -t` in der CI), ISO9660-Leser (Grenzen, falsche
  Strukturen), Kommandozeile (≤ 2048, keine Geheimnisse), Prüfungen aus 8.2 gegen Testbäume von
  `/proc` und `/sys`, Firmware-Fall UEFI → BIOS im Planer, `liveMedium` mit `rootfs[…]`.
- Linux (`agent-root`): `memfd_create` und Probeladung mit `kexec_file_load` gehen in der CI nicht
  (kein `CAP_SYS_BOOT` im Runner-Container); der Aufruf hat eine Schnittstelle mit Fake, der echte
  Aufruf läuft in 19.2.
- TS: Ausstellen (`kind: "oneshot"`, `requireApproval` erzwungen, Befehl), Code-Beweis mit eigener
  Trennung (Testvektoren in TS und Go, dieselbe JSON-Datei wie BM 9.1), Tausch mit 30-Minuten-Frist
  und Verlängerung von `expires_at`, ISO-Route der Sitzung (Zustände, dreimal), `booted` (gleiche
  und andere Hardware), Freigabe mit Entscheidungen (422 ohne `confirmShrink`), `ip-scan` (Grenzen,
  Schwärzung), `ip-review` (nur Admin, frische Anmeldung), Monitor (`oneshot_no_boot`), Trennung
  `reported`/`decided` (keine Sitzungsroute schreibt `decided`), Migration 0105 einzeln, Zustände
  mit genau einem Audit-Eintrag je Übergang.
- Web: Weg-Auswahl, Befehl, Freigabe mit gemeldeten Daten, Netzwahl, Adressliste, Checkliste, beide
  Sprachen, Test gegen Herstellernamen in Texten (wie `TestTextRules`).

### 19.2 Recovery-ISO (Job `recovery-iso`)

Neuer Test "Start ohne Medium": QEMU mit `-kernel`/`-initrd` aus dem gebauten ISO und einem
angehängten cpio wie in 8.6 (gebaut vom Go-Code, nicht von einem Skript), erwartet auf `ttyS0`
den ersten Dialog von `recover` bzw. mit Antworten den Abschluss eines Probelaufs, sowie
`/run/restow-oneshot/oneshot.json` mit 0600, kein `/restow`, kein `serial-getty`. Das ist der
Spike aus Abschnitt 4 als Test.

### 19.3 Ende zu Ende (`scripts/recovery-e2e`, `integrations/recovery/test`)

Der "frische Rechner" ist ein gepinntes Cloud-Abbild (neu in `images.json`: Debian 12
`genericcloud`, Ubuntu 24.04 cloud image) mit cloud-init NoCloud über eine Seed-Platte: statisches
Netz, **anders als die Quelle**, und `runcmd`, das den Befehl mit dem Code aus `fw_cfg`
(`opt/restow/oneshot`) und `--answers` (`confirmErase`) ausführt. Der Treiber gibt die Sitzung über
die API mit `networkMode` frei, beantwortet `ip-review` über die API und prüft danach über die
serielle Konsole des wiederhergestellten Systems.

| Fall | Quelle (gesichert) | frischer Rechner | prüft |
| --- | --- | --- | --- |
| O-E1 | E2-Quelle (Ubuntu 24.04, UEFI, LUKS2 + LVM, netplan mit `macaddress`), mit `nginx`-Konfiguration und `/etc/hosts`, die die alte Adresse nennen | Debian 12 Cloud, UEFI (OVMF ohne Secure Boot), virtio-scsi statt virtio-blk, 10.0.2.15/32 mit Gateway 10.0.2.2 on-link (Form wie bei Hetzner), statisches IPv6 mit Gateway `fe80::2` on-link, cloud-init | kexec, Restore, `E2E-BOOT`, netplan mit `on-link`, alte Konfiguration unter `/etc/restow/network-before-restore/`, `99-restow-restored.cfg`, SSH-Hostschlüssel unverändert (Fingerabdruck vor und nach), Adressliste über die API, ersetzte `nginx`-Datei mit `.restow-*` daneben, `/etc/hosts` gelassen |
| O-E2 | E1-Quelle (Debian 12, BIOS, MBR, md RAID1, ifupdown statisch) | Debian 12 Cloud, BIOS (SeaBIOS), eine Platte, DHCP | BIOS-Weg, ifupdown-Schreiber mit DHCP, Plattenkennung aus `by-path` |
| O-E3 | E2-Quelle | Ubuntu 24.04 Cloud, UEFI **mit** Secure Boot (OVMF mit Microsoft-Schlüsseln) | Probeladung scheitert, Befehl nennt den Rückfall, **nichts** geändert (Platte bitgleich; die Sitzung bleibt `pending_approval` mit `checks.kexec = failed`, die Oberfläche zeigt den Rückfall statt "Freigeben", nach 30 Minuten `failed`) |
| O-E4 | Ubuntu 22.04, UEFI, hybrides GPT (Cloud-Abbild) | Debian 12 Cloud im BIOS-Modus | O7: UEFI → BIOS, `grub-install --target=i386-pc` |
| O-E5 | E2-Quelle | wie O-E1, Admin lehnt die Freigabe ab | nichts geändert, Rechner startet wie vorher |
| O-E6 | E1-Quelle | Rechner, der aus einem "Rettungssystem" startet (das ISO selbst mit `systemd.mask=restow-recover.service` als Ersatz) | 17.1 mit kexec aus dem Rettungssystem |

O-E1 und O-E2 je PR mit Änderungen an `agent/internal/{baremetal,recovery}`, `agent/install/oneshot.sh`,
`integrations/recovery`, Recovery-API; O-E3 bis O-E6 nachts. kexec in einer KVM-Maschine geht; der
Treiber braucht nichts Neues außer der Seed-Platte. Dauer je Fall etwa wie E2 (10 bis 20 Minuten).

### 19.4 Auf echten Rechnern (Maintainer, vor dem Release)

1. Hetzner Cloud, geteilte vCPU, x86: Debian 12 und Ubuntu 24.04 als frisches Abbild; Quelle ein
   anderer Hetzner-Server (Primary IP umziehen, "behalten") und ein Server eines anderen Anbieters
   ("übernehmen", IPv4 /32 mit `172.31.1.1`, IPv6 mit `fe80::1`). Firmwaremodus, kexec,
   VNC-Konsole zeigt den Fortschritt, cloud-init Datenquelle `Hetzner`.
2. Rettungssystem desselben Anbieters (17.1).
3. AWS EC2 (Nitro, `t3`/`m6i`), Ubuntu 24.04 im BIOS- und im UEFI-Abbild: ENA, NVMe, NAT
   (keine öffentliche Adresse am Rechner), Elastic IP umziehen, serielle Konsole, Secure Boot an
   (erwartet Rückfall), EFI-Variablen nach kexec.
4. Ein Rechner mit 2 GiB RAM (Grenze), einer mit großem Repository (Index).
5. MAC einer Instanz nach Stopp/Start und Größenänderung gleich (10.4).

## 20. Meilensteine

Jeder einzeln mergebar, mit Tests und CHANGELOG-Eintrag; ausgeblendet hinter
`RESTOW_BAREMETAL_PREVIEW` und zusätzlich `RESTOW_BAREMETAL_ONESHOT`, bis die Oberfläche für 0.5.1
steht. Aufwand in Personentagen (PT), grob.

**0.5.1** (Entscheidung des Maintainers): O1 bis O5, dazu aus O7 UEFI → BIOS bei hybridem GPT
(Entscheidung 22.6), dazu die Oberfläche, ohne die der Weg nicht benutzbar ist (Befehl-Dialog,
Freigabe-Seite, Live-Ansicht), so knapp wie möglich.

| | Inhalt | Release | PT |
| --- | --- | --- | ---: |
| **O1** | ISO: `init-bottom/restow-oneshot` samt Hook für das initramfs, CI-Test "Start ohne Medium"; `recover`: Quelle `oneshot` lesen, Konsolen spiegeln, `liveMedium` für `rootfs[…]` (die serielle Konsole ist seit `a3198bd6` behoben) | 0.5.1 | 3 |
| **O2** | Server: Migration 0105, Ausstellen, `oneshot.sh`-Route, Tausch, ISO-Route der Sitzung, `booted`, Freigabe mit Entscheidungen, Monitor, Audit, Postgres-Tests | 0.5.1 | 7 |
| **O3** | `oneshot.sh` und `restow-agent oneshot`: Prüfungen, Erfassen, Tausch, Konsole, ISO laden und prüfen, ISO9660-Leser, cpio im `memfd`, `kexec_file_load`, `systemctl kexec` | 0.5.1 | 9 |
| **O4** | `recover` im Modus `oneshot`: Netz der Recovery-Umgebung (neuer Schreiber), `booted`, Entscheidungen statt Fragen, `confirmErase`, Neustart und Fehlerwege; Direktmodus im Rettungssystem | 0.5.1 | 8 |
| **O5** | Netz übernehmen (vier Stapel, Sicherung der alten Konfiguration, Hardware-Bindungen), cloud-init-Datei und -Entscheidung, Beleg in der Prüfung; UEFI → BIOS bei hybridem GPT (aus O7) | 0.5.1 | 11 |
| **O8a** | Oberfläche 0.5.1: Befehl-Dialog, Freigabe-Seite (Prüfzahl, Gemeldetes, Netzwahl, Kästchen), Live-Ansicht der neuen Phasen; Texte de/en | 0.5.1 | 3 |
| **O6** | Manifest `netState`, Adresssuche, `ip-scan`/`ip-review`, Ersetzen; Abfrage der alten öffentlichen Adresse | 0.5.2 | 6 |
| **O7** | Vorplan im Worker, NIC-Treiber als Problem (ohne UEFI → BIOS, das in O5 liegt) | 0.5.2 | 3 |
| **O8b** | Oberfläche: Adressliste, Checkliste, Feinschliff | 0.5.2 | 3 |
| **O9** | Ende-zu-Ende O-E1 bis O-E6, CI-Verdrahtung; Prüfungen auf echten Rechnern (19.4) | Fälle mit O1 bis O5 in 0.5.1, echte Anbieter 0.5.2 | 6 |
| | **zusammen** | | **59** |

Reihenfolge O1 → O2 → O3 → O4 → O5 → O8a (0.5.1), dann O6, O7, O8b, O9 (0.5.2). Die Migration
kommt mit O2; ändert sich der Entwurf von `oneshot` danach, ändert sich nur das JSON, nicht das
Schema. Bis O6 gibt es keine Suche nach der alten Adresse; die Phase `ip_review` fehlt dann im
Ablauf, und die Checkliste nennt die Suche von Hand.

## 21. Befunde im vorhandenen Code

1. **`serial-getty@ttyS0` neben `recover`** (Fehler in 0.5.0, behoben auf `release/0.5.0` in
   `a3198bd6`, Hook 0100 maskiert `serial-getty@ttyS0` und `@ttyS1`): Die Menüeinträge "serielle
   Konsole" setzen `console=ttyS0 restow.console=ttyS0`; systemd startet dann `serial-getty@ttyS0`,
   `restow-recover.service` hat nur `Conflicts=getty@tty1.service`. In der Probe gingen Eingaben an
   den Login, und `recover` begann seinen Dialog nach jedem Login-Versuch von vorn (Protokoll
   der seriellen Konsole aus der Probe). Behebung: `serial-getty@ttyS0` und `@ttyS1` im Hook
   0100 maskieren oder in die `Conflicts=` aufnehmen; mit `systemd.mask=` geprüft. Die CI sah es
   nicht, weil die Fälle ihre Antworten über `fw_cfg` bekommen.
2. **`StaticNetworkFile`** kann nur eine Adresse und ein Gateway ohne on-link und schaltet IPv6-RA
   und Link-local ab; für `fe80::1` und /32 mit `172.31.1.1` reicht das nicht (10.2). Kein
   Blocker, aber ein neuer Schreiber.
3. **`checkFirmwareMode`** lässt nur BIOS → UEFI bei hybridem GPT zu; UEFI → BIOS fehlt (O7). Für
   Ziele im BIOS-Modus ist das bei UEFI-Quellen ein Blocker.
4. **Antwortquellen** (`answers.go`): Klartext-Passphrase nur über `fw_cfg`; die neue Quelle braucht
   eine eigene, gleichwertige Begründung (9.2), keinen Umweg über `fw_cfg`.
5. **Manifest ohne Adressen:** `captureNetwork` erfasst MAC, Treiber und Dateien mit MACs, keine
   Adressen, Routen, DNS (10.6). Für ältere Sicherungen bleibt nur das Lesen der
   Konfigurationsdateien.
6. **NIC-Treiber fehlt** ist nur eine Warnung im Plan (BM 10.4 Punkt 6); für Cloud-Ziele zu
   schwach (14).
7. **`liveMedium`** nimmt den Basisnamen der Quelle von `/run/live/medium`; im Direktstart ergibt
   `rootfs[/restow/medium]` den Namen `medium]` (unschädlich, aber unklar; 9.3).
8. **`syscall`** hat `SYS_KEXEC_FILE_LOAD` und `SYS_MEMFD_CREATE` nicht; Rohaufrufe 320 und 319
   (amd64) wie BM 1.3 für `openat2`. `LINUX_REBOOT_CMD_KEXEC` ist vorhanden.
9. **live-boot `fromiso=`** mit einer Datei im initramfs scheitert am nicht geladenen Modul `loop`
   (4.2 Punkt 3); der Entwurf nutzt `live-media=<verzeichnis>`. Kein Fehler in Restow.
10. Nicht weiter verfolgt: In der Probe kamen Eingaben in der Shell aus dem Menü von `recover` über
    die serielle Konsole verstümmelt an. Ursache offen (langsames TCG oder ein zweiter Leser auf
    dem Terminal); in O1 auf KVM nachprüfen.

Kein Befund verhindert den Weg: Die Recovery-Sitzung (Tausch, Freigabe, Zugangsdaten, Zustände)
trägt ihn ohne neuen Zustand, `recover` hat mit `--answers` schon einen Modus ohne Fragen, und das
ISO startet ohne Medium.

## 22. Entscheidungen zu den offenen Fragen des Entwurfs

Der Maintainer hat den Entwurf angenommen und die offenen Fragen so entschieden:

1. **Migration** `0105_recovery_oneshot` wie in Abschnitt 7 (`when` echt zwischen 0104 und
   1794943124789): ja.
2. **Vorplan auf dem Server vor der Freigabe** (6.3): ja; umgesetzt in 0.5.2 (O7).
3. **Fernzugang** zur Recovery-Umgebung mit den `authorized_keys` des frischen Rechners: nur über
   ein Kästchen in der Freigabe, **Vorgabe aus** (8.4).
4. **LUKS-Passphrase** nur an der SSH-Konsole, nie über den Server: ja (8.4).
5. **cloud-init-Datei** bleibt dauerhaft und steht in der Checkliste mit dem Weg, sie zu entfernen
   (11.2, 13 Punkt 11).
6. **UEFI → BIOS bei hybridem GPT** in 0.5.1: ja (14, O5).
7. **Direktmodus im Rettungssystem** ohne kexec: ja, als Rückfall für Secure Boot (17.1).
8. **AWS ohne Rettungssystem bzw. mit Secure Boot:** in 0.5.1 nicht unterstützt (17.2).
9. **Alte öffentliche Adresse** bei Sicherungen mit DHCP: Die Oberfläche fragt sie ab, keine
   zweite Migration (10.6).
10. **Adressliste** wartet 60 Minuten, danach weiter ohne Ersetzen (12).
11. **Neustart** 60 Sekunden nach Erfolg, abbrechbar (9.3).
12. **Code** `OS-…`, Sitzung Vorgabe 12 Stunden, wählbar 4 bis 48 (6.1).
13. **Arbeitsspeicher:** mindestens 2 GiB, Warnung unter 4 GiB (15).
14. **Serielle Konsole:** in 0.5.0 behoben (`a3198bd6`), entfällt in O1.
15. **Falscher Rechner:** Abbruch, wenn auf dem Rechner ein Agent eingerichtet ist, sonst Warnungen
    (8.4).

Umfang: 0.5.1 = O1 bis O5 mit UEFI → BIOS aus O7 und der knappen Oberfläche (O8a); 0.5.2 = O6, der
Rest von O7, O8b und die Prüfungen auf echten Rechnern (Abschnitt 20).

### 22.1 Festlegungen und Abweichungen bei der Umsetzung (O1 bis O3)

- **`GET /install/oneshot.sh`** kam mit O3 statt mit O2 (die Route braucht die Vorlage). Sie
  antwortet nur mit `RESTOW_BAREMETAL_PREVIEW` und `RESTOW_BAREMETAL_ONESHOT`, sonst 404.
- **Signaturprüfung im Skript (8.1):** eine Kopie der Funktionen aus `linux.sh`
  (`sha256_of` bis `verify_release`); ein Go-Test (`agent/internal/oneshot/script_test.go`) hält
  beide Kopien gleich. `renderInstallScript` bleibt unverändert.
- **Arbeitsordner des Skripts:** `mktemp -d` unter `/run`; startet der Agent dort nicht (`/run`
  ist auf vielen Systemen `noexec`), dasselbe unter `/var/tmp`. Das ISO legt `restow-agent oneshot`
  unter `/var/tmp/restow-oneshot` ab (0700, beim Ende gelöscht).
- **Release-Schlüssel für das ISO:** `restow-agent oneshot` prüft mit dem Schlüssel, der in ihn
  eingebaut ist (`release-signing.pub`), nicht mit dem Schlüssel aus dem Skript; das Skript hat
  den Agenten selbst mit dem Schlüssel der Instanz geprüft. Mit `RESTOW_SHA256SUMS_SHA256` gilt
  nur genau diese Liste. Das ISO muss vom selben Release sein wie der Befehl (ein Neubau zählt);
  ein Entwicklungsbau (`-dev`) nimmt jedes.
- **Eingerichteter Agent (8.4, Entscheidung 22.15):** `--this-is-not-production` entfällt. Der
  Server gibt eine Sitzung mit `agent_enrolled` ohnehin nicht frei (O2); wer den Rechner wirklich
  löschen will, entfernt den Agenten zuerst (`restow-agent uninstall`), der Text an der Konsole
  sagt das.
- **Nach der Sicherheitsprüfung von O1 bis O3:** Code über `RESTOW_ONESHOT_CODE` statt als
  Argument (8.1, 6.1); Origin des Befehls nur aus Schema, Host und Port (6.1); kein Verlängern
  eines Codes `oneshot` vor dem Tausch, Ende der Sitzung nie vor dem Ende des Codes (6.1); die
  Freigabe trägt die Prüfzahl (6.3); jeder Download des ISO über die Sitzung steht im Audit
  (`endpoint.recovery.iso_downloaded`, 6.4); bei abgeschaltetem `RESTOW_BAREMETAL_ONESHOT` oder
  `RESTOW_BAREMETAL_PREVIEW` antwortet der Tausch wie bei einem unbekannten Code, und ISO-,
  Prüf-, `booted`- und Freigabe-Aufrufe lehnen ab; der Punkt ohne Rückkehr ist `systemctl kexec`
  (5.3). Kernel und initrd werden beim Kopieren in die `memfd`s gehasht und vor
  `kexec_file_load` mit der Prüfung verglichen (statt das ISO vorher noch einmal zu lesen). Als
  eingerichteter Agent zählt auch der Proxmox-VE-Helfer (`/etc/restow-pve/state.json`). Ein
  Abgleich der Adresse, MACs und Plattenseriennummern mit den Rechnern des Mandanten auf dem
  Server unterbleibt: Der Server speichert davon nichts, mit dem er vergleichen könnte.
- **O4, `recover` im Modus `oneshot`:** Die Sitzungsdaten sind eine Antwortquelle eigener Art
  (`SourceOneshot`): Tastatur `us`, Sprache aus den Daten, Zuordnung automatisch, Neustart nach
  Erfolg. Die Instanz wird über die **ganze** SHA-256 des Schlüssels angenommen, die der Befehl
  auf einer gültigen Verbindung sah (kein 16-stelliger Prüfwert), oder über die CA aus den Daten,
  wenn die Systemzertifikate nicht reichen. Das Netz kommt aus `network` als
  `/run/systemd/network/10-restow-oneshot-<n>.network` je Schnittstelle (über die MAC): Adressen
  aus DHCP/SLAAC kommen wieder so, statische fest, Standardrouten nur für statische Adressen, mit
  `GatewayOnLink=yes` bei on-link; jeder Wert wird geprüft, ein unbrauchbares Netz fällt auf DHCP
  zurück. `booted` geht vor jeder anderen Anfrage an die Instanz außer dem Fortschritt; erst dann
  `current` mit den Entscheidungen (Schrumpfen, Secure-Boot-Befunde als Warnungen; `networkMode`
  wirkt ab O5). `confirmErase` ist eine Obergrenze: Jede Platte, die der Plan löscht, muss
  darunter sein, sonst endet der Lauf vor dem ersten Schreiben; vor dem ersten Schritt läuft der
  Countdown von 30 Sekunden. Fernzugang nur, wenn die Freigabe ihn erlaubt **und** die Schlüssel
  der Daten genau die Fingerabdrücke haben, die die Freigabe zeigte (`current` liefert sie als
  `oneshot.sshKeys`); dann `sshd` nur mit diesen Schlüsseln, ohne Passwort. Ende: Erfolg →
  Neustart nach 60 Sekunden (eine Taste stoppt ihn); Fehler vor dem ersten Schreiben → nach 60
  Sekunden Neustart ins eigene System des Rechners (eine Taste stoppt ihn); Fehler danach → kein
  Neustart. Die Sitzungsdaten löscht `recover`, sobald die Instanz das Ende angenommen hat.
  "Abbrechen" des Neustarts in der Oberfläche kommt mit O8a.
- **O4, Direktmodus (17.1):** `curl … | RESTOW_ONESHOT_CODE=… sh -s -- --direct`; das Skript lädt
  und prüft dann auch `restic` und übergibt es mit `--restic` (ein eigenes `--restic` lehnt es
  ab). `restow-agent oneshot --direct` meldet `mode: direct` und `rescue: true`, lädt kein ISO und
  lädt keinen Kernel; es bricht ab, wenn ein Programm aus `recover --list-tools` fehlt oder eine
  Platte des Rechners eingehängt, Swap oder von LVM/md/LUKS gehalten ist. Nach der Freigabe
  schreibt es die Sitzungsdaten nach `/run/restow-oneshot` (0700/0600) und startet `recover`
  im selben Prozess mit `--oneshot <datei> --i-know-this-is-not-the-iso`; danach sind die Daten
  gelöscht. Im Direktmodus ändert `recover` das Netz nicht und schaltet keinen Fernzugang ein
  (das Rettungssystem hat beides), und nach einem Fehler startet es nicht neu.
- **O5, Netz übernehmen (10.4, 10.5, 11):** `agent/internal/baremetal/netwrite.go` (reine
  Funktionen), angewandt von `recover` direkt nach der Freigabe der Lesezugänge, vor den
  Anpassungen der Phase `post` (eine weggenommene Datei überspringt die MAC-Anpassung). Stapel:
  netplan, sobald `/etc/netplan` eine Datei hat; sonst die eine aktivierte Unit
  (`NetworkManager`, `systemd-networkd`, `networking`) unter `/etc/systemd/system/*.wants`; mehrere
  ohne eindeutige Konfiguration → Fehler, kein Raten. Weggenommen (gesichert unter
  `/etc/restow/network-before-restore/<recovery-id>/<pfad>` mit Rechten, Ordner 0700, dazu
  `README`): netplan-
  Dateien mit `ethernets`/`addresses`/`match`, networkd-Dateien mit `Address`/`DHCP`/`Gateway`,
  NetworkManager-Verbindungen vom Typ Ethernet und `ifcfg-*` außer `lo`, ifupdown-Dateien mit
  Schnittstellen außer `lo` (`/etc/network/interfaces` wird zu `lo` plus `source`), dazu udev-
  `*-persistent-net.rules` und `.link`-Dateien mit einer alten MAC. Bei ifupdown bekommt die
  Schnittstelle den Namen, den sie auf dem frischen Rechner hatte, über eine `.link`-Datei auf
  dessen MAC; ein on-link-Gateway ist dort `post-up ip route add default via … onlink`. Die
  Prüfung (10.5) liest networkd-, NetworkManager- und `.link`-Dateien als INI und zählt jede
  statische Adresse in genau einer geschriebenen Datei; `netplan generate` im `chroot` läuft
  nicht (Abweichung; nur CI und echte Rechner zeigen, ob netplan die Datei annimmt). Befunde stehen
  unter dem Prüfpunkt `mount_points` (Punkt 9), die Prüfung behält zehn Punkte; ein Fehler der
  Übernahme ist ein Befund dort, kein Abbruch mitten in der Phase `post`.
- **O5, cloud-init (11.2):** Die Datenquelle des frischen Rechners kommt aus `cloud_name` von
  cloud-init (in den Sitzungsdaten unter `network.cloud`) und einer festen Zuordnung zu den
  Namen der Datenquellen (`hetzner` → `Hetzner`, `aws` → `Ec2`, …); ein unbekannter Anbieter
  zählt als "Datenquelle fehlt". `99-restow-restored.cfg` entsteht in jedem Fall, wo cloud-init
  aktiv ist, mit `network: {config: disabled}`, außer wenn cloud-init das Netz selbst übernimmt.
  "Alte Konfiguration behalten" nimmt neben der MAC-Anpassung auch die Bindungen an alte MACs weg
  und schaltet das Netz von cloud-init ab (sonst schriebe cloud-init auf der neuen Instanz ein
  eigenes Netz über das behaltene).
- **O5, UEFI → BIOS (14, aus O7):** Neue Tatsache `grubBios` (liest `recover` nur für
  UEFI-Systeme aus dem Snapshot: `/usr/lib/grub/i386-pc/modinfo.sh` oder `boot.img`). Mit GRUB,
  einer Platte mit ESP **und** BIOS-Boot-Partition und `grubBios` gibt es statt
  `firmware_mode_mismatch` die Warnung `firmware_mode_switched` und `grub-install
  --target=i386-pc` auf diese Platte. Die Prüfung der Stufe 1 im Worker liefert `grubBios` nicht
  und zeigt für BIOS-Ziele eines UEFI-Systems weiter den Befund.
- **Nach der zweiten Sicherheitsprüfung (O4, O5):**
  - Direktmodus: "Platte in Gebrauch" wird über Gerätenummern erkannt (`major:minor` aus
    `/proc/self/mountinfo`, der Swap-Bereiche, von `/`, `/proc/self/exe` und restic gegen
    `/sys/block/<platte>[/<partition>]/dev`), zusätzlich über Namen und Halter; eine Wurzel als
    `/dev/root` ohne initramfs verdeckt die Platte nicht mehr.
  - `recover` legt vor dem ersten Schreiben neben den Sitzungsdaten die Marke `writing` an
    (0600, `O_EXCL|O_NOFOLLOW`); ohne Marke schreibt es nicht. Ein nach einem Absturz neu
    gestartetes `recover` findet sie, sagt es an der Konsole und startet bei einem Fehler nicht
    neu.
  - Netzübernahme ganz oder gar nicht: zuerst jeder Pfad geprüft (kein Link, kein Ordner), dann
    gesichert, die neuen Dateien geschrieben, zurückgelesen und geprüft, erst dann die alten
    weggenommen; jeder Fehler stellt den Zustand aus der Sicherung wieder her. Die Sicherung liegt
    je Wiederherstellung unter `/etc/restow/network-before-restore/<recovery-id>/`, ein README
    oben listet die Ordner. Die Prüfung zählt Adressen geparst (Adresse und Präfix).
  - `oneshot.sh` nimmt nur genau `--direct`; `-direct`, `--direct=…` und jede Form von
    `--restic` lehnt es ab.
- **Für O8a:** Die Oberfläche zeigt "gebootet" nur aus `oneshot.booted` (dem Bericht von
  `recover`), nie aus einer Phase des Fortschritts. **Für O4:** `recover` schaltet `sshd` mit den
  Schlüsseln aus `oneshot.json` nur ein, wenn ihre Fingerabdrücke genau die sind, die der Admin in
  `reported.sshKeys` gesehen und freigegeben hat; sonst kein Fernzugang.
- **Unbeaufsichtigt (8.4):** `--answers` im Format `restow-oneshot-answers-v1` mit
  `confirmErase`, `passphrase`, `language`, `keymap`; ein Schlüssel `code` wird abgelehnt.
  Jede bestätigte Kennung muss eine Platte dieses Rechners sein.
- **Prüfungen (8.2):** Xen PV an `/sys/hypervisor/guest_type`; mehrere Routing-Tabellen an
  `ip -j rule show` (jede Tabelle außer `local`, `main`, `default`); `kexec_load_disabled` beendet
  den Befehl **vor** dem Tausch, der Code bleibt gültig. Die Probeladung (Kernel und das initrd
  des ISO allein) liegt nach dem Laden des ISO und vor der Bestätigung an der Konsole; scheitert
  sie, meldet der Befehl `checks.kexec = failed` und endet; den Direktmodus im Rettungssystem
  bringt O4.
- **"Mehr als 5 GB belegt"** misst den belegten Platz von `/`, `/home`, `/srv`, `/var` und `/opt`
  (jedes Dateisystem einmal) abzüglich der Blöcke unter `/usr` und `/var/cache`.
- **Phasen:** `registered` nach dem Tausch, `downloading`, `waiting_approval`, `kexec`;
  `booted` meldet `recover` (O4).
- **Rückgabewerte** von `restow-agent oneshot`: 0 umgeschaltet, 1 Fehler, 2 Aufruf,
  3 abgelehnt (Prüfung, ISO, Probeladung), 4 beendet (Sitzung abgelehnt, abgelaufen, abgebrochen,
  nicht bestätigt). Außer bei 0 ist am Rechner nichts geändert.
- **Ende zu Ende:** Die Fälle O-E1 bis O-E6 stehen als Daten in
  `scripts/recovery-e2e/oneshot-cases.mjs` (mit Test); Treiber, Seed-Platte und gepinnte
  Cloud-Abbilder kommen mit O9.

## 23. Entscheidungen

### 23.A Entscheidungen des Maintainers

1. Bare-Metal-Wiederherstellung auf einen frischen Cloud-Rechner ohne ISO; Linux only, Windows
   außen vor.
2. Bedienung: Restore › Bare Metal › "Auf einen frischen Rechner (Link)"; ein Befehl, 30 Minuten
   gültig, einmal, nur mit Einmalcode.
3. Das Skript kommt per TLS vom Restow-Server, prüft root, Architektur, RAM, kexec, Secure Boot, lädt
   Kernel und initramfs mit Prüfung, erfasst das Netz und zeigt Kurzcode und Hardware.
4. Freigabe in der Oberfläche für genau diesen Rechner, erst danach Schlüssel für die
   Recovery-Umgebung; ein gestohlener Link allein genügt nicht.
5. kexec in die Recovery-Umgebung im RAM; Fortschritt in der Oberfläche und auf der Konsole des
   Anbieters; der bestehende Ablauf von `recover` mit Plan, Löschen, Übernahme, Bootloader,
   Neustartregel.
6. Rückfall ohne kexec: Rettungssystem des Anbieters mit demselben Befehl; AWS ohne Rettungssystem
   als Handweg oder nicht unterstützt.
7. Netz: gleicher Anbieter → öffentliche Adresse umziehen und alte Konfiguration behalten; sonst
   Vorgabe "Netz des Ziels übernehmen" mit Erfassung, Schreiben im Format des Systems, DHCP wo DHCP,
   Zuordnung ohne alte MAC, alte Konfiguration unter `/etc/restow/network-before-restore/`, Wahl in
   der Oberfläche.
8. cloud-init darf im wiederhergestellten System nur noch das Netz einrichten.
9. Suche nach der alten Adresse mit Liste in der Oberfläche, Ersetzen nur nach Bestätigung je Datei.
10. Checkliste außerhalb des Rechners; Anbieterwechsel mit NAT, initramfs für die Zielhardware,
    BIOS/UEFI-Erkennung.
11. Eine Migration in 0.5.1 heißt 0105 mit `when` zwischen 0104 und dem `when` von `0105_databases`
    in 0.6.0; ohne Migration, wenn die Tabellen es sauber tragen.

### 23.B Entscheidungen dieses Entwurfs (vom Maintainer angenommen)

1. Recovery-Umgebung **aus dem signierten ISO** (Kernel, initrd, squashfs entnommen), kein neuer
   Release-Anhang, kein vom Server entpacktes Abbild (5.1).
2. squashfs **im angehängten cpio**, nicht über `fetch=` (4.3); Medium über `live-media=<ordner>`,
   nicht `fromiso=` (4.2).
3. Eintausch **vor** dem Umschalten durch `restow-agent oneshot`, Sitzungsgeheimnis im `memfd` in die
   Recovery-Umgebung (5.2); Freigabe vor dem Umschalten, damit eine Ablehnung nichts am Rechner
   ändert.
4. Löschbestätigung an der SSH-Konsole, Entscheidungen (Netz, Schrumpfen, Secure-Boot-Warnungen) in
   der Oberfläche (8.4, 6.3).
5. Die Probeladung entscheidet über kexec, keine Tabelle (16).
6. Eine Migration (7), Entscheidungen und Meldungen getrennt im JSON.
7. cloud-init über eine Datei in `cloud.cfg.d` mit leeren Modullisten, ohne Eingriff in
   `/var/lib/cloud` (11).
