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

## IMAP-Archivierung (Zielbild, nicht in 0.1.0)

Fortlaufender Sync, Erfassung bei Ankunft im Postfach (IDLE oder Intervall). Für Vollständigkeit
empfiehlt Restow eine serverseitige Kopie (Sieve/BCC-Regel oder Journaling beim Anbieter) an
die Journal-Adresse; die UI zeigt je Konto, welcher Weg aktiv ist. In 0.1.0 gibt es diesen
Sync nicht: IMAP-Postfächer werden gesichert (Backup), aber nicht fortlaufend archiviert.
Mail aus einem IMAP-Postfach kommt nur über den Datei-Import (Export des Postfachs) mit
"gleichzeitig archivieren" ins Archiv (docs/IMPORT.md).

## SMTP-Journal-Empfänger

- `smtp-server` auf Port 25 (Compose exponiert), STARTTLS mit gültigem Zertifikat
  (Let's Encrypt oder eigenes; Einzelheiten und Erneuerung in docs/ARCHIVE.md, "TLS-Zertifikat"),
  Hostname mit MX-Eintrag `archive.<domain>`. Ohne Zertifikat startet der Empfänger nicht,
  mit Zertifikat nimmt er nichts vor STARTTLS an (530), das Testzertifikat der Bibliothek
  wird nie benutzt. Nur Edition Business und Service Provider.
- Annahme nur für bekannte Journal-Adressen (Token je Mandant), maximale Größe
  150 MB (`JOURNAL_MAX_SIZE_MB`), einfaches Rate-Limit je Absender-IP.
  Absenderprüfung (Zielbild, nicht in 0.1.0): Exchange Online liefert aus
  `*.protection.outlook.com`; den SPF des Absenders zu prüfen ist noch nicht umgesetzt (Journal-Reports
  kommen von der Tenant-Domain bzw. `MicrosoftExchange329e71ec88ae4615bbc36ab6ce41109e@<tenant>.onmicrosoft.com`).
- Verarbeitung: Report parsen (Envelope-Text: Sender, Message-Id, Recipients mit
  To/Cc/Bcc-Kennzeichnung), Original aus Anhang extrahieren, beides speichern. Eine
  Zuordnung zu Postfächern über die Envelope-Empfänger gibt es in 0.1.0 nicht: Die
  Empfänger stehen im Umschlag des Archivobjekts, das Objekt selbst gehört keinem Postfach.
  Geparst wird in einem Parser-Prozess der API mit Zeit- und Speichergrenze
  (docs/ARCHIVE.md, "Lesen der Reports"); ein Report, der sie überschreitet, wird roh
  archiviert und markiert. Sind alle Parser-Prozesse belegt und die Warteschlange voll,
  antwortet der Empfänger 451.
- Bei Fehlern (kein Anhang, nicht parsbar): rohe Report-Mail trotzdem archivieren
  und als "unvollständig" markieren; nie verwerfen. Antwort an Exchange immer 250
  nach erfolgreicher Persistierung, sonst 4xx (Exchange versucht erneut).
- Kein Relay, kein Versand über diesen Port.
