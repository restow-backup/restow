# Aussagenregister

Was keinen Test hat, ist nur eine Behauptung. Dieses Register führt jede prüfbare Aussage,
die Restow über sein eigenes Verhalten macht, mit der Stelle, an der sie steht, und dem Test,
der sie in der Pipeline belegt. Der Wächter `scripts/ci/check-claims.mjs` (Teil von
`pnpm lint`) schlägt fehl, wenn eine Aussage keinen Test hat, wenn ein genannter Test nicht
existiert oder die Kennung nicht trägt, und wenn ein Test eine Kennung trägt, die das Register
nicht kennt.

Anlass war der Bericht eines Teams, dessen Sicherungen sauber hochgeladen wurden und sich nicht
wiederherstellen ließen: Eine Lebenszyklusregel des Speichers löschte Teile unbemerkt, 14 Monate
lang prüfte niemand eine Wiederherstellung, und rotierte Zugangsdaten fielen erst im Ernstfall
auf. Der Bereich FAULT stellt genau diese Fehler nach.

## Umfang

Aufgenommen ist, was für das Versprechen "was grün ist, lässt sich wiederherstellen" und für
die Sicherheit von Daten und Updates zählt: die Bewertungen und was sie grün, gelb oder rot
macht, die Prüfungen, die Wiederherstellung je Quelle, Aufbewahrung und Löschsperren,
Verschlüsselung und Schlüssel, Updates, Lizenz und Editionen, die Alarme, von denen ein
Versprechen abhängt, und die Kopien der Repositories. Reine Beschreibungen ohne prüfbares
Ergebnis fehlen mit Absicht.

Die Aussagen stammen aus diesem Repository: `README.md`, `SECURITY.md`, `docs/*.md` und die
Texte der Oberfläche unter `packages/i18n/resources/en`. Die öffentliche Website und die
Dokumentations-Website liegen in keinem Repository, das hier lesbar ist. Jede Aussage trägt
deshalb das Feld "Öffentliche Seite" mit dem Wert "nicht abgeglichen", bis jemand die Seiten
gegen das Register gelesen hat.

## Aufbau eines Eintrags

Jeder Eintrag steht unter einer Überschrift `### BEREICH-NNN`. Die Kennung ist stabil: Eine
gestrichene Aussage gibt ihre Nummer nicht weiter.

- **Aussage**: der Satz, an dem ein Kunde das Produkt misst, in einem Satz oder zweien.
- **Fundstelle**: wo er im Repository steht (Datei und Abschnitt, bei Oberflächentexten der
  Schlüssel).
- **Öffentliche Seite**: die Stelle auf der Website oder in der Dokumentation, sobald sie
  abgeglichen ist.
- **Tests**: die Dateien, die die Kennung tragen, durch Komma getrennt; `keine` nur bei
  "nur behauptet".
- **Belegt gegen**: wogegen der Test läuft, ehrlich benannt (siehe unten).
- **Stand**: `belegt`, `Abweichung` oder `nur behauptet`.
- **Erwartung** und **Abweichung** (Pflicht bei `Abweichung`): was der Test verlangt, und
  was das Produkt stattdessen tut, mit Datei.
- **Grund** (Pflicht bei `nur behauptet`): warum es keinen Test gibt.
- **Hinweis** (frei): Grenzen der Aussage und Zahlen aus dem Code, die in den Texten fehlen.

## Wie ein Test eine Aussage belegt

Der Test trägt die Kennung, und der Wächter findet sie durch Textsuche:

- Vitest und `node:test` (`*.test.ts`, `*.test.mjs`): `[READY-001]` im Titel des Tests oder
  seines `describe`.
- Go: ein Kommentar `// claim: READY-001` im Kommentarblock direkt über `func Test...`.
- Shell- und PowerShell-Skripte, die Smoke-Checks und die Workflows: ein Kommentar
  `# claim: READY-001` (in JavaScript `// claim: ...`). Mehrere Kennungen stehen durch Komma
  getrennt.

Eine Kennung an einen vorhandenen Test zu hängen ist richtig, wenn der Test das behauptete
Ergebnis wirklich prüft, nicht etwas Benachbartes. Ein Test, der den Codepfad nur durchläuft,
zählt nicht.

## Stand

- `belegt`: Mindestens ein Test mit der Kennung läuft und prüft das Ergebnis.
- `Abweichung`: Das Produkt tut nicht, was die Aussage sagt. Die Aussage wird nicht an den
  Code angepasst und der Test nicht abgeschwächt: Die scheiternde Erwartung bleibt als
  `it.fails` in der Suite. So bleibt die Suite grün, und sie wird rot an dem Tag, an dem das
  Produkt die Aussage erfüllt und der Eintrag noch "Abweichung" sagt. Der Wächter verlangt
  bei diesem Stand einen solchen geparkten Test und zählt ihn bei jedem Lauf als Warnung.
- `nur behauptet`: Es gibt keinen Test, mit Begründung. Der Wächter zählt auch diese bei
  jedem Lauf als Warnung. Ein übersprungener Test (`it.skip`, `it.todo`) mit einer Kennung
  ist ein Fehler: Was nicht läuft, belegt nichts.

## Belegt gegen

- `Logik`: Die Aussage betrifft nur eine Regel des Produkts; kein fremdes System ist beteiligt.
- `Simulator`: Das fremde System (Graph-API, IMAP-Server, S3 mit Object Lock, Proxmox-VE-Knoten,
  Docker-Engine) ist nachgebaut. In Klammern steht, welches echte System nötig wäre.
- `echtes System`: Der Test läuft gegen das echte System, in Klammern welches und in welchem
  Job. PostgreSQL 16 und restic laufen im Job `test` von `ci.yml` echt.
- `beides`: Simulator in `ci.yml`, echtes System im Smoke.
- `nichts`: nur bei "nur behauptet".

Was "echt" heißt, hat Grenzen, die jeder Eintrag nennt. Der Smoke (`scripts/smoke`,
`smoke.yml` jede Nacht auf `main`, `release.yml` vor jedem Release) prüft gegen einen
IMAP-Server, einen S3-Speicher ohne Object Lock und einen SMB-Server in Containern, nicht
gegen einen Anbieter. Microsoft 365 ist in keinem Lauf echt: Smoke-Check 4 braucht fünf
Repository-Secrets eines Entwickler-Mandanten und wurde bisher in jedem Release übersprungen.

## Eine Aussage aufnehmen

1. Eintrag mit der nächsten freien Nummer des Bereichs anlegen.
2. Den Test lesen, der die Aussage belegen soll, oder ihn schreiben, und die Kennung
   anbringen.
3. `node scripts/ci/check-claims.mjs` laufen lassen. Der Wächter nennt jede Lücke mit Datei
   und Zeile und druckt die Zahlen je Bereich.

## Wiederherstellbarkeit: was grün, gelb und rot bedeutet (READY)

### READY-001
- Aussage: Grün gibt es nur nach einer bestandenen Wiederherstellungsprüfung, nie für eine Sicherung, die nur fertig ist. Eine Sicherung, die nach der letzten Prüfung entstand, gilt als nicht geprüft, was immer eine ältere Sicherung erreicht hat.
- Fundstelle: README.md (Einleitung: „A backup only counts as restorable once it has been read back“), packages/i18n/resources/en/verify.json (`subtitle`, `unverified.description`, `snapshot.hint.unverified`)
- Öffentliche Seite: nicht abgeglichen
- Tests: apps/api/src/features/verify/verification-state.test.ts, apps/api/src/features/verify/verification.pg.test.ts, apps/web/src/green-is-proof.test.ts
- Belegt gegen: echtes System (PostgreSQL 16, Job test in ci.yml; die Bewertungsregel zusätzlich als Einheitentest)
- Stand: belegt
- Hinweis: In der Oberfläche ist Grün außerdem die Farbe einer abgeschlossenen Wiederherstellung und einer intakten Speicherprüfung (apps/web/src/green-is-proof.test.ts führt die Liste). Eine nur abgeschlossene Sicherung ist dort nie grün.

### READY-002
- Aussage: In der Bewertung des Mandanten zählt eine Sicherung ohne bestandene Wiederherstellungsprüfung wie eine fehlgeschlagene: Der Mandant ist rot, sobald ein Objekt nicht geprüft ist oder keine Sicherung hat.
- Fundstelle: packages/i18n/resources/en/verify.json (`overall.red.description`)
- Öffentliche Seite: nicht abgeglichen
- Tests: apps/api/src/features/verify/summary.test.ts, apps/api/src/features/verify/verification.pg.test.ts
- Belegt gegen: echtes System (PostgreSQL 16, Job test in ci.yml; die Bewertungsregel zusätzlich als Einheitentest)
- Stand: belegt

### READY-003
- Aussage: Grün setzt eine vollständige Sicherung voraus: Konnte der Lauf Elemente nicht sichern, ist die Bewertung gelb, und rot für Elemente, die in den letzten drei Läufen in Folge fehlschlugen, wie gut die Stichprobe auch zurückkommt.
- Fundstelle: docs/TESTING.md (Abschnitt „Restore-Beweis in Produktion“), packages/i18n/resources/en/verify.json (`reason.backup_incomplete`, `reason.backup_incomplete_persistent`)
- Öffentliche Seite: nicht abgeglichen
- Tests: packages/core/src/verify/readiness.test.ts, apps/worker/src/handlers/verify.test.ts
- Belegt gegen: echtes System (PostgreSQL 16, Job test in ci.yml; die Bewertungsregel zusätzlich als Einheitentest)
- Stand: belegt

### READY-004
- Aussage: Das Alter der neuesten Sicherung wird beim Anzeigen bewertet, nicht nur bei der Prüfung: ab 48 Stunden gelb, ab sieben Tagen rot, in der Bereitschaftsübersicht, der Mandantenbewertung, der Integrations-API, dem Verzeichnis und den Mitgliedern eines Sicherungsauftrags.
- Fundstelle: docs/TESTING.md (Abschnitt „Restore-Beweis in Produktion“), packages/i18n/resources/en/verify.json (`reason.snapshot_stale`, `reason.snapshot_outdated`)
- Öffentliche Seite: nicht abgeglichen
- Tests: packages/core/src/verify/readiness.test.ts, apps/api/src/features/verify/verify.pg.test.ts
- Belegt gegen: echtes System (PostgreSQL 16, Job test in ci.yml; die Bewertungsregel zusätzlich als Einheitentest)
- Stand: belegt

### READY-005
- Aussage: Rot gibt es nur mit Beleg. Eine Prüfung, die der Speicher nicht bedienen konnte, bewertet nichts: kein Bericht, keine Benachrichtigung, der Lauf wird wiederholt, und die letzte Bewertung bleibt stehen.
- Fundstelle: docs/TESTING.md (Abschnitt „Restore-Beweis in Produktion“, „Rot nur mit Beleg“)
- Öffentliche Seite: nicht abgeglichen
- Tests: apps/worker/src/handlers/verify.test.ts, packages/core/src/verify/engine.test.ts
- Belegt gegen: Simulator (Chunk-Speicher im Arbeitsspeicher oder in einem Verzeichnis, Job test in ci.yml; kein Objektspeicher)
- Stand: belegt

### READY-006
- Aussage: Ein altes Grün bleibt nicht beliebig stehen: Endet die Prüfung derselben Sicherung dreimal in Folge ohne Ergebnis, wird sie gelb (`check_incomplete`) und `verify.yellow` wird gemeldet.
- Fundstelle: docs/TESTING.md (Abschnitt „Restore-Beweis in Produktion“), packages/i18n/resources/en/verify.json (`reason.check_incomplete`)
- Öffentliche Seite: nicht abgeglichen
- Tests: apps/worker/src/handlers/verify.test.ts
- Belegt gegen: Simulator (Chunk-Speicher im Arbeitsspeicher oder in einem Verzeichnis, Job test in ci.yml; kein Objektspeicher)
- Stand: belegt

### READY-007
- Aussage: Ein Manifest, das jedes Speicherziel als nicht vorhanden meldet, während die Ziele die übrigen Daten des Mandanten noch halten, macht die Sicherung rot (`manifest_missing`); ein geleertes oder nicht lesbares Ziel beweist nichts und bleibt „nicht abgeschlossen“.
- Fundstelle: docs/TESTING.md (Abschnitt „Restore-Beweis in Produktion“), packages/i18n/resources/en/verify.json (`reason.manifest_missing`)
- Öffentliche Seite: nicht abgeglichen
- Tests: packages/core/src/verify/engine.test.ts, packages/core/src/verify/scrub.test.ts
- Belegt gegen: Simulator (Chunk-Speicher im Arbeitsspeicher oder in einem Verzeichnis, Job test in ci.yml; kein Objektspeicher)
- Stand: belegt

### READY-008
- Aussage: Ein leerer Sicherungsstand (nur Standardordner, 0 Byte) ist gelb „leer“, bis ein Administrator ihn als leer bestätigt. Die Bestätigung endet von selbst, sobald eine spätere Prüfung Inhalt findet.
- Fundstelle: packages/i18n/resources/en/verify.json (`confirmEmpty.description`, `reason.snapshot_empty`), docs/TESTING.md (Abschnitt „Restore-Beweis in Produktion“, „Leere Objekte“)
- Öffentliche Seite: nicht abgeglichen
- Tests: apps/api/src/features/verify/empty.pg.test.ts, apps/worker/src/handlers/verify-empty.pg.test.ts
- Belegt gegen: echtes System (PostgreSQL 16, Job test in ci.yml)
- Stand: belegt

### READY-009
- Aussage: Meldet Microsoft 365 das Objekt vor und nach der Sicherung selbst als leer, ist es ohne Bestätigung neutral leer und löst keine Benachrichtigung aus. Meldet Microsoft 365 Inhalt und die Sicherung hält keinen, ist das Objekt rot, und eine Bestätigung als leer zählt nicht mehr.
- Fundstelle: docs/TESTING.md (Abschnitt „Restore-Beweis in Produktion“), docs/MICROSOFT.md (Abschnitt „Leere Objekte: Nachweis durch Microsoft 365“), packages/i18n/resources/en/verify.json (`table.emptyBySourceHint`, `reason.backup_missing_source_content`)
- Öffentliche Seite: nicht abgeglichen
- Tests: packages/core/src/verify/readiness.test.ts, apps/worker/src/handlers/verify.test.ts, apps/api/src/features/verify/empty.pg.test.ts
- Belegt gegen: Simulator (die Größenangabe von Microsoft 365 stammt aus der simulierten Graph-API; Bewertung gegen PostgreSQL 16 im Job test in ci.yml)
- Stand: belegt

### READY-010
- Aussage: Ein Objekt, das es in der Quelle nicht mehr gibt, wird nur danach bewertet, ob seine behaltene Sicherung wiederherstellbar ist, nicht nach deren Alter, und gilt nie als überfällig.
- Fundstelle: packages/i18n/resources/en/verify.json (`report.removed.description`)
- Öffentliche Seite: nicht abgeglichen
- Tests: apps/api/src/features/verify/verification.pg.test.ts, apps/api/src/features/verify/verify.pg.test.ts, apps/worker/src/handlers/verify.test.ts
- Belegt gegen: echtes System (PostgreSQL 16, Job test in ci.yml)
- Stand: belegt

### READY-011
- Aussage: Ein Objekt in keinem Sicherungsauftrag wird danach bewertet, ob seine neueste Sicherung wiederherstellbar ist, nicht nach deren Alter. Es hält den Mandanten trotzdem von Grün ab.
- Fundstelle: packages/i18n/resources/en/verify.json (`table.noJobHint`, `report.noJob.description`)
- Öffentliche Seite: nicht abgeglichen
- Tests: apps/api/src/features/verify/no-job.pg.test.ts, apps/worker/src/handlers/verify.test.ts
- Belegt gegen: echtes System (PostgreSQL 16, Job test in ci.yml)
- Stand: belegt

### READY-012
- Aussage: Ein frisch geschütztes Objekt hat 24 Stunden Zeit für seine erste Sicherung. Danach gilt es als überfällig („No backup within 24 hours of protection starting“).
- Fundstelle: packages/i18n/resources/en/verify.json (`table.result.noBackupOverdue`)
- Öffentliche Seite: nicht abgeglichen
- Tests: apps/api/src/features/verify/summary.test.ts, apps/api/src/features/verify/first-backup-grace.pg.test.ts
- Belegt gegen: echtes System (PostgreSQL 16, Job test in ci.yml; die Bewertungsregel zusätzlich als Einheitentest)
- Stand: belegt

### READY-013
- Aussage: Findet die Speicherprüfung nach der letzten Wiederherstellungsprüfung beschädigte Daten, ist das Objekt rot, auch wenn die Stichprobe intakt war, und es bleibt rot, bis eine spätere Prüfung den Befund untersucht hat.
- Fundstelle: packages/i18n/resources/en/verify.json (`storage.corrupt`, `report.damagedPacks.description`)
- Öffentliche Seite: nicht abgeglichen
- Tests: apps/api/src/features/verify/verification-state.test.ts, packages/core/src/verify/engine.test.ts, apps/worker/src/handlers/verify.test.ts
- Belegt gegen: Simulator (Chunk-Speicher im Arbeitsspeicher oder in einem Verzeichnis, Job test in ci.yml; kein Objektspeicher)
- Stand: belegt

### READY-014
- Aussage: Bare Metal ist nur grün, wenn Stufe 1 der neuesten Sicherung des ganzen Rechners bestanden ist und eine bestandene Startprobe mit denselben Fingerabdrücken von Layout und Startkette höchstens 8 Tage alt ist. Danach ist der Rechner überfällig, eine Startprobe mit Befund macht ihn rot, und eine geänderte Startkette fällt auf „Layout geprüft“ zurück.
- Fundstelle: docs/BAREMETAL.md (Abschnitte 12.3 und 12.4)
- Öffentliche Seite: nicht abgeglichen
- Tests: packages/core/src/endpoints/baremetal/readiness.test.ts, packages/core/src/endpoints/baremetal/probe.test.ts, apps/api/src/features/endpoints/baremetal.pg.test.ts, apps/api/src/routes/v1/mapping.test.ts, apps/web/src/features/endpoints/components/baremetal-card.test.tsx
- Belegt gegen: echtes System (PostgreSQL 16, Job test in ci.yml; die Bewertungsregel zusätzlich als Einheitentest)
- Stand: belegt

### READY-015
- Aussage: Ohne Wiederherstellungslabor mit KVM wird kein Rechner grün: Er bleibt bei „Layout geprüft“, und die Karte nennt den Grund (kein Labor, kein KVM).
- Fundstelle: docs/BAREMETAL.md (Abschnitte 12.3 und 12.4)
- Öffentliche Seite: nicht abgeglichen
- Tests: packages/core/src/endpoints/baremetal/readiness.test.ts, packages/core/src/endpoints/baremetal/probe.test.ts, apps/api/src/features/endpoints/baremetal.pg.test.ts, apps/web/src/features/endpoints/components/baremetal-card.test.tsx
- Belegt gegen: echtes System (PostgreSQL 16, Job test in ci.yml; die Bewertungsregel zusätzlich als Einheitentest)
- Stand: belegt

## Wiederherstellungsprüfung (VERIFY)

### VERIFY-001
- Aussage: Jede Wiederherstellungsprüfung zieht zufällig 20 Mails und 20 Dateien aus dem letzten Sicherungsstand, dazu je bis zu 5 Kalenderelemente, Kontakte und Website-Objekte (ein Viertel der Hauptmenge).
- Fundstelle: docs/TESTING.md (Abschnitt „Restore-Beweis in Produktion“: „zufällig 20 Mails und 20 Dateien (dazu wenige Kalender- und Kontaktelemente)“), docs/MICROSOFT.md (Abschnitt „SharePoint Online“, „Restore-Prüfung“), packages/core/src/verify/sampling.ts (`DEFAULT_SAMPLE_SIZE`)
- Öffentliche Seite: nicht abgeglichen
- Tests: packages/core/src/verify/sampling.test.ts, packages/core/src/verify/engine.test.ts, apps/worker/src/handlers/verify.test.ts
- Belegt gegen: Logik (Einheitentest ohne Fremdsystem, Job test in ci.yml)
- Stand: belegt
- Hinweis: Die Zahl gilt je Prüfung und Objekt. Ein Postfach mit 50.000 Mails ist nach einer bestandenen Prüfung zu 0,04 Prozent zurückgelesen; die vollständige Prüfung (VERIFY-004) liest alles, läuft aber nur auf Anforderung.

### VERIFY-002
- Aussage: Die Stichprobe wird über den Wiederherstellungspfad zurückgelesen und Byte für Byte mit den aufgezeichneten Prüfsummen verglichen. Abweichende, fehlende oder nicht entschlüsselbare Daten machen die Bewertung rot.
- Fundstelle: README.md (Abschnitt „What it does“, „Restore checks“), packages/i18n/resources/en/verify.json (`subtitle`, `reason.items_mismatched`, `reason.items_unreadable`, `reason.items_missing`)
- Öffentliche Seite: nicht abgeglichen
- Tests: packages/core/src/verify/engine.test.ts, apps/worker/src/handlers/verify.test.ts
- Belegt gegen: Simulator (Chunk-Speicher im Arbeitsspeicher oder in einem Verzeichnis, Job test in ci.yml; kein Objektspeicher)
- Stand: belegt

### VERIFY-003
- Aussage: Zu einer gezogenen Mail im JSON-Format werden alle Anhänge mitgelesen, zu einer gezogenen Datei ihre früheren Versionen (die neueste, die älteste und eine zufällige). Ein fehlerhafter Anhang oder eine fehlerhafte Version zählt gegen die Mail oder die Datei.
- Fundstelle: docs/TESTING.md (Abschnitt „Restore-Beweis in Produktion“)
- Öffentliche Seite: nicht abgeglichen
- Tests: packages/core/src/verify/engine.test.ts, packages/core/src/verify/sampling.test.ts
- Belegt gegen: Simulator (Chunk-Speicher im Arbeitsspeicher oder in einem Verzeichnis, Job test in ci.yml; kein Objektspeicher)
- Stand: belegt

### VERIFY-004
- Aussage: Die vollständige Prüfung (Health Check) liest jedes Objekt mit Inhalt zurück, Anhänge und Versionen eingeschlossen.
- Fundstelle: docs/TESTING.md (Abschnitt „Restore-Beweis in Produktion“), packages/i18n/resources/en/verify.json (`checkKind.health_check`, `report.sample.all`)
- Öffentliche Seite: nicht abgeglichen
- Tests: packages/core/src/verify/engine.test.ts, packages/core/src/verify/sampling.test.ts
- Belegt gegen: Simulator (Chunk-Speicher im Arbeitsspeicher oder in einem Verzeichnis, Job test in ci.yml; kein Objektspeicher)
- Stand: belegt

### VERIFY-005
- Aussage: Die Prüfungen stellen nichts in ein Microsoft-365- oder IMAP-Ziel wieder her: Sie lesen nur zurück.
- Fundstelle: README.md (Abschnitt „What it does“: „The checks do not restore into a Microsoft 365 or IMAP target“), docs/TESTING.md (Abschnitt „Restore-Beweis in Produktion“, letzter Absatz)
- Öffentliche Seite: nicht abgeglichen
- Tests: apps/worker/src/handlers/verify.test.ts
- Belegt gegen: Logik (Einheitentest ohne Fremdsystem, Job test in ci.yml)
- Stand: belegt
- Hinweis: Die Aussage begrenzt zugleich, was Grün beweist: Die Daten kommen aus dem Speicher zurück. Dass das Ziel sie annimmt (Schreibrechte, Kontingent), prüft keine Prüfung, siehe FAULT-011.

### VERIFY-006
- Aussage: Jeder Mandant bekommt eine wöchentliche Wiederherstellungsprüfung (sonntags 03:00), und nach jeder Sicherung wird der neue Sicherungsstand geprüft, solange ein Prüfplan oder der Auftrag eine Prüfung vorsieht.
- Fundstelle: README.md (Einleitung und „Restore checks“: „every week“), docs/TESTING.md („`verify`-Job wöchentlich je geschütztem Objekt“), packages/core/src/schedule/defaults.ts
- Öffentliche Seite: nicht abgeglichen
- Tests: packages/core/src/schedule/recommended.test.ts, apps/scheduler/src/defaults.pg.test.ts, apps/worker/src/handlers/backup.test.ts
- Belegt gegen: echtes System (PostgreSQL 16, Job test in ci.yml; die Bewertungsregel zusätzlich als Einheitentest)
- Stand: belegt
- Hinweis: Ohne Prüfplan und ohne Prüfung im Auftrag läuft keine Prüfung; die Oberfläche sagt das (`footer.scheduleNone`). „Jede Woche“ gilt für die empfohlenen Pläne.

### VERIFY-007
- Aussage: Benachrichtigt wird bei jeder Änderung der Bewertung und zusätzlich bei gleicher Bewertung mit schlimmerer Ursache: rot erst nur „Sicherung zu alt“, dann fehlende oder beschädigte Daten (erneut `verify.red`).
- Fundstelle: docs/TESTING.md (Abschnitt „Restore-Beweis in Produktion“)
- Öffentliche Seite: nicht abgeglichen
- Tests: apps/worker/src/handlers/verify.test.ts
- Belegt gegen: echtes System (PostgreSQL 16, Job test in ci.yml)
- Stand: belegt

### VERIFY-008
- Aussage: Rechner: Der Restore-Test einer Sicherung ist nur grün, wenn jede Stichprobendatei mit ihrem aufgezeichneten SHA-256 aus dem Repository zurückkommt. Eine abweichende Datei macht ihn rot.
- Fundstelle: docs/TESTING.md („Restore-Test grün nur bei passenden Hashes“), docs/AGENT.md (Abschnitt „Aufbewahrung, Prüfung, Restore-Test“)
- Öffentliche Seite: nicht abgeglichen
- Tests: apps/worker/src/endpoints/endpoints.pg.test.ts, agent/internal/core/core_test.go, agent/integration/agent_test.go
- Belegt gegen: echtes System (restic und PostgreSQL 16, Jobs test und agent in ci.yml; der Rechner selbst ist ein Linux-Prozess, kein macOS und kein Windows)
- Stand: belegt

### VERIFY-009
- Aussage: Rechner: Eine Startprobe ist nur grün, wenn die Wiederherstellung des ISO mit einem Prüfbericht ohne Fehler endete und das wiederhergestellte System auf der seriellen Konsole `RESTOW-PROBE-OK` meldet. Rot ist sie nur mit Beleg (ein festes Fehlermuster beim Start, eine fehlgeschlagene Prüfung nach der Wiederherstellung, ein Problem der Sicherung); alles andere (das Labor, ein Zeitlimit ohne Muster) beweist nichts und wird wiederholt. Jedes Ergebnis wird einmal und nur für eine Startprobe angenommen, die das Labor übernommen hat.
- Fundstelle: docs/BAREMETAL.md (Abschnitt 12.3)
- Öffentliche Seite: nicht abgeglichen
- Tests: packages/core/src/endpoints/baremetal/probe.test.ts, apps/worker/src/endpoints/boot-probe.pg.test.ts, scripts/recovery-e2e/run.test.mjs, .github/workflows/ci.yml
- Belegt gegen: echtes System (PostgreSQL 16, Job test in ci.yml; der Start echter Sicherungen im Labor unter QEMU/KVM in den Fällen P1 und P2 des Jobs recovery-e2e in ci.yml, P3 nachts; die Bewertungsregel zusätzlich als Einheitentest)
- Stand: belegt
- Hinweis: recovery-e2e läuft nur, wenn sich ISO-, Agent- oder Laborpfade ändern und das ISO gebaut wird (das Paketverzeichnis des ISO hat Einträge); bis dahin belegen P1 und P2 nichts.

## Speicherprüfung (SCRUB)

### SCRUB-001
- Aussage: Die Speicherprüfung liest wöchentlich eine Stichprobe der Packs (samstags 04:00) und monatlich alle Packs (am 1. um 05:00). Ein Plan, der monatlich oder seltener läuft, prüft alles, ein häufigerer eine Stichprobe.
- Fundstelle: docs/TESTING.md („Scrub: Pack-Integrität (SHA-256), Stichprobe wöchentlich, alles monatlich“), packages/i18n/resources/en/verify.json (`storage.description`)
- Öffentliche Seite: nicht abgeglichen
- Tests: packages/core/src/schedule/recommended.test.ts, packages/core/src/schedule/cadence.test.ts, packages/core/src/verify/scrub.test.ts, apps/worker/src/handlers/scrub.test.ts
- Belegt gegen: Logik (Einheitentest ohne Fremdsystem, Job test in ci.yml)
- Stand: belegt
- Hinweis: Die Stichprobe umfasst 5 Prozent der Packs, mindestens 16 (`SCRUB_SAMPLE_FRACTION`, `SCRUB_SAMPLE_MINIMUM` in packages/core/src/verify/integrity.ts). Die Texte nennen die Größe der Stichprobe nicht.

### SCRUB-002
- Aussage: Die Speicherprüfung liest jedes geprüfte Pack von jedem Repository und vergleicht es mit seinem aufgezeichneten SHA-256. Ein beschädigtes, gekürztes oder fehlendes Pack wird mit der Ursache gemeldet.
- Fundstelle: packages/i18n/resources/en/verify.json (`storage.description`, `storage.targetStatus`)
- Öffentliche Seite: nicht abgeglichen
- Tests: packages/core/src/verify/scrub.test.ts
- Belegt gegen: Simulator (Chunk-Speicher im Arbeitsspeicher oder in einem Verzeichnis, Job test in ci.yml; kein Objektspeicher)
- Stand: belegt

### SCRUB-003
- Aussage: Schäden werden aus einer intakten Kopie repariert, wo eine existiert: Das Pack wird neu geschrieben und zur Bestätigung zurückgelesen.
- Fundstelle: packages/i18n/resources/en/verify.json (`storage.description`, `storage.repaired`)
- Öffentliche Seite: nicht abgeglichen
- Tests: packages/core/src/verify/scrub.test.ts
- Belegt gegen: Simulator (Chunk-Speicher im Arbeitsspeicher oder in einem Verzeichnis, Job test in ci.yml; kein Objektspeicher)
- Stand: belegt

### SCRUB-004
- Aussage: Ein Pack, das die Prüfung nicht lesen konnte (Verbindungs- oder Rechtefehler), gilt nicht als beschädigt: Die betroffenen Objekte brauchen Aufmerksamkeit (gelb) und zählen erst als nicht wiederherstellbar, wenn es in 3 Prüfungen in Folge über mindestens 24 Stunden nicht lesbar war.
- Fundstelle: packages/i18n/resources/en/verify.json (`storage.unreadable`, `storage.unreadablePersistent`, `reason.storage_unreadable`)
- Öffentliche Seite: nicht abgeglichen
- Tests: apps/worker/src/handlers/scrub-unreadable.pg.test.ts, packages/core/src/verify/unreadable.test.ts, apps/worker/src/handlers/scrub.test.ts
- Belegt gegen: echtes System (Chunk-Speicher in einem Verzeichnis und PostgreSQL 16, Job test in ci.yml; das Speicherziel selbst ist ein lokales Verzeichnis, kein Objektspeicher)
- Stand: belegt

### SCRUB-005
- Aussage: Sicherungen verwenden Daten aus einem beschädigten Pack nicht weiter: Die nächste Sicherung schreibt den Inhalt neu, und sobald keine Sicherung das Pack mehr braucht, wird es ausgemustert.
- Fundstelle: packages/i18n/resources/en/verify.json (`storage.corruptHeal`, `storage.retired`)
- Öffentliche Seite: nicht abgeglichen
- Tests: packages/core/src/verify/scrub.test.ts, apps/worker/src/framework.pg.test.ts
- Belegt gegen: echtes System (Chunk-Speicher in einem Verzeichnis und PostgreSQL 16, Job test in ci.yml; das Speicherziel selbst ist ein lokales Verzeichnis, kein Objektspeicher)
- Stand: belegt

### SCRUB-006
- Aussage: Die Bereinigung löscht nichts, was eine laufende Sicherung, Wiederherstellung oder Prüfung liest, und nimmt nur Chunks, die seit der Schonfrist ohne Verweis sind.
- Fundstelle: packages/i18n/resources/en/verify.json (`storage.gc.skipped`, `storage.gc.interrupted`)
- Öffentliche Seite: nicht abgeglichen
- Tests: apps/worker/src/handlers/scrub.test.ts, packages/core/src/verify/scrub.test.ts
- Belegt gegen: echtes System (Chunk-Speicher in einem Verzeichnis und PostgreSQL 16, Job test in ci.yml; das Speicherziel selbst ist ein lokales Verzeichnis, kein Objektspeicher)
- Stand: belegt

### SCRUB-007
- Aussage: Die Speicherprüfung fragt jedes Ziel nach dem Manifest der aktiven Sicherungen. Fehlt eines auf jedem Ziel bei sonst vorhandenen Daten des Mandanten, bekommt das Objekt einen roten Befund `manifest_missing`, und `scrub.corrupt` wird gemeldet.
- Fundstelle: docs/TESTING.md (Abschnitt „Restore-Beweis in Produktion“, „Scrub“)
- Öffentliche Seite: nicht abgeglichen
- Tests: apps/worker/src/handlers/scrub.test.ts, packages/core/src/verify/scrub.test.ts
- Belegt gegen: echtes System (Chunk-Speicher in einem Verzeichnis und PostgreSQL 16, Job test in ci.yml; das Speicherziel selbst ist ein lokales Verzeichnis, kein Objektspeicher)
- Stand: belegt

## Fehlerinjektion: der Speicher, die Zugangsdaten und die Rechte fallen aus (FAULT)

### FAULT-001
- Aussage: Ein Pack, das hinter dem Rücken von Restow gelöscht wurde, ist ein Beleg: Die nächste vollständige Speicherprüfung macht jedes betroffene Objekt rot (`storage_corrupt`) und meldet `scrub.corrupt`, ohne die drei Prüfungen über 24 Stunden eines nur unlesbaren Packs abzuwarten.
- Fundstelle: packages/i18n/resources/en/verify.json (`storage.corrupt`, `storage.targetStatus.missing`), docs/TESTING.md („eine Datendatei, die jedes Speicherziel als nicht vorhanden meldet“)
- Öffentliche Seite: nicht abgeglichen
- Tests: apps/worker/src/handlers/fault-injection.pg.test.ts
- Belegt gegen: echtes System (Chunk-Speicher in einem Verzeichnis und PostgreSQL 16, Job test in ci.yml; das Speicherziel selbst ist ein lokales Verzeichnis, kein Objektspeicher)
- Stand: belegt
- Hinweis: Zeitgrenze aus dem Code: Die wöchentliche Stichprobe liest 5 Prozent der Packs (mindestens 16), erst die monatliche Prüfung liest alle. Ein gelöschtes Pack, das weder eine Stichprobe noch eine Wiederherstellungsprüfung berührt, fällt spätestens nach einem Monat auf.

### FAULT-002
- Aussage: Fehlen die Daten eines Objekts im Speicher, macht die Wiederherstellungsprüfung, die sie liest, das Objekt rot (`items_missing`) und meldet `verify.red`.
- Fundstelle: packages/i18n/resources/en/verify.json (`reason.items_missing`), docs/TESTING.md („Rot nur mit Beleg“)
- Öffentliche Seite: nicht abgeglichen
- Tests: apps/worker/src/handlers/fault-injection.pg.test.ts
- Belegt gegen: echtes System (Chunk-Speicher in einem Verzeichnis und PostgreSQL 16, Job test in ci.yml; das Speicherziel selbst ist ein lokales Verzeichnis, kein Objektspeicher)
- Stand: belegt
- Hinweis: Die Prüfung liest je Objekt 20 Mails und 20 Dateien (VERIFY-001). Ein gelöschtes Pack fällt in ihr nur auf, wenn ein gezogenes Element darin liegt.

### FAULT-003
- Aussage: Hält eine Kopie das gelöschte Pack noch, schreibt die Speicherprüfung es auf das primäre Ziel zurück, meldet `scrub.repaired`, und das Objekt bleibt grün.
- Fundstelle: packages/i18n/resources/en/verify.json (`storage.repaired`, `storage.description`)
- Öffentliche Seite: nicht abgeglichen
- Tests: apps/worker/src/handlers/fault-injection.pg.test.ts
- Belegt gegen: echtes System (Chunk-Speicher in einem Verzeichnis und PostgreSQL 16, Job test in ci.yml; das Speicherziel selbst ist ein lokales Verzeichnis, kein Objektspeicher)
- Stand: belegt

### FAULT-004
- Aussage: Ein auf dem Speicher beschädigtes Pack (Prüfsumme weicht ab) macht bei der nächsten vollständigen Speicherprüfung jedes betroffene Objekt rot und löst `scrub.corrupt` aus.
- Fundstelle: packages/i18n/resources/en/verify.json (`storage.corrupt`, `storage.targetStatus.hash_mismatch`)
- Öffentliche Seite: nicht abgeglichen
- Tests: apps/worker/src/handlers/fault-injection.pg.test.ts
- Belegt gegen: echtes System (Chunk-Speicher in einem Verzeichnis und PostgreSQL 16, Job test in ci.yml; das Speicherziel selbst ist ein lokales Verzeichnis, kein Objektspeicher)
- Stand: belegt
- Hinweis: Zeitgrenze wie FAULT-001: sicher erst mit der monatlichen vollständigen Prüfung.

### FAULT-005
- Aussage: Lassen sich die Daten eines Objekts nicht mehr öffnen oder entschlüsseln, macht die Wiederherstellungsprüfung, die sie liest, das Objekt rot und meldet `verify.red`; sie endet nie ohne Bewertung.
- Fundstelle: packages/i18n/resources/en/verify.json (`reason.items_unreadable`), docs/TESTING.md („lassen sich nicht dekodieren (beschädigtes Pack, AES-GCM-Authentifizierung scheitert)“)
- Öffentliche Seite: nicht abgeglichen
- Tests: apps/worker/src/handlers/fault-injection.pg.test.ts
- Belegt gegen: echtes System (Chunk-Speicher in einem Verzeichnis und PostgreSQL 16, Job test in ci.yml; das Speicherziel selbst ist ein lokales Verzeichnis, kein Objektspeicher)
- Stand: belegt

### FAULT-006
- Aussage: Rechner: Fehlt im Repository eines Rechners eine Pack-Datei, findet das die nächste wöchentliche Prüfung, gleich welchen Teil der Daten sie liest: Der Bericht ist rot, und `scrub.corrupt` wird einmal gemeldet.
- Fundstelle: docs/AGENT.md (Abschnitt „Aufbewahrung, Prüfung, Restore-Test“, Zeile `endpoint-check`; Abschnitt zu Benachrichtigungen: „die wöchentliche Prüfung meldet das Repository als beschädigt (`scrub.corrupt`)“)
- Öffentliche Seite: nicht abgeglichen
- Tests: apps/worker/src/endpoints/endpoints.pg.test.ts
- Belegt gegen: echtes System (restic und PostgreSQL 16, Job test in ci.yml; das Repository liegt in einem lokalen Verzeichnis)
- Stand: belegt

### FAULT-007
- Aussage: Rechner: Eine beschädigte Pack-Datei wird gefunden, sobald die wöchentliche Prüfung den Teil liest, in dem sie liegt: je Woche ein Zwanzigstel der Daten in fester Reihenfolge, also innerhalb von zwanzig Wochen. Dann ist der Bericht rot und `scrub.corrupt` wird gemeldet.
- Fundstelle: docs/AGENT.md (Abschnitt „Aufbewahrung, Prüfung, Restore-Test“: „pro Woche ein Zwanzigstel der Daten, in fester Reihenfolge, damit das ganze Repository über etwa fünf Monate gelesen wird“)
- Öffentliche Seite: nicht abgeglichen
- Tests: apps/worker/src/endpoints/endpoints.pg.test.ts
- Belegt gegen: echtes System (restic und PostgreSQL 16, Job test in ci.yml; das Repository liegt in einem lokalen Verzeichnis)
- Stand: belegt
- Hinweis: Bis zu zwanzig Wochen lang meldet die Prüfung ein Repository mit einem beschädigten Pack als grün. Früher fällt der Schaden nur auf, wenn der Restore-Test einer neuen Sicherung eine Datei aus diesem Pack zieht.

### FAULT-008
- Aussage: Rechner: Öffnet das gespeicherte Passwort das Repository nicht mehr, ist der Bericht der Prüfung rot, mit der Meldung von restic, und `scrub.corrupt` wird gemeldet.
- Fundstelle: docs/AGENT.md (Abschnitt „Aufbewahrung, Prüfung, Restore-Test“: „Bericht `repository_check`, grün oder rot“)
- Öffentliche Seite: nicht abgeglichen
- Tests: apps/worker/src/endpoints/endpoints.pg.test.ts
- Belegt gegen: echtes System (restic und PostgreSQL 16, Job test in ci.yml)
- Stand: belegt
- Hinweis: Die Meldung heißt für den Administrator „Repository beschädigt“. Ein eigener Zustand „Passwort passt nicht“ existiert nicht; der Grund steht nur im Text des Berichts.

### FAULT-009
- Aussage: Werden die Zugangsdaten einer Microsoft-365-Quelle ungültig (Geheimnis rotiert oder abgelaufen, Zertifikat abgelaufen), wechselt die Quelle beim ersten fehlgeschlagenen Lauf auf „Fehler“ mit der Ursache `graph.app_credentials_invalid`, und `backup.failed` wird gemeldet, sobald der Lauf seine fünf Wiederholungen verbraucht hat.
- Fundstelle: docs/MICROSOFT.md (Abschnitt „Warnungen: Läufe mit nicht gesicherten Elementen“ und Ursachenkatalog `graph.app_credentials_invalid`), README.md (Abschnitt „What it does“, „Alerts and reports“: „when a backup fails“)
- Öffentliche Seite: nicht abgeglichen
- Tests: apps/worker/src/fault-injection.pg.test.ts
- Belegt gegen: Simulator (Token-Endpunkt antwortet wie Entra ID; Lauf, Quelle und Meldung gegen PostgreSQL 16 im Job test in ci.yml)
- Stand: belegt
- Hinweis: Zeitgrenze aus dem Code (apps/worker/src/queues.ts): 5 Wiederholungen mit 60 Sekunden, jeweils verdoppelt; die Meldung kommt 31 bis 62 Minuten nach dem ersten Fehlschlag. Die Bereitschaft der Objekte ändert sich dadurch nicht: Sie werden erst nach 48 Stunden ohne neue Sicherung gelb und nach sieben Tagen rot (READY-004).

### FAULT-010
- Aussage: Lehnt der IMAP-Server das Passwort ab, wechselt die Quelle beim ersten fehlgeschlagenen Lauf auf „Fehler“ mit der Ursache `imap.auth_failed`, und `backup.failed` wird gemeldet, sobald der Lauf seine Wiederholungen verbraucht hat. Ein halb begonnener Sicherungsstand bleibt nicht zurück.
- Fundstelle: docs/IMAP.md (Abschnitt „Anmeldung abgelehnt: Konto abgeschaltet?“), README.md (Abschnitt „What it does“, „Alerts and reports“)
- Öffentliche Seite: nicht abgeglichen
- Tests: apps/worker/src/fault-injection.pg.test.ts
- Belegt gegen: Simulator (der IMAP-Server lehnt die Anmeldung ab; Sicherungs-Engine, Lauf und Meldung echt gegen PostgreSQL 16 im Job test in ci.yml)
- Stand: belegt
- Hinweis: Zeitgrenze wie FAULT-009. Zusätzlich fragt Restow nach 3 gezählten Fehlschlägen über mindestens 24 Stunden, ob das Konto abgeschaltet wurde (ALERT-008).

### FAULT-011
- Aussage: Verweigert Microsoft 365 das Schreiben, wenn eine Wiederherstellung es braucht (fehlendes oder entzogenes Schreibrecht), stellt der Lauf nichts wieder her, nennt an jedem Element die fehlende Berechtigung (`graph.access_denied`, `Mail.ReadWrite`) und meldet sofort `restore.failed`.
- Fundstelle: docs/MICROSOFT.md (Abschnitt „App-Registrierung“), packages/core/src/entra/permissions.ts (Kopfkommentar: „backup works, restore fails with 403“), README.md („Alerts and reports“)
- Öffentliche Seite: nicht abgeglichen
- Tests: apps/worker/src/fault-injection.pg.test.ts
- Belegt gegen: Simulator (die Graph-API liest und verweigert jedes Schreiben mit 403; Wiederherstellungs-Engine, Lauf und Meldung echt gegen PostgreSQL 16 im Job test in ci.yml)
- Stand: belegt
- Hinweis: Vor der Wiederherstellung warnt nichts: Die Sicherung braucht nur Leserechte, die Wiederherstellungsprüfung schreibt nicht in das Ziel (VERIFY-005), und die Berechtigungsprüfung der Quelle läuft nur beim Verbinden und auf Anforderung, nicht regelmäßig. Ein entzogenes Schreibrecht fällt erst im Ernstfall auf.

### FAULT-012
- Aussage: Ist der Speicher voll, endet die Sicherung als fehlgeschlagen mit der Ursache `storage.full`, `backup.failed` wird gemeldet, nichts halb Geschriebenes wird zu einem Sicherungsstand, und der vorherige Sicherungsstand bleibt unverändert.
- Fundstelle: docs/STORAGE.md (Abschnitt „A full target“), packages/core/src/failures/catalog.ts (`storage.full`)
- Öffentliche Seite: nicht abgeglichen
- Tests: apps/worker/src/fault-injection.pg.test.ts
- Belegt gegen: Simulator (ein Verzeichnis, das jedes Schreiben mit ENOSPC verweigert; Chunk-Speicher, Lauf und Meldung echt gegen PostgreSQL 16 im Job test in ci.yml)
- Stand: belegt
- Hinweis: Die Meldung kommt nach den Wiederholungen des Laufs (31 bis 62 Minuten). Vorher warnt `installation.disk_low` nur für das lokale Standard-Repository, die Datenbank und die Systemplatte (ALERT-006), nicht für ein S3-Ziel oder das eigene Repository eines Mandanten.

## Wiederherstellung je Quelle (RESTORE)

### RESTORE-001
- Aussage: Eine Wiederherstellung in ein Exchange-Postfach ersetzt nie ein vorhandenes Element: Die API lehnt den Modus „replace“ mit 422 ab, und die Engine löscht nichts, auch nicht für einen Auftrag, der den Modus noch gespeichert trägt.
- Fundstelle: README.md (Abschnitt „What it does“, „Restore“: „next to the original, never over it“), docs/ARCHITECTURE.md (Abschnitt „Restore“), packages/i18n/resources/en/restore.json (`dialog.mode.renameDescriptionMail`)
- Öffentliche Seite: nicht abgeglichen
- Tests: apps/api/src/features/restore/restore.pg.test.ts, apps/api/src/features/restore/schemas.test.ts, packages/core/src/restore/exchange.test.ts, apps/api/src/routes/v1/restore.test.ts
- Belegt gegen: Simulator (simulierte Graph-API, Job test in ci.yml; nie gegen einen echten Microsoft-365-Mandanten)
- Stand: belegt

### RESTORE-002
- Aussage: Eine Wiederherstellung überschreibt in OneDrive nie: Die API lehnt den Modus „replace“ für ein OneDrive ab und legt keinen Auftrag an, und die OneDrive-Engine führt einen gespeicherten Auftrag mit „replace“ als „rename“ aus und sagt das an jedem Element. „Beide behalten“ legt die gesicherte Datei unter neuem Namen daneben, „Vorhandene überspringen“ lässt die Datei stehen.
- Fundstelle: docs/MICROSOFT.md (Abschnitte „OneDrive: Sichern und Wiederherstellen“ und „SharePoint Online“: „Postfächer und OneDrives ersetzen weiterhin nie“), docs/ARCHITECTURE.md (Abschnitt „Restore“), README.md (Abschnitt „What it does“, „Restore“), packages/i18n/resources/en/restore.json (`dialog.mode.renameDescriptionFiles`, `dialog.mode.skipDescription`)
- Öffentliche Seite: nicht abgeglichen
- Tests: apps/api/src/features/restore/restore.pg.test.ts, apps/api/src/routes/v1/restore.test.ts, packages/core/src/restore/onedrive.test.ts
- Belegt gegen: Simulator (simulierte Graph-API, Job test in ci.yml; nie gegen einen echten Microsoft-365-Mandanten)
- Stand: belegt

### RESTORE-003
- Aussage: Eine Wiederherstellung in ein IMAP-Konto ersetzt und löscht nichts: Die API lehnt „replace“ ab, vorhandene Nachrichten werden an ihrer Message-ID erkannt und in keinem Modus gelöscht.
- Fundstelle: docs/ARCHITECTURE.md (Abschnitt „Restore“), README.md (Abschnitt „What it does“, „Restore“)
- Öffentliche Seite: nicht abgeglichen
- Tests: apps/api/src/features/restore/restore.pg.test.ts, packages/core/src/restore/imap.test.ts
- Belegt gegen: Simulator (simulierter IMAP-Server, Job test in ci.yml)
- Stand: belegt

### RESTORE-004
- Aussage: „Beide behalten“ stellt ein Postfach in einen neuen, datierten Ordner wieder her, Byte für Byte, mit Lesestatus, Kennzeichen und Kategorien; nichts Vorhandenes wird berührt.
- Fundstelle: packages/i18n/resources/en/restore.json (`dialog.mode.renameDescriptionMail`, `dialog.target.originalDescriptionFolder`), docs/MICROSOFT.md (Abschnitt „Exchange: Wiederherstellen“)
- Öffentliche Seite: nicht abgeglichen
- Tests: packages/core/src/restore/exchange.test.ts, packages/core/src/restore/roundtrip.test.ts
- Belegt gegen: Simulator (simulierte Graph-API, Job test in ci.yml; nie gegen einen echten Microsoft-365-Mandanten)
- Stand: belegt

### RESTORE-005
- Aussage: Jede nach OneDrive hochgeladene Datei wird geprüft (Größe, SHA-256, QuickXorHash). Weichen die gesendeten Bytes vom Sicherungsstand ab oder lassen sich die gespeicherten Daten nicht authentifizieren, scheitert das Element, und für beschädigte Daten wird nichts hochgeladen.
- Fundstelle: docs/MICROSOFT.md (Abschnitt „OneDrive: Sichern und Wiederherstellen“), docs/ARCHITECTURE.md (Abschnitt zum Chunk-Speicher: „bevor Bytes ein Restore-Ziel erreichen“)
- Öffentliche Seite: nicht abgeglichen
- Tests: packages/core/src/restore/onedrive.test.ts, packages/core/src/restore/roundtrip.test.ts
- Belegt gegen: Simulator (simulierte Graph-API, Job test in ci.yml; nie gegen einen echten Microsoft-365-Mandanten)
- Stand: belegt

### RESTORE-006
- Aussage: „Überschreiben“ gibt es nur für SharePoint-Websites und nur als ausdrückliche Wahl; „Beide behalten“ legt die Datei unter neuem Namen daneben.
- Fundstelle: docs/MICROSOFT.md (Abschnitt „SharePoint Online“, „Wiederherstellung“), README.md (Abschnitt „What it does“, „Restore“), packages/i18n/resources/en/restore.json (`dialog.mode.replaceDescriptionSite`, `dialog.mode.renameDescriptionSite`)
- Öffentliche Seite: nicht abgeglichen
- Tests: packages/core/src/restore/sharepoint.test.ts, apps/api/src/features/restore/schemas.test.ts
- Belegt gegen: Simulator (simulierte Graph-API, Job test in ci.yml; nie gegen einen echten Microsoft-365-Mandanten)
- Stand: belegt

### RESTORE-007
- Aussage: Microsoft-365-Gruppen und Teams: „replace“ wird abgelehnt. In die Gruppe zurück geht nur der Gruppenkalender; die Unterhaltungen lassen sich in ein Benutzerpostfach wiederherstellen.
- Fundstelle: packages/i18n/resources/en/restore.json (`dialog.group.title`, `dialog.group.description`), docs/MICROSOFT.md (Abschnitt „Gruppenpostfächer“)
- Öffentliche Seite: nicht abgeglichen
- Tests: apps/api/src/features/restore/groups.pg.test.ts, packages/core/src/backup/groups/engine.test.ts
- Belegt gegen: Simulator (simulierte Graph-API, Job test in ci.yml; nie gegen einen echten Microsoft-365-Mandanten)
- Stand: belegt

### RESTORE-008
- Aussage: Eine IMAP-Wiederherstellung legt jede Nachricht Byte für Byte mit Datum und Kennzeichen neben die Originale; die Originale bleiben unberührt.
- Fundstelle: docs/CI.md (Smoke-Check 5), docs/IMAP.md (Abschnitt „IMAP-Backup“), README.md (Abschnitt „What it does“, „Restore“)
- Öffentliche Seite: nicht abgeglichen
- Tests: packages/core/src/restore/imap.test.ts, scripts/smoke/checks/05-imap.mjs
- Belegt gegen: beides (simulierter IMAP-Server im Job test in ci.yml; ein echter IMAP-Server in einem Container im Smoke-Check 5, smoke.yml jede Nacht und release.yml vor jedem Release; kein IMAP-Anbieter)
- Stand: belegt

### RESTORE-009
- Aussage: Personen mit der Rolle „user“ stellen nur ihr eigenes Postfach und OneDrive wieder her, und nur in ihr eigenes Konto.
- Fundstelle: README.md (Abschnitt „What it does“, „Restore“)
- Öffentliche Seite: nicht abgeglichen
- Tests: apps/api/src/features/restore/restore.pg.test.ts, apps/api/src/features/snapshots/people.pg.test.ts
- Belegt gegen: echtes System (PostgreSQL 16, Job test in ci.yml)
- Stand: belegt

### RESTORE-010
- Aussage: Stellt ein Administrator die Daten einer anderen Person wieder her, ist ein Grund Pflicht, und das Audit-Log hält fest, in wessen Auftrag.
- Fundstelle: packages/i18n/resources/en/restore.json (`dialog.reason.impersonation`)
- Öffentliche Seite: nicht abgeglichen
- Tests: apps/api/src/features/restore/restore.pg.test.ts
- Belegt gegen: echtes System (PostgreSQL 16, Job test in ci.yml)
- Stand: belegt

### RESTORE-011
- Aussage: Rechner: Eine Wiederherstellung geht in einen neuen Ordner, nie über vorhandene Dateien, Byte für Byte.
- Fundstelle: README.md (Abschnitt „What it does“, „Endpoint backup“: „Restores go into a new folder, never over existing files“), docs/AGENT.md (Einleitung: „Restores überschreiben nie“)
- Öffentliche Seite: nicht abgeglichen
- Tests: agent/internal/core/core_test.go, apps/api/src/features/endpoints/endpoints.restic.pg.test.ts, scripts/smoke/checks/10-endpoint.mjs
- Belegt gegen: echtes System (restic, der Agent als Linux-Prozess und PostgreSQL 16 in den Jobs test und agent in ci.yml; Installationsskript und Agent in einem Linux-Container im Smoke-Check 10; die Windows-Fassung im Job agent-windows; macOS nie)
- Stand: belegt

### RESTORE-012
- Aussage: Dateifreigaben: Eine Wiederherstellung in einen neuen Ordner kommt Byte für Byte mit ihren Berechtigungen zurück; am ursprünglichen Ort bleibt mit „Beide behalten“ das Vorhandene stehen.
- Fundstelle: README.md (Abschnitt „What it does“, „File shares“), docs/FILESHARES.md, docs/CI.md (Smoke-Check 12)
- Öffentliche Seite: nicht abgeglichen
- Tests: apps/worker/src/file-shares/e2e.pg.test.ts, scripts/smoke/checks/12-file-share.mjs
- Belegt gegen: echtes System (restic, der Freigabe-Runner und PostgreSQL 16 im Job test in ci.yml; ein SMB-3-Server in einem Container im Smoke-Check 12; kein Windows Server, kein NAS, kein NFS)
- Stand: belegt

### RESTORE-013
- Aussage: Proxmox VE: Eine Wiederherstellung legt einen neuen Gast mit neuer VMID im Pool `restow-restore` an und nie einen privilegierten Container; der Gast, von dem die Sicherung stammt, bleibt unberührt.
- Fundstelle: README.md (Abschnitt „What it does“, „Proxmox VE“: „Restores create a new VM or container“), docs/PVE.md (Abschnitte „How it fits together“ und „Restore“)
- Öffentliche Seite: nicht abgeglichen
- Tests: apps/api/src/features/pve/pve.pg.test.ts, agent/internal/pve/pve_test.go
- Belegt gegen: Simulator (simulierter Proxmox-VE-Knoten: `pvesh`, `qm` und `pct` als Attrappen, Jobs test und agent in ci.yml; ein echter Knoten nur von Hand nach docs/PVE-HOST-TEST.md)
- Stand: belegt

### RESTORE-014
- Aussage: `restow-restore` stellt allein aus dem Chunk-Speicher und den Schlüsseln wieder her, ohne laufenden Server und ohne Datenbank, Byte für Byte; ein Speicher mit einem beschädigten Byte wird abgelehnt.
- Fundstelle: README.md (Abschnitt „What it does“, „Standalone restore“), docs/CI.md (Smoke-Check 7)
- Öffentliche Seite: nicht abgeglichen
- Tests: packages/cli/src/restore.test.ts, packages/cli/src/cli.test.ts, packages/cli/src/endpoint-password.test.ts, packages/cli/src/restore-pve.test.ts, scripts/smoke/checks/07-standalone-restore.mjs
- Belegt gegen: echtes System (das Werkzeug aus dem Image, Server gestoppt und ohne Netz, im Smoke-Check 7; dazu Einheitentests im Job test in ci.yml)
- Stand: belegt

### RESTORE-015
- Aussage: Ein Download liefert ein ZIP mit den Mails als EML, den Dateien und einer Liste der SHA-256-Prüfsummen. Scheitert ein Objekt an der Integritätsprüfung, wird das Archiv abgebrochen und die halbe Datei entfernt.
- Fundstelle: packages/i18n/resources/en/restore.json (`dialog.target.downloadDescription`), docs/ARCHITECTURE.md (Abschnitt „Restore“)
- Öffentliche Seite: nicht abgeglichen
- Tests: packages/core/src/restore/download.test.ts
- Belegt gegen: Simulator (Chunk-Speicher im Arbeitsspeicher oder in einem Verzeichnis, Job test in ci.yml; kein Objektspeicher)
- Stand: belegt

### RESTORE-016
- Aussage: SQL Server (Vorschau): Die Prüfung spielt die neueste Sicherung aus dem Repository unter einem Prüfnamen zurück und ist nur grün, wenn `DBCC CHECKDB` darauf fehlerfrei läuft; eine beschädigte Kopie ist rot. Eine Wiederherstellung legt die Datenbank unter einem neuen Namen an.
- Fundstelle: docs/BAREMETAL-WINDOWS.md (Abschnitte zu W2a), packages/i18n/resources/en/endpoints.json (SQL-Texte: „restored from the backup data and checked with DBCC CHECKDB without errors“, „Restore under a new name“)
- Öffentliche Seite: nicht abgeglichen
- Tests: agent/scripts/test-sql-windows.ps1, .github/workflows/sql-server.yml, agent/internal/core/sql_test.go
- Belegt gegen: echtes System (SQL Server Express 2019 und 2022 auf einem Windows-Runner, Job windows-sql in sql-server.yml: jede Nacht und bei Änderungen an den SQL-Pfaden; nicht Teil von ci.yml)
- Stand: belegt
- Hinweis: sql-server.yml gehört nicht zum Pflicht-Check „CI passed“. Scheitert der Download von SQL Server, endet der Lauf als „incomplete“ mit Exit 0 und beweist nichts; nur der Aufruf aus dem Release (`strict: true`) schlägt dann fehl.

### RESTORE-017
- Aussage: Der Agent für macOS sichert und stellt wieder her wie der für Linux.
- Fundstelle: README.md (Einleitung und Abschnitt „What it does“, „Endpoint backup“: „Linux and macOS agents“), docs/AGENT.md
- Öffentliche Seite: nicht abgeglichen
- Tests: keine
- Belegt gegen: nichts
- Stand: nur behauptet
- Grund: Die Pipeline hat keinen macOS-Runner: Der Agent wird für darwin nur übersetzt (agent/build.sh im Job agent). Der Installationstest agent/scripts/test-install-macos.sh braucht einen Mac und läuft in keinem Workflow; docs/CI.md sagt es selbst („never on a real macOS host“). Die gemeinsame Logik ist unter Linux belegt (RESTORE-011, VERIFY-008).

## Aufbewahrung und Löschsperren (RETAIN)

### RETAIN-001
- Aussage: Ein Legal Hold hält die Aufbewahrung an: Überfällige Sicherungsstände unter einem Hold bleiben, auch unter einer aggressiven eigenen Richtlinie.
- Fundstelle: packages/i18n/resources/en/retention.json (`previewHeld`), README.md (Abschnitt „What it does“, „Archive“: „legal hold“)
- Öffentliche Seite: nicht abgeglichen
- Tests: apps/worker/src/handlers/retention.test.ts, apps/worker/src/handlers/retention.pg.test.ts
- Belegt gegen: echtes System (PostgreSQL 16, Job test in ci.yml)
- Stand: belegt

### RETAIN-002
- Aussage: Archiv: Die Aufbewahrung löscht nur abgelaufene Elemente ohne Hold und protokolliert jede Löschung. Ein mandantenweiter Hold blockiert jedes Element, und ein Hold, der zwischen zwei Stapeln gesetzt wird, schützt alles, was der Lauf noch nicht erreicht hat.
- Fundstelle: docs/ARCHIVE.md, README.md (Abschnitt „What it does“, „Archive“: „enforced retention … and legal hold“)
- Öffentliche Seite: nicht abgeglichen
- Tests: ee/worker/src/archive-retention/archive-retention.pg.test.ts
- Belegt gegen: echtes System (PostgreSQL 16, Job test in ci.yml)
- Stand: belegt

### RETAIN-003
- Aussage: Der neueste Sicherungsstand eines Objekts und sein einziger geprüfter werden nie entfernt, was immer die Richtlinie sagt.
- Fundstelle: packages/i18n/resources/en/retention.json (Zeile 65: „The newest restore point of an object, and its only checked one, are never removed, whatever the policy says“)
- Öffentliche Seite: nicht abgeglichen
- Tests: apps/worker/src/handlers/retention.test.ts
- Belegt gegen: Simulator (Chunk-Speicher im Arbeitsspeicher oder in einem Verzeichnis, Job test in ci.yml; kein Objektspeicher)
- Stand: belegt

### RETAIN-004
- Aussage: S3 mit Object Lock: Jedes gesperrte Objekt wird mit einer Aufbewahrung von N Tagen plus 7 Tagen Puffer geschrieben. Das Löschen eines gesperrten Objekts wird abgelehnt und löscht nichts, auch nicht für jemanden mit dem Zugriffsschlüssel von Restow, und den Governance-Bypass sendet Restow nie.
- Fundstelle: docs/STORAGE.md (Abschnitt „Immutable backups“, „Design“)
- Öffentliche Seite: nicht abgeglichen
- Tests: packages/core/src/storage/immutability.test.ts
- Belegt gegen: Simulator (strenger S3-Bucket im Arbeitsspeicher, Job test in ci.yml; die Prüfung gegen eine echte S3-API mit Object Lock, packages/core/src/storage/immutability.s3.test.ts, wird ohne `RESTOW_TEST_S3_LOCK_ENDPOINT` übersprungen und läuft in keinem Workflow)
- Stand: belegt

### RETAIN-005
- Aussage: Solange ein Ziel das Manifest eines abgelaufenen Sicherungsstands noch sperrt, lässt die Aufbewahrung ihn unberührt und wiederherstellbar; die Bereinigung behält ein noch gesperrtes Pack und löscht es erst, wenn die Sperre abgelaufen ist.
- Fundstelle: docs/STORAGE.md (Abschnitt „Immutable backups“, „Deleting under a lock“)
- Öffentliche Seite: nicht abgeglichen
- Tests: apps/worker/src/handlers/retention.test.ts, packages/core/src/verify/gc-immutable.test.ts, packages/core/src/endpoints/restic-immutable.test.ts
- Belegt gegen: Simulator (Speicherziel mit Sperre im Arbeitsspeicher; restic echt, Job test in ci.yml)
- Stand: belegt

### RETAIN-006
- Aussage: Die Sperren der Objekte, die noch gebraucht werden, werden erneuert, sobald die letzte vollständige Erneuerung 6 Tage alt ist; ein Objekt, das ohne Sperre geschrieben wurde, wird gefunden und gemeldet.
- Fundstelle: docs/STORAGE.md (Abschnitt „Immutable backups“, „Renewal“ und „Verification“)
- Öffentliche Seite: nicht abgeglichen
- Tests: apps/worker/src/handlers/immutability.pg.test.ts, packages/core/src/storage/immutability.test.ts
- Belegt gegen: Simulator (strenger S3-Bucket im Arbeitsspeicher; Zustand gegen PostgreSQL 16 im Job test in ci.yml)
- Stand: belegt

### RETAIN-007
- Aussage: Löschverzögerung für Verzeichnisse: Restow löscht und überschreibt eine Sicherungsdatei erst N Tage nach dem Schreiben. Eine später verkürzte Frist verkürzt nie, was vorher geschrieben wurde.
- Fundstelle: docs/STORAGE.md (Abschnitt „Immutable backups“, „Directories: deletion delay, not immutability“)
- Öffentliche Seite: nicht abgeglichen
- Tests: packages/core/src/storage/immutability.test.ts
- Belegt gegen: echtes System (lokales Verzeichnis, Job test in ci.yml)
- Stand: belegt
- Hinweis: Die Dokumentation sagt selbst, dass dies keine Unveränderlichkeit ist: Wer Zugriff auf den Server oder die Freigabe hat, kann die Dateien löschen.

### RETAIN-008
- Aussage: Wiederherstellungsmodus: Nach dem Einspielen eines Datenbank-Dumps wird nichts gelöscht. Der Worker erkennt ein Speicherziel, das weiter ist als die Datenbank, schaltet den Modus selbst ein, meldet `installation.restore_mode` und verweigert die Löschung; neue Sicherungen schreiben weiter.
- Fundstelle: docs/STORAGE.md (Abschnitt „Restore mode and progress markers“), docs/UPDATING.md (Abschnitt „Rollback“, „If step 3 is forgotten“)
- Öffentliche Seite: nicht abgeglichen
- Tests: apps/worker/src/restore-mode.pg.test.ts, packages/core/src/storage/deletion-guard.test.ts, packages/core/src/verify/gc-restore-mode.test.ts, packages/core/src/storage/deletion-sites.test.ts, apps/worker/src/handlers/retention.test.ts, ee/worker/src/archive-retention/archive-retention.pg.test.ts
- Belegt gegen: echtes System (Chunk-Speicher in einem Verzeichnis und PostgreSQL 16, Job test in ci.yml; das Speicherziel selbst ist ein lokales Verzeichnis, kein Objektspeicher)
- Stand: belegt

### RETAIN-009
- Aussage: Wiederherstellungsmodus: Aufträge von vor dem Haltepunkt werden abgebrochen statt ausgeführt oder fortgesetzt, auch ein Auftrag, der gerade läuft; Aufträge von danach laufen.
- Fundstelle: docs/STORAGE.md (Abschnitt „Restore mode and progress markers“, „Jobs from before the restore are held“)
- Öffentliche Seite: nicht abgeglichen
- Tests: apps/worker/src/restore-mode-running-job.pg.test.ts, apps/api/src/features/endpoints/cancel.pg.test.ts
- Belegt gegen: echtes System (PostgreSQL 16, Job test in ci.yml)
- Stand: belegt

### RETAIN-010
- Aussage: Ein Repository, das Überschreiben und Löschen ablehnt (WORM), wird beim Test erkannt und bleibt benutzbar; dort wird keine Aufbewahrung angewendet und nichts gelöscht.
- Fundstelle: docs/STORAGE.md (Abschnitt „Write-once storage“)
- Öffentliche Seite: nicht abgeglichen
- Tests: packages/core/src/storage/write-once.test.ts, apps/worker/src/pve/maintenance.pg.test.ts, packages/core/src/endpoints/restic-rest.test.ts
- Belegt gegen: Simulator (Verzeichnis, das Überschreiben und Löschen wie eine WORM-Freigabe ablehnt, Job test in ci.yml; keine echte WORM-Freigabe eines NAS)
- Stand: belegt

### RETAIN-011
- Aussage: Solange ein Objekt einen verdächtigen Sicherungsstand hat, den niemand aufgelöst hat, löscht die Aufbewahrung keinen Sicherungsstand dieses Objekts. Die Sperre endet nur durch einen Administrator, nie durch einen späteren sauberen Sicherungsstand.
- Fundstelle: docs/RANSOMWARE.md (Abschnitt „Retention hold“)
- Öffentliche Seite: nicht abgeglichen
- Tests: apps/worker/src/endpoints/endpoints.pg.test.ts, apps/worker/src/file-shares/file-shares.pg.test.ts, apps/worker/src/pve/maintenance.pg.test.ts
- Belegt gegen: echtes System (restic und PostgreSQL 16, Job test in ci.yml)
- Stand: belegt
- Hinweis: Die Erkennung ist laut docs/RANSOMWARE.md nur mit nachgestellten Angriffen geprüft, nicht gegen echte Schadsoftware.

### RETAIN-012
- Aussage: Ein verdächtiger Sicherungsstand löst `backup.suspicious` einmal je Episode aus. Eine Aufbewahrungssperre, die nach 14 Tagen noch offen ist, wird mit `backup.suspicious_hold` erneut gemeldet.
- Fundstelle: docs/RANSOMWARE.md (Abschnitte „Results, episodes and alerts“ und „Retention hold“, „It never goes on silently“)
- Öffentliche Seite: nicht abgeglichen
- Tests: apps/worker/src/suspicion/scan.pg.test.ts
- Belegt gegen: echtes System (PostgreSQL 16, Job test in ci.yml)
- Stand: belegt

### RETAIN-013
- Aussage: Der Agent schreibt append-only: Er kann Sicherungen hinzufügen, aber keine löschen oder überschreiben. Aufbewahrung und Prune laufen nur mit dem Wartungszugang des Servers.
- Fundstelle: README.md (Abschnitt „What it does“, „Endpoint backup“: „append-only so an agent can add backups but never delete or overwrite one“), docs/AGENT.md (Einleitung)
- Öffentliche Seite: nicht abgeglichen
- Tests: packages/core/src/endpoints/restic-rest.test.ts, apps/api/src/features/endpoints/endpoints.restic.pg.test.ts, agent/integration/agent_test.go, agent/scripts/integration.sh
- Belegt gegen: echtes System (restic gegen den REST-Endpunkt der API und PostgreSQL 16, Job test in ci.yml; der Agent gegen restic und einen append-only-REST-Server, Job agent in ci.yml)
- Stand: belegt

### RETAIN-014
- Aussage: Über die Aufbewahrung entscheidet der Server nach seinen eigenen Aufzeichnungen, nicht nach den Zeiten, die der Agent schreibt: Gefälschte Snapshots mit einem Datum in der Zukunft löschen nichts.
- Fundstelle: README.md (Abschnitt „What it does“, „Endpoint backup“: „with retention decided by the server“), docs/AGENT.md
- Öffentliche Seite: nicht abgeglichen
- Tests: apps/worker/src/endpoints/endpoints.pg.test.ts
- Belegt gegen: echtes System (restic und PostgreSQL 16, Job test in ci.yml)
- Stand: belegt

### RETAIN-015
- Aussage: Auf einem vollen Speicherziel gibt die Aufbewahrung Platz frei: Scheitert der normale Prune aus Platzmangel, folgt ein Prune, der nur ungenutzte Packs löscht. Passt nicht einmal der, endet der Lauf als `storage_full`, und das Repository bleibt intakt.
- Fundstelle: docs/STORAGE.md (Abschnitt „A full target“), CHANGELOG.md (Unreleased, „Retention frees space on a full storage target (#100)“)
- Öffentliche Seite: nicht abgeglichen
- Tests: packages/core/src/endpoints/restic-prune-space.test.ts, apps/worker/src/endpoints/prune-summary.test.ts
- Belegt gegen: beides (restic gegen ein Speicherziel, das Schreiben verweigert, im Job test in ci.yml; das echte volle Dateisystem, ein ext4 in einem Loop-Device, läuft nur als root und wird auf den Runnern von ci.yml übersprungen)
- Stand: belegt
- Hinweis: Für diesen Fall gibt es keinen Alarm: Der Aufbewahrungsbericht des Rechners sagt „Retention could not free space: target full“, eine Benachrichtigung wird nicht ausgelöst. Der Alarm kommt erst mit der fehlgeschlagenen Sicherung (FAULT-012) oder, für lokale Platten, mit `installation.disk_low` (ALERT-006).

### RETAIN-016
- Aussage: Solange eine Startprobe des Labors das Repository eines Rechners liest, laufen dort weder Aufbewahrung noch das Löschen der Sicherungen; eine Startprobe, die ihre Zeit überschreitet, endet ohne Alarm.
- Fundstelle: docs/BAREMETAL.md (Abschnitte 9.7 und 12.3)
- Öffentliche Seite: nicht abgeglichen
- Tests: apps/worker/src/endpoints/boot-probe.pg.test.ts
- Belegt gegen: echtes System (PostgreSQL 16, Job test in ci.yml)
- Stand: belegt

## Verschlüsselung, Schlüssel und Mandantentrennung (CRYPT)

### CRYPT-001
- Aussage: Jeder Chunk wird mit AES-256-GCM versiegelt. Ein verändertes Byte im Chiffrat oder in der gebundenen Chunk-ID wird beim Öffnen erkannt.
- Fundstelle: README.md (Abschnitt „What it does“, „Encryption“), docs/TESTING.md (Stufe 1: „Crypto (Roundtrip, Manipulation erkannt)“)
- Öffentliche Seite: nicht abgeglichen
- Tests: packages/core/src/crypto.test.ts, packages/core/src/pack.test.ts
- Belegt gegen: Logik (Einheitentest ohne Fremdsystem, Job test in ci.yml)
- Stand: belegt

### CRYPT-002
- Aussage: Jeder Mandant hat einen eigenen Schlüssel: Daten lassen sich mit einem anderen Schlüssel nicht öffnen, und die gespeicherte Chunk-ID hängt vom Schlüssel ab, sodass die Deduplizierung im Mandanten bleibt.
- Fundstelle: README.md (Abschnitt „What it does“, „Encryption“: „a separate key per tenant … Deduplication stays within a tenant“)
- Öffentliche Seite: nicht abgeglichen
- Tests: packages/core/src/crypto.test.ts, packages/core/src/chunkId.test.ts
- Belegt gegen: Logik (Einheitentest ohne Fremdsystem, Job test in ci.yml)
- Stand: belegt

### CRYPT-003
- Aussage: Der Hauptschlüssel (`RESTOW_MASTER_KEY`) umschließt jeden Mandantenschlüssel; ohne ihn lässt sich kein Mandantenschlüssel öffnen.
- Fundstelle: README.md (Abschnitte „Encryption“ und „Install by hand“: „without it no backup can ever be read again“)
- Öffentliche Seite: nicht abgeglichen
- Tests: packages/core/src/crypto.test.ts, packages/core/src/keyprovider.test.ts
- Belegt gegen: Logik (Einheitentest ohne Fremdsystem, Job test in ci.yml)
- Stand: belegt

### CRYPT-004
- Aussage: Ein im Speicher abgelegter umschlossener Schlüssel, der von dem der Datenbank abweicht, wird nie überschrieben, sondern als Befund gemeldet; auch auf einer Kopie.
- Fundstelle: docs/STORAGE.md (Abschnitt „Wrapped keys and repository passwords are never overwritten“)
- Öffentliche Seite: nicht abgeglichen
- Tests: packages/core/src/verify/gc-restore-mode.test.ts, packages/core/src/storage/deletion-guard.test.ts, apps/worker/src/framework.pg.test.ts
- Belegt gegen: echtes System (Chunk-Speicher in einem Verzeichnis und PostgreSQL 16, Job test in ci.yml; das Speicherziel selbst ist ein lokales Verzeichnis, kein Objektspeicher)
- Stand: belegt

### CRYPT-005
- Aussage: Die Mandantentrennung in der Datenbank erzwingt Row Level Security auf Rollen, die sie nicht umgehen können: ohne Mandantenbindung keine Zeile, mit Bindung an Mandant A keine Zeile von B. Jede Tabelle ist für diese Rollen eingeordnet, und die Tests scheitern an einer Tabelle, die es nicht ist.
- Fundstelle: SECURITY.md (Abschnitt „Database isolation“), docs/TESTING.md (Postgres-Suiten, `rls.pg.test.ts`)
- Öffentliche Seite: nicht abgeglichen
- Tests: packages/db/src/rls.pg.test.ts
- Belegt gegen: echtes System (PostgreSQL 16, Job test in ci.yml)
- Stand: belegt

### CRYPT-006
- Aussage: Das Wiederherstellungslabor bekommt für eine Startprobe einen Einmal-Code, der an die Adresse der Installation gebunden ist, und nie das Passwort oder die Zugangsdaten eines Repositorys; gespeichert wird nur der Hash des Code-Nachweises. Eine Startprobe wird genau einmal übernommen, auch wenn zwei Labore gleichzeitig fragen. Das Labor selbst hat weder Datenbankzugang noch Hauptschlüssel: Sein Image enthält vom Server nur die Dateien des Labors, sein Compose-Dienst bekommt nur sein Token.
- Fundstelle: docs/BAREMETAL.md (Abschnitte 12.3 und 25.C7), licenses/restow-lab-NOTICES.md
- Öffentliche Seite: nicht abgeglichen
- Tests: apps/worker/src/endpoints/boot-probe.pg.test.ts, apps/worker/src/lab/lab.test.ts, scripts/docker/lab-image.test.mjs
- Belegt gegen: beides (PostgreSQL 16 und die Dateien des Images und der Compose-Dienste, Jobs test und docker in ci.yml)
- Stand: belegt

### COPY-001
- Aussage: Die Speicherprüfung bringt ein Kopie-Ziel auf den Stand des primären: fehlende Schlüssel, Manifeste und Packs werden kopiert. Nach einer Sicherung liegt das Manifest auch auf den Kopien.
- Fundstelle: docs/STORAGE.md (Abschnitt „Targets and roles“), README.md (Abschnitt „What it does“, „Storage you choose“)
- Öffentliche Seite: nicht abgeglichen
- Tests: apps/worker/src/handlers/scrub.test.ts, apps/worker/src/handlers/backup.test.ts
- Belegt gegen: Simulator (Chunk-Speicher im Arbeitsspeicher oder in einem Verzeichnis, Job test in ci.yml; kein Objektspeicher)
- Stand: belegt

### COPY-002
- Aussage: Antwortet das primäre Ziel nicht oder hat es die Daten verloren, lesen Prüfung und Wiederherstellung von der Kopie, und eine fehlende Antwort des primären Ziels gilt dabei nie als fehlende Daten.
- Fundstelle: docs/STORAGE.md (Abschnitte „Targets and roles“ und „Restoring from a copy“)
- Öffentliche Seite: nicht abgeglichen
- Tests: packages/core/src/verify/engine.test.ts, apps/api/src/features/pve/pve.pg.test.ts, apps/api/src/features/endpoints/endpoints.restic.pg.test.ts
- Belegt gegen: echtes System (restic und PostgreSQL 16, Job test in ci.yml)
- Stand: belegt

### COPY-003
- Aussage: Nach dem Austausch des primären Ziels mit „keep“ bleiben die vorhandenen Sicherungen wiederherstellbar: Wiederherstellung, Prüfung und Download lesen einen Sicherungsstand, der nur auf dem vorherigen Ziel liegt, und schreiben dort nie.
- Fundstelle: README.md (Abschnitt „What it does“, „Storage you choose“: „replacement of the primary without losing access to existing backups“), docs/STORAGE.md (Abschnitt „Replacing the primary“)
- Öffentliche Seite: nicht abgeglichen
- Tests: apps/worker/src/framework.test.ts, apps/worker/src/framework.pg.test.ts
- Belegt gegen: echtes System (Chunk-Speicher in einem Verzeichnis und PostgreSQL 16, Job test in ci.yml; das Speicherziel selbst ist ein lokales Verzeichnis, kein Objektspeicher)
- Stand: belegt

## Updates: Signatur, Sicherung, Migrationen, Rollback (UPDATE)

### UPDATE-001
- Aussage: Ein Release, das keinen Image-Digest veröffentlicht, wird nicht installiert: Es wird nicht angekündigt, und ein Lauf ohne Digest endet vor jedem Pull als unverändert mit `fetch.digest_missing`.
- Fundstelle: docs/UPDATING.md (Abschnitt „What is verified“, Punkt 1), packages/i18n/resources/en/updates.json (`install.unverifiable`)
- Öffentliche Seite: nicht abgeglichen
- Tests: apps/api/src/updater/engine.test.ts
- Belegt gegen: Simulator (simulierte Docker-Engine und simulierte Signaturprüfung, Job test in ci.yml; der Nachweis gegen einen echten Docker-Daemon, scripts/updater-e2e/run.mjs, läuft in keinem Workflow)
- Stand: belegt

### UPDATE-002
- Aussage: Vor dem Pull wird jedes Image an seinem Digest geprüft: Es muss die Signatur des Release-Workflows genau dieser Version tragen. Fehlt die Signatur oder stammt sie von einem anderen Unterzeichner, wird nichts installiert.
- Fundstelle: docs/UPDATING.md (Abschnitt „What is verified“, Punkt 2), packages/i18n/resources/en/updates.json (`signature_invalid`: „It was not used“)
- Öffentliche Seite: nicht abgeglichen
- Tests: apps/api/src/updater/engine.test.ts
- Belegt gegen: Simulator (simulierte Docker-Engine und simulierte Signaturprüfung, Job test in ci.yml; der Nachweis gegen einen echten Docker-Daemon, scripts/updater-e2e/run.mjs, läuft in keinem Workflow)
- Stand: belegt
- Hinweis: Die Tests prüfen, dass der Updater die Signaturprüfung mit der richtigen Identität aufruft und ihr Ergebnis befolgt. Die Signaturprüfung selbst (cosign gegen die Registry) ist darin eine Attrappe.

### UPDATE-003
- Aussage: Das gezogene Image muss den geprüften Digest tragen; sonst endet der Lauf unverändert (`fetch.digest_mismatch`), für das Anwendungs- wie für das Web-Image.
- Fundstelle: docs/UPDATING.md (Abschnitt „What is verified“, Punkt 3)
- Öffentliche Seite: nicht abgeglichen
- Tests: apps/api/src/updater/engine-failures.test.ts
- Belegt gegen: Simulator (simulierte Docker-Engine und simulierte Signaturprüfung, Job test in ci.yml; der Nachweis gegen einen echten Docker-Daemon, scripts/updater-e2e/run.mjs, läuft in keinem Workflow)
- Stand: belegt

### UPDATE-004
- Aussage: Vor jedem Update wird die Datenbank gesichert und der Dump auf Lesbarkeit geprüft, bevor etwas gestoppt wird. Scheitert die Sicherung oder ist der Dump nicht prüfbar, endet der Lauf unverändert.
- Fundstelle: docs/UPDATING.md (Abschnitt „What an update does“, Schritt 3), packages/i18n/resources/en/updates.json (`install.effects.backup`)
- Öffentliche Seite: nicht abgeglichen
- Tests: apps/api/src/updater/engine-failures.test.ts, apps/api/src/updater/engine.test.ts
- Belegt gegen: Simulator (simulierte Docker-Engine und simulierte Signaturprüfung, Job test in ci.yml; der Nachweis gegen einen echten Docker-Daemon, scripts/updater-e2e/run.mjs, läuft in keinem Workflow)
- Stand: belegt

### UPDATE-005
- Aussage: Die letzten drei Dumps bleiben erhalten, dazu derjenige, von dem ein Lauf abhängt, der Aufmerksamkeit braucht.
- Fundstelle: docs/UPDATING.md (Abschnitt „What an update does“, Schritt 3), packages/i18n/resources/en/updates.json (`install.effects.backup`: „The last three backups are kept“)
- Öffentliche Seite: nicht abgeglichen
- Tests: apps/api/src/updater/dumps.test.ts, apps/api/src/updater/engine-failures.test.ts
- Belegt gegen: echtes System (Dateisystem, Job test in ci.yml)
- Stand: belegt

### UPDATE-006
- Aussage: Startet die neue Version nicht und sind ihre Datenbankmigrationen nicht gelaufen, stellt der Updater die vorherige Version wieder her: die vorherigen Images laufen, und `.env` ist Byte für Byte zurückgeschrieben.
- Fundstelle: docs/UPDATING.md (Abschnitte „When something goes wrong“, „Rolled back“ und „Rollback“), packages/i18n/resources/en/updates.json (`rolled_back`)
- Öffentliche Seite: nicht abgeglichen
- Tests: apps/api/src/updater/engine-failures.test.ts
- Belegt gegen: Simulator (simulierte Docker-Engine und simulierte Signaturprüfung, Job test in ci.yml; der Nachweis gegen einen echten Docker-Daemon, scripts/updater-e2e/run.mjs, läuft in keinem Workflow)
- Stand: belegt

### UPDATE-007
- Aussage: Scheitert die neue Version, nachdem ihre Migrationen gelaufen sind, oder ist der Stand der Migrationen unbekannt, startet der Updater die alte Version nicht auf der migrierten Datenbank: Er stoppt api, worker und scheduler, behält den Dump und nennt die Schritte.
- Fundstelle: docs/UPDATING.md (Abschnitt „When something goes wrong“, „Needs attention“)
- Öffentliche Seite: nicht abgeglichen
- Tests: apps/api/src/updater/engine-failures.test.ts
- Belegt gegen: Simulator (simulierte Docker-Engine und simulierte Signaturprüfung, Job test in ci.yml; der Nachweis gegen einen echten Docker-Daemon, scripts/updater-e2e/run.mjs, läuft in keinem Workflow)
- Stand: belegt

### UPDATE-008
- Aussage: Startet die neue Version nicht, bevor ihre Datenbankmigrationen gelaufen sind, wird automatisch die vorherige Version wiederhergestellt. Scheitert sie danach, werden api, worker und scheduler angehalten, und die Datenbanksicherung bleibt für eine Wiederherstellung von Hand erhalten. Dasselbe gilt für den Wechsel auf den vollen Build.
- Fundstelle: packages/i18n/resources/en/updates.json (`install.effects.rollback`, `edition.switch.updater`), packages/i18n/resources/de/updates.json (dieselben Schlüssel), docs/UPDATING.md (Abschnitt „When something goes wrong“)
- Öffentliche Seite: nicht abgeglichen
- Tests: apps/api/src/updater/engine-failures.test.ts, apps/api/src/updater/engine-switch.test.ts
- Belegt gegen: Simulator (simulierte Docker-Engine und simulierte Signaturprüfung, Job test in ci.yml; der Nachweis gegen einen echten Docker-Daemon, scripts/updater-e2e/run.mjs, läuft in keinem Workflow)
- Stand: belegt
- Hinweis: Bis zum Commit bffb8ffb versprach der Dialog „What will happen“ das Zurücksetzen ohne Bedingung („If the new version does not start, the previous version is restored automatically.“), und der Eintrag stand auf „Abweichung“. Geändert wurde der Text, nicht das Verhalten.

### UPDATE-009
- Aussage: Ein Update, dessen Dump, Images und Migrationen nicht auf die Platte passen, wird vor dem Start abgelehnt (Sperrgrund `disk_space`).
- Fundstelle: docs/UPDATING.md (Abschnitt „Disk space“)
- Öffentliche Seite: nicht abgeglichen
- Tests: apps/api/src/updater/space.test.ts
- Belegt gegen: Simulator (simulierte Docker-Engine und simulierte Signaturprüfung, Job test in ci.yml; der Nachweis gegen einen echten Docker-Daemon, scripts/updater-e2e/run.mjs, läuft in keinem Workflow)
- Stand: belegt

### UPDATE-010
- Aussage: Wird der Updater mitten im Lauf neu gestartet, wird der Lauf als unterbrochen vermerkt (unverändert, wenn noch nichts gestoppt war, sonst „braucht Aufmerksamkeit“), und nichts wird von selbst gestartet.
- Fundstelle: docs/UPDATING.md (Abschnitt „When something goes wrong“, vorletzter Absatz)
- Öffentliche Seite: nicht abgeglichen
- Tests: apps/api/src/updater/engine-recovery.test.ts
- Belegt gegen: Simulator (simulierte Docker-Engine und simulierte Signaturprüfung, Job test in ci.yml; der Nachweis gegen einen echten Docker-Daemon, scripts/updater-e2e/run.mjs, läuft in keinem Workflow)
- Stand: belegt

### UPDATE-011
- Aussage: Der Updater folgt nie den Variablen, die er selbst umschreibt, und wechselt sein eigenes Image nur auf das signaturgeprüfte Image eines erfolgreichen Updates; nie auf ein selbst gebautes und nie ohne geprüfte Signatur.
- Fundstelle: docs/UPDATING.md (Abschnitt „Security note“ und „The updater updates itself“), packages/i18n/resources/en/updates.json (`source_mode`, `signature_unverified`)
- Öffentliche Seite: nicht abgeglichen
- Tests: apps/api/src/updater/preflight.test.ts, apps/api/src/updater/self-update.test.ts
- Belegt gegen: Simulator (simulierte Docker-Engine und simulierte Signaturprüfung, Job test in ci.yml; der Nachweis gegen einen echten Docker-Daemon, scripts/updater-e2e/run.mjs, läuft in keinem Workflow)
- Stand: belegt

### UPDATE-012
- Aussage: Der Updater hat keinen Datenbankzugang und kein Anwendungsgeheimnis, und kein Geheimnis (gemeinsames Geheimnis, Datenbankpasswort, Token) gelangt in seinen Zustand, sein Log oder sein Journal.
- Fundstelle: docs/UPDATING.md (Abschnitt „Security note: read this before you enable it“)
- Öffentliche Seite: nicht abgeglichen
- Tests: apps/api/src/updater/boundary.test.ts, apps/api/src/updater/engine.test.ts
- Belegt gegen: Logik (Einheitentest ohne Fremdsystem, Job test in ci.yml)
- Stand: belegt

### UPDATE-013
- Aussage: Der Quellmodus ist aus, solange der Betreiber kein Repository in `RESTOW_UPDATER_SOURCE_HOSTS` freigibt; eine nicht freigegebene Quelle wird abgelehnt, bevor etwas angekündigt wird.
- Fundstelle: docs/UPDATING.md (Abschnitt „Security note“)
- Öffentliche Seite: nicht abgeglichen
- Tests: apps/api/src/updater/source-policy.test.ts, apps/api/src/updater/engine.test.ts
- Belegt gegen: Logik (Einheitentest ohne Fremdsystem, Job test in ci.yml)
- Stand: belegt

### UPDATE-014
- Aussage: Die Update-Quelle ändern, das Zugriffstoken setzen und ein Update ankündigen verlangen neben der Inhaberrolle eine Anmeldung aus den letzten zehn Minuten; sonst antwortet die API mit 403 `recent-sign-in-required`.
- Fundstelle: docs/UPDATING.md (Abschnitt „Confirming it is you“)
- Öffentliche Seite: nicht abgeglichen
- Tests: apps/api/src/features/updates/routes.test.ts
- Belegt gegen: Logik (Einheitentest ohne Fremdsystem, Job test in ci.yml)
- Stand: belegt

### UPDATE-015
- Aussage: Nichts davon geschieht, ohne dass es eingeschaltet wird: Bei ausgeschalteter Prüfung nimmt die Installation für Updates keinen Kontakt nach außen auf.
- Fundstelle: docs/UPDATING.md (Einleitung: „A fresh installation does not look for updates, does not contact any server for that purpose“)
- Öffentliche Seite: nicht abgeglichen
- Tests: apps/api/src/features/updates/updates.pg.test.ts
- Belegt gegen: echtes System (PostgreSQL 16, Job test in ci.yml)
- Stand: belegt

### UPDATE-016
- Aussage: Der Agent installiert nur Releases, die der Maintainer signiert hat: Ein unsigniertes oder verändertes Release wird abgelehnt, bevor etwas ersetzt wird.
- Fundstelle: README.md (Abschnitt „What it does“, „Endpoint backup“: „updated only with releases the maintainer signed“), SECURITY.md (Abschnitt „Verifying releases“), docs/AGENT.md (Abschnitt „Signierte Releases“)
- Öffentliche Seite: nicht abgeglichen
- Tests: agent/internal/core/update_now_test.go, agent/internal/release/release_test.go, agent/scripts/test-install.sh
- Belegt gegen: echtes System (Signaturen aus `ssh-keygen`, Installationsskript in einem Linux-Container, Job agent in ci.yml; die Windows-Installation im Job agent-windows; macOS nie)
- Stand: belegt

### UPDATE-017
- Aussage: Das Update von der vorherigen Version auf die neue läuft mit echten Daten durch: Die api wendet ihre Migrationen beim Start an, und ein Neustart auf der gefüllten Datenbank ändert nichts mehr.
- Fundstelle: README.md (Abschnitt „How Restow is built“: „migrations on a fresh and an upgraded database“), docs/CI.md (Smoke-Check 1)
- Öffentliche Seite: nicht abgeglichen
- Tests: scripts/smoke/checks/01-install.mjs, packages/db/src/migrate.pg.test.ts
- Belegt gegen: echtes System (der Release-Stack in Docker im Smoke-Check 1, smoke.yml jede Nacht und release.yml vor jedem Release; PostgreSQL 16 im Job test in ci.yml)
- Stand: belegt
- Hinweis: Der Schritt „upgrade path“ des Smoke-Checks braucht die Images des vorherigen Release (`--previous-image`). Die nächtliche smoke.yml übergibt sie nicht; dort wird der Schritt als nicht gelaufen gemeldet. Er läuft nur im Release.

### UPDATE-018
- Aussage: Läuft das Wiederherstellungslabor (`RESTOW_LAB_IMAGE` in `.env`), bewegt der opt-in Updater sein Image auf das Labor-Image der Zielversion: Signatur und Digest werden wie bei den anderen Images geprüft, bevor etwas heruntergeladen wird; ein ungültiges Labor-Image beendet den Lauf unverändert. Bei einem Rückfall ohne gelaufene Migration steht die alte Zeile Byte für Byte wieder in `.env` und das Labor läuft wieder mit ihr. Eine Installation ohne Labor bleibt unberührt.
- Fundstelle: docs/UPDATING.md (Abschnitt „The recovery lab“), docs/BAREMETAL.md (Abschnitt 26.15), CHANGELOG.md (Upgrade Notes)
- Öffentliche Seite: nicht abgeglichen
- Tests: apps/api/src/updater/engine-lab.test.ts, apps/api/src/updater/config.test.ts, apps/api/src/features/updates/feed.test.ts, deploy/install/test.sh
- Belegt gegen: Simulator (simulierte Docker-Engine und simulierte Signaturprüfung, Job test in ci.yml; der Nachweis gegen einen echten Docker-Daemon, scripts/updater-e2e/run.mjs, läuft in keinem Workflow und kennt das Labor nicht)
- Stand: belegt

## Lizenzschlüssel und Editionen (LICENSE)

### LICENSE-001
- Aussage: Lizenzschlüssel werden offline geprüft: Ein veränderter Schlüssel und ein Schlüssel für eine andere Installation werden abgelehnt.
- Fundstelle: docs/LICENSING.md (Abschnitt „In short“), README.md (Abschnitt „Editions“: „offline-verified license key (Ed25519, no phone-home)“)
- Öffentliche Seite: nicht abgeglichen
- Tests: ee/licensing/src/token.test.ts, ee/api/src/license/license.pg.test.ts
- Belegt gegen: echtes System (PostgreSQL 16, Job test in ci.yml; die Bewertungsregel zusätzlich als Einheitentest)
- Stand: belegt

### LICENSE-002
- Aussage: Kein Schlüssel läuft ab: Restow liest nie die Uhr, um zu entscheiden, was funktioniert. Ein abgedecktes Release bleibt auch Jahre später abgedeckt.
- Fundstelle: docs/LICENSING.md (Abschnitte „In short“ und „What does not change“)
- Öffentliche Seite: nicht abgeglichen
- Tests: ee/licensing/src/entitlement.test.ts
- Belegt gegen: Logik (Einheitentest ohne Fremdsystem, Job test in ci.yml)
- Stand: belegt

### LICENSE-003
- Aussage: Ein Schlüssel mit Update-Zeitraum deckt jedes Release, das bis zum Ende des letzten Tages (UTC) erstellt wurde, gleich welcher Version; ein Release vom Tag danach nicht. Ein Build ohne Release-Datum gilt als abgedeckt.
- Fundstelle: docs/LICENSING.md (Abschnitt „What a key covers“)
- Öffentliche Seite: nicht abgeglichen
- Tests: ee/licensing/src/entitlement.test.ts
- Belegt gegen: Logik (Einheitentest ohne Fremdsystem, Job test in ci.yml)
- Stand: belegt

### LICENSE-004
- Aussage: Ein Release ohne Schlüsselabdeckung stoppt vor den Migrationen: Startet eine Version, die der installierte Business- oder Service-Provider-Schlüssel nicht abdeckt, prüft die api den Schlüssel vor jeder Datenbankmigration, startet nicht und schreibt nichts in die Datenbank.
- Fundstelle: docs/LICENSING.md (Abschnitt „When a version starts that the key does not cover“), docs/UPDATING.md (Abschnitt „Licence keys and updates (full build)“)
- Öffentliche Seite: nicht abgeglichen
- Tests: scripts/docker/entrypoint.test.mjs, ee/api/src/license/startup-check.test.ts, ee/api/src/license/license.pg.test.ts, ee/licensing/src/startup-check.test.ts
- Belegt gegen: echtes System (das Startskript des Images, aus dem Dockerfile geschnitten, im Job docker in ci.yml; die Prüfung gegen PostgreSQL 16 im Job test in ci.yml; nicht mit einem gebauten Image und einem echten Schlüssel)
- Stand: belegt
- Hinweis: Die Reihenfolge im Startskript prüft erst der neue Test scripts/docker/entrypoint.test.mjs; vorher belegte kein Test, dass die Prüfung vor den Migrationen läuft.

### LICENSE-005
- Aussage: Mit `RESTOW_RUN_AS_COMMUNITY=1` startet eine nicht abgedeckte Version als Community: Die Module bleiben aus, der Schlüssel bleibt sichtbar, und ohne die Variable ändert sich zur Laufzeit nichts.
- Fundstelle: docs/LICENSING.md (Abschnitt „When a version starts that the key does not cover“)
- Öffentliche Seite: nicht abgeglichen
- Tests: ee/api/src/license/license.pg.test.ts, ee/api/src/license/startup-check.test.ts, ee/licensing/src/startup-check.test.ts
- Belegt gegen: echtes System (PostgreSQL 16, Job test in ci.yml; die Bewertungsregel zusätzlich als Einheitentest)
- Stand: belegt

### LICENSE-006
- Aussage: Die Startprüfung hält nie eine Installation ohne Schlüssel, eine Beta-Lizenz auf 0.x oder 1.x, einen Entwicklungs-Build oder einen Start an, dessen Datenbank nicht lesbar ist.
- Fundstelle: docs/LICENSING.md (Abschnitt „When a version starts that the key does not cover“, „The check never stops“)
- Öffentliche Seite: nicht abgeglichen
- Tests: ee/licensing/src/startup-check.test.ts, ee/api/src/license/startup-check.test.ts
- Belegt gegen: Logik (Einheitentest ohne Fremdsystem, Job test in ci.yml)
- Stand: belegt

### LICENSE-007
- Aussage: Ein Schlüssel, der die laufende Version nicht abdeckt, wird beim Installieren abgelehnt (`outside_update_period`), und der wirksame Schlüssel bleibt.
- Fundstelle: docs/LICENSING.md (Abschnitt „Installing a key“)
- Öffentliche Seite: nicht abgeglichen
- Tests: ee/api/src/license/license.pg.test.ts
- Belegt gegen: echtes System (PostgreSQL 16, Job test in ci.yml)
- Stand: belegt

### LICENSE-008
- Aussage: Die Update-Prüfung bietet nur Releases an, die der installierte Schlüssel abdeckt, und der Updater installiert nur solche (409 `update-not-covered`).
- Fundstelle: docs/LICENSING.md (Abschnitt „Updating“), packages/i18n/resources/en/updates.json (`notCovered`)
- Öffentliche Seite: nicht abgeglichen
- Tests: apps/api/src/features/updates/updates.pg.test.ts, ee/api/src/license/license.pg.test.ts
- Belegt gegen: echtes System (PostgreSQL 16, Job test in ci.yml)
- Stand: belegt

### LICENSE-009
- Aussage: Ohne Schlüssel läuft die Installation als Community; `RESTOW_EDITION` zählt nur im Demo-Modus.
- Fundstelle: docs/LICENSING.md (Einleitung), docs/CI.md (Abschnitt „The license key of the full build“)
- Öffentliche Seite: nicht abgeglichen
- Tests: ee/licensing/src/editions.test.ts, ee/api/src/license/gate.test.ts, ee/licensing/src/capabilities.test.ts
- Belegt gegen: Logik (Einheitentest ohne Fremdsystem, Job test in ci.yml)
- Stand: belegt

### LICENSE-010
- Aussage: Der Community-Build enthält keinen `ee/`-Code und keine Lizenz-API (404) und hat genau einen Mandanten; ein zweiter wird mit 403 `feature-unavailable` abgelehnt.
- Fundstelle: README.md (Abschnitt „Editions“), docs/CI.md (Abschnitte „Two build targets“ und „The Community build“)
- Öffentliche Seite: nicht abgeglichen
- Tests: scripts/smoke/checks/03-passkey.mjs, scripts/docker/strip-ee.test.mjs, scripts/docker/check-image-tree.test.mjs
- Belegt gegen: echtes System (die gebauten Community-Images im Smoke-Check 3, smoke.yml jede Nacht und release.yml; die Prüfung des Image-Inhalts im Job docker in ci.yml)
- Stand: belegt

### LICENSE-011
- Aussage: Postfach- und Mandantenzahlen sind keine Grenze in der Software: Das Feld `mailbox_limit` eines Schlüssels hat keine Wirkung.
- Fundstelle: README.md (Abschnitt „Editions“: „Mailbox and tenant counts are an honour rule of the license terms, not a limit in the software“), docs/LICENSING.md (Abschnitt „What does not change“)
- Öffentliche Seite: nicht abgeglichen
- Tests: ee/api/src/license/license.pg.test.ts, ee/licensing/src/token.test.ts
- Belegt gegen: echtes System (PostgreSQL 16, Job test in ci.yml; die Bewertungsregel zusätzlich als Einheitentest)
- Stand: belegt

### LICENSE-012
- Aussage: Restow nimmt nie Kontakt zu einem Lizenzserver auf und meldet nichts nach außen.
- Fundstelle: docs/LICENSING.md (Abschnitt „In short“: „Restow never contacts a licence server, never reports anything“), README.md (Abschnitt „Editions“: „no phone-home“)
- Öffentliche Seite: nicht abgeglichen
- Tests: keine
- Belegt gegen: nichts
- Stand: nur behauptet
- Grund: Eine Negativaussage über das ganze Produkt. Ein Test müsste jeden ausgehenden Netzwerkzugriff aller Rollen beobachten; die Pipeline hat dafür keine Messstelle. Belegt ist nur der Teil für die Update-Prüfung (UPDATE-015).

### LICENSE-013
- Aussage: Keine Edition begrenzt die Wiederherstellung.
- Fundstelle: README.md (Abschnitt „Editions“: „All editions are self-hosted, have no mailbox limit and never limit restore“)
- Öffentliche Seite: nicht abgeglichen
- Tests: keine
- Belegt gegen: nichts
- Stand: nur behauptet
- Grund: Kein Test stellt in der Community-Edition jede Quelle wieder her und vergleicht mit den lizenzierten Editionen. Belegt ist nur, dass die Wiederherstellungsrouten keine Lizenzprüfung tragen, soweit die Tests der einzelnen Quellen ohne Schlüssel laufen; als Aussage über alle Editionen bleibt es eine Behauptung.

## Alarme und Benachrichtigungen (ALERT)

### ALERT-001
- Aussage: Kritische Ereignisse (`backup.suspicious`, `endpoint.suspicious_snapshot`, `scrub.corrupt`, `verify.red`, `installation.disk_low`, `endpoint.backups_deletion_scheduled`, `backup.unusually_large`, `installation.disk_reserve_released`) werden sofort gesendet, nie für eine Sammelmail zurückgehalten, erreichen immer die Inhaber und Pflichtempfänger und stehen immer in der Glocke.
- Fundstelle: docs/NOTIFICATIONS.md (Abschnitte „Critical events“ und „Recipients and the floor“)
- Öffentliche Seite: nicht abgeglichen
- Tests: packages/core/src/reports/catalog.test.ts, packages/core/src/reports/rules.test.ts, apps/api/src/features/reports/notifications-050.pg.test.ts
- Belegt gegen: echtes System (PostgreSQL 16, Job test in ci.yml; die Bewertungsregel zusätzlich als Einheitentest)
- Stand: belegt

### ALERT-002
- Aussage: Eine fehlgeschlagene Sicherung löst `backup.failed` aus, mit der Ursache und den Schritten zur Abhilfe; technische Einzelheiten und Geheimnisse verlassen das System nicht. Eine Sicherung, die nur gedrosselt oder aufgehalten wurde, löst nichts aus.
- Fundstelle: README.md (Abschnitt „What it does“, „Alerts and reports“), docs/MICROSOFT.md (Abschnitt „Warnungen: Läufe mit nicht gesicherten Elementen“)
- Öffentliche Seite: nicht abgeglichen
- Tests: apps/worker/src/reporting.test.ts, apps/worker/src/reporting.pg.test.ts, apps/worker/src/failure.pg.test.ts
- Belegt gegen: echtes System (PostgreSQL 16, Job test in ci.yml)
- Stand: belegt

### ALERT-003
- Aussage: Eine Sicherung, die für ihren Zeitplan überfällig ist, löst `backup.overdue` aus, einmal je Strecke, und nach einer erfolgreichen Sicherung beginnt eine neue Strecke. Ein Objekt in keinem Auftrag löst nichts aus.
- Fundstelle: README.md (Abschnitt „What it does“, „Alerts and reports“: „is overdue for its schedule“)
- Öffentliche Seite: nicht abgeglichen
- Tests: apps/worker/src/overdue.pg.test.ts
- Belegt gegen: echtes System (PostgreSQL 16, Job test in ci.yml)
- Stand: belegt

### ALERT-004
- Aussage: Kann eine Benachrichtigung nicht zugestellt werden, wird `notification.delivery_failed` ausgelöst und nie über den Kanal gesendet, der ausgefallen ist.
- Fundstelle: docs/NOTIFICATIONS.md (Abschnitt „Delivery failures“)
- Öffentliche Seite: nicht abgeglichen
- Tests: packages/core/src/reports/rules.test.ts
- Belegt gegen: Logik (Einheitentest ohne Fremdsystem, Job test in ci.yml)
- Stand: belegt

### ALERT-005
- Aussage: Ein Administrator kann einen Pflichtempfänger weder entfernen noch auf eine andere Adresse umleiten; nur Inhaber können das.
- Fundstelle: docs/NOTIFICATIONS.md (Abschnitt „Recipients and the floor“, „Mandatory recipients“)
- Öffentliche Seite: nicht abgeglichen
- Tests: apps/api/src/features/reports/notifications-050.pg.test.ts
- Belegt gegen: echtes System (PostgreSQL 16, Job test in ci.yml)
- Stand: belegt

### ALERT-006
- Aussage: Wird die Platte der Datenbank, des lokalen Standard-Repositorys oder des Systems knapp (unter einem Zehntel ihrer Größe, immer unter 5 GiB), wird `installation.disk_low` einmal je Episode gemeldet.
- Fundstelle: docs/DATABASE.md (Abschnitt „Disk space“), docs/NOTIFICATIONS.md (Abschnitt „Critical events“)
- Öffentliche Seite: nicht abgeglichen
- Tests: apps/api/src/features/updates/database.pg.test.ts
- Belegt gegen: Simulator (die Plattenwerte sind vorgegeben; Zustand und Meldung gegen PostgreSQL 16 im Job test in ci.yml)
- Stand: belegt
- Hinweis: Geprüft wird alle 15 Minuten (apps/api/src/features/updates/disk-watch.ts). S3-Ziele, eingehängte Netzfreigaben und das eigene Repository eines Mandanten werden nicht überwacht.

### ALERT-007
- Aussage: Vor dem Ablauf des Geheimnisses oder Zertifikats der App-Registrierung einer Quelle erinnert Restow 30 Tage und 7 Tage vorher und noch einmal nach dem Ablauf, dann als Fehler (`source.app_secret_expiring`).
- Fundstelle: packages/core/src/reports/catalog.ts (`source.app_secret_expiring`), docs/MICROSOFT.md (Abschnitt „App-Registrierung“)
- Öffentliche Seite: nicht abgeglichen
- Tests: apps/worker/src/source-app-expiry.pg.test.ts
- Belegt gegen: echtes System (PostgreSQL 16, Job test in ci.yml)
- Stand: belegt
- Hinweis: Die Erinnerung setzt voraus, dass das Ablaufdatum hinterlegt ist. Ein Geheimnis, das im Mandanten vorzeitig rotiert oder gelöscht wird, kündigt sich nicht an; es fällt mit dem nächsten Lauf auf (FAULT-009).

### ALERT-008
- Aussage: Wird die Anmeldung eines IMAP-Kontos abgelehnt, fragt Restow nach 3 gezählten Fehlschlägen über mindestens 24 Stunden genau einmal je Strecke, ob das Konto abgeschaltet wurde; eine Anmeldung, die wieder funktioniert, beendet Strecke und Frage.
- Fundstelle: docs/IMAP.md (Abschnitt „Anmeldung abgelehnt: Konto abgeschaltet?“)
- Öffentliche Seite: nicht abgeglichen
- Tests: apps/worker/src/imap-login-state.pg.test.ts
- Belegt gegen: echtes System (PostgreSQL 16, Job test in ci.yml)
- Stand: belegt

### ALERT-009
- Aussage: Eine Wiederherstellung, die durchlief, aber nichts wiederherstellte, während Elemente scheiterten, löst `restore.failed` aus wie eine fehlgeschlagene.
- Fundstelle: apps/worker/src/reporting.ts (Kopfkommentar zu `jobFinishedNotification`), README.md (Abschnitt „What it does“, „Alerts and reports“)
- Öffentliche Seite: nicht abgeglichen
- Tests: apps/worker/src/reporting.test.ts, apps/worker/src/reporting.pg.test.ts
- Belegt gegen: echtes System (PostgreSQL 16, Job test in ci.yml)
- Stand: belegt

### ALERT-010
- Aussage: Eine Sicherung, die weit mehr als üblich schreibt, wird standardmäßig nicht angehalten: Sie läuft weiter und löst einmal je Lauf den nicht kritischen Hinweis `backup.unusually_large_notice` aus, ohne Halt. Angehalten wird ein Lauf nur, wenn sein Speicherziel zu wenig freien Platz behielte, oder wenn die Größenprüfung seines Objekts oder Mandanten auf „Anhalten“ steht; dann löst er `backup.unusually_large` aus.
- Fundstelle: docs/STORAGE.md (Abschnitt „Unusually large runs“), docs/NOTIFICATIONS.md (Abschnitt „Critical events“), CHANGELOG.md (0.5.0, #99)
- Öffentliche Seite: nicht abgeglichen
- Tests: apps/api/src/features/run-size/run-size.pg.test.ts
- Belegt gegen: echtes System (PostgreSQL 16, Job test in ci.yml)
- Stand: belegt

### ALERT-011
- Aussage: Auch Sicherungen von Proxmox-VE-VMs werden gemessen: Was ein Lauf an neuen Daten in den Chunk-Speicher schreibt, gilt gegen die bisherigen VM-Läufe des Gasts. Standardmäßig löst ein ungewöhnlich großer Lauf einen Hinweis aus und läuft weiter, mit „Anhalten“ wird er angehalten und endet als „angehalten“; zu wenig freier Platz auf dem Speicherziel hält ihn immer an. Die erste Sicherung und ein Lauf ohne Basis-Wiederherstellungspunkt beginnen eine neue Kette und gelten nie als ungewöhnlich groß; ein erneutes Lesen nach verlorener Dirty-Bitmap zählt nur, was sich geändert hat.
- Fundstelle: docs/STORAGE.md (Abschnitt „Unusually large runs“), docs/PVE.md (Abschnitt „Jobs, backups, retention“, „Unusually large backups“), CHANGELOG.md (0.5.0, #99)
- Öffentliche Seite: nicht abgeglichen
- Tests: apps/api/src/features/pve/vm-size-guard.pg.test.ts
- Belegt gegen: echtes System (PostgreSQL 16, Job test in ci.yml)
- Stand: belegt

### ALERT-012
- Aussage: Ein roter Bericht von Stufe 1 oder der Startprobe löst `baremetal.red` einmal je Episode aus und jedes Mal `job.failed`; besteht der Rechner danach wieder, folgt `baremetal.recovered`. Ist die bestandene Startprobe älter als 8 Tage, kommt `baremetal.overdue` einmal.
- Fundstelle: docs/BAREMETAL.md (Abschnitt 12.6), packages/i18n/resources/en/reports.json (`events.baremetal`, `eventHints.baremetal`)
- Öffentliche Seite: nicht abgeglichen
- Tests: apps/worker/src/endpoints/boot-probe.pg.test.ts
- Belegt gegen: echtes System (PostgreSQL 16, Job test in ci.yml)
- Stand: belegt

## Archiv und Audit-Log (ARCHIVE)

### ARCHIVE-001
- Aussage: Die Kettenprüfung des Archivs erkennt ein verändertes Element an seiner Stelle und meldet den ersten Bruch; eine von Hand entfernte Zeile macht die Kette rot, eine regelgerechte Löschung nicht.
- Fundstelle: README.md (Abschnitt „What it does“, „Archive“: „SHA-256 hash chain, chain verification“), docs/ARCHIVE.md (Hash-Kette)
- Öffentliche Seite: nicht abgeglichen
- Tests: packages/core/src/archive/chain.test.ts, apps/api/src/features/archive/archive.pg.test.ts, ee/worker/src/archive-retention/archive-retention.pg.test.ts, scripts/smoke/checks/06-journal.mjs
- Belegt gegen: beides (Einheitentests und PostgreSQL 16 im Job test in ci.yml; der Journal-Empfänger und die Kettenprüfung im Release-Stack im Smoke-Check 6)
- Stand: belegt
- Hinweis: Die Kettenprüfung läuft nur auf Abruf; ein täglicher automatischer Lauf ist laut docs/TESTING.md Zielbild und nicht umgesetzt. Auf lokalen und NFS-Zielen ist die Unveränderlichkeit des Archivs laut README.md nur von der Anwendung erzwungen.

### ARCHIVE-002
- Aussage: Das Audit-Log ist eine Hash-Kette, die Manipulation erkennbar macht, und wird täglich versiegelt; die Anker lassen sich nur anfügen.
- Fundstelle: README.md (Abschnitt „What it does“, „Audit log“)
- Öffentliche Seite: nicht abgeglichen
- Tests: ee/api/src/audit-log/chain.test.ts, apps/worker/src/handlers/audit-anchor.test.ts
- Belegt gegen: echtes System (PostgreSQL 16, Job test in ci.yml)
- Stand: belegt

## Prüfungen gegen echte Systeme, die es gibt, die aber in der Pipeline nicht laufen

Diese Prüfungen stehen im Repository und würden mehrere Aussagen gegen das echte System
belegen. Sie laufen in keinem Pflicht-Check, weil ein Secret, ein Dienst oder eine Maschine
fehlt. Solange das so ist, bleibt bei den betroffenen Aussagen "Simulator" stehen.

- **Microsoft 365** (Smoke-Check 4, `scripts/smoke/checks/04-m365.mjs`): braucht die fünf
  Repository-Secrets `M365_TEST_TENANT_ID`, `M365_TEST_CLIENT_ID`, `M365_TEST_CLIENT_SECRET`,
  `M365_TEST_MAILBOX` und `M365_TEST_RESTORE_MAILBOX`. Ohne sie meldet der Bericht
  "skipped: no dev tenant credentials". Der Check ist bisher in jedem Release übersprungen
  worden und nie gegen einen echten Mandanten gelaufen. Betroffen: jede Aussage mit
  "simulierte Graph-API".
- **S3 mit Object Lock** (`packages/core/src/storage/immutability.s3.test.ts`): braucht
  `RESTOW_TEST_S3_LOCK_ENDPOINT` (dazu Zugriffsschlüssel und Region). Kein Workflow setzt die
  Variable; der S3-Speicher des Smoke kennt weder Versionierung noch Object Lock. Betroffen:
  RETAIN-004 bis RETAIN-006.
- **Volles Dateisystem** (`packages/core/src/endpoints/restic-prune-space.test.ts`, der
  Abschnitt mit dem Loop-Device): läuft nur als root mit `losetup`, `mkfs.ext4` und `mount`.
  Die Tests von `ci.yml` laufen nicht als root. Betroffen: RETAIN-015.
- **Updater gegen einen echten Docker-Daemon** (`scripts/updater-e2e/run.mjs`, dazu
  `apps/api/src/updater/database.docker.test.ts` mit `RESTOW_UPDATER_DOCKER_TARGET`): in keinem
  Workflow. Betroffen: UPDATE-001 bis UPDATE-011.
- **Upgrade von der vorherigen Version** (Smoke-Check 1, Schritt "upgrade path"): braucht
  `--previous-image`. Nur `release.yml` übergibt es; die nächtliche `smoke.yml` meldet den
  Schritt als nicht gelaufen. Betroffen: UPDATE-017.
- **Proxmox VE** (`docs/PVE-HOST-TEST.md`): ein Ablauf von Hand auf einem echten Knoten, etwa
  45 Minuten. Betroffen: RESTORE-013 und jede weitere Aussage zu Proxmox VE.
- **macOS** (`agent/scripts/test-install-macos.sh`): braucht einen Mac. Betroffen: RESTORE-017.
- **Agent unter einem echten systemd** (`agent/scripts/test-systemd.sh`): braucht einen
  privilegierten Container und läuft in keinem Workflow.
- **SQL Server** (`sql-server.yml`): läuft jede Nacht und bei Änderungen an den SQL-Pfaden,
  gehört aber nicht zu "CI passed". Scheitert der Download von SQL Server, endet der Lauf als
  "incomplete" mit Exit 0; nur der Aufruf aus `release.yml` (`strict: true`) schlägt dann
  fehl. Betroffen: RESTORE-016.
- **Installationsskript des Servers** (`deploy/install/test.sh`): prüft gegen Attrappen. Die
  Installation selbst wird laut `docs/CI.md` von Hand auf VMs geprüft.
