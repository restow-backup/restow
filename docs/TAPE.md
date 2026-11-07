# LTO-Bandlaufwerke (Entwurf, Roadmap nach 0.5.0)

Stand: Planung, nichts davon ist umgesetzt. Entscheidungen des Maintainers (November 2026):

- Band kommt auf die Roadmap, wenn es sinnvoll machbar ist, **frühestens für 0.7**, und **nur für
  vollständige Tages-, Wochen-, Monats- und Jahressicherungen**.
- **Ab LTO-8**, ältere Generationen werden nicht unterstützt (keine Altlasten).
- **Mail** (Postfächer, M365, Mail-Archiv) kommt auf Band, wenn der Admin es im Band-Job wählt.
- Je Band-Job wählbar: **ein Satz je Mandant oder Mandanten kombiniert**.

Dieses Dokument hält fest, wie das gebaut würde und was vorher zu klären ist.

## 0. Kurzfassung

- Band ist **kein Speicherziel** wie Platte oder S3, sondern eine **Auslagerungskopie**: ein
  Band-Job schreibt in festem Takt einen in sich geschlossenen Vollstand am Stück auf Band, prüft
  ihn durch Zurücklesen und meldet erst dann grün. Danach kann das Band offline gehen (Schutz
  gegen Ransomware, Kopie außer Haus, 3-2-1).
- Jeder Satz ist **für sich allein wiederherstellbar**: ein eigenes restic-Repository nur mit den
  Ständen dieses Satzes, dazu Inhaltsverzeichnis und Prüfsummen. Kein Satz hängt von einem
  früheren Band ab.
- **Medienpools nach Großvater-Vater-Sohn** (Tag, Woche, Monat, Jahr) mit eigener Aufbewahrung;
  ein Band wird erst nach Ablauf wieder überschrieben. WORM-Kassetten für Compliance.
- **Linux braucht keine Herstellertreiber**: Laufwerke über den Kernel-Treiber `st`, Wechsler über
  `sg`. Restow bleibt in Docker; das Gerät wird mit `devices:` freigegeben.
- **Empfohlener Aufbau: ein Bandknoten**, also ein Worker-Knoten der Cluster-Funktion mit dem
  Laufwerk, der nur Band-Jobs übernimmt. Der Hauptserver bleibt unberührt.
- **Wiederherstellung**: Satz vom Band auf Platte zurücklesen, dann der normale Weg. Ohne
  Restow-Server mit Master-Key und `restow-restore`.

## 1. Ausgangslage

- Ein restic-Repository besteht aus vielen kleinen Dateien (Packs, Index, Snapshots), auf die
  Sicherung, Prüfung und das Aufräumen alter Stände wahlfrei zugreifen. Ein Band liest und
  schreibt nur sequenziell.
- Mit LTFS lässt sich ein Band wie ein Dateisystem einhängen. Für ein lebendes Repository ist das
  trotzdem ungeeignet: wahlfreie Zugriffe bedeuten Spulen, und gelöschter Platz wird erst beim
  Neuformatieren des ganzen Bandes frei.
- Daraus folgt der Ansatz dieses Entwurfs: Band nur für abgeschlossene, unveränderliche Vollstände,
  die am Stück geschrieben und am Stück gelesen werden.

## 2. Ziele und Nicht-Ziele

**Ziele**

1. Vollstände auf Band in den Rhythmen Tag, Woche, Monat, Jahr (jeder Rhythmus optional).
2. Jeder Satz eigenständig wiederherstellbar, auch ohne Restow-Datenbank.
3. Nachweis: grün erst nach Zurücklesen und Prüfsummenvergleich; regelmäßige Stichproben-Restores.
4. Medienverwaltung: Pools, Aufbewahrung, Barcodes, Wechsler-Fächer, Auslagerungsstatus, Alarme.
5. Betrieb auf echter Hardware, in einer Proxmox-VM mit durchgereichtem HBA und (eingeschränkt) in
   einem LXC.

**Nicht-Ziele**

- Kein Band als primäres oder laufendes Speicherziel, keine inkrementellen Sicherungen auf Band.
- Kein LTFS-Repository.
- Keine Unterstützung von Bandlaufwerken unter Windows oder macOS (Band hängt am Bandknoten, der
  Linux ist).
- Keine Hardware-Verschlüsselung des Laufwerks als Pflicht: Die Daten sind bereits durch restic
  verschlüsselt (siehe 9).

## 3. Hardware

- **Laufwerke:** ab LTO-8, Einzellaufwerk oder Wechsler (Autoloader, Library). Native Kapazität
  und Rate grob: LTO-8 12 TB / 360 MB/s, LTO-9 18 TB / 400 MB/s, LTO-10 30 TB (Herstellerangabe,
  vor der Umsetzung prüfen).
- **Kompatibilität zwischen Generationen** (vor der Umsetzung mit Datenblättern bestätigen):
  - Seit LTO-8 liest ein Laufwerk nur noch **eine** Generation zurück, nicht mehr zwei: LTO-8
    liest und schreibt LTO-7, LTO-9 liest und schreibt LTO-8.
  - LTO-10 ist nach Herstellerangaben gar nicht rückwärtskompatibel: Es nimmt nur LTO-10-Bänder.
  - LTO-9 kalibriert ein neues Band beim ersten Einlegen (Medienoptimierung, je Band von einigen
    Minuten bis über eine Stunde). Der Band-Job muss das einplanen und darf es nicht als Hänger
    werten.
  - Folge: Restow verlässt sich nicht auf Rückwärtskompatibilität. Unterstützt werden Laufwerke
    und Bänder ab LTO-8 (LTO-7-Bänder im LTO-8-Laufwerk nicht). Für Jahressätze, die länger
    liegen als eine Laufwerksgeneration lebt, gibt es eine **Umkopier-Funktion**: Sätze werden
    vom alten Band über den Zwischenspeicher auf neue Medien geschrieben, geprüft und das alte
    Band erst danach freigegeben.
- **Anschluss:** SAS (selten FC). Ein SAS-HBA im IT-Modus, kein RAID-Controller.
- **Wechsler:** über SCSI Media Changer; Barcode-Leser für die Inventur.
- **WORM:** LTO-WORM-Kassetten werden unterstützt (einmal beschreibbar).

## 4. Linux und Treiber

- **Laufwerk:** Kernel-Treiber `st`. Restow nutzt ausschließlich das nicht zurückspulende Gerät
  `/dev/nstN`, damit mehrere Dateien hintereinander auf ein Band passen.
- **Wechsler:** generischer SCSI-Treiber `sg` (`/dev/sgN`), angesprochen wie `mtx`.
- **Werkzeuge im Image:** `mt-st`, `mtx`, `sg3_utils` (für Laufwerksinformationen, TapeAlert,
  Seriennummern). Keine Herstellertreiber, keine Kernel-Module von Drittanbietern.
- **Hardware-Kompression aus:** restic-Daten sind komprimiert und verschlüsselt, Laufwerks-
  kompression bringt nichts und kostet Rate.
- **Blockgröße:** fest (Vorschlag 1 MiB), im Satz-Etikett vermerkt, damit das Lesen ohne Raten
  funktioniert.

## 5. Aufbau

| Wo Restow läuft | Was nötig ist | Bewertung |
| --- | --- | --- |
| Linux auf echter Hardware, Docker | HBA im Rechner, `devices:` im Compose (`/dev/nst0`, `/dev/sgN`) | empfohlen |
| Proxmox-VM, Docker in der VM | HBA per PCIe-Passthrough (IOMMU, `hostpci`) an die VM, dann `devices:` | empfohlen, wenn virtualisiert |
| Proxmox-LXC, Docker im LXC | Geräte vom Host in den LXC binden (cgroup-Freigabe), dann `devices:` | möglich, hängt am Host-Kernel |
| Proxmox-VM mit einzelnem SCSI-Gerät über virtio-scsi | nur mit handgeschriebenen QEMU-Argumenten | nicht unterstützt |

- **Docker** braucht kein Passthrough: Der Container teilt den Kernel des Hosts, `--device` gibt
  nur den Gerätezugriff frei. Ein privilegierter Container ist nicht nötig.
- **Bandknoten:** ein Worker-Knoten der Cluster-Funktion (Installation › Cluster,
  `install.sh --join`) mit dem Laufwerk. Er übernimmt nur die neue Warteschlange `tape`, alle
  anderen Knoten schließen sie aus (`RESTOW_WORKER_EXCLUDE_QUEUES`). Der Knoten meldet sein
  Laufwerk und seinen Wechsler mit Seriennummern an den Server.
- **Zwischenspeicher:** Der Bandknoten braucht lokalen Plattenplatz in Größe des größten Satzes,
  schnell genug, um das Laufwerk durchgehend zu bedienen (siehe 6).

## 6. Datenfluss eines Band-Jobs

1. **Auswahl:** Der Job nennt die Objekte (Rechner, VMs, Container, Dateifreigaben; Postfächer,
   M365 und Mail-Archiv, wenn der Admin sie im Job wählt) und nimmt je Objekt den neuesten
   grünen Stand zum Stichzeitpunkt. Der Job legt fest, ob je Mandant ein eigener Satz entsteht
   oder die Mandanten in einem Satz kombiniert werden (siehe 7).
2. **Zusammenstellen:** `restic copy` der gewählten Stände in ein **neues, leeres Repository** im
   Zwischenspeicher des Bandknotens, mit eigenem Passwort. Die Repositories der Objekte bleiben
   unverändert.
3. **Prüfen vor dem Schreiben:** `restic check` auf dem Satz-Repository.
4. **Schreiben am Stück:** Etikett, Inhaltsverzeichnis, dann die Dateien des Repositories als
   ein Strom (eigenes, einfaches Containerformat oder tar mit festen Blöcken), dann Prüfsummen und
   ein Abschluss-Etikett. Ein Satz kann über mehrere Bänder gehen; jedes Band trägt Folgenummer
   und Satzkennung.
5. **Zurücklesen:** Das Band wird zurückgespult und vollständig gelesen; jede Datei wird gegen die
   Prüfsumme verglichen. Erst dann gilt der Satz als geschrieben.
6. **Aufräumen:** Der Zwischenspeicher wird geleert. Das Band wird im Inventar als belegt mit
   Ablaufdatum geführt; bei einem Wechsler wird es in sein Fach gelegt oder zum Auslagern
   gemeldet.

**Datenrate:** Ein Band muss durchgehend beschrieben werden, sonst stoppt und spult das Laufwerk
ständig und verschleißt (shoe-shining). Deshalb wird nie direkt aus den Speicherzielen gestreamt,
sondern immer aus dem Zwischenspeicher. Liegt die gemessene Rate unter dem Minimum des Laufwerks,
warnt der Job im Bericht.

## 7. Bandformat

- **Etikett am Bandanfang:** Kennung „Restow-Bandsatz“, Format-Version, Satzkennung, Pool,
  Rhythmus, Stichzeitpunkt, Folgenummer, Blockgröße, Mandant(en).
- **Inhaltsverzeichnis:** jede Datei mit Pfad im Repository, Größe, SHA-256; dazu die Liste der
  enthaltenen Objekte und Stände (lesbar ohne Datenbank).
- **Schlüssel:** das Passwort des Satz-Repositories, mit dem Master-Key verpackt (wie die
  Mandantenschlüssel heute). Wer den Master-Key hat, kann den Satz öffnen; wer nur das Band hat,
  nicht.
- **Abschluss-Etikett:** Prüfsumme über das Inhaltsverzeichnis, Anzahl Dateien und Bytes.
- **Je Mandant oder kombiniert** (Einstellung im Band-Job):
  - *Je Mandant:* ein Satz und ein Repository je Mandant, verpackt mit dem Schlüssel dieses
    Mandanten. Ein Satz lässt sich einem Kunden mitgeben oder für ihn allein vernichten; mehr
    Etiketten und Bandwechsel.
  - *Kombiniert:* ein Satz mit einem Repository je Mandant hintereinander auf denselben Bändern.
    Spart Bänder und Wechsel; ein Band trägt dann Daten mehrerer Kunden, das Inhaltsverzeichnis
    nennt sie, und ein einzelner Kunde lässt sich nicht getrennt herausgeben oder vernichten.
  - Mandanten werden auch kombiniert nie in ein gemeinsames Repository gemischt.
- Ein Satz ohne gültiges Abschluss-Etikett gilt als unvollständig und wird nie als grün geführt.

## 8. Medienverwaltung

- **Pools:** je Rhythmus ein Pool (Tag, Woche, Monat, Jahr) mit eigener Aufbewahrung
  (Vorschlag: Tag 14 Tage, Woche 8 Wochen, Monat 12 Monate, Jahr 10 Jahre, einstellbar).
- **Bänder:** nach Barcode erfasst (bei Einzellaufwerken nach Etikett beim ersten Einlegen), mit
  Pool, Generation, WORM ja/nein, Schreibzahl, Fehlerzählern aus TapeAlert, Ort (im Wechsler,
  ausgelagert, im Tresor).
- **Wiederverwendung:** Ein Band wird erst überschrieben, wenn alle Sätze darauf abgelaufen sind
  und kein Legal Hold sie betrifft. Überschreiben verlangt die Bestätigung im Job-Lauf, wenn das
  Band nicht im erwarteten Pool ist.
- **Alarme:** kein passendes Band verfügbar, Laufwerk meldet Reinigungsbedarf oder Fehler, Satz
  nicht zurücklesbar, Band überfällig für die Auslagerung, Rate zu niedrig.
- **Bericht:** je Satz, welche Objekte und Stände er enthält; je Objekt, auf welchen Bändern sein
  letzter Tages-, Wochen-, Monats- und Jahresstand liegt.

## 9. Sicherheit

- Daten auf Band sind durch restic verschlüsselt; das Satz-Passwort liegt nur mit dem Master-Key
  verpackt auf dem Band.
- Laufwerksverschlüsselung (LTO AES) ist optional und nicht nötig; bei Bedarf später mit eigenem
  Schlüsselmanagement.
- WORM-Kassetten verhindern das Überschreiben auch bei kompromittiertem Server.
- Jeder Schreib-, Lese-, Lösch- und Inventurvorgang wird im Audit-Log festgehalten.
- Wiederherstellungsmodus und Löschschutz gelten auch für Band: Ein Band wird im
  Wiederherstellungsmodus nicht überschrieben.

## 10. Wiederherstellung

- **Mit Restow-Server:** Satz auswählen, Band einlegen lassen (oder der Wechsler holt es),
  Satz-Repository in den Zwischenspeicher zurücklesen und prüfen. Danach öffnet Restow es wie ein
  normales Speicherziel nur zum Lesen: Dateien herunterladen, Rechner wiederherstellen,
  Bare-Metal-Recovery über das Recovery-ISO, VMs und Container zurückspielen.
- **Ohne Restow-Server (Katastrophenfall):** `restow-restore tape read` liest einen Satz mit dem
  Master-Key auf Platte, danach greift der bekannte Weg von `restow-restore` auf das
  Repository.
- **Bare Metal:** Das Recovery-ISO muss kein Band lesen können; der Satz wird vorher auf Platte
  gebracht und von dort wie jeder andere Stand verwendet.

## 11. Prüfung ("grün heißt Beweis")

- Pflicht: vollständiges Zurücklesen jedes Satzes nach dem Schreiben.
- Regelmäßig (Vorschlag monatlich je Pool): Stichprobe eines älteren Bandes zurücklesen und einen
  Stand daraus testweise wiederherstellen, wie die bestehenden Wiederherstellungsprüfungen.
- Ein Band, das beim Zurücklesen Fehler meldet, wird gesperrt und als zu ersetzen gemeldet.

## 12. Tests

- **CI ohne Hardware:** virtuelle Bandbibliothek `mhvtl` (Linux, emuliert Laufwerke und
  Wechsler über `st` und `sg`) in einem eigenen CI-Job: Schreiben, Zurücklesen, Bandwechsel über
  mehrere Bänder, Wechsler-Inventur, Fehler beim Lesen, Wiederherstellung ohne Server.
- **Echte Hardware vor der Freigabe:** mindestens eine Matrix aus zwei LTO-Generationen ab LTO-8,
  Einzellaufwerk und Wechsler, Bare Metal und Proxmox-VM mit durchgereichtem HBA; Messung der
  Rate gegen das Minimum des Laufwerks.

## 13. Meilensteine (Vorschlag)

Ziel-Release: frühestens 0.7.

| T | Inhalt |
| --- | --- |
| T1 | Bandknoten: Warteschlange `tape`, Laufwerks- und Wechslererkennung, Inventar, mhvtl-CI |
| T2 | Satzformat, Schreiben mit Zwischenspeicher, Zurücklesen, Bericht |
| T3 | Pools nach Großvater-Vater-Sohn, Aufbewahrung, Wiederverwendung, WORM, Alarme |
| T4 | Wiederherstellung mit Server und `restow-restore tape read` ohne Server |
| T5 | Regelmäßige Stichprobenprüfung, Oberfläche für Auslagerung und Tresor, Hardware-Gate |

## 14. Offene Fragen an den Maintainer

Entschieden (November 2026): ab LTO-8; Mail auf Wunsch des Admins; je Mandant oder kombiniert
wählbar; frühestens 0.7. Noch offen:

1. Edition: Band nur ab Business oder Service Provider?
2. Testhardware: Für das Hardware-Gate (12) braucht es mindestens ein LTO-8- oder LTO-9-Laufwerk
   mit SAS-HBA, besser auch einen kleinen Wechsler; heute ist keins im Einsatz.
