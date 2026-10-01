# Mail-Import und -Export

Dieses Dokument beschreibt, wie Restow Mail-Dateien einliest (Altpostfach, das als
Postfach nicht mehr existiert, aber aufbewahrt werden muss) und wie es Mails als Dateien
wieder ausgibt (Export aus Sicherung, importiertem Postfach und Archiv). Es ergänzt
docs/IMAP.md (Speicherformat der Postfächer) und docs/ARCHIVE.md (Archiv, Retention).

## Was es kann und was nicht

Import (0.1.0):

| Quelle | Umfang |
|---|---|
| EML | einzelne Dateien, Ordner, ZIP |
| MSG (Outlook) | einzelne Dateien, Ordner, ZIP. Nur Mail-Nachrichten; Kontakte, Termine und Aufgaben in MSG-Form werden als "keine Mail" gemeldet, nicht importiert |
| MBOX | Thunderbird (auch `.sbd`-Ordner), Apple Mail (`X.mbox/mbox`), Dovecot/Postfix-Exporte, Google Takeout. Zeilenenden CRLF und LF, mboxrd-Maskierung wird zurückgenommen |
| ZIP | Ordnerstruktur im Archiv wird zur Ordnerstruktur des Postfachs; darin EML, MSG und MBOX |
| MailStore | ein Export als EML- oder MSG-Ordnerbaum (Ordner oder ZIP davon). **Das interne Archivformat von MailStore kann Restow nicht lesen.** In MailStore "E-Mails exportieren" nach Dateisystem (EML oder MSG) wählen |

Nicht Teil von 0.1.0 (Roadmap):

- **PST und OST.** Die Dateien werden am Inhalt (`!BDN`) erkannt und mit einer klaren
  Meldung abgelehnt, nie geparst. Es gibt in 0.1.0 keine PST-Abhängigkeit. Ausweg:
  aus Outlook als MSG/EML exportieren (Nachrichten in einen Ordner ziehen) oder mit einem
  Konverter nach MBOX wandeln.
- **PST-Export.** Es gibt keinen Node-Schreiber für PST mit tragbarer Lizenz. Geplant ist ein
  eigener Schreiber nach der offenen Spezifikation [MS-PST] (Roadmap, nicht Teil von 0.1.0).
  Die Oberfläche zeigt PST als "geplant". Outlook öffnet den EML-Export per Drag and Drop, MBOX lässt sich mit gängigen
  Werkzeugen importieren.
- **Kalender und Kontakte** aus Mail-Dateien: nur Mail wird importiert und exportiert. Ein
  MSG, das ein Termin oder Kontakt ist, steht im Bericht als "keine Mail".
- Wörtlich vom Original: EML und MBOX werden **byte-genau** gespeichert. Eine MSG-Datei
  enthält kein RFC 5322; Restow **rekonstruiert** daraus eine EML aus den gespeicherten
  Eigenschaften (Kopfzeilen, wenn Outlook sie mitgespeichert hat, Text, HTML, Anhänge,
  eingebettete Nachrichten). Der Bericht zählt diese Nachrichten ("aus MSG rekonstruiert").

## Datenmodell

Ein Import erzeugt ein **importiertes Postfach**. Das ist kein neuer Objekttyp, sondern

- eine Quelle der Art `import` (pro Mandant eine, "Imported mail files", ohne Server und
  ohne Zugangsdaten), und
- ein `protected_objects`-Eintrag der Art `imap` unter dieser Quelle (`origin = manual`,
  `external_id = import-<uuid>`).

Begründung: Das Speicherformat ist bewusst **dasselbe wie beim IMAP-Backup**
(`packages/core/src/backup/imap/paths.ts`): je Nachricht `mail/<Ordner>/<uid>.eml`
(byte-genau, im verschlüsselten Chunk-Store), je Ordner ein Ordnerobjekt, dazu Metadaten
(`mailbox`, `delimiter`, `uid`, `uidValidity`, `flags`, `internalDate`, `messageId` und der
Umschlag: Betreff, Absender, Empfänger, Anhang ja/nein, Sendedatum). Damit funktionieren
Restore-Explorer, Vorschau, Download, IMAP-Restore und die Prüfsummen ohne Sonderpfade. Ein
eigener Objekttyp hätte über 60 Stellen (Planung, Dashboard, Lizenzzählung, Explorer, API)
angefasst, ohne dass ein Restore dadurch besser würde. Die Unterscheidung steckt in der
Quellenart:

- Es wird nie etwas gesichert (der Backup-Handler lehnt ein `imap`-Objekt unter einer
  Quelle, die kein IMAP-Server ist, ab); Zeitpläne, Dashboard, Statistik, Verzeichnis,
  Lizenzzählung und die Integrations-API übergehen Objekte aus Quellen der Art `import`.
  Ein importiertes Postfach ist nie "nicht geschützt" und nie "überfällig".
- "Ins Original zurückspielen" gibt es nicht (kein Original): 422
  `restore-original-not-available`. Ziele sind ein bestehendes IMAP-Konto oder ein
  Microsoft-365-Postfach (dann über die Exchange-Restore-Engine, die das IMAP-Manifest
  liest) oder ein Download.

Jeder Import schreibt einen **neuen Snapshot** des Postfachs, der alles aus dem vorigen
Snapshot enthält plus das Neue (additiv, nichts wird entfernt). Man kann so ein Altpostfach
aus mehreren Dateien nacheinander aufbauen.

### Ordner und Namen

- `a.eml`/`a.msg` ohne Verzeichnis landet im Ordner `Imported`.
- Verzeichnisse werden zu Ordnern (`dir/sub/a.eml` nach `dir/sub`); leere Verzeichnisse
  bleiben als leere Ordner erhalten.
- MBOX-Datei `x.mbox` oder `Inbox` (ohne Endung, erkannt am Inhalt) wird zum Ordner `x`
  bzw. `Inbox`; `Inbox.sbd/`-Verzeichnisse (Thunderbird) werden zu Unterordnern von
  `Inbox`; Apple Mail `X.mbox/mbox` wird zu `X`.
- In einem ZIP gibt die Pfadstruktur die Ordner vor; Einträge ohne Verzeichnis kommen in
  einen Ordner mit dem Namen der ZIP-Datei.
- UIDs sind ein fortlaufender Zähler je Ordner (UIDVALIDITY ist immer `1`).

### Duplikate

Eine Nachricht mit derselben Message-ID **und** demselben SHA-256 im **selben Ordner** ist
ein Duplikat: sie wird nicht noch einmal gespeichert, aber im Bericht gezählt und mit
Fundstelle aufgelistet. Dieselbe Nachricht in einem anderen Ordner bleibt erhalten (die
Ordnerzuordnung ist Information), teilt aber im Chunk-Store dieselben Chunks
(mandantenweite Deduplizierung; dazu der Message-ID-und-Hash-Index der IMAP-Engine). Die
Prüfung schließt frühere Importe desselben Postfachs ein: dieselbe Datei zweimal zu
importieren ergibt beim zweiten Mal "nichts Neues" und keinen Snapshot. Der Auftrag gilt dann als
erfolgreich (Status `completed`), nicht als fehlgeschlagen: der Bericht zählt alle Nachrichten als
Duplikate und die Oberfläche sagt, dass alle N Nachrichten bereits importiert waren. Fehlgeschlagen
bleibt ein Lauf nur, wenn ohne neue Nachricht auch etwas nicht lesbar war oder keine Mail gefunden
wurde.

## Wege für die Dateien

### Upload im Browser

- Chunked und wiederaufnehmbar: die Datei wird in Stücken (Standard 8 MiB, 64 KiB bis 32
  MiB) gesendet, drei parallel, jedes mit SHA-256-Prüfsumme; ein Abbruch (Netz, Tab
  geschlossen) verliert nur die laufenden Stücke. Wird dieselbe Datei (Name, Größe) wieder
  gewählt, sendet die Oberfläche nur die fehlenden Stücke.
- **Verschlüsseltes Staging**: jedes Stück wird sofort mit AES-256-GCM (Mandantenschlüssel,
  gebunden an Mandant, Upload und Position) als eigenes Objekt im primären Speicherziel des
  Mandanten abgelegt (`tenants/<tid>/staging/<upload>/`). Der Worker liest die Datei später
  wahlfrei aus diesen Stücken (ZIP braucht das); **es entsteht keine Klartextkopie auf
  einer Platte**, und nie liegt eine ganze Datei im Speicher (höchstens ein Stück, oder
  eine einzelne Nachricht bis `IMPORT_MAX_MESSAGE_BYTES`).
- Limits: `IMPORT_MAX_FILE_BYTES` (Standard 10 GiB) je Datei, höchstens 20 offene Uploads je
  Mandant, `IMPORT_UPLOAD_TTL_HOURS` (48 h). Abbrechen löscht die Stücke sofort.
- **Staging-Budget** je Mandant: `IMPORT_MAX_STAGING_BYTES` (Standard 100 GiB). Gezählt
  werden die angekündigten Größen aller Uploads, deren Stücke noch liegen (offene Uploads
  und die Dateien eines Imports, der noch nicht beendet ist). Ein neuer Upload, der nicht
  mehr hineinpasst, wird mit 422 `urn:restow:problem:import-staging-full` abgewiesen,
  bevor das erste Stück gesendet wird (die Prüfung läuft unter derselben Sperre wie die
  Zählung der offenen Uploads, zwei gleichzeitige Uploads überschreiten das Budget also nicht).
  Die Oberfläche sagt, was zu tun ist (Import abwarten oder einen Upload entfernen, große
  Dateien in den Server-Ordner legen) und bietet "Erneut versuchen" an. Der Server-Ordner
  belegt kein Staging und zählt nicht mit.
- Der Dateityp wird beim Abschluss **am Inhalt** erkannt (erste 64 KiB), nie an der
  Endung. PST/OST und Unbekanntes werden mit Grund abgewiesen und können nicht importiert
  werden.
- Aufgeräumt wird: sofort nach dem Import, beim Abbruch, bei Ablauf; der Retention-Lauf
  räumt Reste (`mail-files`-Aufgabe): abgelaufene und abgebrochene Uploads, die Dateien
  eines Imports, der für immer beendet ist (fertig, ohne Wiederholung fehlgeschlagen,
  abgebrochen), Staging-Ordner, die keine Zeile mehr kennt (etwa weil die Zeilen mit den
  Daten des Mandanten gingen), und Uploads, deren Job-Zeile verschwunden ist, nach 48
  Stunden. Solange ein Import noch wiederholt werden kann, bleibt sein Staging liegen.

### Server-Ordner

Ein eingehängtes Verzeichnis (`RESTOW_IMPORT_DIR` auf dem Host, im Container
`/var/lib/restow/import`, in api **und** worker **schreibgeschützt**, siehe
docker-compose.yml). **Jeder Mandant hat darin seinen eigenen Unterordner
`<IMPORT_DIR>/<Mandanten-Slug>/`** (auch eine Installation mit einem einzigen Mandanten;
der Slug steht in den Mandanteneinstellungen, die Oberfläche zeigt den vollen Pfad an).
Der Administrator legt Dateien oder ganze Ordnerbäume (etwa einen MailStore-Export) dort
ab und wählt sie in der Oberfläche. Ohne diese Trennung könnte der Administrator eines
Mandanten Dateien sehen und importieren, die ein anderer Mandant abgelegt hat; API und
Worker prüfen deshalb beide, dass ein Pfad unterhalb des eigenen Unterordners liegt
(API: Listing und Auswahl, Worker: zweite Prüfung vor dem Lesen). Der Ordner wird nie
beschrieben und nie geleert. Pfade werden gegen Ausbrüche geprüft (`..`, Symlinks nach
außen, keine Sonderdateien). Das Verzeichnis muss für den Benutzer der Container lesbar
sein; den Unterordner des Mandanten legt der Betreiber an.

## Der Import-Job

- Ein Worker-Job (Queue `import`, Wiederholungen wie ein Backup) mit Fortschritt:
  Gesamtgröße und gelesene Bytes der Quelldateien (Prozent, Restzeit), dazu Zähler (Nachrichten,
  Duplikate, übersprungen, fehlgeschlagen) und die Phase.
- **Wiederaufnahme**: nach jeder fertigen Datei und alle 500 Nachrichten (oder 256 MiB)
  Checkpoint (Packs, Teil-Manifest, Cursor). Der Cursor nennt Datei und Elementnummer; ein
  neu gestarteter Worker liest ab dort weiter (`skipItems`), nie eine Nachricht doppelt. Ändert
  sich die Dateiliste, beginnt der Snapshot von vorn.
- **Fehler je Element sichtbar**: unlesbare oder beschädigte Elemente (kaputte
  MSG/EML, abgeschnittenes ZIP, zu große Nachricht, verschlüsseltes oder verschachteltes ZIP,
  PST) landen als `item_failures` mit Grund und im Bericht; Harmloses (Nicht-Mail-Dateien,
  leere Dateien, Duplikate) ist "übersprungen" und ebenfalls mit Fundstelle aufgelistet.
  Nichts fällt stillschweigend weg.
- **Bericht** (`mail_imports.report`): Nachrichten, Ordner, Anhänge, Duplikate,
  übersprungen, fehlgeschlagen, Bytes (gespeichert und gelesen), je Datei Format,
  SHA-256 der Quelldatei, Zähler und Status (importiert, teilweise, fehlgeschlagen,
  abgelehnt), die Elementliste (Fehler zuerst, höchstens 1000, "weitere" gezählt) und feste
  Hinweise ("Kalender und Kontakte nicht importiert", "aus MSG rekonstruiert").
- **Absturzschutz**: stürzt der Worker-Prozess beim Lesen derselben Datei wiederholt ab
  (Speicher, Absturz im Parser), wiederholt pg-boss den Job nicht endlos. Der Cursor merkt
  sich, bei welcher Datei und welchem Element ein Lauf begann und wie oft er dort abbrach;
  beim zweiten Abbruch in Folge an derselben Stelle wird der Rest dieser Datei als
  `unreadable` im Bericht vermerkt (mit dem Hinweis, sie erneut zu importieren: schon
  vorhandene Nachrichten werden übersprungen) und der Import läuft mit den übrigen Dateien
  weiter. Die Position wird auch gespeichert, solange noch nichts abgelegt ist (vor jeder Datei ab
  1 MiB, sonst höchstens einmal je Sekunde), damit der erste Absturz nicht vergessen wird.
  Ein Absturz im **Kindprozess** des Parsers (siehe unten) ist kein Absturz
  des Workers: er wird als unlesbares Element gemeldet, der Job läuft weiter.
- Findet ein Lauf **keine einzige lesbare Nachricht**, entsteht kein leerer Snapshot: der
  Job schlägt ohne Wiederholung fehl, der Bericht mit allen Gründen bleibt einsehbar.

## Aufnahme ins Archiv (optional)

Wählt der Administrator "auch archivieren", wird jede neu importierte Nachricht ein
Archivobjekt (Erfassungsweg `file_import`): byte-genaues Original (dieselben Chunks wie im
Snapshot), Hash-Kette, Retention des Archiv-Regelwerks, Volltextsuche über Betreff,
Text und Adressen. Wichtig und ehrlich:

- Die **Frist beginnt mit dem Import** (Erfassung), nicht mit dem Datum der Mail. Eine alte
  Mail, die heute importiert wird, ist ab heute unveränderbar und wird ab heute gezählt. Das
  Sendedatum der Mail steht in `sent_at` und wird in Suche und Anzeige bevorzugt.
- Die Unveränderbarkeit gilt erst ab der Aufnahme (wie bei jeder nachträglichen Erfassung, siehe
  ARCHIVE.md).
- Idempotent: was schon archiviert ist (gleicher Hash für dasselbe Postfach), wird nicht
  doppelt angelegt; ein wiederholter Job setzt fort.

## Wiederherstellen aus einem importierten Postfach

Das importierte Postfach erscheint im Restore-Explorer wie jedes andere (Abzeichen
"Importiert"): Ordnerbaum, Suche, Vorschau, Druckansicht, Download, Wiederherstellen in ein
bestehendes IMAP-Konto (APPEND mit Flags und Datum, Message-ID-Prüfung) oder in ein
Microsoft-365-Postfach (Ordnerstruktur unter einem neuen Wiederherstellungsordner; nie
werden vorhandene Elemente ersetzt). Ein "Original" gibt es nicht.

## Export

Formate:

- **EML in einer ZIP-Datei** (`eml_zip`): eine `.eml` je Nachricht, Ordnerstruktur,
  leere Ordner bleiben, dazu `MANIFEST.csv` (Eintrag, SHA-256, Größe, Message-ID, Datum,
  Absender, Empfänger, Betreff, Status) und `SHA256SUMS` (prüfbar mit `sha256sum -c`).
  Die Bytes sind die gespeicherten Originale.
- **MBOX** (`mbox`): mboxrd; ein einzelner Ordner wird eine `.mbox`-Datei, mehrere Ordner
  eine ZIP mit einer `.mbox` je Ordner (plus Manifest und Prüfsummen). Bekannte
  Eigenschaft: eine Nachricht ohne abschließenden Zeilenumbruch bekommt einen.
- **MSG in einer ZIP-Datei** (`msg_zip`): in 0.1.0 **nicht verfügbar**. Es gibt keinen
  MSG-Schreiber für Node mit geklärter, tragbarer Lizenz: `msgkit` ist kein MSG-Schreiber
  (Push-Nachrichten), und `@tutao/oxmsg` (Tuta) besteht den Rundlauf gegen msgreader
  technisch (Betreff, Absender, Empfänger, Datum, Text, HTML, Anhänge byte-genau,
  Inline-Bilder, Message-ID), hat aber einen **Lizenzwiderspruch**: `package.json` und die
  npm-Registry sagen MIT, die Datei `LICENSE.txt` im Paket und im Repository ist die
  GNU GPL-3.0. Eine Abhängigkeit mit unklaren Bedingungen liefert Restow nicht aus. Die
  Auswertung (Code, Tests, Messwerte) liegt als Notiz beim Maintainer; sobald Tuta die
  Lizenz klärt oder ein sauber lizenzierter Schreiber existiert, lässt sich das Format
  wieder anschalten (der Datenbank-Enum `export_format` kennt `msg_zip` bereits). Die
  Oberfläche zeigt MSG deshalb nicht an; EML-ZIP enthält dieselben Nachrichten in der
  Originalform.
- **PST**: nicht verfügbar, siehe oben.

Quellen: Sicherung (M365-Postfach, IMAP-Konto), importiertes Postfach und Archiv (Auswahl
oder Suchfilter). Nur Mail: Kalenderelemente und Kontakte werden gezählt und im Bericht
genannt, nicht exportiert; Nachrichten, die Graph nur in Teilen geliefert hat, haben keine
Originaldatei und stehen als nicht exportierbar im Bericht.

Ablauf: ein Worker-Job (Queue `export`) schreibt die Datei **verschlüsselt** (dieselben
versiegelten Segmente wie beim Upload, `tenants/<tid>/exports/<id>/`) in das Speicherziel
des Mandanten; nichts liegt im Speicher, höchstens eine Nachricht und ein Segment. Beim
Streamen wird der SHA-256 jeder Nachricht gegen das Manifest geprüft: ein beschädigter Chunk
bricht den Export ab, statt eine still fehlerhafte Datei zu liefern. Der Download-Link gilt
`EXPORT_TTL_HOURS` (24 h) nach Fertigstellung, danach löscht der Retention-Lauf die Datei.
**Speicherbudget**: alle noch nicht abgelaufenen Exportdateien eines Mandanten dürfen
zusammen `EXPORT_MAX_TENANT_BYTES` (Standard 50 GiB) belegen. Die API weist eine neue
Anfrage ab, wenn das Budget schon ausgeschöpft ist (422
`urn:restow:problem:export-quota-exceeded`, die Antwort nennt Belegung, Grenze und
Ablaufzeit). Der Worker prüft beim Schreiben noch einmal und zählt die eigene, wachsende
Datei mit: ein Export, der nicht mehr hineinpasst, bricht ab, löscht seine Segmente und
schlägt ohne Wiederholung mit dem Fehlercode `export.quota_exceeded` fehl (Oberfläche und
Benachrichtigung nennen die nächsten Schritte: Ablauf älterer Exporte abwarten, weniger
Post auf einmal exportieren oder das Budget anheben). Das Ergebnis wird unter einer
Sperre je Mandant eingetragen, zwei gleichzeitig endende Exporte überschreiten das Budget
also nicht. Exporte, die fehlschlugen oder abgebrochen wurden, haben kein Ablaufdatum:
ihre Reste (ein Worker, der beim Schreiben starb) löscht der Retention-Lauf eine Stunde
nach Ende des Jobs.
**Anfrage und jeder Download sind im Audit-Log** (`export.requested`, `export.downloaded`,
`export.cancelled`), bei fremden Daten mit Begründung und `onBehalfOf`. Die Prüfsumme der
fertigen Datei steht in der Oberfläche und im Audit-Eintrag.

## Sicherheit und Grenzen

- Erkennung nach Inhalt, nicht nach Endung; ZIP-Schutz: höchstens 2 Mio. Einträge, 256 GiB
  entpackt, Kompressionsfaktor 1000, verschlüsselte und verschachtelte Archive werden
  gemeldet und nicht geöffnet, Einträge werden nie auf eine Platte geschrieben, Namen werden
  bereinigt (`..`, absolute Pfade, Backslashes).
- Einzelne Nachrichten (EML, MSG, eine MBOX-Nachricht) werden in den Speicher gelesen,
  begrenzt durch `IMPORT_MAX_MESSAGE_BYTES` (256 MiB); größere werden gemeldet.
- **Dateien sind Angreifereingaben**: wer Mail importiert oder in einem Postfach eine
  Nachricht hinterlegt, bestimmt die Bytes, die Restow liest. Zwei Fehlerklassen sind
  daher nicht hinnehmbar: Rechenzeit, die den gemeinsamen Worker (oder die API) für alle
  Mandanten blockiert, und Speicher, der den Prozess beendet. Beides wird so begrenzt:
  - **Kindprozesse statt Threads**. Der MSG-Leser, die Metadaten-Auswertung (mailparser)
    und die Vorschau der API laufen in kleinen Kindprozessen (`child_process.fork` von
    `mailfiles/isolate-child.ts`, Pool in `mailfiles/isolate.ts`) mit
    `--max-old-space-size` und einer Wanduhr-Zeitgrenze, nach der der Prozess mit SIGKILL
    beendet wird. Worker-Threads mit `resourceLimits` reichen nicht: eine einzelne große
    Allokation, die die Grenze überschreitet, beendet in Node den **ganzen** Prozess
    ("FATAL ERROR: Reached heap limit", mit Node 22.23.1 und 25.9.0 nachgestellt, etwa
    mailparser `textAsHtml` auf einem 30-MB-Text aus `<`), und ein beendeter Thread, der
    gerade CommonJS-Module lädt, löste einen Abbruch in `node::cjs_lexer` aus. Ein
    Kindprozess kann sterben, ohne den Worker mitzunehmen; Exit-Code, Signal und die
    V8-Meldung auf stderr ordnen den Tod als `timeout`, `memory`, `crashed` oder
    `unavailable` ein. Aus jedem davon wird "unlesbar" (Import-Bericht, Vorschau) und nie
    ein Absturz des Elternprozesses.
  - **Gemeinsame und eigene Prozesse**: Eingaben bis 8 MiB laufen in wiederverwendeten
    Prozessen (512 MB Heap, erneuert nach 2000 Aufgaben oder über 1 GiB RSS, ungenutzte
    Prozesse halten das Programm nicht am Leben); größere Eingaben bekommen einen eigenen
    Prozess mit Heap von 256 MB plus 6 MB je MiB (höchstens 3 GB) und einer Zeitgrenze,
    die mit der Größe wächst (15 s plus 0,5 s je MiB, höchstens 120 s). Gleichzeitig
    laufen `IMPORT_PARSE_WORKERS` Prozesse im Worker bzw. `PREVIEW_PARSE_WORKERS` in der
    API (Standard 2, 1 bis 8), dahinter eine begrenzte Warteschlange.
  - **MSG-Strukturprüfung vor dem Leser** (`mailfiles/cfb-guard.ts`): `@kenjiuno/msgreader`
    folgt FAT-Ketten ohne Schleifenerkennung und legt Puffer in der Größe an, die die Datei
    behauptet. Eine MSG, deren Kopf, FAT/DIFAT, Mini-FAT oder Verzeichnis nicht stimmen
    (Sektorgröße, Ketten, die in sich zurücklaufen oder sich Sektoren teilen, Längen über
    der Dateigröße, mehr als 250 000 Verzeichniseinträge, Baumtiefe über 64), wird gemeldet
    und nie an den Leser gegeben. Gültige Dateien mit DIFAT-Erweiterung und Mini-Stream
    bestehen die Prüfung.
  - **Linearer Aufwand** in den eigenen Auswertungen: Kommentarentfernung in Kopfzeilen,
    HTML zu Text (`@restow/core/html-text`, ein Durchlauf, auch für HTML-only-Nachrichten
    in der Vorschau), Zusammenfassen vieler loser MBOX-Teile, Sammeln der `cid:`-Verweise.
    mailparser läuft ohne Text-zu-HTML-, Link- und Bild-Umwandlung, wo sie nicht gebraucht
    werden (diese erzeugen auf einem 30-MB-Text aus `<` eine einzige Zeichenkette von
    125 MB), und HTML wird für Suche und Vorschau begrenzt.
  - **Vorschau und Anhang-Download der API** (`features/snapshots/preview*.ts`): dieselben
    Kindprozesse. Zuerst die volle Auswertung (gesäubertes HTML), bei Überschreitung ein
    zweiter Versuch nur mit Text (HTML-only-Nachrichten über den linearen Konverter), die
    Oberfläche zeigt "Vereinfachte Ansicht". Bleibt die Nachricht auch dann zu aufwendig,
    antwortet die Vorschau mit dem Zustand "unlesbar" (Kopfdaten aus dem Manifest),
    der Anhang-Download mit 422 `urn:restow:problem:preview-unreadable`; eine Lastspitze
    über Prozesse und Warteschlange hinaus bekommt 503 `urn:restow:problem:preview-busy`,
    statt den Speicher der API wachsen zu lassen. Zeitgrenze `PREVIEW_TIMEOUT_MS` (10 s),
    der Textversuch bekommt die Hälfte. Der Download der EML und die Wiederherstellung
    lesen die gespeicherten Bytes und parsen nichts.
  - **Journal-Empfang des Archivs**: liest seine Reports in denselben
    Kindprozessen der API (`apps/api/src/lib/parser-pool.ts`, docs/ARCHIVE.md, "Lesen der
    Reports"); die 16 wartenden Aufgaben gelten für Vorschau und Journal zusammen.
  - Der Import selbst speichert die Bytes unverändert; was nicht lesbar ist, kostet nur
    die Metadaten (`metadata_unavailable` im Bericht) oder die Nachricht (MSG), nie den Lauf.
- Alle Aktionen sind auditiert: `import.upload.created|completed|cancelled`,
  `import.requested`, `import.cancelled`, `export.requested|cancelled|downloaded`. Lesen von
  Sicherungsdaten im Explorer bleibt wie dort beschrieben auditiert.
- Speicherbedarf: Staging (Größe der Dateien, bis zum Ende des Imports), danach im
  Chunk-Store dedupliziert; Exporte bis zum Ablauf.

## Bekannte Grenzen

- **MSG**: ein Körper, der nur als RTF (oder RTF-verpacktes HTML) vorliegt, wird nicht
  dekodiert; Restow nimmt dann den Text-Körper. Anhänge, die nur auf eine Datei verweisen
  (Referenzanhänge), entfallen. Ein eingebettetes Nicht-Mail-Element bleibt ein
  `.msg`-Anhang. Die Kopfzeilen kommen, wenn vorhanden, unverändert aus den
  Transportkopfzeilen der MSG; ein nachträglich in Outlook geänderter Betreff steht dort
  nicht. Der MSG-Leser läuft hinter der Strukturprüfung in einem Kindprozess mit Zeit- und
  Speichergrenze (siehe Sicherheit); eine beschädigte oder bösartige MSG wird als
  "unlesbar" gemeldet.
- **Andere Archive und Formate**: gz, 7z, rar, tar und Apple `.emlx` werden erkannt und als
  nicht unterstützt gemeldet, nicht geöffnet. Reste von Betriebssystemen (`.DS_Store`,
  `Thumbs.db`, `desktop.ini`, `__MACOSX`, Thunderbird-`.msf`) stehen als "keine Mail" im
  Bericht, nie als Fehler. UTF-16-kodierte EML-Dateien werden nicht als EML erkannt.
- **MBOX**: die Variante mboxrd wird zurückgenommen (ein führendes `>` vor `From `-Zeilen);
  bei mboxo-Dateien, die `>From` schon im Original hatten, ist die Unterscheidung nicht
  möglich. `\Deleted` aus `X-Status` wird nicht übernommen, die Nachricht wird importiert.
- **Metadaten** (Betreff, Absender, Volltext) liest mailparser im Kindprozess; für sehr große
  Nachrichten (Anhänge in Megabyte) dauert das entsprechend und läuft bei Überschreitung
  der Grenzen ab: die Nachricht wird dann trotzdem importiert, aber ohne Betreff, Absender
  und Volltext (Hinweis `metadata_unavailable` im Bericht). Der Import selbst speichert
  die Bytes unverändert, unabhängig davon.
- **Kindprozesse und Speicher**: je Parser-Prozess bis 512 MB Heap (eigene Prozesse für
  Dateien über 8 MiB bis 3 GB). Bei knappem Arbeitsspeicher `IMPORT_PARSE_WORKERS` bzw.
  `PREVIEW_PARSE_WORKERS` senken. Die Prüfung der MSG-Struktur ist eine Schutzprüfung, kein
  vollständiger Validator: eine Datei, die sie besteht und den Leser dennoch überfordert,
  kostet den Kindprozess, nicht den Worker.
- **Vorschau**: eine Nachricht, deren Vorschau die Grenzen überschreitet, ist in der
  Oberfläche "unlesbar" oder "vereinfacht"; Herunterladen und Wiederherstellen gehen
  weiterhin.
- **Löschen**: ein importiertes Postfach lässt sich in 0.1.0 nicht löschen (die Chunk-Referenzen
  der Snapshots müssten von einer Worker-Aufgabe freigegeben werden); ebenso die
  Import-Quelle, solange sie Snapshots, Archivobjekte oder Legal Holds hält (409). Ältere
  Snapshots räumt die Backup-Retention; der neueste bleibt.
- **Speicherwechsel**: Staging-Dateien und Export-Dateien sind temporär und werden beim
  Wechsel des primären Speicherziels nicht kopiert; ein Upload muss dann wiederholt werden.
- **Mandanten**: `IMPORT_DIR` ist für die ganze Installation ein Verzeichnis, innerhalb
  dessen jeder Mandant seinen Unterordner hat (siehe oben).

## Konfiguration

| Variable | Bedeutung | Standard |
|---|---|---|
| `RESTOW_IMPORT_DIR` | Host-Verzeichnis, das in api und worker unter `/var/lib/restow/import` (schreibgeschützt) eingehängt wird | `./import` |
| `IMPORT_DIR` | Pfad im Container; je Mandant gilt der Unterordner `<IMPORT_DIR>/<Mandanten-Slug>/` | `/var/lib/restow/import` |
| `IMPORT_MAX_FILE_BYTES` | größte Upload-Datei | 10 GiB |
| `IMPORT_UPLOAD_TTL_HOURS` | Lebensdauer eines unfertigen oder ungenutzten Uploads | 48 |
| `IMPORT_SEGMENT_BYTES` | Stückgröße des Uploads | 8 MiB |
| `IMPORT_MAX_MESSAGE_BYTES` | größte einzelne Nachricht | 256 MiB |
| `IMPORT_MAX_STAGING_BYTES` | Summe der angekündigten Größen aller Uploads eines Mandanten, deren Stücke noch liegen | 100 GiB |
| `IMPORT_PARSE_WORKERS` | gleichzeitige Parser-Prozesse im Worker (MSG, Metadaten), 1 bis 8 | 2 |
| `EXPORT_TTL_HOURS` | Gültigkeit eines fertigen Exports | 24 |
| `EXPORT_MAX_TENANT_BYTES` | Summe aller nicht abgelaufenen Exportdateien eines Mandanten (API weist ab, Worker prüft beim Schreiben) | 50 GiB |
| `PREVIEW_PARSE_WORKERS` | gleichzeitige Parser-Prozesse der API für Vorschau und Anhang-Download, 1 bis 8 | 2 |
| `PREVIEW_TIMEOUT_MS` | Zeitgrenze für die volle Vorschau einer Nachricht (der Textversuch bekommt die Hälfte) | 10000 |

## Tests

Fixtures liegen unter `packages/core/src/mailfiles/testdata/` (Herkunft und Lizenz in der
dortigen README). Nachweise (Stufen aus docs/TESTING.md):

- Parser und Erkennung (Unit): EML/MSG/MBOX/ZIP/Ordner, ZIP-Grenzen, MBOX-Streaming,
  Wiederaufnahme-Äquivalenz, unlesbare Elemente.
- Import-Engine: Manifest im IMAP-Format, Duplikate, additive Läufe, Wiederaufnahme nach
  Absturz ohne Doppellesen, Abbruch, **IMAP-Restore und Exchange-Restore eines
  importierten Postfachs byte-genau**.
- **Isolation und feindliche Dateien**: Prozess-Pool (Zeitgrenze, Heap-Grenze, Absturz,
  Abbruch, Warteschlange, Wiederverwendung, Programmende ohne `shutdown`); eine 30-MB-Eingabe,
  die in einem Thread den ganzen Prozess beendet hätte, beendet nur den Kindprozess
  (`isolate.test.ts`); erzeugte CFB-Dateien (zyklische FAT-Kette, Selbstreferenz,
  geteilte Sektoren, Längen über der Dateigröße, DIFAT-Schleife, Verzeichniszyklus,
  Mini-Stream-Verweise) werden vom Prüfer abgelehnt und zerstören weder den Worker noch
  blockieren sie ihn (`cfb-guard.test.ts`, `msg-hostile.test.ts`, einschließlich eines
  Imports einer ZIP mit schleifenden MSG-Dateien); quadratische Kopfzeilen, MBOX-Teile
  und HTML; Absturzschutz des Imports; Vorschau mit feindlichen Nachrichten, die die API
  früher Sekunden blockierten (`preview-isolated.test.ts`, `preview.pg.test.ts`).
- Worker-Handler (Unit und Postgres): Bericht, Staging-Bereinigung, Archivaufnahme,
  Exportdateien versiegelt, Export-Budget (Grenze, atomares Eintragen, Aufräumen
  fehlgeschlagener Exporte und verwaister Bereiche).
- **Round-Trip Import, Export, Import** für EML und MBOX mit Byte- und Hash-Vergleich.
- API (Postgres): Upload (Wiederaufnahme, Prüfsummen, Abbruch, Staging-Budget), RLS,
  Import-Anlage, Export (Rechte, Begründung, Download versiegelt, Ablauf, Speicherbudget),
  Restore-Anpassungen.
- Web (Komponenten): Upload-Ablauf (auch volles Staging), Assistent, Bericht mit
  unlesbarem Element, Export-Dialog mit PST "geplant" und Budget-Meldung, Lesebereich mit
  "vereinfacht" und "unlesbar".

## Roadmap

PST/OST-Import (`pst-extractor`, MIT, ist bewertet, aber für 0.1.0 zurückgestellt), PST-Export,
MSG-Export (sobald die Lizenz eines Schreibers geklärt ist, siehe oben),
Kalender und Kontakte aus MSG/PST, lesbares MailStore-Archivformat (falls das Format offen
dokumentiert wird), Passwortgeschützte ZIP-Dateien.
