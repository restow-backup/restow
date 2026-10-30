# IMAP und SMTP

## IMAP-Backup

- Verbindung über imapflow, TLS Pflicht (STARTTLS oder implizit), Auth per Passwort
  (gemeinsam, je Postfach oder Master-User, siehe unten). XOAUTH2 (Microsoft 365, Google mit
  eigener OAuth-App) ist Zielbild und in 0.1.0 weder in der API noch in der Oberfläche
  angeboten; die Engine in `packages/core` kennt den Pfad, es legt ihn aber niemand an.
- Ordnerliste über LIST/LSUB, Sonderordner über SPECIAL-USE, Hierarchietrennzeichen
  beachten.
- Inkrementell über UIDVALIDITY und UIDNEXT je Ordner; ändert sich UIDVALIDITY, wird
  der Ordner voll neu gelesen (Dedupe über Message-ID plus Hash verhindert Doppelung
  im Speicher).
- Inhalt: RFC 5322 byte-genau (`BODY.PEEK[]`), Flags separat, interne Datumsangabe.
- Gelöschte Mails: beim nächsten Lauf per UID-Vergleich erkannt; Snapshot behält sie.
- Parallelität: max. 2 Verbindungen je Konto (viele Server limitieren).
- Restore: APPEND in Zielordner mit Original-Datum und Flags; Zielordner anlegen, falls
  fehlend; Duplikate über Message-ID prüfen. Geprüft wird gegen den Stand des Ordners,
  bevor dieser Lauf dort etwas geschrieben hat (ein Ordner kann zwei verschiedene Mails
  mit derselben Message-ID enthalten, etwa Direktzustellung und Verteiler-Kopie): eigene
  Kopien des Laufs gelten nie als Duplikat. Ein IMAP-Restore ersetzt nie ein vorhandenes
  Original: nichts im Zielkonto wird je gelöscht,
  überschrieben oder verschoben; ein Treffer wird je nach Modus daneben abgelegt
  ("rename") oder übersprungen ("skip"). Der Modus "replace" wird für IMAP-Ziele von der
  API abgelehnt (422 `urn:restow:problem:restore-replace-not-allowed`); der
  `restore_mode`-Datenbank-Enum behält den Wert für die Historie, ein davor eingereihter
  Restore-Job mit "replace" läuft deshalb wie "rename"
  (packages/core/src/restore/common.ts, `mailboxRestoreMode`) und vermerkt das im
  Ergebnis. Ein wiederholter "rename"-Job erkennt eigene frühere Kopien nur am gleichen
  Inhalt (SHA-256), jede Kopie steht für genau eine Mail
  (packages/core/src/restore/duplicates.ts).
- Grenzen: Kalender/Kontakte gibt es per IMAP nicht (CalDAV/CardDAV später).
- Importierte Postfächer (Mail-Dateien statt Server, docs/IMPORT.md) nutzen dasselbe
  Manifestformat wie ein IMAP-Backup; sie werden nie gesichert, aber wie ein IMAP-Konto
  durchsucht, angesehen und wiederhergestellt.
- Erreichbare Server (SSRF-Schutz, packages/core/src/net/address-policy.ts): Restow
  verbindet sich von den eigenen Servern aus, für den Verbindungstest in der API wie für
  jedes Backup und jeden Restore im Worker. Ein Mandanten-Admin darf deshalb nur
  öffentliche Server eintragen; Loopback, private Netze (RFC 1918, CGNAT, ULA) und
  lokale Namen (Container-Namen, `.local`, `.internal`, ...) werden abgelehnt, sowohl
  beim Speichern (422 `imap-host-not-allowed`) als auch beim Verbinden. Ein interner
  Server ist eine Entscheidung des Betreibers: entweder für die ganze Installation
  (`IMAP_ALLOW_PRIVATE_NETWORKS=true`) oder je Quelle, indem ein Provider-Admin den Host
  speichert; die Freigabe steht dann an der Quelle (`privateNetworkApproval`) und
  entfällt, sobald jemand anderes Host oder Port ändert. Link-Local (Cloud-Metadaten),
  Multicast und reservierte Bereiche sind nie erlaubt. Geprüft wird im DNS-Lookup des
  Sockets, also genau die Adresse, zu der verbunden wird (kein DNS-Rebinding); ein
  abgelehnter Test meldet nur `blocked_address`, nie Banner oder Antworten dahinter.

## Zugangsdaten je Postfach (`SourceConfig.imapAuthMode`)

Eine IMAP-Quelle trägt genau ein Anmeldeverfahren, gültig für alle ihre Postfächer
(`sources.config.imapAuthMode`, `"shared"` als Vorgabe, wenn das Feld fehlt: bestehende
Quellen vor diesem Feld laufen unverändert als `shared` weiter). Worker und API lösen
den Login aus denselben Spalten identisch auf (`apps/worker/src/handlers/backup.ts`
`imapAccountFor`, `apps/api/src/features/directory/service.ts`
`resolveImapProbeInput`), damit "Backup", "Restore" und "Anmeldung testen" nie
auseinanderlaufen.

- **`shared`** (Standard, unverändert seit vor diesem Feature): ein Login und ein
  Passwort auf der Quelle (`sources.secret_ref`), der Login für jedes Postfach ist
  dessen `external_id`. Passt zu einem App-Passwort oder einem vom Anbieter fürs
  Backup vorgesehenen Konto mit Zugriff auf alle Postfächer.
- **`per_mailbox`**: jedes Postfach trägt sein eigenes versiegeltes Passwort
  (`protected_objects.secret_ref`, genauso versiegelt wie `sources.secret_ref`,
  gleicher Schlüssel). Für Hoster ohne Master-User und mit einem Passwort je
  Postfach (Hetzner, IONOS, all-inkl): jeder Kunde hat dort schlicht ein eigenes
  Postfachpasswort, keinen gemeinsamen Zugang. Fehlt das Passwort, schlägt der
  Backup-Job dieses einen Postfachs mit einer klaren, nie geheimen Fehlermeldung
  fehl ("has no password set"); die Objektliste zeigt es als "Nicht geschützt", bis ein
  Passwort gesetzt und erfolgreich getestet wurde.
- **`master_user`**: ein gemeinsamer Master-Account übernimmt jedes Postfach
  (`sources.secret_ref` trägt das Master-Passwort, `SourceConfig.masterUser` den
  Login und die Anmelde-Art):
  - `dovecot_separator` (Vorgabe, Trennzeichen `*`): Login wird
    `<master><trennzeichen><postfach>`, z. B. `master*anna@example.test`
    (Dovecot-Konvention, master user separator).
  - `sasl_authzid`: Login bleibt der Master-Account, das Postfach wird als SASL-PLAIN-
    AUTHZID übertragen (RFC 4616); imapflow reicht das als `auth.authzid` durch
    (`packages/core/src/backup/imap/imapflow-connector.ts`). Nur zusammen mit einem
    Passwort, nie mit OAuth2 (XOAUTH2 kennt kein AUTHZID). Die Anmeldemethode wird
    dabei fest auf `AUTH=PLAIN` gesetzt, aber das allein reicht nicht: imapflow
    versucht SASL überhaupt nur, wenn der Server `AUTH=LOGIN` oder `AUTH=PLAIN`
    meldet; meldet er keins von beiden, greift imapflow unabhängig von der
    erzwungenen Methode auf das klassische `LOGIN`-Kommando zurück, das AUTHZID gar
    nicht kennt, und meldet sich unbemerkt als Master-Account selbst an. Der
    Connector prüft deshalb nach dem Verbindungsaufbau `client.capabilities`: fehlt
    `AUTH=PLAIN` dort, wird die Verbindung sofort geschlossen und die Anmeldung
    schlägt laut fehl, statt unbemerkt das falsche Postfach zu sichern.

Eine `per_mailbox`-Quelle hat kein eigenes Login, das "Verbindung testen" auf
Quellenebene prüfen könnte: sie ist deshalb sofort nach dem Anlegen oder Umstellen
`active` (nicht `pending`), und Mandantenseite › Verbindungen (Reiter IMAP) zeigt dort statt eines
Testen-Buttons den Hinweis, jedes Postfach einzeln im Reiter Verzeichnis zu testen.
Bei `master_user` prüft "Verbindung testen" auf Quellenebene, sofern die Quelle
bereits ein Postfach kennt, mit dessen echter Login-Form (Trennzeichen oder AUTHZID).
Ohne ein bekanntes Postfach testet er nur den blanken Master-Login, was Dovecot je
nach Konfiguration ablehnen kann, auch wenn die eigentliche Maskerade funktioniert;
maßgeblich bleibt deshalb in jedem Fall "Anmeldung testen" am einzelnen Postfach.

Eine bestehende `shared`-Quelle auf `per_mailbox` umstellen: im Quellenformular den
Anmeldemodus wechseln (die Quelle braucht danach kein eigenes Passwort mehr; der
Benutzername auf Quellenebene bleibt dabei unverändert editierbar, wird für den
Login aber nicht mehr benutzt). Der Wechsel gilt sofort, die Quelle bleibt (bzw.
wird) `active`. Für jedes Postfach dann im Reiter Verzeichnis "Passwort setzen" und
"Anmeldung testen" verwenden, bevor der nächste Backup-Lauf ansteht. Ein Postfach ohne eigenes
Passwort schlägt sonst fehl statt mit dem alten gemeinsamen Passwort weiterzulaufen:
der Moduswechsel gilt sofort für alle Postfächer der Quelle, es gibt keinen
Übergangszustand, in dem alte und neue Zugangsdaten beide gelten. Bis ein Postfach
sein eigenes Passwort hat, zeigt die Objektliste es als "Nicht geschützt"; Postfächer
auf `shared`- oder `master_user`-Quellen zeigen dagegen nie "Nicht geschützt" (sie
haben ohnehin kein eigenes Passwort), sondern höchstens das Ergebnis des letzten
Anmeldungstests.

Ein gespeichertes Passwort reist nie zu einem anderen Server als dem, für den es
versiegelt wurde. Das gilt für das Quellen-Passwort bei `shared`/`master_user`
genauso wie für jedes einzelne Postfach-Passwort bei `per_mailbox`: Ändert sich bei
einer `per_mailbox`-Quelle Host oder Port, verwirft Restow sofort das versiegelte
Passwort jedes Postfachs dieser Quelle (`protected_objects.secret_ref` wird `null`,
`credential_status` ebenso) statt es beim nächsten Backup, Restore oder "Anmeldung
testen" stillschweigend an den neuen Server zu schicken. Jedes Postfach zeigt danach
wieder "Nicht geschützt" und braucht ein neu gesetztes Passwort. Eine reine
Formatänderung (Groß-/Kleinschreibung, führende oder folgende Leerzeichen) am
gleichen Host löst das nicht aus.

### Einrichtung: Hoster mit einem Passwort je Postfach

Ablauf für einen typischen Hoster ohne Master-User (Hetzner, IONOS, all-inkl):

1. Quelle anlegen: Mandantenseite › Verbindungen › Reiter IMAP → Neue IMAP-Quelle, Server/Port/Sicherheit des
   Hosters eintragen, Anmeldemodus `per_mailbox` wählen. Kein Passwort auf
   Quellenebene nötig; die Quelle ist danach sofort `active`.
2. Postfächer eintragen: Reiter Verzeichnis → Konten hinzufügen, entweder einzeln
   oder per CSV-Import. Die CSV kennt eine optionale Spalte `password` (auch
   `pass`/`pwd`) sowie `login`/`username`/`user`/`account` und optional
   `email`/`name`; Kopfzeile in beliebiger Reihenfolge und Groß-/Kleinschreibung.
   Ein Passwort in dieser Spalte wird beim Import sofort versiegelt, nie
   zwischengespeichert oder geloggt, und im Ergebnis nur als "hat ein Passwort"
   zurückgemeldet, nie im Klartext. Eine Zeile ohne Passwort legt das Postfach
   trotzdem an; das Passwort lässt sich danach einzeln nachtragen.
3. Passwort nachtragen oder ändern: Reiter Verzeichnis → Zeilenaktion "Passwort
   setzen" am jeweiligen Postfach.
4. Testen: Zeilenaktion "Anmeldung testen" je Postfach, bevor der nächste
   Backup-Lauf ansteht. Ein Postfach ohne Passwort oder mit fehlgeschlagenem Test
   zeigt "Nicht geschützt" bzw. den Grund des letzten Tests, nie grün.

## Anmeldung abgelehnt: Konto abgeschaltet?

Ab 0.4.8. Wird die Anmeldung eines IMAP-Kontos wiederholt abgelehnt, ist das meist eine
Konfiguration, die der Administrator ändern kann (Passwort, App-Passwort). Es kann aber auch heißen,
dass der Hoster das Konto abgeschaltet hat. Restow entscheidet das nie allein: Das Konto bleibt
`active` und rot, bis ein Administrator antwortet.

**Was gezählt wird.** Nur eine abgelehnte Passwort-Anmeldung (`imap.auth_failed`) eines aktiven
Kontos, aus einem Sicherungslauf, einem Pass der Archiv-Erfassung oder der wöchentlichen Probe.
Ein Fehlschlag zählt nur, wenn der zuletzt gezählte mindestens 6 Stunden zurückliegt (bei einem Pass
der Archiv-Erfassung mindestens 20 Stunden, weil diese Pässe alle paar Stunden laufen): Wiederholungen
desselben Laufs und „Jetzt sichern“ ergeben einen Lauf, Archiv-Pässe höchstens einen je Tag. Nicht gezählt werden
vorübergehende Absagen des Servers (`imap.server_limit`: zu viele Verbindungen, Authentifizierung
gerade nicht erreichbar), Netz- und TLS-Fehler, ein fehlendes Passwort (`imap.credential_missing`),
`imap.oauth_failed` und alle OAuth2-Quellen (Microsoft, Google): dort heißt ein Fehler
„neu autorisieren“. Eine gelungene Anmeldung setzt die Zählung zurück.

**Die Frage.** Nach 3 gezählten Fehlschlägen über mindestens 24 Stunden (bei nächtlicher Sicherung
in der dritten Nacht) steht am Konto die Frage „Anmeldung seit <Datum> abgelehnt. Wurde dieses Konto
abgeschaltet?“, einmal je Serie von Fehlschlägen. Sie erscheint
- am Konto (Schutz › Objekte, unter dem Status, mit den Knöpfen „Ja, abgeschaltet“ und „Nein,
  Anmeldung korrigieren“), in einem Hinweis oben auf der Seite und im Filter „Anmeldung abgelehnt:
  Antwort offen“ (`?status=login_question`);
- als Meldung in der Glocke und in den anderen Kanälen, über die Ereignisse `object.inactive` und
  `object.inactive_many` mit `details.question = "login"` (keine neuen Ereignisse; die
  Benachrichtigungsmatrix bleibt, wie sie ist). Fallen bei einem Mandanten an einem Tag viele Konten
  zugleich auf (mehr als 10 oder mehr als 20 %), kommt eine Sammelwarnung statt vieler Hinweise;
- für Anbieter als Hinweis „Antwort nötig“ (`login_question`) beim Mandanten in der Anbieteransicht
  des Dashboards, solange Fragen offen sind.

Betrifft die Ablehnung fast alle Konten einer Quelle (mindestens zwei und die Hälfte der aktiven),
steht bei der Frage „Prüfen Sie zuerst das Passwort der Quelle“: Das gemeinsame Passwort oder das
Master-Konto hat sich dann wahrscheinlich geändert.

**Ja, abgeschaltet.** Nur diese Antwort ändert den Zustand: Das Konto wird `orphaned` mit dem Grund
`login_refused`, sofort bestätigt (von dem, der geantwortet hat), grau „Absichtlich nicht mehr
gesichert“, nie überfällig, ohne `backup.failed` und ohne `job.failed`. Vorhandene Sicherungen
bleiben erhalten und bewertet; sie werden nicht gelöscht. Eine Prüfung der Datenbank
(`protected_objects_login_refused_ck`, Migration 0070) macht den Grund ohne diese Bestätigung
unmöglich: Weder Worker noch Scheduler noch ein Abgleich können ihn setzen. Die Antwort wird
auditiert (`directory.inactive.confirmed`, `details.via = "login_question"`).

**Nein, Anmeldung korrigieren.** Das Konto bleibt geschützt und rot; Restow fragt nicht wieder, bis
eine Anmeldung gelingt, ein Passwort gesetzt oder die Anmeldung der Quelle geändert wird oder
90 Tage vergehen und die Anmeldung noch immer abgelehnt wird. Bei einem Konto mit eigenem Passwort
(`per_mailbox`) öffnet sich „Passwort setzen“, sonst steht ein Hinweis auf die Quelle. Wer es sich
anders überlegt, wählt im Menü „Doch abgeschaltet“. Auditiert als `directory.login.dismissed`.

**Wöchentliche Anmeldeprobe.** Für ein abgeschaltetes Konto stellt der Scheduler (`login-probes.ts`,
unabhängig von den Zeitplänen der Jobs, auch für Konten nur in einem Archiv-Job oder in keinem Job)
einmal je 7 Tage einen normalen Sicherungslauf ein. Der Lauf meldet sich zuerst an:
- Gelingt es, ist das Konto wieder `active` (mit neuem Beginn der Überfälligkeitsuhr; Grund, Datum
  und Bestätigung entfallen) und die Sicherung läuft im selben Lauf weiter. Auditiert als
  `directory.login.restored`.
- Wird es wieder abgelehnt, endet der Lauf neutral („Nicht gesichert: Konto abgeschaltet“) und die
  nächste Probe ist in 7 Tagen. Bei einem unklaren Fehler (Netz, Serverlimit) wird nichts geändert
  und morgen erneut geprüft.
Pro abgeschaltetem Konto ist das eine Anmeldung je Woche; Hoster, die fehlgeschlagene Anmeldungen
sperren, merken sich diese eine.

**Sofort fortsetzen.** Ein neues Passwort (einzeln, per CSV-Import oder an der Quelle),
„Anmeldung testen“ mit Erfolg, „Jetzt sichern“ und „Doch wieder sichern“ (Einschließen) setzen die
Sicherung eines abgeschalteten Kontos sofort fort, ohne auf die Wochenprobe zu warten. Ein
Administrator kann ein abgeschaltetes Konto auch ausschließen, um die Probe zu beenden.

**Was sich nicht ändert.** Die Zählung gilt nur für IMAP-Konten. Bei Microsoft 365 erkennt Restow
selbst, dass ein Konto deaktiviert oder ohne Lizenz ist, und lässt es danach bestätigen
(docs/MICROSOFT.md „Nicht mehr gesichert: Bestätigung“); bei IMAP bestätigt die Antwort den
Zustand, den sie auslöst.

## Archivierung

Ab 0.4.4 archiviert Restow IMAP-Konten fortlaufend (Edition Business und Service Provider,
Fähigkeit `archive.mailboxCapture`; docs/ARCHIVE.md, "Erfassungswege"). Ein Mail-Job mit
Archiv wählt je Art des Postfachs die Wege: für IMAP und Google Workspace die
IMAP-Synchronisation (`archiveCapture.imap.sync` bzw. `.google.sync`, Standard) und/oder die
weitergeleitete Kopie (`.forward`, siehe "Weiterleitung"). Beide dürfen zusammen laufen; was
beide erfassen, liegt einmal im Archiv.

**Was erfasst wird.** Jeder auswählbare Ordner, auch Gesendet, Papierkorb und Spam; Entwürfe
nicht (Ordner mit `\Drafts` oder dem Namen Drafts/Entwürfe, und jede Mail mit dem Flag
`\Draft`). Bei Gmail und Google Workspace erscheint jede Mail einmal je Label: gelesen werden
dort nur `[Gmail]/All Mail` (Alle Nachrichten), Spam und Papierkorb, die jede Mail genau einmal
halten. Erkannt wird ein Google-Konto an der OAuth2-Quelle von Google, am Host
`imap.gmail.com`/`imap.googlemail.com` oder an der Ordnerliste (`\All` unter `[Gmail]`).

**Wie.** Bei der Aktivierung merkt sich der Worker je Ordner UIDVALIDITY und UIDNEXT. Mail bis
dahin übernimmt einmalig der Backfill-Job ("Archiv-Übernahme", fortsetzbar, markiert als
nachträglich erfasst), danach erfasst jeder Durchlauf nur Neues: STATUS je Ordner, und nur ein
Ordner, dessen UIDNEXT weitergerückt ist, wird geöffnet; von neuen UIDs erst die Metadaten,
dann nur die Quellen der Mails, die das Archiv für dieses Konto noch nicht hält (nach
`<Ordner>;<UIDVALIDITY>;<UID>` oder Message-ID). Eine verschobene Mail oder eine schon
weitergeleitete Kopie wird so nicht erneut geladen. Ändert sich UIDVALIDITY, wird der Ordner
von vorn gelesen, ohne Doppel im Archiv. Ein Neuabgleich aus der Oberfläche liest alle
Ordner von vorn.

**IDLE und Polling.** Jeder Worker-Prozess beobachtet bis zu `ARCHIVE_IMAP_IDLE_MAX` Konten
(Standard 300, `0` schaltet IDLE ab) mit je einer Verbindung per IMAP IDLE auf INBOX (bei
Gmail auf All Mail), vor 29 Minuten erneuert. Neue Mail löst sofort einen Durchlauf aus; alle
`ARCHIVE_IMAP_POLL_MINUTES` (Standard 5) fragt dieselbe Verbindung per STATUS die übrigen
Ordner ab; alle 30 Minuten läuft zur Sicherheit ein voller Durchlauf. Mehrere Worker teilen
sich die Konten über Postgres-Sperren (eine Verbindung je Worker hält sie), ein abgestürzter
Worker gibt seine Konten mit seiner Datenbankverbindung frei. Konten ohne IDLE-Platz werden alle
`ARCHIVE_IMAP_LOGIN_POLL_MINUTES` (Standard 10) per Anmeldung abgefragt. Die Statusseite nennt
je Konto den Modus und bei Polling den Grund: `imap.idle_unsupported` (Server ohne IDLE),
`imap.idle_disabled` (Quelle mit Archiv-IDLE aus) oder `imap.idle_budget` (kein freier Platz).

**Verbindungsbudget.** Viele Anbieter begrenzen gleichzeitige Verbindungen je Konto (Gmail 15,
Exchange Online 20, viele Hoster 2 bis 5). Die Archivierung hält je Konto eine Verbindung
dauerhaft (IDLE) und während eines Durchlaufs oder der Übernahme kurz eine zweite; das Backup
nutzt zusätzlich bis zu zwei. Reicht das Limit nicht, auf der Seite der Quelle unter
"Archivierung" "Nur in Abständen prüfen" wählen (API: `PATCH /api/v1/sources/:id`,
`{"archiveIdle": "off"}`): dann nur Polling, keine Dauerverbindung. Die Worker übernehmen die
Einstellung innerhalb einer Minute. Die Mailclients der Nutzer brauchen ihre eigenen Verbindungen.

**IMAP auf Microsoft-Hosts** (`outlook.office365.com` u. a.) wird archiviert wie jedes Konto;
für Microsoft 365 ist eine Microsoft-365-Quelle mit Graph oder Journaling der bessere Weg.

## Weiterleitung

Ein Anbieter kann jede Mail eines Kontos schon beim Transport als Kopie an das Archiv schicken.
Das erfasst Mail, bevor ein Nutzer sie löschen kann (stärker als die Synchronisation aus dem
Postfach) und braucht keine IMAP-Verbindung. Der Empfänger ist derselbe wie für Exchange
Online (Abschnitt "SMTP-Journal-Empfänger", Edition Business und Service Provider); er erkennt
Journal-Reports am Header `X-MS-Journal-Report` oder an ihrem Aufbau und nimmt alles andere als
einfache Kopie (Quelle `smtp_forward`).

**Adressen.**

- **Konto-Adresse** `archive+<token>@<JOURNAL_HOSTNAME>`: je IMAP-Konto, auf Anforderung
  ausgestellt (`POST /api/v1/archive/forwarding/:objectId/address`, einmalig, Audit
  `archive.forward.address_created`), erneuerbar (`.../rotate`, die alte Adresse wird sofort
  abgewiesen, Audit `archive.forward.address_rotated`; im Audit-Log steht nur ein
  Fingerabdruck). Eine Kopie an diese Adresse gehört genau diesem Konto. Für Regeln je Konto.
- **Mandanten-Adresse** `journal+<token>@<JOURNAL_HOSTNAME>`: die Journal-Adresse des
  Mandanten. Für domänenweite Regeln; eine einfache Kopie wird den Postfächern zugeordnet,
  deren Adresse in ihren Kopfzeilen steht (From, To, Cc, Delivered-To, X-Original-To u. a.)
  oder im `MAIL FROM`.

`GET /api/v1/archive/forwarding` listet die Konten mit Adresse, ob ein Job die Weiterleitung
gewählt hat, und den Kopien der letzten 7 Tage (je Konto und für die Mandanten-Adresse).

**Einrichtung.**

- **Postfix** (eigener Server): je Konto eine Zeile in `sender_bcc_maps` (gesendete Mail) und
  `recipient_bcc_maps` (empfangene Mail), z. B. `anna@example.com archive+<token>@archive.example.com`,
  dann `postmap` und `postfix reload`. Für alle Konten einer Domäne auf einmal `always_bcc`
  an die Mandanten-Adresse (Zuordnung dann über die Kopfzeilen).
- **mailcow**: Konfiguration → E-Mail → BCC → BCC-Map je Postfach, Typ "Sender" und
  "Empfänger", Ziel die Konto-Adresse.
- **Sieve** (Dovecot Pigeonhole, viele Hoster): im Filter des Kontos
  `require ["copy"]; redirect :copy "archive+<token>@archive.example.com";`. Erfasst nur
  eingehende Mail; gesendete Mail kommt über die IMAP-Synchronisation dazu.
- **Google Workspace**: Admin-Konsole → Apps → Google Workspace → Gmail → Routing →
  "Weitere Empfänger hinzufügen" (Add more recipients) für eingehende und ausgehende Mail, Ziel
  die Mandanten-Adresse. Die Weiterleitung je Nutzer in Gmail wird nicht unterstützt (sie
  verlangt eine Bestätigung im Postfach und lässt sich vom Nutzer abschalten).

**Grenzen.**

- **BCC ist in einer Kopie nicht sichtbar.** Eine weitergeleitete Kopie hat keinen Umschlag
  wie ein Journal-Report: `RCPT TO` ist die Archiv-Adresse, nicht die Empfänger der Mail.
  Wer Bcc erhielt, steht nur in der Kopie, wenn der Anbieter es in eine Kopfzeile schreibt
  (Delivered-To, X-Original-To). Die Konto-Adresse ordnet deshalb sicher zu; die
  Mandanten-Adresse nur nach dem, was in den Kopfzeilen steht.
- `MAIL FROM` ist oft eine SRS-Adresse des Weiterleiters; Restow speichert es im Umschlag
  (`envelopeFrom`), ordnet danach aber nur zu, wenn es eine Adresse des Mandanten ist.
- Der Empfänger prüft kein SPF des Absenders; die Adresse (zufälliges Token) ist das
  Geheimnis. Eine Transaktion liefert in genau ein Archiv: ein Empfänger eines zweiten
  Mandanten erhält 452 und wird vom Absender getrennt zugestellt.
- Gleiche Mail auf mehreren Wegen: Die Kopie zur Transportzeit ist stärker als die
  Synchronisation. Kommt sie zuerst, nimmt die Synchronisation dieselbe Mail nicht noch
  einmal auf; kommt sie danach, wird sie das Element, das das synchronisierte ersetzt
  (`supersedesItemId`, die Suche zeigt das neuere). Dieselbe Kopie an mehrere Konten oder an
  Konto- und Mandanten-Adresse ergibt ein Element und je weiterem Empfänger eine
  Erfassungszeile.

## SMTP-Journal-Empfänger

- `smtp-server` auf Port 25 (Compose exponiert), STARTTLS mit gültigem Zertifikat
  (Let's Encrypt oder eigenes; Einzelheiten und Erneuerung in docs/ARCHIVE.md, "TLS-Zertifikat"),
  Hostname mit MX-Eintrag `archive.<domain>`. Ohne Zertifikat startet der Empfänger nicht,
  mit Zertifikat nimmt er nichts vor STARTTLS an (530), das Testzertifikat der Bibliothek
  wird nie benutzt. Nur Edition Business und Service Provider.
- Annahme nur für bekannte Adressen (Journal-Adresse je Mandant, ab 0.4.4 auch Archiv-Adressen
  je IMAP-Konto, siehe "Weiterleitung"), maximale Größe 150 MB (`JOURNAL_MAX_SIZE_MB`).
  Grenzen je api-Prozess: Verbindungen je Absender-IP und Minute (`JOURNAL_RATE_PER_IP`,
  Standard 600, darüber 421) und Zustellungen je Adresse und Minute
  (`JOURNAL_RATE_PER_ADDRESS`, Standard 300, darüber 451 bei RCPT TO); hoch genug für einen
  Hoster, der die Mail vieler Konten weiterleitet.
  Absenderprüfung (Zielbild, nicht in 0.1.0): Exchange Online liefert aus
  `*.protection.outlook.com`; den SPF des Absenders zu prüfen ist noch nicht umgesetzt (Journal-Reports
  kommen von der Tenant-Domain bzw. `MicrosoftExchange329e71ec88ae4615bbc36ab6ce41109e@<tenant>.onmicrosoft.com`).
- Verarbeitung: Report parsen (Envelope-Text: Sender, Message-Id, Recipients mit
  To/Cc/Bcc-Kennzeichnung), Original aus Anhang extrahieren, beides speichern. Ab 0.3.0
  ordnet der Empfänger jeden Report den Postfächern zu, deren Adresse der Umschlag nennt
  (docs/ARCHIVE.md, "Zuordnung zu Postfächern"); vorher gehörte ein Report keinem Postfach.
  Geparst wird in einem Parser-Prozess der API mit Zeit- und Speichergrenze
  (docs/ARCHIVE.md, "Lesen der Reports"); ein Report, der sie überschreitet, wird roh
  archiviert und markiert. Sind alle Parser-Prozesse belegt und die Warteschlange voll,
  antwortet der Empfänger 451.
- Bei Fehlern (kein Anhang, nicht parsbar): rohe Report-Mail trotzdem archivieren
  und als "unvollständig" markieren; nie verwerfen. Antwort an Exchange immer 250
  nach erfolgreicher Persistierung, sonst 4xx (Exchange versucht erneut).
- Kein Relay, kein Versand über diesen Port.
