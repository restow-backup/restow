# Archiv, GoBD und Nachweise

Backup ist zum Zurückholen, Archiv ist zum Beweisen. Restow führt beides im selben
Speicher, aber mit getrennten Regeln. Dieses Dokument ist die fachliche Grundlage; es
ist keine Rechtsberatung, die Paragraphen dienen der Orientierung.

**Stand: Restow 0.4.4 (in Arbeit).** Was diese Version kann, steht im Abschnitt
"Umsetzungsstand" am Ende; er wird zur Freigabe von 0.4.4 gegen den Code geprüft und
abgeschlossen. Was für 0.4.4 geplant ist, ist als
**"Geplant für 0.4.4"** gekennzeichnet, alles Weitere als **"Zielbild"**.

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
- "Zeitgerecht/vollständig": Die Kopie soll entstehen, bevor ein Nutzer die Mail
  verändern oder löschen kann. Am sichersten gelingt das beim Transport (Journaling);
  eine Erfassung aus dem Postfach ist zeitnah, aber nicht garantiert lückenlos
  (Abschnitt "Echt oder zeitnah").
- DSGVO: Löschkonzept nach Fristablauf, Auskunftsfähigkeit (Suche nach Person),
  Zugriffsbeschränkung, Legal Hold nur mit dokumentiertem Grund.

## Archiv im Mail-Job

Der Editor eines Mail-Jobs fragt zuerst "Was soll dieser Job tun?" (seit 0.4.2):

- **Sichern**: Ordner, Kalender, Kontakte und ganze Postfächer wiederherstellen können.
- **Archivieren**: jede Mail revisionssicher aufbewahren. "Archivieren" allein sichert nicht
  nach Zeitplan (der Job hat dann keinen Zeitplan; ein von Hand gestarteter Lauf sichert
  trotzdem).
- **Beides**: die Vorgabe für neue Jobs.

Archivieren und beides schalten das Archiv für die Postfächer des Jobs ein. Die Auswahl sagt,
welche Postfächer im Archiv erwartet werden, nennt den Erfassungsweg und zeigt dessen Status.
Mit Archiv schlägt der Editor bei einem Zeitplan häufiger als alle 8 Stunden vor, seltener zu
sichern (nur ein Vorschlag, Abschnitt "Journaling und Postfach-Sicherung"). Ein Maschinen-Job
kann nicht archivieren. Object Lock ist keine Voraussetzung; ohne Object Lock zeigt der Editor,
dass das Archiv dann nur auf Anwendungsebene unveränderbar ist (Abschnitt "Speicherung").

**Bis 0.4.3** bietet der Editor als Erfassungsweg ausschließlich das Exchange-Online-Journaling
an, auch für IMAP-Konten. Für ein IMAP-Postfach ist das kein brauchbarer Weg.

**Geplant für 0.4.4:** Der Editor erkennt die Art der Quelle des Jobs (Microsoft 365, IMAP,
Google Workspace über IMAP) und bietet nur die Erfassungswege an, die dazu passen (Tabelle im
nächsten Abschnitt). Eine Journal-Adresse wird nur angelegt und angezeigt, wo sie gebraucht
wird: für das Exchange-Journaling und, wenn gewählt, für die Weiterleitung bei IMAP-Anbietern.
Ein Job mit Postfächern verschiedener Art zeigt den Weg je Art. Jeder Weg ist als **echt** oder
**zeitnah** gekennzeichnet; je Art muss mindestens ein Weg gewählt sein. Ein Weg, den die Edition
nicht enthält, ist gesperrt und nennt die Edition.

Anhalten eines Mail-Jobs hält nur die Sicherungen nach Zeitplan an; die Archivierung läuft weiter
(die Rückfrage beim Anhalten sagt das). Sie endet nur, wenn im Job das Archivieren oder ein
Erfassungsweg ausgeschaltet wird. Der Editor fragt dann vor dem Speichern nach: Neue Mail dieser
Postfächer wird ab dann nicht mehr (über diesen Weg) archiviert, das bisherige Archiv bleibt.

## Erfassungswege

| Weg | Quelle | Erfassung | Stand |
| --- | --- | --- | --- |
| Exchange-Online-Journaling | Microsoft 365 | **echt**: beim Transport, vor der Zustellung | seit 0.1.0 (Business, Service Provider) |
| Graph-Erfassung | Microsoft 365 | **zeitnah**: kurz nach der Zustellung aus dem Postfach | geplant für 0.4.4 |
| Weiterleitung an die Journal-Adresse | IMAP-Anbieter mit serverseitiger Kopie (BCC- oder Weiterleitungsregel), Google Workspace (Routing-Regel) | **echt**: beim Transport des Anbieters | geplant für 0.4.4 |
| IMAP-Archivierung | jedes IMAP-Konto, auch Google Workspace | **zeitnah**: aus dem Postfach, laufend | geplant für 0.4.4 |
| Datei-Import mit "gleichzeitig archivieren" | EML, MSG, MBOX, ZIP, MailStore-Export | **nachträglich** | seit 0.1.0 |

Jedes Archivobjekt trägt seinen Erfassungsweg (`source`: `journal`, `graph_sync`, `imap_sync`,
`file_import`; ab 0.4.4 zusätzlich `smtp_forward` für die Weiterleitung). Suche, Detail, Export und
Nachweisbericht nennen ihn; eine importierte oder zeitnah erfasste Mail erscheint nie als
Journal.

1. **Exchange-Online-Journaling.** SMTP-Journal-Report an `journal+<token>@<Journal-Host>`
   (Einrichtung: Abschnitt "Exchange-Online-Journaling einrichten"). Erfasst ein- und
   ausgehend, intern und extern, inklusive BCC über den Umschlag. Restow speichert das
   Original (message/rfc822) byte-genau und den Umschlag als JSON. **Geplant für 0.4.4:**
   Restow erzeugt die Befehle für Exchange Online PowerShell (Journalregel, Adresse für nicht
   zustellbare Journalberichte) zum Kopieren und meldet den ersten angekommenen Report.
2. **Graph-Erfassung (geplant für 0.4.4).** Restow abonniert für jedes archivierte Postfach
   die Benachrichtigungen über neue Mails (Microsoft Graph) und holt jede neue Mail kurz nach
   der Zustellung; ein regelmäßiger Abgleich holt nach, was eine verlorene Benachrichtigung
   verpasst hat. Gelöschte Mails liest Restow aus "Wiederherstellbare Elemente". Nötig ist
   nur die App-Zustimmung, die es für die Sicherung schon gibt: kein Port 25, kein
   Mail-Hostname, keine Journalregel. Damit auch schnell gelöschte Mail erfasst wird, sollte
   im Mandanten eine Aufbewahrungsrichtlinie oder ein Litigation Hold aktiv sein. Graph gibt
   darüber keine Auskunft: Die Archiv-Seite zeigt je Microsoft-365-Quelle die Befehle für
   Exchange Online PowerShell, die es prüfen, und der Administrator bestätigt den Hold dort
   (auditiert); ohne Bestätigung steht dort "Hold nicht bestätigt". Einmalig übernimmt die Graph-Erfassung auch den Altbestand, markiert
   als nachträglich erfasst.
3. **Weiterleitung an die Journal-Adresse (geplant für 0.4.4).** Für Anbieter ohne
   Exchange-Journaling: Der Anbieter schickt serverseitig eine Kopie jeder ein- und
   ausgehenden Mail an die Journal-Adresse des Mandanten (zum Beispiel eine BCC-Regel in
   Postfix, mailcow oder beim Hoster, eine Routing-Regel "Weitere Empfänger hinzufügen" in
   Google Workspace). Der Empfänger nimmt dann außer Exchange-Journalberichten auch solche
   Kopien an. Absender und Empfänger stehen bei einer solchen Kopie nur in den Kopfzeilen
   (From, To, Cc, Delivered-To); BCC-Empfänger sind darin nicht sichtbar. Eine eigene Adresse je
   Konto ordnet die Kopie trotzdem eindeutig dem richtigen Postfach zu. Die Kopie entsteht beim
   Transport des Anbieters, also wie beim Journaling vor jedem Zugriff des Nutzers. Je
   IMAP-Konto zeigt Restow, wie die Regel einzurichten ist, und ob schon Kopien ankommen.
4. **IMAP-Archivierung (geplant für 0.4.4).** Laufender Abgleich des Postfachs (IDLE oder
   Intervall), Erfassung sobald die Mail im Postfach liegt; für Anbieter ohne Weiterleitung
   die bestmögliche Näherung und als solche gekennzeichnet. Übernimmt einmalig auch den
   Altbestand. Liefert die Weiterleitung dieselbe Mail, wird sie über Message-ID und
   Inhalts-Hash zusammengeführt; das Archiv behält den früheren, stärkeren Erfassungsweg.
5. **Datei-Import (Erfassungsweg `file_import`).** Mails aus einem Altpostfach (EML, MSG,
   MBOX, ZIP, MailStore-Export), die der Administrator beim Import ins Archiv übernimmt
   (docs/IMPORT.md). Die Frist beginnt mit der Erfassung (dem Import), das Sendedatum der
   Mail steht in `sent_at`; die Unveränderbarkeit gilt erst ab Erfassung, wie bei jeder
   nachträglichen Erfassung.

### Echt oder zeitnah

**Echtes Journaling** (Exchange-Journalregel, Weiterleitung beim Anbieter): Die Kopie entsteht
beim Transport, bevor die Mail in einem Postfach liegt. Kein Nutzer, keine Postfachregel und
kein Client kann vorher eingreifen. Der Umschlag nennt alle Empfänger, auch BCC und aufgelöste
Verteiler, und auch Mail, die nie in einem Postfach landet oder sofort gelöscht wird, ist
erfasst. Das ist der stärkste Nachweis für "vollständig und vor jeder Veränderung erfasst".
Der Preis: Restow muss Mail von außen annehmen (Port 25, eigener Hostname mit TLS), und ist
Restow länger nicht erreichbar, gibt der Absender die Zustellung irgendwann auf.

**Zeitnahe Erfassung** (Graph, IMAP): Restow holt die Mail kurz nach der Zustellung aus dem
Postfach. In dieser Lücke kann eine Mail verschoben oder gelöscht werden; ein Hold im
Microsoft-365-Mandanten schließt die Lücke für gelöschte Mail weitgehend, bei IMAP gibt es
dafür nichts Vergleichbares. BCC sieht Restow nur beim Absender; Mail, die eine Anwendung ohne
Kopie in "Gesendete Elemente" verschickt, fehlt.

Kurz: Journaling beweist jede Mail so, wie sie durch den Server ging; die zeitnahe Erfassung
liefert jede Mail so, wie sie kurz danach im Postfach lag. Restow kennzeichnet beides und
behauptet für die zeitnahe Erfassung keine Vollständigkeit.

## Exchange-Online-Journaling einrichten

Journaling liefert die Kopie jeder Mail an Restow, bevor der Nutzer sie verändern oder
löschen kann. Die Einrichtung hat zwei Seiten: die Installation (Betreiber) und den
Microsoft-365-Mandanten (Administrator des Kunden). Den Stand zeigt Restow selbst: Archiv,
Abschnitt "Exchange-Journaling" (Mandanten-Administrator, Edition Business oder Service
Provider, Fähigkeit `archive.journalReceiver`). Ohne die Edition erscheint der Abschnitt
nicht, die API-Pfade antworten mit 404. Microsoft verlangt, dass das Ziel der Journalberichte
außerhalb von Exchange Online liegt; am SMTP-Weg führt beim Journaling deshalb nichts vorbei.

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

### Zuordnung zu Postfächern (seit 0.3.0)

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
- Suche, Export und Legal Hold je Postfach berücksichtigen zugeordnete Journal-Reports.
- Reports, die vor 0.3.0 eingegangen sind, haben keine Zuordnung; sie gehören weiter nur dem
  Mandanten.

### Grenzen

- Journaling erfasst ab der Aktivierung. Altbestand lässt sich bis 0.4.3 nur als Export des
  Postfachs über den Datei-Import mit "gleichzeitig archivieren" aufnehmen und ist dann als
  nachträglich erfasst markiert. Geplant für 0.4.4: Die Graph-Erfassung übernimmt den
  Altbestand einmalig selbst.
- Der Empfänger verlangt STARTTLS (Abschnitt "TLS-Zertifikat") und startet nicht ohne
  gültiges Zertifikat. Die Prüfung des Absenders (SPF, Microsoft-Adressbereiche) ist
  noch nicht umgesetzt; die Annahme beschränkt sich auf bekannte Journal-Adressen, ein
  einfaches Rate-Limit je Absender-IP (im Arbeitsspeicher der API) und das Größenlimit
  (`JOURNAL_MAX_SIZE_MB`, Standard 150 MB; größere Reports werden abgewiesen).

### Journaling und Postfach-Sicherung

Journaling ersetzt die Sicherung der Postfächer nicht, und die Sicherung ersetzt das
Journaling nicht. Beide laufen unabhängig: Das Archiv ändert keinen Sicherungslauf, lässt
keinen aus und dedupliziert keinen; gemeinsam ist nur der Chunk-Store des Mandanten.

Journaling erfasst, was Exchange Online beim Transport sieht, und zwar in dem Moment, in dem
die Mail durch den Transport geht:

- ein- und ausgehende Mail, intern und extern, BCC-Empfänger über den Umschlag, sofern die
  Journalregel diese Nachrichten erfasst (Nachrichtentyp "Alle Nachrichten" für alle
  Absender und Empfänger, Abschnitt "Microsoft 365"). Eine Regel nur für externe Mail
  ("Extern") oder nur für bestimmte Benutzer erfasst interne Mail bzw. die übrigen
  Postfächer nicht;
- den Stand beim Versand: Was ein Nutzer danach ändert, verschiebt oder löscht, ändert die
  Kopie im Archiv nicht.

Journaling erfasst nicht:

- Kalender, Kontakte, Aufgaben und Notizen, auch keine Termin-Antworten als
  Postfachobjekte (eine Einladung, die als Mail transportiert wird, liegt als Mail im Archiv);
- Entwürfe und alles, was nie versendet wurde;
- die Ordnerstruktur, den Ordner einer Mail, Gelesen- und Kennzeichnungsstatus, Kategorien
  und spätere Verschiebungen;
- spätere Änderungen und Löschungen: Das Archiv zeigt den Stand beim Transport, nicht den
  aktuellen Stand des Postfachs, und kann ein Postfach nicht in einen früheren Zustand
  zurückversetzen (Wiederherstellung in die ursprünglichen Ordner);
- Mail, die vor der Aktivierung des Journalings im Postfach lag (Altbestand, Abschnitt
  "Grenzen");
- Mail, die nicht durch den Exchange-Online-Transport geht: von außen direkt ins Postfach
  importiert (PST-Import, Migration, Graph oder IMAP), oder die der Transport abweist bzw. in
  die Quarantäne legt, bevor die Journalregel greift;
- Reports, die Restow nicht erreichen (Connector, Firewall, Zertifikat): Exchange Online
  schickt sie an das Postfach für nicht zustellbare Journalberichte, nicht ins Archiv.

Die Postfach-Sicherung (docs/MICROSOFT.md, docs/IMAP.md) erfasst Mail, Kalender und Kontakte mit
Ordnern und Status zum Zeitpunkt des Laufs und stellt sie wieder her. Sie sieht nicht, was
zwischen zwei Läufen eintrifft und wieder gelöscht wird, und ist nicht unveränderbar:
Sicherungspunkte laufen nach ihrer Aufbewahrungsrichtlinie ab.

Wann was:

- **Wiederherstellen können** (gelöschte Mail, ganze Ordner, Kalender, ein Postfach nach
  einem Fehler oder Angriff): Postfach-Sicherung. Sie ist immer nötig.
- **Nachweisen können** (GoBD, Aufbewahrungsfristen, Legal Hold, vollständige Mail vor jeder
  Änderung durch Nutzer): Journaling ins Archiv, zusätzlich zur Sicherung.
- Ist das Journaling für einen Mandanten aktiv, ist neue Mail ab ihrem Eingang im Archiv
  erfasst. Eine seltenere Sicherung (zum Beispiel alle 8 Stunden oder täglich statt
  stündlich) verkleinert dann nur das Fenster, in dem Kalender, Ordner und Status verloren
  gehen können, nicht die Erfassung der Mail. Restow stellt die Häufigkeit nicht selbst um; der
  Job-Editor schlägt "alle 8 Stunden" vor und übernimmt es erst auf Klick.

## Speicherung

- Archivobjekte gehen in den Chunk-Store wie Backup-Objekte, zusätzlich ein versiegelter
  Datensatz je Objekt: `tenants/<tid>/archive/<jahr>/<monat>/<archive_item_id>.json`
  (Format: `packages/core/src/archive/FORMAT.md`). Auf einem S3-Ziel mit Object Lock
  (Compliance-Modus) trägt dieser Datensatz eine Retention bis zum Fristende des Archivs.
- **Seit 0.4.0** lässt sich Object Lock je Repository einschalten (docs/STORAGE.md,
  "Immutable backups"). Dann sind auch die Packs des Chunk-Stores gesperrt, also auch die
  Inhalte archivierter Mails: für die Frist des Repositories (1 bis 3650 Tage), verlängert,
  solange sie gebraucht werden. Diese Frist ist eine Einstellung des Repositories, nicht die
  Archivfrist. Ohne Object Lock am Repository tragen die Packs keine Retention, und Hardware-WORM
  schützt den Inhalt einer Mail nicht.
- Hash-Kette: `archive_items.chain_hash = SHA-256(prev_chain_hash || item_hash ||
  received_at)`. Nach Ende eines UTC-Tages schreibt der nächtliche Ankerlauf des Workers
  (`apps/worker/src/handlers/archive-anchor.ts`, zusammen mit den Audit-Ankern) je Mandant
  einen Anker in `archive_anchor`: Datum, Kettenwert des letzten Eintrags des Tages und die
  Länge der Kette bis dahin; jeder Anker steht zusätzlich im Worker-Log. Die Archivprüfung
  (`apps/api/src/features/archive/verify.ts`, Schaltfläche auf der Archiv-Seite) prüft drei
  Dinge und nennt jedes im Ergebnis: die Verkettung aller Einträge (erster Bruch mit Position
  ab 1 und Element), den Abgleich mit jedem Anker (erkennt am Ende abgeschnittene Einträge bis
  zum neuesten Anker; Einträge danach sind noch nicht versiegelt) und optional eine Stichprobe
  von Nachrichten, die aus dem Speicher gelesen und mit Größe und SHA-256 der Erfassung
  verglichen werden. Jede Prüfung steht im Audit-Log (`archive.chain.verified`). Zielbild:
  Versand der Anker per E-Mail und externe Zeitstempel (RFC 3161).
- Dedupe: Gleiche Inhalte liegen im Chunk-Store einmal je Mandant. Zielbild: gleiche Mail an
  mehrere Postfächer als ein Original mit mehreren Zuordnungen (die Zuordnung zu Postfächern
  gibt es seit 0.3.0, das Original liegt aber je Erfassung einmal im Archiv).
- Ohne Object Lock (lokaler Speicher, NFS, S3 ohne Lock): Restow erzwingt Unveränderbarkeit
  nur auf Anwendungsebene (kein Lösch- oder Änderungspfad im Code, Kettenprüfung); wer Zugriff
  auf die Dateien oder den Server hat, kann sie ändern oder löschen. Die Seite Repositories
  zeigt solche Ziele als "Kein Hardware-WORM" bzw. "Object Lock nicht aktiviert", die
  Archiv-Seite sagt, wie der Speicher archivierte Mail schützt.
- Das Feld `object_lock` eines Archivobjekts und der Zähler `objectLocked` in Archivstatus und
  Nachweisbericht bedeuten "hat ein Fristende", nicht "liegt unter Object Lock".

## Retention und Löschung

Für jeden Mandanten gilt bis heute eine feste Voreinstellung: 8 Jahre, Fristende am
31. Dezember des Jahres des Eingangs plus 8 Jahre
(`apps/api/src/features/archive/retention-policy.ts`). Die Archiv-Seite zeigt sie
(`GET /api/v1/archive/retention`); weder API noch Oberfläche setzen eine andere. Löschlauf
und Legal Hold sind Edition Business und Service Provider.

- Zielbild: Richtlinie je Mandant (wählbar 6/8/10/unbegrenzt), optional je Postfach-Gruppe.
  Fristbeginn = Erfassungsdatum (oder Kalenderjahresende, wie AO § 147 Abs. 4 rechnet).
- Legal Hold mit Grund, Anleger und Datum; blockiert die Löschung und wird auditiert. Er gilt
  mandantenweit oder je Postfach (seit 0.3.1), nicht je Suchergebnis (Zielbild). Ein Hold je
  Postfach schützt die Archivobjekte, die diesem Postfach gehören: aus dem Datei-Import und die
  ihm zugeordneten Journal-Reports. Reports ohne Zuordnung schützt nur ein mandantenweiter
  Hold. Die Freigabe verlangt einen Grund (`DELETE /archive/legal-holds/:id` mit
  `{ "reason": … }`), den das Audit-Log (`archive.legal_hold.released`) festhält; ein bereits
  freigegebener Hold wird nicht ein zweites Mal freigegeben (409).
- Löschlauf: täglich (Aufgabe `retention`, empfohlener Zeitplan 04:30), löscht nur abgelaufene
  Objekte ohne Hold und schreibt jede Löschung ins Audit-Log. Zielbild: ein Löschprotokoll
  (Anzahl, Zeitraum, Hashes der gelöschten Objekte) als eigener Eintrag der Kette.

## Suche und Export

- Volltextsuche über Betreff, extrahierten Text des Bodys (sehr lange Bodies können gekürzt
  sein) und Umschlag (Absender, Empfänger), mit Filter nach Datum und "hat Anhang". Postgres
  `to_tsvector('simple', ...)`, kein Stemming. Nur Administratoren des Mandanten suchen
  (auditiert, je Suche und je gelesenem Element). Jeder Treffer nennt seinen Erfassungsweg,
  ab 0.4.4 auch die Wege, die dieselbe Mail erneut erfasst haben, und "nachträglich erfasst".
  Eine Erfassung, die ein stärkerer Weg ersetzt hat, blendet die Suche aus ("Ersetzte
  Erfassungen zeigen" listet sie, `includeSuperseded=true`); das Detail verweist in beide
  Richtungen. Ein Export nach Filter enthält ersetzte Erfassungen weiterhin.
- Lesen (Leseansicht) und Herunterladen (`.eml`) einer archivierten Nachricht, beides im
  Audit-Log.
- Export: Mails aus Archiv (Auswahl oder aktuelle Suche), Sicherung oder importiertem Postfach
  als EML in einem ZIP mit Ordnerstruktur, `MANIFEST.csv` und `SHA256SUMS`, oder als MBOX
  (docs/IMPORT.md, Abschnitt Export). Der Export ist ohne Restow lesbar.
- Nachweisbericht als API (JSON): `GET /api/v1/archive/report` (Scope `archive:read`,
  höchstens 366 Tage) mit Mandant, Zeitraum, Anzahl, Erfassungswegen, Kettenzustand,
  Retention-Richtlinie und Legal Holds.
- Zielbild: Suche in Anhängen (PDF, DOCX, XLSX, TXT) und nach Postfach und Größe;
  Selbstbedienungssuche der Endnutzer im eigenen Postfach; Zugriff eines Provider-Admins nur mit
  Freigabe durch den Mandanten; `CHAIN.txt` im Export; der Nachweisbericht als signiertes PDF
  in der Oberfläche.

## Verfahrensdokumentation (Zielbild)

Generiert je Mandant aus Konfiguration und Vorlage: Systembeschreibung, Erfassungswege,
Speicherort, Verschlüsselung, Zugriffsrechte, Retention, Löschverfahren, Kontrollen
(Kettenprüfung, Scrub), Verantwortliche, Änderungshistorie. Als Markdown und PDF,
versioniert, mit Datum. Das Dokument ist Bestandteil der Prüfungsfähigkeit, nicht Kür.

## Umsetzungsstand 0.4.4

Wird zur Freigabe von 0.4.4 abgeschlossen. Bis dahin beschreiben die Zeilen den geprüften Stand
von 0.4.3; was hier nicht steht, ist nicht umgesetzt.

- **Erfassung.** Archivobjekte entstehen auf zwei Wegen: durch den SMTP-Journal-Empfänger
  (Exchange-Online-Journaling, Edition Business und Service Provider) und durch den
  Datei-Import mit "gleichzeitig archivieren". Graph-Erfassung, Weiterleitung von
  IMAP-Anbietern und IMAP-Archivierung gibt es noch nicht.
- **Mail-Job.** Zweck Sichern, Archivieren oder beides (seit 0.4.2); Archiv je Job und
  Zuordnung der Journal-Reports zu den genannten Postfächern (seit 0.3.0). In 0.4.3 nennt der
  Editor als Erfassungsweg für jede Art von Postfach nur das Exchange-Journaling; 0.4.4 bietet
  je Art die passenden Wege an (Abschnitt "Archiv im Mail-Job").
- **Journal-Empfänger** (`ee/api/src/journal/`, Teil der api-Rolle). Er braucht
  `JOURNAL_SMTP_PORT`, `JOURNAL_HOSTNAME` und ein TLS-Zertifikat; ohne gültiges Zertifikat
  öffnet er den Port nicht. STARTTLS ist Pflicht. Unbekannte Empfänger werden bei RCPT TO
  abgelehnt (550), bei Speicher- oder Datenbankfehlern antwortet er 451. Zertifikate werden
  alle fünf Minuten neu gelesen. Nicht umgesetzt: die Prüfung des Absenders (SPF,
  Microsoft-Adressbereiche).
- **Speicherung.** Originale byte-genau und verschlüsselt im Chunk-Store, je Objekt ein
  versiegelter Datensatz mit der Hash-Kette, tägliche Anker. Mit Object Lock am Repository
  (seit 0.4.0) sind auch die Packs gesperrt; auf lokalem Speicher und NFS gilt die
  Unveränderbarkeit nur auf Anwendungsebene. Externe Zeitstempel gibt es nicht.
- **Archivprüfung** (Verkettung, Anker, Inhaltsstichprobe) als API und Schaltfläche, synchron
  in einer Anfrage; ein Hintergrundlauf mit Fortschritt ist nicht umgesetzt.
- **Suche, Lesen, Export** wie im Abschnitt "Suche und Export"; nicht über Anhänge, nur für
  Administratoren des Mandanten.
- **Retention.** Fest 8 Jahre bis zum Jahresende des Eingangsjahres. Der tägliche Löschlauf
  (`ee/worker/src/archive-retention/`) löscht nur abgelaufene Objekte ohne Legal Hold.
- **Legal Hold** (`ee/api/src/legal-holds/`): mandantenweit oder je Postfach, Freigabe mit
  Grund.
- **Nachweisbericht.** Nur als API (JSON), kein PDF, keine Oberfläche.
- **Audit-Log.** Aufgezeichnet wird in jeder Edition; die Ansicht mit Filter und
  Kettenprüfung ist Business und Service Provider.
- **IMAP-Quellen** melden sich mit Passwort an. Die Engine kennt OAuth2 (Microsoft, Google,
  eigener Anbieter), API und Oberfläche bieten es aber noch nicht an (docs/IMAP.md).

## Geplant für 0.4.4

- Job-Editor erkennt die Art der Quelle (Microsoft 365, IMAP, Google Workspace über IMAP) und
  bietet nur passende Erfassungswege an; Journal-Adressen nur dort, wo sie gebraucht werden.
- Graph-Erfassung für Microsoft 365 als einfacher Standard, mit Prüfung des Holds im Mandanten
  und Übernahme des Altbestands.
- Exchange-Journaling vereinfacht: fertige PowerShell-Befehle und Meldung des ersten Reports.
- Weiterleitung an die Journal-Adresse für IMAP-Anbieter und Google Workspace, mit Anleitung und
  Empfangsstatus je Konto.
- IMAP-Archivierung (laufender Abgleich) mit Übernahme des Altbestands.
- Zusammenführen derselben Mail aus mehreren Erfassungswegen (Message-ID, Inhalts-Hash).

## Was Restow nicht behauptet

- Keine "Zertifizierung" (IDW PS 880 ist ein Prüfungsstandard für Software, teuer und
  optional; wir sagen "GoBD-orientiert" und beschreiben die Maßnahmen).
- Kein Ersatz für die Prüfung durch Steuerberater oder Datenschutzbeauftragte.
- Keine Garantie der Vollständigkeit für zeitnah erfasste Mail (Graph, IMAP): Sie ist als
  solche gekennzeichnet.
- Keine Hardware-WORM-Garantie ohne Object Lock: Auf lokalem Speicher und NFS ist die
  Unveränderbarkeit nur Anwendungsebene.
