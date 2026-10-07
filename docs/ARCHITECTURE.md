# Architektur

## Komponenten

```
apps/web        React + shadcn/ui, spricht nur mit apps/api (REST + SSE für Fortschritt)
apps/api        Hono, better-auth, REST /api/v1, Webhooks, Erweiterungspunkte für ee/
apps/worker     pg-boss-Worker: backup, restore, verify, archive-sync, directory-sync, retention
apps/scheduler  legt fällige Jobs an (cron-artig, ein Prozess, leader-lock in Postgres)
apps/site       Astro-Landingpage (eigenständig deploybar)
packages/core   Chunk-Store, Crypto, Graph-Client, IMAP-Client, MIME-Parser, Manifeste
packages/db     Drizzle-Schema, Migrationen, RLS-Policies
packages/i18n   Übersetzungen (de, en), Typen, Tolgee-Sync
packages/cli    restow-restore (Standalone-Restore aus Speicher ohne Server)
ee/             Business- und Service-Provider-Module (eigene Lizenz, ee/LICENSE):
                ee/api, ee/worker, ee/web und ee/licensing (Lizenzschlüssel, Editionen)
```

Der Kern (alles außerhalb von `ee/`) kennt keine Lizenz, keine Edition und keine
Capability; wie `ee/` sich über die Erweiterungspunkte einhängt, steht im Abschnitt
"Erweiterungsschnittstelle und `ee/`" unten.

Server und Clients (Endpunkte) sichert der Restow-Agent mit restic, dateibasiert und
append-only; Aufbau, Protokoll und Grenzen stehen in docs/AGENT.md. Die Jobs dazu
(`endpoint-retention`, `endpoint-check`, `endpoint-verify`, `endpoint-monitor`) laufen in eigenen
pg-boss-Queues neben den Mandanten-Queues.

Ein Docker-Image, Rolle über `CMD` (api | worker | scheduler). Compose startet je eins,
Worker skalierbar. Postgres 16 ist die einzige Zustandsquelle außer dem Chunk-Speicher.

### Gesundheit (`/healthz`, `/readyz`)

- `GET /healthz` ist reine Lebendigkeit: der API-Prozess antwortet. Sie hängt von nichts anderem
  ab (Docker-Healthcheck, Edge-Vorabfrage); ein fehlender Worker startet also keinen API-Container neu.
- Worker und Scheduler melden sich in `service_heartbeats` (Rolle, Instanz-ID, Version, Hostname,
  `started_at`, `beat_at`, Zustand in `details`): beim Start, danach alle 30 Sekunden, und sie
  löschen ihre Zeile beim geordneten Beenden. Der Worker meldet erst, wenn seine Queues bedient
  werden (`running`, beim Beenden `stopping`), der Scheduler jede Instanz (`leader`, `standby`,
  `stopping`). Zeit vergleicht die Datenbank selbst (`now()`), nicht die Uhr der Container; Zeilen
  toter Instanzen räumt der nächste Start nach einem Tag ab.
- `GET /readyz` meldet `{ status, checks: { database, worker, scheduler } }`. `worker` und `scheduler`
  sind `ok`, wenn irgendeine Instanz der Rolle vor weniger als 2 Minuten geschlagen hat, sonst
  `missing`. Bereit (200) ist die Installation nur mit erreichbarer Datenbank und beiden Rollen:
  ein Backup-Produkt ohne Worker oder Scheduler ist nicht bereit, also 503 `not_ready`. Der Updater
  wartet nach dem Stoppen von Worker und Scheduler auf die neue API und startet beide erst danach;
  er wertet die API deshalb als bereit, sobald `database` stimmt und nur Worker oder Scheduler
  fehlen.

## Mandantenmodell

- `provider` (die Installation gehört genau einem Betreiber; Community = 1 Mandant)
- `tenant` (Kunde; `mailboxCap`, Spalte `edition_limit_mailboxes`, ist eine mit dem Kunden
  vereinbarte Postfachzahl, nur Anzeige, nie durchgesetzt), `tenant_key` (Verschlüsselung). Den ersten
  Mandanten legt der Kern immer an; jeder weitere existiert nur, solange eine Erweiterung
  `tenants.additional` freischaltet (siehe unten).
- Eigene Organisation (`tenant.kind`): Ein Mandant ist `customer` (Standard) oder `internal`,
  die eigene Organisation des Betreibers mit seinem eigenen M365, seinen Servern und seinem
  Speicher. Höchstens einer je Provider ist `internal` (partieller Unique-Index
  `tenants_internal_uq`). Der Setup-Wizard legt ihn aus dem Namen der Organisation an
  (`providers.name`); eine Installation aus 0.1.x bekommt ihn beim API-Start, wenn sie
  höchstens einen Mandanten haben kann (`tenants.additional` aus) und genau einen hat; sonst
  markiert ein Provider-Admin einen Mandanten (`POST /api/v1/tenants/:id/internal`, mit
  `confirmSwitch: true`, wenn die Markierung von einem anderen wandern soll) oder legt sie an
  (`POST /api/v1/tenants/internal`). Ein interner Mandant lässt sich nicht löschen
  (409 `urn:restow:problem:internal-tenant-protected`). `GET /me` und `GET /tenants` führen
  `kind` und `customerNumber` und stellen die eigene Organisation an den Anfang.
- `source` je Mandant: `m365` (App-Consent, Tenant-ID), `imap` (Host, Auth) oder `import`
  (Mail-Dateien, kein Server; ihre importierten Postfächer sind `protected_objects` der Art
  `imap` im Speicherformat des IMAP-Backups, siehe docs/IMPORT.md)
- `protected_object`: Postfach, OneDrive, IMAP-Konto; Herkunft `directory_sync` oder
  `manual`; Schutzstatus (aktiv, ausgeschlossen, verwaist)
- Rollen: `provider_admin`, `tenant_admin` (inkl. entra_global_admin via SSO), `tenant_user`
- Row Level Security: jede Tabelle mit `tenant_id` hat eine Policy; API setzt
  `SET LOCAL app.tenant_id` je Request. Provider-Admin arbeitet mit explizitem
  Mandantenwechsel, nie tenant-übergreifend in einer Query.
- Datenbankrollen (packages/db/src/roles.ts), damit RLS tatsächlich greift und nicht
  nur auf dem Papier steht:
  - Owner (`DATABASE_MIGRATION_URL`, in Compose `POSTGRES_USER`): führt nur die
    Migrationen aus und besitzt alle Tabellen.
  - Anwendungsrolle (`DATABASE_URL`): `NOSUPERUSER`, `NOBYPASSRLS`, besitzt keine
    Tabelle. Alle Mandantenarbeit läuft darauf in `withTenantTx`; eine Abfrage ohne
    Mandantenfilter sieht trotzdem nur den gepinnten Mandanten, ohne Pin gar nichts.
  - Installationsrolle (`DATABASE_PROVIDER_URL`, `BYPASSRLS`): nur für Lookups, bevor
    ein Mandant feststeht (Session-Mandant, API-Key, Mandantenliste, `/me`),
    installationsweite Daten (Settings, Provider-Secrets, Provider-API-Keys, die
    Lizenztabelle des Moduls `ee/licensing`,
    Installations-Auditkette), Provider-Übersichten, die mandantenübergreifenden Scans
    (Scheduler, Webhook-Zustellung, Audit-Anker) und pg-boss (Eigentümer des Schemas
    `pgboss`; die Anwendungsrolle darf dort Jobs einstellen).
  Der Migrationsschritt legt beide Login-Rollen mit Name und Passwort aus ihren
  Connection-Strings an (SCRAM-Verifier clientseitig berechnet, das Klartextpasswort
  steht in keinem SQL-Statement) und vergibt die Rechte; `audit_log`, `audit_anchor`,
  `archive_anchor` sind für beide Rollen nicht änderbar, `archive_items` löscht nur die
  Installationsrolle (Retention). api, worker und scheduler prüfen beim Start, dass die
  Anwendungsrolle RLS nicht umgehen kann, und starten sonst nicht.

## Chunk-Store (offenes Format)

Ziel: Dedupe über Mandanten hinweg ist nicht erlaubt (Schlüssel je Mandant), innerhalb
eines Mandanten über alle Objekte.

- Chunking: FastCDC, min 256 KiB, avg 1 MiB, max 4 MiB. Kleine Objekte (< 256 KiB)
  sind ein Chunk.
- Chunk-ID: SHA-256 über Klartext (Dedupe-Schlüssel), HMAC-SHA-256 mit Mandanten-
  Key als gespeicherte ID (verhindert Inhaltsraten über IDs).
- Verschlüsselung: AES-256-GCM je Chunk, Nonce zufällig, AAD = Chunk-ID. Schlüssel:
  Mandanten-Datenkey (DEK), verschlüsselt mit Master-Key aus Umgebung/KMS (KEK).
  Rotation: neue DEK für neue Chunks, alte bleiben lesbar (Key-Version im Header).
  Jeder Leser (Restore, Verify, Standalone-Restore) prüft einen Chunk, bevor er dessen
  Bytes herausgibt: die im versiegelten Header gebundene ID (AAD) muss der angeforderten
  ID entsprechen, und die aus dem Klartext neu berechnete gespeicherte ID ebenso.
  Abweichung ist ein Integritätsfehler (`RestoreIntegrityError`), bevor Bytes ein
  Restore-Ziel erreichen.
- Pack-Dateien: bis 64 MiB, Chunks hintereinander, Index am Ende (Chunk-ID, Offset,
  Länge), Datei-Header mit Magic `RESTOWPK`, Version, Mandanten-ID. Eine Chunk-ID steht
  in einem Pack höchstens einmal: der Writer hängt ein Duplikat nicht an, und parallele
  Schreibvorgänge desselben Writers beanspruchen jede neue ID genau einmal. Ältere Packs
  mit doppeltem Index-Eintrag liest der Reader mit dem ersten Eintrag, so wie im
  Chunk-Index die erste Zeile gilt.
- Speicherlayout: `tenants/<tid>/packs/<xx>/<packid>`, `tenants/<tid>/manifests/
  <snapshot>.json.zst`, `tenants/<tid>/keys/` (nur verschlüsselte DEKs),
  `tenants/<tid>/archive/...` (versiegelte Archiv-Datensätze; auf S3 mit Object Lock nur
  diese Datensätze mit Retention, nicht die Packs, siehe ARCHIVE.md).
- Manifeste: je Snapshot eine Objektliste mit Pfad, Größe, mtime, Metadaten,
  Chunk-Liste. Postgres hält denselben Index für Suche und Restore; Manifest im
  Speicher ist die Wahrheit für den Standalone-Restore.
  Serialisierung (Manifest-Format 2, `packages/core/src/manifest.ts`): 1 Byte
  Codec-Tag, dann der Inhalt. `0x03` = NDJSON mit zstd, `0x02` = NDJSON ohne
  Kompression (Laufzeit ohne zstd). NDJSON heißt: UTF-8, ein JSON-Wert je Zeile, jede
  Zeile endet mit LF. Zeile 1 ist der Kopf (alle Manifest-Felder außer `objects`,
  dazu `objectCount`), jede weitere Zeile genau ein Objekt in Manifest-Reihenfolge.
  Ein Leser muss genau `objectCount` Objektzeilen finden, sonst gilt das Manifest
  als abgeschnitten und wird abgelehnt statt als kleinerer Snapshot gelesen.
  Geschrieben und gelesen wird zeilenweise und als zstd-Stream, nie als ein String
  des ganzen Manifests: V8 begrenzt Strings auf rund 2^29 Zeichen, ein einzelnes
  JSON-Dokument scheiterte daher ab etwa 500.000 Objekten (großes Shared- oder
  Archivpostfach). Format 1 (`0x00` JSON, `0x01` JSON mit zstd, ein Dokument) bleibt
  lesbar, wird aber nicht mehr geschrieben.
  Versiegelung (`packages/core/src/engine/sealed-manifest.ts`): im Speicher liegt jedes
  Manifest und jeder Checkpoint versiegelt. Codec-Tag `0x10`, danach ein versiegelter
  Blob im Chunk-Layout (AES-256-GCM mit der aktuellen Mandanten-DEK, Key-Version im
  Header), dessen Klartext die unversiegelte Serialisierung oben ist. AAD ist der
  UTF-8-Speicherschlüssel (`tenants/<tid>/manifests/<snapshot>.json.zst` bzw.
  `.partial`); er steht im Header im Klartext, nennt nur Mandanten- und Snapshot-ID (die
  der Pfad ohnehin zeigt) und bindet das Manifest an seinen Ort: an einen anderen
  Schlüssel kopiert, öffnet es sich nicht, und Mandant und Snapshot im Inhalt müssen zum
  Schlüssel passen. Grund: Pfade (aus Betreffen, Kontakt- und Dateinamen), Message-IDs,
  Ordnernamen und der Klartext-SHA-256 jedes Objekts wären sonst für jeden lesbar, der
  das Speicherziel lesen kann (Anbieter einer Offsite-Kopie, Storage-Admin); der
  Klartext-Hash würde bei Objekten unter 256 KiB (ein Chunk) zudem die HMAC-IDs
  aushebeln. Unversiegelte Manifeste älterer Versionen (`0x00` bis `0x03`) bleiben
  lesbar.
- Backends: lokaler Speicher im App-Container (Docker-Volume) als Standard ohne
  Zusatzdienst, S3-kompatibel (AWS SDK v3, Pfadstil und virtuelle Hosts) und weiteres
  gemountetes Dateisystem (NFS). Object Lock (Retention-Datum) für die Archiv-Datensätze auf
  S3-Zielen mit Object Lock; die Packs mit dem Nachrichteninhalt und die Sicherungsdaten tragen
  in 0.1.0 keine Retention (ARCHIVE.md, "Speicherung"). Auf lokalem Speicher, NFS gibt es
  keine Hardware-Unveränderbarkeit. Mehrere Ziele je Mandant (Primär plus Kopie) und der Wechsel des Primärziels
  (Speicherziel hinzufügen, Migration mit oder ohne Kopie der Altbestände, Umschalten):
  docs/STORAGE.md.
- Garbage Collection: Referenzzählung in Postgres, Chunks ohne Referenz nach Ablauf
  der Snapshot-Retention in neue Packs umkopieren, alte Packs löschen (nie in-place).
  Checkpoints (`<snapshot>.partial`) halten ihre Chunks nur, solange ein Retry sie noch
  fortsetzen kann (Job `queued` oder `active`). Endet der Job endgültig (abgeschlossen,
  nach dem letzten Retry fehlgeschlagen, abgebrochen), löscht der Worker Checkpoint,
  ein liegengebliebenes Manifest eines gescheiterten Commits und die laufende
  Snapshot-Zeile; ein Retry, der einen unlesbaren oder veralteten Checkpoint verwirft,
  räumt ihn ebenso weg. Der Scrub räumt nach, was dabei liegen blieb, und die GC löscht
  Checkpoints ohne fortsetzbaren Job, statt ihre Chunks zu behalten. Ein unlesbarer
  Checkpoint stoppt die GC nur, solange ihn noch ein Retry fortsetzen könnte.
- Integrität: jeder Pack hat SHA-256 der Gesamtdatei; wöchentlicher Scrub prüft
  Stichproben, monatlich alles (konfigurierbar).
- Beschädigte Packs: findet der Scrub ein Pack auf keinem Ziel intakt und ist der Schaden
  belegt (kein Ziel mit I/O-Fehler, und mindestens ein anderes geprüftes Pack ist intakt,
  sonst ist es eher ein Speicherausfall), setzt er `packs.damaged_at`. Chunks
  beschädigter Packs zählen für die Deduplizierung nicht mehr: das nächste Backup, das
  denselben Inhalt sieht, schreibt eine intakte Kopie, und die Chunk-Zeile zieht beim
  Eintragen des neuen Packs dorthin um (Referenzen bleiben). Eine Vollsicherung schreibt
  so alles neu, was die Quelle noch enthält; die Oberfläche sagt das beim Schaden dazu.
  Ein beschädigtes Pack ohne Chunk-Zeile nimmt der Scrub aus dem Katalog, die Datei wird
  wie ein ersetztes Pack frühestens nach der Wartezeit gelöscht. Prüft ein markiertes
  Pack wieder intakt, entfällt die Markierung.

Der Standalone-Restore (`packages/cli`) braucht: Speicherzugang, Manifest, DEK (der
Betreiber exportiert ihn verschlüsselt mit einem Passwort). Damit ist Restore ohne
laufenden Restow möglich. Das ist Vertragsbestandteil gegenüber Kunden. Ein versiegeltes
Manifest nennt im Header den Mandanten, dessen Schlüssel es öffnet; das Werkzeug lädt
diese Schlüssel zuerst und öffnet damit das Manifest.

## Job-System

- pg-boss in Postgres, Queues: `backup`, `restore`, `verify`, `archive`, `directory`,
  `retention`, `scrub`, `storage_migration`, `import`, `export`. Prioritäten: restore >
  export > verify > backup (import liegt zwischen archive und backup).
- Ein Backup-Job je geschütztem Objekt; ein Snapshot je Objekt je Lauf. Fortschritt in
  `job_progress` (Elemente gesamt/erledigt/fehlgeschlagen, Bytes, ETA), per SSE an UI.
- Durchsatz je Lauf (seit 0.2.0): `run_samples` hält kumulative Zähler `[epoch ms, verarbeitet, übertragen]`
  höchstens 300 Punkte je Lauf (`packages/db/src/run-samples.ts`; die ältere Hälfte wird ausgedünnt, Raten ergeben
  sich aus Nachbarpunkten). Mail-Läufe schreiben über den `PgProgressSink` des Workers, Agent-Läufe über
  `/agent/v1/runs/:id/progress` (übertragen = Wachstum von `endpoints.repository_bytes` seit Laufbeginn; der
  Agent meldet ab 0.2.0 alle 5 s). Die Oberfläche zeichnet die Übertragung als Durchschnitt über 15 s, weil
  Daten in Paketen im Repository ankommen und die rohe Rate sonst eine Rechteckwelle ergibt.
- Ein Live-Kanal je Browser-Tab: `GET /api/v1/live` (SSE, nur Session, Mandantenadministratoren) liefert Läufe beider
  Quellen als eine Form (`RunDto`, `apps/api/src/features/history`), die Job-Definitionen mit letztem und nächstem Lauf
  und den Verbindungszustand der Maschinen. Der Server fragt alle 2 s die Datenbank und sendet nur Änderungen
  (Ereignisse `snapshot`, `run`, `definition`, `machine`, `gone`; alle 15 s ein Kommentar als Keep-alive). Der Client
  schreibt sie in den React-Query-Cache (`apps/web/src/features/history/live`), pausiert im Hintergrund-Tab und pollt
  weiter, solange der Kanal nicht steht. `/api/v1/jobs/events` bleibt unverändert. Der Verlauf (`/api/v1/history`,
  `/history/:id`) ist ein Lesemodell über `jobs` und `endpoint_runs`, ohne eigene Tabelle.
- Throttling-Budget je Source: Token-Bucket in Postgres (je Tenant-App), Worker
  reservieren Kapazität; 429 verkleinert das Budget, Erfolg vergrößert es (AIMD).
- Wiederaufnahme: Job speichert Cursor (Ordner, Delta-Token, letzte Item-ID); Neustart
  setzt fort, nichts wird doppelt geladen.
- Fehlgeschlagene Elemente bleiben als `item_failures` sichtbar mit Grund und werden
  beim nächsten Lauf erneut versucht; nach 3 Läufen Alarm.
- Fehlerursachen: Jeder gespeicherte Fehler wird im Kern (`packages/core/src/failures`)
  in eine stabile Ursache eingeordnet (`FailureCause`: Code wie `graph.consent_missing`,
  `graph.permission_missing`, `graph.throttled`, `imap.auth_failed`, `storage.full`,
  `crypto.key_missing`, `verify.hash_mismatch`, dazu Parameter, `transient` und redigierte
  technische Details wie HTTP-Status, Graph-Code, Request-IDs). Der Worker legt sie als jsonb
  neben den Klartext ab (`jobs.failure`, `item_failures.failure`, `sources.failure`,
  `protected_objects.credential_failure`, in `verify_reports.details` je Element und
  Testwiederherstellung); die alten Textspalten bleiben gefüllt, alte Zeilen ohne Ursache
  bleiben gültig. Der Katalog (`failures/catalog.ts`) kennt je Code die Schritte (mit Ziel
  in der UI), ob Warten genügt und ob ein manueller Neuversuch sinnvoll ist; die API
  liefert das als `failure` (Schritte, Doku-Link aus `RESTOW_DOCS_TROUBLESHOOTING_URL`), auch
  in Integrations-API und `job.failed`-Webhook. Die Texte je Code stehen in
  `packages/i18n/resources/{de,en}/failures.json`; ein Test schlägt fehl, wenn ein Code
  ohne Text bleibt. Neue Quellen von Fehlern (etwa Endpunkt-Läufe) hängen sich mit
  `FailureError`/`classifyFailure` und einem eigenen Code im Katalog ein.

## Jobs (Sicherungsdefinitionen)

Seit 0.2.0 ist ein **Job** (`backup_jobs`, Migration 0023) die Vorlage dafür, was gesichert wird, wann,
wohin und wie lange, für viele Objekte oder Rechner zugleich. Ein **Lauf** ist, was daraus entsteht
(`jobs`, `endpoint_runs`); die Integrations-API nennt Läufe weiter `/api/v1/jobs` (Alias
`/api/v1/runs`), die Definitionen heißen `/api/v1/backup-jobs` (Session-API der Weboberfläche).

- **Modell.** `backup_jobs`: Mandant, Art (`mail` oder `endpoint`), Name (je Mandant und Art
  eindeutig, ohne Groß/Klein), Umfang (`selected` = die Mitglieder, `all` = jedes geeignete Objekt des
  Mandanten, das in keinem anderen Job ist, auch später hinzukommende; höchstens ein `all`-Job je
  Mandant und Art), `schedule` (Intervall, Cron oder bei Rechnern täglich/bei Verbindung, mit
  Zeitzone; NULL = nur von Hand) und `verify_schedule` (nur Mail: Restore-Prüfung; NULL = keine),
  Repository (`storage_target_id`, NULL = Primärziel des Mandanten, das einzige, in das geschrieben
  wird), Aufbewahrung (Mail: `retention_policy_id` auf eine Snapshot-Richtlinie, NULL = Standard des
  Mandanten; Rechner: `settings.retention`), `settings` (Rechner: Pfade, Ausschlussmuster,
  Größenlimit, Hooks, Bandbreite in kbit/s als Standard plus optionale Zeitfenster `bandwidthWindows`), `enabled`, `origin` (`user` oder `migration`) und die
  Laufzeitspalten des Schedulers (`next_run_at`, `last_run_at`, `verify_*`). `backup_job_members`:
  ein Objekt oder ein Rechner (genau eines von `protected_object_id` und `endpoint_id`, je höchstens
  in einem Job) mit `overrides` (jsonb) und denselben Laufzeitspalten für ein eigenes Intervall.
  Beide Tabellen haben Row Level Security wie jede Mandantentabelle.
- **Ausführung Mail.** Der Scheduler plant Sicherung und Restore-Prüfung aus den Jobs
  (`apps/scheduler/src/planning.ts` `expandJobUnit`, `store.ts` `loadDueUnits`/`enqueueUnit`): ein Job
  auf seinem Takt für seine Objekte, ein Objekt mit eigenem Zeitplan auf dem Takt seines Mitglieds.
  Der Umfang eines Jobs ist eine reine Regel im Kern (`mailJobObjectIds`), die Scheduler, API und
  Worker teilen. Jeder geplante Lauf trägt `backupJobId` in der Nutzlast. Der Worker reiht nach einer
  Sicherung eine Restore-Prüfung ein, wenn der Job (oder das Mitglied) eine hat (`verifyBackupJobId`),
  sonst, wenn ein Zeitplan älterer Version das verlangt (`verifyScheduleId`).
- **Ausführung Rechner.** Der Agent plant selbst; der Server schreibt die Wirk-Konfiguration (Job plus
  Override) in `endpoints.config` und erhöht `config_version`, nur dort und nur bei einer Änderung
  (`apps/api/src/features/backup-jobs/endpoint-sync.ts`, docs/AGENT.md "Jobs"). Die Zeitfenster der
  Bandbreite (`bandwidthWindows`) stehen mit in dieser Konfiguration; ausgewertet werden sie beim Abruf
  `GET /agent/v1/config` für den Moment der Anfrage (reine Regel `effectiveBandwidthKbps` im Kern), ohne
  etwas zu schreiben und ohne `config_version` zu ändern. Der Agent liest die Konfiguration zu Beginn jeder
  Sicherung neu und bleibt dafür unverändert.
- **Rechner ohne Job sichern nicht (seit 0.2.1).** Die Anmeldung schreibt den Zeitplan `none`
  (`enrolledEndpointConfig`), und ein Rechner, der seinen Job verlässt (Mitglied entfernt, Umfang ohne ihn,
  Job gelöscht), bekommt ihn zurück (`releaseEndpointConfigs`). Ordner und übrige Einstellungen bleiben
  gespeichert; `GET /agent/v1/config` liefert bei `none` aber leere `paths` und keine Hooks
  (`agentFacingConfig`), damit ein Agent vor 0.2.1, der `none` nicht kennt und auf den Standard seines
  Profils zurückfällt, nichts sichert. "Jetzt sichern" und ein Zeitplan von Hand sind für einen Rechner
  ohne Job gesperrt (409 `endpoint-no-job`), die Liste markiert ihn mit `no_job`. Rechner, die schon vor
  0.2.1 ohne Job waren, behalten ihren Zeitplan. Einzelheiten in docs/AGENT.md, "Rechner ohne Job".
- **Wartung bleibt in `schedules`:** Aufbewahrungslauf, Speicherprüfung (scrub), Verzeichnisabgleich,
  Archiv-Sync. Auch ein Zeitplan älterer Version, den kein Job übernehmen konnte, läuft weiter.
- **Aufbewahrung Mail.** Die Objekte eines Jobs, der eine Richtlinie nennt, folgen ihr; eine Richtlinie,
  die auf genau das Objekt zeigt, gilt weiter vor der des Jobs (`withJobRetention` im Kern, vom Worker
  und von der Vorschau der API gleich benutzt). Eine Richtlinie, die ein Job nennt, lässt sich nicht
  löschen (409).
- **Migration älterer Installationen** (`apps/api/src/features/backup-jobs/migration.ts`, Regeln in
  `packages/core/src/backup-jobs/migration.ts`). Beim Start der API, einmal je Mandant
  (`tenants.backup_jobs_migrated_at`), eine Transaktion je Mandant, Advisory-Lock, nichts wird gelöscht:
  Mail: ein Job aus den aktivierten Zeitplänen `backup` und `verify`; objektbezogene Zeitpläne werden
  Overrides des Mitglieds, wenn ihre längste Pause zwischen zwei Läufen nicht länger ist als der kürzeste
  Abstand des Job-Zeitplans (`scheduleGaps`, über die nächsten fünf Wochen; sonst läuft der alte weiter,
  damit kein Objekt seltener gesichert wird, auch nachts, am Wochenende oder über den Monat nicht); hat
  ein Objekt mehrere eigene Zeitpläne einer Art, wird der mit den kürzesten Pausen sein Override und die
  übrigen laufen weiter;
  Zeitpläne, die ein Job übernimmt, behalten ihre Zeile und bekommen `superseded_by_job_id` (ohne
  Fremdschlüssel: ein gelöschter Job erweckt sie nicht wieder); Takte (`next_run_at`) werden übernommen,
  die Zeitpläne werden dafür gesperrt (ein Scheduler, der gerade einen davon ausführt, wird abgewartet;
  die Mandantenzeile nur mit `FOR NO KEY UPDATE`, damit kein Deadlock mit Einfügungen entsteht, die auf
  den Mandanten verweisen). Hat der Mandant schon einen Mail-Job, bleiben seine Zeitpläne und werden im
  Audit als `mail_job_exists` genannt. Rechner: aktive Rechner mit gleichem Profil, System und Zeitplan
  (so wie der Agent ihn liest, Zeitzone eingeschlossen) ergeben einen Job; die Einstellungen, die die
  meisten teilen, sind die des Jobs, der Rest ist Override; die Konfigurationen ändern sich dabei nicht.
  Rechner mit dem Zeitplan `none` (seit 0.2.1) bleiben ohne Job. Zusammenfassung als Audit-Eintrag
  `backup_job.migrated` je Mandant und einer für die Installation. Ein zweiter Lauf ändert nichts.
- **Neue Mandanten** bekommen den Standard-Job (Sicherung alle 8 Stunden, Restore-Prüfung sonntags
  03:00, Umfang `all`) statt zweier Zeitpläne, sobald sie die erste aktive Quelle haben
  (Scheduler, `applyRecommendedDefaults`, oder "Empfohlene Zeitpläne anwenden").
- **Rechte und Demo.** Alle Routen verlangen `tenant_admin` (oder Provider); Provider-Rollen: Ansehen ab
  "Nur lesen" (Hook-Texte maskiert unter "Administrator"), "Jetzt ausführen" ab "Techniker", Anlegen,
  Ändern, Umfang, Löschen ab "Administrator". Ein Hook im Job braucht die frische Anmeldung. In der Demo
  sind alle Schreibzugriffe gesperrt (Standardverweigerung des Demo-Wächters).
- **Audit:** `backup_job.created`, `.updated` (mit den geänderten Feldern, nie Hook-Texte),
  `.deleted`, `.scope.changed` (hinzugefügt, entfernt, Overrides, bei Verschieben auch im Ausgangsjob),
  `.run_requested`, `.migrated`.

## Restore

- Restore-Job mit Quelle (Snapshot, Auswahl), Ziel (Original, anderes Konto, Download),
  Modus (rename/skip), Ausführender (User oder Admin mit Grund). Ein Restore ersetzt nie
  ein vorhandenes Element: "replace" wird für jedes Konto-Ziel von der API abgelehnt (422
  `urn:restow:problem:restore-replace-not-allowed`), nur beim Download ist der Modus
  wirkungslos und wird als "rename" gespeichert. Der `restore_mode`-Enum behält den Wert
  für die Historie. Geplant für später: "replace" für OneDrive-Dateien, bei dem die
  aktuelle Datei zur Vorversion wird statt gelöscht zu werden (Engine-Code dafür liegt
  in packages/core/src/restore/onedrive.ts, ist aber nicht erreichbar).
- Datei-Explorer für den Restore: Browsen durch Snapshots, Ordnerbaum und Datei-Versionen
  (Zeitpunkt wählbar), Auswahl einzelner Dateien oder ganzer Ordner. Gilt für OneDrive und
  die Infrastruktur-Dateibackups. Wiederherstellen an Ort, in ein anderes Ziel oder als
  Download.
- Download-Restore: ZIP mit EML/Dateien wird serverseitig gestreamt (kein Temp auf
  Platte über 1 GiB), Link mit Ablauf 24 h.
- Export als Mail-Dateien (EML-ZIP, MBOX, ggf. MSG) aus Sicherung, importiertem Postfach und
  Archiv: eigener Job `export`, Ergebnis versiegelt im Speicherziel, Download mit Ablauf und
  Audit; Import von Mail-Dateien in ein importiertes Postfach: Job `import`
  (docs/IMPORT.md).
- Verifikation: `verify`-Job stellt eine Zufallsauswahl in ein Prüfziel wieder her
  (Testpostfach je Mandant oder Restow-interner Vergleich MIME-Hash), Ergebnis
  `recovery_readiness` je Objekt (grün/gelb/rot, Datum).
- Health Check (opt-in, rechenintensiv): tiefer Abgleich (Reconciliation) zwischen
  Live-Quelle und letztem Snapshot über alle Quelltypen (M365, IMAP, Infrastruktur) —
  fehlende Objekte, Hash-Abweichungen, Drift — plus vollständiger Storage-Scrub. Kostet
  Graph-/IMAP-Kontingent bzw. CPU, daher je Mandant/Objekt schaltbar; Ergebnis ergänzt
  `recovery_readiness` als eigener Report.

## Audit-Log

`audit_log` ist append-only (Trigger verbietet UPDATE/DELETE), Hash-Kette je Mandant
(prev_hash), täglicher Anker-Hash in `audit_anchor`. Ereignisse: Login, Consent,
Restore, Impersonation, Export, Retention-Löschung, Legal Hold, Schlüsselzugriff,
Lizenzänderung, Lesen von Sicherungsinhalten im Explorer (Ordner, Versionsverlauf,
Suche; mit `onBehalfOf`, wenn es nicht die eigenen Daten sind).

Stand 0.1.0: Aufgezeichnet wird immer, vom Kern. Die Ansicht (Liste, Filter, Detail,
Kettenprüfung) ist ein Modul unter `ee/api/src/audit-log` (Business und Service Provider,
Capability `audit.log`); ein CSV-/PDF-Export ist geplant. Die Kette ist
manipulationserkennend (Hash-Kette plus tägliche Anker, die Anwendungsrollen dürfen nicht
ändern oder löschen), nicht manipulationssicher gegenüber jemandem mit Eigentümerrechten an
der Datenbank.

## API

REST unter `/api/v1`, OpenAPI aus Zod-Schemas, im Kern. API-Keys je Mandant
mit Scopes (`status:read`, `jobs:read`, `items:read`, `users:read`, `restore:write`,
`verify:write`, `users:write`, `webhooks:manage`, ...). Neben Backup/Restore/Verify und
Archiv-Nachweisen liefert die API eine saubere Nutzer-/Postfach-Aufstellung je Mandant
(Directory) zur Anbindung an RMM, PSA und Ticketsysteme; mandantenübergreifend über einen
Provider-Key, solange eine Erweiterung `apiKeys.provider` freischaltet (in der Vollversion:
Service Provider). `GET /tenant` nennt seit dem 01.10.2026 keine Edition mehr.
SSE `/api/v1/jobs/{id}/events`. Die Läufe heißen in der Integrations-API weiter `/jobs`; seit 0.2.0 (Vertrag
1.2.0, additiv) gibt es sie auch unter `/runs` (`listRuns`, `startRunBackup`, `getRun`, `streamRunEvents`).
Die Job-Definitionen (`/api/v1/backup-jobs`) sind Session-API und nicht Teil der Integrations-API.
Webhooks je Mandant (Ereignis,
HMAC-Signatur). Jeder lesende Zugriff auf Nutzer-/Backupdaten ist auditiert.

Jeder Webhook hat ein Format (`webhooks.format`, Migration 0026, seit 0.3.0; Vertrag 1.3.0,
additiv). `restow` (Standard, alle bestehenden Webhooks) ist der signierte JSON-Umschlag mit
`X-Restow-Signature`, `X-Restow-Event`, `X-Restow-Delivery` und `X-Restow-Attempt`. `discord`,
`slack` und `teams` sind Chatnachrichten in der Form, die die eingehenden Webhooks dieser Dienste
annehmen: Discord `content` plus ein Embed (Titel, Beschreibung, Farbe nach Schwere, Felder,
Zeitstempel, `allowed_mentions` leer), Slack `text` als Rückfall plus Blöcke (Header, Section,
Context), Teams eine Adaptive Card in `{"type":"message","attachments":[...]}` (Workflows /
Power Automate, "Post to a channel when a webhook request is received"; die alten
Office-365-Connectors `*.webhook.office.com` nehmen dieselbe Form an). Die Weboberfläche wählt das
Format beim Eingeben der URL (`discord.com`/`discordapp.com` mit `/api/webhooks/`,
`hooks.slack.com`, `*.webhook.office.com`, `*.logic.azure.com`, `*.powerautomate.com`,
`*.powerplatform.com`); es lässt sich von Hand ändern. Chatformate werden ohne Signatur und ohne
die `X-Restow-*`-Header gesendet, die Oberfläche zeigt für sie kein Secret (gespeichert wird
trotzdem eines, damit ein Wechsel zu `restow` sofort signiert; die Oberfläche erneuert es dann und
zeigt es einmal). Der Worker rendert die Nachricht erst beim Zustellen aus dem gespeicherten
Umschlag (`apps/worker/src/handlers/webhook-formats.ts`), in der Sprache des Mandanten (sonst der
Installation) mit denselben Texten wie die Alarm-Mails (Ursache, Schritte), mit Link auf die
öffentliche URL aus den Einstellungen (sonst `RESTOW_PUBLIC_URL`) und gekürzt auf die Grenzen des
Dienstes (Discord: Inhalt 2000, Titel 256, Beschreibung 4096, Feldwert 1024, Embed gesamt 6000;
Slack: Header 150, Section 3000; Teams: Text 4000). Das Zustellprotokoll zeigt weiter den
Umschlag. Antwortet ein Chatdienst mit 400, 401, 403, 404, 410, 413 oder 422, endet die
Zustellung sofort (URL oder Nachricht falsch, ein gelöschter Discord-Webhook antwortet 404);
429 und 5xx werden wiederholt, frühestens nach `Retry-After`. Für `restow` beendet weiter nur 410
die Zustellung sofort.

## Berichte und Benachrichtigungen

Regeln je Mandant in `report_rules`, zwei Auslöser:

- **Ereignis** (immer, Kern): Der Worker schreibt jedes Ereignis als In-App-
  Benachrichtigung (`notifications`, die Glocke) und legt in derselben Transaktion für
  jede aktive Ereignisregel des Mandanten, die das Ereignis nennt, Zustellungen in
  `report_deliveries` an (`apps/worker/src/reporting.ts`). Ereignisse (Katalog in
  `packages/core/src/reports/catalog.ts`): `backup.failed`, `restore.failed`,
  `restore.completed`, `archive.failed`, `directory.failed`, `verify.red`,
  `verify.yellow`, `verify.recovered`, `scrub.corrupt`, `scrub.repaired`, dazu für Server und
  Clients `endpoint.stale`, `endpoint.suspicious_snapshot`, `endpoint.storage_quota` und
  `endpoint.repository_locked` (docs/AGENT.md, "Alarme"). Drosselung je
  Regel und Gegenstand (Objekt, sonst Auftragstyp) über `throttle_minutes`.
- **Zeitpunkt** (nur solange eine Erweiterung `reports.timed` freischaltet; in der
  Vollversion Business, Capability `reports.scheduled`): Kadenz wie bei Zeitplänen
  (Intervall oder Cron in einer Zeitzone). Der Scheduler legt fällige Berichte als
  Zustellungen an (`apps/scheduler/src/reports.ts`); eine Regel ohne `next_run_at` bekommt
  nur ihren ersten Termin und feuert nicht sofort. Den Inhalt (Kennzahlen des Reiters
  Statistik der Übersicht für den Zeitraum, gewählte Abschnitte) baut das Modul
  `ee/api/src/reports/summary.ts` (FeatureHook `reportSummary`); ohne es, oder solange
  `reports.timed` aus ist, wird eine Zustellung als `skipped` (`not_available`) protokolliert.

`report_deliveries` ist Ausgang und Protokoll in einem, wie `webhook_deliveries`. Ein
Hintergrunddienst im API-Prozess (`apps/api/src/features/reports/dispatcher.ts`)
beansprucht fällige Zeilen mandantenübergreifend (`FOR UPDATE SKIP LOCKED` plus Lease),
rendert sie in der Sprache der Regel oder des Mandanten und stellt sie zu: E-Mail über den
Mail-Transport der Einstellungen, Glocke (nur Berichte; Ereignisse stehen ohnehin dort),
Webhook als signierte Zustellung (`report.alert`, `report.summary`) über den
Webhook-Dispatcher des Workers. Fehlschläge werden nach 1, 5, 15 und 60 Minuten wiederholt,
dann aufgegeben. Im Demo-Modus sendet der Dienst nichts (NoopNotifier). Regeländerungen und
Testsendungen stehen im Audit-Log (`report.rule.*`, `report.test_sent`).

Die Empfänger-Flags des Mandanten-Assistenten (`tenant_notification_recipients`) wurden mit
Migration 0010 zu Regeln; der Assistent legt seitdem direkt Regeln an
(`apps/api/src/features/reports/defaults.ts`). Die Tabelle bleibt unverändert bestehen.

## Setup und Betriebsmodi

Erststart läuft über einen Setup-Wizard. Konfiguration in `settings` (ein Datensatz je
Installation, in der DB, nicht im Repo). Der Wizard legt den ersten Admin, `settings`,
Provider-Zeile, SMTP-Secret, die Annahme des Betreiberhinweises und die Audit-Einträge in
**einer** Transaktion an und setzt dabei `settings.setup_completed_at`; danach ist der
öffentliche Wizard dauerhaft geschlossen (einseitige Sperre, unabhängig von Konten und
Rollen). Ein abgebrochenes Setup hinterlässt nichts. Der Wizard fragt den Namen der eigenen
Organisation ab (Pflichtfeld `providerName`, gespeichert als `providers.name`); gleich nach der
Setup-Transaktion legt die API daraus den Mandanten `kind = internal` an (Organisation, Zeile,
Schlüssel, Alarmregeln für den ersten Admin, Audit-Eintrag; wie jeder erste Mandant ohne
`tenants.additional`). Scheitert das, bleibt das Setup vollständig, der Fehler wird geloggt und
als `setup.internal_tenant_failed` in die Installationskette geschrieben, und das Dashboard
bietet an, die eigene Organisation anzulegen. Einstellungen ändert der Provider-Admin
danach in der Oberfläche. Der Admin mit Passwort muss vor allem anderen eine
Authenticator-App (TOTP) einrichten.

Erster Schritt des Wizards ist die Sprache (Deutsch oder Englisch, vorbelegt aus der
Browsersprache, sofort angewendet): Sie läuft als `language` im Setup-Request mit und wird die
Sprache der eigenen Organisation (`tenants.language`, auch die Namen ihrer Alarmregeln) und der
Testnachricht. Die Installation hat keine eigene Standardsprache in `settings`; ohne `language`
(ältere Clients) bleibt `tenants.language` null und die Fallback-Konstante `defaultLanguage` aus
`@restow/i18n` greift. Der Mail-Transport ist optional (`mail` fehlt im Request, wenn der
Betreiber den Schritt überspringt): `settings.mail_transport` und `mail_config` bleiben null,
`sendTest` ohne Transport lehnt die API mit 422 ab, und jede Stelle, die Mail verschicken würde,
meldet „kein Transport" (`createInstallationNotifier` liefert null: Einladungen zeigen den Link
zum Kopieren, Berichte werden mit dem Fehler `mail_not_configured` begrenzt wiederholt). Die Einrichtungsliste
(„Start" im Menü, `GET /dashboard?widgets=setup`) behandelt die Mail als den einen optionalen Schritt
(`notificationMail`): ohne Transport (Wizard übersprungen oder Konfiguration entfernt) zählt er als „nicht nötig"
(`state: not_needed`, Grund `mail_skipped`), ein eingerichteter Transport wird durch eine erfolgreiche Testmail
erledigt, und der Installations-Owner kann ihn mit `PUT /settings/mail/not-needed` (`settings.mail_not_needed`,
Audit `settings.mail.not_needed`) als „nicht nötig" markieren. Ein nicht nötiger Schritt zählt wie ein erledigter; sind
alle Schritte erledigt oder nicht nötig, verschwindet „Start" aus dem Menü.

- Setup-Token (`apps/api/src/lib/setup-token.ts`): Wer nur die Adresse einer
  frischen Installation kennt, darf sie nicht übernehmen (Cross-Site-POST aus einer
  besuchten Seite, DNS-Rebinding im lokalen Modus, Wettlauf nach dem Eintrag der Domain in
  die Certificate-Transparency-Logs). Startet die api auf einer nicht eingerichteten
  Installation, erzeugt sie ein zufälliges Einmal-Token (20 Zeichen, rund 100 Bit) und
  schreibt es als markierten Block in ihr Log (`docker compose logs api | grep 'SETUP
  TOKEN'`); jeder Neustart erzeugt ein neues. Alternativ setzt der Betreiber
  `RESTOW_SETUP_TOKEN` (mindestens 16 Zeichen, sonst startet die api nicht; wird nie
  geloggt). Der Wizard fragt das Token im ersten Schritt ab (`POST /api/v1/setup/token`,
  204 oder 403 `urn:restow:problem:setup-token-invalid`) und sendet es mit
  `POST /api/v1/setup` erneut als `X-Restow-Setup-Token`; nach dem Setup ist es verworfen.
  Kein Rate-Limit auf Fehlversuche (100 Bit, ein Limiter je IP würde nur den Betreiber
  aussperren lassen). Alle schreibenden Setup-Routen laufen zusätzlich durch den
  Browser-Schutz der Session-Routen (`requireSameOrigin`: Cross-Site 403, Body nicht JSON
  415). Der Demo-Modus hat kein Setup-Token; dort richtet nur der Seed mit seinem
  Seed-Token ein.
- Admin-Wiederherstellung (`apps/api/src/cli`): Ein verlorener Owner wird über
  die Kommandozeile des Servers wiederhergestellt, nie über den Wizard:
  `docker compose exec api restow admin recover --email <owner>` (Liste:
  `restow admin list`). Nur aktive Owner des Provider-Teams; Rückfrage, neues Passwort
  über verdeckte Eingabe (oder `--password-stdin --yes`), dann in einer Transaktion:
  Passwort setzen (Credential-Konto anlegen, wenn nur Passkeys bestanden), TOTP und alle
  Passkeys entfernen, alle Sessions beenden, Audit `account.access_recovered` (Akteur
  `system`, `via: command_line`) in der Installationskette. Danach Anmeldung mit dem neuen
  Passwort und Pflicht zur TOTP-Einrichtung wie nach dem Setup.
  Jedes andere Mitglied setzt ein Owner im Browser zurück (Installation › Mitglieder,
  „Zugang zurücksetzen“, `POST /api/v1/provider-team/:userId/reset-access`, mit kürzlicher
  Anmeldung): in einer Transaktion Passwort (Credential-Konto), Passkeys, TOTP und alle
  Sessions entfernen und einen neuen Set-Password-Link ausstellen (ohne Mail-Dienst zum
  Kopieren angezeigt, mit dem Benutzernamen), Audit `provider_team.access_reset`. Nicht für
  den eigenen Zugang und nie für den letzten Owner.

- Betreiberhinweis (erster Schritt): Vor allem anderen muss der Betreiber den Hinweis zur
  eigenen Verantwortung annehmen (Restow ist Backup- und Archivwerkzeug; Hardware, Speicher,
  Redundanz, Unveränderbarkeit, Schlüsselverwahrung, Netzwerk- und Zugriffssicherheit und
  Restore-Tests liegen beim Betreiber; das Archiv ist für den GoBD-konformen Einsatz
  ausgelegt, die Konformität des Gesamtverfahrens liegt beim Betreiber). Der Text liegt in den
  Übersetzungsdateien (`setup.json`, Schlüssel `disclaimer`), seine Fassung in
  `apps/api/src/lib/disclaimer.ts` (`DISCLAIMER_VERSION`); ein Test fixiert den Wortlaut, eine
  Textänderung erzwingt eine neue Fassung und damit eine erneute Zustimmung. Der Wizard
  zeigt den Hinweis nach dem Setup-Token; die Annahme reist im Body von `POST /api/v1/setup`
  mit (`disclaimer: { version, accepted: true }`) und wird in der Setup-Transaktion
  gespeichert (Fassung, Zeitpunkt und Client-IP in `settings.disclaimer_*`, Audit-Eintrag
  `settings.disclaimer_accepted` in der Installationskette mit dem neuen Admin als Akteur).
  Ohne Annahme antwortet `POST /api/v1/setup` mit 428
  (`urn:restow:problem:disclaimer-required`), bei anderer Fassung mit 409, serverseitig
  erzwungen. Eine eigene, anonyme Route für die Annahme vor dem Setup gibt es nicht.
  `GET /api/v1/setup/state`
  meldet `disclaimer: { version, accepted }` (vor dem Setup immer `accepted: false`, außer
  im Demo-Modus) und `setupToken: { required, source }`. Eine
  Installation, die vor dem Hinweis eingerichtet wurde (oder deren Textfassung sich ändert),
  zeigt ihn einmalig dem Provider-Admin nach der Anmeldung als blockierenden Dialog
  (`POST /api/v1/settings/disclaimer`, gleiche Aufzeichnung mit Person und IP; annehmen dürfen nur
  Owner und Administrator des Provider-Teams, Technician und Read-only sehen den Hinweis, dass
  zuerst einer von beiden annehmen muss, die Route antwortet ihnen mit 403); Jobs,
  Integrationen und übrige Nutzer laufen währenddessen weiter. Der Demo-Modus gilt als
  angenommen (kein Betreiber, Besucher können nicht schreiben).
- Betriebsmodus: `local` (lokal über IP oder localhost, ohne öffentliche Domain) oder
  `public` (öffentlich erreichbar, Domain plus TLS). Daraus abgeleitet: Basis-URL,
  öffentliche URL, Passkey-RP-ID und -Origin, Entra-Redirect-URI, Journal-Hostname
  (`archive.<domain>`).
- Auth-Folge des Modus: WebAuthn/Passkeys binden an eine registrierbare Domain über
  HTTPS. Restow bietet Passkeys erst an, wenn die Domain nachweislich sauber verbunden
  ist: öffentliche URL auf eine registrierbare Domain gesetzt, per HTTPS mit gültigem,
  vertrauenswürdigem Zertifikat erreichbar, und die vom Browser gemeldete Origin stimmt
  mit der konfigurierten RP-Origin überein. Diese Prüfung (`passkey_ready`) läuft im
  Wizard und als laufender Health Check; schlägt sie fehl (IP-Modus, self-signed,
  Origin-Mismatch), bleibt der Passkey-Weg verborgen und es greift ausschließlich der
  Notfall-Passwort-Weg mit TOTP-Pflicht. localhost ist nur eine ausgewiesene Entwicklungs-
  Ausnahme, nicht für den Produktivbetrieb. Der Wizard sagt den Zustand klar an, statt ihn
  zu verschleiern.
- Erster Admin: Provider-Admin wird im Wizard angelegt (Passkey, sonst Notfall-Passwort
  plus TOTP).
- Mail-Dienst für Benachrichtigungen: ein Transport-Interface mit zwei Implementierungen,
  im Wizard per Dropdown wählbar und mit Testversand:
  - `smtp`: Host, Port, STARTTLS/implizit, Benutzer/Passwort (verschlüsselt in DB, KEK),
    Absenderadresse (nodemailer).
  - `graph`: Microsoft Graph `sendMail` als App (Client Credentials), Absenderpostfach im
    Tenant, braucht die Anwendungsberechtigung `Mail.Send` (nur wenn gewählt, siehe
    docs/MICROSOFT.md). Kein eigener SMTP-Ausgang nötig.
- Der SMTP-Journal-Empfänger (Archiv) ist davon getrennt: er empfängt nur, versendet nie
  (docs/IMAP.md).

### Produktname (Branding)

Kein Text, keine Vorlage und kein Renderer schreibt den Produktnamen selbst. Übersetzungen
tragen den Platzhalter `{appName}`; er gilt in jedem Text, ohne dass eine Aufrufstelle ihn
übergibt. Die einzige Quelle ist `packages/i18n/src/branding.ts`: Standard `Restow`,
überschrieben durch `RESTOW_PRODUCT_NAME` (Konfiguration der API, bereinigt: keine
Steuerzeichen, höchstens 60 Zeichen).

- Server: `apps/api/src/config.ts` liest die Variable und setzt den Namen einmal für den Prozess
  (`configureProductName`); jede `createI18n()`-Instanz löst `{appName}` damit auf (Benachrichtigungs-
  und Alarmmails, PDF-Berichte, Zustimmungsseite), ebenso die englischen Problemtexte, der
  OpenAPI-Titel, der Aussteller in der Authenticator-App und der Passkey-Name.
- Web: Die öffentliche Setup-Antwort (`GET /api/v1/setup/state`) trägt `productName`; der
  Wurzel-Guard der Oberfläche wendet den Namen an, bevor etwas rendert
  (`apps/web/src/lib/branding.ts`). Bis dahin, und wenn die API nicht antwortet, gilt der Standard.
- Die statische Wartungsseite entsteht beim Bauen des Web-Images und trägt den Namen des Build-Arguments
  `RESTOW_PRODUCT_NAME`; sie folgt einem zur Laufzeit gesetzten Namen nicht.
- Technische Kennungen werden nicht umbenannt: `RESTOW_*`, `restow-agent`, `restow-restore`,
  `X-Restow-*`, `rsk_`, `urn:restow:problem:*`, `restow-license-v*`, Image- und Dateinamen. Ein Test
  (`packages/i18n/src/product-name.test.ts`) lässt das Wort "Restow" in Übersetzungen nur in
  solchen Kennungen und in ausdrücklich gelisteten Hersteller-Texten zu.

## Updates

Restow wird als Docker-Images ausgeliefert: je Release-Tag ein Anwendungs- und ein Web-Image, in
zwei Builds (voll und Community, docs/CI.md "Two build targets"). Der Standardweg bleibt
`docker compose pull && docker compose up -d`; Migrationen laufen automatisch beim Start.
Darauf setzt ein optionaler Komfortweg auf. Beide Teile sind aus, bis der Betreiber sie
einschaltet, und beide halten die Regel "kein Telefonieren nach Hause" ein: Es wird nur die
Release-Liste der gewählten Quelle gelesen, nie etwas über die Installation gesendet.

### Versionsprüfung (Einstellungen, Reiter "Updates")

- Standardmäßig aus. Der Administrator schaltet sie im Reiter ein; dann liest Restow einmal am
  Tag (und bei "Jetzt prüfen") die Release-Liste der Quelle und legt das Ergebnis im Cache ab.
  `RESTOW_UPDATE_CHECK_URL` bleibt als Umgebungs-Override bestehen und hat Vorrang: gesetzt
  (https) ist die Prüfung an, die Quelle schreibgeschützt, und ein gespeichertes Token wird
  dorthin nie gesendet. Reihenfolge: Umgebung, Reiter, Standard (aus, öffentliche
  Projekt-Releases, stable).
- Quelle: standardmäßig die öffentlichen GitHub-Releases von `restow-backup/restow`; wahlweise ein
  anderes Repository (GitHub, Forgejo, Gitea; deren Releases-API ist kompatibel). Nur https, keine
  Zugangsdaten in der URL. Für ein privates Repository ein optionales Zugriffs-Token: verschlüsselt
  im bestehenden Secret-Store (installationsweit, Art `update_source_token`, gebunden an den Origin
  der Quelle), nur als `Authorization`-Header an genau diesen Origin, nie zurück an den Client, nie
  im Log oder Audit (dort nur `tokenSet`). Ein Wechsel auf einen anderen Origin löscht das Token,
  statt es mitzunehmen. Umleitungen auf einen anderen Origin werden nicht verfolgt.
- Kanäle: `stable` (ohne Vorabversionen) und `beta` (mit). SemVer-Vergleich inklusive
  Pre-Release-Tags. Entwürfe (drafts) werden ignoriert. Fehler (Rate-Limit mit Zeitpunkt, 401,
  403, 404, Netzwerk, Zeitüberschreitung, keine Release-Liste) werden mit Grund angezeigt; das
  letzte gute Ergebnis bleibt sichtbar. Nach Fehlschlag frühestens nach einer Stunde erneut.
- Datenmodell: Spalten an der Einzeilen-Tabelle `settings` (`update_check_enabled`,
  `update_source_url`, `update_channel`, `update_check` als jsonb-Cache, `update_notified_version`,
  `update_audit_cursor`); kein neuer Tabellentyp. Der Cache-Schreibzugriff ändert `updated_at`
  nicht.
- Ereignis `update.available`: einmal je neuer Version (Anspruch per `update_notified_version` in
  derselben Transaktion). Es geht als installationsweite Benachrichtigung (ohne Mandant) in die
  Glocke der Provider-Admins und in die Ausgangs-Warteschlange (`report_deliveries`) jeder
  aktivierten Ereignisregel, die es aufführt. Solche Regeln dürfen nur Provider-Admins anlegen
  (Katalogeintrag Gruppe "system"); Mandanten-Admins sehen das Ereignis nicht.
- Integrations-API: `VersionInfo` wurde nur um Felder erweitert (`channel`, `latestTag`,
  `publishedAt`, `checkError`, `maintenance`); `running`, `latest`, `updateAvailable`,
  `releaseUrl`, `updateCheck`, `checkedAt` sind unverändert.

### Der Updater (opt-in)

Ein eigener Prozess im selben Image (`ROLE=updater`, Compose-Profil `updater`, nicht Teil des
Standard-Stacks). Der Code liegt im Paket `apps/api` (`src/updater`), damit das Image nur
ein `case` in der Entrypoint-Rollenauswahl braucht. Warum ein eigener Container: Er bekommt
den Docker-Socket. Der Socket ist root auf dem Host; deshalb gilt:

- Opt-in, ohne ihn zeigt der Reiter die manuellen Schritte (`docs/UPDATING.md`) und keinen
  "Installieren"-Knopf. Die Doku sagt es offen.
- Kein Zugriff auf Anwendungs-Zugangsdaten: kein `env_file`, keine Datenbank-Rechte, kein
  Master-Key. Ein Grenztest verbietet Importe von `db`, `config`, `secrets`, `auth` im Verzeichnis.
- Nur im internen Docker-Netz erreichbar (kein `ports:`). Authentifizierung der API gegenüber dem
  Updater mit einem beim ersten Start erzeugten gemeinsamen Secret in einem Volume
  (`restow-updater-shared`, in der API nur lesend), nie im Repo, nie im Log. Die API gibt die
  Laufzeitversion über `/readyz` nur an den Aufrufer mit diesem Secret heraus.
- Nach außen führt der Edge nur den schreibgeschützten Status durch (`/_maintenance/status`
  auf `/public/status`; Phase, Schritt, Fortschritt, Zeiten, Meldungs-Code, Fehlercode). Keine
  Versionen (weder laufende noch Zielversion, auch nicht in Meldungsparametern); die sehen nur
  angemeldete Nutzer über `/api/v1/maintenance`.
- Eigenes, per Digest festgehaltenes Image: Der Updater ist das Anwendungs-Image mit
  `ROLE=updater` (kein eigenes Updater-Image) und läuft mit `RESTOW_UPDATER_IMAGE`, nie mit dem
  `RESTOW_IMAGE`, das jedes Update umschreibt. Ist `RESTOW_UPDATER_IMAGE` leer, startet der
  Release-Stack ihn aus `RESTOW_IMAGE` (`${RESTOW_UPDATER_IMAGE:-${RESTOW_IMAGE}}`), und beim
  ersten Start schreibt er das laufende Image per Digest in `RESTOW_UPDATER_IMAGE`
  (`self-update.ts`, `pinOwnImage`); das ändert nichts an dem, was läuft. Gelingt das nicht,
  blockiert er, solange die Compose-Datei sein Image aus `RESTOW_IMAGE`/`RESTOW_WEB_IMAGE`
  nimmt (Probe mit Platzhalterwerten, Blocker `updater_image_unpinned`).
- Selbstaktualisierung, signaturgesteuert: Nach einem erfolgreichen Update im Modus `image`,
  dessen Images die cosign-Prüfung der Release-Identität dieses Tags bestanden haben, setzt der
  Updater `RESTOW_UPDATER_IMAGE` auf das geprüfte App-Image per Digest (nie per Tag) und lässt
  einen kurzlebigen Hilfscontainer `docker compose --profile updater up -d --no-deps updater`
  ausführen (ein Container kann sich nicht selbst neu erzeugen); der neue Updater bestätigt
  beim Start (Status `selfUpdate` in `status.json`). Nie im Modus `source`, nie ohne
  Signaturprüfung, abschaltbar mit `RESTOW_UPDATER_SELF_UPDATE=false`. Ein Fehlschlag macht das
  App-Update nicht rückgängig; der Reiter zeigt den Befehl zum Nachholen. Über das Image des
  Containers mit dem Socket entscheidet damit die Signatur des Release-Workflows, nicht mehr
  ein Mensch. Der Mounter folgt unter genau denselben Regeln (`mounterUpdateDecision`): Ist er
  in Gebrauch (Container vorhanden oder `RESTOW_MOUNTER_IMAGE` gesetzt), setzt der Updater vor
  dem eigenen Wechsel `RESTOW_MOUNTER_IMAGE` auf dasselbe geprüfte Image und lässt einen
  Hilfscontainer `docker compose --profile mounts up -d --no-deps mounter` ausführen. Solange
  der Mounter eine Freigabe ändert (`busy` in seinem `/healthz`), wartet er bis zu zehn
  Minuten; das Ergebnis steht in `selfUpdate.mounter`, ein Fehlschlag lässt das App-Update nie scheitern.
- Docker-Befehle: Der Updater führt `docker` und `docker compose` aus. Das Image enthält
  kein Docker-CLI; der Updater startet dafür kurzlebige Hilfscontainer aus `docker:27-cli`,
  per Digest gepinnt, über den Socket (oder nutzt ein vorhandenes `docker`-Binary). Das Projektverzeichnis ist unter
  `/project` eingehängt; den Host-Pfad liest der Updater aus diesem Mount und bindet ihn in den
  Hilfscontainern unter demselben Pfad wie auf dem Host ein, damit relative Pfade der
  Compose-Datei stimmen. Mit `RESTOW_PROJECT_DIR` wird es direkt unter dem Host-Pfad
  eingehängt.

Modi, automatisch aus der Quelle gewählt und im Reiter angezeigt:

- `image` (öffentliche Projekt-Releases): Der Digest des App-Images muss in den Release Notes
  stehen (Zeile `restow: sha256:...`), sonst wird nicht installiert; das Web-Image wechselt nur
  mit eigenem Digest. Vor dem Ziehen prüft cosign (v3.1.3, Image per Digest gepinnt, in einem
  abgeschotteten Container) je Image die keyless-Signatur per Digest: Zertifikatsidentität exakt
  `https://github.com/restow-backup/restow/.github/workflows/release.yml@refs/tags/v<version>`,
  Aussteller `https://token.actions.githubusercontent.com`. Danach den Tag ziehen, Digest
  vergleichen, `RESTOW_IMAGE`/`RESTOW_WEB_IMAGE` in `.env` setzen, Dienste neu erzeugen.
  `RESTOW_UPDATER_VERIFY_SIGNATURES=false` (nur per Compose-Override) lässt für Testinstallationen
  die Signatur weg, nie den Digest.
- `source` (eigenes Repository, z. B. privates Forgejo): standardmäßig aus. Nur wenn der Betreiber
  das Repository (oder den Host) in `RESTOW_UPDATER_SOURCE_HOSTS` einträgt; der Updater prüft das
  selbst, nicht die API. Tag-Archiv mit dem gespeicherten Token laden (HTTP-Header, nie in URL,
  Argumenten oder Log; das Token holt der Updater erst im Moment des Abrufs von der API und behält
  es nur im Speicher), lokal mit `docker build` bauen, dann derselbe Neustart. Nichts davon ist
  signiert; das Vertrauen liegt allein in der Freigabe durch den Betreiber.

Quelle, Token und das Ankündigen eines Updates verlangen neben der Owner-Rolle eine Anmeldung aus
den letzten zehn Minuten (Passkey, Passwort mit TOTP oder OIDC; `lib/recent-sign-in.ts`, Problem
`recent-sign-in-required`, im Web ein "Bestätigen Sie, dass Sie es sind"-Dialog). Die
Update-Prüfung verbindet sich nur mit öffentlichen Adressen (Adressrichtlinie aus `@restow/core`
im DNS-Lookup des Sockets, Body gestreamt mit 8-MiB-Grenze); private Netze nur für den
Umgebungs-Override oder einen in `RESTOW_UPDATER_SOURCE_HOSTS` genannten Host.

Ablauf (Schritte `prepare`, `fetch`, `backup`, `stop`, `start`, `health`, `finish`):
Vorprüfung, Ziehen/Bauen (noch nichts gestoppt), `pg_dump -Fc` in das Updater-Volume (die
letzten drei bleiben), Worker und Scheduler stoppen (pg-boss-Aufträge laufen danach weiter),
API neu erzeugen (Migrationen), `/readyz` samt neuer Version abwarten (siehe Gesundheit), dann Worker und Scheduler,
zuletzt der Edge. Fehlerregeln, ohne zu raten:

- Fehler vor dem Stoppen: `unchanged`, die alte Version lief nie aus.
- Fehler, bevor Migrationen liefen: Der Updater hält die neue API zuerst an und vergleicht die
  Zahl der Einträge in `drizzle.__drizzle_migrations` mit dem Stand vor dem Update. Ist sie gleich:
  Rollback auf die vorherigen Images und `.env` (byte-genau wiederhergestellt), Ergebnis
  `rolled_back`. Stürzt die neue API dauernd ab (Neustartschleife), bricht der Gesundheitstest früh ab.
- Fehler, nachdem Migrationen liefen (oder Zustand unklar): api, worker, scheduler bleiben
  gestoppt, der Dump bleibt, Ergebnis `needs_attention`; der Reiter zeigt den Wiederherstellungsweg.
  Migrationen sind nicht umkehrbar, ein altes Image auf migrierten Daten wäre geraten.

Zustand: `status.json` im Updater-Volume (atomar geschrieben), damit er den Neustart der API
überlebt; er verschwindet nie (eine beschädigte Datei wird beiseitegelegt, nicht verworfen). Ein
Updater-Neustart mitten im Lauf endet als `interrupted` (`unchanged`, wenn noch nichts gestoppt war,
sonst `needs_attention`), und der Updater startet danach nichts von selbst. Der
Updater kann nicht selbst in die Datenbank schreiben; er führt ein Journal (`update.started`,
`update.succeeded`, `update.failed`), das die API (auch nach ihrem eigenen Neustart) genau einmal in
die installationsweite Audit-Kette übernimmt (Cursor `update_audit_cursor`). `update.check`,
`update.scheduled`, `update.cancelled`, `update.acknowledged` und Einstellungsänderungen schreibt
die API selbst. Die Ausgänge landen zusätzlich in der Glocke der Provider-Admins.

### Wartungsansage und Wartungsseite

- Der Administrator (Provider-Team-Rolle Owner) wählt Version und Vorlaufzeit (0, 1, 5, 15, 30,
  60 Minuten) und bestätigt. `GET /api/v1/maintenance` liefert allen angemeldeten Nutzern den
  Zustand (Phase, Countdown, Schritt, Fortschritt); die Oberfläche zeigt ein dauerhaftes Banner mit
  Countdown und einen Toast, zum Start ein Vollbild-Modal mit den Schritten. Abbruch ist bis zum
  Start möglich.
- Ist die API nicht erreichbar, während eine Wartung angekündigt ist oder läuft, gilt das als "Wartung
  läuft", nicht als Fehler: die Oberfläche fragt weiter (API und `/_maintenance/status`) und lädt neu,
  sobald die neue Version antwortet.
- Der Edge (Caddy) liefert bei 502/503/504 für Seitenaufrufe eine statische Wartungsseite (Deutsch
  oder Englisch nach `Accept-Language`, hell/dunkel, Produktname aus dem Branding (Build-Argument), zur
  Bauzeit erzeugt, ohne Inline-Skript wegen der CSP) mit Status 503, für `/api/*` ein `problem+json` 503.
  Seitenaufrufe fragen dafür vorab `GET /healthz` der API (`forward_auth`); ist sie nicht da, erscheint
  die Wartungsseite statt einer Oberfläche, die nicht laden kann. Die Seite lädt sich neu, sobald
  `/readyz` 200 meldet oder, bei 503, die Datenbank-Prüfung besteht: eine API, die nur noch auf
  Worker oder Scheduler wartet, liefert die Oberfläche bereits aus.

### Demo, Rechte

Demo: kein Updater, keine Prüfung, "Installieren" gesperrt; der Reiter zeigt nur die
Versionsinformationen. Rechte: der Reiter ist für Provider-Admins; Lesen für jede Teamrolle, alles, was etwas
ändert (Einstellungen, Prüfung auslösen, Wartung ankündigen, abbrechen, Ergebnis bestätigen), nur
`owner`.

## Netzlaufwerke: der Mounter (opt-in)

Ein weiterer eigener Prozess im selben Image (`ROLE=mounter`, Compose-Profil `mounts`, Code in
`apps/api/src/mounter`), unabhängig vom Updater; Betriebsdoku in `docs/MOUNTS.md`. Er bindet
NFS-Freigaben als Docker-Volumes des `local`-Treibers in `api` und `worker` unter
`/mnt/restow/<name>` ein, damit ein Speicherziel der Art "Verzeichnis" dorthin zeigen kann.

- Quelle der Wahrheit ist die Compose-Override-Datei des Projekts: die Liste `x-restow-mounts`,
  je Freigabe ein Volume `restow-nfs-<name>-<hash8>` (Hash über die Einstellungen, geänderte
  Einstellungen ergeben ein neues Volume) und die `volumes:`-Einträge von `api` und `worker`.
  Bearbeitet über die Document-API des `yaml`-Pakets, sodass Inhalte und Kommentare des
  Betreibers erhalten bleiben (`override.ts`).
- Ablauf einer Änderung (`engine.ts`): prüfen, Freigabe testen (temporäres Volume mit
  `soft,timeo=50,retrans=1`, kurzlebiger Container schreibt und löscht eine Datei), Override
  schreiben und `docker compose config -q`, `up -d --no-deps --no-build --pull never api worker`,
  auf Gesundheit warten, nicht mehr benutzte Volumes entfernen. Jeder Fehler nach dem Schreiben
  stellt die vorige Override-Datei wieder her (und erstellt die Dienste erneut).
- Dieselben Grenzen wie beim Updater: Docker-Socket, daher opt-in, nur internes Netz (Port
  8091), gemeinsames Secret im Volume `restow-mounter-shared` (in der API nur lesend), keine
  Anwendungs-Zugangsdaten, eigenes per Digest festgehaltenes Image (`RESTOW_MOUNTER_IMAGE`).
  Er nutzt die Bausteine des Updaters (Secret, Engine-API-Client, Runner, Redaktion, Logger),
  ein eigener Grenztest lässt nur diese und die eigenen Dateien zu.
- Die API (`features/mounts`) leitet weiter: Lesen für Provider-Admins mit allen Mandanten,
  Hinzufügen, Entfernen und Testen nur `owner`, Hinzufügen und Entfernen mit frischer Anmeldung;
  alles im Installations-Audit-Log. Sie lehnt Änderungen ab, solange Jobs oder Endpoint-Läufe
  laufen, und das Entfernen einer Freigabe, die ein Speicherziel oder der Standardspeicher nutzt.
- Nur NFS. Das Protokollfeld (`protocol`) lässt Platz für ein weiteres Protokoll (SMB) über
  denselben Container.

## Erweiterungsschnittstelle und `ee/`

Entscheidung vom 01.10.2026 (Plan D8): Der Kern steht unter Apache-2.0 und weiß nichts von
Lizenzen. Schlüsselprüfung, Editionen, Capabilities, `RESTOW_EDITION`, die Lizenz-API und
die Lizenzoberfläche liegen ausschließlich unter `ee/`; der Kern bietet nur
Erweiterungspunkte an und rendert, was ihm eine Erweiterung gibt. Abhängigkeiten laufen in
eine Richtung: `ee/` importiert den Kern, der Kern importiert `ee/` nur in genau einem
Loader je App (`apps/api/src/ee.ts`, `apps/worker/src/ee.ts`, `apps/web/src/features/ee.ts`;
`scripts/ci/check-ee-boundary.mjs`). Ohne `ee/` (Community-Build, docs/CI.md) ersetzt der
Build diese drei Loader durch leere Module; der Kern läuft dann mit genau seinen eigenen
Funktionen.

API (`apps/api/src/extensions.ts`, `ApiExtension`):

- `sessionRoutes[]`: Routengruppen unter `/api/v1<path>`, jede mit optionalem `guard`
  (Middleware vor der Gruppe). `ee/` setzt dort seinen Lizenzwächter ein
  (`ee/api/src/license/gate.ts`, `capabilityGuard`): ohne Capability antwortet die Gruppe
  404 wie ein unbekannter Pfad.
- `featureGate`: entscheidet die Kernfunktionen, die es nur mit einer Erweiterung gibt
  (`apps/api/src/lib/features.ts`, `GATED_FEATURES`): `tenants.additional` (ein weiterer
  Mandant, wenn schon einer existiert), `apiKeys.provider` (Provider-Keys und die
  mandantenübergreifenden Operationen der Integrations-API), `stats.allTenants`
  (Statistik über alle Mandanten), `dashboard.allTenants` (Provider-Ansicht des Dashboards),
  `reports.timed` (zeitgesteuerte Berichte), `providerTeam.tenantScope` (Mitglieder des
  Provider-Teams auf ausgewählte Mandanten beschränken; ohne sie hat jedes Mitglied alle
  Mandanten, eine schon gespeicherte Beschränkung bleibt bestehen und wirkt weiter). Ohne
  registrierte Schranke ist jede davon aus;
  der Kern antwortet dann 403 `urn:restow:problem:feature-unavailable`. Eine Schranke kann
  ihr eigenes Problem liefern (`unavailable`): `ee/` antwortet wie bisher 403
  `urn:restow:problem:edition-required` mit `requiredEdition`, `edition`, `capability`.
  Der Kern zählt keine Mandanten; er prüft nur, ob die Installation schon einen hat.
- `sessionFields[]`: Felder, die `GET /api/v1/me` unter `extensions.<key>` ausliefert, ohne
  sie zu lesen (`ee/` liefert `edition`). Daneben nennt `/me` die eingeschalteten
  Kernfunktionen (`features`).
- `providerRouteRules`: Regeln des Provider-Teams (`lib/provider-access.ts`) für die eigenen
  Routen einer Erweiterung; die Kerntabelle kennt nur Kernrouten.
- Weiterhin: `authRouteGuards`, `signInProviders`, `integrationRoutes`, `services`
  (Hintergrunddienste wie der Journal-Empfänger), `hooks` (`reportSummary`,
  `providerDashboard`).

Web (`apps/web/src/lib/extensions.tsx`, `WebExtension`): Seiten (`routes`), Menüeinträge
(`navItems`) mit optionalem `lock` (`apps/web/src/lib/navigation.ts`, `NavLock`:
`isLocked`, Ziel, Hinweistext), Sperren für Menüeinträge des Kerns per ID (`navLocks`) und
Abschnitte der Installationsseite (`installationSections`, `/installation/<abschnitt>`, mit
optionalem `lock` und `legacySettingsSection` für die alte Adresse unter `/settings`) und
Slots (`shell.sidebarFooter`, `tenants.creationLocked`, `team.tenantScopeLocked`,
`archive.sections`, `dashboard.provider`). Die Seitenleiste zeigt einen gesperrten Eintrag
ausgegraut mit Schloss und schickt ihn nach Installation → Lizenz (`/installation/license`,
dorthin führt auch der Eintrag Installation › Lizenz der vollen Images); ein gesperrter
Abschnitt der Installationsseite (Journal-Empfang ab Business, Provider-API im Service
Provider) steht ausgegraut in der Unternavigation und führt ebenfalls dorthin. Ob etwas
gesperrt ist, entscheidet allein die Erweiterung (aus `features` und `extensions` von `/me`).
Der Kern kennt keine Edition: ohne Erweiterung gibt es keine Sperre und keine Lizenzoberfläche.

Installation → Über (Abschnitt `about`, C18) zeigt im Kern nur Produktname, Version, Commit,
die Kernlizenz Apache-2.0 mit Link auf den englischen Lizenztext, einen Link auf den
Quelltext beim Tag der laufenden Version (Entwicklungsbuild: Repository-Wurzel) und die
Drittlizenzen (lokal `/licenses/THIRD_PARTY_NOTICES.txt` aus dem Web-Image und auf GitHub
beim Tag). Im Vollbuild bringt `ee/web` Edition, Lizenznehmer, Schlüssel-ID, den
Link auf die Restow-Lizenzbedingungen (Sprache der Oberfläche) sowie Einspielen und
Entfernen des Schlüssels als eigenen Abschnitt Lizenz mit. Erklärungen von Lizenzrechten stehen nirgends in der
Oberfläche.

Worker (`apps/worker/src/extensions.ts`): `retentionTasks`, `handlers`; jede Aufgabe prüft
selbst, ob sie laufen darf (Archiv-Löschlauf: `ee/licensing`, Capability
`archive.retentionEnforcement`).

`ee/licensing` ist der gemeinsame Teil von `ee/api` und `ee/worker`: Editionen,
Capability-Tabelle, Offline-Prüfung Ed25519-signierter Schlüssel gegen den eingebetteten
Prüfschlüssel (`RESTOW_LICENSE_PUBLIC_KEY` überschreibt ihn), die installierte Lizenz aus
der Tabelle `license`. Signieren kann dieses Repository nicht: das Ausstellungswerkzeug
liegt im privaten Repo restow-license; Tests signieren mit einem Wegwerfschlüssel
(`ee/licensing/testing/test-signer.mjs`, nie Teil eines Builds). `RESTOW_EDITION` wirkt nur
zusammen mit `RESTOW_DEMO=true` (öffentliche Demo, deploy/demo/README.md); sonst gilt ohne
Schlüssel Community. Die Tabellen `license` und das Enum `edition` bleiben im gemeinsamen
Schema (eine Migrationsreihe für beide Builds, ein Schlüsselwechsel braucht nie eine
Migration); gelesen und geschrieben werden sie nur von `ee/`.

`/api/v1/status` und `/me` nennen neben der Version den Commit des Builds (`version.commit`,
aus `RESTOW_REVISION`); daraus baut die Oberfläche den Info-Kasten der Einstellungen.

## Sicherheit

- Passkey-first für Betreiber, aber nur bei verifiziert sauber verbundener Domain (HTTPS,
  gültiges Zertifikat, passende Origin; `passkey_ready`); sonst Notfall-Passwort mit TOTP.
  Entra-SSO für Endnutzer.
- Secrets (Client-Secrets, IMAP-Passwörter, OAuth-Refresh-Tokens) in Postgres nur mit
  KEK-Verschlüsselung; nie in Logs; Log-Redaktion zentral.
- Journal-SMTP: TLS, Allowlist, Token-Adressen, Limits.
- Rate-Limits auf Login, Restore-Anfragen, API-Keys.
- Request-Bodys begrenzt (`apps/api/src/middleware/body-limit.ts`): 1 MiB je
  Request, Ausnahmen nur mit Begründung in der Regel-Liste (16 MiB für Restore-/Export-
  Auswahl, IMAP-Kontolisten und CSV, Directory-Regeln, Import-Anfrage, Laufbericht des
  Agents; 4 MiB Endpoint-Downloadauswahl; keine Grenze auf dem restic-Datenpfad und beim
  Import-Segment, die selbst begrenzen). Ein deklariertes Content-Length darüber wird ohne
  Lesen abgelehnt, Chunked-Bodys werden beim Lesen gezählt, nie in der Middleware
  gepuffert; Antwort 413 `urn:restow:problem:payload-too-large`. Caddy setzt
  `request_body max_size` als äußere Grenze (1 MiB für Anmeldung, Setup, Set-Password-Links
  und Agent-Enrollment, 33 MiB für den Rest von `/api`, 16 MiB für `/agent/v1`).
  Fehlerhafte Enrollment-Bodys zählen im Enrollment-Limiter wie falsche Tokens.
- Öffentliche schreibende Routen ohne Session (Setup, Set-Password-Links,
  Agent-Enrollment) laufen durch denselben Browser-Schutz wie die Session-Routen
  (Cross-Site 403, Body nicht JSON 415); `apps/api/src/middleware/public-routes.test.ts`
  hält die Liste vollständig. better-auth (`/api/auth/*`) prüft Origin und Fetch Metadata
  selbst, die übrigen Agent-Routen verlangen das Agent-Secret.
- Client-IP (`apps/api/src/lib/forwarded.ts`): der rechteste
  `X-Forwarded-For`-Hop, der kein vertrauenswürdiger Proxy ist
  (`RESTOW_EDGE_TRUSTED_PROXIES`, gleiche Liste und gleicher Default wie im Caddyfile),
  nie der linke, vom Client schreibbare Eintrag. better-auth bekommt dieselbe Liste. Im
  Demo-Modus wird keine IP gespeichert.
- Hinter einem Reverse-Proxy (Installer `--behind-proxy`, ab 0.2.0): Der Proxy hält Namen und
  Zertifikat und leitet standardmäßig verschlüsselt an die Edge weiter (`https://<Host>:443`).
  `RESTOW_EDGE_TLS` im Caddyfile wählt die Herkunft des Zertifikats: nicht gesetzt oder `acme`
  ist das bisherige Verhalten (automatisches HTTPS, Let's Encrypt für öffentliche Namen),
  `internal` lässt die Edge für `RESTOW_APP_DOMAIN` ein Zertifikat von Caddys eigener CA
  ausstellen (`tls internal` im Site-Block, `default_sni` für Proxys ohne SNI, die Auswahl über
  die Snippets `restow_tls_*` und `restow_sni_*`; ein anderer Wert stoppt Caddy beim Start).
  Das Root-Zertifikat liegt im Volume `caddy-data` unter
  `/data/caddy/pki/authorities/local/root.crt`; der Installer kopiert es nach
  `<Verzeichnis>/edge-root-ca.crt`, damit der Proxy die Edge prüfen kann. Die unverschlüsselte
  Ausnahme (`--proxy-hop http`) setzt `RESTOW_APP_DOMAIN=http://<Name>`. Der von der Edge nicht
  gebrauchte Host-Port (80 bzw. 443) wird über `RESTOW_HTTP_PORT` / `RESTOW_HTTPS_PORT=127.0.0.1:`
  nur auf dem Loopback und auf einem von Docker gewählten Port veröffentlicht. HSTS bleibt aus
  (Sache des Proxys).
- Content Security Policy strikt, keine Inline-Scripts, keine externen CDNs (Fonts lokal).
- Dependencies: pnpm audit in CI, Dependabot, Lockfile committed, Lizenzprüfung gegen eine Allowlist (`scripts/ci/license-policy.json`).
- Threat-Model-Dokument vor Phase 4.
