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
  Group.Read.All liest auch die Microsoft-365-Gruppen und ihre Unterhaltungen, siehe
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
- Große Anhänge (>4 MB) kommen im MIME mit; `$value` kann für sehr große Mails
  (>150 MB) fehlschlagen; Fallback: Anhänge einzeln über `/attachments/{id}/$value`.
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
- Kalender im Restore-Explorer (ab 0.4.2): Ein Kalender listet seine Termine nach Beginn
  (neueste zuerst oder anstehende zuerst), mit Wann, Ort und Organisator, nicht nach Betreff.
  Eine Serie steht einmal in der Liste und klappt ihre Termine auf; die Monatsansicht zeigt
  alle Kalender eines Postfachs (oder einen) Tag für Tag. Die Termine einer Serie berechnet
  die API (`GET /snapshots/:id/calendar`, auditiert als `snapshot.calendar.read`) aus dem
  gesicherten Muster und setzt die gesicherten Ausnahmen an ihre Stelle; die Uhrzeit folgt der
  Zeitzone der Serie über Sommer- und Winterzeit. Ein einzeln gelöschter Termin einer Serie ist
  im Backup nicht vermerkt (Graph v1.0 nennt keine abgesagten Vorkommen) und erscheint daher
  noch, so wie ihn eine Wiederherstellung der Serie auch wieder anlegt.
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
- Freigaben/Berechtigungen werden als Information gesichert, nicht wiederhergestellt
  (v1).
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
| `site.json` | Titel, URL, Beschreibung, Websitesammlung, `sharepointIds`; je Bibliothek Name, Drive-ID und die Freigaben ihres Stammordners (`/drives/{id}/root/permissions`); je Liste Name, Vorlage, Elementzahl |
| `Libraries/<Bibliothek>/…` | jede Dokumentbibliothek (`/sites/{id}/drives`, auch „Websiteseiten" mit den Seiten und „Websiteobjekte") über den Drive-Lauf der OneDrive-Engine: Delta mit Token je Bibliothek, Elemente nach ID, gestreamte Downloads, optionale Versionen (`<Datei>:versions/<id>`), Wiederholung, 410-Neuaufzählung, Prüfpunkte, Freigabe-Facette je Element als Information |
| `Lists/<Liste>/_list.json` | Liste und Spalten (`/lists/{id}/columns`) |
| `Lists/<Liste>/<Titel> (<id>).json` | je Listenelement alle Feldwerte (`/lists/{id}/items?expand=fields`), dazu Inhaltstyp, Autor, Daten |

Bibliotheken setzen bei der nächsten Sicherung an ihrem Delta-Link fort (`state.libraries[]`);
eine Wiederholung nach Abbruch läuft Bibliotheken, die schon fertig waren, nicht erneut ab. Listen
haben kein Delta: Sie werden je Lauf vollständig gelesen (die Feldwerte kommen mit der Auflistung,
200 je Seite), ein unverändertes Element (gleiches eTag) übernimmt seine gespeicherten Bytes, den
Rest dedupliziert der Pack-Speicher. Versteckte Listen (Systemlisten) und Bibliotheken als Listen
werden übergangen. Eine Bibliothek oder Liste, die Graph verweigert (403/404/423), wird als
fehlgeschlagenes Element gemeldet und behält ihre letzte Kopie (Liste: als `stale` markiert); der
Rest der Website wird gesichert. Eine gelöschte Website schlägt mit `graph.site_unavailable` fehl.
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
  QuickXorHash).
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
  gesichert, nie wiederhergestellt; Websitegruppen und Mitgliedschaften nicht.
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
  sie wenigstens als Termine wiederherstellbar sind. Ereignisse vor dem Fenster sieht dieser
  Rückfallweg nicht. Kalender haben in v1.0 kein Delta: Jeder Lauf liest vollständig, unveränderte
  Ereignisse kosten über die Bytes nichts.
- Ereignisanhänge: wie bei Nutzerkalendern nicht gesichert (`hasAttachments` steht in den
  Metadaten); Graph dokumentiert `…/events/{id}/attachments` für Gruppen nicht.
- Unterhaltungen: `/groups/{id}/threads` vollständig je Lauf, Beiträge
  (`/threads/{id}/posts?$expand=attachments`) nur für Threads, deren `lastDeliveredDateTime` sich
  seit dem letzten Lauf bewegt hat (Zustand `conversationThreads` im Manifest), bei „Vollständig"
  für alle. Ein Beitrag mit gleicher ID und gleichem `changeKey` behält seine Bytes. Weggefallene
  Threads nehmen ihre Beiträge mit. Graph liefert keine MIME-Form von Beiträgen; Restow baut sie
  deterministisch (`From`, ggf. `Sender`, `To` = Gruppenadresse, `Cc` = vom Beitrag hinzugefügte
  Teilnehmer, `Subject`/`Thread-Topic` = Thema, `Date`, eine aus der Post-ID abgeleitete
  `Message-ID`, Text/HTML, Dateianhänge als MIME-Teile). Verweigert Graph die Erweiterung um
  Anhänge, werden die Beiträge ohne Anhänge gesichert und `missingAttachments` nennt das;
  Link- und Elementanhänge werden namentlich vermerkt.
- Eine gelöschte Gruppe schlägt mit `graph.group_unavailable` fehl (die nächste Synchronisierung
  verwaist sie). Throttling wie bei Postfächern (derselbe Graph-Client, Parallelität über die
  Gruppen statt innerhalb einer).

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
  Metadaten.
- Zeitzonen: Graph liefert UTC; Anzeige in Nutzerzeitzone (MailboxSettings).
- Große Tenants: `users` mit `$filter=accountEnabled eq true` reicht nicht (geteilte
  Postfächer sind disabled). Schutzregeln, nicht Filter.
