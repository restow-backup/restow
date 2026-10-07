# Archiv, GoBD und Nachweise

Backup ist zum Zurückholen, Archiv ist zum Beweisen. Restow führt beides im selben
Speicher, aber mit getrennten Regeln. Dieses Dokument ist die fachliche Grundlage; es
ist keine Rechtsberatung, die Paragraphen dienen der Orientierung.

Das Dokument beschreibt das Zielbild des Archivs. Was Restow 0.1.0 davon tatsächlich
kann, steht im Abschnitt "Umsetzungsstand 0.1.0" am Ende; Abschnitte und Absätze, die
darüber hinausgehen, sind als "Zielbild, nicht in 0.1.0" gekennzeichnet.

## Was das Gesetz verlangt (Deutschland)

- Geschäftliche E-Mails sind Handels- und Geschäftsbriefe bzw. Buchungsbelege:
  Aufbewahrung 6 Jahre (Handelsbriefe, § 257 HGB, § 147 AO) bzw. 8 Jahre für
  Buchungsbelege (seit 2025), 10 Jahre für Bücher/Jahresabschlüsse.
- GoBD (BMF-Schreiben): vollständig, richtig, zeitgerecht, geordnet, unveränderbar,
  nachvollziehbar, maschinell auswertbar; Verfahrensdokumentation; Protokollierung
  von Änderungen; Aufbewahrung im Ursprungsformat (E-Mail als E-Mail, nicht als
  Ausdruck).
- "Unveränderbar" bedeutet: Nach Erfassung kann niemand, auch kein Admin, Inhalte
  ändern oder löschen, bevor die Frist abläuft; Löschungen nach Fristablauf werden
  protokolliert.
- "Zeitgerecht/vollständig": Die Kopie muss entstehen, bevor ein Nutzer die Mail
  verändern oder löschen kann. Deshalb Journaling, nicht Postfach-Sync.
- DSGVO: Löschkonzept nach Fristablauf, Auskunftsfähigkeit (Suche nach Person),
  Zugriffsbeschränkung, Legal Hold nur mit dokumentiertem Grund.

## Erfassungswege

In 0.1.0 schreiben genau zwei Wege ins Archiv: das Exchange-Online-Journaling (1) und der
Datei-Import mit "gleichzeitig archivieren" (4). Der fortlaufende Graph- und IMAP-Sync (2, 3) ist
Zielbild und nicht Teil von 0.1.0; es gibt dafür keinen Worker-Handler und keinen Zeitplan.

1. Exchange Online Journaling (Standard für M365, Edition Business und Service Provider):
   SMTP-Journal-Report an `journal+<token>@<Journal-Host>` (Einrichtung: Abschnitt
   "Exchange-Online-Journaling einrichten"). Erfasst ein- und ausgehend, intern und
   extern, inklusive BCC über den Umschlag. Restow speichert das Original
   (message/rfc822) byte-genau und den Umschlag als JSON.
2. Graph-Sync (Zielbild, nicht in 0.1.0): sichert, was vor Aktivierung des Journalings im
   Postfach lag (Altbestand) und Kalender/Kontakte. Wird als "nachträglich erfasst"
   markiert, weil die Unveränderbarkeit erst ab Erfassung gilt.
3. IMAP-Archivierung (Zielbild, nicht in 0.1.0): fortlaufender Sync (IDLE oder Intervall),
   Erfassung sobald die Mail im Postfach liegt; für Anbieter ohne Journaling die
   bestmögliche Näherung, in der Doku als solche benannt. Optional SMTP-Kopie (BCC-Regel
   beim Anbieter) an die Journal-Adresse.
4. Datei-Import (Erfassungsweg `file_import`): Mails aus einem Altpostfach (EML, MSG, MBOX,
   ZIP, MailStore-Export), die der Administrator beim Import ins Archiv übernimmt
   (docs/IMPORT.md). Die Frist beginnt mit der Erfassung (dem Import), das Sendedatum der
   Mail steht in `sent_at`; die Unveränderbarkeit gilt erst ab Erfassung, wie bei jeder
   nachträglichen Erfassung.

## Exchange-Online-Journaling einrichten

Journaling liefert die Kopie jeder Mail an Restow, bevor der Nutzer sie verändern oder
löschen kann. Die Einrichtung hat zwei Seiten: die Installation (Betreiber) und den
Microsoft-365-Mandanten (Administrator des Kunden). Den Stand zeigt Restow selbst: Archiv,
Abschnitt "Exchange-Journaling" (Mandanten-Administrator, Edition Business oder Service
Provider, Fähigkeit `archive.journalReceiver`). Ohne die Edition erscheint der Abschnitt
nicht, die API-Pfade antworten mit 404.

### Installation (Betreiber)

1. `.env`: `JOURNAL_SMTP_PORT=25`, `JOURNAL_HOSTNAME=archive.example.com` (nur der
   Hostname: ohne Schema, Pfad, Port und Mailadresse), `JOURNAL_TLS_CERT_PATH` und
   `JOURNAL_TLS_KEY_PATH` (PEM-Dateien, Zertifikat einer öffentlich vertrauten Stelle,
   passend zum Hostnamen; Einzelheiten im Abschnitt "TLS-Zertifikat" unten). Im
   Release-Compose zusätzlich `JOURNAL_SMTP_BIND=0.0.0.0`, sonst ist der Port nur auf dem
   Loopback-Interface erreichbar. Die API danach neu starten: der Empfänger liest Port und
   Edition nur beim Start.
2. DNS: ein A- oder AAAA-Eintrag für den Hostnamen (oder ein MX-Eintrag auf einen Host, der
   einen hat), der auf diesen Server zeigt. Die Domain der Journal-Adresse darf keine
   akzeptierte Domäne des Microsoft-365-Mandanten sein.
3. Firewall: Port 25/TCP eingehend aus dem Internet. Exchange Online stellt ausschließlich
   an Port 25 zu. Lauscht der Empfänger auf einem anderen Port (`JOURNAL_SMTP_PORT`), muss
   Port 25 der öffentlichen Adresse auf ihn weitergeleitet werden.

Restow kann DNS und Erreichbarkeit von außen nicht prüfen. Die Seite zeigt deshalb nur, was
sich aus der Konfiguration ergibt (Port, TLS, Hostname) und was tatsächlich angekommen ist.

### TLS-Zertifikat

Exchange Online stellt Journalberichte nur über TLS zu (der Connector steht auf "TLS
immer"). Der Empfänger startet deshalb nur mit einem eigenen, gültigen Zertifikat und nimmt
nie Mail ohne TLS an. Er verwendet nie das Testzertifikat, das die SMTP-Bibliothek
mitbringt: dessen privater Schlüssel ist öffentlich bekannt, eine damit "verschlüsselte"
Verbindung schützt nichts und sieht trotzdem geschützt aus.

- **Dateien**: `JOURNAL_TLS_CERT_PATH` (Zertifikatskette, Blatt zuerst) und
  `JOURNAL_TLS_KEY_PATH` (privater Schlüssel, PEM, nicht mit Passphrase verschlüsselt).
  Beide müssen gesetzt sein. Das Zertifikat muss von einer öffentlich vertrauten Stelle
  stammen und zu `JOURNAL_HOSTNAME` passen, sonst weist Exchange Online die Zustellung ab.
- **Release-Compose**: Das Verzeichnis `JOURNAL_TLS_DIR` (Standard `./journal-tls` neben
  der `docker-compose.yml`) ist schreibgeschützt im api-Container unter
  `/etc/restow/journal-tls` eingehängt. `fullchain.pem` und `privkey.pem` dorthin legen und
  `JOURNAL_TLS_CERT_PATH=/etc/restow/journal-tls/fullchain.pem` sowie
  `JOURNAL_TLS_KEY_PATH=/etc/restow/journal-tls/privkey.pem` in `.env` setzen. Eingehängt
  ist bewusst das Verzeichnis, nicht zwei einzelne Dateien: Ein Erneuerungsclient, der
  Dateien ersetzt, wird so gesehen.
- **Prüfung beim Start**: Beide Dateien müssen lesbar und PEM sein, der Schlüssel muss zum
  Zertifikat gehören, das Zertifikat muss gültig und nicht abgelaufen sein. Sonst startet
  kein Listener (Port 25 bleibt zu), der Status lautet "Empfänger läuft nicht" mit dem
  Grund "kein TLS-Zertifikat" (`tls_not_configured`), "Zertifikat nicht verwendbar"
  (`tls_invalid`) oder "Zertifikat abgelaufen" (`tls_expired`), und das API-Log nennt die
  Datei. Die API läuft weiter; nach dem Beheben die API neu starten.
- **TLS ist Pflicht**: Mit Zertifikat bietet der Empfänger STARTTLS an (mindestens TLS 1.2)
  und weist jede Sitzung ohne STARTTLS bei `MAIL FROM` mit `530 Must issue a STARTTLS command
  first` ab. Weder ein Empfänger noch ein Nachrichtenkörper wird im Klartext angenommen.
- **Erneuerung ohne Neustart**: Die API liest die Dateien alle fünf Minuten neu und
  übernimmt ein neues Zertifikat für neue Sitzungen, sobald Zertifikat und Schlüssel
  zusammen gültig sind. Ein halb geschriebener oder kaputter Austausch ändert nichts, der
  Empfänger bleibt beim bisherigen Zertifikat und es steht eine Meldung im API-Log. Läuft
  das Zertifikat ab, ohne dass ein gültiger Ersatz da ist, wechselt der Status auf
  "Zertifikat abgelaufen" und zurück, sobald die Dateien erneuert sind. Gewählt ist
  regelmäßiges Lesen statt `fs.watch`: Ein Watch übersieht atomare Umbenennungen,
  Symlink-Wechsel (so arbeiten Let's-Encrypt-Clients) und Änderungen auf gemounteten
  Verzeichnissen.
- **Zertifikat aus dem vorhandenen Caddy**: Gilt für den Hostnamen, den Caddy ohnehin
  bedient (`JOURNAL_HOSTNAME` gleich `RESTOW_APP_DOMAIN`). Caddy legt die Kette und den
  Schlüssel im Volume `caddy-data` ab. Kopieren, zum Beispiel täglich per Cron (Caddy
  erneuert rund 30 Tage vor Ablauf, der Empfänger übernimmt die Kopie selbst):

  ```sh
  docker compose exec caddy ls /data/caddy/certificates      # Verzeichnis der CA ermitteln
  docker compose cp "caddy:/data/caddy/certificates/<CA-Verzeichnis>/<host>/<host>.crt" ./journal-tls/fullchain.pem
  docker compose cp "caddy:/data/caddy/certificates/<CA-Verzeichnis>/<host>/<host>.key" ./journal-tls/privkey.pem
  ```

  Für einen anderen Hostnamen bedient Caddy kein Zertifikat.
- **Anderer ACME-Client** (certbot, acme.sh, lego): Zertifikat für den Journal-Hostnamen auf
  dem Host ausstellen, mit der DNS-Challenge, weil Caddy Port 80 belegt, und per Deploy-Hook
  in `JOURNAL_TLS_DIR` kopieren (`cp -L`: die Dateien, nicht die Symlinks aus `live/`).
- **Nur lokale Entwicklung**: `JOURNAL_ALLOW_INSECURE=true` startet den Empfänger ohne
  Zertifikat und bietet STARTTLS gar nicht erst an (nicht mit einem öffentlich bekannten
  Schlüssel). Exchange Online stellt an so einen Empfänger nicht zu, und Mail liefe
  unverschlüsselt. **Nie in Produktion.** Die Option gilt nur, solange kein Zertifikat
  konfiguriert ist: Ein konfiguriertes, aber kaputtes Zertifikat führt nie zu Klartext.
  Der Release-Smoke (Prüfung 6) nutzt sie nicht, er prüft den echten TLS-Weg mit einem
  Wegwerf-Zertifikat.

### Journal-Adresse

Die Adresse lautet `journal+<token>@<Journal-Host>`. Der Token ist je Mandant zufällig
(32 Zeichen, nur Kleinbuchstaben und Ziffern, weil Mailsysteme die Groß-/Kleinschreibung
des lokalen Teils nicht zuverlässig erhalten) und steht nur in der Datenbank
(`tenants.journal_token`). Die erste Ansicht des Abschnitts erzeugt die Adresse und schreibt
`archive.journal.address_created` ins Audit-Log. Ist `JOURNAL_HOSTNAME` nicht gesetzt oder
ungültig, zeigt Restow keine vollständige Adresse, sondern sagt das ausdrücklich.

Der Status des Abschnitts:

- **Empfang läuft**: der Empfänger lauscht und der letzte Report ist höchstens 24 Stunden
  alt.
- **Seit mehr als 24 Stunden kein Report**: es kamen Reports, aber keine mehr. Bei einem
  Mandanten mit Mailverkehr ist das ein Fehler auf dem Weg (Connector, Regel, Firewall).
- **Noch keine Reports**: der Empfänger lauscht, es ist nichts angekommen.
- **Nicht eingerichtet** (`not_configured`): `JOURNAL_SMTP_PORT` ist nicht gesetzt, die
  Installation nutzt kein Journaling. Das ist kein Fehler und wird neutral gezeigt: graue
  Markierung, ein Satz, was nötig ist (`JOURNAL_SMTP_PORT`, `JOURNAL_HOSTNAME`,
  TLS-Zertifikat, API-Neustart), die Anleitung eingeklappt, keine roten oder gelben
  Hinweise. Rot (Empfänger läuft nicht) und Gelb gibt es nur für einen Empfänger, der
  eingerichtet ist.
- **Empfänger läuft nicht** (der Empfänger ist eingerichtet, `JOURNAL_SMTP_PORT` ist
  gesetzt): mit dem Grund: die Lizenz enthält den Empfänger, aber die API startete davor
  (Neustart nötig); der Listener konnte nicht starten (Port belegt, keine Berechtigung für Port 25; das API-Log nennt die
  Ursache); kein TLS-Zertifikat konfiguriert (`tls_not_configured`); Zertifikat oder
  Schlüssel nicht verwendbar (`tls_invalid`: nicht lesbar, kein PEM, verschlüsselter oder
  nicht passender Schlüssel, noch nicht gültig, nur eine der beiden Variablen gesetzt);
  Zertifikat abgelaufen (`tls_expired`); in diesem Prozess nicht gestartet. Die drei
  TLS-Gründe nennen, welche Variablen zu setzen sind und dass Exchange Online TLS verlangt;
  Dateinamen stehen nur im API-Log, nie in der Oberfläche.

Zeitpunkt des letzten Reports und die Zähler für 24 Stunden und 7 Tage kommen aus dem
Archiv (Erfassungsweg Journal), nicht aus einem eigenen Zähler.

### Microsoft 365 (Administrator des Kunden)

1. Connector: Exchange Admin Center (admin.exchange.microsoft.com), E-Mail-Fluss, Connectors,
   Connector hinzufügen: von Office 365 zu Partnerorganisation. Nur für E-Mail an die Domäne
   des Journal-Hosts, über den Smarthost des Journal-Hosts, TLS immer, Zertifikat einer
   vertrauenswürdigen Stelle mit passendem Namen. Die Überprüfung des Connectors fragt nach
   einer Adresse: die Journal-Adresse eintragen. Die Testmail kommt als nicht lesbarer
   Journal-Report an und wird mit der Markierung `report-unparseable` archiviert; das ist
   erwartet.
2. Adresse für nicht zustellbare Journalberichte: Microsoft-Purview-Portal
   (purview.microsoft.com), Datenlebenszyklusverwaltung, Exchange (Legacy), Journalregeln,
   "Nicht zustellbare Journalberichte senden an": ein echtes Postfach, das jemand liest (zum
   Beispiel ein freigegebenes Postfach). Dorthin schickt Exchange Online Reports, die nicht
   an Restow zugestellt werden konnten; hier fällt eine Lücke auf.
3. Journalregel: Journalberichte senden an die Journal-Adresse, für Nachrichten von oder an
   alle, Nachrichtentyp "Alle Nachrichten" (intern, extern und BCC), Regel einschalten.
4. Prüfen: eine Mail innerhalb der Organisation senden. Der Report kommt meist innerhalb
   weniger Minuten an; der Status wechselt auf "Empfang läuft", die Mail steht in der
   Archivsuche mit der Quelle "Exchange-Online-Journal", die Kettenprüfung bleibt grün.

### Adresse erneuern

"Adresse erneuern" (mit Rückfrage) erzeugt einen neuen Token. Die alte Adresse ist sofort
ungültig: der Empfänger löst den Token bei jedem RCPT TO in der Datenbank auf und weist die
alte Adresse mit 550 ab. Danach den Empfänger der Journalregel (und die Adresse des
Connector-Tests) auf die neue Adresse ändern. Bis dahin werden Reports abgewiesen und nicht
archiviert; Exchange Online schickt sie an das Postfach für nicht zustellbare
Journalberichte. Anlass sind ein offengelegter Token oder ein Wechsel des Journal-Hosts. Das
Audit-Log hält `archive.journal.address_created` und `archive.journal.address_rotated` mit
einem Fingerabdruck des Tokens fest, nie mit dem Token selbst.

### Lesen der Reports

Der Empfänger liest jeden Report in einem Parser-Prozess der API
(`packages/core/src/archive/journal-isolated.ts`; derselbe Prozess-Pool wie die Mail-Vorschau,
`apps/api/src/lib/parser-pool.ts`), nie auf ihrem Event-Loop. Grenzen wie beim Import: bis 8 MiB
langlebige Prozesse mit 512 MiB Heap, darüber ein eigener Prozess mit 256 MiB + 6 MiB je MiB;
Zeit 15 s + 0,5 s je MiB, höchstens 120 s (ein Report von 150 MB hat 90 s). Es laufen
`PREVIEW_PARSE_WORKERS` Prozesse gleichzeitig (Standard 2), höchstens 16 Aufgaben warten,
Vorschau und Journal zusammen.

- Überschreitet das Lesen Zeit oder Speicher, wird der Prozess beendet und der Report trotzdem
  archiviert: Byte für Byte wie empfangen, ohne die Angaben aus Umschlag und Original (Absender,
  Empfänger, Betreff), markiert mit `report-parse-timeout` bzw. `report-parse-memory-limit` und
  `original-message-missing` (das Original wurde nicht herausgelöst; es steckt unverändert im
  archivierten Report). Wirft der Parser oder stürzt sein Prozess ab, ergibt das
  `report-unparseable`. Eine Ablehnung mit 4xx hätte Exchange Online denselben Report bis zur
  Aufgabe erneut schicken lassen, danach bliebe nur der Bericht an das Postfach für nicht
  zustellbare Journalberichte. Das API-Log nennt Mandant, Element, Markierungen und Größe, nie
  Inhalt.
- Ist kein Prozess frei und die Warteschlange voll, oder lässt sich gar kein Parser-Prozess
  starten, antwortet der Empfänger 451: gespeichert ist nichts, Exchange liefert später erneut.
- Was die Angaben nicht brauchen, liest der Parser nicht: keine HTML-Darstellung des Textes und
  keine Links (`textAsHtml`; 30 MB `<` kosteten damit 1 GB Heap), vom Original nur der Kopf
  (Betreff, Message-ID, To, Cc), HTML-Umschläge über 2 MiB werden nicht in Text umgewandelt (der
  Report wird dann roh archiviert, `report-unparseable`), höchstens 100.000 Empfänger aus dem
  Umschlag (darüber `recipients-truncated`; der archivierte Report enthält alle). Ein ehrlicher
  Report bis zur Größengrenze bleibt so weit unter dem Speicher seines Prozesses.

### Zuordnung zu Postfächern und Archiv je Job (ab 0.3.0)

Ein Journal-Report nennt Empfänger und Absender, kein Postfach. Der Empfänger ordnet jeden
archivierten Report in derselben Transaktion allen geschützten Postfächern des Mandanten zu,
deren Adresse der Umschlag nennt: als Empfänger, als Absender (gesendete Mail), als Postfach, für
das ein Stellvertreter gesendet hat, oder als Postfach, das weitergeleitet hat. Verglichen wird
klein geschrieben mit primärer Adresse, UPN und allen SMTP-Aliasen aus `proxyAddresses`, die die
Verzeichnissynchronisierung speichert (`users.mail_addresses`); ein IMAP-Konto über seinen Login.
Die Zuordnung steht in `archive_item_mailboxes` (nur hinzufügen, nie ändern, wie
`archive_items`).

- Ein Report, der kein Postfach des Mandanten nennt, wird trotzdem archiviert und gehört dann nur
  dem Mandanten. Nichts wird verworfen.
- Im Editor eines Mail-Jobs schaltet "Postfächer dieses Jobs archivieren" das Archiv für den Job
  ein. Die Erfassung hängt nicht daran: Exchange journalisiert nach seiner Journalregel, Restow
  archiviert jeden Report. Der Schalter sagt, welche Postfächer im Archiv erwartet werden, und
  zeigt Journal-Adresse und Empfangsstatus (Business). Ein Maschinen-Job kann nicht archivieren.
- Object Lock ist keine Voraussetzung. Ohne Object Lock zeigt der Editor den Hinweis, dass das
  Archiv dann nur auf Anwendungsebene unveränderbar ist (Abschnitt "Speicherung").
- Suche, Export und Legal Hold je Postfach berücksichtigen zugeordnete Journal-Reports.
- Reports, die vor 0.3.0 eingegangen sind, haben keine Zuordnung; sie gehören weiter nur dem
  Mandanten.

### Grenzen

- Journaling erfasst ab der Aktivierung. Was vorher im Postfach lag, erfasst das Archiv in
  0.1.0 nicht von selbst (der Graph-Sync ist Zielbild); Altbestand lässt sich als Export des
  Postfachs über den Datei-Import mit "gleichzeitig archivieren" aufnehmen und ist dann als
  nachträglich erfasst markiert.
- Der Empfänger verlangt STARTTLS (Abschnitt "TLS-Zertifikat") und startet nicht ohne
  gültiges Zertifikat. Die Prüfung des Absenders (SPF, Microsoft-Adressbereiche) ist
  noch nicht umgesetzt, die Annahme beschränkt sich auf bekannte Journal-Adressen, ein
  einfaches Rate-Limit je Absender-IP (im Arbeitsspeicher der API) und das Größenlimit (`JOURNAL_MAX_SIZE_MB`, Standard 150 MB;
  größere Reports werden abgewiesen).

## Speicherung

- Archivobjekte gehen in den Chunk-Store wie Backup-Objekte, zusätzlich ein versiegelter
  Datensatz je Objekt: `tenants/<tid>/archive/<jahr>/<monat>/<archive_item_id>.json`
  (Format: `packages/core/src/archive/FORMAT.md`). Auf einem S3-Ziel mit Object Lock
  (Compliance-Modus) setzt 0.1.0 die Retention bis Fristende nur auf diesen Datensatz. Die Packs
  mit dem Nachrichteninhalt tragen keine Retention; der Garbage Collector kann sie umpacken oder
  löschen, sobald keine Referenz mehr besteht. Hardware-WORM schützt den Inhalt einer Mail damit
  in 0.1.0 nicht, und Sicherungsdaten (Backups) tragen gar keine Object-Lock-Retention.
- Hash-Kette: `archive_items.chain_hash = SHA-256(prev_chain_hash || item_hash ||
  received_at)`. Nach Ende eines UTC-Tages schreibt der nächtliche Ankerlauf des Workers
  (`apps/worker/src/handlers/archive-anchor.ts`, zusammen mit den Audit-Ankern) je Mandant
  einen Anker in `archive_anchor`: Datum, Kettenwert des letzten Eintrags des Tages und die
  Länge der Kette bis dahin; jeder Anker steht zusätzlich im Worker-Log. Die Archivprüfung
  (`apps/api/src/features/archive/verify.ts`) prüft drei Dinge und nennt jedes im Ergebnis:
  die Verkettung aller Einträge (erster Bruch mit Position ab 1 und Element), den Abgleich
  mit jedem Anker (erkennt am Ende abgeschnittene Einträge bis zum neuesten Anker; Einträge
  danach sind noch nicht versiegelt) und eine Stichprobe von Nachrichten, die aus dem
  Speicher gelesen und mit Größe und SHA-256 der Erfassung verglichen werden. Jede Prüfung
  steht im Audit-Log (`archive.chain.verified`). Nicht umgesetzt: Versand der Anker per
  E-Mail und externe Zeitstempel (RFC 3161).
- Dedupe: Gleiche Inhalte liegen im Chunk-Store einmal je Mandant. Zielbild, nicht in 0.1.0:
  gleiche Mail an mehrere Postfächer = ein Original mit mehreren Zuordnungen
  (Envelope-Empfänger bleiben je Zuordnung erhalten).
- Ohne Object Lock (lokaler Speicher, NFS, S3 ohne Lock): Restow erzwingt Unveränderbarkeit
  nur auf Anwendungsebene (kein Lösch-/Änderungspfad im Code, Kettenprüfung); wer Zugriff auf
  die Dateien oder den Server hat, kann sie ändern oder löschen. Die Seite Repositories zeigt solche
  Ziele als "Kein Hardware-WORM" bzw. "Object Lock nicht aktiviert".
- Das Feld `object_lock` eines Archivobjekts und der Zähler `objectLocked` in Archivstatus und
  Nachweisbericht bedeuten in 0.1.0 nur "hat ein Fristende", nicht "liegt unter Object Lock".

## Retention und Löschung

In 0.1.0 gilt für jeden Mandanten eine feste Voreinstellung: 8 Jahre, Fristende am
31. Dezember des Jahres des Eingangs plus 8 Jahre
(`apps/api/src/features/archive/retention-policy.ts`). Weder API noch Oberfläche schreiben eine
Archiv-Richtlinie; die Tabelle `retention_policies` kennt für das Archiv den Eintrag
`applies_to.target = "archive"`, es legt ihn aber niemand an. Der Löschlauf und der Legal Hold
sind Edition Business und Service Provider.

- Zielbild, nicht in 0.1.0: Richtlinie je Mandant (wählbar 6/8/10/unbegrenzt), optional je
  Postfach-Gruppe. Fristbeginn = Erfassungsdatum (oder Kalenderjahresende, Option "zum
  Jahresende", wie AO § 147 Abs. 4 rechnet).
- Legal Hold mit Grund, Anleger, Datum; blockiert Löschung, wird auditiert. In 0.1.0 gilt er
  mandantenweit oder je Postfach, nicht je Suchergebnis (Zielbild). Ein Hold je Postfach schützt
  die Archivobjekte, die diesem Postfach gehören: aus dem Datei-Import mit "gleichzeitig
  archivieren" und, ab 0.3.0, die Journal-Reports, die ihm zugeordnet sind (Abschnitt "Zuordnung
  zu Postfächern"). Reports ohne Zuordnung schützt nur ein mandantenweiter Hold.
- Löschlauf: täglich (Aufgabe `retention`, empfohlener Zeitplan 04:30), löscht nur abgelaufene
  Objekte ohne Hold und schreibt jede Löschung ins Audit-Log. Zielbild, nicht in 0.1.0: ein
  Löschprotokoll (Anzahl, Zeitraum, Hashes der gelöschten Objekte) als eigener Eintrag der Kette.

## Suche und Export

- Umgesetzt (0.1.0): Volltextsuche über Betreff, extrahierten Text des Bodys (sehr lange
  Bodies können gekürzt sein) und Umschlag (Absender, Empfänger), mit Filter nach Datum und
  "hat Anhang". Postgres `to_tsvector('simple', ...)`, kein Stemming. Nur Administratoren des
  Mandanten suchen (auditiert, je Suche und je gelesenem Element). Jeder Treffer trägt seinen
  Erfassungsweg (`source`: `journal`, `graph_sync`, `imap_sync` oder `file_import`); Liste und
  Detail der Archivseite zeigen ihn, ein importiertes Mail-Archiv erscheint nie als Journal.
- Zielbild, nicht in 0.1.0: Suche auch in Anhängen (PDF, DOCX, XLSX, TXT) und nach Mandant,
  Postfach und Größe; Endnutzer suchen nur im eigenen Postfach; Provider-Admin nur mit
  expliziter Freigabe durch den Mandanten (Vier-Augen-Schalter).
- Export (umgesetzt): Mails aus Archiv (Auswahl oder aktuelle Suche), Sicherung oder
  importiertem Postfach als EML in einem ZIP mit Ordnerstruktur, `MANIFEST.csv` und `SHA256SUMS`, oder als MBOX (docs/IMPORT.md,
  Abschnitt Export). Der Export ist ohne Restow lesbar (jeder Mailclient öffnet EML). Zielbild,
  nicht in 0.1.0: `CHAIN.txt` mit den Kettenwerten des Zeitraums.
- Nachweisbericht (umgesetzt als API, JSON): `GET /api/v1/archive/report` (Scope `archive:read`,
  höchstens 366 Tage) mit Mandant, Zeitraum, Anzahl, Erfassungswegen, Kettenzustand,
  Retention-Richtlinie und Legal Holds. Es gibt weder PDF noch Signatur noch eine Oberfläche
  dafür. Zielbild, nicht in 0.1.0: der Bericht als signiertes PDF mit Speicherziel,
  Object-Lock-Status und Löschprotokollen.

## Verfahrensdokumentation (Zielbild, nicht in 0.1.0)

Generiert je Mandant aus Konfiguration und Vorlage: Systembeschreibung, Erfassungsweg,
Speicherort, Verschlüsselung, Zugriffsrechte, Retention, Löschverfahren, Kontrollen
(Kettenprüfung, Scrub), Verantwortliche, Änderungshistorie. Als Markdown und PDF,
versioniert, mit Datum. Das Dokument ist Bestandteil der Prüfungsfähigkeit, nicht Kür.

## Umsetzungsstand 0.1.0

Stand der ersten öffentlichen Version. Jede Zeile ist gegen den Code geprüft; was hier nicht
steht, ist nicht umgesetzt.

- **Erfassung.** Archivobjekte entstehen nur auf zwei Wegen: durch den SMTP-Journal-Empfänger
  (Edition Business und Service Provider) und durch den Datei-Import mit "gleichzeitig
  archivieren". Der fortlaufende IMAP-Sync und der Graph-Sync existieren nicht: Es gibt keinen
  Worker-Handler für die Archiv-Queue, und die Zeitplanart "Archiv" wird nicht angeboten.
- **Journal-Empfänger** (`ee/api/src/journal/`, Teil der api-Rolle). Er braucht
  `JOURNAL_SMTP_PORT`, `JOURNAL_HOSTNAME` und ein TLS-Zertifikat
  (`JOURNAL_TLS_CERT_PATH`, `JOURNAL_TLS_KEY_PATH`); ohne gültiges Zertifikat öffnet er den Port
  nicht. STARTTLS ist Pflicht: Eine Sitzung ohne STARTTLS wird bei `MAIL FROM` mit 530 abgewiesen.
  Unbekannte Empfänger werden bei RCPT TO abgelehnt (550), bei Speicher- oder
  Datenbankfehlern antwortet er 451, damit Exchange Online es erneut versucht. Die
  Die Lizenzfähigkeit liest er nur beim Start der API. Nicht umgesetzt: die Prüfung des Absenders (SPF,
  Microsoft-Adressbereiche).
- **Speicherung.** Originale byte-genau und verschlüsselt im Chunk-Store, je Objekt ein
  versiegelter Datensatz mit der Hash-Kette. Unveränderbarkeit auf lokalem Speicher und NFS
  nur auf Anwendungsebene. Auf S3 mit Object Lock trägt in 0.1.0 nur der Datensatz eine
  Retention, nicht die Packs mit dem Nachrichteninhalt; Sicherungsdaten tragen keine.
  Tägliche Archiv-Anker (`archive_anchor`) schreibt der Worker; externe Zeitstempel gibt es nicht.
- **Suche.** Volltext (Postgres `simple`, kein Stemming) über Betreff, extrahierten Text
  (lange Bodies können gekürzt sein) und Umschlag, nicht über Anhänge. Nur Administratoren des
  Mandanten; kein Selbstbedienungszugriff für Endnutzer. Jede Suche und jedes gelesene Element
  steht im Audit-Log (`apps/api/src/features/archive/`).
- **Archivprüfung** (Verkettung, tägliche Anker, Inhaltsstichprobe) als API-Endpunkt und
  Schaltfläche auf der Archiv-Seite (`apps/web/src/features/archive/`), synchron in einer
  Anfrage; ein Hintergrundlauf mit Fortschritt ist nicht umgesetzt.
- **Lesen und Herunterladen** einer archivierten Nachricht (Leseansicht, `.eml`), beides im
  Audit-Log.
- **Retention.** Fest 8 Jahre bis zum Jahresende des Eingangsjahres; keine API und keine
  Oberfläche setzen eine andere Richtlinie. Der tägliche Löschlauf (Business und Service
  Provider, `ee/worker/src/archive-retention/`, im bestehenden `retention`-Job) löscht nur
  abgelaufene Objekte ohne Legal Hold und schreibt jede Löschung ins Audit-Log.
- **Legal Hold** (Business und Service Provider, `ee/api/src/legal-holds/`): mandantenweit
  oder je Postfach, nicht je Suchergebnis. Ein Hold je Postfach schützt nur Objekte, die einem
  Postfach zugeordnet sind (Datei-Import); Journal-Objekte schützt nur ein mandantenweiter Hold.
- **Export.** Mails aus Archiv, Sicherung und importiertem Postfach als EML in einem ZIP
  (`MANIFEST.csv`, `SHA256SUMS`) oder als MBOX (docs/IMPORT.md).
- **Nachweisbericht.** Nur als API (JSON, `GET /api/v1/archive/report`), kein PDF, keine
  Oberfläche. Der Zähler `objectLocked` zählt Objekte mit Fristende, nicht Objekte unter Object
  Lock.
- **Audit-Log.** Aufgezeichnet wird in jeder Edition; die Ansicht mit Filter und
  Kettenprüfung ist Business und Service Provider. Ein CSV- oder PDF-Export ist geplant.
- **Nicht umgesetzt:** Graph-Sync, IMAP-Archivierung, Suche in Anhängen, Selbstbedienungssuche
  der Endnutzer, Legal Hold je Suchergebnis, Verfahrensdokumentation, signierter PDF-Nachweis,
  Zuordnung einer Mail zu mehreren Postfächern als Referenz, `CHAIN.txt` im Export, OAuth2
  für IMAP-Quellen. Der Stand der ganzen Version steht im Abschnitt "Known Issues" von
  CHANGELOG.md.

## Was Restow nicht behauptet

- Keine "Zertifizierung" (IDW PS 880 ist ein Prüfungsstandard für Software, teuer und
  optional; wir sagen "GoBD-orientiert" und beschreiben die Maßnahmen).
- Kein Ersatz für die Prüfung durch Steuerberater oder Datenschutzbeauftragte.
- Keine Garantie der Vollständigkeit für IMAP-Archivierung ohne Journaling (Zielbild; die
  IMAP-Archivierung gibt es in 0.1.0 nicht).
- Keine Hardware-WORM-Garantie: Auf lokalem Speicher und NFS ist die Unveränderbarkeit nur
  Anwendungsebene, und auch auf S3 mit Object Lock sind in 0.1.0 nur die Datensätze gesperrt.
