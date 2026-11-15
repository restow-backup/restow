# Datenbanken (Entwurf für 0.6.0)

Stand: Entwurf, noch nicht umgesetzt. Ziel ist Restow 0.6.0 für den Modus Sicherung, 0.6.x für
Point-in-Time, 0.7.0 für die warme Kopie. Entscheidungen von Lucas Flores (November 2026):

- **E1** Version 0.6.0, nicht 0.5.x.
- **E2** Eigenes Modul "Datenbanken": standardmäßig aus, im Menü nur, wenn eingeschaltet.
- **E3** Die native SQL-Server-Sicherung (0.5.0, docs/AGENT.md "SQL Server", docs/BAREMETAL-WINDOWS.md
  5.1) zieht in dieses Modul um; die Rechnerseite behält einen Verweis.
- **E4** Zuschnitt: Eine Datenbank wird **ohne** Sicherung des ganzen Servers geschützt. Der
  Administrator gibt eine Adresse und einen Benutzer (Backup-Benutzer oder Admin) ein, fertig.
  Engines: PostgreSQL, MySQL und MariaDB, Microsoft SQL Server, SQLite. Restow erkennt die
  Engine selbst, sichert im Zeitplan (auch stündlich), prüft und zeigt Healthchecks mit Verlauf.
  MongoDB kommt später.
- **E5** Die Prüfung läuft auf der Instanz des Kunden, wenn der Benutzer die Rechte dafür hat
  (wie bei SQL Server); sonst siehe offene Frage F1.
- **E6** Die Verbindung baut wahlweise ein Agent im Kundennetz oder der Restow-Server selbst auf.
  Zugangsdaten liegen dafür verschlüsselt im Geheimnisspeicher des Servers (wie IMAP-Kennwörter),
  **nicht** mehr nur lokal auf dem Rechner. Die Anmeldung über den Socket ohne Kennwort bleibt
  für einen Agenten auf dem Datenbankrechner.
- **E7** PostgreSQL und MySQL auf Windows-Rechnern kommen nach 0.6.0 (SQL Server läuft dort
  schon).
- **E8** Drei Modi je Verbindung: **Sicherung** (0.6.0), **Point-in-Time** (0.6.x), **warme
  Kopie** (0.7.0). Eine laufend replizierte Bereitschaftsinstanz (Streaming-Standby) baut Restow
  nicht; sie ist ein Betriebsfall des Kunden mit eigenem Failover (Abschnitt 7.3).

Markierungen wie in docs/BAREMETAL-WINDOWS.md: **[CI]** = in der CI zu belegen, bevor es
irgendwo behauptet wird; **[HW]** = auf echter Hardware zu belegen; ohne Markierung = Entwurf.

## 1. Grundsatz: Dump für die Datenbank, Snapshot für die Maschine

Restow sichert eine Datenbank auf zwei Wegen, die sich ergänzen und nicht ersetzen:

| | Datenbank-Modul (Dump bzw. Basissicherung mit Log) | Dateisystem-Snapshot (LVM, btrfs, VSS) |
|---|---|---|
| Konsistenz | transaktionskonsistent je Datenbank (Dump) bzw. je Cluster zu jedem Zeitpunkt (Point-in-Time) | absturzkonsistent, nur wenn Daten, WAL bzw. Redo-Log und alle Tablespaces im **selben** atomaren Snapshot liegen |
| Einzelne Datenbank zurück | ja, auch unter neuem Namen | nein, nur der ganze Cluster bzw. die ganze Instanz |
| Andere Hauptversion beim Restore | ja (Dump) | nein |
| Prüfbar | ja: Restore-Probe in eine Wegwerf-Datenbank | nur durch Start der ganzen Instanz |
| Zweck | eine Datenbank wiederherstellen | die ganze Maschine wiederherstellen (Bare Metal) |

Daraus folgt:

- Ist eine Datenbank im Modul geschützt und läuft auf einem Rechner mit Restow-Agent, schließt
  die **Dateisicherung** dieses Rechners ihren Datenordner aus (doppelt und ohne Wert, wie bei
  SQL Server, docs/BAREMETAL-WINDOWS.md 3.8). Das **Bare-Metal-Image** enthält ihn weiter, damit
  die Maschine als Ganzes startet.
- Restow behauptet nirgends, dass ein Snapshot eine Datenbank sichert; die Oberfläche nennt nur
  das Modul eine Datenbanksicherung. Ein LVM-Snapshot gilt je logischem Volume: Liegen Daten und
  WAL auf verschiedenen Volumes, ist die Kopie nicht einmal absturzkonsistent.
- Ein Dump über mehrere Datenbanken ist **kein** gemeinsamer Zeitpunkt: jede Datenbank hat ihren
  eigenen konsistenten Stand. Einen gemeinsamen Zeitpunkt für alle Datenbanken eines Clusters
  gibt es nur im Modus Point-in-Time.

## 2. Das Modul "Datenbanken"

### 2.1 Modul und Menü

- Neue Modul-ID `databases` in `MODULE_IDS` (apps/web `lib/modules.ts` und apps/api
  `lib/modules.ts`, gleiche Liste). Bezeichnung "Datenbanken" (en: "Databases").
- `settings.modules` speichert die **ausgeschalteten** Module (Migration 0094); ein neues Modul
  wäre in jeder bestehenden Installation sofort an. Die Migration schreibt `databases` darum in
  die Liste der ausgeschalteten Module, **außer** irgendein Job der Installation hat die native
  SQL-Server-Sicherung an: Dann bleibt das Modul an, damit nichts verschwindet, was schon genutzt
  wird.
- Der Einrichtungsassistent fragt das Modul mit den anderen ab, Vorgabe aus. Installation ›
  Module schaltet es später.
- Wie jedes Modul blendet es nur aus (Menü, Karten der Übersicht, "Neu anlegen", Befehlspalette);
  die Seiten bleiben über ihre Adresse erreichbar und sagen, dass das Modul ausgeblendet ist.
- Keine Edition-Sperre für den Modus Sicherung. Ob Point-in-Time und warme Kopie an eine Edition
  gebunden werden, ist offene Frage F3.

### 2.2 Begriffe

- **Verbindung:** eine Adresse (Instanz) mit Anmeldung, Ausführer, Modus und Zeitplan. Eine
  Verbindung schützt alle Datenbanken der Instanz oder eine Auswahl.
- **Datenbank:** eine Datenbank bzw. ein Schema einer Verbindung, mit eigener Geschichte
  (Identität 3.3), eigenen Sicherungen, Prüfungen und Bewertung.
- **Ausführer:** wer die Verbindung aufbaut und die Programme startet: ein Agent (Abschnitt 4.1)
  oder der Restow-Server (4.2).

### 2.3 Seiten

- **Datenbanken** (`/databases`, Menüpunkt im Bereich Schutz): Liste aller Datenbanken des
  Mandanten. Spalten: Engine, Datenbank, Verbindung, Modus, Größe, letzte Sicherung, letzte
  Prüfung, Erreichbarkeit (Punkt mit Verlauf der letzten 24 Stunden), Bewertung. Filter nach
  Engine, Verbindung, Modus und Bewertung; die Sortierung beginnt mit Rot, dann Nicht erreichbar,
  Überfällig, Ungeprüft.
- **Datenbank hinzufügen** (Dialog, Abschnitt 3): ein Feld für die Adresse, eines für den
  Benutzer, eines für das Kennwort, dazu der Ausführer. "Verbindung prüfen" zeigt Engine,
  Version, gefundene Datenbanken und **was dieser Benutzer erlaubt** (Rechte-Matrix 3.2), bevor
  gespeichert wird. Danach Modus und Zeitplan (Vorgabe: Sicherung, stündlich, Aufbewahrung wie die
  Vorgabe des Mandanten).
- **Verbindung** (`/databases/connections/:id`): Ausführer, Anmeldung (geht, fehlt, mit
  Anleitung), TLS-Fingerabdruck, Modus, Zeitplan, Auswahl der Datenbanken, Healthcheck-Verlauf der
  Instanz (Abschnitt 8).
- **Datenbank** (`/databases/:id`): Sicherungen (Zeitpunkt, Größe, SHA-256, Snapshot),
  Prüfberichte mit Beleg, Healthcheck-Verlauf (Größe, Wachstum), Aktionen "Wiederherstellen",
  "Jetzt sichern", "Jetzt prüfen", "Herunterladen", "Restore-Anleitung". Im Modus Point-in-Time
  zusätzlich die Zeitleiste des wiederherstellbaren Bereichs (7.2).
- **Rechnerseite:** Der Reiter "SQL" wird zum Reiter "Datenbanken" mit den Verbindungen, die
  dieser Rechner ausführt, und den Datenbanken, die seine Inventur gefunden hat (3.4). Die
  bisherigen Adressen des SQL-Reiters leiten weiter.

### 2.4 Bewertung und Alarme

Je Datenbank: `not_protected`, `unverified`, `green`, `red`, `overdue` (letzte grüne Prüfung
älter als 8 Tage bzw. letzte Sicherung älter als das Dreifache des Zeitplans, mindestens
24 Stunden). Die Erreichbarkeit ist eine eigene Anzeige neben der Bewertung, keine Bewertung: Eine
Datenbank, die gerade nicht erreichbar ist, hat trotzdem gute Sicherungen.

Neue Alarme (Gruppe `jobs`, je einmal je Episode): `database.red`, `database.recovered`,
`database.overdue`, `database.unreachable` (nach drei fehlgeschlagenen Healthchecks in Folge),
`database.reachable`, im Modus Point-in-Time `database.pitr_lag` (Rückstand über der Grenze,
7.2). Die SQL-Server-Alarme `endpoint.sql_*` bleiben unter ihrem Namen, damit bestehende
Benachrichtigungsregeln weiter greifen; die Benachrichtigungsmatrix zeigt beide unter
"Datenbanken".

## 3. Verbindung anlegen

### 3.1 Adresse und Erkennung der Engine

Das Adressfeld nimmt:

- eine URL: `postgres://` bzw. `postgresql://`, `mysql://`, `mariadb://`, `sqlserver://`
  (Benutzer und Kennwort in der URL werden in die Felder übernommen und aus der Adresse
  entfernt, nie gespeichert, wie sie eingegeben wurde);
- `host:port` oder nur `host`: Restow erkennt die Engine am ersten Austausch des Protokolls
  **[CI]**:
  - **MySQL/MariaDB:** Der Server schickt zuerst ein Begrüßungspaket mit Versionstext; MariaDB
    nennt sich darin selbst.
  - **PostgreSQL:** Antwort auf eine `SSLRequest` (ein Byte `S` oder `N`).
  - **SQL Server:** Antwort auf ein TDS-`PRELOGIN`.
  - Ohne Port probiert Restow 5432, 3306 und 1433 in dieser Reihenfolge.
- einen Dateipfad (`/var/lib/app/data.db`, `sqlite:///…`): SQLite. Erkannt am Dateikopf
  `SQLite format 3\0`. Nur mit einem Agenten auf diesem Rechner (4.1).

Eine erkannte Engine steht im Dialog und lässt sich nicht still ändern: Antwortet unter der
Adresse später eine andere Engine, ist der Lauf rot (`db_engine_changed`).

### 3.2 Anmeldung und Rechte-Matrix

"Verbindung prüfen" meldet sich an, liest Version und Datenbanken und prüft die Rechte des
Benutzers. Die Oberfläche zeigt, was mit diesem Benutzer geht:

| Fähigkeit | PostgreSQL | MySQL/MariaDB | SQL Server |
|---|---|---|---|
| Sicherung | `CONNECT` und Lesen aller Objekte (`pg_read_all_data` ab 14) | `SELECT, SHOW VIEW, TRIGGER, EVENT, LOCK TABLES, PROCESS, RELOAD` | `db_backupoperator` |
| Prüfung und Restore auf derselben Instanz | zusätzlich `CREATEDB` | zusätzlich `CREATE, DROP, INSERT, ALTER, INDEX, REFERENCES, CREATE ROUTINE, ALTER ROUTINE` | `dbcreator` |
| Point-in-Time | `REPLICATION` und ein Eintrag `replication` in `pg_hba.conf` | `REPLICATION SLAVE, REPLICATION CLIENT`, Binlog an | `sysadmin` bzw. Log-Sicherung (7.2) |

Fehlt eine Fähigkeit, zeigt der Dialog den SQL-Block, der sie erteilt (Benutzer `restow_backup`
mit genau diesen Rechten), und speichert trotzdem: Die Verbindung kann dann, was der Benutzer
erlaubt. Ein Admin-Benutzer geht immer; der Dialog empfiehlt den Backup-Benutzer.

**Zugangsdaten:** Benutzer und Kennwort liegen versiegelt im Geheimnisspeicher (`secrets`,
packages/core `secret-seal.ts`, mit dem Schlüssel des Mandanten), nie im Klartext in einer
Tabelle, nie in einer API-Antwort, nie in einem Log. Der Ausführer bekommt sie je Lauf (4.3). Die
Programme bekommen das Kennwort nie auf der Kommandozeile: PostgreSQL über eine `PGPASSFILE`
(0600, im Speicher-Dateisystem des Ausführers, nach dem Lauf gelöscht), MySQL/MariaDB über eine
Optionsdatei auf stdin (`--defaults-extra-file=/dev/stdin`), SQL Server über die Verbindung des
Agenten selbst.

**Ohne Kennwort:** Läuft der Agent auf dem Datenbankrechner, meldet er sich wie im ersten
Entwurf über den Socket an (PostgreSQL `peer` als `postgres`, MariaDB `unix_socket` als root,
MySQL `auth_socket`, Container über `docker exec`). Die Verbindung speichert dann kein
Geheimnis; der Dialog bietet das an, sobald die Inventur dieses Rechners die Instanz gefunden
hat (3.4).

**TLS:** Bietet der Server TLS an, nutzt Restow es immer. Beim ersten Verbinden zeigt der Dialog
den Fingerabdruck des Zertifikats (bzw. die ausstellende CA) und speichert ihn; ein anderes
Zertifikat später ist rot (`db_tls_changed`), bis ein Admin es bestätigt. Ohne TLS nur mit
ausdrücklichem Haken "unverschlüsselt verbinden", der in der Verbindung als Hinweis stehen bleibt.
Der Restow-Server als Ausführer verbindet sich mit einer öffentlichen Adresse nie ohne TLS.

### 3.3 Identität

Eine Datenbank, die gelöscht und unter demselben Namen neu angelegt wird, ist eine andere
Datenbank mit eigener Geschichte (wie `family_guid` bei SQL Server):

- **PostgreSQL:** Instanz = `system_identifier` des Clusters (`pg_control_system()`),
  Datenbank = Name plus OID aus `pg_database`.
- **MySQL/MariaDB:** Instanz = `@@server_uuid` (MySQL) bzw. `@@server_id` plus `@@datadir`
  (MariaDB) **[CI]**. Ein Schema hat keine stabile Kennung; die Oberfläche sagt das
  ("Schemas werden über den Namen erkannt").
- **SQL Server:** wie bisher (`family_guid`).
- **SQLite:** Pfad plus Inode und Erstellzeit der Datei; eine ersetzte Datei ist eine neue
  Datenbank.
- Antwortet unter der Adresse eine **andere Instanz** (anderer `system_identifier` bzw.
  `server_uuid`), etwa nach einem Umzug oder Failover, sichert Restow nicht still weiter: Die
  Verbindung wird rot (`db_instance_changed`), bis ein Admin bestätigt, dass die neue Instanz
  dieselbe Aufgabe hat. Die Geschichte bleibt getrennt.

### 3.4 Vorschläge aus der Inventur (optional)

Der Linux-Agent findet wie im ersten Entwurf Instanzen auf seinem Rechner (systemd-Units,
`pg_lsclusters`, Docker-Container mit `postgres`, `mysql`, `mariadb`), höchstens alle 6 Stunden,
und meldet sie als `databaseInventory` im Heartbeat (höchstens 64 KiB). Die Seite Datenbanken
zeigt sie als Vorschläge "Auf <Rechner> gefunden, nicht geschützt" mit einem Knopf, der den
Dialog mit Adresse und Socket-Anmeldung vorbelegt. Die Inventur legt nie selbst eine Verbindung
an.

## 4. Ausführer

### 4.1 Agent

- Jeder Agent des Mandanten mit der Fähigkeit `db_runner_v1` kann Verbindungen ausführen, auch
  einer, der nicht auf dem Datenbankrechner läuft: Er ist dann die Brücke ins Kundennetz.
- **Pflicht** für SQLite (Datei) und SQL Server (die `.bak`-Datei schreibt SQL Server selbst auf
  seinen Rechner) sowie für die Anmeldung über den Socket.
- Die Programme (`pg_dump`, `pg_basebackup`, `pg_receivewal`, `mysqldump`/`mariadb-dump`,
  `mysqlbinlog`) nimmt der Agent bevorzugt aus der Instanz selbst (Paket bzw. Container). Auf
  einem Brücken-Rechner ohne Instanz bringt das Restow-Paket `restow-agent-dbtools` die Clients
  für die unterstützten Hauptversionen mit (Abschnitt 11); fehlt eines: `db_tool_missing` mit
  der Anleitung.
- SQLite liest der Agent mit einer eingebauten SQLite-Bibliothek in reinem Go
  (`modernc.org/sqlite`, BSD-3-Clause, `check-go-deps` und `check-licenses` vorher) über die
  Online-Backup-API: konsistent auch während Schreibzugriffen, auch im WAL-Modus **[CI]**.

### 4.2 Restow-Server

- Der Worker baut die Verbindung selbst auf und braucht keinen Agenten. Er bringt die Clients im
  Image mit (Abschnitt 11).
- **Netzschutz wie bei IMAP** (apps/api `features/sources/imap-host.ts`, packages/core
  `net/address-policy.ts`): Ein Mandanten-Admin darf nur öffentliche Adressen eintragen. Eine
  Adresse in einem privaten Netz oder ein Container-Name gibt nur ein Provider-Admin frei (je
  Verbindung, auditiert) oder die Installation mit `RESTOW_DB_ALLOW_PRIVATE_NETWORKS=true`.
  Link-local und reservierte Adressen (Cloud-Metadaten) sind für alle gesperrt. Geprüft wird beim
  Speichern **und** bei jeder Verbindung (eine Adresse, die später anders aufgelöst wird, gewinnt
  nichts).
- **Nie die eigene Datenbank:** Antwortet unter der Adresse die Datenbank dieser
  Restow-Installation (gleicher `system_identifier`), verweigert Restow die Verbindung
  (`db_target_is_restow`). Die eigene Datenbank sichert der Restow-Server über
  docs/BACKUP-RESTORE.md, nicht über dieses Modul.
- Der Restow-Server ist nur für Engines mit Netzprotokoll möglich (PostgreSQL, MySQL/MariaDB).
- Last: Läufe des Servers zählen gegen `WORKER_CONCURRENCY` in einer eigenen Queue `db`
  (Vorgabe 2 gleichzeitig je Worker-Prozess, `DB_CONCURRENCY`).

### 4.3 Lauf

- Der Server plant den Lauf und gibt ihn dem Ausführer: Agent über die Aufgabe `db_backup`,
  Server über die Queue `db`. Der Lauf trägt Verbindung, Datenbanken, Modus und ein
  **einmaliges** Zugangsdatenpaket (Anmeldung und restic-Zugang des Repositorys), das der
  Agent wie heute die restic-Zugangsdaten eines Laufs abruft und nur im Speicher hält.
- Zwei Läufe einer Verbindung überschneiden sich nie: Ein fälliger Lauf, während der vorige noch
  läuft, entfällt mit Hinweis `db_run_overlap` (sichtbar, damit ein zu kurzer Zeitplan auffällt).
- Fällt ein Agent als Ausführer aus (kein Heartbeat seit 15 Minuten), zeigt die Verbindung das,
  und ein Admin kann einen anderen Agenten oder den Server wählen. Kein automatischer Wechsel:
  Die Zugangsdaten gehen nur an den Ausführer, den ein Admin gewählt hat.

### 4.4 Repository

Jede Verbindung hat ein eigenes restic-Repository (Präfix `db/<verbindung>`) auf dem Speicherziel
des Mandanten, mit eigenem Kennwort vom Server, wie die Repositories der Rechner. Kopie-Ziele,
Aufbewahrung und Prüfungen des Repositorys gelten wie dort (docs/STORAGE.md).

## 5. Modus Sicherung (0.6.0)

### 5.1 Ablauf ohne Zwischenablage

Ein Dump läuft ohne Zwischendatei direkt in restic:

```
restic backup --stdin-from-command --stdin-filename <instanz>/<datenbank>.<endung> \
  --tag restow-db --tag restow-db-engine=<engine> --tag restow-db-connection=<id> \
  --tag restow-db-name=<name> -- <ausführer> db-stream --spec <datei>
```

- `--stdin-from-command` (restic ab 0.17, Restow nutzt 0.19.1): restic legt **keinen** Snapshot
  an, wenn der Befehl mit einem Fehler endet **[CI]**. Ein halber Dump wird so nie zu einer
  scheinbar gültigen Sicherung.
- `db-stream` (im Agenten bzw. im Worker-Image) startet das Dump-Programm mit fester
  Argumentliste (nie über eine Shell), reicht die Daten durch, berechnet SHA-256 und Größe, zählt
  die Objekte im Datenstrom (5.5) und endet mit einem Fehler, wenn das Dump-Programm scheitert.
- Ein Snapshot je Datenbank und Lauf; die Aufbewahrung gilt je Datenbank (Gruppe
  `db:<verbindung>:<datenbank>`, `--group-by host,tags`).
- **Inkrementell im Repository:** Jeder Lauf ist ein vollständiger Dump, aber unkomprimiert;
  restic speichert nur die Blöcke, die es noch nicht kennt. Ein stündlicher Lauf einer Datenbank,
  die sich wenig ändert, wächst im Repository um ungefähr die Änderungen. Gelesen wird die
  Datenbank jedes Mal ganz: Die Oberfläche zeigt die Dauer je Lauf und warnt, wenn sie ein
  Viertel des Zeitplans übersteigt (`db_run_slow`).
- Zeitplan: Vorgabe stündlich, mindestens alle 15 Minuten.

### 5.2 PostgreSQL

- Je Datenbank: `pg_dump --format=custom --compress=0 --no-password <db>`. Ohne Kompression, damit
  restic dedupliziert.
- Je Instanz einmal: `pg_dumpall --globals-only --no-role-passwords`, wenn der Benutzer
  `pg_authid` nicht lesen darf, sonst mit Kennwort-Hashes (liegen nur verschlüsselt im
  Repository).
- `pg_dump` muss mindestens die Hauptversion des Servers haben **[CI]**.
- Ausgelassen: `template0`, `template1`, `postgres` sofern leer (Hinweis statt Fehler).

### 5.3 MySQL und MariaDB

- Je Schema: `mysqldump` bzw. `mariadb-dump` mit `--single-transaction --routines --events
  --triggers --hex-blob --default-character-set=utf8mb4 --no-tablespaces`, **ohne**
  `--databases`, damit der Dump unter einem anderen Namen eingespielt werden kann **[CI]**.
- `--single-transaction` ist nur für InnoDB konsistent; andere Engines meldet der Lauf als
  Hinweis `db_nontransactional_tables` mit den Namen.
- Benutzer und Rechte einmal je Instanz, wenn der Benutzer sie lesen darf (MariaDB
  `--system=users`, MySQL `SHOW CREATE USER`/`SHOW GRANTS`).
- Systemschemas (`mysql`, `sys`, `performance_schema`, `information_schema`) werden nicht als
  Datenbank gesichert.

### 5.4 SQL Server und SQLite

- **SQL Server:** die bestehende Sicherung aus 0.5.0 (COPY_ONLY-Full, Staging-Ordner, Kette und
  Prüfung mit CHECKDB) unverändert, nur unter dem Modul und mit Verbindung statt Job-Schalter.
  Die bisherigen Jobs werden bei der Migration zu Verbindungen mit dem Agenten des Rechners als
  Ausführer.
- **SQLite:** Online-Backup-API in eine Datei im Zustandsordner des Agenten, dann `restic backup`
  dieser Datei und Löschen. Braucht kurz Platz in Größe der Datenbank; fehlt er:
  `db_no_space`. Vorgabe-Grenze 20 GiB je Datei, darüber Hinweis `db_too_large_for_sqlite_copy`.

### 5.5 Was ein Lauf meldet

`finish` eines Laufs trägt je Datenbank: Engine, Verbindung, Name, Identität (3.3), Ergebnis
`backed_up`, `skipped` oder `failed`, Snapshot-ID, Dateiname, SHA-256, Bytes, Start, Ende,
Version des Dump-Programms und den **Objektzähler** aus dem Datenstrom (PostgreSQL: Einträge des
Inhaltsverzeichnisses nach Art; MySQL/MariaDB: `CREATE TABLE`, `VIEW`, `PROCEDURE`, `FUNCTION`,
`TRIGGER`, `EVENT`; SQLite: Tabellen, Indizes, Trigger, Views aus `sqlite_schema`). Die Prüfung
vergleicht damit.

## 6. Prüfung: grün nur nach einer echten Restore-Probe

Wie bei SQL Server urteilt der Server; der Ausführer meldet nur Fakten.

- **Wann:** Aufgabe `db_verify` je Verbindung am Prüftermin (Vorgabe täglich 03:00 in der Zone
  des Zeitplans) oder mit "Jetzt prüfen". Grenze `maxGiB` je Datenbank (Vorgabe 50 GiB); größere
  bleiben ungeprüft mit Hinweis.
- **Wo:** auf derselben Instanz, wenn der Benutzer die Rechte dafür hat (3.2), mit vorheriger
  Prüfung des freien Platzes (`db_verify_no_space`). SQLite prüft der Agent in einer Kopie im
  Zustandsordner (`PRAGMA integrity_check`, Zählung). Hat der Benutzer die Rechte nicht: offene
  Frage F1.
- **Ablauf:** die neueste Sicherung **aus dem Repository** holen (nie eine lokale Kopie),
  SHA-256 vergleichen, unter `<erste 40 Zeichen>__restow_verify_<UTC-Zeit>` einspielen
  (PostgreSQL: `CREATE DATABASE … TEMPLATE template0`, dann `pg_restore --exit-on-error
  --no-owner`; MySQL/MariaDB: `CREATE DATABASE`, dann der Client mit Abbruch beim ersten Fehler),
  Objekte zählen, die Kopie löschen.
- **Aufräumen:** Vor jedem Einspielen steht der geplante Name in einem Journal (beim Agenten
  lokal, beim Server in der Tabelle der Prüfungen). Gelöscht werden nur Namen, die im Journal
  stehen und dem Muster entsprechen, nie eine Datenbank, die nur so aussieht.
- **Urteil:** grün (geholt, SHA-256 gleich, ohne Fehler eingespielt, jede Objektart mindestens so
  oft wie im Lauf), rot (anderer SHA-256, Fehler beim Einspielen, fehlende Objekte),
  unvollständig (sonst, mit Code).
- Je Datenbank ein Bericht `kind = db_verify` mit Beleg.

## 7. Weitere Modi

### 7.1 Wiederherstellung (alle Modi)

- **Unter neuem Namen auf derselben Instanz** (Vorgabe, auditiert, Rechte 3.2): eine
  vorhandene Datenbank wird nie ersetzt.
- **Auf eine andere Verbindung** desselben Mandanten (andere Instanz, gleiche Engine), etwa
  eine Test-Instanz.
- **Herunterladen:** die Dump-Datei über den Restore-Download, dazu eine Restore-Anleitung als
  Text (`pg_restore`- bzw. `mysql`-Befehle, ohne Geheimnis).
- **Über die vorhandene Datenbank** nur mit ausdrücklicher Bestätigung (Name eintippen) und
  einer Sicherung unmittelbar davor; nicht in 0.6.0.

### 7.2 Point-in-Time (0.6.x)

Wiederherstellen auf einen beliebigen Zeitpunkt zwischen der ältesten Basissicherung und "vor
wenigen Minuten". Braucht einen **dauernd laufenden** Ausführer (Agent oder Worker), der das Log
mitschreibt.

- **PostgreSQL:**
  - Basissicherung physisch mit `pg_basebackup --wal-method=none --checkpoint=fast` (ganzer
    Cluster, nicht je Datenbank), Vorgabe täglich, als Datenstrom in restic.
  - WAL laufend mit `pg_receivewal --slot=restow_<verbindung> --synchronous` über die
    Replikationsverbindung. Der Ausführer sammelt die Segmente lokal und legt alle 5 Minuten
    (Vorgabe, mindestens 1) einen restic-Snapshot an. Der mögliche Datenverlust (RPO) ist damit
    höchstens dieser Abstand plus der Rückstand der Übertragung; die Oberfläche nennt ihn so.
  - **Risiko des Slots:** Solange Restow nicht abholt, hält der Slot WAL auf dem Kundenserver
    zurück, bis die Platte voll ist. Restow verlangt darum `max_slot_wal_keep_size` (PostgreSQL
    13+) und prüft es beim Anlegen (`db_pitr_slot_unbounded`, ohne Grenze kein Point-in-Time).
    Der Healthcheck zeigt das zurückgehaltene WAL; Alarm `database.pitr_lag` ab 15 Minuten
    Rückstand oder 50 % der Grenze. Ein ungültig gewordener Slot (Grenze überschritten) ist eine
    Lücke: Die Zeitleiste zeigt sie, und eine neue Basissicherung startet sofort.
  - Wiederherstellung: ganzer Cluster in eine neue Instanz derselben Hauptversion auf einem
    Rechner mit Agent (eigener Datenordner und Port, `recovery_target_time`), danach daraus
    einzelne Datenbanken per `pg_dump` unter neuem Namen in die Quelle, wenn gewünscht.
    **[CI]** für den ganzen Weg.
- **MySQL/MariaDB:**
  - Basissicherung als Dump mit Binlog-Position (`--source-data=2` ab MySQL 8.0.26 bzw.
    `--master-data=2` bei MariaDB), Vorgabe täglich.
  - Binlogs laufend mit `mysqlbinlog --read-from-remote-server --raw --stop-never`, gesammelt
    und alle 5 Minuten in restic wie oben.
  - Voraussetzungen, beim Anlegen geprüft: `log_bin` an (bei MariaDB standardmäßig aus),
    `binlog_format=ROW`, Aufbewahrung der Binlogs länger als ein Ausfall des Ausführers dauern
    darf (Vorgabe-Warnung unter 24 Stunden).
  - Wiederherstellung je Schema unter neuem Namen: Dump einspielen, dann `mysqlbinlog
    --start-position … --stop-datetime … --rewrite-db=<alt>-><neu>` in den Client **[CI]**.
- **SQL Server:** Wiederherstellungsmodell FULL und Log-Sicherungen alle 15 Minuten (Vorgabe)
  über den Agenten auf dem SQL-Server-Rechner. Damit übernimmt Restow die Log-Kette: Eine
  andere Sicherungssoftware, die ebenfalls Logs sichert, hätte danach Lücken. Nur mit
  ausdrücklicher Bestätigung "Restow führt die Log-Kette" und dem Befund aus `msdb`, welche
  andere Software zuletzt gesichert hat (docs/BAREMETAL-WINDOWS.md, W2b).
- **SQLite:** kein Point-in-Time.

### 7.3 Warme Kopie (0.7.0) statt Standby

- Restow spielt im Zeitplan (Vorgabe stündlich, nach jeder Sicherung bzw. im Modus Point-in-Time
  auf "jetzt") die neueste Sicherung auf eine **Zielverbindung** des Mandanten ein.
- Auf dem Ziel gehören Restow nur Datenbanken, die es selbst angelegt hat: Kennzeichen im
  Kommentar der Datenbank (`restow-warm-copy:<verbindung>:<datenbank>`) und in der Tabelle der
  Kopien. Eine Datenbank ohne dieses Kennzeichen wird nie überschrieben, auch nicht bei gleichem
  Namen (`db_warm_copy_name_taken`).
- Eingespielt wird erst unter einem neuen Namen, dann umbenannt (PostgreSQL `ALTER DATABASE …
  RENAME`, MySQL über `RENAME TABLE` in ein neues Schema): Die alte Kopie bleibt nutzbar, bis die
  neue vollständig ist.
- Der Abstand zum Original ist der Zeitplan; die Oberfläche nennt ihn als "Stand der Kopie".
- Jede gelungene Kopie ist zugleich eine Restore-Probe und zählt als Prüfung (6).
- **Kein Streaming-Standby:** Eine laufend replizierte Instanz mit Failover betreibt Restow
  nicht. Sie verlangt Überwachung, Failover-Entscheidungen und Rückführung, also einen
  Betriebsdienst. Wird er nachgefragt, kommt er frühestens nach 0.7.0 und nur für PostgreSQL.

## 8. Healthchecks und Verlauf

Unabhängig von den Läufen prüft der Ausführer jede Verbindung leicht und regelmäßig:

- **Intervall:** Vorgabe 5 Minuten, einstellbar 1 bis 60 Minuten je Verbindung.
- **Je Prüfung** (mit dem Backup-Benutzer, nur lesend, Zeitlimit 10 Sekunden):
  - erreichbar ja/nein mit Fehlercode, Antwortzeit (Verbindungsaufbau und `SELECT 1`);
  - Version, Startzeit der Instanz (ein Neustart wird als Ereignis sichtbar);
  - Verbindungen in Benutzung im Verhältnis zu `max_connections`;
  - Größe je Datenbank (höchstens einmal je Stunde, weil teurer);
  - im Modus Point-in-Time: Rückstand der Übertragung, vom Slot zurückgehaltenes WAL bzw. älteste
    vorhandene Binlog-Datei;
  - TLS-Fingerabdruck.
- **Speicherung:** Tabelle `database_health_samples` (Zeit, Verbindung, Werte, Fehlercode).
  Rohwerte 14 Tage, danach Stundenmittel und -extreme 400 Tage. Ein Mandant mit 100 Verbindungen
  bei 5 Minuten erzeugt rund 29.000 Zeilen am Tag; die Rohwerte werden täglich verdichtet.
- **Anzeige:**
  - Liste: Punkt (erreichbar, langsam, nicht erreichbar) mit Verlauf der letzten 24 Stunden als
    Band;
  - Verbindungsseite: Verfügbarkeit in Prozent (24 Stunden, 7 Tage, 30 Tage), Antwortzeit,
    Verbindungen, im Modus Point-in-Time Rückstand, Ereignisliste (nicht erreichbar seit/bis,
    Neustart, Versionswechsel, TLS geändert);
  - Datenbankseite: Größe und Wachstum je Tag.
- **Alarme:** `database.unreachable` nach drei fehlgeschlagenen Prüfungen in Folge,
  `database.reachable` beim ersten Erfolg danach (2.4).
- Der Healthcheck ist **kein** Monitoring-Ersatz: Er misst aus Sicht des Ausführers und nur das,
  was die Sicherung braucht. Die Oberfläche sagt das in einem Satz.

## 9. Server: Datenmodell und API

- **Neue Tabellen:** `database_connections` (Mandant, Engine, Adresse, Ausführer, Verweis auf
  das Geheimnis, TLS-Fingerabdruck, Freigabe für private Netze, Modus, Zeitpläne, Auswahl,
  Identität der Instanz), `databases` (Verbindung, Name, Identität, Größe, `dropped_at`),
  `database_backups` (Snapshot, Datei, SHA-256, Bytes, Zeiten, Objektzähler, Status
  `active`/`pruned`), `database_health_samples` (8), im Modus Point-in-Time `database_pitr_ranges`
  (wiederherstellbare Bereiche und Lücken), in 0.7.0 `database_warm_copies`. SQL Server behält
  seine Tabellen (`endpoint_sql_*`); die Modulseite liest beide über eine gemeinsame Abfrage.
  Migrationsnummer: die nächste freie bei der Umsetzung.
- **Agent-API:** Fähigkeit `db_runner_v1` in Enroll und Heartbeat; `databaseInventory` im
  Heartbeat; Aufgaben `db_backup`, `db_verify`, `db_restore`, `db_health` (gebündelt je Agent,
  einmal je Intervall); Abruf des Zugangsdatenpakets je Lauf. Vertrag mit Testdaten, die Agent
  und Server teilen (`agent/internal/api/testdata/contract/`).
- **Session-API:** `GET/POST /api/v1/databases/connections`, `POST …/connections/test`
  (Verbindung prüfen, ohne zu speichern), `GET/PATCH/DELETE …/connections/:id`,
  `GET /api/v1/databases`, `GET /api/v1/databases/:id`, `GET …/:id/health?from&to`,
  `POST …/:id/backup`, `POST …/:id/verify`, `POST …/:id/restore`, `GET …/:id/restore-guide`.
  Anlegen, Ändern und Wiederherstellen nur für Admins; Lesen auch für Restore-Bediener.
  Zugangsdaten werden nur geschrieben, nie gelesen (die Antwort sagt nur `credential: "set"`).
- **Aufbewahrung:** Regeln je Gruppe `db:<verbindung>:<datenbank>`; eine Sicherung, deren
  Snapshot vergessen wurde, wird `pruned`.
- **Abrechnung:** neue Position `databases` (je geschützte Datenbank und Monat) im Preisrechner
  und in `GET /api/v1/provider/billing` (Typ `databases`), offene Frage F2.
- **Fehlercodes** (Präfix `db_`): `db_unreachable`, `db_login_failed`, `db_permission_missing`,
  `db_engine_changed`, `db_instance_changed`, `db_target_is_restow`, `db_private_network`,
  `db_tls_changed`, `db_tls_missing`, `db_dump_failed`, `db_snapshot_failed`, `db_tool_missing`,
  `db_tool_too_old`, `db_no_space`, `db_restore_name_taken`, `db_restore_failed`,
  `db_backup_mismatch`, `db_verify_no_space`, `db_verify_timeout`, `db_runner_offline`,
  `db_pitr_slot_unbounded`, `db_pitr_gap`, `db_warm_copy_name_taken`. Hinweise:
  `db_nontransactional_tables`, `db_version_untested`, `db_too_large_to_verify`, `db_run_overlap`,
  `db_run_slow`.

## 10. Sicherheit

- Die Zugangsdaten einer Datenbank sind die wertvollsten Geheimnisse, die Restow hält. Darum:
  versiegelt mit dem Schlüssel des Mandanten; je Lauf nur an den gewählten Ausführer; im Agenten
  nur im Speicher und in einer 0600-Datei im Speicher-Dateisystem für die Dauer des Programms;
  nie auf einer Kommandozeile (sichtbar in `ps`), nie im Log, nie im Fehlertext (Fehlertexte
  der Clients werden vor dem Speichern um URL, Benutzer und Kennwort bereinigt).
- Der Backup-Benutzer ist die Empfehlung; der Dialog zeigt, welche Rechte ein Admin-Benutzer
  zusätzlich gäbe, die Restow nicht braucht.
- Netzschutz und "nie die eigene Datenbank" (4.2).
- Audit: Anlegen, Ändern der Zugangsdaten, Freigabe privater Netze, Bestätigen eines neuen
  TLS-Zertifikats oder einer neuen Instanz, jede Wiederherstellung und jede warme Kopie.
- Wiederherstellungsmodus der Installation (nach dem Zurückspielen eines DB-Dumps): keine Läufe,
  keine Healthchecks mit Zugangsdaten, bis er aufgehoben ist.

## 11. Versionen und Programme

Unterstützt werden die Hauptversionen, die das jeweilige Projekt beim Erscheinen von 0.6.0 noch
pflegt. Stand dieses Entwurfs: PostgreSQL 14 bis 18, MySQL 8.0 und 8.4 LTS, MariaDB 10.6, 10.11,
11.4 und 11.8, SQL Server wie 0.5.0, SQLite 3 **[CI]**. Ältere laufen mit dem Hinweis
`db_version_untested`.

- **Worker-Image** und Paket `restow-agent-dbtools`: `pg_dump`, `pg_dumpall`, `pg_restore`,
  `pg_basebackup`, `pg_receivewal` der neuesten Hauptversion (sie können ältere Server
  sichern), `mariadb-dump` und `mysqldump` (MySQL 8.4, für MySQL-Server), `mysqlbinlog` bzw.
  `mariadb-binlog`. Größe des Images vorher messen; Lizenzen in die Drittanbieter-Hinweise.
- Für die Wiederherstellung einer physischen PostgreSQL-Basissicherung braucht es genau die
  Hauptversion der Quelle; sie kommt aus dem Zielrechner (7.2).

## 12. Aussagen (docs/CLAIMS.md)

Neue Einträge, jeweils mit Test-Tag:

- Eine Datenbank lässt sich mit Adresse und Benutzer schützen, ohne den ganzen Server zu sichern.
- Restow erkennt PostgreSQL, MySQL, MariaDB und SQL Server an der Adresse allein.
- Ein abgebrochener Dump wird nie zu einer Sicherung.
- Grün heißt: aus dem Repository geholt, Prüfsumme gleich, vollständig eingespielt, alle Objekte
  da.
- Zugangsdaten liegen nur verschlüsselt auf dem Server und erscheinen in keiner API-Antwort,
  keinem Log und keiner Kommandozeile.
- Der Restow-Server verbindet sich nur mit Adressen in privaten Netzen, die ein Provider-Admin
  freigegeben hat.
- (0.6.x) Point-in-Time: Wiederherstellung auf einen Zeitpunkt mit höchstens dem angezeigten
  Datenverlust.
- (0.7.0) Eine warme Kopie überschreibt nie eine Datenbank, die Restow nicht selbst angelegt hat.

## 13. Umsetzung in Stufen

| Stufe | Version | Inhalt |
|---|---|---|
| D1 | 0.6.0 | Modul `databases` mit Migration; Verbindungen: Dialog, Erkennung der Engine, Verbindung prüfen mit Rechte-Matrix, Zugangsdaten im Geheimnisspeicher, TLS-Fingerabdruck, Ausführer Agent und Server mit Netzschutz; Inventur als Vorschlag |
| D2 | 0.6.0 | Healthchecks mit Verlauf und Alarmen (alle Engines) |
| D3 | 0.6.0 | PostgreSQL: Sicherung, Restore unter neuem Namen und auf eine andere Verbindung, Download mit Anleitung |
| D4 | 0.6.0 | MySQL und MariaDB: dasselbe |
| D5 | 0.6.0 | SQLite über den Agenten; SQL Server zieht ins Modul um |
| D6 | 0.6.0 | Prüfung `db_verify`, Bewertung, Alarme, Abrechnungsposition |
| D7 | 0.6.0 | Härtung: Versionsmatrix in der CI, große Datenbanken, Abbruch während des Dumps, Ausführer fällt aus, Instanz gewechselt, Aufnahmen auf echter Hardware **[HW]** |
| P1 | 0.6.x | Point-in-Time PostgreSQL |
| P2 | 0.6.x | Point-in-Time MySQL und MariaDB |
| P3 | 0.6.x | Point-in-Time SQL Server (Log-Kette, W2b) |
| W1 | 0.7.0 | Warme Kopie |

Später: MongoDB, Podman, PostgreSQL und MySQL unter Windows (E7), Restore über die vorhandene
Datenbank, Streaming-Standby nur auf Nachfrage (7.3).

## 14. Tests

- **Einheit (Go und TypeScript):** Erkennung der Engine aus aufgezeichneten Begrüßungen,
  Argumentlisten der Programme (keine Shell), Zähler im Datenstrom, Journal der Prüfkopien,
  Bereinigung der Fehlertexte von Zugangsdaten, Netzschutz (privat, link-local, eigene
  Datenbank).
- **Vertrag:** gemeinsame Testdaten für Lauf, Prüfung, Restore, Healthcheck.
- **Server (pg-Tests):** Identität (neu angelegte Datenbank = neue Zeile, andere Instanz = rot),
  Bewertung, Aufbewahrung, Verdichtung der Healthchecks, Modul-Migration (mit und ohne SQL
  Server in Benutzung), Zugangsdaten nie in einer Antwort.
- **Ende zu Ende (CI):** jede Version aus 11 als Container, je einmal mit Agent als Brücke und
  mit dem Server als Ausführer: Daten anlegen, sichern, ändern, unter neuem Namen zurück,
  vergleichen; Dump mitten im Lauf abbrechen und belegen, dass kein Snapshot entsteht; Prüfung
  grün und mit beschädigter Datei rot; Instanz ausgetauscht; Healthcheck bei gestopptem
  Container rot und danach wieder grün. SQLite unter Schreiblast im WAL-Modus.

## 15. Offene Fragen

- **F1 Prüfung ohne Rechte auf der Instanz:** Hat der Benutzer nur Sicherungsrechte, kann Restow
  nicht auf der Instanz des Kunden prüfen. Vorschlag: Restow bringt einen Prüfdienst mit (Compose-
  Profil `db-lab`, ein Container mit PostgreSQL 14 bis 18 aus den Paketen von postgresql.org und
  je ein Container für MySQL 8.4 und MariaDB 11.x, nur im internen Netz des Workers, Wegwerf-
  Daten im tmpfs). Schon in 0.6.0, oder in 0.6.0 "gesichert, ungeprüft" und der Prüfdienst in
  0.6.x?
- **F2 Preis:** je geschützte Datenbank oder je Verbindung (Instanz)? Vorschlag: je Datenbank,
  wie Postfächer je Postfach.
- **F3 Edition:** Sicherung in allen Editionen (wie SQL Server heute). Point-in-Time und warme
  Kopie auch, oder nur ab Business?
