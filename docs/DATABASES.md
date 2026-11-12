# Datenbanken (Entwurf für 0.6.0)

Stand: Entwurf, noch nicht umgesetzt. Ziel ist Restow 0.6.0. Entscheidungen von Lucas Flores
(November 2026):

- **E1** Version 0.6.0, nicht 0.5.x.
- **E2** Eigenes Modul "Datenbanken": standardmäßig aus, im Menü nur, wenn eingeschaltet.
- **E3** Die native SQL-Server-Sicherung (0.5.0, docs/AGENT.md "SQL Server", docs/BAREMETAL-WINDOWS.md
  5.1) zieht in dieses Modul um; die Rechnerseite behält einen Verweis.
- **E4** Erster Umfang: PostgreSQL sowie MySQL und MariaDB. MongoDB und Point-in-Time (WAL,
  Binlog) kommen später.

Markierungen wie in docs/BAREMETAL-WINDOWS.md: **[CI]** = in der CI zu belegen, bevor es
irgendwo behauptet wird; **[HW]** = auf echter Hardware zu belegen; ohne Markierung = Entwurf.

## 1. Grundsatz: Dump für die Datenbank, Snapshot für die Maschine

Restow sichert eine Datenbank auf zwei Wegen, die sich ergänzen und nicht ersetzen:

| | Nativer Dump (dieses Modul) | Dateisystem-Snapshot (LVM, btrfs, VSS) |
|---|---|---|
| Konsistenz | transaktionskonsistent je Datenbank | absturzkonsistent, nur wenn Daten, WAL bzw. Redo-Log und alle Tablespaces im **selben** atomaren Snapshot liegen |
| Einzelne Datenbank zurück | ja, auch unter neuem Namen | nein, nur der ganze Cluster bzw. die ganze Instanz |
| Andere Hauptversion beim Restore | ja (logischer Dump) | nein, gleiche Hauptversion und gleiche Plattform |
| Prüfbar | ja: Restore-Probe in eine Wegwerf-Datenbank | nur durch Start der ganzen Instanz |
| Zweck | eine Datenbank wiederherstellen | die ganze Maschine wiederherstellen (Bare Metal) |

Daraus folgt:

- Ist die native Sicherung einer Datenbank an, schließt die **Dateisicherung** ihren Datenordner
  aus (doppelt und ohne Wert, wie bei SQL Server, docs/BAREMETAL-WINDOWS.md 3.8). Das
  **Bare-Metal-Image** enthält ihn weiter, damit die Maschine als Ganzes startet.
- Ein LVM-Snapshot gilt je logischem Volume. Liegen Daten und WAL auf verschiedenen Volumes, sind
  zwei Snapshots nicht atomar zueinander, und die Kopie ist nicht einmal absturzkonsistent. Restow
  behauptet darum nirgends, dass ein Snapshot eine Datenbank sichert; die Oberfläche nennt nur den
  Dump eine Datenbanksicherung.
- Was nicht stimmt und darum nirgends behauptet wird: Ein Dump über mehrere Datenbanken ist
  **kein** gemeinsamer Zeitpunkt. Jede Datenbank hat ihren eigenen konsistenten Stand
  (`pg_dump` je Datenbank in einer eigenen Transaktion, `mysqldump --single-transaction` je
  Schema). Wer Datenbanken braucht, die zueinander passen, braucht Point-in-Time (später).

## 2. Das Modul "Datenbanken"

### 2.1 Modul und Menü

- Neue Modul-ID `databases` in `MODULE_IDS` (apps/web `lib/modules.ts` und apps/api
  `lib/modules.ts`, gleiche Liste). Bezeichnung "Datenbanken" (en: "Databases").
- `settings.modules` speichert die **ausgeschalteten** Module (Migration 0094); ein neues Modul
  wäre in jeder bestehenden Installation sofort an. Die Migration schreibt `databases` darum in die
  Liste der ausgeschalteten Module, **außer** irgendein Job der Installation hat die native
  SQL-Server-Sicherung an: Dann bleibt das Modul an, damit nichts verschwindet, was schon genutzt
  wird.
- Der Einrichtungsassistent fragt das Modul mit den anderen ab, Vorgabe aus. Installation ›
  Module schaltet es später.
- Wie jedes Modul blendet es nur aus (Menü, Karten der Übersicht, "Neu anlegen", Befehlspalette);
  die Seiten bleiben über ihre Adresse erreichbar und sagen, dass das Modul ausgeblendet ist. Die
  API verweigert deswegen nichts.
- Keine Edition-Sperre: Die native SQL-Server-Sicherung ist Kern, die neuen Engines auch.

### 2.2 Seiten

- **Datenbanken** (`/databases`, Menüpunkt im Bereich Schutz): eine Liste aller Datenbanken des
  Mandanten über alle Rechner und Engines. Spalten: Engine, Datenbank, Instanz, Rechner, Größe,
  letzte Sicherung, letzte Prüfung, Bewertung. Filter nach Engine, Rechner und Bewertung; die
  Sortierung beginnt mit Rot, dann Überfällig, dann Ungeprüft.
- **Datenbank** (`/databases/:id`): Sicherungen (Zeitpunkt, Größe, SHA-256, Snapshot),
  Prüfberichte mit Beleg, Aktionen "Wiederherstellen", "Jetzt prüfen", "Herunterladen",
  "Restore-Anleitung für einen anderen Rechner".
- **Instanzen** (Reiter auf der Seite Datenbanken): je Instanz Rechner, Engine, Version, Art
  (Dienst oder Container), Anmeldung (geht, fehlt, mit Anleitung), letzte Inventur.
- **Rechnerseite:** Der Reiter "SQL" wird zum Reiter "Datenbanken" mit einer Kurzliste der
  Datenbanken dieses Rechners und einem Verweis auf die Modulseite. Die bisherigen Adressen des
  SQL-Reiters leiten weiter.
- **Job-Seite:** Sobald die Inventur eines Rechners eine Instanz findet, bietet der Job die
  native Sicherung an (wie heute bei SQL Server). Vorgabe aus.

### 2.3 Bewertung und Alarme

Wie bei SQL Server je Datenbank: `not_protected`, `unverified`, `green`, `red`, `overdue`
(letzte grüne Prüfung älter als 8 Tage). Neue Alarme `endpoint.database_red`,
`endpoint.database_recovered`, `endpoint.database_overdue`, je einmal (Gruppe `jobs`). Die
SQL-Server-Alarme `endpoint.sql_*` bleiben unter ihrem Namen, damit bestehende
Benachrichtigungsregeln weiter greifen; die Benachrichtigungsmatrix zeigt beide Gruppen unter
"Datenbanken".

## 3. Erkennung (Inventur)

Der Linux-Agent (läuft als root) sucht bei jeder Inventur, höchstens alle 6 Stunden, solange die
native Sicherung an ist, sonst nur nach "Anmeldung prüfen" (jede fehlgeschlagene Anmeldung landet
im Log der Datenbank):

- **Dienste:** systemd-Units und Sockets. PostgreSQL: Cluster aus `pg_lsclusters` (Debian,
  Ubuntu) bzw. Units `postgresql-<ver>` (RHEL-Familie), Socket-Verzeichnis aus der laufenden
  Instanz. MySQL und MariaDB: Unit `mysql`, `mysqld` oder `mariadb`, Socket aus
  `mysqld --print-defaults` bzw. der laufenden Instanz.
- **Container:** Docker über `/var/run/docker.sock`. Erkannt werden Container, deren Image
  `postgres`, `mysql` oder `mariadb` heißt oder auf einem davon aufbaut (`docker inspect`,
  `Config.Image` und die Labels), oder in denen `postgres` bzw. `mysqld`/`mariadbd` als
  Hauptprozess läuft. Podman später.
- Je Instanz: Engine, Hauptversion, Art (`service` oder `container`), Instanz-Schlüssel,
  Datenordner, Anmeldung, Datenbanken mit Name, Größe und Kennung (3.1).

Ergebnis im Heartbeat als `databaseInventory` (höchstens 64 KiB, zu groß: Datenbanken vom Ende
weg und `truncated: true`, wie `sqlInventory`).

### 3.1 Identität

Eine Datenbank, die gelöscht und unter demselben Namen neu angelegt wird, ist eine andere
Datenbank mit eigener Geschichte (wie `family_guid` bei SQL Server):

- **PostgreSQL:** Instanz = `system_identifier` des Clusters (`pg_control_system()`),
  Datenbank = Name plus OID aus `pg_database`. Neue OID bei gleichem Namen = neue Datenbank.
- **MySQL/MariaDB:** Instanz = `@@server_uuid` (MySQL) bzw. `@@server_id` plus Datenordner
  (MariaDB hat keine `server_uuid`) **[CI]**. Ein Schema hat keine stabile Kennung; Restow
  erkennt Löschen und Neuanlegen darum nicht sicher und sagt das in der Oberfläche
  ("Schemas werden über den Namen erkannt").
- **Container:** Der Instanz-Schlüssel hängt an der Instanz-Kennung oben, nicht an der
  Container-ID. Ein neu erzeugter Container mit demselben Datenvolume ist dieselbe Instanz.

## 4. Anmeldung, ohne ein Kennwort zu speichern

Grundsatz wie bei SQL Server: Restow speichert, wo immer es geht, **kein** Datenbank-Kennwort,
weder auf dem Server noch auf dem Rechner.

- **PostgreSQL (Dienst):** Der Agent startet `pg_dump` als Betriebssystem-Benutzer `postgres`
  (`setpriv`/`runuser`) über den Unix-Socket. Das trifft die Vorgabe `local all postgres peer`
  von Debian, Ubuntu und RHEL **[CI]**. Fehlt sie: `db_login_missing` mit der Zeile für
  `pg_hba.conf` in der Oberfläche.
- **PostgreSQL (Container):** `docker exec -u postgres <container> pg_dump …` über den Socket im
  Container. Das offizielle Image vertraut lokalen Socket-Verbindungen **[CI]**.
- **MariaDB (Dienst):** `root@localhost` meldet sich ab MariaDB 10.4 über `unix_socket` an
  **[CI]**; der Agent läuft als root und braucht kein Kennwort.
- **MySQL (Dienst):** Die Pakete von Debian und Ubuntu geben `root@localhost` das Plugin
  `auth_socket` **[CI]**. Andere Pakete setzen ein Kennwort; dann legt der DBA einen Benutzer an,
  der sich über den Socket anmeldet. Die Oberfläche zeigt den SQL-Block, den der DBA ausführt
  (Benutzer `restow` mit `auth_socket`, Rechte `SELECT, SHOW VIEW, TRIGGER, EVENT, LOCK TABLES,
  PROCESS, RELOAD` für die Sicherung sowie `CREATE, DROP, INSERT, ALTER, INDEX, REFERENCES,
  CREATE ROUTINE, ALTER ROUTINE` für Prüfung und Restore unter neuem Namen **[CI]**), und der
  Agent startet den Client als Betriebssystem-Benutzer `restow-db`, den das Installationsskript
  anlegt.
- **MySQL/MariaDB (Container):** Das Kennwort steht im Container (`MYSQL_ROOT_PASSWORD`,
  `MARIADB_ROOT_PASSWORD` oder die `_FILE`-Variante). Der Agent liest es im Container und gibt es
  dem Client über eine Optionsdatei auf stdin (`--defaults-extra-file=/dev/stdin`), **nie** auf
  der Kommandozeile **[CI]**. Es verlässt den Rechner nicht.
- **Rückfall (offene Frage F2):** Ein Kennwort, das der Administrator lokal auf dem Rechner
  hinterlegt (`restow-agent db-credential set`, Datei 0600 unter `/etc/restow-agent/`), nie über
  den Server.

Vor jedem Lauf prüft der Agent die Rechte und meldet `db_login_missing` bzw.
`db_permission_missing` je Instanz oder Datenbank.

## 5. Sicherung

### 5.1 Ablauf ohne Zwischenablage

Ein Dump läuft ohne Zwischendatei direkt in restic. SQL Server braucht einen Staging-Ordner, weil
SQL Server die `.bak`-Datei selbst schreibt; ein Dump-Programm schreibt nach stdout:

```
restic backup --stdin-from-command --stdin-filename <instanz>/<datenbank>.<endung> \
  --tag restow-db --tag restow-db-engine=<engine> --tag restow-db-instance=<schlüssel> \
  --tag restow-db-name=<name> -- /usr/lib/restow-agent/restow-agent db-stream --spec <datei>
```

- `--stdin-from-command` (restic ab 0.17, Restow nutzt 0.19.1): restic legt **keinen** Snapshot
  an, wenn der Befehl mit einem Fehler endet **[CI]**. Ein halber Dump wird so nie zu einer
  scheinbar gültigen Sicherung.
- Der Befehl ist der Agent selbst (`db-stream`, aus dem signierten Agenten). Er startet das
  Dump-Programm mit fester Argumentliste (nie über eine Shell), reicht die Daten durch, berechnet
  dabei SHA-256 und Größe und zählt die Objekte im Datenstrom (5.4). Er schreibt das Ergebnis in
  eine Datei im Zustandsordner des Agenten, die der Agent nach dem Snapshot liest, und endet mit
  einem Fehler, wenn das Dump-Programm scheitert.
- Ein Snapshot je Datenbank und Lauf; die Aufbewahrung gilt je Datenbank (Gruppe
  `db:<engine>:<schlüssel>:<datenbank>`, `--group-by host,tags`).
- Kein Platz auf dem Rechner nötig außer dem restic-Cache. Die Größenwarnung (#99) gilt wie bei
  jedem Lauf.

### 5.2 PostgreSQL

- Je Datenbank: `pg_dump --format=custom --compress=0 --no-password <db>`. Ohne Kompression,
  weil restic selbst komprimiert und dedupliziert; ein komprimierter Dump bekommt bei jeder
  Änderung ganz neue Blöcke.
- Je Cluster einmal: `pg_dumpall --globals-only` (Rollen, Mitgliedschaften, Tablespaces). Es
  enthält die Kennwort-Hashes der Rollen und liegt darum nur verschlüsselt im Repository, wie
  alles andere.
- `pg_dump` muss mindestens die Hauptversion des Servers haben **[CI]**. Der Agent nimmt das
  Programm der Instanz selbst (`/usr/lib/postgresql/<ver>/bin` bzw. das im Container), nie ein
  beliebiges im `PATH`.
- `pg_dump` läuft in einer Transaktion mit eigenem Snapshot: konsistent je Datenbank, ohne
  Sperre für Schreiber. Lange laufende Dumps halten das Aufräumen (VACUUM) auf; die Oberfläche
  zeigt die Dauer je Datenbank.
- Ausgelassen: `template0`, `template1`, `postgres`, sofern leer (Hinweis statt Fehler).

### 5.3 MySQL und MariaDB

- Je Schema: `mysqldump` bzw. `mariadb-dump` mit `--single-transaction --routines --events
  --triggers --hex-blob --default-character-set=utf8mb4 --no-tablespaces`, **ohne**
  `--databases`, damit der Dump unter einem anderen Namen eingespielt werden kann **[CI]**.
- `--single-transaction` ist nur für InnoDB konsistent. Tabellen mit einer anderen Engine
  (MyISAM, Aria) meldet der Lauf als Hinweis `db_nontransactional_tables` mit den Namen. Ein
  DDL-Befehl während des Dumps kann ihn abbrechen lassen; dann ist der Lauf für dieses Schema
  rot, nicht still unvollständig.
- Benutzer und Rechte einmal je Instanz: MariaDB über `mariadb-dump --system=users`, MySQL über
  `SHOW CREATE USER` und `SHOW GRANTS` je Benutzer, zusammengesetzt vom Agenten **[CI]**.
  Systemschemas (`mysql`, `sys`, `performance_schema`, `information_schema`) werden nicht als
  Datenbank gesichert.
- Das Client-Programm kommt aus der Instanz selbst (Paket bzw. Container) und passt damit zur
  Server-Version.

### 5.4 Was ein Lauf meldet

`finish` eines Laufs `db` trägt je Datenbank: Engine, Instanz-Schlüssel, Name, Kennung (3.1),
Ergebnis `backed_up`, `skipped` oder `failed`, Snapshot-ID, Dateiname im Snapshot, SHA-256,
Bytes, Start, Ende, Version des Dump-Programms und den **Objektzähler** aus dem Datenstrom
(PostgreSQL: Einträge des Inhaltsverzeichnisses nach Art; MySQL/MariaDB: `CREATE TABLE`,
`CREATE VIEW`, `CREATE PROCEDURE`, `CREATE FUNCTION`, `CREATE TRIGGER`, `CREATE EVENT`). Die
Prüfung (6) vergleicht damit.

## 6. Prüfung: grün nur nach einer echten Restore-Probe

Wie bei SQL Server urteilt der Server; der Agent meldet nur Fakten.

- **Wann:** Aufgabe `db_verify` je Instanz am Prüftermin des Jobs (Vorgabe Sonntag 03:00 in der
  Zone des Zeitplans) oder mit "Jetzt prüfen". Grenze `maxGiB` je Datenbank (Vorgabe 50 GiB);
  größere bleiben ungeprüft mit Hinweis.
- **Wo (offene Frage F1):** Vorschlag für 0.6.0 auf derselben Instanz, wie bei SQL Server: gleiche
  Version, keine weitere Infrastruktur. Der Agent prüft vorher den freien Platz
  (`db_verify_no_space`).
- **Ablauf:** Die neueste Sicherung **aus dem Repository** holen (nie eine lokale Kopie),
  SHA-256 vergleichen, unter dem Namen `<erste 40 Zeichen>__restow_verify_<UTC-Zeit>` einspielen
  (PostgreSQL: `CREATE DATABASE … TEMPLATE template0`, dann `pg_restore --exit-on-error
  --no-owner`; MySQL/MariaDB: `CREATE DATABASE`, dann der Client mit `--abort-source-on-error`
  bzw. Abbruch beim ersten Fehler), die Objekte der Kopie zählen, die Kopie löschen.
- **Aufräumen:** Vor jedem Einspielen schreibt der Agent den geplanten Namen in ein lokales
  Journal. Das Aufräumen vor der nächsten Prüfung löscht nur Namen, die im Journal stehen und dem
  Muster entsprechen, nie eine Datenbank, die nur so aussieht (wie C7 bei SQL Server).
- **Urteil:**
  - **grün:** Datei geholt, SHA-256 gleich, Einspielen ohne Fehler, und jede Objektart der
    Kopie hat mindestens die Anzahl aus dem Lauf;
  - **rot:** anderer SHA-256, Fehler beim Einspielen oder fehlende Objekte;
  - **unvollständig:** sonst, mit dem Code des Agenten.
- Je Datenbank ein Bericht `endpoint_reports.kind = db_verify` mit Beleg (Sicherung, Zählung,
  Fehlertexte).

## 7. Wiederherstellung

- **Unter neuem Namen auf derselben Instanz** (Vorgabe, Aufgabe `db_restore`, auditiert): Eine
  vorhandene Datenbank wird nie ersetzt. Namensregeln je Engine (PostgreSQL höchstens 63 Bytes,
  MySQL 64 Zeichen, kein Muster `__restow_verify_`).
- **Herunterladen:** die Dump-Datei über den vorhandenen Restore-Download, dazu eine
  Restore-Anleitung als Text (`pg_restore`- bzw. `mysql`-Befehle, ohne Geheimnis), wie das
  Restore-Skript von SQL Server.
- **Später:** Restore auf einen anderen Rechner, Restore über die vorhandene Datenbank (nur mit
  ausdrücklicher Bestätigung und vorheriger Sicherung), Point-in-Time.

## 8. Server: Datenmodell und API

- **Neue Tabellen** `endpoint_databases` (Engine, Instanz-Schlüssel, Art, Name, Kennung, Größe,
  `dropped_at`, Fakten) und `endpoint_database_backups` (Snapshot, Datei, SHA-256, Bytes,
  Zeiten, Objektzähler, Status `active`/`pruned`). SQL Server behält seine Tabellen
  (`endpoint_sql_*`); ihre Ketten mit LSNs passen nicht in ein gemeinsames Schema. Die
  Modulseite liest beide über eine gemeinsame Abfrage. Migrationsnummer: die nächste freie bei
  der Umsetzung.
- **Agent-API:** Fähigkeit `db_native_v1` in Enroll und Heartbeat; `databaseInventory` im
  Heartbeat; `GET /config` trägt `databases: { enabled, engines: { postgresql?, mysql? },
  instances, databases, exclude }`; Läufe `db`, `db_restore`, `db_verify`; Aufgaben
  `db_inventory`, `db_restore`, `db_verify`. Der Vertrag wird wie bei SQL Server mit Testdaten
  festgelegt, die Agent und Server teilen (`agent/internal/api/testdata/contract/`).
- **Session-API:** `GET /api/v1/databases` (Liste des Mandanten, beide Quellen),
  `GET /api/v1/databases/:id`, `POST …/restore`, `POST …/verify`, `GET …/restore-guide`,
  `POST /api/v1/endpoints/:id/databases/inventory`. Aktionen nur für Admins, Lesen auch für
  Restore-Bediener.
- **Aufbewahrung:** Regeln des Rechners je Gruppe `db:<engine>:<schlüssel>:<datenbank>`;
  DB-Snapshots werden nie als `unrecorded` markiert; eine Sicherung, deren Snapshot vergessen
  wurde, wird `pruned`.
- **Fehlercodes** (neu, Präfix `db_`): `db_instance_unreachable`, `db_login_missing`,
  `db_permission_missing`, `db_dump_failed`, `db_snapshot_failed`, `db_tool_missing`,
  `db_tool_too_old`, `db_database_unavailable`, `db_restore_name_taken`,
  `db_restore_no_space`, `db_restore_failed`, `db_backup_mismatch`, `db_verify_no_space`,
  `db_verify_timeout`, `db_container_gone`. Hinweise: `db_nontransactional_tables`,
  `db_version_untested`, `db_too_large_to_verify`.

## 9. Versionen

Unterstützt werden die Hauptversionen, die das jeweilige Projekt beim Erscheinen von 0.6.0 noch
pflegt. Stand dieses Entwurfs: PostgreSQL 14 bis 18 (19, sobald erschienen), MySQL 8.0 und 8.4
LTS, MariaDB 10.6, 10.11, 11.4 und 11.8 **[CI]**. Ältere laufen mit dem Hinweis
`db_version_untested`. Die CI prüft jede dieser Versionen als Container auf dem Linux-Runner.

## 10. Aussagen (docs/CLAIMS.md)

Neue Einträge, jeweils mit Test-Tag:

- Eine Datenbank lässt sich einzeln und unter neuem Namen wiederherstellen.
- Ein abgebrochener Dump wird nie zu einer Sicherung (restic legt keinen Snapshot an).
- Grün heißt: aus dem Repository geholt, Prüfsumme gleich, vollständig eingespielt, alle
  Objekte da.
- Restow speichert für die Sicherung von PostgreSQL und MariaDB kein Datenbank-Kennwort.
- Ist die native Sicherung an, steckt der Datenordner nicht zusätzlich in der Dateisicherung.

## 11. Umsetzung in Stufen

| Stufe | Inhalt |
|---|---|
| D1 | Modul `databases` mit Migration, Seiten Datenbanken und Instanzen, SQL Server zieht um, Inventur für PostgreSQL, MySQL und MariaDB (Dienst und Docker) ohne Sicherung |
| D2 | PostgreSQL: Sicherung, Restore unter neuem Namen, Download mit Anleitung |
| D3 | MySQL und MariaDB: dasselbe |
| D4 | Prüfung `db_verify` für beide, Bewertung, Alarme |
| D5 | Härtung: Versionsmatrix in der CI, große Datenbanken, Abbruch während des Dumps, Container neu erzeugt, Aufnahmen auf echter Hardware **[HW]** |

Später: Point-in-Time (PostgreSQL über WAL-Archivierung mit `pg_backup_start`/`pg_backup_stop`
zusammen mit dem Dateisystem-Snapshot, MySQL/MariaDB über Binlogs), MongoDB, Podman, PostgreSQL
und MySQL unter Windows, Restore auf einen anderen Rechner.

## 12. Tests

- **Einheit (Go):** Argumentlisten der Dump-Programme (keine Shell, keine Verkettung), Zähler im
  Datenstrom, Journal und Aufräumen der Prüfkopien, Erkennung aus Fixtures (`pg_lsclusters`,
  `docker inspect`).
- **Vertrag:** gemeinsame Testdaten für Inventur, Lauf, Prüfung und Restore.
- **Server (pg-Tests):** Inventur nach Kennung (neu angelegte Datenbank = neue Zeile),
  Bewertung, Aufbewahrung, Modul-Migration (mit und ohne SQL Server in Benutzung).
- **Ende zu Ende (CI):** Agent gegen jede Version aus 9 als Dienst und als Container: Daten
  anlegen, sichern, ändern, unter neuem Namen zurück, vergleichen; Dump mitten im Lauf
  abbrechen und belegen, dass kein Snapshot entsteht; Prüfung grün und mit beschädigter Datei
  rot.

## 13. Offene Fragen

- **F1** Prüfung auf der Instanz des Kunden (Vorschlag für 0.6.0, wie SQL Server) oder in einem
  Restow-eigenen Wegwerf-Container im Labor (keine Last beim Kunden, braucht ein Image je
  Version)? Vorschlag: auf der Instanz in 0.6.0, Labor als Option in 0.6.x.
- **F2** MySQL mit Kennwort und ohne Socket-Anmeldung: lokales Kennwort auf dem Rechner zulassen
  (4, Rückfall) oder nur den Benutzer mit `auth_socket`? Vorschlag: beides, das lokale Kennwort
  nur, wenn der Administrator es auf dem Rechner selbst setzt.
- **F3** Windows-Rechner mit PostgreSQL oder MySQL schon in 0.6.0? Vorschlag: später.
