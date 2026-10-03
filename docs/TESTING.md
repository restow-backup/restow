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
  `features/webhooks/integrations.pg.test.ts`
- ee (Business und Service Provider): `ee/api/src/license/license.pg.test.ts` (Schlüssel
  mit einem Wegwerf-Testschlüssel aus `ee/licensing/testing/test-signer.mjs`),
  `ee/api/src/audit-log/audit.pg.test.ts`,
  `journal/receiver.pg.test.ts`, `journal/setup.pg.test.ts`,
  `legal-holds/legal-holds.pg.test.ts`, `provider-api/tenants.pg.test.ts`,
  `provider-dashboard/view.pg.test.ts`,
  `reports/summary.pg.test.ts`, `ee/worker/src/archive-retention/archive-retention.pg.test.ts`
- apps/worker: `framework.pg.test.ts` sowie die Postgres-Abschnitte von
  `handlers/restore.test.ts`, `handlers/webhooks.test.ts` und `handlers/audit-anchor.test.ts`
- Endpoint-Backup (docs/AGENT.md), brauchen zusätzlich das restic-Binary (`RESTIC_BINARY` oder
  im `PATH`): apps/api `features/endpoints/endpoints.pg.test.ts` (Enrollment, Agent-API, RLS),
  `features/endpoints/endpoints.restic.pg.test.ts` (Ende zu Ende mit dem echten restic gegen den
  REST-Endpunkt der API: append-only, Prune nur mit Wartungszugang, Restore Byte für Byte,
  Restore-Test grün nur bei passenden Hashes, Download), apps/worker
  `endpoints/endpoints.pg.test.ts` (Retention, Prüfung, Restore-Test, Alarme),
  apps/scheduler `endpoints.pg.test.ts`
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
- apps/api: `features/imports/imports.pg.test.ts`, `features/exports/exports.pg.test.ts`,
  `features/restore/imported.pg.test.ts`, `features/archive/sent-at.pg.test.ts`
- packages/db: `imports.pg.test.ts` (RLS, Segment-Eindeutigkeit, Kaskaden der Import-Tabellen),
  `rls.pg.test.ts` — RLS auf der echten Anwendungsrolle: ohne Pin keine
  Zeile, mit Pin auf Mandant A keine Zeile von B, kein Schreiben für B, kein Ändern des
  Audit-Logs; die Installationsrolle sieht alle Mandanten. Diese Suite legt eindeutig
  benannte Rollen an und löscht sie wieder, braucht daher einen Superuser.

## Restore-Beweis in Produktion

- `verify`-Job wöchentlich je geschütztem Objekt: zufällig 20 Mails und 20 Dateien (dazu
  wenige Kalender- und Kontaktelemente) aus dem letzten Snapshot über den Restore-Pfad
  zurücklesen, mit dem Manifest vergleichen, Ergebnis speichern, Recovery-Readiness anzeigen.
  Rot nur mit Beleg: Daten fehlen (ein Chunk, den der Index nicht kennt, oder eine Datendatei,
  die jedes Speicherziel als nicht vorhanden meldet), stimmen nicht (Hash oder Größe, ein Chunk,
  der nicht der ist, den seine ID nennt) oder lassen sich nicht dekodieren (beschädigtes Pack,
  AES-GCM-Authentifizierung scheitert). Eine Prüfung, die der Speicher nicht bedienen konnte
  (Netzwerkfehler, Zeitüberschreitung, 5xx, Drosselung, unbekannter Fehler, ein Manifest, das der
  Speicher nicht liefert), ist "nicht abgeschlossen": kein Bericht, keine Benachrichtigung, der
  Job wird mit Backoff wiederholt, der letzte Versuch endet ohne Bewertung, und die nächste
  geplante Prüfung versucht es erneut. Eine zu alte neueste Sicherung (sieben Tage oder mehr) ist
  ein eigener roter Grund ("Sicherung zu alt").
  Ein zusätzlicher Test-Restore in ein Prüfziel (Testpostfach des Mandanten) ist als
  optionale Sonde vorgesehen, in 0.1.0 aber nicht verdrahtet: Die Prüfung stellt nichts in ein
  Microsoft-365- oder IMAP-Ziel wieder her.
- Scrub: Pack-Integrität (SHA-256), Stichprobe wöchentlich, alles monatlich.
- Kettenprüfung Archiv: auf Abruf (API und Schaltfläche auf der Archiv-Seite). Ein täglicher
  automatischer Lauf ist Zielbild und in 0.1.0 nicht umgesetzt.

## Regeln

- Kein Merge ohne grüne Stufen 1 bis 3 und 5.
- Jeder Bug bekommt zuerst einen Test, der ihn reproduziert.
- Live-Tests dürfen nur gegen den Dev-Tenant laufen; Kundendaten nie in Tests.
- Testdaten enthalten keine echten Personen (Faker mit festem Seed).
