# Teststrategie

Ein Backup-Produkt ist so gut wie sein schlechtester Restore. Tests sind hier kein
Qualitätsmerkmal, sie sind das Produkt. Ohne die unten genannten Stufen gilt ein
Feature als nicht vorhanden.

## Stufen

1. Unit (Vitest): Chunker (Determinismus, Grenzen, Referenzvektoren im Repo), Crypto
   (Roundtrip, Manipulation erkannt), Pack-Format (Schreiben/Lesen/Index), MIME-Parsing,
   Journal-Report-Parsing, Retention-Berechnung, Hash-Kette, Lizenzprüfung (in `ee/licensing`).
2. Integration (Vitest + Testcontainers): Postgres mit RLS (Mandant A sieht nie
   Daten von B, als Test je Tabelle), pg-boss-Jobs, S3 (Garage) und lokaler Speicher,
   Standalone-Restore aus einem echten Pack-Satz.
3. Graph-Contract-Tests: aufgezeichnete Antworten (Fixtures) für Delta, MIME, 429,
   410 Gone, Upload-Session. Läuft in CI ohne Microsoft.
4. Live-Tests gegen Dev-Tenant (nightly, nicht in PR-CI): synthetischer Datensatz
   (Skript erzeugt 200 Mails mit Anhängen, Kalender, Kontakte, OneDrive-Baum mit
   1.000 Dateien), Backup, Delta-Änderungen (löschen, verschieben, umbenennen, Flag),
   erneutes Backup, Restore in zweites Konto, Byte-Vergleich MIME und Dateien,
   Metadaten-Vergleich. Ergebnis als Report im Repo (`docs/live-results/`).
   Stand 0.1.0: Diese Stufe hat noch nie gegen einen echten Microsoft-365-Tenant
   gelaufen (der Release-Smoke-Check 4 wird ohne Dev-Tenant-Zugangsdaten übersprungen,
   siehe CI.md); Microsoft 365 ist nur gegen die simulierte Graph-API getestet.
5. E2E (Playwright): Login mit virtuellem Authenticator (Passkey), Mandant anlegen,
   Restore-Dialog, i18n-Umschaltung (jeder Screen in de und en ohne fehlende Keys;
   fehlende Keys sind Testfehler).
6. Chaos: Worker mitten im Job killen, Speicher kurz nicht erreichbar, 429-Sturm,
   Netzabbruch bei Upload-Session; erwartet: Wiederaufnahme ohne Duplikate.

### Postgres-Suiten (Stufe 2)

Die Suiten gegen eine echte Datenbank laufen, sobald `RESTOW_TEST_DATABASE_URL` auf einen
Postgres-16-Server zeigt (eine Rolle mit `CREATEDB`, z. B.
`postgres://restow@localhost:5432/postgres`). Jede Suite legt ihre eigene Datenbank
`restow_*_test` neu an (eine vorhandene wird vorher gelöscht) und migriert sie. Ohne die
Variable werden sie übersprungen und als "skipped" gemeldet; CI stellt dafür einen
Postgres-Service bereit und setzt die Variable.

- apps/api: `features/usage/usage.pg.test.ts`,
  `features/provider-team/provider-team.pg.test.ts` (Mitglieder: Einladung, Rollen,
  Mandantenbeschränkung nur mit dem freigeschalteten Merkmal `providerTeam.tenantScope`,
  Zugang zurücksetzen), `cli/admin-recovery.pg.test.ts`,
  `features/restore/restore.pg.test.ts`, `features/snapshots/explorer.pg.test.ts`,
  `features/snapshots/preview.pg.test.ts`, `features/snapshots/routes.pg.test.ts`,
  `features/snapshots/calendar.pg.test.ts` (Kalender im Explorer: Termine nach Beginn,
  Monatsansicht mit Serien aus echtem verschlüsseltem Inhalt),
  `features/snapshots/people.pg.test.ts` (Personen im Explorer seitenweise: stabiler Keyset,
  Suche, Typfilter, eigener Eintrag zuerst), `features/snapshots/memberships.pg.test.ts` (Teams
  und Websites einer Person: Inhaber zuerst, stabiler Keyset, eine Abfrage je Seite, nur für
  Wiederherstellungsoperatoren und Administratoren), `features/snapshots/explorer-scale.pg.test.ts`
  (Ordnerliste eines Postfachs mit 60 000 Nachrichten und eines OneDrive mit 20 000 Ordnern
  über den Index: Plan ohne Scan aller Einträge, gleiche Zeilen wie der vollständige Scan,
  rund 25 s), `features/webhooks/integrations.pg.test.ts`
- ee (Business und Service Provider): `ee/api/src/license/license.pg.test.ts` (Schlüssel
  mit einem Wegwerf-Testschlüssel aus `ee/licensing/testing/test-signer.mjs`),
  `ee/api/src/audit-log/audit.pg.test.ts`,
  `journal/receiver.pg.test.ts`, `journal/setup.pg.test.ts`,
  `legal-holds/legal-holds.pg.test.ts`, `provider-api/tenants.pg.test.ts`,
  `provider-dashboard/view.pg.test.ts`,
  `reports/summary.pg.test.ts`, `ee/worker/src/archive-retention/archive-retention.pg.test.ts`
- apps/worker: `handlers/directory-memberships.pg.test.ts` (Inhaber und Mitglieder der
  Microsoft-365-Gruppen auf Gruppe und Gruppen-Website, Ersetzen beim erneuten Lesen, Zeilen
  bleiben bei verweigertem Lesen), `framework.pg.test.ts` sowie die Postgres-Abschnitte von
  `handlers/restore.test.ts`, `handlers/webhooks.test.ts` und `handlers/audit-anchor.test.ts`
- Endpoint-Backup (docs/AGENT.md), brauchen zusätzlich das restic-Binary (`RESTIC_BINARY` oder
  im `PATH`): apps/api `features/endpoints/endpoints.pg.test.ts` (Enrollment, Agent-API, RLS),
  `features/endpoints/endpoints.restic.pg.test.ts` (Ende zu Ende mit dem echten restic gegen den
  REST-Endpunkt der API: append-only, Prune nur mit Wartungszugang, Restore Byte für Byte,
  Restore-Test grün nur bei passenden Hashes, Download), apps/worker
  `endpoints/endpoints.pg.test.ts` (Retention, Prüfung, Restore-Test, Alarme),
  apps/scheduler `endpoints.pg.test.ts`. Ohne restic: apps/api
  `features/endpoints/removal.pg.test.ts` (Rechner entfernen: nur gesperrt, Hostname, Legal Hold,
  Verdacht, Ablaufdatum, aus jeder Liste, Mandantentrennung) und apps/worker
  `endpoints/removal.pg.test.ts` (Löschen auf allen Zielen, Halt, Aufschub durch Sperren,
  Verlängerung der Sperren)
- apps/scheduler: `scheduler.pg.test.ts`, `roles.pg.test.ts` (Scheduler auf den
  provisionierten Rollen, pg-boss als Installationsrolle)
- Jobs (docs/ARCHITECTURE.md, "Jobs"): packages/db `backup-jobs.pg.test.ts` (RLS, Eindeutigkeiten,
  Kaskade, `superseded_by_job_id` überlebt das Löschen des Jobs); apps/api
  `features/backup-jobs/backup-jobs.pg.test.ts` (Routen, 422 mit Feldnamen, ein Objekt in einem Job,
  Konfiguration der Rechner, Hook-Regel und frische Anmeldung, Jetzt ausführen, Rollen, Mandantentrennung)
  und `migration.pg.test.ts` (die Migration älterer Installationen gegen realistische Fixtures: Anzahl der
  Jobs, nichts verloren, Konfigurationen unverändert, zweiter Lauf ändert nichts, Audit);
  apps/scheduler `jobs.pg.test.ts` (Planung aus Jobs, Mitglieder mit eigenem Takt, übernommene Zeitpläne,
  geänderter Job zwischen Laden und Einreihen) und `defaults.pg.test.ts` (Standard-Job); apps/worker
  `handlers/verify-origin.pg.test.ts` und `handlers/retention.pg.test.ts` (Aufbewahrung je Job)
- apps/worker: `handlers/mail-files.pg.test.ts` (Import, Archivaufnahme mit Hash-Kette, Export
  versiegelt, Bereinigung, Ziel-Postfach für den Restore eines importierten Postfachs)
- Proxmox VE in den Übersichten: apps/api `features/pve/protection.pg.test.ts` (Status,
  Wiederherstellbarkeit, GET /status, Fehlschläge der Provider-Ansicht, Warnungen, Statistik,
  Mandantentrennung mit RLS), apps/worker `overdue.pg.test.ts` (`backup.overdue` für Gäste und mit
  der eigenen Frist einer Regel), apps/api `features/reports/reports.pg.test.ts` (Frist der Regel)
- apps/api: `features/imports/imports.pg.test.ts`, `features/exports/exports.pg.test.ts`,
  `features/restore/imported.pg.test.ts`, `features/archive/sent-at.pg.test.ts`
- packages/db: `imports.pg.test.ts` (RLS, Segment-Eindeutigkeit, Kaskaden der Import-Tabellen),
  `rls.pg.test.ts` — RLS auf der echten Anwendungsrolle: ohne Pin keine
  Zeile, mit Pin auf Mandant A keine Zeile von B, kein Schreiben für B, kein Ändern des
  Audit-Logs; kein Zugriff auf better-auth-Tabellen (außer Name und E-Mail eines Benutzers),
  Installationstabellen und Job-Payloads in `pgboss` (nur Einstellen), die Rechte jeder
  Tabelle wie in `TABLE_ACCESS` (roles.ts), die Auth-Rolle unter RLS, das Entziehen der
  0.3.4-Rechte beim Update; die Installationsrolle sieht alle Mandanten. Diese Suite legt
  eindeutig benannte Rollen an und löscht sie wieder, braucht daher einen Superuser.
  `schema/schema.test.ts` schlägt fehl, wenn eine Tabelle weder unter RLS steht noch in
  `TABLE_ACCESS` eingeordnet ist.

## Restore-Beweis in Produktion

- `verify`-Job wöchentlich je geschütztem Objekt: zufällig 20 Mails und 20 Dateien (dazu
  wenige Kalender- und Kontaktelemente) aus dem letzten Snapshot über den Restore-Pfad
  zurücklesen, mit dem Manifest vergleichen, Ergebnis speichern, Recovery-Readiness anzeigen.
  Zu einer gezogenen Mail, die als JSON mit getrennten Anhängen gesichert ist (zu groß für MIME),
  werden alle Anhänge mitgelesen, zu einer gezogenen OneDrive-Datei ihre früheren Versionen; ein
  fehlerhafter Anhang oder eine fehlerhafte Version zählt gegen die Mail bzw. Datei (seit 0.5.0).
  Die Integritätsprüfung (Health Check) liest jedes Objekt mit Inhalt, Anhänge und Versionen
  eingeschlossen.
  Grün setzt seit 0.5.0 auch eine vollständige Sicherung voraus: Hat der Lauf, der den geprüften
  Sicherungsstand erstellt hat, Elemente nicht sichern können (`jobs.item_failure_summary`), ist
  die Bewertung gelb ("Sicherung unvollständig"), rot für Elemente, die in den letzten drei
  Läufen in Folge fehlschlugen. Das gilt für die Bewertung je Objekt, die Übersicht des
  Mandanten, die Statistik und `verify.completed`; `job.completed` einer Sicherung nennt
  `failedItems`.
  Rot nur mit Beleg: Daten fehlen (ein Chunk, den der Index nicht kennt, oder eine Datendatei,
  die jedes Speicherziel als nicht vorhanden meldet), stimmen nicht (Hash oder Größe, ein Chunk,
  der nicht der ist, den seine ID nennt) oder lassen sich nicht dekodieren (beschädigtes Pack,
  AES-GCM-Authentifizierung scheitert). Eine Prüfung, die der Speicher nicht bedienen konnte
  (Netzwerkfehler, Zeitüberschreitung, 5xx, Drosselung, unbekannter Fehler, ein Manifest, das der
  Speicher nicht liefert), ist "nicht abgeschlossen": kein Bericht, keine Benachrichtigung, der
  Job wird mit Backoff wiederholt, der letzte Versuch endet ohne Bewertung, und die nächste
  geplante Prüfung versucht es erneut. Seit 0.5.0 bleibt ein altes Grün dabei nicht beliebig
  stehen: Endet die Prüfung derselben Sicherung dreimal in Folge so (jeweils der letzte Versuch),
  wird sie gelb ("die letzten Prüfungen konnten nicht abgeschlossen werden", `check_incomplete`) mit der Meldung "braucht
  Aufmerksamkeit". Ein Manifest, das jedes Speicherziel als nicht vorhanden meldet, ist Beleg,
  wenn dieselben Ziele die übrigen Daten des Mandanten noch halten (seine Schlüssel unter
  `tenants/<tid>/keys/` oder ein anderes Manifest): rot `manifest_missing`; ein geleertes oder
  nicht eingehängtes Ziel bleibt "nicht abgeschlossen". Eine zu alte neueste Sicherung (sieben Tage oder mehr) ist
  ein eigener roter Grund ("Sicherung zu alt"). Seit 0.5.0 bewerten die Readiness-Seite, die
  Bewertung des Mandanten, die Integrations-API und die Statistik das Alter der neuesten
  Sicherung beim Anzeigen, nicht nur bei der Prüfung: Hören die Sicherungen nach einer grünen
  Prüfung auf, wird das Objekt nach 48 Stunden gelb und nach sieben Tagen rot, ohne auf die
  nächste Prüfung zu warten (nicht für Objekte, die ohne Alter bewertet werden).
  Ein zusätzlicher Test-Restore in ein Prüfziel (Testpostfach des Mandanten) ist als
  optionale Sonde vorgesehen, in 0.1.0 aber nicht verdrahtet: Die Prüfung stellt nichts in ein
  Microsoft-365- oder IMAP-Ziel wieder her.
- Scrub: Pack-Integrität (SHA-256), Stichprobe wöchentlich, alles monatlich. Seit 0.5.0 fragt
  der Scrub außerdem jedes Ziel nach dem Manifest jeder aktiven Sicherung (Stichprobe: der
  neuesten je Objekt; nicht während einer Speichermigration und nicht für Sicherungen vor einem
  Austausch mit "keep"); fehlt es auf jedem Ziel bei sonst vorhandenen Daten des Mandanten,
  bekommt das Objekt einen roten Befund `manifest_missing` und `scrub.corrupt` nennt die Zahl.
- Kettenprüfung Archiv: auf Abruf (API und Schaltfläche auf der Archiv-Seite). Ein täglicher
  automatischer Lauf ist Zielbild und in 0.1.0 nicht umgesetzt.

## Regeln

- Kein Merge ohne grüne Stufen 1 bis 3 und 5.
- Jeder Bug bekommt zuerst einen Test, der ihn reproduziert.
- Live-Tests dürfen nur gegen den Dev-Tenant laufen; Kundendaten nie in Tests.
- Testdaten enthalten keine echten Personen (Faker mit festem Seed).
