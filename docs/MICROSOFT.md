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
- Sites.ReadWrite.All (erst mit SharePoint)
- User.Read.All, Group.Read.All, Directory.Read.All (Verzeichnis-Sync, Schutzregeln)
- Organization.Read.All (Tenant-Name, Lizenzen)
- Mail.Send (optional, nur wenn Benachrichtigungen über Graph statt SMTP verschickt
  werden; sendet als konfiguriertes Absenderpostfach über `/users/{id}/sendMail`, per
  Application Access Policy auf dieses Postfach beschränkbar)

Endnutzer-SSO (Self-Service-Restore) läuft getrennt als delegierter OIDC-Login
(openid, profile, email) über better-auth; der Nutzer sieht nur, was sein `oid`
im Backup besitzt.

Client-Secret-Rotation: Secrets laufen maximal 24 Monate; Restow warnt 60 Tage vorher.
Besser: Zertifikat statt Secret (msal-node unterstützt beides).

## Application Access Policies

Ein App-Consent gewährt Zugriff auf alle Postfächer des Tenants. Kunden, die den
Umfang einschränken wollen, nutzen Exchange `New-ApplicationAccessPolicy` mit einer
Gruppe. Restow muss damit umgehen (403 für ausgeschlossene Postfächer als "nicht im
Schutzumfang" anzeigen, nicht als Fehler).

## Throttling (der Grund, warum alle Tools langsam sind)

- Limits gelten je App je Tenant und zusätzlich je Postfach. Outlook-Ressourcen:
  Richtwert 10.000 Anfragen pro 10 Minuten je App je Postfach und 4 gleichzeitige
  Anfragen je Postfach. OneDrive/SharePoint: eigene Limits je Tenant, abhängig von
  Lizenzzahl.
- Antwort 429 mit `Retry-After` ist normal, kein Fehler. Immer respektieren, Jitter
  dazu, kein Hammering. 503/504 mit Backoff wiederholen.
- Strategie: Parallelität über Postfächer, nicht innerhalb eines Postfachs; Delta-
  Queries; `$select` minimal; Batch-Requests (max. 20 je Batch, teilen sich Limits).
- Erstsicherung großer Tenants dauert Tage. Das ist so und wird in der UI so gesagt
  (Restlaufzeit-Schätzung, Fortschritt je Postfach).

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
- Große Anhänge (>4 MB) kommen im MIME mit; `$value` kann für sehr große Mails
  (>150 MB) fehlschlagen; Fallback: Anhänge einzeln über `/attachments/{id}/$value`.
- Kalender: `/users/{id}/calendars` und `/events` (Serientermine als Master plus
  Ausnahmen; `calendarView` nur für Ansicht, nicht für Backup). Kontakte:
  `/contactFolders` und `/contacts`. Beides als JSON mit Graph-Schema sichern.
- Archivpostfach (In-Place Archive): über Graph nur eingeschränkt erreichbar
  (`/users/{id}/mailFolders` liefert das primäre Postfach). Dokumentieren, in v1 nicht
  versprechen.
- Geteilte Postfächer und Ressourcen: normale Nutzerobjekte ohne Lizenz; Schutzregel
  muss sie einschließen können.
- Gelöschte Nutzer: Graph `directory/deletedItems/microsoft.graph.user` 30 Tage; das
  Backup behält Snapshots unabhängig davon (Retention regelt das, nicht Entra).

## Exchange: Wiederherstellen

- Nachricht aus MIME anlegen: `POST /users/{id}/mailFolders/{fid}/messages` mit
  `Content-Type: text/plain` und Base64-kodiertem MIME. Ergebnis ist ein neues Objekt
  (neue ID, `isDraft=false` wenn Header vollständig). Datum bleibt erhalten, Flags/
  Kategorien danach per PATCH setzen.
- Zielordner: Original-Pfad nachbauen oder "Wiederhergestellt <Datum>"-Ordner; beides
  anbieten. Duplikate vermeiden: vor Import per `internetMessageId` prüfen.
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
  rename/replace wählbar. mtime setzen über `fileSystemInfo`.
- Freigaben/Berechtigungen werden als Information gesichert, nicht wiederhergestellt
  (v1).
- Papierkorb: Elemente im OneDrive-Papierkorb sind über delta nicht erreichbar; ist ok,
  Restow hat sie im letzten Snapshot.

## Teams (nicht v1)

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

- Graph-Aufrufe für Mail/OneDrive sind kostenlos. Teams-Export ist metered.
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

## Dinge, die immer wieder schiefgehen

- Consent gegeben, aber `Mail.Read` statt `Mail.ReadWrite`: Backup läuft, Restore
  scheitert mit 403. Beim Verbinden alle Rechte prüfen und anzeigen.
- Delta-Token ungültig (410 Gone) nach längerer Pause oder Ordner-Änderung: vollen
  Neuabgleich für diesen Ordner, nicht für das ganze Postfach.
- `lastModifiedDateTime` ändert sich bei Flag-Änderung; MIME nicht neu laden, nur
  Metadaten.
- Zeitzonen: Graph liefert UTC; Anzeige in Nutzerzeitzone (MailboxSettings).
- Große Tenants: `users` mit `$filter=accountEnabled eq true` reicht nicht (geteilte
  Postfächer sind disabled). Schutzregeln, nicht Filter.
