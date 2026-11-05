# Microsoft 365 — Fakten, Grenzen, Fallstricke

Pflichtlektüre vor jeder Zeile Graph-Code. Stand 21.09.2026. Bei Zweifel gegen den
Dev-Tenant testen (Microsoft 365 Developer Program liefert einen kostenlosen Tenant
mit 25 Lizenzen; Antrag unter developer.microsoft.com/microsoft-365/dev-program).

## Schnittstellen

- Microsoft Graph v1.0 ist die einzige unterstützte API. `beta` nur mit Begründung
  im Code und Fallback.
- EWS (Exchange Web Services) wird für Exchange Online am 1. Oktober 2026 abgeschaltet.
  Kein EWS, auch nicht als Fallback.
- Exchange Online PowerShell wird nur für Dinge dokumentiert, die Graph nicht kann
  (Journaling-Regel anlegen, Postfach-Auditing), nicht vom Produkt ausgeführt.

## App-Registrierung

Eine Multi-Tenant-App im Tenant von IT Systeme Flores (oder des jeweiligen Betreibers).
Kunden erteilen Admin-Consent per Link; Restow bekommt dann ein Client-Credentials-Token
je Kunden-Tenant. Application Permissions (keine delegierten) für Backup:

- Mail.ReadWrite (Restore braucht Write; lesen reicht nicht)
- MailboxSettings.Read
- Calendars.ReadWrite
- Contacts.ReadWrite
- Files.ReadWrite.All (OneDrive; Restore)
- Sites.ReadWrite.All (SharePoint Online, optional; Sites.Read.All genügt für die Sicherung,
  die Wiederherstellung in eine Website braucht ReadWrite; siehe „SharePoint Online" unten)
- User.Read.All, Group.Read.All, Directory.Read.All (Verzeichnis-Sync, Schutzregeln;
  User.Read.All erkennt auch ein Online-Archiv, siehe „Exchange: Sichern“; Group.Read.All liest auch die Microsoft-365-Gruppen und ihre Unterhaltungen, siehe
  „Gruppenpostfächer" unten)
- Organization.Read.All (Tenant-Name, Lizenzen)
- Mail.Send (optional, nur wenn Benachrichtigungen über diese App statt über eine eigene
  App-Registrierung für Benachrichtigungen oder SMTP verschickt werden; sendet als
  konfiguriertes Absenderpostfach über `/users/{id}/sendMail`, siehe
  „Benachrichtigungs-Mail" unten)

Endnutzer-SSO (Self-Service-Restore) läuft getrennt als delegierter OIDC-Login
(openid, profile, email) über better-auth; der Nutzer sieht nur, was sein `oid`
im Backup besitzt.

Client-Secret-Rotation: Secrets laufen maximal 24 Monate; Restow erinnert 30 Tage vorher,
erneut 7 Tage vorher und nach dem Ablauf (docs/ENTRA-SETUP.md, Teil 3).
Besser: Zertifikat statt Secret (der eigene Token-Client in
packages/core/src/graph/auth/token.ts unterstützt beides).

## Application Access Policies

Ein App-Consent gewährt Zugriff auf alle Postfächer des Tenants. Kunden, die den
Umfang einschränken wollen, nutzen Exchange `New-ApplicationAccessPolicy` mit einer
Gruppe. Restow muss damit umgehen (403 für ausgeschlossene Postfächer als "nicht im
Schutzumfang" anzeigen, nicht als Fehler). Wird die Richtlinie (oder ein entzogener Consent)
mitten in einem Lauf wirksam, antwortet das Delta jedes weiteren Ordners mit 403. Bestätigt der
Posteingang des Postfachs die Verweigerung, bricht der Lauf mit dem Zugriffsfehler ab und
verwirft den Sicherungsstand, statt die übrigen Ordner ungelesen weiterzutragen; ein 403, das nur
ein Ordner liefert, bleibt ein Ordnerfehler.

## Throttling (der Grund, warum alle Tools langsam sind)

- Limits gelten je App je Tenant und zusätzlich je Postfach. Outlook-Ressourcen:
  Richtwert 10.000 Anfragen pro 10 Minuten je App je Postfach und 4 gleichzeitige
  Anfragen je Postfach. OneDrive/SharePoint: eigene Limits je Tenant, abhängig von
  Lizenzzahl.
- Antwort 429 mit `Retry-After` ist normal, kein Fehler. Immer respektieren, Jitter
  dazu, kein Hammering. 503/504 mit Backoff wiederholen, aber nur, wo eine zweite Anfrage
  nichts doppelt anlegen kann.
- POST ist nicht idempotent: Exchange legt eine Nachricht oft schon an, während das Gateway
  noch mit 504 aufgibt, und eine zweite Anfrage legt eine zweite Kopie an. Der Graph-Client
  (`graph/client.ts`) sendet deshalb einen POST nur nach einer Antwort erneut, die beweist,
  dass nichts geschehen ist: 429 und 503 mit `Retry-After` (Drosselung). Nach 504, nach 503
  ohne `Retry-After` und ohne Antwort innerhalb der Wartezeit (5 Minuten) wirft er
  `GraphOutcomeUnknownError` (Ursache `graph.outcome_unknown`, vorübergehend); wer den POST
  geschickt hat, muss zuerst im Ziel nachsehen (bei Nachrichten über die Message-ID im
  Zielordner), bevor er ihn wiederholt. GET, PUT, PATCH und DELETE werden wie bisher wiederholt.
  Ein POST, der nichts anlegt oder nur Wegwerfbares (Upload-Session anlegen, Reauthorisieren
  eines Abonnements), setzt `idempotent: true`. Im `$batch` gilt dasselbe je Teilanfrage: eine
  anlegende Teilanfrage mit 504 kommt als 504 zurück, eine gedrosselte wird erneut gesendet; ein
  `$batch` mit anlegenden Teilanfragen wird nach 504 oder Zeitüberschreitung nicht erneut
  gesendet.
- Strategie: Parallelität über Postfächer, nicht innerhalb eines Postfachs; Delta-
  Queries; `$select` minimal; Batch-Requests (max. 20 je Batch, teilen sich Limits).
- Erstsicherung großer Tenants dauert Tage. Das ist so und wird in der UI so gesagt
  (Restlaufzeit-Schätzung, Fortschritt je Postfach). Während der ersten Sicherung eines
  Postfachs zeigen Verlauf, Laufdetail und Job-Liste "Erste Sicherung: X von Y Elementen"
  über alle Versuche hinweg: Y ist die Summe der `totalItemCount` der gesicherten
  Mailordner (Kalender und Kontakte kommen beim Lesen dazu), X zählt, was frühere Versuche
  im Teil-Snapshot gespeichert haben, plus den laufenden Versuch. Die Restzeit wird aus der
  Geschwindigkeit des laufenden Versuchs geschätzt, gerundet (bis 10 Min. minutengenau, dann
  5 Min., bis 10 Std. Viertelstunden, darüber Stunden) und als Schätzung bezeichnet. Ein
  OneDrive nennt seine Elementzahl erst nach vollständiger Aufzählung: Dort steht "X
  Elemente bisher" ohne Restzeit und ohne Prozentangabe.

## Exchange: Sichern

- Ordnerbaum: `/users/{id}/mailFolders` rekursiv (`childFolders`), inkl. versteckte
  Ordner (`includeHiddenFolders=true`), Wohlbekannte Namen (inbox, sentitems, ...)
  über `wellKnownName`.
- Nachrichten: `/users/{id}/mailFolders/{fid}/messages/delta` mit `$select=id,
  internetMessageId,subject,receivedDateTime,lastModifiedDateTime,isRead,flag,
  categories,hasAttachments,parentFolderId`. Delta-Token je Ordner speichern.
- Inhalt: `/users/{id}/messages/{mid}/$value` liefert MIME (RFC 5322) inklusive
  Anhänge. Das ist das Format im Backup. Nachteil: Änderungen an Flags/Kategorien
  erzeugen kein neues MIME; Metadaten separat speichern.
- Wann der Inhalt neu geladen wird: Ein Fingerabdruck aus Betreff, `hasAttachments`, `isDraft`
  und `bodyPreview` (bei Entwürfen zusätzlich `lastModifiedDateTime`) entscheidet über den
  Download. Entfernt jemand in Outlook einen Anhang einer empfangenen Mail oder bearbeitet ihren
  Text hinter den ersten 255 Zeichen, bleibt dieser Abdruck gleich. Deshalb liest der Lauf für
  jede Nachricht, deren Inhalt er lädt oder deren `lastModifiedDateTime` sich bei gleichem
  Abdruck geändert hat, eine Inhaltssignatur: `GET /messages/{mid}?$select=id,body&$expand=
  attachments($select=id,name,size,isInline)` mit `Prefer: outlook.body-content-type="text"`,
  je 20 Nachrichten ein `$batch`, daraus SHA-256 über den Text und die sortierte Anhangsliste,
  gespeichert als `contentSignature`. Weicht sie ab, wird der Inhalt neu geladen. Markierung,
  Lesestatus, Kategorien und Aufbewahrungsstempel ändern sie nicht (PidTagMessageSize dagegen
  schon: Exchange zählt jede MAPI-Eigenschaft mit, deshalb taugt die Größe nicht). Bleibt die
  Abfrage für eine geänderte Nachricht unbeantwortet (429, 5xx, ganzer `$batch` abgelehnt),
  behält die Sicherung die alte Kopie mit ihrer alten Änderungszeit, der Lauf meldet die
  Nachricht als Warnung `graph.mail_content_unchecked`, und der nächste Lauf prüft sie über die
  Wiederholungsliste erneut. Auch eine Nachricht, die erst eine Wiederholung oder die erneute
  MIME-Abfrage speichert, bekommt ihre Signatur. Eine Kopie ohne `contentSignature` (vor 0.5.0)
  wird bei ihrer nächsten Änderung einmal neu geladen. `changeKey` taugt dafür nicht, er ändert
  sich auch bei Flags und Lesestatus.
- Große Anhänge (>4 MB) kommen im MIME mit; `$value` kann für sehr große Mails
  (>150 MB) fehlschlagen; Fallback: Anhänge einzeln über `/attachments/{id}/$value`.
- JSON-Format (Graph-JSON der Nachricht mit `body` und `internetMessageHeaders`, dazu jeder
  Anhang als eigenes Objekt) nur, wenn `$value` die Nachricht wirklich verweigert. Der Grund
  steht im Objekt als `formatReason`: `too_large` (413 oder ein Größen-Code), `conversion_refused`
  (Exchange kann das Element nicht in MIME umwandeln: `ErrorMimeContentConversionFailed`,
  `ConversionFailed`, `CorruptData`). Ein einfacher 500 ohne solchen Code ist kein Grund: `$value`
  wird mit Backoff (1 s, 2 s, plus Jitter; `Retry-After` gilt) insgesamt dreimal gefragt; bleibt
  es beim 500, ist die Nachricht ein Elementfehler und der nächste Lauf holt sie über
  `mailRetry` erneut. Antworten fünf Nachrichten in Folge mit nichts als 500 (ein Ausfall im
  Exchange-Backend trifft ganze Postfächer), fragt der Lauf weitere Nachrichten nicht mehr und
  wartet auch keinen Backoff mehr ab: Sie sind sofort Elementfehler (wiederholt über
  `mailRetry`, ohne Zählung in `mailMimeServerErrors`), und höchstens einmal je Minute geht ein
  einzelner Versuch ohne Backoff hinaus; antwortet er, läuft alles wieder normal.
  Erst nach drei Läufen in Folge mit nur 500 wird die JSON-Form gesichert
  (`server_error`, gezählt in `mailMimeServerErrors` im Zustand), damit der Inhalt sicher ist.
  Eine JSON-Kopie mit `server_error` oder ohne `formatReason` (vor 0.5.0 reichten zwei schnelle
  500 für die JSON-Form auf Dauer) fragt jeder inkrementelle Lauf noch einmal nach dem MIME
  (höchstens 200 je Ordner und Lauf); kommt es, ersetzt es die JSON-Kopie samt Anhängen, sonst
  bleibt die Kopie unverändert. Jede JSON-Sicherung steht im Protokoll ("message stored as JSON
  instead of MIME" mit Grund) und gezählt im Abschluss des Laufs (`jsonFallbacks`). Eine nach
  Serverfehlern gesicherte JSON-Kopie (`server_error`) ist außerdem eine Warnung
  `graph.mail_stored_without_mime` an der Nachricht, im Lauf, der sie speichert, und in jedem
  Lauf, dessen erneute MIME-Abfrage wieder scheitert: Bis das MIME kommt, hat die Nachricht keine
  Originaldatei für EML-, MBOX- oder PST-Export, der Lauf ist also nicht grün. `too_large` und
  `conversion_refused` sind endgültige Antworten von Exchange und bleiben grün.
  Jeder Dateianhang der JSON-Form trägt seine Content-ID (`metadata.contentId`, gelesen mit dem
  Typ-Cast-`$select` `microsoft.graph.fileAttachment/contentId`, weil `contentId` nur am
  abgeleiteten Typ steht); der Restore setzt sie wieder, sonst zeigen die `cid:`-Bilder im
  HTML-Text ins Leere. Lehnt Graph den Typ-Cast ab (400), werden die Anhänge ohne gelistet und
  die Nachricht trägt `contentIdUnavailable`. JSON-Sicherungen vor 0.5.0 haben keine Content-ID.
- Kalender: `/users/{id}/calendars` und `/events` (Serientermine als Master plus
  Ausnahmen; `calendarView` nur für Ansicht, nicht für Backup). Kontakte:
  `/contactFolders` und `/contacts`. Beides als JSON mit Graph-Schema sichern.
  `/calendars` liefert alle Kalender des Postfachs, auch die in anderen Kalendergruppen
  ("Weitere Kalender"); `/events` jeden Termin ohne Filter auf Teilnehmer oder Teams, also auch
  Termine nur für sich selbst. Ausnahmen einer Serie kommen aus `/events/{master}/instances` im
  Fenster ein Jahr zurück bis zwei Jahre voraus. Die Kalender von Microsoft-365-Gruppen und Teams
  gehören nicht zum Postfach eines Nutzers; sie werden ab 0.4.5 als Gruppenpostfach gesichert
  (siehe „Gruppenpostfächer"). Ein von
  einem anderen Postfach freigegebener Kalender gehört diesem Postfach und wird mit ihm gesichert.
  Die Metadaten eines Termins nennen Betreff, Beginn und Ende (UTC), ganztägig, Organisator, Ort
  und bei einer Serie das letzte Datum ihres Bereichs (Ort und Serienende ab 0.4.2).
- Terminanhänge (Nutzerkalender, ab 0.5.0): Hat ein Termin `hasAttachments`, listet der Lauf
  `/users/{id}/events/{id}/attachments` (mit Content-ID) und speichert jeden Dateianhang als
  Objekt `event-attachment` unter `<Termin>.attachments/<Name>.<id>` (Inhalt über `$value`;
  Metadaten Name, Inhaltstyp, Größe, inline, Content-ID, `eventItemId`, `eventPath`), einen
  Elementanhang als sein Graph-JSON (`$expand=microsoft.graph.itemAttachment/item`), einen
  Linkanhang nur mit Namen am Termin (`referenceAttachments`). Der Termin trägt
  `attachmentsChangeKey`: Solange sein `changeKey` gleich bleibt, werden die Anhänge nicht neu
  gelesen, nur mitgeführt (auch bei Umbenennung). Ein Anhang, der sich nicht lesen lässt, ist ein
  Elementfehler des Termins; die gespeicherten Anhänge bleiben, und der nächste Lauf liest sie
  erneut. Eine Ausnahme einer Serie (ein verschobener Termin, an den nur dort das Protokoll
  angehängt ist) hat eigene Anhänge: Für jede Ausnahme mit `hasAttachments` liest der Lauf
  `/events/{Ausnahme-ID}/attachments` genauso und legt sie unter
  `<Serie>.attachments/occurrence <Datum>.<id>/` ab, mit `eventItemId` = Ausnahme,
  `seriesMasterId` = Serie und `eventPath` = `<Serie-Pfad>#<Ausnahme-ID>` (ein eigenes
  Terminobjekt hat die Ausnahme nicht, sie steht im JSON der Serie). Die Serie trägt je Ausnahme
  deren `changeKey` (`exceptionAttachments`); nur bei einer Änderung wird neu gelesen.
  Sicherungen vor 0.5.0 haben keine Terminanhänge; der erste Lauf danach holt sie für alle noch
  vorhandenen Termine nach.
- Terminanhänge im Restore (`packages/core/src/restore/exchange.ts`, `restoreEventAttachments`):
  Objekte vom Typ `event-attachment` (die Bytes eines Dateianhangs, `metadata.eventPath` oder
  `eventItemId` nennt den Termin, dazu `name`, `contentType`, `attachmentType`, `isInline`)
  werden nach dem Termin angelegt, unter 3 MB mit `POST /events/{id}/attachments`, ab 3 MB über
  `…/attachments/createUploadSession` (bis 150 MB, Fragmente wie bei Mail-Anhängen); ein
  angehängtes Element kommt als Datei mit seinem gesicherten Graph-JSON (`<Name>.json`), ein
  Link-Anhang nicht. Die Anhänge einer Serienausnahme (`seriesMasterId`, `eventPath`
  `<Serie-Pfad>#<Ausnahme-ID>`) kommen an das passende Vorkommen der wiederhergestellten Serie,
  sobald die Ausnahme dort wieder angewendet ist; lässt sie sich nicht anwenden, werden sie mit
  diesem Grund übersprungen. Danach wird jeder Anhang an Name und Größe auf dem Termin bestätigt. Ein Anhang, den ein früherer Versuch desselben Jobs schon
  angelegt hat, wird nicht noch einmal gesendet. Hatte ein Termin Anhänge (`hasAttachments`), die
  Sicherung aber keine (ältere Sicherungen, Gruppenkalender), ist er „Nicht bestätigt“ mit dem
  Hinweis, dass die Anhänge nicht gesichert wurden.
- Kalender im Restore-Explorer (ab 0.4.2): Ein Kalender listet seine Termine nach Beginn
  (neueste zuerst oder anstehende zuerst), mit Wann, Ort und Organisator, nicht nach Betreff.
  Eine Serie steht einmal in der Liste und klappt ihre Termine auf; die Monatsansicht zeigt
  alle Kalender eines Postfachs (oder einen) Tag für Tag. Die Termine einer Serie berechnet
  die API (`GET /snapshots/:id/calendar`, auditiert als `snapshot.calendar.read`) aus dem
  gesicherten Muster und setzt die gesicherten Ausnahmen an ihre Stelle; die Uhrzeit folgt der
  Zeitzone der Serie über Sommer- und Winterzeit. Ein einzeln gelöschter Termin einer Serie ist
  im Backup nicht vermerkt (Graph v1.0 nennt keine abgesagten Vorkommen) und erscheint daher
  noch, so wie ihn eine Wiederherstellung der Serie auch wieder anlegt.
- Online-Archiv (In-Place Archive) wird nicht gesichert: Graph v1.0 liest nur das primäre
  Postfach (`/users/{id}/mailFolders`), und Restow liest das Archiv nicht über Beta-APIs. Mails,
  die eine Aufbewahrungsrichtlinie (MRM, etwa „nach 2 Jahren ins Archiv verschieben“) oder der
  Benutzer ins Online-Archiv verschiebt, meldet das Ordner-Delta als entfernt; sie fehlen ab
  dann in den neuen Sicherungsständen, ältere behalten sie bis zum Ende ihrer Aufbewahrung. Damit
  das nie still geschieht, fragt jeder Lauf einmal (Antwort einen Tag im Zustand gemerkt,
  `onlineArchive`) Graph beta `GET /beta/users/{id}/settings/exchange` (exchangeSettings,
  Anwendungsberechtigung User.Read.All, die die App für den Verzeichnis-Sync ohnehin hat). Nennt
  Graph ein `inPlaceArchiveMailboxId`, endet jeder Lauf des Postfachs mit der Warnung
  `graph.online_archive_not_covered` (Element `online-archive`, nicht wiederholbar), nie einfach
  grün; die Warnung lässt sich bestätigen. Grün bleibt ein Lauf nur bei der belegten Antwort
  „kein Archiv“. Verweigert Graph die Abfrage oder beantwortet sie nicht (fehlende Berechtigung,
  Beta nicht verfügbar, 403, 5xx), endet der Lauf mit der Warnung `graph.online_archive_unknown`
  (wiederholbar), und der nächste Lauf fragt erneut; ein früher erkanntes Archiv bleibt solange
  als `graph.online_archive_not_covered` gemeldet. Wer das Archiv braucht, sichert es auf anderem Weg (etwa per
  eDiscovery-Export) oder bewahrt die Sicherungsstände so lange auf, wie die Mails gebraucht
  werden.
- Geteilte Postfächer und Ressourcen: normale Nutzerobjekte ohne Lizenz; Schutzregel
  muss sie einschließen können.
- Gelöschte Nutzer: Graph `directory/deletedItems/microsoft.graph.user` 30 Tage; das
  Backup behält Snapshots unabhängig davon (Retention regelt das, nicht Entra).

### Deaktivierte und unlizenzierte Konten

Ab 0.4.7. Ein Postfach, dessen Konto deaktiviert ist (`accountEnabled=false`) oder das keine
Exchange-Online-Lizenz (mehr) hat (Postfach nicht bereitgestellt, Lizenz entzogen, inaktives
Postfach), ist kein fehlgeschlagenes Backup. Es bleibt `orphaned` wie ein entferntes Objekt, mit
einem Grund in `protected_objects.status_reason` (`account_disabled` oder `no_license`,
Migration 0069): keine neuen Sicherungen, die vorhandenen bleiben, nie überfällig, die Bereitschaft
ohne das Alter der letzten Sicherung (`readinessWithoutFreshness`), keine `backup.failed`-Meldung.
Die Oberfläche zeigt neutral „Nicht gesichert: Konto deaktiviert“ bzw. „... keine Lizenz“.

- Entscheidend ist allein die Antwort von Exchange, nicht `accountEnabled`: Ein deaktiviertes
  Konto, dessen Postfach Graph noch liest (geteiltes Postfach, ausgeschiedene Person), wird
  weiter gesichert. Ein geteiltes Postfach hat dieselben Merkmale (deaktiviert, ohne Lizenz) und
  ließe sich sonst nicht unterscheiden.
- Verzeichnisabgleich: Meldet die Postfach-Probe (`GET /users/{id}/mailboxSettings`) für ein
  Mitglied „kein Postfach“ (404 oder ein Code aus `MAILBOX_UNAVAILABLE_CODES`, darunter
  `MailboxNotEnabledForRESTAPI`, `MailboxNotSupportedForRESTAPI`,
  `ErrorMailboxNotHostedInExchangeOnline`), wird das Postfach mit Grund verwaist: deaktiviert,
  wenn `accountEnabled=false`, sonst keine Lizenz (`inactiveReason`, core `directory/rules.ts`).
  Kann die Probe nicht antworten, bleibt ein so markiertes Postfach, wie es ist.
- Beim Backup (das Fenster bis zum nächsten Abgleich): Scheitert ein Postfach mit
  `graph.mailbox_not_licensed`, `graph.user_not_found` oder `graph.request_rejected` mit 400/404,
  fragt der Worker einmal nach (`confirmMailboxInactive`, core `directory/confirm.ts`:
  Benutzer lesen und Postfach-Probe in einem `$batch`). Nur wenn der Benutzer existiert und
  Exchange eindeutig „kein Postfach“ sagt, markiert er das Objekt und beendet den Lauf mit
  `graph.mailbox_inactive` (endgültig, ohne Wiederholung, technische Details des ursprünglichen
  Fehlers bleiben). Ein späterer Lauf auf das markierte Objekt endet mit `config.object_inactive`.
- 401 und 403 gelten nie als inaktiv (`ErrorAccessDenied`, `Authorization_RequestDenied`,
  Application Access Policy, RBAC for Applications): Das sind Berechtigungsprobleme und bleiben
  Fehler. Ein Benutzer, den es nicht mehr gibt (404 auf `/users/{id}`), ist kein inaktives Konto;
  ihn verwaist der Abgleich ohne Grund.
- Wiederaufnahme von selbst: Eine neue Lizenz oder ein wieder aktiviertes Konto ändert
  `assignedLicenses` bzw. `accountEnabled`, der Benutzer kommt in `users/delta`, die Probe
  antwortet 200, das Postfach wird `active` (der Trigger der Migration 0069 löscht den Grund)
  und die erste Sicherung startet gleich nach dem Abgleich. Spätestens der volle Abgleich alle
  24 Stunden findet es.
- Zählung: Solche Läufe (`NOT_BACKED_UP_CAUSES` in core `failures/limits.ts`) zählen weder als
  fehlgeschlagen noch als gebremst (getrennt von `SERVICE_LIMIT_CAUSES`), beenden keine
  Bestätigung einer Warnung und lösen weder `backup.failed` noch den Webhook `job.failed` aus.

### Nicht mehr gesichert: Bestätigung

Ab 0.4.7. Hört Restow auf, ein Objekt zu sichern, weil die Quelle es als entfernt, deaktiviert,
ohne Lizenz oder gesperrt meldet (`orphaned`, mit oder ohne `status_reason`), steht es zuerst
gelb „Nicht mehr gesichert, bitte bestätigen“, mit Grund und Datum (`inactive_since`). Das gilt
für Postfächer, OneDrives, SharePoint-Websites und Gruppenpostfächer. IMAP-Konten werden nur durch
die Antwort eines Administrators `orphaned`, mit dem Grund `login_refused` und schon bestätigt
(docs/IMAP.md „Anmeldung abgelehnt: Konto abgeschaltet?“): Bei Microsoft 365 erkennt Restow den
Zustand und lässt ihn nachträglich bestätigen, bei IMAP setzt ihn die Antwort.

- Unbestätigt: kein Fehlschlag, kein Rot, nicht überfällig (wie oben), aber „braucht
  Aufmerksamkeit“: die Bereitschaft des Mandanten ist höchstens gelb (`toConfirm` in der
  Zusammenfassung, core `directory/inactive.ts`, API `verify/summary.ts`), Warnungen, Dashboard,
  Anbieter-Alarm `inactive_to_confirm` und `GET /api/v1/status` zählen es. Die eigene Bewertung des
  Objekts ändert sich nicht: ein roter Prüfbericht bleibt rot.
- Einmalige Meldung je Objekt und Übergang über die Benachrichtigungsmatrix: `object.inactive`
  (Hinweis, Stufe `info`). Werden bei einem Mandanten an einem Tag mehr als 10 Objekte oder mehr
  als 20 % der zuvor gesicherten Objekte (ab zwei Objekten) inaktiv, kommt stattdessen eine
  Warnung `object.inactive_many`, höchstens eine je Tag (apps/worker `inactive-notices.ts`, nach
  jedem Verzeichnisabgleich und in derselben Transaktion, in der ein Backup ein Objekt inaktiv
  markiert). `inactive_notified_at` macht die Meldung idempotent.
- „Ja, beabsichtigt“: Mandanten-Admins und Anbieter mit Konfigurationsrecht bestätigen einzeln
  (`POST /api/v1/directory/objects/:id/inactive/confirm`) oder in der Liste für mehrere
  (`POST /api/v1/directory/objects/inactive/confirm`, `objectIds` oder `filter`, mandantenweit,
  höchstens 1000), auditiert (`directory.inactive.confirmed`, `directory.inactive.bulk_confirmed`).
  Danach grau „Absichtlich nicht mehr gesichert, bestätigt von <wer> am <Datum>“
  (`status_confirmed_at`, `status_confirmed_by`).
- Wird das Objekt wieder aktiv (Konto aktiviert, Lizenz zugewiesen, Sperre aufgehoben, wieder in
  der Quelle), löscht der Trigger der Migration 0069 Grund, Datum, Meldung und Bestätigung, und
  die Sicherung startet direkt nach dem Abgleich. Wird es später erneut inaktiv, wird wieder
  gefragt.
- Upgrade: Objekte, die vor 0.4.7 schon `orphaned` waren, gelten als bestätigt
  (`status_confirmed_by = 'migration'`, Backfill in 0069) und lösen keine Meldung aus.
- Ausgeschlossene Objekte: Wird ein `excluded` Objekt (Ausschluss durch Administrator oder Regel)
  `orphaned`, etwa weil das Konto oder die Website gelöscht wurde, hat Restow nie etwas davon
  gesichert und nichts beendet. Der Trigger setzt es daher gleich auf bestätigt und gemeldet
  (`status_confirmed_by = 'excluded'`): keine Meldung, kein gelber Zustand, nicht in `toConfirm`.

## Exchange: Wiederherstellen

- Nachricht aus MIME anlegen: `POST /users/{id}/mailFolders/{fid}/messages` mit
  `Content-Type: text/plain` und Base64-kodiertem MIME. Ergebnis ist ein neues Objekt
  (neue ID, `isDraft=false` wenn Header vollständig). Datum bleibt erhalten, Flags/
  Kategorien danach per PATCH setzen. Legt Graph eine Nachricht als Entwurf an, die laut
  Sicherung keiner war (`isDraft` der Exchange-Sicherung, `\Draft` einer IMAP-Sicherung oder
  eines Imports), etwa weil Date oder From im Header fehlen, ist das Element „Nicht bestätigt“
  mit dem Grund; ist der Entwurfsstatus der Sicherung unbekannt, steht es nur als Hinweis da.
- Größe: Graph nimmt in einer Anfrage höchstens 4 MB an (sonst 413). Base64 macht aus 3 MB MIME
  4 MB, deshalb importiert Restow eine Nachricht nur dann in einem Stück als MIME, wenn ihr Base64
  höchstens 3,5 MiB lang ist (`MIME_IMPORT_LIMIT_BASE64_BYTES`, also etwa 2,6 MiB MIME). Eine
  größere Nachricht (bis 150 MB sichert die Sicherung als MIME) wird in zwei Durchgängen über die
  Sicherung zerlegt (`packages/core/src/restore/mime-parts.ts`, mailparser, ohne einen Anhang im
  Speicher zu halten): zuerst aus Kopf und Text als JSON angelegt (Betreff, Text oder HTML,
  Absender, Empfänger, Antwort an, Wichtigkeit, Message-ID, `x-`-Header und die erweiterten
  Eigenschaften für Entwurfsstatus und Daten wie unten), dann bekommt sie ihre Anhänge einzeln:
  unter 3 MB mit einem POST, ab 3 MB über `createUploadSession` (bis 150 MB je Anhang, Fragmente
  bis 4 MiB), eingebettete Bilder mit ihrer Content-ID (`cid:` im HTML), eine angehängte
  Nachricht als `.eml`. Danach listet Restow die Anhänge der Nachricht und vergleicht Name und
  Größe mit dem, was es hinzugefügt hat. Scheitert ein Anhang, fehlt einer in der Liste oder
  stimmt die Message-ID nicht, ist das Element „Nicht bestätigt“ mit dem Grund. Der Text selbst
  muss in die 4 MB einer Anfrage passen: Bilder, die ein HTML-Text als `data:`-URI enthält (ein
  Newsletter), werden zu eingebetteten Anhängen mit Content-ID; ein Text, der auch ohne sie
  größer ist, lässt sich nicht ins Postfach legen und scheitert mit dem Hinweis auf den
  EML-Download. Den Entwurfsstatus legt die Sicherung fest; wo sie ihn nicht kennt (Beiträge
  aus Gruppenunterhaltungen), gilt, was ein MIME-Import ergäbe: kein Entwurf, wenn Date und From
  im Header stehen. Eine verschlüsselte (S/MIME `application/pkcs7-mime`, PGP
  `multipart/encrypted`), undurchsichtig signierte (`smime-type=signed-data`) oder
  rechtegeschützte Nachricht (Purview, `.rpmsg`) dieser Größe baut Restow nicht nach: Exchange
  speichert solche Nachrichten als eigene Nachrichtenklasse mit dem Original-MIME, ein Nachbau
  aus Teilen ließe sich weder öffnen noch prüfen. Sie scheitert mit dem Hinweis auf den
  EML-Download. Eine signierte Nachricht (`multipart/signed`) kommt lesbar mit der Signaturdatei
  als Anhang zurück, aber „Nicht bestätigt“, weil die Signatur nicht mehr passt. Bis zur Grenze
  des MIME-Imports behalten alle diese Nachrichten ihren Schutz. Was dabei nicht zurückkommt (die Header, die Graph beim
  Anlegen nicht nimmt, etwa Received und References, und die genaue MIME-Struktur), nennt der
  Hinweis des Elements; die Originalbytes gibt es als EML-Download. Den Hinweis „als Download
  (EML) wiederherstellen“ gibt es nur noch, wenn Exchange eine Anfrage wirklich ablehnt.
- Nachricht aus dem JSON-Format anlegen (Graph hatte den MIME-Export verweigert, siehe
  „Sichern"): `POST /users/{id}/mailFolders/{fid}/messages` mit dem gesicherten JSON ohne die
  schreibgeschützten Felder (`toCreatableMessage`, `packages/core/src/graph/resources/mail.ts`).
  Graph nimmt beim Anlegen in `internetMessageHeaders` nur eigene Header mit `x-`/`X-` an und
  lehnt jeden anderen (Received, DKIM-Signature, Message-ID, ...) mit 400
  `InvalidInternetMessageHeader` ab. Restow schickt deshalb nur `x-`-Header mit, ohne die von
  Exchange beim Zustellen gestempelten (`X-MS-*`, `X-Microsoft-*`, `X-Forefront-*`), höchstens 5
  und zusammen höchstens 2 KB; die übrigen bleiben in der Sicherung, die Wiederherstellung nennt
  ihre Anzahl. Ohne weitere Angaben legt Graph eine JSON-Nachricht als Entwurf mit dem heutigen
  Datum an; kennt die Sicherung den Entwurfsstatus nicht und zeigt Exchange die Nachricht als
  Entwurf, ist sie „Nicht bestätigt“. War die gesicherte Nachricht kein Entwurf (`isDraft` im JSON oder in den Metadaten),
  setzt Restow beim Anlegen die erweiterten Eigenschaften `PidTagMessageFlags` (`Integer 0x0E07`,
  gelesen-Bit aus `isRead`, nie das Entwurfs-Bit 0x8), `PidTagMessageDeliveryTime`
  (`SystemTime 0x0E06` = `receivedDateTime`) und `PidTagClientSubmitTime` (`SystemTime 0x0039` =
  `sentDateTime`). Graph wertet sie nur beim Anlegen aus. Meldet Graph die Nachricht danach doch
  als Entwurf oder mit anderen Daten, ist das Element „Nicht bestätigt“ mit dem Grund.
- Zielordner: Original-Pfad nachbauen oder "Wiederhergestellt <Datum>"-Ordner; beides
  anbieten. Duplikate vermeiden: vor Import per `internetMessageId` prüfen.
- Unbekannter Ausgang: Ein POST ist nicht idempotent. Antwortet das Gateway 502/504, kommt keine
  Antwort rechtzeitig oder bricht die Verbindung ab, kann Exchange das Element trotzdem anlegen,
  auch erst Sekunden bis Minuten später (ein großer MIME-Import in ein gedrosseltes Postfach).
  Restow sendet dann nicht sofort erneut, sondern sucht das Element etwa zwei Minuten lang
  (Abfragen nach 0, 5, 15, 30 und 60 s, `UNKNOWN_OUTCOME_LOOKS_MS` in
  `packages/core/src/restore/common.ts`): eine Nachricht über ihre Message-ID im Zielordner, einen
  Anhang über Name und Größe, einen Kontakt über Name und Adresse. Was es findet, wird übernommen
  (wiederhergestellt, aber nicht bestätigt). Erst wenn keine Abfrage etwas sieht, geht die Anfrage
  ein zweites Mal hinaus; danach sieht Restow noch einmal nach, und eine zweite Kopie, die doch
  noch entstanden ist, macht das Element „Nicht bestätigt“ mit dem Hinweis, die überzählige zu
  entfernen. Ein Ordner wird erneut angelegt; antwortet Exchange darauf 409, weil der erste doch
  entstanden ist, wird er übernommen. Eine Nachricht ohne Message-ID und ein nicht gefundener
  Kontakt werden nie ein zweites Mal gesendet, sondern gemeldet. Termine gehen mit derselben
  `transactionId` erneut hinaus, Graph liefert dann den schon angelegten.
- Kalender/Kontakte: POST auf `/events` bzw. `/contacts` aus dem JSON (IDs werden neu).
- Grenzen: Send/Receive-Status, Konversations-IDs und einige Header werden neu erzeugt.
  Das ist bei jedem Produkt so; in der Doku sagen.

## OneDrive: Sichern und Wiederherstellen

- Laufwerk: `/users/{id}/drive`; Änderungen: `/drives/{did}/root/delta` mit Token.
  Erstlauf liefert alles, danach nur Änderungen inkl. Löschungen (`deleted` Facette).
- Download: `@microsoft.graph.downloadUrl` (kurzlebig, ohne Auth), Stream in den
  Chunker, nie ganze Dateien im RAM.
- Versionen: `/items/{id}/versions` optional (Kosten!), v1 sichert die aktuelle
  Version je Snapshot; Snapshots liefern die Historie.
- Restore: Upload-Session `createUploadSession` für alles über 4 MB, Chunks 5 bis
  60 MiB, Vielfache von 320 KiB. Konflikte: `@microsoft.graph.conflictBehavior`
  rename/replace wählbar. mtime setzen über `fileSystemInfo`. Ein Fragment, das scheitert
  (5xx, abgebrochene Verbindung, keine Antwort, 416 nach einem erneut gesendeten Fragment),
  beendet die Datei nicht: Restow fragt die Session (`GET` auf die `uploadUrl`) nach
  `nextExpectedRanges` und sendet nur, was ihr fehlt, bis zu sechs Versuche je Fragment mit
  wachsender Pause (`packages/core/src/graph/resources/upload-session.ts`). Eine Datei liest das
  Fragment dafür erneut aus ihren Chunks (`restore/object-range.ts`), auch ein früheres, das die
  Session verloren hat; ein Mail-Anhang (aus dem MIME-Strom) sendet das aktuelle Fragment aus dem
  Speicher. Gibt der Upload auf, wird die Session mit `DELETE` beendet. Ging nur die Antwort auf
  das letzte Fragment verloren, sucht Restow die Datei unter ihrem Namen (nicht im Modus
  „Umbenennen“, dort bleibt sie fehlgeschlagen) und den Anhang an seiner Nachricht.
- OneNote-Notizbücher liefert Graph als `package` ohne `folder`-Facette. Die Sicherung legt sie
  als Ordner mit ihren `.one`-Abschnitten ab; beim Restore steigt der Pfad in ein noch
  vorhandenes Notizbuch ab und legt die Abschnitte dort hinein.
- Restore-Explorer (ab 0.4.2): Postfach, OneDrive und ein zugeordnetes IMAP-Konto einer
  Person stehen als ein Eintrag (über den Verzeichnisbenutzer des Objekts,
  `protected_objects.user_id`); die zweite Spalte zeigt E-Mail, Kalender, Kontakte und OneDrive,
  jeweils mit den Sicherungsständen des passenden Objekts. Ein OneDrive for Business gehört immer
  genau einem Benutzer; nach dem Löschen des Kontos steht es verwaist unter dessen Namen, markiert
  als "Konto gelöscht". SharePoint-Websites (mit den Dateien der Teams-Kanäle) haben einen eigenen
  Abschnitt. Die Liste kommt seitenweise aus der API (`GET /snapshots/people`, Keyset nach eigenem
  Eintrag, Name und Schlüssel, je 50 Einträge, beim Blättern oder auf "Weitere anzeigen"); Suche
  über Namen, Adressen und Konto-IDs und der Typfilter laufen in der Datenbank, so dass auch
  Mandanten mit über 10.000 Personen nie alle auf einmal laden.
- Teams & Websites einer Person (ab 0.5.0, #89): Unter E-Mail, Kalender, Kontakte und OneDrive
  zeigt der Eintrag einer Person die SharePoint-Websites und Gruppenpostfächer, deren Inhaber oder
  Mitglied sie ist (Abschnitt „Mitgliedschaften" unten), Inhaber zuerst, mit Rolle und neuestem
  Sicherungsstand. Ein Klick öffnet das Objekt in seinem eigenen Eintrag unter „SharePoint &
  Teams" mit seinen Sicherungsständen; dort bleibt es auch gelistet, und eine Wiederherstellung
  von hier folgt denselben Regeln. Wie Websites und Gruppen überall sehen den Bereich nur
  Wiederherstellungsoperatoren und Administratoren. Aufgeführt sind geschützte Objekte und solche
  mit Sicherungsstand. Die Liste kommt seitenweise aus der API
  (`GET /snapshots/people/memberships?key=user:<id>`, Keyset nach Rolle, Name und ID, je 25 Einträge,
  eine Abfrage je Seite über den Index `directory_memberships_user_idx`).
- Freigaben/Berechtigungen werden als Information gesichert, nicht wiederhergestellt
  (v1): je Element die Freigabe-Facette (`sharedScope`, `sharedBy`, `sharedDateTime`).
  Jede Delta-Seite fragt mit `Prefer: deltashowsharingchanges` (ab 0.5.0):
  Ohne den Header lässt OneDrive for Business/SharePoint ein Element, an dem sich nur die Freigabe
  geändert hat, aus dem Delta weg, und ein inkrementeller Lauf behielte die alte Freigabe für
  immer. Ein so gemeldetes Element (`@microsoft.graph.sharedChanged: "True"`) liest der Lauf
  einmal einzeln (`GET /drives/{did}/items/{id}`, ohne Download; unveränderte Bytes werden wie
  immer übernommen) und übernimmt dessen Freigabe; lässt es sich nicht lesen, ist das ein
  Elementfehler mit Wiederholung im nächsten Lauf, die Datei bleibt gesichert. Bewusst ohne
  `hierarchicalsharing`: Damit meldet Graph eine Freigabe nur an der Wurzel der
  Berechtigungshierarchie und lässt die geerbte Freigabe an jedem Element darunter weg. Eine
  bearbeitete oder neue Datei in einem freigegebenen Ordner stünde dann als nicht freigegeben im
  Sicherungsstand, und die Dateien unter einem Ordner, dessen Freigabe entfernt wurde, behielten
  ihre alte. Ohne den Header trägt jedes gemeldete Element seine geltende (auch geerbte)
  Freigabe. Sagt ein Delta-Eintrag zur Freigabe nichts, behält eine Datei mit unveränderten
  Bytes die zuletzt gesicherte.
- Gesperrtes OneDrive (ab 0.4.7): Microsoft sperrt das OneDrive eines Kontos ohne Lizenz nach
  einiger Zeit. Jeder Zugriff antwortet dann HTTP 423 mit `notAllowed`/`resourceLocked` („Access
  to this site has been blocked. Please contact the administrator to resolve this problem.“),
  auch `GET /drives/{id}/root/delta`; das Laufwerk bleibt aber gelistet. Ein 423 mit diesem Code
  auf Laufwerks- oder Website-Ebene ist `graph.object_locked` (core `failures/graph.ts`), kein
  `graph.request_rejected`; ein 423 auf einer einzelnen Datei (ausgecheckt, in Benutzung) bleibt ein
  Elementproblem. Beim Backup bestätigt eine billige Leseanfrage die Sperre
  (`GET /drives/{id}/root?$select=id`, `confirmObjectLocked`, core `directory/locks.ts`); dann wird
  das Objekt `orphaned` mit Grund `locked` (gelb bis bestätigt, siehe oben), der Lauf endet
  neutral und endgültig, und der Planer plant keine Läufe mehr dafür (nur `active` wird geplant).
  Bestätigt die Leseanfrage die Sperre nicht (200, 429/5xx/403, Fehler, abgebrochener Lauf), bleibt
  das Objekt aktiv und der Lauf ein gezählter Fehler (`graph.request_rejected`, mit
  `backup.failed`); neutral ist nur eine bestätigte Sperre, sonst endeten die Läufe jede Nacht
  still ohne Fehler und ohne gelben Zustand.
  Der Verzeichnisabgleich schaltet ein gesperrtes Laufwerk nicht blind wieder aktiv: Er fragt für
  jedes bekannte gesperrte OneDrive dieselbe Leseanfrage (gebündelt per `$batch`) und aktiviert
  es nur bei 200; jede andere Antwort lässt es gesperrt und meldet `lock_probe_failed`. Antwortet
  schon die Laufwerks-Probe `/users/{id}/drive` mit der Sperre, wird das bekannte Laufwerk sofort
  neutral. Hat das Postfach des Besitzers den Grund „keine Lizenz“, zeigt die Oberfläche den
  Hinweis „Das Konto hat keine Lizenz“.
- Papierkorb: Elemente im OneDrive-Papierkorb sind über delta nicht erreichbar; ist ok,
  Restow hat sie im letzten Snapshot.

## SharePoint Online: Sichern und Wiederherstellen

Eine SharePoint-Website ist ein eigenes geschütztes Objekt (`protected_objects.kind = 'site'`,
Migration `0046_sharepoint_sites`), keinem Nutzer zugeordnet. Code: Graph-Ressourcen in
`packages/core/src/graph/resources/sites.ts`, Erkennung in `packages/core/src/directory/sites.ts`,
Sicherung in `packages/core/src/backup/sharepoint`, Wiederherstellung in
`packages/core/src/restore/sharepoint.ts`.

**Berechtigungen.** Erkennen und Sichern brauchen `Sites.Read.All`, die Wiederherstellung in eine
Website `Sites.ReadWrite.All` (Anwendungsberechtigungen). Der Katalog
(`packages/core/src/entra/permissions.ts`) führt `Sites.ReadWrite.All` als **optional**: Ein
Tenant, der vor SharePoint zugestimmt hat, bleibt „vollständig", Mail und OneDrive laufen weiter.
Fehlt die Berechtigung, antwortet Graph beim Auflisten mit 403; die Verzeichnissynchronisierung
meldet dann die Warnung `sites_unavailable` (in der Oberfläche: „SharePoint-Websites werden weder
gefunden noch gesichert …") und lässt bekannte Websites unverändert. Die Berechtigungsprüfung der
Quelle zeigt den Fall eigens an, ebenso nur `Sites.Read.All` („gesichert, aber nicht
wiederhergestellt"). **Bestehende Tenants müssen neu zustimmen**: Betreiber trägt
`Sites.ReadWrite.All` in der App-Registrierung ein, Kunden-Admin öffnet den Consent-Link der Quelle
erneut (docs/ENTRA-SETUP.md, Teil 2 und 4). Danach findet die nächste Synchronisierung die
Websites.

**Erkennung.** Jede Verzeichnissynchronisierung listet `/sites/getAllSites` (`$select`, 500 je
Seite). Gruppenverbundene Websites von Microsoft-365-Gruppen und Teams sind darin normale Websites.
Persönliche Websites (OneDrives, `isPersonalSite` bzw. `-my.sharepoint.com/personal/`) werden
übergangen, sie sind über ihren Besitzer als OneDrive geschützt. Die Regeln kennen einen eigenen
Modus für Websites (`config.protection.sites`): `all` (Vorgabe, alle Websites) oder `selected`
(nur eingeschlossene). Gruppe, Ausschlussliste und Schalter für geteilte Postfächer gelten nicht
für Websites, Einzelentscheidungen (einschließen/ausschließen) schon. Eine Website, die nicht mehr
aufgelistet wird, wird verwaist; ihre Sicherungsstände bleiben. Neu geschützte Websites bekommen
sofort ihre erste Sicherung. Websites stecken in Mail-Jobs wie Postfächer und OneDrives; ein Job
mit Umfang „alle" umfasst damit auch alle Websites (über den Website-Modus „ausgewählte" lässt sich
das vorab begrenzen).

**Sicherung, ein Sicherungsstand je Website:**

| Pfad im Sicherungsstand | Inhalt |
| --- | --- |
| `site.json` | Titel, URL, Beschreibung, Websitesammlung, `sharepointIds`; je Bibliothek Name, Drive-ID, die Freigaben ihres Stammordners (`/drives/{id}/root/permissions`), ob sie in diesem Lauf gelesen wurde (`readThisRun`) und wann zuletzt (`lastReadAt`); je Liste Name, Vorlage, Elementzahl |
| `Libraries/<Bibliothek>/…` | jede Dokumentbibliothek (`/sites/{id}/drives`, auch „Websiteseiten" mit den Seiten und „Websiteobjekte") über den Drive-Lauf der OneDrive-Engine: Delta mit Token je Bibliothek, Elemente nach ID, gestreamte Downloads, optionale Versionen (`<Datei>:versions/<id>`), Wiederholung, 410-Neuaufzählung, Prüfpunkte, Freigabe-Facette je Element als Information (Freigabeänderungen über `Prefer: deltashowsharingchanges`, wie beim OneDrive) |
| `Lists/<Liste>/_list.json` | Liste und Spalten (`/lists/{id}/columns`) |
| `Lists/<Liste>/<Titel> (<id>).json` | je Listenelement alle Feldwerte (`/lists/{id}/items?expand=fields`), dazu Inhaltstyp, Autor, Daten |

Bibliotheken setzen bei der nächsten Sicherung an ihrem Delta-Link fort (`state.libraries[]`);
eine Wiederholung nach Abbruch läuft Bibliotheken, die schon fertig waren, nicht erneut ab. Listen
haben kein Delta: Sie werden je Lauf vollständig gelesen (die Feldwerte kommen mit der Auflistung,
200 je Seite), ein unverändertes Element (gleiches eTag) übernimmt seine gespeicherten Bytes, den
Rest dedupliziert der Pack-Speicher. Versteckte Listen (Systemlisten) und Bibliotheken als Listen
werden übergangen. Eine Bibliothek oder Liste, die Graph verweigert (403/404/423), wird als
fehlgeschlagenes Element gemeldet und behält ihre letzte Kopie (Liste: jedes Element als `stale`
markiert; Bibliothek, ab 0.5.0: der Bibliotheksordner trägt `carriedForward: "true"` und
`lastReadAt`, den Zeitpunkt, zu dem ihre Dateien zuletzt gelesen wurden, und `site.json` nennt sie
mit `readThisRun: false`; die Dateien selbst werden nicht als `stale` markiert, damit ihre
Wiederverwendung nach Inhaltskennung weiter greift); der Rest der Website wird gesichert. Eine gelöschte Website schlägt mit `graph.site_unavailable` fehl.
Eine gesperrte Website (ab 0.4.7; ein Administrator hat sie gesperrt, oder sie gehört zu einem
Konto ohne Lizenz) antwortet auf Website-Ebene (`/sites/{id}`, `/sites/{id}/drives`) oder in jeder
Bibliothek mit 423 `notAllowed`/`resourceLocked`: Antworten alle Bibliotheken so, endet der Lauf
ohne Sicherungsstand mit `graph.object_locked` statt alte Kopien zu übernehmen. Danach gilt wie
beim OneDrive (siehe dort): Bestätigung per `GET /sites/{id}/drive/root?$select=id`, Grund
`locked`, gelb bis bestätigt, und der Abgleich aktiviert eine weiter gelistete Website erst wieder,
wenn diese Anfrage 200 antwortet; eine nicht mehr gelistete wird ohne Grund verwaist.
Throttling wie bei OneDrive: derselbe Graph-Client (Retry-After plus Jitter, 429/503/504 mit
Backoff), dieselbe Backup-Queue und damit dieselbe Parallelität je Tenant.

**Wiederherstellung.** Im Explorer: Website wählen, „Bibliotheken" → Ordner → Dateien, „Listen" →
Elemente.

- Download als ZIP: jede Auswahl, auch Listenelemente als JSON und `site.json`.
- Dateien und Ordner in die ursprüngliche Bibliothek (Drive-ID aus dem Sicherungsstand, Pfad wie
  gesichert) oder in eine andere Bibliothek einer gesicherten Website derselben Quelle (Ziel
  `<Drive-ID>` oder `<Drive-ID>:/<Ordner>`; die Oberfläche bietet die Bibliotheken der neuesten
  Sicherungsstände an, die API lehnt andere ab). Werden mehrere Bibliotheken zusammen in eine andere
  wiederhergestellt, bekommt jede einen Ordner mit ihrem Namen. Modi: „Beide behalten"
  (umbenennen), „Überschreiben" (SharePoint behält die alte Datei als Version), „Vorhandene
  überspringen". Upload und Prüfung wie bei OneDrive (Upload-Session, Größe, SHA-256,
  QuickXorHash). Trägt der Ordner einer Bibliothek `carriedForward` (Graph hatte sie bei dieser
  Sicherung verweigert, sie hält die Dateien des letzten Laufs, der sie lesen konnte,
  `lastReadAt`), nennt das Ergebnis an der Bibliothek und an jeder daraus wiederhergestellten
  Datei, von wann ihr Stand ist; die Prüfung der Dateien bleibt dieselbe. Der Explorer zeigt an
  der Bibliothek „Bibliothek bei dieser Sicherung nicht lesbar“.
- Listenelemente nur in ihre ursprüngliche Liste, als **neue** Elemente (neue IDs; Erstellt/Geändert
  und Autoren setzt SharePoint). Geschrieben werden nur beschreibbare Felder: System-, schreibgeschützte,
  versteckte und berechnete Spalten bleiben weg (nach `_list.json`). „Überschreiben" setzt bei einem
  noch vorhandenen Element die gesicherten Werte, „Überspringen" lässt es stehen.
- „Überschreiben" ist nur für Websites erlaubt; Postfächer und OneDrives ersetzen weiterhin nie.
  Eine Website gehört keiner Person: Ihre Wiederherstellung gilt nicht als Wiederherstellung im
  Auftrag (kein Grund nötig), Websites sehen nur Wiederherstellungsoperatoren und Administratoren.

**Restore-Prüfung.** Die Stichprobe liest Dateien der Bibliotheken eines Sicherungsstands zurück
wie bei OneDrive (bis zu 20, Hash gegen Manifest); Listenelemente sind nicht Teil der Stichprobe.

**Benachrichtigungen.** Keine neuen Ereignisse: `backup.failed`, `backup.succeeded` und
`backup.overdue` gelten für Websites wie für Postfächer, mit der Website als Objekt.

**Lizenzzählung.** Websites zählen nicht als geschützte Postfächer (`countProtectedMailboxes`):
Wie das OneDrive ist eine Website über die Personen abgedeckt, die in ihr arbeiten (Modell je
Nutzer, wie bei anderen Microsoft-365-Sicherungsprodukten).

**Grenzen (bewusst nicht gesichert oder nicht wiederhergestellt):**

- Teams-Chats und Kanalnachrichten (siehe „Teams"; die Dateien eines Kanals liegen in der
  Bibliothek der Teams-Website und werden gesichert).
- Anhänge von Listenelementen: Graph v1.0 bietet dafür keine Schnittstelle; die SharePoint-REST-API
  bräuchte eine zweite Token-Zielgruppe und app-only ein Zertifikat. Nicht gesichert.
- Websitedesign, Designs/Themes, Navigation, Webparts außerhalb der Seitenbibliothek,
  Websitevorlage (Graph v1.0 nennt sie nicht), Inhaltstypen-Hub: nicht gesichert bzw. nur als
  Information.
- Berechtigungen (Freigaben, Stammordner-Freigaben der Bibliotheken) werden als Information
  gesichert, nie wiederhergestellt; Websitegruppen und Mitgliedschaften nicht (welche Personen
  Inhaber oder Mitglied einer Microsoft-365-Gruppe sind, kennt der Verzeichnisabgleich für den
  Explorer, siehe „Mitgliedschaften" unter „Gruppenpostfächer"; wiederhergestellt wird das nie).
- Workflows (SharePoint 2010/2013), Power Automate, Power Apps: nicht gesichert.
- SharePoint Server (on-premises): nicht unterstützt, nur SharePoint Online über Graph.
- Eine gelöschte Website oder Bibliothek wird nicht neu angelegt; wiederhergestellt wird in eine
  bestehende Bibliothek.
- Listenelemente werden nur in ihre ursprüngliche Liste wiederhergestellt; ein wiederholter
  Auftrag im Modus „Beide behalten" legt Elemente erneut an.
- Nicht gegen einen echten Tenant geprüft: Die Formen folgen der Graph-v1.0-Referenz, die Tests
  laufen gegen eine simulierte Graph-API (`packages/core/src/backup/sharepoint/testing.ts`).

## Gruppenpostfächer: Kalender und Unterhaltungen von Microsoft-365-Gruppen und Teams

Jede Microsoft-365-Gruppe (`groupTypes` enthält `Unified`; ein Team ist eine solche Gruppe mit
`resourceProvisioningOptions` = `Team`) hat ein Exchange-Gruppenpostfach mit **einem** Kalender und
den **Gruppenunterhaltungen**. Es ist ein eigenes geschütztes Objekt
(`protected_objects.kind = 'group'`, Migration `0065_group_mailboxes`, `external_id` = Objekt-ID
der Gruppe), keinem Nutzer zugeordnet. Sicherheits- und Verteilergruppen haben kein
Gruppenpostfach und werden übergangen. Die Dateien einer Gruppe bzw. eines Teams liegen in ihrer
SharePoint-Website (siehe oben), Kanalnachrichten von Teams nicht im Gruppenpostfach (siehe
„Teams"). Code: Graph-Ressourcen in `packages/core/src/graph/resources/groups.ts` und
`calendar.ts` (`MailboxOwner`), Erkennung in `packages/core/src/directory/group-mailboxes.ts`,
Sicherung in `packages/core/src/backup/groups`, Wiederherstellung in
`packages/core/src/restore/groups.ts` (über die Exchange-Wiederherstellung).

**Berechtigungen (keine neue).** Alles läuft mit den Anwendungsberechtigungen, die die App schon
immer verlangt; ein erneuter Admin-Consent ist **nicht** nötig:

| Aufruf (Graph v1.0) | Anwendungsberechtigung laut Referenz | bei Restow vorhanden über |
| --- | --- | --- |
| `GET /groups/delta`, `GET /groups/{id}` | `Group.Read.All` (u. a.) | `Group.Read.All` |
| `GET /groups/{id}/threads`, `…/threads/{id}/posts` | `Group-Conversation.Read.All` (geringste), `Group.Read.All` | `Group.Read.All` |
| `GET /groups/{id}/calendarView` | `Calendars.ReadBasic`/`Calendars.Read`/`Calendars.ReadWrite` | `Calendars.ReadWrite` |
| `GET /groups/{id}/events/{id}/instances` | `Calendars.ReadBasic`/`Calendars.Read` | `Calendars.ReadWrite` |
| `GET /groups/{id}/calendar/events`, `GET /groups/{id}/events/{id}` | laut Referenz **nur delegiert** | — (wird versucht, siehe unten) |
| `POST /groups/{id}/calendar/events` | laut Referenz **nur delegiert** | — (wird versucht, siehe unten) |
| `GET …/posts/{id}/attachments` | Anwendung: **nicht unterstützt** | — (`$expand=attachments` wird versucht) |
| `POST /groups/{id}/threads`, `…/reply` | Anwendung: **nicht unterstützt** | — (keine Wiederherstellung in die Gruppe) |

Die Referenz ist an diesen Stellen widersprüchlich (die Kalenderansicht der Gruppe nennt
Anwendungsberechtigungen, die Ereignisliste nicht). Restow versucht deshalb zuerst den direkten
Weg und fällt bei 401/403 (oder 400 „nicht unterstützt") zurück; eine Gruppe, deren Kalender Graph
der App ganz verweigert, ergibt **eine Warnung** („Der Gruppenkalender kann mit den Berechtigungen
der App nicht gelesen werden …") und die Unterhaltungen werden trotzdem gesichert. Eine Exchange
Application Access Policy, die Gruppenpostfächer ausschließt, wirkt genauso.

**Erkennung.** Die Verzeichnissynchronisierung liest neben `users/delta` einen zweiten
Delta-Strom, `groups/delta` (`$select` = id, displayName, description, mail, mailEnabled,
groupTypes, resourceProvisioningOptions; ohne Mitglieder). Der erste Lauf und jeder volle Abgleich
zählen alle Gruppen seitenweise auf, dazwischen kommen nur Änderungen und Löschungen; der
Delta-Link liegt in `sources.config.directory.groupsDeltaLink` und wird mit den Zeilen festgeschrieben.
Tausende Gruppen kosten damit wenige Seiten je Lauf. Eine gelöschte Gruppe (`@removed`) bzw. bei
voller Aufzählung eine nicht mehr genannte wird verwaist; ihre Sicherungsstände bleiben. Ohne
`Group.Read.All` meldet der Abgleich die Warnung `groups_unavailable` und lässt bekannte Gruppen
unverändert.

**Schutzumfang: Opt-in.** Die Regeln haben einen eigenen Modus für Gruppen
(`config.protection.groups`): `selected` (**Vorgabe**: keine Gruppe, außer eingeschlossenen) oder
`all` (alle Microsoft-365-Gruppen). Bewusst anders als bei Websites: Ein Tenant mit Tausenden
Gruppen soll nach dem Update nicht ungefragt alle sichern. Gruppen stecken in Mail-Jobs wie
Postfächer und Websites; ein Job mit Umfang „alle" umfasst alle **geschützten** (aktiven) Gruppen,
ein Job mit Umfang „ausgewählte" die gewählten. Wer Gruppen sichern will, schaltet in den
Schutzregeln „Alle Microsoft-365-Gruppen schützen" ein oder schließt einzelne Gruppen in der Liste
der geschützten Objekte ein; neu geschützte Gruppen bekommen sofort ihre erste Sicherung.

**Sicherung, ein Sicherungsstand je Gruppe** (Aufbau wie ein Postfach, damit Explorer,
Wiederherstellung, Download, Export, Restore-Prüfung und Aufbewahrung unverändert greifen):

| Pfad im Sicherungsstand | Inhalt |
| --- | --- |
| `calendar/Calendar/<Betreff>.<id>.json` | jedes Ereignis des Gruppenkalenders als Graph-JSON, Serienmaster mit den Ausnahmen im Fenster (ein Jahr zurück, zwei voraus) — derselbe Code wie für Nutzerkalender (`backup/exchange/calendar.ts`) |
| `mail/Conversations/<Thema>.<id>.eml` | jeder Beitrag (Post) jeder Unterhaltung als RFC-5322-Nachricht |

- Kalender: zuerst `/groups/{id}/calendar/events` (Einzeltermine und Serienmaster, wie bei
  Nutzern). Verweigert Graph das der App, liest Restow `/groups/{id}/calendarView` über **fünf
  Jahre zurück bis zwei Jahre voraus**, übernimmt Einzeltermine und liest je Serie ihren Master
  **einmal** über die `seriesMasterId` (`/groups/{id}/events/{id}`); die Ausnahmen kommen dann wie
  gewohnt über `/instances`. Ist auch der Master nicht lesbar, werden die Vorkommen der Serie im
  Fenster als Einzeltermine gesichert (Typ `occurrence`/`exception` in der Metadatenspalte), damit
  sie wenigstens als Termine wiederherstellbar sind. Ereignisse vor oder hinter dem Fenster sieht
  dieser Rückfallweg nicht: Bereits gesicherte bleiben dann so im Sicherungsstand, wie sie zuletzt
  gesichert wurden (auch wenn sie inzwischen gelöscht sind); entfernt wird nur ein gesicherter
  Termin, dessen Beginn im Fenster liegt und den die Ansicht nicht mehr nennt, ein Serienmaster
  nur, wenn sein ganzer Bereich im Fenster liegt und die Ansicht kein Vorkommen der Serie nennt.
  Jeder Lauf über den Rückfallweg endet mit der Warnung `graph.group_calendar_windowed` (mit dem
  Fenster), nie einfach grün. Kalender haben in v1.0 kein Delta: Jeder Lauf liest vollständig,
  unveränderte Ereignisse kosten über die Bytes nichts.
- Ereignisanhänge: anders als bei Nutzerkalendern nicht gesichert (`hasAttachments` steht in den
  Metadaten); Graph dokumentiert `…/events/{id}/attachments` für Gruppen nicht. Hat mindestens
  ein Termin des Gruppenkalenders Anhänge, endet der Lauf mit einer Warnung
  `graph.group_event_attachments_not_covered` (Anzahl der Termine), nie einfach grün.
- Unterhaltungen: `/groups/{id}/threads` vollständig je Lauf, Beiträge
  (`/threads/{id}/posts?$expand=attachments`) nur für Threads, deren `lastDeliveredDateTime` sich
  seit dem letzten Lauf bewegt hat (Zustand `conversationThreads` im Manifest), bei „Vollständig"
  für alle. Ein Beitrag mit gleicher ID und gleichem `changeKey` behält seine Bytes. Weggefallene
  Threads nehmen ihre Beiträge mit. Graph liefert keine MIME-Form von Beiträgen; Restow baut sie
  deterministisch (`From`, ggf. `Sender`, `To` = Gruppenadresse, `Cc` = vom Beitrag hinzugefügte
  Teilnehmer, `Subject`/`Thread-Topic` = Thema, `Date`, eine aus der Post-ID abgeleitete
  `Message-ID`, Text/HTML, Anhänge als MIME-Teile). Dateianhänge kommen mit `contentBytes` aus
  der Erweiterung oder, wenn Graph sie ohne liefert, über
  `/threads/{id}/posts/{id}/attachments/{id}/$value`; Elementanhänge (eine als Anlage
  weitergeleitete Mail, ein Termin) über dasselbe `/$value` als MIME und eingebettet als
  `message/rfc822`; Linkanhänge haben keinen Inhalt in Graph v1.0 und stehen namentlich in
  `referenceAttachments` (die Datei liegt in OneDrive oder SharePoint). Verweigert Graph die
  Erweiterung um Anhänge, werden die Beiträge ohne Anhänge gesichert und `missingAttachments`
  nennt das; ebenso jeder Anhang, dessen Abruf scheitert. Ein so gesicherter Beitrag trägt
  `attachmentsNotBackedUp: "true"` (`hasAttachments` bleibt, wie Graph es meldet), und jeder Lauf,
  dessen Sicherungsstand solche Beiträge hat, endet mit einer Warnung (Element
  `mail/Conversations`, mit der Anzahl): `graph.group_post_attachments_refused` bei verweigerter
  Erweiterung, `graph.group_post_attachments_unreadable` bei gescheitertem Abruf, nie einfach
  grün. Threads mit solchen Beiträgen werden erneut gelesen, solange Graph die Erweiterung nicht
  verweigert; gibt Graph die Anhänge später heraus, kommen sie dazu. Ein Beitrag ohne gesicherte
  Anhänge ist nach einem Restore in ein Postfach und im ZIP-Download „Nicht bestätigt“ mit dem
  Hinweis, welche Anhänge fehlen (`attachmentsNotBackedUpOf`,
  `packages/core/src/restore/conventions.ts`); der Restore-Explorer zeigt an ihm „Anhänge nicht
  gesichert“ (`MailSummary.attachmentsNotBackedUp`).
- Eine gelöschte Gruppe schlägt mit `graph.group_unavailable` fehl (die nächste Synchronisierung
  verwaist sie). Throttling wie bei Postfächern (derselbe Graph-Client, Parallelität über die
  Gruppen statt innerhalb einer).

**Mitgliedschaften (ab 0.5.0, #89).** Damit der Restore-Explorer bei einer Person ihre Teams
und Websites zeigen kann, liest die Verzeichnissynchronisierung nach dem Festschreiben der Gruppen
deren Inhaber und Mitglieder und legt sie in `directory_memberships` ab (Migration
`0074_directory_memberships`, Row Level Security wie jede Mandantentabelle; Code: Graph-Aufrufe in
`packages/core/src/graph/resources/groups.ts`, Lesen in `packages/core/src/directory/memberships.ts`,
Schreiben in `apps/worker/src/handlers/directory.ts` `writeMemberships`). Je Gruppe drei Aufrufe,
gebündelt per `$batch`, 50 Gruppen je Abschnitt. Geschrieben wird am Ende jedes Abschnitts und
zusätzlich, sobald die gelesenen Gruppen 20 000 Zeilen erreichen (`MEMBERSHIP_FLUSH_ROWS`; eine
Gruppe mit Website zählt doppelt), jeweils in einer eigenen Transaktion. Darin rechnet der Worker
den Unterschied zu den gespeicherten Zeilen aus und schickt Löschungen und Einfügungen in Scheiben
zu 5000 Zeilen (`MEMBERSHIP_WRITE_SLICE`); eine Gruppe „Alle Mitarbeitenden" mit Zehntausenden
Mitgliedern wird so zu mehreren begrenzten Anweisungen statt einem riesigen Parameter, und im
Speicher liegen höchstens die ersten Seiten eines Abschnitts plus die größte einzelne Gruppe:

| Aufruf (Graph v1.0) | Anwendungsberechtigung laut Referenz | bei Restow vorhanden über |
| --- | --- | --- |
| `GET /groups/{id}/owners?$select=id&$top=999` | `GroupMember.Read.All` (geringste), `Group.Read.All`, `Directory.Read.All` | `Group.Read.All` |
| `GET /groups/{id}/members?$select=id&$top=999` | `GroupMember.Read.All` (geringste), `Group.Read.All`, `Directory.Read.All` | `Group.Read.All` |
| `GET /groups/{id}/sites/root?$select=id` | `Sites.Read.All` | `Sites.ReadWrite.All` (optional, siehe oben) bzw. `Sites.Read.All` |

**Keine neue Berechtigung**, kein erneuter Admin-Consent. Mehr als 999 Einträge setzen auf dem
`@odata.nextLink` fort. Behalten werden nur Benutzer (`#microsoft.graph.user`; Geräte, Kontakte
und Dienstprinzipale nicht) und nur solche, die das Verzeichnis kennt (`users.entra_object_id`).
Wer als Inhaber und als Mitglied geführt wird, ist Inhaber. Die Website einer Gruppe bekommt
dieselben Zeilen wie die Gruppe. Eine Gruppe, die neu gelesen wird, ersetzt ihre Zeilen: Wer
ausgetreten ist, verliert seine Zeile, eine geänderte Rolle wird aktualisiert. Zeilen einer an der
Quelle gelöschten Gruppe oder Website bleiben wie zuletzt gelesen (wie ihre Sicherungsstände),
damit die Teams einer Person auch nach dem Löschen eines Teams wiederherstellbar bei ihr stehen;
sie gehen mit dem Objekt oder der Person.

- Wann: bei jedem vollen Abgleich (spätestens alle 24 Stunden) und beim ersten Lauf mit dieser
  Version alle Gruppen (`sources.config.directory.membershipsSyncedAt`), dazwischen die Gruppen,
  die der Delta-Strom meldet, und die, die ein früherer Lauf nicht abschließen konnte
  (`membershipsRetryIds`: verweigert, über die Wiederholungen hinaus gedrosselt, oder ihre Website
  war noch kein Objekt der Quelle, weil `getAllSites` die Website eines eben angelegten Teams
  noch nicht listet). Diese liest jeder folgende Lauf erneut, bis sie gelingen, nicht erst der
  nächste volle. Sind es mehr als 1000 (`MEMBERSHIP_RETRY_LIMIT`), merkt sich der Lauf sie nicht
  einzeln, sondern setzt `membershipsSyncedAt` zurück, und der nächste Lauf liest alle Gruppen.
  Eine geänderte Mitgliedschaft allein weckt `groups/delta` nicht (Mitglieder sind nicht
  ausgewählt), sie erscheint also mit dem nächsten vollen Abgleich.
- Throttling: derselbe Graph-Client (Retry-After plus Jitter); gedrosselte Antworten im `$batch`
  werden einzeln wiederholt. Bleibt eine Gruppe nach den Wiederholungen gedrosselt (429/5xx) oder
  verweigert Graph sie (403 ohne Zustimmung), behält sie ihre Zeilen, und der Abgleich meldet
  **eine** Warnung `memberships_unavailable` mit der Zahl der Gruppen („Inhaber und Mitglieder
  der Microsoft-365-Gruppen werden nicht gelesen: Der Tenant hat der App der Sicherung
  Group.Read.All nicht erteilt …" bei 401/403). Der Abgleich schlägt deshalb nie fehl, und die
  betroffenen Gruppen liest der nächste Lauf erneut. Verweigert Graph einen ganzen Abschnitt mit
  401/403 (die Berechtigung fehlt), fragt der Lauf die übrigen Gruppen nicht mehr an und lässt sie
  ebenso dem nächsten Lauf; ohne Zustimmung kostet ein Lauf so nur einen Abschnitt. Eine
  Gruppe, die inzwischen gelöscht ist (404), wird übergangen; der nächste Delta-Lauf verwaist sie.
- Vollständigkeit im Explorer: Solange eine nicht pausierte Microsoft-365-Quelle des Mandanten
  noch nie alle Gruppen gelesen hat oder Gruppen zum erneuten Lesen vormerkt, liefert die API
  `complete: false`, und der Bereich „Teams & Websites" sagt, dass die Liste unvollständig sein
  kann; eine leere Liste heißt dann ausdrücklich nicht „keine Mitgliedschaften".
  Verweigert Graph nur die Website (ohne `Sites.Read.All`), behält die Website ihre Zeilen.
- Kommunikationswebsites ohne Gruppe bekommen **keine** Zeilen: Graph v1.0 nennt ihre
  SharePoint-Gruppen (Besitzer, Mitglieder, Besucher) nicht; das ginge nur über die
  SharePoint-REST-API (`/_api/web/AssociatedOwnerGroup`), mit einer zweiten Token-Zielgruppe und
  app-only einem Zertifikat. Dasselbe gilt für Websitesammlungsadministratoren und für
  private und freigegebene Kanäle eines Teams (eigene Websites mit eigener Mitgliedschaft).
- Nicht gegen einen echten Tenant geprüft: Die Formen folgen der Graph-v1.0-Referenz, die Tests
  laufen gegen eine simulierte Graph-API (`packages/core/src/graph/testing/fake-memberships.ts`).

**Wiederherstellung.** Im Explorer steht die Gruppe im Abschnitt „SharePoint & Teams" (ein
Eintrag je Gruppe, Filter „Microsoft-365-Gruppen") mit den Bereichen **Gruppenkalender** und
**Unterhaltungen**.

- Download als ZIP: jede Auswahl (Beiträge als `.eml`, Ereignisse als `.json`).
- Export: Unterhaltungen als EML, MBOX oder PST wie Postfach-Mails (Kalender wird übersprungen
  und gezählt).
- In das Postfach eines Benutzers (Ziel „Anderes Konto", Adresse eines Postfachs derselben
  Quelle): Ereignisse in dessen Kalender (bei „Beide behalten" in einen Wiederherstellungskalender),
  Unterhaltungen als Mails in einen Ordner `Conversations` (bei „Beide behalten" unterhalb des
  Wiederherstellungsordners). Das ist der Weg, der sicher funktioniert.
- In die Gruppe selbst (Ziel „Ursprünglicher Ort"): nur Kalenderereignisse, in den einen
  Gruppenkalender (`POST /groups/{id}/calendar/events`; „Beide behalten" legt Kopien neben das
  Vorhandene, „Vorhandene überspringen" lässt Ereignisse mit gleicher `iCalUId` stehen; Teilnehmer
  werden nicht erneut eingeladen). Verweigert Graph das Schreiben der App (laut Referenz nur
  delegiert), scheitert jedes Ereignis mit der Antwort von Graph, und der Weg über ein
  Benutzerpostfach bleibt. Unterhaltungen **können nicht** in die Gruppe zurück: Graph v1.0 lässt
  eine App weder einen Thread anlegen noch antworten (nur delegiert). Jeder Beitrag erscheint im
  Bericht als „nicht wiederherstellbar" mit diesem Grund.
- Eine Gruppe gehört keiner Person: ihre Wiederherstellung gilt nicht als Wiederherstellung im
  Auftrag (kein Grund nötig); Gruppen sehen nur Wiederherstellungsoperatoren und Administratoren.
  „Überschreiben" gibt es nicht.

**Restore-Prüfung, Ransomware-Signale, Aufbewahrung.** Wie bei Postfächern: Die Stichprobe liest
Beiträge und Ereignisse zurück, die Signale der Microsoft-365-Läufe (Elemente und Bytes je Lauf)
gelten auch für Gruppen, die Aufbewahrung des Mail-Jobs gilt für ihre Sicherungsstände.

**Lizenzzählung.** Gruppenpostfächer zählen nicht als geschützte Postfächer
(`countProtectedMailboxes`), wie Websites.

**Am echten Tenant zu prüfen** (die Tests laufen gegen eine simulierte Graph-API,
`packages/core/src/backup/groups/testing/fake-group.ts`):

1. Liefert `/groups/{id}/calendar/events` mit Client-Credentials Ereignisse oder 403? Greift im
   zweiten Fall der Rückfall über `calendarView`, und liest `/groups/{id}/events/{id}` den Master?
2. Liefert `/groups/{id}/threads/{id}/posts?$expand=attachments` die Anhänge mit `contentBytes`
   oder 403/400?
3. Nimmt `POST /groups/{id}/calendar/events` mit Client-Credentials an?
4. Akzeptiert `groups/delta` `resourceProvisioningOptions` im `$select`?
5. Wirkt eine Application Access Policy auf Gruppenpostfächer (403 je Gruppe als Warnung)?

## Teams (nicht v1)

Kalender und Unterhaltungen der Microsoft-365-Gruppe hinter einem Team sichert Restow als
Gruppenpostfach (siehe oben), die Dateien über die Teams-Website. Nicht gesichert werden
Kanal- und Chatnachrichten:

- Nachrichten-Export nur über Protected APIs (`/teams/{id}/channels/{cid}/messages`
  mit `getAllMessages`, `/users/{id}/chats/getAllMessages`). Freischaltung per
  Microsoft-Formular je App und Tenant, Metered: Modell A (Sicherheit) 0,00075 USD je
  Nachricht bzw. Modell B; Abrechnung über Azure-Abo des Betreibers.
- Restore in bestehende Kanäle gibt es nicht; nur Migrations-Modus für neue Teams.
- Deshalb: Teams ausschließlich als Export mit Kostenhinweis; nie als Backup verkaufen.

## Journaling für das Archiv

- Exchange Online Journaling: Regel im Exchange Admin Center (Compliance) mit
  Journal-Empfänger extern (SMTP-Adresse bei Restow, z. B.
  `journal+<token>@archive.<domain>`). Voraussetzung: Undeliverable-Journal-
  Report-Adresse im Tenant gesetzt. Die Adresse zeigt Restow im Archiv (Abschnitt
  "Exchange-Journaling"); Schritte in `docs/ARCHIVE.md`.
- Journal-Report: Umschlag-Mail mit Text (Sender, Recipients, Message-Id) und dem
  Original als Anhang (message/rfc822). Restow parst beides, speichert Original plus
  Envelope-Metadaten (BCC-Empfänger sind nur im Envelope sichtbar).
- Journaling erfasst interne und externe Mails vor Zustellung; das ist die GoBD-Basis
  ("vollständig, zeitnah, unveränderbar").
- Absicherung des Empfängers: TLS Pflicht (ohne Zertifikat startet er nicht), je Mandant eine
  eigene Journal-Adresse mit zufälligem Token, einfaches Rate-Limit je Absender-IP, Größenlimit
  150 MB. Die Prüfung der Absender-Domänen (`*.protection.outlook.com`, SPF) ist Zielbild und in
  0.1.0 nicht umgesetzt.

## Archiv-Erfassung per Graph (Änderungsbenachrichtigungen)

Ab 0.4.4 (Business, Fähigkeit `archive.mailboxCapture`) archiviert Restow Microsoft-365-Postfächer
auch ohne Journaling: Graph meldet neue Mails, der Worker holt sie ab und legt sie ins Archiv.
Code: `packages/core/src/graph/resources/subscriptions.ts`, `packages/core/src/archive/graph-capture.ts`,
`apps/worker/src/archive-capture/graph.ts`, Hooks in `apps/api/src/features/archive-capture/hooks.ts`.

- **Keine neue Berechtigung.** Abonnements auf `users/{id}/messages` (changeType `created`) und das
  Abholen deckt `Mail.ReadWrite` (Application) ab, das die Sicherung ohnehin hat. Keine
  Ressourcendaten in Benachrichtigungen, also kein Verschlüsselungszertifikat.
- **Öffentliches HTTPS ist Pflicht.** Graph stellt nur an eine per HTTPS auf Port 443 erreichbare
  Adresse zu: `<öffentliche URL>/api/v1/hooks/graph/notifications` und `.../lifecycle`. Die
  öffentliche URL kommt aus Installation › Server & Betrieb, sonst aus `RESTOW_PUBLIC_URL`. Ohne
  `https://`, mit anderem Port, localhost oder privater Adresse legt Restow keine Abonnements an
  und fragt jedes Postfach alle `ARCHIVE_GRAPH_POLL_MINUTES` (15) per Delta ab (nur Abfrage); der
  Status nennt den Grund `graph.notification_url_unavailable`. Lehnt Graph ein Abonnement ab
  (Validierung der URL scheitert, 403), gilt für das Postfach dasselbe mit
  `graph.subscription_failed`; nach einer Stunde versucht Restow es erneut.
- **Validierung:** Beim Anlegen ruft Graph beide URLs mit `?validationToken=` auf; der Hook
  antwortet mit dem Token als `text/plain` (Graph wartet höchstens 10 s). Benachrichtigungen
  beantwortet er mit 202, nachdem er die Mail-ID als ausstehend vermerkt hat (Graph erwartet die
  Antwort in 3 s, sonst wiederholt und verwirft es später). Körper höchstens 1 MiB.
- **clientState:** je Abonnement 32 Zufallsbytes; gespeichert wird nur der SHA-256
  (`graph_subscriptions.client_state_hash`), verglichen zeitkonstant. Benachrichtigungen mit
  falschem oder fehlendem clientState oder unbekanntem Abonnement werden ignoriert (trotzdem 202).
  Eine Benachrichtigung trägt nie die Mail: der Worker holt sie mit eigenem Token bei Graph.
- **Unveränderliche IDs:** Anlegen, Delta, Auflistung und Metadaten senden
  `Prefer: IdType="ImmutableId"`. Eine verschobene Mail behält ihre ID und wird nicht doppelt
  erfasst. Die Sicherung nutzt weiter die normalen IDs (ihre Manifeste bleiben gültig); die
  Archiv-Erfassung hält eigenen Delta-Zustand je Ordner (`archive_capture_streams.state`), nie
  den der Sicherung.
- **Lebensdauer und Verlängerung:** angelegt mit 4230 Minuten, verlängert per `$batch` (PATCH
  `expirationDateTime`), sobald weniger als 24 h übrig sind. Anlegen und Verlängern aller
  Postfächer eines Microsoft-Tenants laufen gebündelt in `$batch` zu höchstens 20, höchstens
  ein Batch je Sekunde und Tenant. Grenze bei Microsoft: 1000 Abonnements je Postfach über alle
  Apps.
- **Lebenszyklus** (`lifecycleNotificationUrl`): `reauthorizationRequired` → `POST
  /subscriptions/{id}/reauthorize` (scheitert das, neues Abonnement); `subscriptionRemoved` →
  neues Abonnement und Nachholen; `missed` → Nachholen per Delta sofort.
- **App-Wechsel:** Ein Abonnement gehört der App, die es angelegt hat. Restow merkt sich den
  Fingerabdruck der App (Client-ID und Authority, nicht das Secret) und legt bei einer anderen
  App neu an; der Worker prüft die App der Installation alle fünf Minuten und macht bei einer
  Änderung alle Graph-Postfächer sofort fällig.
- **Abholen:** Metadaten per `$batch` (`id, internetMessageId, receivedDateTime, isDraft,
  parentFolderId`), Entwürfe übersprungen (eine gesendete Mail kommt als eigene Nachricht in
  Gesendete Elemente), was das Archiv für das Postfach schon hat, wird nicht geladen; dann MIME
  über `$value`. 404 heißt: inzwischen gelöscht oder verschoben, das Nachholen schaut nach.
  Mails über ~150 MB (kein MIME-Export) werden nicht archiviert und protokolliert.
- **Nachholen:** Delta über alle Ordner (versteckte eingeschlossen; ohne Suchordner, Entwürfe,
  Postausgang, Synchronisierungsprobleme) plus `recoverableitemsdeletions`, alle
  `ARCHIVE_GRAPH_CATCHUP_MINUTES` (360) mit Benachrichtigungen. 410 Gone → dieser Ordner wird neu
  aufgezählt, Unbekanntes erfasst. Fortschritt wird je Seite gesichert.
- **Recoverable Items:** Graph v1.0 kennt nur `recoverableitemsdeletions` als Well-known-Ordner.
  `Purges`, `Versions`, `DiscoveryHolds` sind über v1.0 nicht erreichbar. Was ein Benutzer
  endgültig löscht, bevor Restow es abholt (Sekunden bis Minuten mit Benachrichtigungen), kann
  fehlen; nur Journaling erfasst vor der Zustellung.
- **Übernahme:** Die vorhandenen Mails übernimmt einmalig ein `archive`-Job seitenweise (Cursor
  im Job, nach zwei Stunden fortgesetzt im nächsten Job); Mails, die vor dem Start der Erfassung
  eingingen, sind als `captured-late` markiert.

### Holds (Aufbewahrung im Tenant)

Restow fragt ab 0.4.4 je Microsoft-365-Quelle, ob ein Administrator bestätigt, dass gelöschte
Mails im Tenant durch einen Hold aufbewahrt werden (`PUT /archive/capture/holds/:sourceId`,
auditiert `archive.hold.confirmed`). `GET /archive/capture/holds` liefert dazu die lesenden
Prüfbefehle (`checks`, `apps/api/src/features/archive-capture/hold-checks.ts`):

```powershell
Connect-ExchangeOnline
Get-Mailbox -ResultSize Unlimited | Select-Object UserPrincipalName, LitigationHoldEnabled, LitigationHoldDuration, InPlaceHolds
Get-Mailbox -ResultSize Unlimited | Where-Object { -not $_.LitigationHoldEnabled -and $_.InPlaceHolds.Count -eq 0 } | Select-Object UserPrincipalName
Get-OrganizationConfig | Select-Object -ExpandProperty InPlaceHolds
Connect-IPPSSession
Get-RetentionCompliancePolicy -DistributionDetail | Where-Object { $_.ExchangeLocation } | Select-Object Name, Enabled, Mode, DistributionStatus, ExchangeLocation, ExchangeLocationException
Get-RetentionComplianceRule | Select-Object Policy, Name, RetentionDuration, RetentionComplianceAction
```

**Spike (0.4.4, zeitlich begrenzt): Holds per Graph v1.0 erkennen.** Ergebnis: nicht möglich,
der Zustand bleibt `unknown`/`confirmed` mit Bestätigung durch den Administrator.

- Litigation Hold (`LitigationHoldEnabled`), In-Place-Holds und Retention-Policies
  (`Get-RetentionCompliancePolicy`) haben keine Entsprechung in Graph v1.0; `user`,
  `mailboxSettings` und `mailFolder` tragen nichts davon; nach unserem Kenntnisstand gibt es dafür
  auch in `beta` keine
  Ressource.
- `security/labels/retentionLabels` (v1.0, Records Management) beschreibt Aufbewahrungs-
  *Bezeichnungen*, nicht die Richtlinien und nicht, welche Postfächer sie abdecken.
- `security/cases/ediscoveryCases/{id}/legalHolds` (v1.0, `ediscoveryHoldPolicy`) listet die Holds
  von eDiscovery-Fällen samt Postfach-Quellen. Laut Doku mit `eDiscovery.Read.All` auch als
  Application-Berechtigung (die Seite der Auflistung selbst wurde im Spike nicht abgerufen). Das
  deckt nur eDiscovery-Holds ab, nicht Litigation Hold und keine Retention-Policies, und
  bräuchte eine neue, weitreichende Berechtigung (Lesen aller eDiscovery-Fälle). Daher nicht
  umgesetzt; ein späteres `detected` könnte darauf aufbauen, nur als Ergänzung zur Bestätigung.
- Die Exchange-Online-PowerShell (oder die REST-Variante der Exchange Admin API) kann es, ist aber
  keine Graph-Schnittstelle; Restow führt sie nicht aus (siehe „Schnittstellen“), es zeigt nur die
  Befehle.

## Identität und Rollen

- Admin-Consent-Rückweg: der Parameter `tenant` ist unsigniert und nur eine Behauptung.
  Restow bindet eine Quelle erst nach einer bestätigenden OIDC-Anmeldung (Code-Flow gegen
  den behaupteten Tenant, delegierte Scopes `openid profile` an der Backup-App, keine
  Datenrechte) und nur, wenn das Konto Global Administrator oder Administrator für
  privilegierte Rollen ist (`wids` oder `transitiveMemberOf`). Details in
  docs/ENTRA-SETUP.md, Teil 4.
- Global Admin des Kundentenants = darf für alle Nutzer seines Tenants wiederherstellen.
  Restow prüft das beim SSO-Login über `directoryRoles` (Graph, delegiert) oder den
  `wids`-Claim im ID-Token (Rollen-Template-ID 62e90394-69f5-4237-9190-012177145e10).
- Endnutzer = `oid` des Tokens muss dem Besitzer des Postfachs/OneDrives entsprechen.
- Provider-Admin (Restow) ist Passkey-Nutzer, kein Entra-Login nötig.

## Kosten für Betreiber

- Graph-Aufrufe für Mail/OneDrive/SharePoint sind kostenlos. Teams-Export ist metered.
- Azure-App-Registrierung ist kostenlos; für Metered APIs braucht die App ein Azure-Abo.

## Warnungen: Läufe mit nicht gesicherten Elementen

Ein Lauf, der durchläuft, aber einzelne Elemente nicht sichern kann (zu große oder bei Microsoft
beschädigte Nachrichten, Throttling am Element, unvollständig gemeldete OneDrive-Dateien, eine
Nachricht, die der IMAP-Server nicht ausliefert, gesperrte Dateien auf einem Rechner), endet
`completed` mit Fehlschlägen (`partial` in History). Das ist eine **Warnung**: Das Objekt ist
gesichert, nur nicht vollständig. Ein Lauf, der ganz fehlschlägt, ist keine Warnung, sondern ein
Fehler (es gibt keinen neuen Sicherungsstand).

**Was gespeichert wird.** Jedes Element, das ein Lauf nicht verarbeiten kann, landet mit Pfad
(Ordner, Betreff bzw. Dateiname und Kurz-ID), Rohmeldung (HTTP-Status, Graph-Code, Text; nie
Inhalte oder Tokens), eingeordneter Ursache (`item_failures.failure`, Katalog in
`packages/core/src/failures`), Zahl der Läufe in Folge und, wo bekannt, dem Datum des Elements
(`item_failures.item_date`, Empfangszeit einer Nachricht) in `item_failures`. Je Lauf werden die
ersten 200 Elemente als Zeilen behalten (`MAX_ITEM_FAILURE_ROWS` in `apps/worker/src/progress.ts`);
alle Fehlschläge zählt `jobs.item_failure_summary` je Ursache, damit die Erklärung auch bei
Tausenden gedrosselter Elemente stimmt, ohne die Tabelle zu fluten (Migration
`0029_warning_acknowledgements`). Neue Ursachen dafür: `graph.item_incomplete` (OneDrive meldet ein
Element ohne Namen oder Ordner) und `imap.message_missing` (der Server liefert eine aufgeführte
Nachricht nicht aus); vorher landeten beide als „Ursache nicht erkannt".

**Wo man es sieht.** Bis 0.3.0 zeigten der Start (Kachel „mit fehlgeschlagenen Elementen") und
History (`partial`) eine Warnung, aber der Link führte zu den geschützten Objekten, wo das Postfach
als normal gesichert erschien, und die Lauf-Schublade zeigte für einen `partial`-Lauf keine Ursache
(nur die Seite des Laufs hatte die Elemente). Jetzt:

- Geschützte Objekte: Spalte „Letzte Sicherung" mit „Mit Warnungen" bzw. „Warnung bestätigt" und
  „Gründe ansehen".
- Seite `/warnings` (vom Start verlinkt): alle offenen und bestätigten Warnungen von Postfächern,
  OneDrives, IMAP-Konten und Rechnern; je Objekt ein Bereich mit den letzten Läufen, den
  Ursachen (was passiert ist, warum, was zu tun ist, technische Details mit Graph-Code und
  Rohmeldung) und den Elementen mit Ordner, Betreff, ID und Datum.
- Lauf-Schublade in History: die ersten nicht gesicherten Elemente mit Ursache und dem Weg zur
  Seite des Laufs.

**Bestätigen.** Wer sich eine Warnung angesehen hat und sie hinnimmt (die beschädigte Nachricht
bleibt beschädigt), bestätigt sie, einzeln oder für mehrere, mit optionaler Notiz
(`warning_acknowledgements`, eine Zeile je Objekt oder Rechner; `POST /api/v1/warnings/acknowledge`,
zurücknehmen mit `DELETE /api/v1/warnings/:kind/:id/acknowledgement`). Die Bestätigung gilt für die
**Ursachen** des Laufs, den man angesehen hat. Solange der neueste Lauf nur diese Ursachen hat und
seit der Bestätigung kein Lauf ganz fehlgeschlagen ist, zählt die Warnung nicht mehr: nicht in
`objects.withItemFailures` von `GET /api/v1/status` (und damit nicht auf dem Start, im
Provider-Dashboard und im RMM; neu ist `objects.acknowledgedWarnings`), nicht in der Spalte der
geschützten Objekte und nicht im Zustand „Aufmerksamkeit" eines Jobs mit Rechnern. Eine neue
Ursache oder ein ganz fehlgeschlagener Lauf dazwischen öffnet die Warnung wieder; die alte
Bestätigung bleibt als „gilt nicht mehr" sichtbar und kann erneuert werden. Bestätigen und
Zurücknehmen stehen im Audit-Log (`warning.acknowledged`, `warning.acknowledgement_revoked`, mit
Ursachen, Lauf, Zahl der Elemente und Notiz). Erlaubt für Administratoren des Mandanten und
Provider-Mitglieder ab Techniker; lesen dürfen alle Provider-Rollen.

**Entscheidungen.**

- Ein ganz fehlgeschlagener Lauf lässt sich nicht bestätigen und wird von keiner Bestätigung
  verdeckt: Er bleibt rot, bis wieder eine Sicherung gelingt. Eine Warnung sagt „unvollständig",
  ein Fehler „kein neuer Sicherungsstand"; das Zweite darf nie dauerhaft still werden.
- Die Bestätigung ändert keine Geschichte: Berichte und Statistik zählen fehlgeschlagene Elemente
  eines Zeitraums weiter (sie sind passiert), der Backup-Verlauf auf dem Start ebenso. Sie ändert
  auch keine Wiederherstellbarkeit: Ein Rechner, dessen neuester Sicherungsstand Dateien
  auslässt, bleibt in der Restore-Prüfung gelb.
- Alarme: Für Läufe mit Warnungen gibt es kein Ereignis (nur `job.failed` für Fehler); die
  Bestätigung unterdrückt daher keinen Alarm, und ein Fehler alarmiert wie bisher.

## Benachrichtigungs-Mail (Microsoft 365 und Google Workspace)

Die installationsweite Benachrichtigungs-Mail (Berichte, Warnungen, Einladungen;
Installation → Benachrichtigungs-Mail, Code in `apps/api/src/notify*.ts`) kennt drei
Transporte: SMTP, Microsoft 365 (Graph `sendMail` als Anwendung) und Google Workspace
(Gmail-API als Dienstkonto mit domainweiter Delegierung). Alle Zugangsdaten liegen
versiegelt im Secret-Store der Installation (`smtp_password`, `mail_graph_app`,
`mail_google_key`), werden nie zurückgegeben und nur ersetzt; ein Wechsel des Transports
löscht, was der neue nicht braucht. „Mail-Konfiguration entfernen" vernichtet alle drei.
Vor dem Speichern lässt sich mit den ungespeicherten Werten testen; jeder Fehlschlag kommt
als Grund-Code (`MAIL_FAILURE_REASONS` in `notify-core.ts`) zurück, den die Oberfläche in der
Sprache des Betreibers erklärt. Die technische Antwort steht nur darunter als Detail.

### Microsoft 365: eigene App-Registrierung (empfohlen)

Eine eigene Single-Tenant-App nur für Benachrichtigungen, getrennt von der Multi-Tenant-App
der Sicherung. Die App der Sicherung bleibt als Auswahl („App-Registrierung der Sicherung
verwenden"), wenn sie eingerichtet ist; sie braucht dann zusätzlich Mail.Send für alle
Postfächer ihres Tenants. Liegt das Absenderpostfach in einem Tenant, der der App der
Sicherung nie zugestimmt hat, antwortet Entra mit AADSTS700016; der Test meldet dann
`graph_backup_app_not_consented` statt `graph_app_not_found` und nennt beide Wege: eine eigene
App nur mit `Mail.Send` in diesem Tenant (empfohlen) oder die Administratorzustimmung für die
App der Sicherung dort, mit dem Link
`https://login.microsoftonline.com/<Tenant>/adminconsent?client_id=<Anwendungs-ID>` (Tenant
der Token-Anfrage). Diese Zustimmung erteilt der App der Sicherung in dem Tenant auch alle
ihre Sicherungsberechtigungen, und `Mail.Send` gilt dort für jedes Postfach.

1. Microsoft Entra Admin Center → Identität → Anwendungen → App-Registrierungen → Neue
   Registrierung. Unterstützte Kontotypen: „Nur Konten in diesem Organisationsverzeichnis".
   Keine Umleitungs-URI (Client Credentials brauchen keine).
2. API-Berechtigungen → Berechtigung hinzufügen → Microsoft Graph →
   Anwendungsberechtigungen → nur `Mail.Send`, dann „Administratorzustimmung erteilen".
   Keine delegierten Berechtigungen.
3. Zertifikate & Geheimnisse → Neuer geheimer Clientschlüssel: die Spalte **Wert** kopieren
   (nicht die Geheime ID; die Oberfläche lehnt eine GUID im Schlüsselfeld als `secretIsId`
   ab). Höchstens 24 Monate gültig, Ablaufdatum notieren. Alternativ ein Zertifikat
   hochladen und in Restow privaten Schlüssel plus Zertifikat (PEM) einfügen.
4. In Restow: Verzeichnis-ID (GUID), Anwendungs-ID, Schlüssel oder Zertifikat und das
   Absenderpostfach eintragen, Testnachricht senden, speichern. Ein gespeicherter Schlüssel
   wird nur für denselben Tenant, dieselbe Anwendungs-ID und dieselbe Art von Zugangsdaten
   weiterverwendet.

**Auf das Absenderpostfach beschränken (dringend empfohlen).** `Mail.Send` als
Anwendungsberechtigung erlaubt sonst das Senden als jedes Postfach des Tenants. Empfohlen ist
RBAC für Anwendungen in Exchange Online (die Oberfläche setzt Anwendungs-ID und Absender in
die Befehle ein und bietet sie zum Kopieren an):

```powershell
Connect-ExchangeOnline
New-ServicePrincipal -AppId '<Anwendungs-ID>' -ObjectId '<Objekt-ID der Unternehmensanwendung>' -DisplayName 'Notification mail sender'
New-ManagementScope -Name 'Notification mail sender' -RecipientRestrictionFilter "PrimarySmtpAddress -eq 'alerts@contoso.com'"
New-ManagementRoleAssignment -App '<Anwendungs-ID>' -Role 'Application Mail.Send' -CustomResourceScope 'Notification mail sender'
Test-ServicePrincipalAuthorization -Identity '<Anwendungs-ID>' -Resource 'alerts@contoso.com'
```

Danach die in Entra erteilte `Mail.Send`-Zustimmung wieder entfernen: Berechtigungen aus
Entra gelten zusätzlich zur Rollenzuweisung und würden die Beschränkung aufheben. Die
ältere Alternative ist eine Application Access Policy auf eine E-Mail-aktivierte
Sicherheitsgruppe, die nur das Absenderpostfach enthält (die Entra-Berechtigung bleibt):

```powershell
New-ApplicationAccessPolicy -AppId '<Anwendungs-ID>' -PolicyScopeGroupId '<Gruppe>' -AccessRight RestrictAccess -Description 'Notification mail sender'
Test-ApplicationAccessPolicy -Identity 'alerts@contoso.com' -AppId '<Anwendungs-ID>'
```

Beides kann bis zu einer Stunde dauern, bis es wirkt.

Fehlerbilder und ihre Gründe (`notify-graph.ts`):

| Antwort | Grund-Code | Bedeutung |
| --- | --- | --- |
| AADSTS7000215 | `graph_secret_invalid` | Falscher Schlüssel, meist die Geheime ID statt des Werts |
| AADSTS7000222 | `graph_secret_expired` | Schlüssel abgelaufen |
| AADSTS700027/700024 | `graph_certificate_invalid` | Zertifikat nicht (dieses) in der App hinterlegt |
| AADSTS700016 (eigene App)/7000112 | `graph_app_not_found` | Anwendungs-ID nicht im Tenant oder App deaktiviert |
| AADSTS700016 mit der App der Sicherung | `graph_backup_app_not_consented` | Der Tenant des Absenders hat der App der Sicherung nicht zugestimmt; der Test liefert den Link zur Administratorzustimmung mit |
| AADSTS90002/900023 | `graph_tenant_not_found` | Verzeichnis-ID falsch |
| Graph 403 | `graph_send_denied` | Mail.Send oder Admin-Consent fehlt, oder RBAC/Access Policy schließt den Absender aus |
| Graph 404, `ErrorInvalidUser`, `MailboxNotEnabledForRESTAPI` | `graph_sender_not_found` | Absender existiert nicht oder hat kein Exchange-Online-Postfach |

### Google Workspace: Dienstkonto mit domainweiter Delegierung

Restow signiert das JWT des Dienstkontos selbst (RS256, `node:crypto`, RFC 7523) und holt
bei `https://oauth2.googleapis.com/token` ein Token nur für den Bereich
`https://www.googleapis.com/auth/gmail.send` im Namen des Absenders; die Nachricht baut
nodemailers MIME-Composer, sie geht base64url-kodiert an `users.messages.send` der
Gmail-API. Keine Google-Bibliothek, kein SMTP-Ausgang. Token-Endpunkt und API-Host sind fest;
der `token_uri` einer hochgeladenen Schlüsseldatei wird ignoriert.

1. Google Cloud Console: Projekt wählen oder anlegen, APIs & Dienste → Bibliothek →
   Gmail API → Aktivieren.
2. IAM & Verwaltung → Dienstkonten → Dienstkonto erstellen (keine Projektrollen nötig) →
   Schlüssel → Schlüssel hinzufügen → Neuen Schlüssel erstellen → JSON. Blockiert die
   Organisationsrichtlinie `iam.disableServiceAccountKeyCreation` das, braucht das Projekt
   eine Ausnahme. Die Datei nach dem Einfügen löschen: sie ist ein Zugang zu jedem Postfach,
   für das die Delegierung gilt.
3. Google Admin-Konsole (Super Admin): Sicherheit → Zugriffs- und Datenverwaltung →
   API-Steuerung → Domainweite Delegierung verwalten → Neu hinzufügen. Client-ID = das Feld
   `client_id` der JSON-Datei (die Oberfläche zeigt es zum Kopieren, sobald der Schlüssel
   eingefügt oder gespeichert ist), OAuth-Bereich nur
   `https://www.googleapis.com/auth/gmail.send`. Wirkt nach Minuten, selten bis zu 24 Stunden.
4. In Restow: Absenderpostfach (ein Benutzer der Domain mit Gmail, keine Gruppe und kein
   Alias) und den Schlüssel eintragen, testen, speichern. Ohne neuen Schlüssel bleibt der
   gespeicherte, solange der Transport Google bleibt.

Fehlerbilder (`notify-google.ts`): `unauthorized_client` → `google_delegation_missing`
(Delegierung fehlt oder ohne `gmail.send`), `invalid_grant` „Invalid email or User ID" →
`google_sender_not_found`, `invalid_grant` „Invalid JWT Signature" / `invalid_client` →
`google_key_invalid` (Schlüssel oder Dienstkonto gelöscht/deaktiviert), Gmail-API 403 mit
`SERVICE_DISABLED`/`accessNotConfigured` → `google_api_disabled`, sonstige 403 →
`google_send_denied`.

### Warum kein OAuth mit Benutzeranmeldung (delegiert)

Ein delegierter Login (Authorization Code mit Refresh-Token eines Postfach-Benutzers) wurde
bewertet und bewusst nicht gebaut. App-only ist der empfohlene Weg:

- Der Refresh-Token hängt an einer Person: Passwortwechsel, MFA- oder
  Conditional-Access-Änderungen, Kontosperre oder Austritt widerrufen ihn, und die
  Benachrichtigungen fallen still aus, genau wenn niemand hinsieht.
- Er braucht eine Umleitungs-URI unter der öffentlichen URL. Installationen im lokalen
  Betriebsmodus (ohne öffentliche URL) könnten ihn nicht nutzen.
- Google: `gmail.send` ist ein sensibler Bereich. Eine nicht verifizierte externe App im
  Status „Testing" bekommt Refresh-Tokens, die nach 7 Tagen ablaufen; die Verifizierung
  müsste jeder Betreiber selbst durchlaufen. Workspace-intern ginge es, aber nur mit einer
  eigenen OAuth-App je Installation.
- Microsoft: delegiertes `Mail.Send` plus `offline_access` braucht ebenfalls eine eigene
  App-Registrierung; gewonnen wäre gegenüber app-only nur, dass die App ohne
  Exchange-Beschränkung nur als dieser eine Benutzer senden kann. Dasselbe erreicht die
  RBAC-Beschränkung oben, ohne Personenbindung.
- Rotation, Widerruf und das Erkennen eines toten Tokens wären zusätzlicher Zustand, den
  Restow pflegen und anzeigen müsste.

Wer keine App-Registrierung oder kein Dienstkonto anlegen darf, nutzt SMTP (bei Microsoft
365 etwa einen SMTP-Relay-Connector, bei Google den SMTP-Relay-Dienst von Workspace).

### Konfiguration über die Umgebung

Neue Umgebungsvariablen gibt es dafür nicht: Schlüssel, Zertifikate und Dienstkonto-Schlüssel
gehören versiegelt in den Secret-Store, nicht in eine `.env`. Wie bisher liefert
`GRAPH_MAIL_TENANT_ID` den Tenant, wenn Microsoft 365 über die App der Sicherung sendet und
keiner eingetragen ist. Die Einstellungen der Oberfläche gelten vor der Umgebung.

### Einrichtungs-Assistent

Der Assistent bietet SMTP immer und Microsoft 365 über die App der Sicherung nur, wenn diese
schon nutzbar ist (`GET /setup/state` → `mailOptions.graphBackupApp`). Eigene
App-Registrierung und Google Workspace richtet der Betreiber nach der Einrichtung unter
Installation → Benachrichtigungs-Mail ein, wo Anleitung und Testversand vor dem Speichern
liegen. Die Testnachricht am Ende des Assistenten liefert `testSend.reason`; der Assistent
zeigt den übersetzten Grund, nie die rohe Serverantwort.

## Dinge, die immer wieder schiefgehen

- Consent gegeben, aber `Mail.Read` statt `Mail.ReadWrite`: Backup läuft, Restore
  scheitert mit 403. Beim Verbinden alle Rechte prüfen und anzeigen.
- Delta-Token ungültig (410 Gone) nach längerer Pause oder Ordner-Änderung: vollen
  Neuabgleich für diesen Ordner, nicht für das ganze Postfach.
- `lastModifiedDateTime` ändert sich bei Flag-Änderung; MIME nicht neu laden, nur
  Metadaten. Ob sich doch der Inhalt geändert hat, sagt die Nachrichtengröße (siehe „Wann der
  Inhalt neu geladen wird“ oben), nicht `changeKey`.
- Zeitzonen: Graph liefert UTC; Anzeige in Nutzerzeitzone (MailboxSettings).
- Große Tenants: `users` mit `$filter=accountEnabled eq true` reicht nicht (geteilte
  Postfächer sind disabled). Schutzregeln, nicht Filter.
- `$batch` mit doppelten Request-IDs: Graph lehnt den ganzen Batch mit 400 ab („Request Id ... has
  to be unique in a batch“). Bis 0.3.1 nutzte der Ordnerbaum der Postfächer Ordner-IDs als
  Request-IDs, und Graph listet beim Blättern denselben Ordner manchmal zweimal (behoben in
  0f67c28, 0.3.2; ein Fehler mit diesem Text vom 10.10.2026 stammt von einem älteren Build). Seitdem
  vergibt `FetchGraphClient.batch` eigene IDs (die Position) und gibt dem Aufrufer seine zurück;
  ab 0.4.7 schickt er außerdem eine identische Leseanfrage (Methode, URL, Header, ohne Body) nur
  einmal und gibt die Antwort jedem Aufrufer, auch in den Wiederholungen nach 429 und nach einem
  neuen Token (401/403). Schreibende Anfragen (POST/PATCH der Abonnements) werden nie
  zusammengelegt.
