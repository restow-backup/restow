# Endpoint-Backup: Server und Clients mit dem Restow-Agent

Dieses Dokument beschreibt Aufbau, Protokoll, Sicherheitsmodell und Grenzen der
Sicherung von Servern und Clients (Endpunkten). Es ist der Vertrag zwischen dem Agenten
(Go, Verzeichnis `agent/`) und dem Server (`apps/api`, `apps/worker`, `apps/scheduler`,
`apps/web`, `packages/db`, `packages/core`). Entscheidung des Maintainers vom 30.09.2026:
Engine restic, Agent in Go, Teil der Community-Edition, ausgeliefert mit 0.1.0.

Stand 0.1.0: **Linux und macOS**. Windows (Dienst als LocalSystem, VSS, DPAPI) ist Teil
des Protokolls und des Datenmodells, wird aber in dieser Version weder eingerichtet noch
angenommen (Roadmap). Der Server lehnt `os=windows` mit einem klaren Problem ab; die
Oberfläche zeigt Windows als deaktivierte Option "Geplant".

## Grundsätze

- Dateibasierte Sicherung mit restic. Keine Images, kein Bare-Metal-Restore. Das steht so
  in der Oberfläche und in der Doku.
- Ein Agent für Server und Clients, Profil `server` oder `client`.
- Der Agent verbindet sich nur ausgehend per HTTPS mit der Restow-Instanz. Kein
  eingehender Port auf dem Rechner.
- Der Agent schreibt append-only: Er kann Sicherungen hinzufügen, nie löschen oder
  überschreiben. Aufbewahrung, Prune und Prüfung laufen ausschließlich auf dem Server.
- Der Agent bekommt nie Zugangsdaten des Speicherziels (S3-Schlüssel, Mount-Pfade). Er
  spricht nur mit der Restow-Instanz.
- Ein restic-Repository je Endpunkt mit eigenem zufälligem Passwort. Das Passwort liegt
  auf dem Server, mit dem Mandantenschlüssel verschlüsselt (wie jedes andere Secret), damit
  ein Admin auch dann wiederherstellen kann, wenn der Endpunkt nicht mehr existiert.
- Restores überschreiben nie: Sie landen in einem neuen Ordner auf dem Endpunkt oder als
  ZIP-Download in der Oberfläche.
- Jedes Lesen von Sicherungsinhalten (Browsen, Download) und jede Änderung ist auditiert.

## Bausteine

```
Endpunkt (Linux/macOS)                       Restow-Instanz
+---------------------------+                +------------------------------------------+
| restow-agent (Dienst)     |  HTTPS         | Caddy: /agent/*, /install/*, /api/*       |
|   restic (gepinnt)        |--------------->| apps/api                                  |
|   Zustand: state.json     | Basic-Auth     |   /agent/v1/*        Agent-API (JSON)     |
+---------------------------+ endpointId:    |   /agent/restic/:id  restic REST v2       |
                              agentSecret    |   /install/*         Skripte, Binärdateien|
                                             |   /api/v1/endpoints  Session-API (UI)     |
                                             | apps/worker (pg-boss)                     |
                                             |   endpoint-retention / -check / -verify   |
                                             |   endpoint-monitor                        |
                                             | apps/scheduler   plant diese Jobs         |
                                             | Postgres         Tabellen endpoint_*      |
                                             | Speicherziel     endpoints/<id>/          |
                                             +------------------------------------------+
```

- **Agent** (`agent/`): Zeitplan, Aufgaben, ruft `restic backup` auf, meldet Läufe.
  Nicht Teil dieses Dokuments über die Protokollgrenze hinaus.
- **restic-REST-Endpunkt** (`apps/api/src/features/endpoints/restic-route.ts`, Protokoll in
  `packages/core/src/endpoints/restic-rest.ts`): nimmt die Daten des Agenten entgegen und
  legt sie über die Speicher-Abstraktion im Primärziel des Mandanten ab.
- **Wartungszugriff des Servers** (`packages/core/src/endpoints/loopback.ts`): Retention,
  Prüfung, Restore-Test, Browsen und Download laufen als restic-Prozesse auf dem Server
  gegen einen Loopback-Listener mit Volllzugriff. Siehe "Wartungszugang".
- **Worker-Jobs** (`apps/worker/src/endpoints/`) und **Scheduler**
  (`apps/scheduler/src/endpoints.ts`).
- **Oberfläche** (`apps/web/src/features/endpoints`): Server & Endpunkte › Inventar (eine Liste
  aller Rechner mit den Filtern Alle, Server, Clients), Assistent, Detailseite
  (`/inventory/<id>`), Dateibrowser, Server & Endpunkte › Datei-Restore, Einstellungen. Anmeldung, offene Token und die Pause der
  Agent-Updates liegen außerdem auf der Mandantenseite (`/tenants/<id>/agents`).

## Enrollment

1. Ein Admin wählt "Neuer Server" oder "Neuer Client" und das Betriebssystem. Der Server
   erzeugt ein Einmal-Token: 32 zufällige Bytes, base64url, Präfix `rset_`, 24 Stunden
   gültig, an Mandant und Profil gebunden, **nur als SHA-256 gespeichert**, einmal
   verwendbar. Audit `endpoint.token.created`.
2. Die Oberfläche zeigt den Befehl und getrennt davon das Token. Das Token steht in keinem
   Befehl, keiner URL, keiner Prozessliste und keiner Shell-Historie: Das Skript fragt
   danach und liest es verdeckt vom Terminal (`/dev/tty`). Für unbeaufsichtigte
   Installationen (RMM) liest es das Token aus einer Datei, die nur root lesen kann:
   - Linux: `curl -fsSL 'https://<instanz>/install/linux.sh' | sudo sh`
   - macOS: `curl -fsSL 'https://<instanz>/install/macos.sh' | sudo sh`
   - unbeaufsichtigt: `curl -fsSL '...' | sudo RESTOW_TOKEN_FILE=/root/restow-enrollment.token sh`
     (macOS: `/var/root/restow-enrollment.token`)

   Die Adresse steht in einfachen Anführungszeichen und muss eine reine Origin sein
   (Schema, Host, Port); der Server baut keinen Befehl aus etwas anderem.
   `RESTOW_TOKEN` in der Umgebung funktioniert weiter (Rückwärtskompatibilität, Smoke-Test).

   `<instanz>` ist die öffentliche URL der Installation (`settings.public_url`, sonst
   `RESTOW_PUBLIC_URL`, sonst die Adresse, unter der der Admin die Oberfläche geöffnet hat).
   Nie eine feste Domain. Bei reinem http zu einer Nicht-Loopback-Adresse zeigt der
   Assistent eine Warnung (das Token und die Geheimnisse gingen unverschlüsselt über die
   Leitung), ebenso wenn die Adresse nicht in den Einstellungen gesetzt ist.
3. Das Skript lädt `SHA256SUMS` und `SHA256SUMS.sig` des Releases
   (`/install/agent/<version>/`) sowie `restow-agent`, `restic` und `THIRD_PARTY_NOTICES.txt`
   für Betriebssystem und Architektur von derselben Instanz, prüft **vor jeder Ausführung** die
   Signatur des Maintainers über `SHA256SUMS` (siehe "Signierte Releases") und die SHA-256
   beider Programme und der Lizenzhinweise, prüft, dass jeder Ordner des Installationsorts root gehört und weder für die
   Gruppe noch für andere schreibbar ist, installiert über `mktemp`-Zwischendateien nach
   `/opt/restow-agent/bin` (Linux) bzw. `/Library/Application Support/Restow/bin` (macOS),
   legt die Lizenzhinweise lesbar für alle nach `/opt/restow-agent/THIRD_PARTY_NOTICES.txt` bzw.
   `/Library/Application Support/Restow/THIRD_PARTY_NOTICES.txt` (ein Release ohne die Datei
   installiert mit einer Warnung), richtet den Dienst ein (systemd-Unit `restow-agent.service`, macOS LaunchDaemon
   `com.restowbackup.agent`) und ruft `restow-agent enroll` auf. Es ist idempotent: Erneutes
   Ausführen repariert und verschiebt eine Installation einer Vorabversion aus `/usr/local`,
   ohne deren Binärdatei auszuführen. Option `--hooks=off|scripts|any` setzt die Hook-Regel des Rechners
   (siehe "Hooks"). Deinstallation: `sudo /opt/restow-agent/bin/restow-agent uninstall` oder
   das Skript mit `--uninstall`; beides zeigt der Assistent an und entfernt auch die
   Lizenzhinweise.
4. `POST /agent/v1/enroll` mit `{ token, hostname, os, arch, agentVersion, osVersion, hooks }`
   antwortet `{ endpointId, agentSecret, repository: { url, password }, config, restic }`.
   - `agentSecret`: 32 zufällige Bytes, base64url, Präfix `rsea_`, **nur als SHA-256
     gespeichert**.
   - `repository.url`: `rest:https://<instanz>/agent/restic/<endpointId>/`. restic
     authentifiziert mit HTTP-Basic `endpointId:agentSecret`; der Agent übergibt beides über
     `RESTIC_REST_USERNAME` und `RESTIC_REST_PASSWORD`, nie über die Kommandozeile.
   - `repository.password`: 32 zufällige Bytes, base64url. Es liegt danach nur noch
     verschlüsselt auf dem Server (`secrets`, Art `endpoint_repository`, Mandanten-DEK).
   - Der Server legt das restic-Repository **selbst** an (`restic init` über den
     Wartungszugang), damit der Agent nie eine Config schreiben oder etwas löschen muss.
   - `config` hat seit 0.2.1 den Zeitplan `none`: Ein neu angemeldeter Rechner sichert **nichts**, bis
     ein Admin ihn einem Backup-Job hinzufügt (siehe "Rechner ohne Job"). Gespeichert werden dabei die
     Ordner und Ausschlüsse des Profils (`enrolledEndpointConfig`), damit der Job-Editor davon ausgehen
     kann; ausgeliefert werden sie dem Agenten erst mit einem Zeitplan.
5. Ablauf und Fehlerpfade des Servers: Das Token wird atomar verbraucht
   (`UPDATE ... WHERE used_at IS NULL AND revoked_at IS NULL AND expires_at > now()`);
   zwei gleichzeitige Enrollments mit demselben Token ergeben genau einen Erfolg. Scheitert
   danach etwas (Speicher nicht erreichbar, restic fehlt), macht der Server alles rückgängig
   (Endpunktzeile, Secret, Repository-Objekte) und gibt das Token wieder frei, denn der Agent
   hat noch nichts erhalten und kann denselben Befehl erneut ausführen. Eine ungültige Anfrage
   (unbekanntes `os`/`arch`, leerer Hostname) verbraucht das Token nicht.
6. Windows: `os=windows` antwortet 422 `urn:restow:problem:unsupported-os`, das Token bleibt
   gültig. Auch `POST /api/v1/endpoints/tokens` verweigert es.
7. Ablage des Agenten: Linux/macOS `/etc/restow-agent/state.json`, Modus 0600, root. (Windows
   später: `%ProgramData%\Restow\agent\state.json`, ACL SYSTEM und Administratoren, Secrets per
   DPAPI LocalMachine.)

`GET /api/v1/endpoints/tokens` listet standardmäßig nur gültige Token (nicht verwendet, nicht widerrufen,
nicht abgelaufen), `?state=all` zusätzlich die abgeschlossenen (höchstens 50, neueste zuerst); der
Assistent fragt für das Token, auf das er wartet, alle Zustände ab, weil ein eben verwendetes Token kein
gültiges mehr ist. Die Oberfläche zeigt die gültigen Befehle und schaltet die übrigen auf Wunsch zu.

Audit-Ereignisse rund um das Enrollment: `endpoint.token.created`, `endpoint.token.revoked`,
`endpoint.enrolled` (Hostname, OS, Architektur, Profil, Token-ID; nie ein Secret).

## Agent-API `/agent/v1`

Alle Antworten sind JSON, Fehler `application/problem+json` wie im Rest der API. Außer
`/enroll` verlangen alle Aufrufe HTTP-Basic `endpointId:agentSecret`. Jeder Aufruf setzt
`last_seen_at`. Kein Cookie, keine Session, keine CSRF-Middleware: Ein Agent ist kein Browser.

| Aufruf | Zweck |
| --- | --- |
| `POST /enroll` | Token gegen Zugangsdaten tauschen (siehe oben). |
| `GET /config` | `{ profile, schedule, paths, excludes, hooks, bandwidthKbps, onlyOnAcPower, useVss, configVersion }`, bei einem Rechner in einem Job mit Größenlimit zusätzlich `excludeLargerThanBytes` (siehe "Jobs"; ein Agent, der das Feld nicht kennt, ignoriert es). `schedule.kind` ist `interval`, `daily`, `on_connect` oder (seit 0.2.1) `none`; bei `none` sind `paths` leer und `hooks` `{}` (siehe "Rechner ohne Job"). `bandwidthKbps` ist das Limit, das **im Moment der Anfrage** gilt (aktives Zeitfenster des Jobs, sonst der Standard, `null` = unbegrenzt); die Zeitfenster selbst bekommt der Agent nie. `Cache-Control: no-store`. |
| `POST /heartbeat` | `{ agentVersion, osVersion, state: idle/running, nextRunAt, configVersion, hooks, hookScripts? }` ergibt `{ tasks }`. Alle 5 Minuten (Jitter +-60 s) und sofort beim Start. `hooks` ist die Hook-Regel des Rechners (`off`, `scripts`, `any`), `hookScripts` die Skripte in `/etc/restow-agent/hooks.d` (Regel `scripts`, höchstens 50). |
| `POST /runs` | `{ kind: backup/restore/verify_sample, taskId?, startedAt }` ergibt `{ runId }`. |
| `POST /runs/:id/progress` | `{ filesDone, bytesDone, totalFiles?, totalBytes?, currentPath? }`, alle 5 s (Agent ab 0.2.0; 0.1.x: alle 10 s). Das Limit der Agent-API (600 Aufrufe je Endpunkt und 10 Minuten, gleitendes Fenster) lässt das zu: Mit Heartbeat, Konfiguration und Start und Ende des Laufs sind es etwa 125 Aufrufe in 10 Minuten. Der Verlauf (`run_samples`) behält Punkte, die mindestens 1,5 s auseinanderliegen. |
| `POST /runs/:id/finish` | `{ status: succeeded/partial/failed, finishedAt, snapshotId?, stats?, sample?, errors, logTail, restoreTest? }`. `restoreTest` nur bei `verify_sample`: `{ files: [{ path, sha256? \| missing: true \| error }], restic?: { exitCode, fatal, errors: [{ item, message }] } }` (siehe "Restore-Test"). Wiederholung für einen beendeten Lauf antwortet gleich und ändert nichts. |
| `GET /update` | `{ version, url, sha256 }` oder `null`: neuere **signierte** Agent-Version auf dieser Instanz; `null` auch, solange der Mandant Agent-Updates pausiert hat. |

Standardkonfiguration (`packages/core/src/endpoints/config.ts`):

- Zeitplan bei der Anmeldung (seit 0.2.1): `none` in der Zeitzone des Mandanten, gesichert wird erst in
  einem Job (`enrolledEndpointConfig`). Der Zeitplan, mit dem der Job-Editor beginnt
  (`defaultEndpointConfig`, `GET /api/v1/backup-jobs/defaults`): Server täglich 22:00 in der Zeitzone
  des Mandanten (sonst Europe/Berlin), Client `on_connect`, höchstens eine Sicherung alle 4 Stunden.
- Pfade je System: Linux `/etc /home /root /srv /var/www`, bei Servern zusätzlich `/opt
  /usr/local /var/lib /var/backups` (dort liegen die Daten der Anwendungen, etwa in einem
  LXC-Container); macOS `/Users`, (Windows später `C:\Users`, bei Servern zusätzlich
  `C:\ProgramData`).
- Ausschlüsse je System: Caches, Temp, Papierkorb, `node_modules`, `*.tmp`, der restic-Cache;
  unter Linux außerdem `/var/lib/docker`, `/var/lib/containerd` und `/var/lib/apt/lists`
  (Images und Paketlisten werden neu geladen, nicht wiederhergestellt). Datenbanken unter
  `/var/lib` werden als Dateien gesichert; für ein konsistentes Abbild braucht es einen
  Dump-Befehl vor der Sicherung.
- `onlyOnAcPower: false` für beide Profile: Eine Sicherung, die nie läuft, ist schlimmer als
  eine im Akkubetrieb. Einstellbar.
- `bandwidthKbps` ist in Kilobit pro Sekunde (kbit/s) angegeben; `null` heißt unbegrenzt.

### Jobs: wer die Konfiguration schreibt

Seit 0.2.0 gehört die Konfiguration eines Rechners einem **Job** (`backup_jobs`, Art `endpoint`;
`docs/ARCHITECTURE.md`, "Jobs"), sobald der Rechner in einem steht. Der Agent merkt davon nichts: Er
liest weiter `GET /config` und kennt nur `config`.

- **Was der Job entscheidet:** Zeitplan (`schedule`), Ordner (`paths`), Ausschlüsse (`excludes`),
  Hooks, Bandbreite (`bandwidthKbps`), ein Größenlimit (`excludeLargerThanGib`, als
  `excludeLargerThanBytes` in `config`) und die Aufbewahrung des Repositorys
  (`settings.retention` des Rechners; nur der Server liest sie). Was der Job nicht entscheidet,
  bleibt am Rechner: Profil, `onlyOnAcPower`, `useVss`, Anzeigename, Speicherbudget und
  Stille-Schwellen.
- **Je Rechner überschreibbar:** Ein Mitglied des Jobs (`backup_job_members`) trägt `overrides` mit
  genau den Feldern, die es anders macht (ein gesetztes Feld ersetzt den Wert des Jobs). Die
  Wirk-Konfiguration ist `buildEndpointConfig(config des Rechners, Zeitplan, Einstellungen des Jobs
  mit Override)` (`packages/core/src/backup-jobs/endpoint-config.ts`).
- **Geschrieben wird an einer Stelle:** `syncEndpointConfigs`
  (`apps/api/src/features/backup-jobs/endpoint-sync.ts`), bei Anlegen, Ändern und Umfang eines Jobs.
  Sie sperrt die Zeile des Rechners, schreibt `config` nur, wenn sie sich ändert, erhöht dann
  `config_version`, legt wie bei einer Änderung von Hand eine `update_config`-Aufgabe an und
  auditiert `endpoint.config.changed` mit `via.job` (Hook-Texte nie, nur Fingerabdrücke). Dieselbe
  Funktion läuft in der Migration älterer Installationen und beweist dort, dass der Job die
  vorhandene Konfiguration exakt wiedergibt (nichts zu ändern, keine neue Version).
- **Hooks im Job** laufen durch dieselben Schranken wie am Rechner: die Hook-Regel des Rechners
  (`endpoint-hooks-not-allowed`, `endpoint-hook-not-a-script`, die Meldung nennt den Rechner) und
  die frische Anmeldung (`recent-sign-in-required`), bevor irgendetwas geschrieben wird.
- **Von Hand ändern geht dann nicht mehr:** `PATCH /api/v1/endpoints/:id` mit einer `config`, die ein
  vom Job entschiedenes Feld ändert (oder einer `settings.retention`, wenn der Job sie setzt), antwortet
  409 `endpoint-config-managed-by-job` mit dem Job. Anzeigename, `onlyOnAcPower`, Speicherbudget
  und die zugeordnete Person bleiben änderbar.
- **Zugeordnete Person (seit 0.2.1):** `PATCH /api/v1/endpoints/:id` nimmt `assignedUserId`, eine
  Person aus dem Schutzverzeichnis des Mandanten (`users`, kein Anmeldekonto; `null` hebt die
  Zuordnung auf). Liste und Detail tragen sie als `assignedTo` (`id`, `displayName`, `email`). Eine
  Person eines anderen Mandanten oder eine unbekannte antwortet 422 `endpoint-assignee-unknown`; die
  Datenbank sichert das zusätzlich mit einem Schlüssel über (`tenant_id`, `assigned_user_id`) ab
  (Migration 0025). Verlässt die Person das Verzeichnis, wird nur die Zuordnung geleert. Die
  Zuordnung ändert keine Konfiguration (keine neue `config_version`) und wird als
  `endpoint.assigned` auditiert. Die Auswahl in der Oberfläche liest
  `GET /api/v1/directory/people?search=`.
- **Einen Job verlassen heißt: keine Sicherung mehr (seit 0.2.1).** Wer einen Rechner aus dem Job nimmt
  (`DELETE .../members/:id`, ein `PUT .../members` ohne ihn) oder den Job löscht, setzt ihn auf den
  Zeitplan `none` zurück (`releaseEndpointConfigs` in `endpoint-sync.ts`): neue `config_version`,
  `update_config`-Aufgabe, Audit `endpoint.config.changed` mit `via.job` und `left: true`. Eine
  `backup_now`-Aufgabe, für die noch kein Lauf begann, endet `failed` ("the machine left its backup
  job"); ein laufender Lauf endet, wie er endet. Ordner, Ausschlüsse, Hooks und Bandbreite bleiben in
  der Konfiguration stehen (für den nächsten Job), der Agent bekommt sie mit `none` aber nicht. Ein
  Rechner, der in einen anderen Job **verschoben** wird (`move`), bekommt sofort dessen Zeitplan, ohne
  Pause dazwischen. Bis 0.2.0 behielt ein Rechner ohne Job die zuletzt geschriebene Konfiguration.
- **Größenlimit.** `excludeLargerThanBytes` wird nur geschrieben, wenn ein Job eines setzt (sonst bleibt
  `config` Byte für Byte, wie sie war). Der Agent ab 0.2.0 reicht es als `--exclude-larger-than <Bytes>`
  an restic weiter (reine Zahl, restic 0.19.1 liest sie ohne Einheit) und schreibt ins Lauf-Log, dass
  Dateien darüber nicht gesichert werden. Fehlt das Feld oder ist es 0, gibt es kein Limit; eine 0 reicht
  der Agent nie weiter, denn restic liest sie als "jede Datei mit Inhalt auslassen". Ein Agent vor 0.2.0
  ignoriert das Feld und sichert diese Dateien; die Oberfläche sagt am Feld, dass Agent 0.2.0 nötig ist.
  Agent-Versionen sind Restow-Versionen: Ein Rechner hat das Limit, sobald er sich auf 0.2.0 aktualisiert
  hat (signiertes Release, Selbstaktualisierung, `autoUpdatePaused` des Mandanten beachten).
- **Bandbreite mit Zeitfenstern.** `settings.bandwidthKbps` des Jobs ist der Standard,
  `settings.bandwidthWindows` eine Liste von Fenstern `{ days, from, to, kbps }`: `days` sind die Wochentage,
  an denen das Fenster **beginnt** (1 = Montag ... 7 = Sonntag), `from` (eingeschlossen) und `to` (nicht
  eingeschlossen) Ortszeiten `HH:MM`, `kbps` das Limit in kbit/s, 0 = unbegrenzt. Ein `to`, das nicht nach
  `from` liegt, endet am nächsten Tag (22:00 bis 06:00 von Freitag reicht bis Samstag 06:00); gleiche Zeiten
  ergeben 24 Stunden (Ganztags: 00:00 bis 00:00). Fenster dürfen sich nicht überschneiden (422
  `bandwidth_window_overlap` mit dem Pfad des späteren Fensters), aneinanderstoßende sind erlaubt; höchstens
  24 Fenster. Gelesen werden sie in der Zeitzone des Zeitplans, den der Rechner hat (der des Jobs, bei
  einem Zeitplan als Override dessen Zone), hilfsweise in der Zeitzone des Mandanten, sonst Europe/Berlin
  (`bandwidthTimeZone` im Kern). Sommerzeit gilt auf der Wanduhr: Ein Fenster über die Nacht der Umstellung
  dauert eine Stunde kürzer oder länger, ein Fenster in der ausgefallenen Stunde gilt an dem Tag nicht, eines
  in der doppelten Stunde beide Male.
  - **Wer wertet aus:** der Server, bei `GET /agent/v1/config` (`configResponse` in `agent-service.ts`). Die
    Fenster stehen in `endpoints.config.bandwidthWindows`, geschrieben von `syncEndpointConfigs` und nur,
    wenn sie sich ändern (normalisiert: Tage sortiert, Fenster nach Woche geordnet, so dass ein gleichbedeutender
    Job nichts neu schreibt). Der Anfang oder das Ende eines Fensters schreibt **nichts** und erhöht
    `config_version` nie; es entsteht auch keine `update_config`-Aufgabe. Die Antwort trägt das Limit des
    Moments als `bandwidthKbps` und lässt `bandwidthWindows` weg.
  - **Wann der Agent es sieht:** Jede Sicherung (Zeitplan, `backup_now`, `backup-now` auf der Konsole) holt
    die Konfiguration zu Beginn neu (`runBackup`, `fetchConfig`) und nutzt deren `bandwidthKbps`. Ein Lauf
    behält das Limit, mit dem er begann (restic bekommt `--limit-upload` einmal); ein Fenster, das während des
    Laufs beginnt oder endet, ändert daran nichts. Ist der Server beim Start nicht erreichbar, läuft kein
    Backup (das Repository liegt hinter ihm).
  - **Override je Rechner:** Limit und Fenster sind eine Einstellung (Gruppe "Bandbreite" im Override). Hat ein
    Mitglied ein eigenes `bandwidthKbps` (auch eines aus der Zeit vor den Fenstern), gelten die Fenster des
    Jobs für es nicht; `bandwidthWindows` allein behält den Standard des Jobs; `[]` heißt "keine Fenster".
  - **Rechner ohne Job:** Ein Rechner, der den Job verlassen hat, behält die zuletzt geschriebenen Fenster
    (sie wirken erst wieder in einem Job). `PATCH /api/v1/endpoints/:id` nimmt `config.bandwidthWindows` an (`null` oder `[]` entfernt sie; 422
    `endpoint-invalid-bandwidth-windows` mit dem Pfad); in einem Job antwortet es wie bei jedem Feld des Jobs
    mit 409 `endpoint-config-managed-by-job`.
- **Ein Job lässt sich bei Rechnern nicht pausieren** (`enabled=false` antwortet 422 `pause_not_supported`):
  Der Agent entscheidet, wann er sichert. Einen Rechner aus dem Job nehmen beendet seine Sicherung (siehe
  oben).
- **Nicht der Scheduler plant Rechner-Jobs.** Der Agent läuft nach seinem Zeitplan; der Scheduler plant
  weiter nur Aufbewahrung, Prüfung und Restore-Test aus dem Zustand der Endpunktzeilen
  (`apps/scheduler/src/endpoints.ts`). "Jetzt ausführen" eines Jobs (`POST /api/v1/backup-jobs/:id/run`)
  legt je Rechner eine `backup_now`-Aufgabe an (eine wartende genügt).

### Rechner ohne Job (seit 0.2.1)

Gesichert wird nur, was in einem Backup-Job steht. Ein Rechner in keinem Job hat den Zeitplan `none`
(`EndpointSchedule.kind`, nur die Zeitzone ist gesetzt): neu angemeldete Rechner von Anfang an, andere,
sobald sie ihren Job verlassen. Rechner, die schon vor 0.2.1 ohne Job waren, behalten ihren Zeitplan und
sichern weiter; es gibt keine Datenmigration, die sie anhält (die Migration nach 0.2.0 lässt Rechner mit
`none` aus, `planEndpointMigration`).

- **Agent ab 0.2.1:** Mit `none` startet er keine geplante Sicherung, keine Wiederholung und setzt
  keinen unterbrochenen Lauf fort (`schedule.Evaluate`); Heartbeat, Konfigurationsabruf, Restore,
  Restore-Test und Selbstaktualisierung laufen weiter. Eine `backup_now`-Aufgabe ignoriert er (der
  Server stellt keine zu), `restow-agent backup-now` bricht mit einem Hinweis ab, ohne einen Lauf
  anzumelden, und `restow-agent status` zeigt "Configuration: version N, waiting for a backup job" und
  "Backups: waiting for a backup job".
- **Ältere Agenten (0.2.0 und früher)** kennen `none` nicht: `schedule.FromAPI` schreibt eine Warnung ins
  Log und nimmt den Standard des Profils (Server täglich 22:00, Client `on_connect` alle 4 Stunden), der
  Konfigurationsabruf selbst scheitert nicht. Darum liefert `GET /agent/v1/config` (`configResponse`,
  `agentFacingConfig` im Kern) einem Rechner mit `none` **leere `paths` und keine Hooks**. Ein älterer
  Agent bricht den fälligen Lauf dann in `doBackup` mit `no_paths` ab, bevor restic oder ein Hook startet:
  Es wird nichts gesichert und kein Befehl ausgeführt. Der Preis: Bis er sich auf 0.2.1 aktualisiert hat
  (Selbstaktualisierung, ausgesetzt solange der Mandant Agent-Updates pausiert), meldet ein solcher
  Agent zu seinen Standardzeiten (plus bis zu fünf Wiederholungen) einen fehlgeschlagenen Lauf
  `no_paths`, der wie jeder fehlgeschlagene Lauf `backup.failed` auslöst. Neu angemeldete Rechner
  betrifft das nicht, denn das Installationsskript holt den Agenten der Instanz.
- **Server:** `POST /api/v1/endpoints/:id/tasks` mit `backup_now` antwortet für einen Rechner ohne Job
  409 `endpoint-no-job`, die Oberfläche bietet "Jetzt sichern" dann nicht an. `PATCH
  /api/v1/endpoints/:id` nimmt für einen Rechner ohne Job keinen anderen Zeitplan als `none` an (409
  `endpoint-no-job`); `none` selbst ist erlaubt (hält einen Rechner einer älteren Version an), ebenso
  Ordner, Ausschlüsse, Hooks, Bandbreite und alles Übrige, das erst in einem Job wirkt. In einem Job
  bleibt es bei 409 `endpoint-config-managed-by-job`.
- **Sichtbar:** Die Liste der Rechner trägt den Handlungsbedarf `no_job` (zählt in "brauchen
  Aufmerksamkeit" der Übersicht und in `endpoints.needingAttention` von `GET /api/v1/status`); ohne
  Erklärung in `problems`, die Seite des Rechners zeigt den Zustand mit "Job anlegen" und "Zu Job
  hinzufügen". Ein Client ohne Job löst nach 7 Tagen ohne gute Sicherung wie jeder Client
  `endpoint.stale` aus.
- **In einen Job:** Anlegen mit `scope.members`, `POST .../members` oder `PUT .../members` schreiben den
  Zeitplan des Jobs über `none` (`buildEndpointConfig` übernimmt ihn immer, wenn der Rechner `none`
  hat) und erhöhen `config_version`; der Agent holt die Konfiguration mit der `update_config`-Aufgabe.

### Aufgaben (`tasks`)

`backup_now`, `restore`, `verify_sample`, `update_config`, `uninstall`. Eine Aufgabe ist
`pending`, dann `delivered` (der Agent hat sie mit dem Heartbeat erhalten), dann `done` oder
`failed`.

- `backup_now`, `restore`, `verify_sample` enden mit dem Lauf, der sie über `taskId` aufgreift.
  Eine zugestellte Aufgabe, für die 30 Minuten lang kein Lauf begann, wird erneut zugestellt.
  Eine offene Aufgabe mit `params.notBefore` (ein erneut angebotener Restore-Test) gibt der
  Heartbeat erst ab diesem Zeitpunkt aus.
- `update_config` und `uninstall` gelten mit der Zustellung als erledigt. Nach `uninstall`
  ist der Endpunkt widerrufen (der Agent entfernt sich selbst; das Repository bleibt
  wiederherstellbar).
- Hat der Agent eine andere `configVersion` als der Server, erhält er ohne Zutun eine
  `update_config`-Aufgabe (Selbstheilung).
- Nicht abgeholte Aufgaben laufen nach 7 Tagen ab (ein Laptop, der aus blieb). Die Detailseite trägt
  die wartenden Aufgaben (`tasks`: offen oder zugestellt) und die letzten 20 abgeschlossenen
  (`recentTasks`: erledigt oder fehlgeschlagen, neueste zuerst); bei einer fehlgeschlagenen steht der
  Grund (abgelaufen, Endpunkt widerrufen, Agent still, sonst die Meldung des Agenten).
- `restore`: `{ snapshotId, paths, targetDir? }`. Der Agent stellt in `targetDir` her, sonst
  in `<erstes gesichertes Wurzelverzeichnis, das nur root ändern kann>/Restow-Restore-<yyyyMMdd-HHmmss>/`,
  nie über vorhandene Dateien (`restic restore --target <neuer Ordner> --include ...`).
  `targetDir` muss ein schlichter absoluter Pfad sein (kein `.`, `..`, doppelter oder
  abschließender Schrägstrich; der Server prüft das schon beim Anlegen der Aufgabe). Der
  Agent löst Links im übergeordneten Ordner auf, verlangt, dass dieser und alle Ordner
  darüber nur root ändern kann (ein Ordner mit Sticky-Bit wie `/tmp` ist erlaubt), und legt
  das Ziel mit `os.Mkdir` (0700) an; ein vorhandenes Ziel muss leer sein und root gehören.
  Sonst Fehlercode `invalid_task`, `target_unusable` oder `target_not_empty`.
- `verify_sample`: `{ snapshotId, files: [{ path, sha256 }], retry?, notBefore? }`. Der Agent stellt
  alle Dateien mit einem einzigen `restic restore` in einen temporären Ordner her, bildet je Datei
  SHA-256, löscht die Kopie und meldet in `restoreTest`, was er vorfand (Hash, `missing` oder
  `error` je Datei, dazu Exit-Code, letzte Fehlermeldung und bis zu 100 Einzelfehler von restic).
  Ein Urteil sendet er nicht; der Server bewertet (siehe "Restore-Test"). Ein erneut angebotener
  Test trägt `retry` (1 bis 6) und `notBefore`.

### Stichproben (`sample`)

Nach jeder erfolgreichen Sicherung wählt der Agent aus bis zu 80 zufälligen regulären Dateien
des Snapshots (keine über 256 MiB, zusammen höchstens 1 GiB zu hashen) bis zu 20 aus und meldet
Pfad, SHA-256 und Größe (`agent/internal/core/sample.go`). **Der Hash muss dem Inhalt im
Snapshot entsprechen, nicht einer später geänderten Datei**: Der Agent hasht die Datei auf der
Platte nur, wenn sie nachweislich unverändert ist (Größe wie im Snapshot, Änderungszeit höchstens
zwei Sekunden daneben, und vor wie nach dem Hashen gleich); andere Kandidaten überspringt er.
Sonst würde der Restore-Test eine nach der Sicherung bearbeitete Datei fälschlich rot bewerten.
Der Server speichert die Stichproben (`endpoint_samples`, 90 Tage) und benutzt sie für den
Restore-Test.

### Fehlercodes eines Laufs

`errors[].code` ist ein Code des Agenten; der Server speichert ihn unverändert (ein neuerer Agent
darf weitere senden), die Oberfläche formuliert die bekannten (`endpoints:runErrors.<code>`):
`interrupted`, `no_paths`, `pre_hook_failed`, `post_hook_failed`, `hooks_not_allowed`, `timeout`,
`target_not_empty`, `invalid_task`, `hash_mismatch`, `missing`, `not_regular`, `read_error` und
`restic_exit_<N>`. `hooks_not_allowed` heißt: Ein Hook ist eingestellt, aber der Rechner lässt
Hooks des Servers nicht zu; die Sicherung lief ohne ihn und ist `partial`. `missing` heißt nur noch:
In der hergestellten Kopie liegt unter diesem Pfad nichts; jeder andere Fehler beim Prüfen des
Pfads ist `read_error`. Dateien, die restic bei einer Sicherung nicht lesen konnte, stehen je Datei
mit restics Grund in `errors` (der Agent liest dafür beide Ausgabekanäle von restic 0.19); bei mehr
als 100 Dateien nennt die Liste die ersten 99 und im letzten Eintrag die Zahl der übrigen. Jeder
Eintrag wird auf das gekürzt, was der Server annimmt (lange Pfade behalten Anfang und Ende).

`interrupted` heißt: Der Agent wurde während des Laufs neu gestartet (Update, Neustart des
Rechners, gestoppter Dienst) und setzt die Arbeit selbstständig fort. Das ist kein Ergebnis und
keine fehlgeschlagene Sicherung: Der Lauf wird als `failed` mit diesem Code gespeichert, löst aber
weder einen Alarm noch das Webhook `job.failed` aus, verschiebt `last_backup_at` nicht und taucht
nicht als "letzte Sicherung fehlgeschlagen" in der Oberfläche auf. Die Lauf-Objekte der Session-API
tragen dafür das Feld `interruptedOnly` (ein fehlgeschlagener Lauf, dessen Fehler alle `interrupted`
sind); die Läufe-Liste und die Liste der Rechner zeigen ihn neutral als "Unterbrochen", nicht als
"Fehlgeschlagen". Ebenso bewertet ein `verify_sample`-Lauf, der nicht vollständig laufen konnte,
nichts (siehe "Restore-Test"): kein `verify.red`, kein `job.failed`. Läufe und Aufgaben der
Session-API tragen dafür `checkIncomplete`; die Oberfläche zeigt einen solchen Test neutral als
"Nicht abgeschlossen, wird wiederholt" (bei einem widerrufenen Rechner nur "Nicht abgeschlossen"),
mit der Ursache und, solange er wartet, dem Zeitpunkt des nächsten Versuchs.

**Erklärung statt Rohtext.** Zu jedem Lauf, der nicht gut endete, speichert der Server eine
strukturierte Erklärung (`endpoint_runs.failure`, dasselbe Format wie bei Jobs,
`packages/core/src/failures`): ein stabiler Code `endpoint.*` (`no_paths`, `pre_hook_failed`,
`post_hook_failed`, `hooks_not_allowed`, `timeout`, `target_not_empty`, `invalid_task`, `hash_mismatch`,
`file_missing`, `file_not_regular`, `read_error`, `restic_failed`, `repository_locked`,
`repository_missing`, `repository_password`, `repository_refused`, `network`, `agent_stopped`,
`interrupted`), dazu die Schritte aus dem Katalog. Entscheidend für die Wahl ist der Fehler, den
der Admin zuerst beheben muss (ein Hook oder fehlende Ordner vor allem anderen). `restic_exit_<N>`
wird nach restics Exit-Codes gedeutet (10 Repository fehlt, 11 gesperrt, 12 Passwort, 3
unvollständig) und nach dem Text des Fehlers (Netzwerk, abgelehnt). Die Detailansicht eines
Endpunkts erklärt jeden Grund für Aufmerksamkeit ebenso (`problems`: still, überfällig, letzte
Sicherung fehlgeschlagen, Restore-Test fehlgeschlagen, Repository beschädigt). Die Texte stehen
in `failures.json` (de/en); ein Test in apps/api verlangt sie für jeden Code.

### Grenzen, die der Server erzwingt

Jede Anfrage wird mit Zod geprüft, unbekannte Felder werden ignoriert. Höchstens 20
Stichproben (die Größe darf fehlen, sie gilt dann als 0), 1000 Fehler (davon werden 200
gespeichert, je 1000 Zeichen), Log-Ende bis 768 KiB angenommen (der Abschluss eines Laufs kann
einen halben Megabyte groß sein; gespeichert werden die letzten 20 KiB). IDs und `configVersion`
dürfen als Zahl oder als Zeichenkette kommen, ein leeres `configVersion` heißt "unbekannt". Zeiten des Agenten werden auf "nicht in der
Zukunft, höchstens 24 Stunden zurück" begrenzt. `restoreTest` nimmt höchstens 100 Dateien und
100 Einzelfehler von restic an (Meldungen bis 4000 Zeichen, Pfade bis 8192); ein Bericht, der nicht
passt, wird verworfen, der Lauf aber nicht abgelehnt. Stichprobenpfade bleiben genau so, wie restic
die Datei nennt (auch ein Leerzeichen am Ende wird nicht mehr abgeschnitten).

Fehlermeldungen und Log-Ende eines Laufs schwärzt der Server, bevor er sie speichert
(`packages/core/src/endpoints/run-redact.ts`): Meldungen mit der zentralen Schwärzung der
Fehlertexte, das Log Zeile für Zeile, sodass sein Aufbau erhalten bleibt (Schlüsselblöcke über
mehrere Zeilen werden als Ganzes entfernt). Die Schwärzung kennt auch die eigenen Zugangsdaten des
Produkts ohne Kontext (`rset_`, `rsea_`, `rsk_<tag>_<secret>`) und Variablen wie `PGPASSWORD=`. Auf
die Schwärzung im Agenten verlässt sich der Server nicht: Ein Hook oder restic kann alles ausgeben.

Snapshot-IDs nimmt der Server in beliebiger Schreibweise an und speichert, vergleicht und verteilt
sie nur klein geschrieben (Migration 0019 schreibt gespeicherte IDs wartender Aufgaben, der Läufe
und der Endpunkte klein). restic und der Agent kennen nur Kleinbuchstaben; eine großgeschriebene ID
in einer Restore- oder Prüfaufgabe würde auf dem Rechner mit `invalid_task` scheitern.

## restic-REST-Endpunkt `/agent/restic/:endpointId/...`

Implementiert das Protokoll v2 des REST-Backends von restic
(`Accept: application/vnd.x.restic.rest.v2`): `HEAD/GET /config`, `POST /config`,
`GET /:type/` (Liste), `HEAD/GET/POST/DELETE /:type/:name`, `POST /?create=true`, mit den Typen
`data`, `keys`, `locks`, `snapshots`, `index`. `GET` versteht `Range`.

**Ablage.** Die Objekte liegen im Primärziel des Mandanten unter `endpoints/<endpointId>/`,
im Ordnerlayout des restic-rest-servers (`config`, `data/<xx>/<id>`, `index/<id>`,
`keys/<id>`, `locks/<id>`, `snapshots/<id>`). Bei einem lokalen Ziel ist der Ordner damit
ein gewöhnliches restic-Repository (siehe "Restore ohne Restow"). Lokal, S3, NFS
funktionieren gleich. Alles wird gestreamt, nichts komplett im Speicher gehalten.

**Autorisierung** (`packages/core/src/endpoints/restic-authz.ts`, getestet als Matrix):

| Operation | Agent (append-only) | Wartung (Volllzugriff) |
| --- | --- | --- |
| `HEAD/GET` alles, Listen | ja | ja |
| `POST /:type/:name`, Objekt existiert nicht | ja | ja |
| `POST /:type/:name`, Objekt existiert schon | **403** | ja |
| `POST /config`, `POST /?create=true` | **403** | ja |
| `DELETE /locks/:name`, Sperre hat der Agent selbst geschrieben | ja | ja |
| `DELETE /locks/:name`, jede andere Sperre (z. B. die exklusive Sperre des Servers) | **403** | ja |
| `DELETE` alles andere, `DELETE /` | **403** | ja |

Dazu: Namen müssen ein SHA-256 in Hex sein (kein Pfad kann aus dem Repository ausbrechen).
Der Server prüft beim Hochladen, dass der Inhalt zum Namen passt (jedes restic-Objekt heißt
wie der SHA-256 seines Inhalts); passt er nicht, wird nichts gespeichert (400). Damit kann auch
ein gleichzeitiger Doppel-Upload nichts Falsches unter einem vorhandenen Namen ablegen. Bodys
über 128 MiB werden abgelehnt (413). Ein Upload, der das Speicherbudget sprengt, wird mit 403 und
`urn:restow:problem:endpoint-quota-exceeded` abgelehnt (siehe "Speicherbudget"). Zugriffe sind je Endpunkt begrenzt (20.000 Anfragen pro
10 Minuten), falsche Zugangsdaten je Adresse (30 pro 10 Minuten, dann 429). Jeder Versuch
eines Agenten, etwas Verbotenes zu tun, wird auditiert (`endpoint.repository.denied`,
gedrosselt auf einen Eintrag je Endpunkt und Art alle 10 Minuten): Ein Rechner, der versucht,
seine Sicherungen zu löschen, ist ein Fall für den Admin.

**Widerruf.** Ein widerrufener Endpunkt bekommt 401 mit `urn:restow:problem:endpoint-revoked`
und sichert nicht mehr. Ein Mandant im Status "gesperrt" bekommt 403.

### Sperren

restic markiert ein Repository, an dem es arbeitet, mit einer Datei unter `locks/`; `prune`
braucht eine exklusive Sperre und bricht ab, solange eine andere existiert. Ohne Schutz könnte
der Agent jede Sperre löschen (auch die exklusive des Servers) und eine Sperre anlegen, die nie
verwaist (restic bewertet das Alter nach dem Zeitstempel **in** der Datei, und den schreibt der
Agent). Deshalb:

- Die API merkt sich den Namen jeder Sperre, die ein Agent schreibt (`endpoint_repository_locks`),
  und lässt ihn nur diese löschen. Jede andere Sperre bleibt; der Versuch wird als
  `endpoint.repository.denied` mit dem Grund `foreign_lock` auditiert. Eine Sperre, die der Server
  schon entfernt hat, beantwortet die API beim Freigeben mit 404 statt 403.
- Vor jeder Aufbewahrung und Prüfung räumt der Worker auf (`apps/worker/src/endpoints/maintenance.ts`):
  Eine Sperrdatei, die der Speicher vor mehr als 30 Minuten erhalten hat, ist verwaist, gleich was
  in ihr steht, denn restic schreibt für eine lebende Sperre alle fünf Minuten eine neue Datei mit
  neuem Namen. Sperren des Agenten entfernt er, sobald die Datenbank keinen laufenden Lauf des
  Agenten zeigt. Sperren der eigenen restic-Prozesse des Servers bleiben, solange sie frisch sind.
- Ein Repository, das trotzdem gesperrt ist, wird gezählt: Findet die Wartung es sechsmal in
  Folge und über mindestens zwölf Stunden gesperrt, geht einmal `endpoint.repository_locked`
  hinaus; der nächste Lauf, der die Sperre bekommt, setzt den Zähler zurück. Ein Agent kann die
  Wartung also weiterhin aufhalten, indem er einen Lauf offen hält und Sperren erneuert (so wie
  eine sehr lange Sicherung), aber nicht mehr unbemerkt; einen Lauf ohne Fortschritt schließt
  der Monitor nach sechs Stunden.

### Speicherbudget

Ein Agent kann nur anhängen, aber Anhängen genügt, um ein Speicherziel zu füllen, das auch alle
Postfachsicherungen trägt. Deshalb hat jedes Endpunkt-Repository ein Budget, und alle
Repositories eines Mandanten teilen sich ein weiteres (`packages/core/src/endpoints/quota.ts`):

- `RESTOW_ENDPOINT_QUOTA_GIB` je Endpunkt, Standard 2048 (2 TiB). Ein Admin kann je Rechner einen
  eigenen Wert setzen (Einstellungen, `settings.quotaGib`, 1 GiB bis 1 PiB; leer heißt Standard).
- `RESTOW_ENDPOINT_TENANT_QUOTA_GIB` für alle Endpunkte eines Mandanten zusammen, Standard 20480
  (20 TiB). Nur der Betreiber setzt ihn.
- `0` schaltet ein Budget ab; ein ungültiger Wert lässt den Standard gelten. API und Worker lesen
  beide Variablen.

Die API kennt die Größe jedes Repositorys (`endpoints.repository_bytes`): Beim ersten Bedarf misst
sie es durch Auflisten des Speichers, danach zählt sie jeden Upload und jede Löschung mit, und jeder
Aufbewahrungslauf misst neu. Vor jedem Upload fragt sie, wie viel noch passt; ein Upload, der nicht
passt, wird mit 403 und `urn:restow:problem:endpoint-quota-exceeded` abgelehnt (403 und nicht 507,
weil restic bei 403 sofort aufgibt, statt dasselbe Pack eine Viertelstunde lang erneut zu senden).
Sperrdateien zählen nicht gegen das Budget, damit ein Restore auf dem Rechner auch mit ausgeschöpftem
Budget funktioniert. Gleichzeitige Uploads können das Budget um einige Packs überschreiten. Die
Ablehnung wird am Endpunkt vermerkt (`quota_refused_at`).

Der Monitor warnt mit `endpoint.storage_quota`, wenn ein Repository 90 Prozent seines Budgets
erreicht (Warnung) und wenn es ausgeschöpft ist oder ein Upload abgelehnt wurde (Fehler), je Stufe
einmal; unter 80 Prozent wird die Warnung wieder scharf. Erreichen alle Endpunkte eines Mandanten
zusammen 90 Prozent des Mandantenbudgets, geht höchstens einmal am Tag eine Meldung hinaus (Gegenstand
ist der Mandant). Die Detailseite zeigt im Bereich "Repository" den belegten Speicher gegen beide
Budgets, welches Budget gilt, den letzten abgelehnten Upload und ab 90 Prozent einen Hinweis.

## Wartungszugang des Servers

Retention, Prüfung, Restore-Test, Browsen, Download und das erste `init` brauchen mehr als
den append-only-Zugriff. Sie laufen als restic-Prozess auf dem Server. Der Zugang:

- ein HTTP-Listener nur auf `127.0.0.1`, Port vom Betriebssystem gewählt,
- dasselbe Protokoll-Modul wie der öffentliche Endpunkt, aber mit dem Prinzipal
  `maintenance` (Volllzugriff),
- Basic-Zugangsdaten, die für **diesen** Listener zufällig sind und dem restic-Prozess über
  seine Umgebung übergeben werden (`RESTIC_REST_USERNAME`/`RESTIC_REST_PASSWORD`),
- der Listener lebt für genau eine Operation und wird danach geschlossen.

Das Wartungs-Secret verlässt also nie den Prozess, steht nirgends, und ist nach der Operation
wertlos. Es gibt bewusst **keinen** öffentlich erreichbaren Wartungszugang und kein
gespeichertes Wartungs-Passwort. (Der Auftrag sah ein "internes Wartungs-Credential" vor, das
der Worker verwendet; mit dem Loopback-Listener braucht der Worker weder Netzwerkzugriff auf die
API noch ein geteiltes Geheimnis.) restic-Prozesse bekommen nur `PATH`, `TMPDIR` und die
`RESTIC_*`-Variablen, nicht die Umgebung des Servers (keine Datenbank-URL, kein Master-Key).

## Aufbewahrung, Prüfung, Restore-Test

Eigene pg-boss-Queues, nicht Teil der Mandanten-Queues (kein `jobs`-Eintrag, weil sie auf
einem Endpunkt-Repository laufen, nicht auf einem geschützten Objekt). Der Scheduler
(`apps/scheduler/src/endpoints.ts`) plant sie aus dem Zustand der Endpunktzeilen; ein
Singleton-Schlüssel je Endpunkt und Art verhindert doppelte Jobs, `singletonSeconds` (1 Stunde)
beschränkt die Wiederholung bei dauerhaft fehlschlagenden Jobs.

| Queue | Wann | Was |
| --- | --- | --- |
| `endpoint-retention` | täglich je aktivem Endpunkt | Sperren aufräumen (siehe "Sperren"), `restic unlock`, die Entscheidung des Servers (unten), `restic forget <id>...` und `restic prune` nur für die gewählten Snapshots, Größe messen; Bericht `retention`. |
| `endpoint-check` | wöchentlich je Endpunkt | Sperren aufräumen, `restic check --read-data-subset=n/20`: pro Woche ein Zwanzigstel der Daten, in fester Reihenfolge, damit das ganze Repository über etwa fünf Monate gelesen wird. Bericht `repository_check`, grün oder rot. War das Repository gesperrt, gilt die Prüfung als nicht gelaufen: `last_check_at` bleibt stehen, der Scheduler bietet sie wieder an. |
| `endpoint-verify` | nach jedem neuen guten Backup mit Stichproben | Restore-Test (unten). |
| `endpoint-monitor` | alle 5 Minuten | Aufräumen und Alarme (unten). |

**Nie zwei Arbeiten des Servers zugleich auf einem Repository.** restic sperrt seine
Repositories selbst, aber zwei restic-Prozesse, die im selben Augenblick starten, können die Sperre des
anderen übersehen; ein Restore-Test, der liest, während ein Prune Packs umschreibt, hält heile Daten
für beschädigt (beobachtet: der Scheduler startete die erste Aufbewahrung, die Prüfung und einen
Restore-Test binnen 0,3 Sekunden, und der Test wurde zu Unrecht rot). Darum hält jede Arbeit des
Servers an einem Endpunkt-Repository eine Sperre in Postgres (`pg_try_advisory_lock`, je Endpunkt,
über alle Prozesse; `packages/db/src/repository-lock.ts`): Aufbewahrung und Prüfung exklusiv, der
Restore-Test und die Lesezugriffe der API (Snapshot-Liste, Browsen, Download) geteilt. Ein Job wartet
bis zu einer Minute; bekommt er die Sperre dann nicht, scheitert er mit
`EndpointRepositoryBusyError`, bewertet nichts, schreibt keinen Bericht und zählt nicht als gesperrte
Wartung, und pg-boss bzw. der Scheduler versuchen es später wieder. Ein Lesezugriff der API wartet bis
zu zwei Sekunden und antwortet sonst mit 503 `endpoint-repository-locked`; ein vorbereiteter Download,
der so abgewiesen wird, bleibt startbar. Ein Download hält die Sperre, bis sein Strom endet.

Ein restic-Prozess, den ein Signal beendet (abgebrochen, Speichermangel, Herunterfahren), endet ohne
Exit-Code. Das gilt überall als Fehlschlag (`killed`), nie als Erfolg: Ein so abgebrochener
`restic dump` liefert nur einen Teil der Datei, der sonst wie die ganze gehasht würde. Der Restore-Test
bewertet einen solchen Lesefehler nicht, sondern wiederholt sich wie bei einem gesperrten Repository.

**Aufbewahrungsrichtlinie.** Je Endpunkt, Standard **täglich 30, wöchentlich 12, monatlich 12**
(`endpoints.settings.retention`, änderbar in den Einstellungen). Das Retention-Modell der
Postfächer (Stufen nach Alter) ist bewusst nicht wiederverwendet: restic kennt "die letzten N
Tages-/Wochen-/Monatssnapshots", nicht Altersstufen, und die beiden lassen sich nicht sauber
ineinander abbilden. Gruppiert wird nicht: Das Repository gehört einer Maschine; eine Änderung der
gesicherten Pfade soll keine zweite Aufbewahrungsreihe mit ewig behaltenen alten Snapshots
erzeugen. Ein widerrufener Endpunkt wird nicht mehr bereinigt. Ist das Repository gesperrt (ein
Backup läuft), schlägt der Job mit `locked` fehl und pg-boss wiederholt ihn; das ist kein Befund
(siehe "Sperren"). Der Agent legt seine Snapshots mit `--host <Hostname beim Enrollment> --tag
restow-agent` an; die Aufbewahrung gruppiert bewusst nicht nach Host und Pfaden.

**Wer entscheidet, was gelöscht wird.** `restic forget --prune --keep-daily ...` allein wäre
unsicher: restic sortiert dabei nach der Zeit, die **in** jedem Snapshot steht, und die schreibt der
Agent. Ein kompromittierter Rechner könnte etwa 30 Snapshots mit Zeiten in der Zukunft anlegen, und
der nächste Aufbewahrungslauf würde jede echte Sicherung vergessen. Deshalb entscheidet
der Server (`packages/core/src/endpoints/retention-policy.ts`), und zwar nur mit Fakten, die er
kontrolliert:

1. Welche Snapshots es gibt: die Dateien unter `snapshots/` im Speicher.
2. Welche davon Sicherungen sind: die Snapshots, die Sicherungsläufe gemeldet haben
   (`endpoint_runs.snapshot_id`; eine gekürzte ID zählt nur, wenn genau ein Snapshot mit ihr
   beginnt).
3. Wann jeder entstand: der frühere von zwei Zeitpunkten, zu dem der Speicher seine Datei erhalten
   hat (`lastModified` im S3, Änderungszeit im Dateisystem; der Agent kann ihn nicht setzen und nicht
   ändern, denn ein vorhandenes Objekt wird nie überschrieben) und dem Ende des Laufs, der ihn
   gemeldet hat, wie der Server es aufgezeichnet hat (nie nach dem Eintreffen der Meldung, höchstens
   einen Tag davor). Der frühere gilt, damit ein kopierter Speicherordner, dessen Dateien alle die
   Zeit der Kopie tragen, nicht jeden Snapshot neu aussehen lässt.

Auf diese Snapshots wendet der Server die Regeln von restic an (je Regel der neueste Snapshot jedes
der letzten N Tage, Wochen nach ISO 8601 und Monate, die einen haben; der älteste bleibt, solange eine
Regel noch Zähler übrig hat), in der Zeitzone des Mandanten, und übergibt restic genau die gewählten
IDs (`restic forget <id>...`, danach `restic prune`, nur wenn etwas wegfiel). Die Zeit im Snapshot
entscheidet nichts mehr.

Snapshots, die kein Lauf gemeldet hat, löscht die Aufbewahrung nie. Sie und Snapshots, deren Zeit mehr
als eine Stunde in der Zukunft oder nach dem Speichern ihrer Datei liegt, werden als verdächtig
vermerkt (`endpoint_snapshot_flags`, Gründe `unrecorded` und `future_time`) und einmal mit
`endpoint.suspicious_snapshot` gemeldet. Ein nicht gemeldeter Snapshot, dessen Datei jünger als eine
Stunde ist, gilt noch nicht als verdächtig (restic legt die Datei ab, bevor der Agent den Lauf
abschließt). Meldet ein Lauf einen vermerkten Snapshot später doch, verschwindet die Markierung beim
nächsten Lauf. Die Zeiten in den Snapshots liest der Server dafür ohne Sperre (`restic snapshots
--no-lock`); kann restic sie nicht lesen, vermerkt er die nicht gemeldeten trotzdem und entscheidet
nichts. Die Liste der Wiederherstellungspunkte markiert verdächtige Snapshots, der Bericht des Laufs
nennt ihre Zahl (`unrecordedSnapshots`, `futureSnapshots`). Ein Agent, der weiter täglich Unsinn
sichert und meldet, verdrängt nach 30 Tagen die täglichen echten Snapshots; die wöchentlichen und
monatlichen bleiben, und die Restore-Tests werden rot. Das ist dieselbe Grenze wie bei jedem Rechner,
der Unsinn sichert.

**Restore-Test.** Der Server liest die gemeldeten Stichprobendateien mit `restic dump` aus dem
Repository, bildet SHA-256 und vergleicht (`packages/core/src/endpoints/restore-test.ts`,
Job `apps/worker/src/endpoints/verify.ts`). **Grün nur bei übereinstimmenden Hashes** und
mindestens einer Datei. **Rot nur mit Beleg**: ein abweichender Hash, oder restic beendet das
Lesen mit Exit-Code 1 und als letzter Zeile einem `Fatal:`, das die Sicherung selbst betrifft
(die Datei steht nicht im Snapshot, `<data|index|snapshot/…> does not exist`, `not found in
repository`, `ciphertext verification failed`, `invalid data returned`; `isBackupFinding`).
Jeder andere Lesefehler beweist nichts über die Sicherung: Repository gesperrt oder
beschäftigt, restic per Signal beendet, abgestürzt, nicht startbar, Zeitüberschreitung,
Repository nicht erreichbar oder Passwort falsch (das bewertet die Repository-Prüfung). Dann
ist das Ergebnis unvollständig: Der Job scheitert mit `RestoreTestIncompleteError`, schreibt
keinen Bericht, pg-boss wiederholt ihn, und der Scheduler bietet ihn stündlich wieder an, bis
ein Test vollständig durchläuft; bis dahin bleibt der Endpunkt "nicht geprüft". Ein
fehlgeschlagener Lesevorgang zählt nie als Übereinstimmung. Die kleinste Datei liest der
Server zuerst und allein, die übrigen zu viert: restic 0.19 kann einen neuen Cache-Ordner nicht
aus mehreren Prozessen zugleich anlegen ("unable to open cache: readVersion"), was den ersten
Restore-Test eines neuen Endpunkts zufällig scheitern ließ; ist der Ordner einmal angelegt,
teilen ihn die Prozesse sicher.

Nach einem bewerteten Test legt der Job dem Agenten dieselben Dateien als
`verify_sample`-Aufgabe vor (sieben Tage gültig); dessen Ergebnis wird ein zweiter Bericht
(Herkunft `agent`) zum selben Snapshot. Ist einer der beiden rot, ist der Endpunkt rot.

Den Bericht des Agenten bewertet der Server nach denselben Regeln
(`judgeAgentRestoreTest`, `isRestoreFinding` in `packages/core/src/endpoints/restore-test.ts`):

- **Grün** nur mit Status `succeeded` und jeder Datei mit ihrem Hash zurück (ohne `restoreTest`,
  von einem Agenten einer Vorabversion: `succeeded` ohne Fehler).
- **Rot** nur mit Beleg: ein abweichender Hash; `missing` nach einem `restic restore` ohne Fehler
  (die Datei steht nicht im Snapshot); oder restic endet mit Exit-Code 1 und entweder ist seine
  letzte Fehlermeldung einer der Befunde des Servers (`<data|index|snapshot/…> does not exist`,
  `not found in repository`, `ciphertext verification failed`, `invalid data returned`,
  `not found in snapshot`), oder er endet mit "There were N errors", der Agent hat alle N
  weitergegeben, und jedes gescheiterte Element hat mindestens einen Befund unter seinen Fehlern
  (Folgefehler am selben Element zählen nicht dagegen). "Der Snapshot existiert nicht" belegt
  nichts, wenn der getestete Snapshot nicht mehr der neueste des Rechners ist (die Aufbewahrung
  kann ihn entfernt haben).
- **Alles andere ist unvollständig**, auch eine Mischung aus Beleg und anderen Fehlern, ebenso ein
  Test, der gar nicht bis `restic restore` kam (voller oder nicht beschreibbarer Datenträger, Agent
  angehalten, Repository beschäftigt oder nicht erreichbar, restic nicht startbar) und ein Test,
  dessen Lauf der Monitor nach sechs Stunden ohne Fortschritt schließt: kein Bericht, keine
  Änderung der Bewertung, `last_restore_test_at` bleibt, kein Alarm, kein `job.failed`. Derselbe
  Test wird als neue Aufgabe nach 1, 2, 4, 8, 16 und 24 Stunden erneut angeboten
  (`packages/core/src/endpoints/restore-test-retry.ts`), nur solange sein Backup das neueste des
  Rechners ist, nur wenn nicht schon ein Test dieses Backups wartet, nie für einen widerrufenen
  Rechner; danach bringt die nächste Sicherung einen neuen Test.

restic 0.19 kann einen neuen Cache-Ordner nicht aus mehreren Prozessen zugleich anlegen; den Agenten
betrifft das nicht, denn er stellt alle Dateien eines Tests mit einem `restic restore` her und
führt einen Lauf nach dem anderen aus.

**Recovery Readiness** (`packages/core/src/endpoints/readiness.ts`, dieselbe Regel wie bei
Postfächern: Die Bewertung gehört zu dem Backup, das sie geprüft hat):

- `no_backup`: noch kein gutes Backup.
- `unverified`: ein Backup, aber kein Restore-Test für genau dieses Backup. Ein grüner Test
  eines älteren Backups zählt nicht.
- `green`: Restore-Test des neuesten Backups bestanden.
- `yellow`: bestanden, aber das Backup war `partial` (einige Dateien unlesbar).
- `red`: ein Restore-Test des neuesten Backups ist fehlgeschlagen, oder eine neuere
  Repository-Prüfung fand Schäden.

Die Endpunkte erscheinen in der Übersicht der Recovery Readiness (`GET /api/v1/verify/latest`,
Feld `endpoints`) und zählen in der Zusammenfassung des Mandanten mit. Die Seite listet sie in
derselben Tabelle wie Postfächer, OneDrives und IMAP-Konten (mit Typ Server oder Client und dem
Betriebssystem), nach Dringlichkeit sortiert, damit Banner, Kacheln und Filter-Tabs denselben
Bestand zählen wie die Zeilen darunter. Ein Rating älter als 8 Tage ist überfällig.

## Alarme

Der Job `endpoint-monitor` nutzt dieselben Ereignisse, Regeln und denselben Ausgang (Glocke,
E-Mail, Webhook) wie alle anderen Jobs; jede Meldung entsteht einmal (eine Markierung an Lauf,
Bericht oder Endpunkt wird in derselben Transaktion gesetzt).

| Ereignis | Auslöser |
| --- | --- |
| `endpoint.stale` (neu, Gruppe Aufträge, Warnung) | Server: länger als 2 Stunden kein Kontakt. Client: seit 7 Tagen keine gute Sicherung. Beides je Endpunkt einstellbar. Clients gelten nie als "still": ein Laptop ist nachts aus. |
| `backup.failed` | ein Backup-Lauf ist fehlgeschlagen (auch ein Lauf, dessen Agent verschwand und der nach 6 Stunden ohne Fortschritt geschlossen wird). Einen Restore-Test, den der Monitor so schließt, bewertet niemand: Er wird erneut angeboten (siehe "Restore-Test"). |
| `restore.failed` | ein Restore-Lauf auf dem Endpunkt ist fehlgeschlagen. |
| `verify.red` | ein Restore-Test fand einen Beleg (siehe "Restore-Test"); ein unvollständiger löst nichts aus. `verify.recovered`, wenn danach ein Test wieder grün ist. |
| `scrub.corrupt` | die Repository-Prüfung fand Schäden. |
| `endpoint.suspicious_snapshot` (Gruppe Speicher, Fehler) | die Aufbewahrung fand Snapshots, die kein Lauf gemeldet hat oder die in der Zukunft datiert sind; je Snapshot einmal. |
| `endpoint.storage_quota` (Gruppe Speicher, Warnung bzw. Fehler) | ein Repository hat 90 Prozent seines Budgets erreicht, das Budget ist ausgeschöpft oder ein Upload wurde abgelehnt; je Stufe einmal. Dazu höchstens einmal am Tag, wenn alle Endpunkte eines Mandanten 90 Prozent des Mandantenbudgets erreichen (Gegenstand ist dann der Mandant). |
| `endpoint.repository_locked` (Gruppe Aufträge, Warnung) | Aufbewahrung und Prüfung fanden das Repository sechsmal in Folge über mindestens zwölf Stunden gesperrt. |

Damit deckt eine bestehende Alarmregel für `backup.failed` und `verify.red` Endpunkte ohne
Änderung mit ab. Zusätzlich löst ein fehlgeschlagener Lauf das Webhook-Ereignis `job.failed`
aus (Nutzlast `job` mit `queue: endpoint_backup`, `endpoint_restore` bzw., nur für einen rot
bewerteten Restore-Test des Agenten, `endpoint_verify_sample`, dazu `endpoint`), damit RMM und PSA
Tickets anlegen können. Ein unvollständiger Restore-Test, auch einer, den der Monitor geschlossen
hat, sendet kein `job.failed`.

## Restore

- **Auf den Endpunkt** (`POST /api/v1/endpoints/:id/tasks`, `kind: restore`): Der Agent stellt
  in einen **neuen Ordner** her. Die Oberfläche sagt das, bevor der Admin bestätigt.
- **Download als ZIP** in zwei Schritten. `POST /api/v1/endpoints/:id/downloads` mit
  `{ snapshotId, paths }` (Pfade im Body, höchstens 10.000, Body höchstens 4 MiB, sonst 413
  `endpoint-download-too-large`) prüft jeden Pfad gegen den Snapshot (ein `restic ls` für bis zu
  200 Pfade; ein unbekannter Pfad ist ein 404 `endpoint-path-not-found`, bevor irgendetwas
  vorbereitet wird) und legt die geprüfte Auswahl als Download ab (`endpoint_downloads`). Die Antwort
  (201) ist `{ id, expiresAt, items }`. `GET /api/v1/endpoints/:id/downloads/:downloadId` startet ihn: Der
  Download gilt zehn Minuten, genau **einmal** und nur für den Admin, der ihn vorbereitet hat (ein
  zweiter Abruf, ein anderer Admin, ein anderer Mandant oder Ablauf ergeben 404
  `endpoint-download-gone`); ein HEAD-Aufruf verbraucht ihn nicht (405). Erst dann ruft der Server
  `restic dump` auf und packt gestreamt zu einem ZIP; der Audit-Eintrag steht **vor dem ersten Byte**.
  Ordner werden als tar gelesen und Eintrag für Eintrag umgepackt, sodass das ZIP den gewählten
  Ordner zeigt (`docs/a.txt`, nicht `home/anna/docs/a.txt`). Nichts wird auf Platte
  zwischengespeichert. Ein Fehler beim Streamen bricht die Verbindung ab, sodass kein ZIP entsteht,
  das vollständig aussieht und es nicht ist. Symbolische Links und Sonderdateien tragen keinen Inhalt
  und fehlen im ZIP; doppelt genannte Pfade zählen einmal. Eintragsnamen enthalten keine Teile aus
  Punkten und keinen Backslash, keinen Doppelpunkt und kein Steuerzeichen (diese werden zu
  `_`): Ein Linux-Dateiname wie `..\..\x` bleibt beim Entpacken unter Windows ein Dateiname und wird
  kein Pfad zwei Ordner nach oben. Der Start ist eine Navigation und kann den
  Header `X-Restow-Tenant` nicht senden; der Mandant kommt als Query-Parameter `tenant` (wie beim
  Restore-Download). Die Oberfläche bereitet zuerst vor und schickt den Browser dann auf die Adresse.
  Abgelaufene Download-Zeilen räumt der Monitor eine Stunde nach Ablauf ab. **Grenze:** Jede einzeln
  gewählte Datei und jeder gewählte Ordner läuft als eigener restic-Prozess (jeder Start kostet eine
  Schlüsselableitung von rund einer halben Sekunde Rechenzeit); Tausende Einzeldateien dauern
  entsprechend, ein übergeordneter Ordner ist viel schneller. Die Oberfläche weist ab 50 Einzeldateien
  darauf hin.
- **Browsen** (`GET .../browse?snapshotId=&path=&limit=&cursor=`) über `restic ls` auf dem Server, ein
  Ordner pro Anruf, in Seiten: Ordner zuerst, dann nach Name (Groß-/Kleinschreibung ignoriert, Zahlen
  in natürlicher Reihenfolge), höchstens `limit` Einträge (Standard 1000, höchstens 5000). Ein Ordner mit
  mehr Einträgen antwortet mit `nextCursor` (undurchsichtiger Text); der nächste Aufruf mit
  `cursor=<nextCursor>` liefert die Seite danach, ohne Lücke und ohne Überlappung. Ein Cursor, den der
  Server nicht ausgestellt hat, ist ein 400 `endpoint-invalid-cursor`. restic kann nicht springen:
  Jede Seite liest die Ordnerliste von restic einmal durch und behält nur die Einträge der Seite, ein
  Ordner mit Millionen Einträgen kostet also je Seite einen Durchlauf, aber nie den Speicher für alle.
  Die Oberfläche lädt die erste Seite beim Öffnen und weitere mit "Mehr laden". Jede gelesene Seite ist
  auditiert.
- Browsen (je Seite), Download, Restore-Anforderung und das Anzeigen des Repository-Passworts stehen im
  Audit-Log: `endpoint.snapshot.browsed`, `endpoint.snapshot.downloaded`,
  `endpoint.restore.requested`, `endpoint.restore.finished`,
  `endpoint.repository.password.revealed`.
- Gleichzeitige restic-Prozesse der API sind begrenzt (6 insgesamt, 3 je Mandant; darüber 429
  `urn:restow:problem:restic-busy`).

### Restore ohne Restow

Das Repository ist ein gewöhnliches restic-Repository. Bei einem lokalen Speicherziel öffnet
`restic -r <Speicherpfad>/endpoints/<endpointId> restore latest --target <Ordner>` es ohne
Restow, mit dem Repository-Passwort. Ein Admin kann es in der Oberfläche anzeigen lassen
(`POST /api/v1/endpoints/:id/repository-password`, Bestätigung, Audit-Eintrag; nur mit
einer Anmeldung aus den letzten zehn Minuten, siehe "Sicherheitsmodell", Hooks und Step-up). Bei S3-Zielen
bindet man den Bucket mit restic direkt ein (`-r s3:...` mit `endpoints/<id>` als Präfix, sofern
der Pfad dort liegt).

**Master-Key und Speicher genügen.** Wie bei den Postfachsicherungen reichen der
Master-Key (KEK) und das Speicherziel, auch ohne Datenbank: Der Server legt das Repository-Passwort
zusätzlich neben das Repository, versiegelt mit dem Datenschlüssel des Mandanten
(`packages/core/src/endpoints/repository-key.ts`):

```
endpoints/<endpointId>/restow-repository-password.json
{ "format": "restow-endpoint-repository-password-v1", "tenantId": "...", "endpointId": "...",
  "sealed": "<base64, AES-256-GCM im Chunk-Format, AAD restow.endpoint-repository:<tid>:<eid>>" }
```

Die gewrappten Mandantenschlüssel liegen ohnehin unter `tenants/<tid>/keys/<version>` im selben
Speicher. Die Datei liegt außerhalb der Ordner von restic (in `keys/` würde restic sie als Schlüssel
lesen und scheitern); restic übergeht sie, und der restic-Endpunkt der API kann sie nicht adressieren,
der Agent kann sie also weder lesen noch ersetzen. Der Server schreibt sie beim Enrollment; für
Rechner, die mit 0.1.0 angemeldet wurden, schreibt sie der nächste Aufbewahrungs- oder Prüflauf, und
jeder Lauf ersetzt eine beschädigte oder veraltete Datei (idempotent). Das Werkzeug ohne Server öffnet
sie:

```
restow-restore endpoint-password --storage <Speicherpfad> --key <KEK-Datei|Variable> \
  --endpoint <endpointId> --out <neue Datei, Modus 0600>
restic -r <Speicherpfad>/endpoints/<endpointId> --password-file <Datei> restore latest --target <Ordner>
```

Ohne `--out` gibt es nur das Passwort auf der Standardausgabe aus; Warnung und restic-Befehl gehen auf
die Fehlerausgabe (packages/cli/README.md). Ohne Master-Key hilft nur ein notiertes Passwort; die
Oberfläche zeigt es auf Wunsch (siehe oben) und rät weiterhin, es in einem Passwortmanager
aufzubewahren.

## Problem-Typen

Die Antworten der Session-API sind `application/problem+json`. Jede Ablehnung, die ein Admin beheben
kann, hat einen eigenen `type` (`apps/api/src/features/endpoints/problems.ts`); die Oberfläche
formuliert einen Fehler nach dem `type`, nie nach dem Titel. Die Session-API gehört nicht zur
OpenAPI-Beschreibung der Integrations-API (sie bedient nur die Weboberfläche), darum stehen die Typen
hier.

| Typ (`urn:restow:problem:...`) | Status | Bedeutung |
| --- | --- | --- |
| `endpoint-revoked` | 401 an den Agenten, 409 bei Änderung oder Aufgabe durch einen Admin | Der Endpunkt ist widerrufen. |
| `endpoint-nothing-to-test` | 409 | Ein Restore-Test wurde verlangt, aber es gibt noch keine gute Sicherung. |
| `endpoint-instance-unknown` | 503 | Die öffentliche Adresse der Installation ist nicht gesetzt; ein Installationsbefehl lässt sich nicht bauen. |
| `endpoint-queue-not-ready` | 503 | Der Worker hat seine Queues noch nicht angelegt. |
| `endpoint-token-settled` | 409 | Das Token ist bereits verwendet oder widerrufen. |
| `endpoint-path-not-found` | 404 | Ein gewählter Pfad ist keine Datei und kein Ordner des Snapshots. |
| `endpoint-download-gone` | 404 | Der vorbereitete Download ist unbekannt, abgelaufen oder bereits gestartet. |
| `endpoint-download-too-large` | 413 | Die Auswahl eines Downloads ist zu groß (Body über 4 MiB). |
| `endpoint-invalid-cursor` | 400 | Der Cursor einer Ordnerseite stammt nicht vom Server. |
| `endpoint-repository-locked` | 503 | Das Repository ist durch eine Sicherung oder Wartung gesperrt, später erneut versuchen. |
| `endpoint-repository-unavailable` | 409 oder 500 | Das Repository oder sein Passwort ist nicht verfügbar. |
| `restic-busy` | 429 | Zu viele Snapshot-Lesevorgänge gleichzeitig (6 insgesamt, 3 je Mandant). |
| `restic-failed` | 502 | restic ist auf eine Weise gescheitert, die keinen eigenen Typ hat. |
| `restic-unavailable` | 503 | Das restic-Binary fehlt auf dem Server. |
| `endpoint-hooks-not-allowed` | 409 | Hooks wurden für einen Rechner gesetzt, der Hooks des Servers nicht zulässt (Regel `off`) oder keine Regel meldet (Agent einer Vorabversion). Leeren geht immer. |
| `endpoint-hook-not-a-script` | 422 | Der Rechner führt nur Skripte aus `/etc/restow-agent/hooks.d` aus (Regel `scripts`), und ein Hook ist kein Skriptname. |
| `recent-sign-in-required` | 403 | Hook setzen oder ändern bzw. Repository-Passwort anzeigen, aber die Anmeldung der Sitzung ist älter als zehn Minuten (`apps/api/src/lib/recent-sign-in.ts`, Feld `maxAgeSeconds`). Die Oberfläche fragt "Bestätigen Sie, dass Sie es sind" und wiederholt die Aktion. |
| `endpoint-no-job` | 409 | Der Rechner ist in keinem Backup-Job: "Jetzt sichern" oder ein anderer Zeitplan als `none` wird abgelehnt, gesichert wird nur in einem Job (seit 0.2.1). |
| `endpoint-config-managed-by-job` | 409 | Der Rechner gehört zu einem Job, der Zeitplan, Ordner, Ausschlüsse, Hooks und Bandbreite (und die Aufbewahrung, wenn der Job sie setzt) entscheidet; den Job ändern oder den Rechner aus ihm nehmen. Die Antwort nennt den Job (`job.id`, `job.name`). |
| `endpoint-assignee-unknown` | 422 | Die Person, der der Rechner zugeordnet werden soll (`PATCH /api/v1/endpoints/:id` mit `assignedUserId`), steht nicht (mehr) im Verzeichnis des Mandanten. Feld `field` ist `assignedUserId`. |
| `endpoint-invalid-bandwidth-windows` | 422 | Die Zeitfenster der Bandbreite eines Rechners ohne Job lassen sich nicht speichern (kein Tag, keine Uhrzeit `HH:MM`, Limit außerhalb 0 bis 10000000, Fenster überschneiden sich, mehr als 24). `issues[0].path` nennt Fenster und Feld, `code` ist `bandwidth_window_days_required`, `_days_invalid`, `_time_invalid`, `_kbps_invalid`, `bandwidth_windows_too_many` oder `bandwidth_window_overlap`. Im Job antwortet dieselbe Prüfung als `invalid-backup-job` (422) mit denselben Codes. |
| `unsupported-os` | 422 | Betriebssystem nicht unterstützt (Windows ist geplant, nicht ausgeliefert). |
| `enrollment-token-invalid` | 401 | Das Enrollment-Token ist unbekannt, abgelaufen, widerrufen oder verwendet. |
| `agent-unauthorized` | 401 | Falsche oder fehlende Zugangsdaten des Agenten. |
| `rate-limited` | 429 | Zu viele Anfragen oder fehlgeschlagene Anmeldungen einer Adresse. |
| `endpoint-quota-exceeded` | 403 an den Agenten (restic-Endpunkt) | Der Upload passt nicht mehr ins Speicherbudget des Endpunkts oder des Mandanten. |

Ein Speicherwechsel, der Endpunkte betrifft, antwortet mit `storage-active-endpoints` und
`storage-previous-holds-endpoint-repositories` (siehe "Offene Punkte und später").

## Übersicht (Status und Statistik)

- Übersicht, Reiter Status: Das Admin-Widget `endpoints` ("Server und Clients") zeigt die geschützten Rechner
  (Endpunkte, die nicht widerrufen sind), aufgeteilt in Server und Clients und bewertet wie die Seite
  der Recovery Readiness (grün, gelb, rot, ungeprüft, keine Sicherung). Dazu: wie viele nicht als
  wiederherstellbar bewiesen sind (rot, ungeprüft, keine Sicherung), wie viele eine fehlgeschlagene
  letzte Sicherung haben (ein nur unterbrochener Lauf ist kein Fehlschlag), wie viele Aufmerksamkeit
  brauchen und die jüngste gute Sicherung. Die Karte erscheint nur, wenn der Mandant mindestens einen
  geschützten Rechner hat. Dieselben Rechner zählen auch in den Summen des Readiness-Widgets.
- Übersicht, Reiter Statistik: Endpunkte zählen als geschützte Objekte. Die Readiness-Reihe, die Kennzahlen
  "verifizierter Anteil" und "geschützte Objekte" und die Mandantenzeilen des Provider-Bereichs bewerten
  jeden Endpunkt zu jedem Zeitpunkt mit `endpointReadiness` nach dem, was damals bekannt war (jüngste
  gute Sicherung, Restore-Tests genau dieses Snapshots, jüngste Repository-Prüfung). Ein Endpunkt ist von
  der Anmeldung bis zum Widerruf geschützt.
- Die Reihe der Sicherungen und die Erfolgsquote enthalten beendete Endpunkt-Sicherungen je UTC-Tag
  (erfolgreich und teilweise zählen als erfolgreich, fehlgeschlagen als fehlgeschlagen, nur
  unterbrochene Läufe werden übergangen).
- Nicht enthalten: Speicher, Volumen, Deduplizierung, größte Objekte, Restores, Drosselung und
  Fehlerursachen. Endpunkt-Repositories sind restic-Repositories außerhalb des Chunk-Stores; ihre Größe
  zeigt die Detailseite des Rechners.

## Verteilung

Das Image enthält für jedes Ziel (linux/amd64, linux/arm64, darwin/amd64, darwin/arm64)
`restow-agent`, `restic` und `THIRD_PARTY_NOTICES.txt` unter `/srv/agent/<version>/<os>-<arch>/`
mit einer `SHA256SUMS` daneben (auch eine Liste über alle Ziele mit `<os>-<arch>/<datei>`-Zeilen wird verstanden).
Die Installationsskripte liegen in `/srv/agent/install/` (Entwicklung: `agent/install/` im
Repository). Der Server ersetzt die Platzhalter `__RESTOW_URL__` und `__RESTOW_VERSION__` und
schreibt nur eine geprüfte Origin (Schema, Host, Port) in das Skript, nie ungeprüfte Eingaben.
Statische Dateien werden nur für bekannte Versionen, Ziele und Dateinamen ausgeliefert (kein
Pfad kann ausbrechen). Ein Entwicklungsaufbau (`agent/build.sh`) legt die Ziele ohne Versionsordner
unter `agent/dist/<os>-<arch>/` ab, mit `agent/dist/VERSION` und einer `SHA256SUMS`; der Server
versteht beide Layouts und nimmt ohne `RESTOW_AGENT_DIR` und ohne `/srv/agent` den Ordner
`agent/dist` des Repositorys. Es gibt kein `windows.ps1` und keine Windows-Ziele in 0.1.0.

Agent-Version = Restow-Version; restic gepinnt (0.19.1), im Image per SHA-256
geprüft (BSD-2-Clause). `THIRD_PARTY_NOTICES.txt` je Ziel baut `agent/build.sh` aus
`agent/THIRD_PARTY_NOTICES.txt`: die Lizenz des Agenten (Apache-2.0 mit der Copyright-Zeile aus
NOTICE), die von Go, restic und den 79 Go-Modulen, die in restic einkompiliert sind (Texte in
`licenses/restic-deps/`, gelistet in THIRD_PARTY_NOTICES.md; golang-lru unter MPL-2.0 mit
Hinweis auf seinen Quellcode). Die Datei steht in der signierten `SHA256SUMS` und liegt dem
GitHub-Release als `restow-agent-THIRD_PARTY_NOTICES.txt` bei. Der Agent aktualisiert sich über
`GET /agent/v1/update` (signierte Prüfsummen laden und prüfen, Download, SHA-256, Ersetzen der
Lizenzhinweise vor restic und dem Agenten, Neustart des Dienstes).

### Signierte Releases

Jedes Agent-Release ist vom Maintainer mit einem Ed25519-Schlüssel signiert, der seinen
Rechner nie verlässt (nicht im Repository, nicht in CI). Format: OpenSSH-Signatur
(`ssh-keygen -Y sign`, Namensraum `restow-agent-release`) über die `SHA256SUMS` des Releases,
die jede Agent- und restic-Binärdatei aller Ziele auflistet. Begründung der Wahl: Das
mitgelieferte `ssh-keygen` jedes unterstützten macOS und aktueller Linux-Distributionen
erzeugt und prüft das Format ohne Zusatzwerkzeug (LibreSSL auf macOS kann kein Ed25519,
minisign/signify sind nirgends vorinstalliert); OpenSSL 3 prüft dieselbe Signatur unter
Linux; der Agent prüft sie mit der Go-Standardbibliothek.

- Der öffentliche Schlüssel liegt in `agent/release-signing.pub`, ist in den Agenten
  einkompiliert (`go:embed`) und wird vom Server aus `/srv/agent/install/release-signing.pub`
  in die Installationsskripte geschrieben (`__RESTOW_RELEASE_KEY__`). Solange die Datei der
  Platzhalter ist, schlägt jeder Release-Build fehl (`build.sh` lehnt jede Version außer
  Entwicklungs-Builds `*-dev` ab), Agenten installieren keine Updates, und die Skripte installieren nur
  Entwicklungs-Builds mit `RESTOW_ALLOW_UNSIGNED_DEV=1` (für Release-Versionen wirkungslos).
- Der Server liefert `/install/agent/<version>/SHA256SUMS` und `SHA256SUMS.sig` Byte für Byte
  aus und bietet nur signierte Releases als Update an.
- Der Agent prüft vor jedem Update zuerst die Signatur, dann jede Datei gegen ihren signierten
  Hash, macht sie erst danach ausführbar, führt `version` erst danach aus und benennt sie dann
  um (Zwischendatei mit `O_CREATE|O_EXCL|O_NOFOLLOW` und Zufallsnamen im root-eigenen Ordner).
- Die Installationsskripte prüfen mit `ssh-keygen -Y verify` (OpenSSH 8.1+) oder OpenSSL 3;
  ohne beides (RHEL 8, Amazon Linux 2) lehnen sie ab und nennen den Weg über
  `RESTOW_SHA256SUMS_SHA256` (Signatur auf einem anderen Rechner prüfen, Hash vorgeben).
- Ablauf im Release-Workflow: Agent bauen, `agent-SHA256SUMS` an ein **Entwurfs**-Release
  hängen, in der Umgebung `agent-release-signing` warten; der Maintainer signiert mit
  `scripts/release/sign-agent.sh <tag>` (lädt per `gh`, signiert, prüft gegen den
  eingecheckten Schlüssel, lädt hoch, setzt den Lauf fort); der Workflow prüft die Signatur,
  baut die Images mit dem signierten Agenten (das Dockerfile prüft erneut), fährt den
  Release-Smoke, prüft ein drittes Mal und veröffentlicht erst dann den Entwurf.
- Grenze: Die Erstinstallation vertraut dem Skript, das die Instanz ausliefert (wie jedes
  `curl | sh`). Die Signaturen schützen die Selbstaktualisierung und die Binärdateien gegen
  eine kompromittierte Instanz.

Ein Mandant kann automatische Agent-Updates pausieren (`GET/PUT /api/v1/endpoints/agent-updates`,
Oberfläche: Mandantenseite › Agenten; Audit `endpoint.updates.paused`/`resumed`). Der Schalter ist eine
Einstellung des Mandanten (`tenants.agent_updates_paused`, Migration 0021): Er lässt sich setzen, bevor
der erste Rechner existiert, und gilt für später angemeldete Rechner mit. Bis 0.1.x lag er in
`endpoints.settings.autoUpdatePaused` jedes Endpunkts; die Migration übernimmt ihn für Mandanten, deren
Rechner alle pausiert waren. Ein Rechner kann weiterhin eine eigene Pause tragen (Überschreibung): Der
Agent bekommt kein Update, solange die Mandanten-Einstellung oder die eigene Pause gilt. Die Überschreibungen
zeigt die Oberfläche einzeln (`DELETE /api/v1/endpoints/agent-updates/machines/:id` hebt eine auf,
`PUT` mit `resumeMachines` alle) und ein neu angemeldeter Rechner übernimmt keine mehr.

## Datenmodell

Alle Tabellen tragen `tenant_id` und haben Row Level Security wie die übrigen
Mandantentabellen (`packages/db/sql/rls.sql`).

- `endpoints`: Hostname, Anzeigename, OS, Architektur, Profil, Agent- und OS-Version, Status
  `active`/`revoked`, `secret_hash`, `repository_secret_id` (Verweis auf `secrets`), `config` und
  `config_version`, `settings` (nur Server: Aufbewahrung, Stille-Schwellen, `autoUpdatePaused`,
  und unter `agent` die vom Agenten gemeldete Hook-Regel samt Skriptnamen), Zustand des Agenten
  (`agent_state`, `next_run_at`, `agent_config_version`), `last_seen_at`, `last_backup_at`,
  `last_success_at`, `last_snapshot_id`, `last_retention_at`, `last_check_at`,
  `last_restore_test_at`, `stale_alerted_at`, `revoked_at`. Mit Migration 0019 dazu
  `repository_bytes` und `repository_measured_at` (Größe im Speicher), `quota_refused_at`,
  `quota_alert_level` und `quota_alerted_at` (Speicherbudget), `maintenance_locked_count`,
  `maintenance_locked_since` und `locked_alerted_at` (gesperrte Wartung); `settings.quotaGib`.
- Jobs (Migration 0023, `docs/ARCHITECTURE.md`, "Jobs"): `backup_jobs` und `backup_job_members` sind
  Mandantentabellen. Ein Rechner ist in höchstens einem Job (`backup_job_members.endpoint_id` ist
  eindeutig); die Wirk-Konfiguration steht weiter in `endpoints.config`, nur ihr Schreiber hat gewechselt.
- `endpoint_enrollment_tokens`: `token_hash` (eindeutig), Profil, Bezeichnung, `expires_at`,
  `used_at`, `used_by_endpoint_id`, `revoked_at`, `created_by`.
- `endpoint_runs`: Art, Status, Zeiten, `snapshot_id`, `stats`, `errors`, `log_tail`,
  `progress`, `failure` (die Erklärung oben), `task_id`, `alerted_at`.
- `endpoint_tasks`: Art, `params`, Status, `created_by`, Zeiten, `expires_at`, `error_message`.
  Ein erneut angebotener Restore-Test trägt `params.retry` und `params.notBefore` (keine eigene
  Spalte).
- `endpoint_samples`: Lauf, Snapshot, Pfad, SHA-256, Größe.
- `endpoint_repository_locks`: die Sperrdateien, die ein Agent geschrieben hat
  (Name je Endpunkt eindeutig); nur diese darf er löschen.
- `endpoint_snapshot_flags`: verdächtige Snapshots, die die Aufbewahrung gefunden hat
  (`reasons`: `unrecorded`, `future_time`; Zeit im Snapshot und Speicherzeit der Datei), mit
  `alerted_at`, damit jeder einmal gemeldet wird.
- `endpoint_downloads`: vorbereiteter ZIP-Download (Snapshot, geprüfte Auswahl als `selection`
  `[{ path, type }]`, `created_by`, `expires_at`, `started_at`); zehn Minuten gültig, einmal startbar,
  vom Monitor eine Stunde nach Ablauf entfernt.
- `endpoint_reports` (zusätzlich zur ursprünglichen Liste): Ergebnisse der Serverarbeit als Fakten
  mit Zeitpunkt: Restore-Test (Herkunft `server` oder `agent`, Snapshot, grün/rot, Details),
  Repository-Prüfung, Retention. Sie spielen die Rolle von `verify_reports`, ohne die
  Postfach-Tabellen zu berühren (deren Fremdschlüssel verlangen ein geschütztes Objekt und einen
  Restow-Snapshot).

## Sicherheitsmodell und bekannte Grenzen

- **Transport.** Alles über HTTPS. In 0.1.0 pro Agent ein Secret über HTTPS; **mTLS je Agent
  ist für ein späteres Release geplant** und hier ausdrücklich eine bekannte Grenze. Wer das
  Secret eines Agenten kennt, kann als dieser Endpunkt Daten hinzufügen und lesen, aber nichts
  löschen oder überschreiben.
- **Kompromittierter Endpunkt.** Er hat Passwort und Zugangsdaten seines eigenen Repositorys
  (er muss ja schreiben und für den Restore lesen). Er kann keine Sicherung löschen, überschreiben
  oder eine neue Config schreiben; die Sperre erzwingt der Server, nicht restic. Er kann
  Müll hinzufügen (der Restore-Test und die Prüfung bewerten das; Retention räumt auf) und sein
  eigenes Repository lesen, also auch entschlüsseln. Er hat keinen Zugriff auf andere
  Endpunkte oder das Speicherziel. Er kann außerdem nicht erreichen, dass die Aufbewahrung des
  Servers echte Sicherungen löscht (der Server entscheidet nach seinen eigenen Aufzeichnungen,
  siehe "Aufbewahrung"), keine Sperre des Servers lösen und die Wartung nicht unbemerkt dauerhaft
  sperren (siehe "Sperren"), und er füllt das Speicherziel höchstens bis zu seinem Budget (siehe
  "Speicherbudget").
- **Bekannte Grenze: Metadaten, die der Agent hinzufügt.** `restic prune` vertraut den Index-Dateien
  des Repositorys, und der Agent darf neue hinzufügen. Ein kompromittierter Agent könnte Index-Einträge
  oder Snapshot-Dateien anlegen, die restic nicht lesen kann; dann scheitern Aufbewahrung oder Prüfung,
  und die wöchentliche Prüfung meldet das Repository als beschädigt (`scrub.corrupt`). Gelöscht wird
  dadurch nichts, was der Server nicht gewählt hat; ein Aufbewahrungslauf, der scheitert, schreibt einen
  Bericht mit der Fehlermeldung.
- **Hooks** (`pre`/`post`) laufen als root auf dem Rechner, deshalb **entscheidet der Rechner**:
  Die Hook-Regel steht in `state.json` und kann nur root auf dem Rechner ändern
  (`restow-agent hooks off|scripts|any`, `enroll --hooks`, Installer `--hooks=`). `off`
  (Standard): Server-Hooks laufen nie, ein eingestellter Hook wird übersprungen, die Sicherung
  ist `partial` mit `hooks_not_allowed`. `scripts`: nur benannte Skripte aus
  `/etc/restow-agent/hooks.d` (root-eigen, nicht für andere schreibbar, ohne Shell, ohne
  Argumente). `any`: beliebige Befehle über `/bin/sh -c`. Der Agent
  meldet die Regel mit Enrollment und Heartbeat (`endpoints.settings.agent`, keine Migration);
  der Server lehnt Hooks ab, die der Rechner nicht ausführen würde (siehe Problem-Typen), und
  die Oberfläche zeigt die Regel. Setzen dürfen Hooks weiterhin nur `tenant_admin` und Provider
  ab "Administrator". Das Audit-Log enthält die Änderung mit einem Fingerabdruck des
  Hook-Textes, nicht den Text (ein Hook enthält mitunter Zugangsdaten). Die Detailansicht gibt
  den Hook-Text nur an Betrachter mit Konfigurationsrecht heraus, allen anderen (Provider
  "Nur lesen" und "Techniker") nur "gesetzt" und den Fingerabdruck.
- **Step-up für Hooks und Repository-Passwort.** Wer einen Hook setzt oder ändert,
  braucht zusätzlich eine Anmeldung aus den letzten zehn Minuten mit Passkey, Passwort mit TOTP
  oder Entra (`apps/api/src/lib/recent-sign-in.ts`, dieselbe Prüfung wie für Update-Quelle und
  Updates, docs/UPDATING.md). Eine ältere Sitzung bekommt 403 `recent-sign-in-required`; die
  Oberfläche fragt "Bestätigen Sie, dass Sie es sind" (mit Passkey direkt im Dialog, sonst über
  eine neue Anmeldung) und schickt die Änderung danach erneut. Die Prüfung läuft in der
  Transaktion der Änderung, nachdem die Hook-Regel des Rechners die neuen Hooks angenommen hat;
  eine abgelehnte Änderung bleibt ganz ungespeichert, auch was mit ihr geschickt wurde. Das
  Entfernen aller Hooks braucht keinen Step-up (der Rechner führt danach weniger aus, nie mehr).
  Denselben Step-up verlangt das Anzeigen des Repository-Passworts (siehe "Restore ohne Restow").
  Er ersetzt die Zustimmung des Rechners nicht, er kommt dazu: Mit der Regel `any` kann weiterhin
  jeder mit Konfigurationsrecht und frischer Anmeldung Befehle als root ausführen lassen.
- **Installationsort.** Agent und restic liegen in einem Ordner, den nur root ändern kann
  (`/opt/restow-agent/bin`, macOS `/Library/Application Support/Restow/bin`); Installer und
  Agent prüfen jeden Ordner des Pfades (Eigentümer root, nicht gruppen- oder weltschreibbar)
  und verweigern sonst die Arbeit. restic wird nur aus diesem Ordner genommen. Die Lizenzhinweise
  (`THIRD_PARTY_NOTICES.txt`) liegen im selben Präfix neben `bin`, lesbar für alle. Ein Agent, der aus
  `/usr/local/bin` startet (dem Ort der Vorabversionen), installiert sein signiertes Release an
  den neuen Ort, schreibt Unit/Plist um und lässt sich vom Dienstverwalter neu starten (launchd
  über einen Einmal-Job `com.restowbackup.agent.reload`); der neue Prozess entfernt die alten
  Dateien.
- **Repository-Host.** Der Agent akzeptiert nur ein Repository auf dem Host der Instanz (Schema
  und Hostname), auch wenn die Enrollment-Antwort etwas anderes sagt (gefälschte
  `X-Forwarded-Host` ohne konfigurierte öffentliche URL). Der Server nimmt weiterhin zuerst die
  konfigurierte öffentliche URL.
- **Dienst-Härtung (systemd).** `NoNewPrivileges`, `ProtectKernelTunables`, `ProtectKernelLogs`,
  `ProtectControlGroups`, `ProtectHostname`, kein Laden von Kernelmodulen
  (`CapabilityBoundingSet=~CAP_SYS_MODULE`, `SystemCallFilter=~@module`), `RestrictNamespaces`,
  `RestrictRealtime`, `LockPersonality`, `SystemCallArchitectures=native`, `UMask=0077`; launchd
  `Umask` 077. Bewusst nicht: `ProtectSystem`, `ProtectHome`, `PrivateTmp` (Sicherung beliebiger
  Pfade, Restore überallhin), `ProtectKernelModules` (versteckt `/usr/lib/modules`),
  `PrivateDevices`, `ProtectClock` (Gerätezugriff für Hooks und Restore von Gerätedateien).
  `agent/scripts/test-systemd.sh` beweist Backup und Restore unter genau diesen Einstellungen.
- **Wer darf was.** Alle Endpunkt-Routen verlangen `tenant_admin` (oder Provider). Provider-Rollen:
  Lesen der Liste und der Läufe ab "Nur lesen", Restore/Browsen/Download ab "Techniker",
  Token, Konfiguration, Widerruf, Passwort ab "Administrator".
- **Secrets.** Agent-Secret und Token nur als SHA-256, Repository-Passwort mit dem
  Mandantenschlüssel verschlüsselt, keins davon in Logs oder Audit-Details. Fehlermeldungen von
  restic laufen durch eine Schwärzung.
- **Wiederherstellung von Sicherungen des Endpunkts setzt das Repository-Passwort voraus.**
  Es liegt nur auf dem Server (und dem Endpunkt selbst).
- **Konsistenz.** Linux/macOS: optionale Pre-/Post-Hooks (z. B. `pg_dump`). Snapshots von
  LVM/ZFS/btrfs sind ein späterer Schritt. Windows würde VSS nutzen (`--use-fs-snapshot`), wenn
  es kommt.

## Offene Punkte und später

- Windows (Dienst, VSS, DPAPI, PowerShell-Skript, Ziele im Image).
- mTLS je Agent.
- LVM/ZFS/btrfs-Snapshots als Konsistenzquelle.
- Löschen eines Endpunkts samt Repository (heute: Widerruf, Daten bleiben bis zur Aufbewahrung
  bzw. für immer, wenn kein Backup mehr kommt).
- Die Speicherziel-Migration (docs/STORAGE.md) kopiert nur `tenants/<tid>/...`, nicht `endpoints/`.
  **Bekannte Grenze, umgesetzt als Ablehnung, nicht als Migration:** Solange ein Endpunkt des Mandanten
  aktiv ist (der Agent schreibt, Retention und Prüfung laufen), verweigert der Server jeden Wechsel des
  Primärziels (Ersetzen mit "verschieben" oder "behalten" und das Hochstufen einer Kopie) mit 409
  `storage-active-endpoints` und einer klaren Meldung. Ein Endpunkt-Repository zählt außerdem als Daten
  des Primärziels: Dessen Ort lässt sich nicht ändern, und es lässt sich nicht entfernen, solange es
  Repositories hält. Vorgehen für einen Wechsel: die Rechner widerrufen oder deinstallieren
  (`POST .../uninstall`), das Primärziel wechseln, die Rechner neu anmelden (neue Endpunkte mit neuem
  Repository im neuen Primärziel). Die Repositories der widerrufenen Rechner bleiben auf dem alten Ziel
  (es wird zu `previous` oder zur Kopie) und vom Server lesend auffindbar (Browsen, Download); das alte Ziel
  lässt sich deshalb nicht entfernen, solange es allein ein Endpunkt-Repository hält
  (`storage-previous-holds-endpoint-repositories`). Retention läuft für widerrufene Rechner nicht mehr.
- Die Löschung eines Mandanten (`DELETE /api/v1/tenants/:id`) markiert ihn nur als `deleting` und
  entzieht die Anmeldungen; einen Bereinigungsjob, der Daten entfernt, gibt es für keinen Speicherpfad
  (`tenants/<tid>/...` ebenso wenig wie `endpoints/`). Die Agenten eines solchen Mandanten werden
  abgewiesen (403), und die Endpunkt-Jobs lassen ihn aus; das Repository bleibt im Speicherziel liegen,
  bis der Betreiber es dort löscht.
- Wiederherstellung großer Ordner als ZIP über sehr langsame Verbindungen: Der Server hält
  die Verbindung offen, solange restic liefert; Proxys mit kurzem Leerlauf-Timeout können sie
  kappen.

## Tests

- Unit (`packages/core/src/endpoints/*.test.ts`, `apps/api/src/features/endpoints/endpoints.test.ts`):
  Token-Hashing, Ablauf und Einmaligkeit; Konfigurationsstandards je System und Profil;
  die Autorisierungsmatrix (append-only) in allen Kombinationen; das REST-Protokoll gegen einen
  Speicher im Arbeitsspeicher (Hash-Prüfung, Überschreiben, Range, Limits, Listen v1/v2);
  der tar-Leser; Readiness-Regel; Stille-Regel; Vergleich der Stichproben; ZIP-Namen; Skript-
  Platzhalter und Origin-Prüfung; Schemas; das Urteil über den Restore-Test des Agenten
  (`restore-test.test.ts`: jeder Beleg rot, jeder Fehler ohne Beweiskraft unvollständig, passende
  Hashes eines neuen und eines älteren Agenten grün, der von der Aufbewahrung entfernte Snapshot;
  dazu `restic restore` mit dem echten restic gegen beschädigte und fehlende Daten) und die
  Wiederholungen (`restore-test-retry.test.ts`).
- Postgres (`endpoints.pg.test.ts` in api, worker, scheduler): Enrollment (Token einmalig,
  abgelaufen, widerrufen, Windows, gleichzeitig), Agent-Authentifizierung und Drosselung,
  Heartbeat und Aufgaben, Läufe, Stichproben und Webhook, RLS-Isolation zwischen Mandanten für
  alle Tabellen, Readiness, Jobs (Retention, Prüfung mit beschädigtem Pack, Restore-Test) und die
  Alarme des Monitors (einmalig, je Mandant), die Planung des Schedulers; der Restore-Test des
  Agenten (rot bei abweichendem Hash und fehlenden Daten, grün von neuem und älterem Agenten,
  unvollständig ohne Bericht, Bewertung, Webhook und ohne Änderung von `last_restore_test_at`,
  die erneute Aufgabe mit ihrer Wartezeit) und der vom Monitor geschlossene Test, der erneut
  angeboten wird. Der Agent selbst: Integrationstest mit restic 0.19.1 und rest-server, in dem ein
  entferntes Daten-Pack für jede Datei mit restics eigenen Worten gemeldet wird.
- Ende zu Ende (`endpoints.restic.pg.test.ts`): der echte restic-Prozess gegen den REST-Endpunkt
  der API über eine echte Loopback-Verbindung: Init durch den Server, Backup mit Agent-Zugang
  (auch inkrementell), `forget`/`prune`/Löschen/Überschreiben/neue Config mit Agent-Zugang
  verweigert und Bytes unverändert, `forget --prune` und `check` mit dem Wartungszugang,
  Restore in einen neuen Ordner Byte für Byte gleich, Restore-Test grün nur bei passenden Hashes,
  rot bei einem beschädigten Pack, Browsen in Seiten und ZIP-Download in zwei Schritten (einmalig,
  nur für den Admin, der ihn vorbereitet hat, abgelaufen, Audit vor dem ersten Byte).
- Gegen echtes restic ohne Datenbank (`packages/core/src/endpoints/restic-cli.test.ts`): Ordnerseiten
  ohne Lücke und Überlappung, Ende einer Seite genau am Ende des Ordners, Nachschlagen vieler Pfade mit
  wenigen restic-Läufen, Auswahl in der gefragten Reihenfolge. Die Routen des Downloads
  (`downloads.routes.test.ts`): Body mit Pfaden, Größengrenze, Start mit Mandant im Query, HEAD.
- Speicherwechsel und Endpunkte (`apps/api/src/features/storage/service.endpoints.pg.test.ts`).
- Die Aufbewahrung nach den Aufzeichnungen des Servers (Einheit: Regeln, ISO-Wochen,
  Zeitzone, gekürzte IDs, kopierter Speicherordner, der Angriff mit Snapshots in der Zukunft; Worker
  gegen echtes restic: gefälschte Snapshots löschen nichts, nicht gemeldete werden nie gelöscht,
  Meldung einmal), das Aufräumen der Sperren und der Zähler gesperrter Läufe, die Sperren-Liste und
  das Speicherbudget der API (auch mit echtem restic: der Agent löst die Sperre des Servers auch mit
  `unlock --remove-all` nicht, ein Backup über dem Budget scheitert sofort, ein Restore funktioniert
  weiter), das versiegelte Passwort (Einheit; Ende zu Ende: `restow-restore endpoint-password` und
  danach reines restic stellen Byte für Byte wieder her), die Schwärzung von Fehlern und Log-Ende,
  ZIP-Namen mit Backslash und Laufwerk, Migration 0019 auf einer Datenbank mit Bestand.
- Diese Suiten brauchen das restic-Binary (`RESTIC_BINARY` oder im `PATH`, gepinnte Version).
- Agent (`agent/`, Go, ohne Server): Signaturprüfung gegen Fixtures des echten `ssh-keygen`,
  Vertrauensprüfung von Pfaden, signierte Selbstaktualisierung und Umzug, Hook-Regel, Restore-
  Ziele, systemd-Unit; `scripts/test-install.sh` (Installer im Container mit Wegwerf-Schlüssel:
  Signatur über ssh-keygen und OpenSSL, Manipulation, Pin, Umzug aus `/usr/local`, unsichere Ordner,
  Token-Datei) und `scripts/test-systemd.sh` (echtes systemd: Integrationstests unter der
  Härtung, Selbstaktualisierung eines älteren Agenten mit Umzug nach `/opt/restow-agent`).
- Postgres (`endpoints.pg.test.ts`): Hook-Regel aus Heartbeat und Enrollment, Ablehnung und
  Annahme von Hooks, verdeckte Hook-Texte, Pausieren der Agent-Updates je Mandant (auch für
  später angemeldete Rechner; `agent-updates.pg.test.ts` ohne restic), signierte Prüfsummen und Schlüssel in den Skripten.
