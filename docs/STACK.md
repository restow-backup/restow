# Stack-Entscheidungen

Jede Abhängigkeit hier eintragen: Zweck, Lizenz, Alternative, warum gewählt.

## Sprache und Laufzeit

TypeScript auf Node 22 LTS, pnpm Workspaces. Ein Stack für API, Worker, Web und
Landingpage. Go hätte beim Chunking und bei Parallelität Vorteile, aber better-auth,
shadcn und das i18n-Ökosystem sind TypeScript; ein Sprachwechsel zwischen Engine und
Oberfläche kostet mehr, als Go bringt. Streams statt Puffer, Worker-Threads für Hashing
und Verschlüsselung, wenn der PoC zeigt, dass der Event-Loop bremst.

## Datenbank

PostgreSQL 16, Drizzle ORM (Apache-2.0), drizzle-kit Migrationen. Row Level Security
für Mandantentrennung. Volltext über tsvector/GIN mit `german`- und `english`-
Konfiguration. Kein SQLite: keine RLS, kein paralleler Schreibzugriff, schwache FTS
für Anhänge, und eine Backup-Lösung mit einer Ein-Datei-Datenbank ist ein Widerspruch.
Treiber: node-postgres `pg` (MIT), von Drizzle und pg-boss gemeinsam genutzt.

drizzle-orm 0.45 (Apache-2.0) in genau einer Version für API, Worker und `@restow/db`;
das ist zugleich die Version, die `@better-auth/drizzle-adapter` als Peer verlangt
(`^0.45.2`), damit gibt es keine zweite Kopie im Baum. Ältere Stände sind von einer
SQL-Injection über Bezeichner betroffen (behoben ab 0.45.2). Seit 0.44 verpackt Drizzle
Treiberfehler in `DrizzleQueryError`, der Postgres-Fehler steckt in `cause`; Code, der
SQLSTATEs prüft (etwa `23505` für Unique-Verletzungen), läuft deshalb die `cause`-Kette
ab. Eine Alternative gibt es nicht: die Lücke betrifft jeden Nutzer des ORM.
drizzle-kit 0.31 (MIT, Dev) passend zur ORM-Version. Der Wechsel von 0.30 erzeugt keine
Schemaänderung (`generate` meldet nichts zu migrieren). Alternative: drizzle-kit 0.30
behalten; dann driftet das Snapshot-Format gegenüber dem aktualisierten ORM.

## API

Hono (MIT) auf `@hono/node-server` (MIT): Web-Standard-Request/Response, typisierte
Sub-Apps je Feature, klein und ohne Plugin-Magie. Alternative Fastify (MIT), schneller
bei sehr vielen Requests, aber mit eigenem Plugin-Modell; der Engpass liegt bei uns in
Graph und Speicher, nicht im HTTP-Router. Request-Validierung mit zod (MIT), Fehler als
RFC 7807 (`application/problem+json`), OpenAPI-Beschreibung der Integrations-API im Code.

PDF-Berichte (Statistikbericht, später der Nachweisbericht des Archivs):
@react-pdf/renderer (MIT) mit react (MIT) serverseitig im API-Prozess. Berichte sind
React-Komponenten (`.tsx`), Kopf, Tabellen und Kennzahlenblöcke sind wiederverwendbare
Bausteine. Nur eingebaute Schriften, kein Nachladen externer Ressourcen, kein
Zusatzdienst. Alternative pdfkit (MIT): eine Ebene tiefer, ohne Komponentenmodell für
wiederverwendbare Layouts. Headless Chromium und WeasyPrint sind verworfen: ein Browser
oder eine Python-Laufzeit im Image vergrößert Image und Angriffsfläche für eine Aufgabe,
die im selben Node-Prozess lösbar ist. Für Tests (Dev): @types/react (MIT) für die
`.tsx`-Berichte und unpdf (MIT, bündelt pdf.js unter Apache-2.0), das Seitenzahl und Text
aus gerenderten PDFs liest. Alternative pdfjs-dist (Apache-2.0) direkt: dieselbe
Extraktion mit schwererer API.

## Queue

pg-boss (MIT): Jobs in Postgres, keine Redis-Instanz, Retry, Priorität, Singleton-
Jobs, Cron. Alternative BullMQ (Redis) wäre schneller bei Zehntausenden Jobs pro
Minute, das brauchen wir nicht; ein Container weniger im Compose ist mehr wert.

Der Scheduler hängt vom Workspace-Paket `@restow/core` (Apache-2.0) ab und nutzt
dessen Cron-Modul und die empfohlenen Standard-Zeitpläne. Die Zeitplan-Vorschau der API
und der Scheduler planen so mit derselben Implementierung. Alternative: eine Kopie des
Cron-Moduls im Scheduler; doppelte Logik, und die Vorschau könnte vom tatsächlichen Plan
abweichen.

## Auth

better-auth (MIT) mit Plugins:
- passkey (WebAuthn über simplewebauthn), User Verification erforderlich
- organization (Mandanten, Einladungen, Rollen)
- admin (Rolle Provider-Admin, Kontoanlage durch den Setup-Wizard)
Über HTTP erreichbar ist davon nur, was die Web-App nutzt (`apps/api/src/lib/auth-surface.ts`):
aus dem organization-Plugin die Seite des Eingeladenen (Einladung lesen, annehmen,
ablehnen; beides wird auditiert) und `set-active`, aus dem admin-Plugin nichts.
Mitglieder, Einladungen, Rollen und Konten ändern sich nur über die auditierten
Restow-Endpunkte; Impersonation über better-auth ist geschlossen, und eine solche Session
wird abgewiesen. Für andere handelt ein Admin nur über den Restore-Pfad (mit Begründung,
auditiert). Rate-Limits gelten unabhängig von `NODE_ENV` (Passwort-Anmeldung und TOTP
je Client-IP streng begrenzt). Die Zähler liegen in Postgres (better-auth
`rateLimit.storage: "database"`, Tabelle `rate_limit`), damit ein Neustart der API, auch
ein von außen provozierter, keine frischen Versuche verschenkt. Alternative Speicher im
Prozess (better-auth-Standard): ein Round-Trip weniger je Anfrage an `/api/auth/*`, aber
die Zähler gehen mit jedem Neustart verloren; Redis scheidet aus (siehe Queue).
- generic OAuth / Microsoft-Provider für Endnutzer-SSO (Entra ID, Multi-Tenant `common`)
- two-factor (TOTP) nur für den Notfall-Passwortweg
Das Passkey-Plugin ist ein eigenes Paket, `@better-auth/passkey` (MIT). API und Web
nutzen dieselben Pakete: die Web-App den React-Client (`better-auth/react`) mit den
Client-Plugins (`better-auth/client/plugins`, `@better-auth/passkey/client`).
Offene Registrierung per E-Mail und Passwort ist abgeschaltet (`disableSignUp`): das
erste Betreiberkonto legt der Setup-Wizard an, Endnutzer kommen über Entra-SSO. Auch die
Microsoft-Anmeldung legt kein Konto an: ein unbekanntes Entra-Konto erhält keinen
Restow-Benutzer. Dafür braucht der Provider `disableImplicitSignUp` und `disableSignUp`;
`disableImplicitSignUp` allein ließe eine Registrierung zu, sobald der Client sie mit
`requestSignUp` ausdrücklich anfordert. Wer ein Konto bekommt, entscheidet der Server
anhand des Verzeichnisses des Mandanten. Bestehende Nutzer mit verknüpftem
Microsoft-Konto melden sich weiter an. Die Entra-Identität (`oid`, `tid`) liegt in
`user.entra_object_id` und `user.entra_tenant_id` (eindeutig je Paar) und wird nur
serverseitig geschrieben (`additionalFields` mit `input: false`).
Sessions in Postgres, Cookies `Secure; HttpOnly; SameSite=Lax`.

## Web

React 19, Vite, TanStack Router (typisierte Routen) und TanStack Query, shadcn/ui
(MIT, kopierte Komponenten, kein Runtime-Lock-in), Tailwind CSS v4, lucide-react.
Die Komponenten in `apps/web/src/components/ui` erzeugt die shadcn-CLI (Stil new-york,
auf Tailwind v4 die Registry new-york-v4; Konfiguration in `apps/web/components.json`,
Hooks der Registry unter `components/ui/hooks`). Wo Restow vom Registry-Stand abweicht
(Ladezustand des Buttons, Status-Varianten von Badge und Alert, i18n der Screenreader-
Texte), steht das in `components/ui/README.md`; diese Dateien nie mit `--overwrite`
neu erzeugen. Die Registry-Datei `shadcn/tailwind.css` (zusätzliche `data-*`-Varianten)
ist nicht eingebunden: keine new-york-v4-Komponente nutzt sie, und sie käme nur mit dem
kompletten `shadcn`-CLI-Paket als Dev-Abhängigkeit.
Primitives: `radix-ui` (MIT), das gebündelte Radix-Paket, das die aktuelle shadcn-Registry
(new-york-v4) importiert. Alle Komponenten importieren nur noch daraus; die einzelnen
`@radix-ui/react-*`-Pakete sind entfernt. Alternative: weiter Einzelpakete; dann braucht
jede per CLI hinzugefügte Komponente händische Importkorrekturen.
Klassen-Zusammenführung: `cn` (MIT, aus dem shadcn-Projekt, ohne eigene
Abhängigkeiten), das Paket, aus dem die Registry `cn` seit September 2026 direkt
importiert. Es ersetzt clsx und tailwind-merge (gleiche Ergebnisse wie tailwind-merge 3,
also mit Tailwind-v4-Klassen; das bisherige tailwind-merge 2 kannte nur Tailwind v3).
`@/lib/utils` reicht `cn` für den Feature-Code durch, damit gibt es eine Implementierung.
Alternative: clsx plus tailwind-merge 3 behalten; dann müsste jede neu hinzugefügte
Komponente von Hand auf `@/lib/utils` umgestellt werden. Risiko: das Paket ist jung
(0.x); die Version ist über das Lockfile fest, ein Wechsel zurück betrifft nur
`lib/utils.ts` und die Importzeile der Komponenten.
Formulare: react-hook-form (ab 7.89) + zod (ab 3.25). Das shadcn-`form` baut nur auf
react-hook-form auf; die Verbindung zu zod übernimmt ein kleiner eigener Resolver in
`apps/web/src/lib/form.ts`, der die Fehler der Schemas auf i18n-Schlüssel abbildet, damit
zods englische Standardtexte nie in der Oberfläche landen. Die Registry schlägt dafür
@hookform/resolvers vor; das ist bewusst nicht installiert. Alternative: @hookform/resolvers 5
(MIT) plus eine eigene Fehlerzuordnung je Formular; eine Abhängigkeit mehr für dieselbe
Leistung. Tabellen: TanStack Table. Charts: recharts 3 (MIT) in der
Version, die die Registry für `chart` festlegt (3.8); recharts 2 passt nicht mehr dazu
(unter anderem heißen die Props eines eigenen Tooltip-Inhalts jetzt
`TooltipContentProps`). Dazu react-is (MIT) als direkte Abhängigkeit in der Hauptversion
von React (19): recharts erwartet es als Peer und erkennt damit Fragmente um `Cell`-
Kinder; ohne direkte Angabe löst pnpm react-is 18 auf, das React-19-Elemente nicht
erkennt, und solche Zellen fielen stillschweigend weg. Alternative: keine; die Version
muss zu React passen und wird mit React zusammen angehoben. Die Diagrammfarben `--chart-1` bis `--chart-5` sind je Theme
gewählt: jede mindestens 3:1 gegen `--card`, paarweise unterscheidbar auch bei Rot-Grün-
Sehschwäche. Statuscodierte Reihen (Backup- und Restore-Ergebnisse, Wiederherstellbarkeit)
nutzen auf jeder Seite die eigenen Status-Diagrammfarben `--chart-success`,
`--chart-warning`, `--chart-destructive` und `--chart-muted` (über `STATUS_CHART_COLOR`
im UI-Kit) mit denselben zwei Garantien, nie die UI-Töne wie `--warning` (rund 2:1 auf
Weiß). `components/ui/tokens.test.ts` prüft das zusammen mit den textsicheren
Statusfarben (`--success-text` usw., mindestens 4,5:1 auf der getönten Fläche von Badge
und Alert) und lässt in Diagramm-Konfigurationen nur Farben aus diesen beiden Paletten zu. Weitere Bausteine der Registry: vaul (MIT) für `drawer`, react-day-picker 10
(MIT) für `calendar` (Monats- und Wochentagsnamen folgen der App-Sprache). Alternative zu
vaul: `sheet` mit `side="bottom"` (Radix Dialog), ohne Wischgeste zum Schließen auf
Touch-Geräten. Alternative zu react-day-picker: ein eigenes Monatsraster auf date-fns;
mehr eigener Code für Tastaturbedienung, Bereichsauswahl und Lokalisierung, die
react-day-picker mitbringt.
tw-animate-css (MIT, Dev, nur zur Build-Zeit in `index.css` importiert) liefert die Ein-
und Ausblend-Animationen, die dialog, sheet und popover erwarten; Alternative wären
handgeschriebene Keyframes in `index.css`, die bei jeder Registry-Aktualisierung
nachgezogen werden müssten.
Toasts: sonner 2 (MIT). Version 2 statt 1.7, weil erst sie die Beschriftung des
Schließen-Knopfs konfigurierbar macht (`closeButtonAriaLabel`); 1.7 sagt fest
"Close toast" an. Der Toaster folgt dem Theme der App (ThemeProvider), nicht next-themes,
das die Registry vorschlägt und das hier nicht installiert ist.
Theme: die gespeicherte oder die System-Einstellung setzt die Klasse `light` oder `dark`
auf `<html>`, sobald das Theme-Modul geladen wird, also vor dem ersten Rendern von React.
Für den einen Frame, den der Browser zeichnen kann, bevor das (verzögert geladene) Bundle
läuft, trägt `<html>` noch keine der beiden Klassen; `index.css` gibt der leeren Seite dann
bei dunkler System-Einstellung die dunkle Fläche. Wer abweichend vom System ein Theme
gewählt hat, sieht dieses ab dem Laden des Moduls. Alternative: ein Inline-Skript im
`<head>` von `index.html`, das auch ein abweichend gewähltes Theme vor dem ersten Frame
setzt; es dupliziert die Logik des Theme-Moduls und bräuchte unter einer künftigen
Content-Security-Policy einen Hash.
Keine externen CDNs. Schriften sind immer selbst gehostet, nie von Google Fonts oder einem
anderen Dienst; die Content-Security-Policy der Edge erlaubt nur `font-src 'self'`, und eine
Installation ruft keinen Fremdserver auf. Schriften nach Brand Guide, Abschnitt 5: Inter Tight
(`@fontsource/inter-tight`, OFL-1.1) für alles, was ein Mensch liest, IBM Plex Mono
(`@fontsource/ibm-plex-mono`, OFL-1.1) für alles, was eine Maschine erzeugt. Zweck: die
Dateien kommen mit dem Web-Bundle und werden von der Installation selbst ausgeliefert, damit
Oberfläche und Wortmarke auf jedem Gerät gleich aussehen. Beide Pakete hängen nur an
`apps/web` (Kern); die OFL ist in `scripts/ci/license-policy.json` für den Kern erlaubt, nicht
für `ee/`. Die OFL verlangt Copyright-Vermerk und Lizenztext bei jeder Kopie der Schrift;
beides steht in `THIRD_PARTY_NOTICES.md` (erzeugt aus den Paketen). Eingebunden sind nur die
Subsets latin und latin-ext und nur die verwendeten Schnitte (Inter Tight 400, 500, 600, 700;
IBM Plex Mono 400, 500, 600), aufrecht, als woff2, mit eigenen `@font-face`-Regeln in
`apps/web/src/fonts.css` (mit `unicode-range`, damit latin-ext nur bei Bedarf geladen wird).
Vite legt die 14 Dateien (13 bis 38 KB, zusammen rund 320 KB, also nie inline) unter
`/assets` ab; `apps/web/src/fonts.test.ts` schlägt bei jeder externen Schrift-URL fehl.
Die latin-Dateien von Inter Tight 400, 500 und 600 (Fließtext, Menüs, Überschriften) lädt der
Browser vorab: das Vite-Plugin `apps/web/vite/font-preload.ts` setzt beim Build
`<link rel="preload" as="font" type="font/woff2" crossorigin>` mit den Hash-Namen in
`dist/index.html`, damit der erste Aufbau nicht auf das Stylesheet warten muss. Fehlt eine
der drei Dateien im Bundle, bricht der Build ab.
Alternativen: die Fontsource-CSS-Dateien direkt einbinden (sie bringen zusätzlich woff-Dateien
mit, die kein unterstützter Browser braucht, und ohne `unicode-range` je Subset); variable
Schriften (`@fontsource-variable/*`): weniger Dateien, aber IBM Plex Mono gibt es nicht
variabel, und beide Schriften sollen gleich eingebunden sein; Systemschriften: kein Download,
aber Wortmarke und Zahlen sehen je Gerät anders aus. PDF-Berichte bleiben bei den
eingebauten PDF-Schriften (Helvetica, Courier): Einbetten der Fontsource-Dateien machte die
API von den Schriftpaketen abhängig und bräuchte einen Ersatz für Zeichen außerhalb der
latin-Subsets.
Dazu die üblichen shadcn-Hilfen: class-variance-authority (Apache-2.0); cmdk (MIT) für die
Befehlspalette, date-fns (MIT) für Datumsrechnung (Anzeige und Formatierung über `Intl`).
Lade-/Aktivitätsanzeige für lang laufende Vorgänge wie Sicherung, Wiederherstellung,
Verzeichnis-Sync und Speicherprüfung: thinking-orbs (MIT, react >=18 als Peer, ohne
eigene Laufzeit-Abhängigkeiten), Canvas-basiert und `prefers-reduced-motion`-bewusst.
Alternative lucide-react `Loader2` (bereits installiert): reicht für kurze Requests,
aber ohne abgestufte Zustände für lang laufende Jobs (Backup-Läufe, Delta-Sync); dafür
bringt thinking-orbs neun fertige Zustände statt eines rotierenden Icons mit.
Resizable-Panes für den Restore-Explorer, je Nutzer gemerkte Breiten:
react-resizable-panels (MIT), die Laufzeit-Abhängigkeit, die die shadcn-Registry für
die `resizable`-Komponente vorschreibt; installiert in der Hauptversion, die die
Registry aktuell zieht (4.x). Alternative CSS-Grid mit festen Splits oder ein
handgeschriebener Splitter: kein Tastaturzugriff und keine Persistenz der
Panel-Größen ohne eigenen Code.

## i18n (Recherche, Stand 21.09.2026)

Anforderung: vollwertig ab Tag 1, de und en, Plural/ICU, Typsicherheit, Übersetzer
ohne Repo-Zugang, Open Source und kostenlos betreibbar.

Bibliotheken (App):
- i18next + react-i18next (MIT): größtes Ökosystem, ICU über i18next-icu, Namespaces,
  Lazy-Loading, Typen aus JSON generierbar (`i18next-resources-for-ts`). Gewählt.
- Paraglide JS (inlang, Apache-2.0): compile-time, sehr klein, typsicher, aber jüngeres
  Ökosystem und weniger Tooling für dynamische Inhalte. Gewählt für die Astro-Site.
- Lingui (MIT): gut, Makro-basiert; weniger verbreitet in shadcn-Projekten.
- FormatJS/react-intl (BSD): solide, ICU-nativ; Ökosystem kleiner als i18next.

Übersetzungsplattform (für Beitragende, In-Context-Bearbeitung):
- Tolgee (Apache-2.0): self-hostbar, In-Context-Editor per Browser-Plugin/SDK,
  i18next-Integration, kostenlose Cloud für Open Source. Gewählt.
- Weblate (GPL): sehr reif, self-hostbar, kostenloses Hosting für freie Projekte;
  kein In-Context. Gute Alternative, falls Tolgee nicht passt.
- Crowdin: kostenlos für OSS, proprietär. Nicht gewählt.
- inlang Fink: passt zu Paraglide, Web-Editor; für die Astro-Site nutzbar.

Maschinelle Vorübersetzung: DeepL API Free (500k Zeichen/Monat) über Tolgee-Plugin
für Erstentwürfe, danach menschlich prüfen. Keine automatische Übersetzung im Build.

ICU-Laufzeit: intl-messageformat (BSD-3-Clause) ist direkte Abhängigkeit von
`@restow/i18n`. Der ICU-Formatter wird über dessen benannten Export gebaut (`PortableIcu`,
packages/i18n/src/icu.ts), weil i18next-icu unter Node den CommonJS-Einstieg des Pakets
per Default-Import lädt und dort rohe ICU-Quellen statt Texten liefern würde; so
formatieren API-Benachrichtigungen und Tests genauso wie der Browser.

Regeln: Schlüssel sprechend (`backup.status.running`), keine Sätze als Schlüssel,
Plural über ICU, Datum/Zahl über Intl, Sprache aus Nutzerprofil, dann Browser.
Rechtstexte (Datenschutz, Lizenz) liegen als Markdown je Sprache, nicht in JSON.

## Microsoft

- @azure/msal-node (MIT): Client Credentials, Zertifikat oder Secret, Token-Cache.
- Graph über `fetch` mit eigenem Client (Retry/Throttling/Batch). Das offizielle
  SDK `@microsoft/microsoft-graph-client` ist möglich, aber die Throttling-Steuerung
  muss ohnehin selbst gebaut werden; weniger Abstraktion ist hier besser.
- Typen: @microsoft/microsoft-graph-types (MIT).

## Mail

- imapflow (MIT, von den nodemailer-Autoren): IMAP, Streams; OAuth2/XOAUTH2 und IDLE kann die
  Bibliothek, in 0.1.0 nutzt Restow nur Passwort-Anmeldung und keinen IDLE-Sync.
- smtp-server (MIT): Journal-Empfänger mit STARTTLS, `ee/api` (Teil der api-Rolle, seit
  0.1.0). Dazu `@types/smtp-server` (MIT, Dev). Alternative ein selbstgebauter
  SMTP-Parser über `net`: hätte STARTTLS, Größenlimits und die RCPT-TO-Ablehnung
  selbst neu implementiert statt eine geprüfte, gepflegte Bibliothek zu nutzen.
- mailparser (MIT): MIME-Parsing für Metadaten und Volltext; Original bleibt als
  Bytes erhalten (nie neu serialisieren). Seit der Mail-Vorschau in der Snapshots-API
  (`apps/api`) ist mailparser auch dort direkte Abhängigkeit, exakt in derselben
  Version wie in `packages/core` (`^3.7.2`, aktuell 3.9.28 aufgelöst) – damit liegt
  nur eine Kopie im Baum, nicht zwei divergierende Parser. Dazu `@types/mailparser`
  (MIT, Dev) in `packages/core` und `apps/api`. Alternative postal-mime oder ein
  eigener Parse-Helfer in `@restow/core`: hätte den vorhandenen, bereits getesteten
  Parser dupliziert statt ihn wiederzuverwenden.
- sanitize-html (MIT): säubert die aus mailparser gewonnenen HTML-Bodies für die
  Mail-Vorschau, bevor sie im Browser landen – kein Script, kein Formular, keine
  nachladende Remote-Ressource (Tracking-Pixel, externe Bilder). Dazu
  `@types/sanitize-html` (MIT, Dev). Alternative DOMPurify + linkedom (beide MIT):
  bräuchte ein DOM-Polyfill im Node-Prozess der API, weil dort kein Browser-DOM
  existiert; sanitize-html arbeitet direkt auf dem HTML-String.
- nodemailer 10 (MIT-0): Benachrichtigungen per SMTP-Transport. Version 10 schließt den
  DoS im Adressparser und die Umgehung über die `raw`-Option (behoben ab 9.1.0) und ist
  dieselbe Hauptversion, die mailparser mitbringt, also nur eine Kopie im Baum.
  Alternative nodemailer 9.1.x: behebt die Advisories, installiert aber eine zweite
  Kopie neben der von mailparser. nodemailer 10 bringt eigene Typdeklarationen mit;
  `@types/nodemailer` 8 (MIT, Dev) ist eingetragen, der Compiler lädt aber die
  mitgelieferten Typen, das @types-Paket ist damit überflüssig und kann entfallen.
- Microsoft Graph `sendMail` (über den vorhandenen Graph-Client, keine neue Abhängigkeit):
  alternativer Benachrichtigungs-Transport für M365-Betreiber, im Setup-Wizard per
  Dropdown wählbar; braucht die App-Berechtigung `Mail.Send`.
- Textextraktion Anhänge: pdf-parse (PDF), mammoth (DOCX), xlsx-Alternative offen.
- archiver (MIT): streamende ZIP-Erzeugung für den Download-Restore (EML und Dateien
  plus `MANIFEST.csv` mit SHA-256), ohne das Archiv im Speicher zu halten. Alternative
  yazl (MIT), kleiner, aber ohne Streaming-Komfort für viele Einträge.

Mail-Import und -Export (docs/IMPORT.md, `packages/core/src/mailfiles`):

- @kenjiuno/msgreader (Apache-2.0): liest Outlook-MSG-Dateien (OLE/CFB) für den Import;
  reines JavaScript, wird gepflegt (1.28). Aus einer MSG baut Restow eine EML nach, siehe
  IMPORT.md. Läuft nie im Worker-Prozess selbst, sondern hinter einer Strukturprüfung
  (`cfb-guard.ts`) in einem Kindprozess mit Heap- und Zeitgrenze (der Leser folgt
  FAT-Ketten ohne Schleifenerkennung). Alternativen: `msg-parser` und `msgreader` (npm, beide seit Jahren ohne
  Pflege, deutlich weniger MSG-Varianten, Anhänge und Unicode-Felder), `@tutao/oxmsg`
  (schreibt nur).
- yauzl (MIT): ZIP-Leser mit wahlfreiem Zugriff (`fromRandomAccessReader`): liest das
  Inhaltsverzeichnis am Dateiende und einzelne Einträge als Stream, ohne die Datei zu
  laden; wird über die versiegelten Upload-Segmente betrieben, es entsteht nie eine
  Klartextdatei. Dazu `@types/yauzl` (MIT, Dev). Alternativen: `unzipper` (streamend, ohne
  Zugriff auf das Verzeichnis am Ende, oder ganze Datei im Speicher), `adm-zip` und
  `fflate` (ganze Datei im Speicher).
- archiver (MIT, siehe oben) schreibt auch die Export-ZIPs (EML, MBOX, MSG).
- Kein Mail-Baukasten für MSG->EML: die Rekonstruktion schreibt ein kleines eigenes Modul
  (`mime-writer.ts`: Kopfzeilen nach RFC 2047, Transfer-Encodings über die Kodierer
  `nodemailer/lib/base64` und `nodemailer/lib/qp`). nodemailer (MIT-0) ist dafür direkte
  Abhängigkeit von `@restow/core` (dieselbe Version wie in apps/api, eine Kopie im Baum).
  `MailComposer` wurde geprüft und verworfen: es erzeugt zufällige Grenzen und ein Date von
  "jetzt", die Ausgabe wäre nicht reproduzierbar (gleiche MSG, gleiche Bytes ist
  Voraussetzung für die Duplikaterkennung).
- MSG-Export: nicht in 0.1.0. `@tutao/oxmsg` 0.2.3 (Tuta GmbH, Schreiber für .msg, abgeleitet von
  MsgKit) wurde bewertet: der Rundlauf gegen msgreader besteht, aber `package.json` nennt MIT
  und die mitgelieferte `LICENSE.txt` ist die GPL-3.0 (auch das GitHub-Repository weist
  GPL-3.0 aus). Das ist ein Widerspruch, den `pnpm licenses` nicht sieht (es liest nur
  `package.json`). Deshalb ist es nur noch eine Dev-Abhängigkeit für Testdaten (erzeugt
  MSG-Fixtures für die Import-Tests, wird nicht ausgeliefert) und nicht im Image. Alternative:
  bei Tuta (hello@tutao.de) nachfragen oder einen MSG-Schreiber von Grund auf bauen.
- Bewertet und **nicht** übernommen: `pst-extractor` (MIT) für den PST/OST-Import. Die
  Entscheidung vom 30.09.2026 verschiebt PST/OST-Import und -Export auf ein späteres
  Release (Roadmap in IMPORT.md). `msgkit` ist kein MSG-Schreiber (Push-Nachrichten
  über Pushover, Bark und Ähnliches), obwohl der Name es nahelegt.

## Speicher und Crypto

- Standardziel: lokaler Speicher im App-Container (Docker-Volume), ohne Zusatzdienst;
  Zugriff über Node `fs`/Streams. S3 und gemountete Netzlaufwerke (NFS) sind
  gleichwertige, optionale Ziele.
- @aws-sdk/client-s3 v3 (Apache-2.0) für alle S3-kompatiblen Ziele; Object Lock.
- Node `crypto` für SHA-256, HMAC, AES-256-GCM; kein externes Crypto-Paket.
- Schlüsselverwaltung hinter einem `KeyProvider`-Interface (packages/core/src/keyprovider.ts):
  `EnvKeyProvider` (KEK aus Umgebung) für Self-Hosting, ein KMS/Vault-Provider für die
  gehostete Variante. DEKs werden gewrappt gespeichert, der KEK erscheint nie im Speicher.
- FastCDC: eigene Implementierung in TypeScript (kleiner Algorithmus, dokumentiert),
  Gear-Hash-Tabelle fest im Repo.
- zstd für Manifeste: `@mongodb-js/zstd` oder Node-eigenes `zlib` (Node 22 hat kein
  zstd im Kern; Entscheidung im PoC).

## Endpoint-Backup (Agent)

- restic (BSD-2-Clause) ist die Engine der Server-/Client-Sicherung (docs/AGENT.md): ein
  gepinntes Binary (0.19.1), im Image mit SHA-256 geprüft und für Server (Retention, Prüfung,
  Restore-Test, Browsen, Download) wie für die Agenten ausgeliefert. Alternativen: Kopia
  (jünger, weniger Werkzeug rund um das Repository), Borg (keine Windows-Unterstützung, kein
  REST-Backend), ein eigener Dateisicherer (würde den Chunk-Store um Dateisystem-Metadaten
  erweitern, die restic schon beherrscht).
- Der Agent ist in Go geschrieben (`agent/`, `CGO_ENABLED=0`, eine statische Datei je Ziel).
  Kein neues npm-Paket: Der Server nutzt das vorhandene `archiver` für ZIP-Downloads und einen
  kleinen eigenen tar-Leser (`packages/core/src/endpoints/tar.ts`).

## Landingpage

Astro 7 (MIT), Tailwind v4, Astro-i18n-Routing (`/de/`, `/en/`), Paraglide für Strings,
MDX für längere Seiten (Doku, Vergleich), Sitemap, OpenGraph, keine Cookies, keine
Analytics ohne Einwilligung (Plausible self-hosted optional).

Astro 7 statt 5: ältere Versionen sind von einer kritischen Remote-Code-Ausführung in der
AVIF-Bildoptimierung (behoben ab 7.2.8), einem reflektierten XSS und einer SSRF über den
Host-Header betroffen; Astro 6 als Alternative ist von der AVIF-Lücke noch betroffen.
Astro 7 bringt sharp 0.35 mit (Apache-2.0; die vorkompilierten libvips-Binaries stehen
unter LGPL-3.0-or-later und nur beim Bauen der Site im Einsatz, nicht im Produkt-Image),
das zwei hohe libvips/libheif-Advisories schließt, und ein eigenes Vite 8; die App bleibt
auf Vite 6. Astro 7 braucht Node ab 22.12. Typprüfung mit @astrojs/check 0.9 (MIT).

## Tooling

- Biome (Lint + Format) statt ESLint/Prettier; TypeScript strict.
- Vitest 3 (MIT, im Workspace-Root; Unit/Integration), Playwright (E2E gegen
  Compose-Stack). 3.2.7 schließt die kritische Lücke im Vitest-UI (Dateizugriff, behoben
  ab 3.2.6) und zieht ein gepatchtes Vite 6.4.3. Offen bleibt ein mittleres Advisory
  (Pfad-Traversal über Redirect-Mocks in `@vitest/mocker`, GHSA-82fw-gwwq-j7x9), behoben
  erst ab 4.1.11; es betrifft den Testlauf, nicht den Produktivbetrieb. Alternative:
  Vitest 4.1 oder 5.x, eine größere Migration, die für die kritische Lücke nicht nötig ist.
- happy-dom (MIT), Test-DOM-Umgebung nur für @restow/web, nur per Datei-Pragma
  (`// @vitest-environment happy-dom`): jede andere Web-Suite läuft ohne DOM über
  `renderToStaticMarkup`, das keine Effekte ausführt. `page-context.test.tsx` braucht eine
  echte, mountbare DOM, um `usePageWidth`s `useLayoutEffect`-Umschaltung und ihr Cleanup
  beim Unmount zu prüfen. Alternative jsdom (MIT): schwerer, mehr Abhängigkeiten;
  ausschließlich `renderToStaticMarkup` verworfen, weil es Effekte gar nicht ausführen
  kann und den Unmount-Vertrag daher nicht beweisen könnte.
- tsx (MIT) als Dev-Runner (`watch`) für API, Worker, Scheduler und CLI; im Image läuft
  kompiliertes JavaScript. commander (MIT) für die Standalone-CLI `restow-restore`.
- Testcontainers für Postgres in CI; Garage (OSS, S3-kompatibel) für Speichertests.
- Dependabot (siehe unten), GitHub Actions: lint, typecheck, test, build image, Trivy-Scan.
- Conventional Commits, DCO-Signoff Pflicht, dazu die CLA vor dem ersten externen Pull Request
  (`CLA.md`).

## Updater (opt-in, Compose-Profil `updater`)

Keine neue npm-Abhängigkeit: der Updater (`apps/api/src/updater`) nutzt nur Node-Bordmittel,
zod, Hono und `@hono/node-server`, die die API ohnehin hat. Zur Laufzeit ruft er `docker` und
`docker compose` auf. Das Produkt-Image enthält kein Docker-CLI (es würde jede Installation um
gut 100 MB vergrößern, auch die ohne Updater); der Updater startet dafür kurzlebige Hilfscontainer
aus `docker:27-cli` (Docker Inc., Apache-2.0; enthält CLI, Compose und Buildx) über den Socket,
oder nutzt ein vorhandenes `docker`-Binary. Das Image ist per Digest gepinnt (ein Tag
ließe sich unter dem Updater verschieben, und der Container hat den Socket), wird beim Start
gezogen und ist über `RESTOW_UPDATER_CLI_IMAGE` austauschbar, aber nur gegen eine Referenz mit
Digest (etwa eine eigene Registry).

Signaturprüfung: `ghcr.io/sigstore/cosign/cosign:v3.1.3`, per Digest gepinnt
(Sigstore/Linux Foundation, Apache-2.0), als kurzlebiger Container über denselben Socket, ohne
Capabilities und schreibgeschützt. Zweck: Vor dem Ziehen eines Release-Images die keyless-Signatur
des Release-Workflows (`.github/workflows/release.yml`, signiert mit cosign v3.1.3) mit exakter
Zertifikatsidentität prüfen. Dieselbe cosign-Version wie beim Signieren, damit das Signaturformat
(neues Bundle-Format von cosign 3) sicher gelesen wird. Austauschbar über
`RESTOW_UPDATER_COSIGN_IMAGE`, ebenfalls nur mit Digest. Alternative: sigstore-js (npm,
Apache-2.0) im Updater-Prozess. Nicht gewählt, weil der Updater bewusst keine weiteren npm-Pakete
hat (Grenztest), sigstore-js keine OCI-Registry-Abfrage der Signaturen mitbringt (die müsste
selbst gebaut werden) und eine zweite Implementierung neben dem Signierwerkzeug Formatabweichungen
riskiert. Der Container braucht ausgehend HTTPS zur Registry und zum Sigstore-TUF-Root. Alternative: das CLI ins Produkt-Image kopieren (`COPY --from=docker:cli`). Nicht gewählt,
weil es die Angriffsfläche und die Größe für alle vergrößert, nicht nur für die, die das Feature
wollen. Der Quellcode-Modus lädt das Tag-Archiv per HTTP (Header, kein Git im Image) und entpackt
es mit dem im Image vorhandenen `tar`.

## Release-Pipeline und Smoke (CI, nicht Teil des Produkt-Images)

Nichts davon läuft im ausgelieferten Image; alles sind Werkzeuge der Pipeline (docs/CI.md),
jedes per Container-Digest oder Commit-SHA gepinnt.

- Playwright (Apache-2.0) im offiziellen Microsoft-Container: Passkey-Login mit virtuellem
  Authenticator (CDP `WebAuthn`), Mandanten-Assistent, i18n-Durchlauf de/en. Nur
  `playwright-core` (scripts/smoke/e2e, mit Lockfile), die Browser liegen im Image.
  Alternative: Playwright auf dem Host installieren; verworfen, weil der Container überall
  (Laptop, CI) dieselbe Browser-Version liefert.
- Garage (AGPL-3.0, nur als Testziel im Smoke gestartet, nichts davon im Image) als
  S3-Ziel; Dovecot (MIT/LGPL, das Demo-Image) als IMAP-Server; `curlimages/curl` (MIT) als
  Linux-Client für den Agent-Test. Alternative zu Garage: MinIO, nicht mehr Open Source.
- Trivy (Apache-2.0) für den Image-Scan, syft (Apache-2.0) für das SBOM (SPDX), cosign
  (Apache-2.0) für die schlüssellose Signatur (GitHub OIDC, Sigstore). Alternativen:
  Grype (nur Scan), Notation/GPG (eigene Schlüsselverwaltung, die wir nicht wollen).
- actionlint (MIT) für die Workflows, gitleaks (MIT) für Geheimnisse, shellcheck (GPL-3.0,
  als Werkzeug in CI, nicht gelinkt) für die Shell-Skripte.
- Lizenzprüfung der Abhängigkeiten: `scripts/ci/check-licenses.mjs` gegen die Allowlist in
  `scripts/ci/license-policy.json` (eigener Code, keine Abhängigkeit), bei jedem Push und
  Pull Request; GPL, LGPL, AGPL, SSPL, EUPL und unbekannte Lizenzen brechen den Build, für `ee/`
  zusätzlich jedes Copyleft (auch MPL-2.0). Die Go-Abhängigkeiten des Agents (keine) prüft
  `scripts/ci/check-go-deps.mjs` mit `go list`. Alternative: `license-checker` oder
  `licensee` als npm-Paket; nicht gewählt, weil der Kern der Prüfung (SPDX-Ausdrücke mit OR und
  AND gegen eine Allowlist) kurz ist und eine weitere Abhängigkeit im Lizenzwerkzeug selbst
  vermieden wird.
- ScanCode Toolkit (Apache-2.0, AboutCode) für den Lizenz- und Herkunftsscan des Repositorys vor
  einem Release: einmal je Release lokal im Container, nichts davon im Repository oder im Image,
  das Ergebnis liegt intern unter `internal/`. Alternative: FOSSology (GPL-2.0, braucht einen
  Server und eine Datenbank).
- Dependabot (GitHub-Dienst, `.github/dependabot.yml`): wöchentliche Pull Requests für npm, Go,
  GitHub Actions und Docker, Patch- und Minor-Updates gruppiert (seit 0.2.0; vorher je Update ein
  Pull Request, nach 0.1.0 waren das 13 auf einmal), bekannte Major-Migrationen (vite, vitest,
  intl-messageformat, archiver) von Hand; jeder Pull Request läuft durch dieselbe CI, einschließlich
  der Lizenzprüfung, und wird im Entwicklungsbaum nachgezogen statt gemergt (docs/CI.md).
  Alternative: Renovate (mehr Konfiguration, ein weiterer Dienst).
- Image-Aufbau: Die Laufzeit startet jede Rolle mit `node`; npm, yarn, corepack und pnpm
  (Build-Werkzeuge des Node-Images) sind aus dem Dateisystem entfernt, ebenso die von
  better-auth als optionale Peers mitinstallierten Werkzeuge (vitest, vite, esbuild,
  drizzle-kit). Das hält ungepatchte Go-Standardbibliotheken fremder Binaries aus dem Scan.

## Demo (deploy/demo, nicht Teil des Produkt-Images)

- Dovecot (IMAP-Server, MIT) im Alpine-Basisimage: der öffentlichen Demo eigenes,
  isoliertes Postfach mit synthetischen Mails, statische `passwd-file`-Konten aus der
  Umgebung, kein TLS (internes, netzisoliertes Demo-Netz ohne Internetroute).
  Alternative: Greenmail/James (Java, schwerer); Dovecot ist die verbreitetste,
  leichtgewichtigste Wahl für ein reines IMAP-Postfach ohne SMTP-Zustellung.
- `deploy/demo/seed` (eigenes pnpm-Workspace-Paket, `@restow/demo-seed`): keine neue
  npm-Abhängigkeit. MIME-Nachricht, iCalendar-Termin und PDF-Anhang werden von Hand
  gebaut (RFC 5322/2045, RFC 5545, minimales PDF), der deterministische Zufall ist ein
  kleiner mulberry32-PRNG inline — für ein paar hundert synthetische Testmails lohnt sich
  keine MIME-Bibliothek (`mailparser`/`nodemailer` gehören zum Produkt, nicht zum
  Testdaten-Generator) oder PDF-Bibliothek zusätzlich zum bereits vorhandenen
  `@react-pdf/renderer` (API-Reports, anderer Anwendungsfall).

## Ausdrücklich nicht

- Next.js (kein SSR-Bedarf, Vite reicht, weniger Magie).
- Prisma (schwer, eigener Query-Engine-Prozess).
- Redis (siehe Queue).
- Electron/Desktop-Client.
