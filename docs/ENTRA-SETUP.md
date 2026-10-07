# Entra ID — App-Registrierung und Admin-Consent

Diese Anleitung richtet sich an den Betreiber (Provider-Admin), der Restow einmal
einrichtet, und an Kunden-Admins, die ihren Tenant verbinden. Sie erklärt Schritt für
Schritt die beiden benötigten App-Registrierungen, die exakten Berechtigungen, den
Unterschied Secret gegen Zertifikat, den Admin-Consent-Link für Kunden und woher die
Redirect-URIs kommen. Pflichtlektüre vorab: `docs/MICROSOFT.md` (Fakten, Grenzen,
Fallstricke). Stand: Version 0.1.0. Bei Zweifel gegen den Dev-Tenant testen, nicht raten.
Ehrlicher Hinweis: Restow 0.1.0 ist noch nie gegen einen echten Microsoft-365-Tenant gelaufen
(nur gegen eine simulierte Graph-API); die Schritte folgen der Microsoft-Dokumentation und
dem Code. Rechne bei der ersten echten Einrichtung mit Abweichungen und melde sie.

## Zwei getrennte Apps, ein Prinzip

Restow braucht **zwei** App-Registrierungen im Entra-Tenant des Betreibers (bei IT
Systeme Flores bzw. beim jeweiligen Service Provider). Beide werden **einmal** angelegt
und für alle Mandanten wiederverwendet:

1. **Backup-App** (Anwendungsberechtigungen, Client Credentials, Multi-Tenant). Sie
   sichert und restauriert Postfächer und OneDrives. Kunden erteilen ihr Admin-Consent
   per Link; danach holt Restow je Kunden-Tenant ein App-Token. Kein Nutzer ist an
   diesem Fluss beteiligt. → In der Weboberfläche unter **Installation → Microsoft-Multi-Tenant-App**
   (verschlüsselt gespeichert) oder alternativ per `.env`: `ENTRA_CLIENT_ID`,
   `ENTRA_CLIENT_SECRET` oder `ENTRA_CLIENT_CERT_PATH`. Die Umgebung hat Vorrang.
2. **SSO-App** (delegierte Berechtigungen, OIDC, Multi-Tenant `common`, Edition Business
   und Service Provider; **in 0.1.0 nicht nutzbar**, siehe Teil 5). Sie ermöglicht die Anmeldung mit Microsoft für Personen, deren
   Restow-Konto bereits mit ihrem Microsoft-Konto verknüpft ist; über diese Anmeldung legt
   Restow nie ein Konto an. Wer sich anmeldet, sieht im Self-Service-Restore nur das eigene
   Postfach und OneDrive (Zuordnung über die E-Mail-Adresse). → `.env`: `ENTRA_SSO_CLIENT_ID`,
   `ENTRA_SSO_CLIENT_SECRET`.

Warum getrennt: Die Backup-App braucht weitreichende Anwendungsberechtigungen ohne
angemeldeten Nutzer, die SSO-App braucht nur eine Identität und keine Datenrechte. Eine
Vermischung würde entweder dem Login zu viel Macht geben oder den Backup-Token an eine
Nutzersitzung binden. Getrennte Apps halten beide Pfade klein und prüfbar.

## Teil 1 — Backup-App registrieren

Im Entra Admin Center (entra.microsoft.com) oder Azure-Portal unter
**Identität → Anwendungen → App-Registrierungen → Neue Registrierung**:

1. **Name**: z. B. `Restow` (frei wählbar, für Kunden sichtbar beim Consent —
   sprechend benennen).
2. **Unterstützte Kontotypen**: „Konten in einem beliebigen Organisationsverzeichnis
   (beliebiges Microsoft-Entra-ID-Verzeichnis – mandantenübergreifend)". Das ist die
   Multi-Tenant-Option und Voraussetzung dafür, dass fremde Kunden-Tenants zustimmen
   können. **Nicht** „Nur dieses Verzeichnis".
3. **Umleitungs-URI**: für die reine Client-Credentials-Nutzung nicht nötig. Sie wird
   aber für den **Admin-Consent-Rückweg** gebraucht (siehe Teil 3). Typ „Web", Wert aus
   Teil 4. Dieselbe URI dient auch der bestätigenden Anmeldung nach dem Consent; eine
   zweite URI ist nicht nötig.
4. Registrieren. Danach **Anwendungs-(Client-)ID** und **Verzeichnis-(Mandanten-)ID**
   notieren. Beide trägt der Provider-Admin in Restow unter **Installation → Microsoft-Multi-Tenant-App** ein (Schritt 4 der dortigen Anleitung); die Verzeichnis-ID dient dem
   Verbindungstest. Alternativ gehört die Client-ID in `ENTRA_CLIENT_ID`.

**Eintragen in der Weboberfläche.** Die Seite **Installation → Microsoft-Multi-Tenant-App** führt
durch Teil 1 bis 3 (mit dem exakten Umleitungs-URI zum Kopieren, der Berechtigungsliste
und dem OpenSSL-Befehl) und nimmt Client-ID, Verzeichnis-ID und Zugangsdaten entgegen.
Client-Secret bzw. privater Schlüssel werden nur verschlüsselt in der Datenbank abgelegt
(Tabelle `secrets`, Schlüssel abgeleitet aus `RESTOW_MASTER_KEY`), nie wieder angezeigt
und nie protokolliert; das Audit-Log vermerkt nur, *dass* sie geändert wurden. Änderungen
gelten ohne Neustart (API sofort, Worker innerhalb von 30 Sekunden). „Verbindung testen“
holt ein Graph-Token im eigenen Verzeichnis und vergleicht die erteilten
Anwendungsberechtigungen mit Teil 2. Sind `ENTRA_CLIENT_ID` und `ENTRA_CLIENT_SECRET`
bzw. `ENTRA_CLIENT_CERT_PATH` in der Umgebung gesetzt, haben sie **Vorrang**: Die Seite
zeigt die Werte dann nur an („aus der Server-Umgebung“) und nimmt keine Änderungen an.

## Teil 2 — Anwendungsberechtigungen (Application permissions)

Unter **API-Berechtigungen → Berechtigung hinzufügen → Microsoft Graph →
Anwendungsberechtigungen** exakt diese Rechte setzen. Alle sind vom Typ *Application*
(nicht delegiert); für alle ist am Ende Admin-Consent nötig.

| Berechtigung | Wofür | Pflicht |
| --- | --- | --- |
| `Mail.ReadWrite` | Mail sichern **und** restaurieren. Lesen allein reicht nicht — Restore schreibt. | ja |
| `MailboxSettings.Read` | Zeitzone/Regionaleinstellungen (Anzeige in Nutzerzeit). | ja |
| `Calendars.ReadWrite` | Kalender sichern und restaurieren. | ja |
| `Contacts.ReadWrite` | Kontakte sichern und restaurieren. | ja |
| `Files.ReadWrite.All` | OneDrive sichern und restaurieren (Upload-Session). | ja |
| `User.Read.All` | Verzeichnis-Sync, Postfachliste, Schutzregeln. | ja |
| `Group.Read.All` | Schutzregel „Gruppe" auflösen. | ja |
| `Directory.Read.All` | Verzeichnis-Sync, gelöschte Nutzer, Rollenprüfung. | ja |
| `Organization.Read.All` | Tenant-Name, Lizenzen (Anzeige, Schätzungen). | ja |
| `Mail.Send` | **Optional.** Nur wenn Benachrichtigungen über Graph statt SMTP laufen (Setup-Wizard, Transport `graph`). Sendet als konfiguriertes Absenderpostfach über `/users/{id}/sendMail`; per Application Access Policy auf dieses eine Postfach beschränkbar. | optional |

Hinweise:

- **`Mail.ReadWrite`, nicht `Mail.Read`.** Der häufigste Fehler: Consent mit
  Nur-Lesen, Backup läuft, Restore scheitert mit 403. Restow prüft beim Verbinden alle
  Rechte und zeigt fehlende an (siehe `docs/MICROSOFT.md`, „Dinge, die immer wieder
  schiefgehen").
- **`Sites.ReadWrite.All` bewusst nicht in v1.** Es kommt erst mit SharePoint
  (`docs/MICROSOFT.md`, ROADMAP „Danach"). Jetzt nicht anfragen — es weitet den
  Consent unnötig aus.
- **`Mail.Send` nur wenn wirklich gewählt.** Sie erlaubt Versand als jedes Postfach im
  Kunden-Tenant. Wer SMTP für Benachrichtigungen nutzt, lässt sie weg. Wer sie nimmt,
  begrenzt sie beim Kunden mit `New-ApplicationAccessPolicy` auf das Absenderpostfach.

Zusätzlich unter **API-Berechtigungen → Berechtigung hinzufügen → Microsoft Graph →
Delegierte Berechtigungen** die beiden OIDC-Scopes **`openid`** und **`profile`**
eintragen. Sie geben Restow keinerlei Datenzugriff; sie erlauben nur die bestätigende
Anmeldung des Kunden-Admins nach dem Consent (Teil 4). Stehen sie in der Registrierung,
deckt der Admin-Consent sie mit ab und die Anmeldung fragt nicht noch einmal nach.
Optional kann im Manifest `groupMembershipClaims` auf `DirectoryRole` gesetzt werden:
dann trägt das ID-Token die Rollen des Admins (`wids`) und Restow spart sich die
Rollenabfrage über Graph (`Directory.Read.All`).

Wichtig: Anwendungsberechtigungen wirken erst nach **Admin-Consent**. Im Betreiber-Tenant
kann der Provider-Admin auf der Seite „API-Berechtigungen" mit „Administratorzustimmung
für <Tenant> erteilen" zustimmen (nur für den eigenen Tenant). Für **Kunden-Tenants**
läuft der Consent über den Link aus Teil 3, nicht über dieses Portal.

## Teil 3 — Zugangsdaten: Zertifikat (bevorzugt) oder Client-Secret

Die Backup-App authentifiziert sich per Client Credentials. Zwei Wege, `@azure/msal-node`
kann beide:

**Zertifikat (bevorzugt).**

- Schlüsselpaar erzeugen, z. B.
  `openssl req -x509 -newkey rsa:4096 -keyout restow-entra.key -out restow-entra.crt -days 730 -nodes -subj "/CN=Restow"`.
- Unter **Zertifikate & Geheimnisse → Zertifikate → Zertifikat hochladen** die
  `.crt` (öffentlichen Teil) hochladen. Der private Schlüssel bleibt beim Betreiber.
- Privaten Schlüssel und Zertifikat zu einer PEM-Datei zusammenfügen
  (`cat restow-entra.key restow-entra.crt > restow-entra.pem`) und diese unter
  **Installation → Microsoft-Multi-Tenant-App** hochladen; Restow prüft beim Speichern, dass Schlüssel
  (RSA, unverschlüsselt) und Zertifikat zusammenpassen und das Zertifikat gültig ist, und
  legt beides nur verschlüsselt ab. Alternativ den Pfad zur PEM-Datei in
  `ENTRA_CLIENT_CERT_PATH` setzen; der Schlüssel gehört nicht ins Repo, nur auf den Host
  (Volume, außerhalb des Images).
- Vorteil: kein ablaufendes Geheimnis im Klartext, sauber rotierbar, empfohlen von
  Microsoft.

**Client-Secret (einfacher, schwächer).**

- Unter **Zertifikate & Geheimnisse → Geheime Clientschlüssel → Neuer geheimer
  Clientschlüssel**. Laufzeit **maximal 24 Monate** — Microsoft lässt keine längeren
  mehr zu.
- Den **Wert** (Spalte „Wert“) **sofort** kopieren, nicht die „Geheime ID“ daneben
  (später nicht mehr sichtbar), und unter **Installation → Microsoft-Multi-Tenant-App** eintragen,
  alternativ in `ENTRA_CLIENT_SECRET` ablegen. Restow lehnt eine eingetragene GUID ab,
  weil das fast immer die Geheime ID ist. Nie ins Repo, nie in Logs (`docs/… nicht
  verhandelbar`: keine Secrets im Repo, keine Secrets in Logs; Secrets liegen nur
  verschlüsselt in der DB bzw. in der Umgebung).
- Das Ablaufdatum aus Entra beim Eintragen mit angeben: Restow warnt **60 Tage** vor
  Ablauf (bei Zertifikaten liest es das Datum selbst aus). Rotation: neues
  Secret/Zertifikat anlegen, in Restow hinterlegen, dann das alte entfernen — nie erst
  löschen.

Genau **einen** Weg befüllen. Ist `ENTRA_CLIENT_CERT_PATH` gesetzt, nutzt Restow das
Zertifikat und ignoriert das Secret. In der Weboberfläche wird entweder ein Secret oder ein
Zertifikat gespeichert; die Umgebung hat immer Vorrang vor dem dort Gespeicherten.

## Teil 4 — Kunden verbinden: Admin-Consent-Link

Ein Kunde verbindet seinen Tenant, indem sein **Global Admin** einem
Admin-Consent-Link zustimmt. Restow erzeugt den Link je Mandant; das Muster:

```
https://login.microsoftonline.com/{tenant}/adminconsent?client_id={clientId}&redirect_uri={redirectUri}
```

- `{tenant}` — die Tenant-ID oder verifizierte Domain des Kunden (z. B.
  `contoso.onmicrosoft.com`). `common` funktioniert auch, aber die konkrete Tenant-ID
  ist eindeutiger und vermeidet Verwechslungen beim Kunden.
- `{clientId}` — die Client-ID der **Backup-App** (`ENTRA_CLIENT_ID`).
- `{redirectUri}` — der Admin-Consent-Rückweg von Restow. Er leitet sich aus der
  öffentlichen URL ab (siehe Teil 6), Standard:
  `<RESTOW_PUBLIC_URL>/api/v1/sources/m365/consent/callback`. **Genau dieser Wert** muss in
  Teil 1, Schritt 3 als Umleitungs-URI (Typ „Web") in der Backup-App eingetragen sein,
  sonst lehnt Entra den Rückweg ab. Mandantenseite › Verbindungen (Reiter Microsoft 365) in Restow zeigt den Wert mit
  Kopier-Knopf an.

Ablauf: Kunden-Admin öffnet den Link → meldet sich in **seinem** Tenant an → sieht die
angefragten Anwendungsberechtigungen → stimmt für die ganze Organisation zu → wird auf
`redirectUri` zurückgeleitet → meldet sich dort **ein zweites Mal** an (bestätigende
Anmeldung, OpenID Connect, Scopes `openid profile`) → erst dann verbindet Restow die
Quelle mit dem Tenant. Danach direkt alle Rechte prüfen und fehlende/falsche (etwa
`Mail.Read` statt `Mail.ReadWrite`) sofort anzeigen.

**Warum die zweite Anmeldung.** Der Rückweg des Admin-Consents nennt die Tenant-ID im
Parameter `tenant`, aber Microsoft signiert ihn nicht. Wer einen gültigen Consent-Link
(also dessen `state`) hat, könnte dort jede Tenant-ID eintragen, auch die eines fremden
Kunden, der der (für alle Kunden gemeinsamen) Backup-App bereits zugestimmt hat, und so
dessen Postfächer in den eigenen Mandanten ziehen. Restow wertet `tenant` deshalb nur als
Behauptung und prüft sie mit der bestätigenden Anmeldung:

- Der Code wird am Token-Endpunkt **des behaupteten Tenants** mit den Zugangsdaten der
  Backup-App eingelöst; das ID-Token muss Tenant (`tid`, `iss`), App (`aud`) und die
  Nonce aus dem signierten `state` bestätigen.
- Das angemeldete Konto muss **Global Administrator** oder **Administrator für
  privilegierte Rollen** dieses Tenants sein (nur diese Rollen dürfen Graph-
  Anwendungsberechtigungen erteilen). Ein normales Mitglied oder ein Gast des Tenants
  genügt nicht. Die Rolle kommt aus dem `wids`-Claim oder per Graph aus den aktiven
  Rollen des Kontos; direkt nach dem Consent wartet Restow dafür einige Sekunden.
- Als „Consent erteilt von" speichert Restow den UPN des bestätigten Admins.

**Ein Tenant, eine Quelle.** Ein Kunden-Tenant ist in der ganzen Installation höchstens
mit einer Quelle verbunden (eindeutiger Index über alle Mandanten). Ist er bereits einer
Quelle eines anderen Mandanten zugeordnet, lehnt Restow den Consent ab, ohne zu verraten,
welchem. Einen Tenant einem anderen Mandanten zuzuordnen ist Sache des
Provider-Administrators: erst die bisherige Quelle lösen, dann neu verbinden.

**Application Access Policies (Umfang eingrenzen).** Ein Consent gilt für **alle**
Postfächer des Tenants. Kunden, die nur eine Teilmenge schützen wollen, begrenzen die
Backup-App im Exchange Online PowerShell mit `New-ApplicationAccessPolicy` auf eine
Mail-fähige Sicherheitsgruppe. Restow muss das aushalten: Ein `403` für ein
ausgeschlossenes Postfach ist **kein Fehler**, sondern „nicht im Schutzumfang" und wird
so angezeigt (`docs/MICROSOFT.md`).

### Alternative: eine eigene App pro Quelle

Statt des Consent-Links kann eine Quelle über eine **Graph-App des Kunden** angebunden werden, die im
Kunden-Tenant selbst angelegt wurde. Dann braucht der Tenant weder die gemeinsame Restow-App noch einen
Consent-Link; die Zugangsdaten gehören dem Kunden.

1. Im Entra Admin Center des Kunden-Tenants unter *Identität → Anwendungen → App-Registrierungen →
   Neue Registrierung* eine App anlegen, Kontotyp „Nur Konten in diesem Organisationsverzeichnis“.
   **Keine Umleitungs-URI (Callback-URL) eintragen**: Restow meldet sich als App ohne Benutzer an
   (Client Credentials), es gibt keinen Rückweg.
2. Unter *API-Berechtigungen → Berechtigung hinzufügen → Microsoft Graph → Anwendungsberechtigungen*
   dieselben Berechtigungen wie in Teil 2 hinzufügen, also die ReadWrite-Varianten (`Mail.ReadWrite`,
   `Calendars.ReadWrite`, `Contacts.ReadWrite`, `Files.ReadWrite.All`) plus `MailboxSettings.Read`,
   `User.Read.All`, `Group.Read.All`, `Directory.Read.All`, `Organization.Read.All` und optional
   `Mail.Send`. Danach *Administratorzustimmung für … erteilen*. Die Oberfläche zeigt dieselbe Liste
   zum Kopieren.
3. Unter *Zertifikate & Geheimnisse* ein Clientgeheimnis (den **Wert**, nicht die Geheimnis-ID) oder ein
   Zertifikat anlegen. Das Ablaufdatum notieren und rechtzeitig ein neues eintragen.
4. In Restow in der **Organisation**, zu der der Kunde gehört: Verbindungen → Quelle → *Eigene Graph-App*.
   Tenant-ID, Anwendungs-ID und das Secret (oder eine PEM-Datei mit privatem Schlüssel und Zertifikat)
   eintragen.

Restow fordert mit diesen Zugangsdaten ein Token für genau diesen Tenant an; ohne gültiges Token wird nichts
gebunden. Die Zugangsdaten liegen verschlüsselt im Geheimnisspeicher der Organisation und werden nie wieder
angezeigt; zum Rotieren trägt man neue ein. Der Tenant gehört danach der Organisation, in der die Quelle
liegt, und kann in keiner anderen verbunden werden. Eine Quelle mit eigener App hat keinen Consent-Link.

## Teil 5 — SSO-App für den Endnutzer-Login

> **Stand 0.1.0:** Die Anmeldung mit Microsoft ist noch nicht nutzbar. Die Anmeldeseite
> zeigt die Schaltfläche nicht, weil es noch keinen Weg gibt, ein Restow-Konto mit einer
> Microsoft-Identität zu verknüpfen. `ENTRA_SSO_CLIENT_ID` und `ENTRA_SSO_CLIENT_SECRET`
> bleiben leer. Die folgende Einrichtung beschreibt das Zielbild für die Version, die die
> Verknüpfung bringt.

Zweite Registrierung, **Neue Registrierung**:

1. **Name**: z. B. `Restow Self-Service Restore`.
2. **Unterstützte Kontotypen**: Multi-Tenant (`common`), damit sich Nutzer aus jedem
   verbundenen Kunden-Tenant anmelden können.
3. **Umleitungs-URI**: Plattform **Web**, Wert = der OIDC-Callback von Restow. Dieser
   wird von better-auth bereitgestellt (generic OAuth, Provider-ID `microsoft`, über
   den gemeinsamen Callback-Endpunkt `/callback/:id`). Form:
   `<RESTOW_PUBLIC_URL>/api/auth/callback/microsoft`. Die Anmeldeseite bietet
   „Mit Microsoft anmelden" nur an, wenn `ENTRA_SSO_CLIENT_ID` und
   `ENTRA_SSO_CLIENT_SECRET` gesetzt sind, die Installation im Modus `public` mit
   öffentlicher URL läuft und die Edition Business oder Service Provider aktiv ist.
4. **Delegierte** Graph-Berechtigungen (nicht Application): `openid`, `profile`,
   `email`. Mehr braucht der Login nicht — er stellt nur die Identität her, keine
   Datenrechte. Rollenprüfung (Global Admin des Kunden) macht Restow über den
   `wids`-Claim im ID-Token bzw. `directoryRoles`, ohne Zusatzberechtigung.
5. **Zugangsdaten**: ein Client-Secret (oder Zertifikat) wie in Teil 3, hier in
   `ENTRA_SSO_CLIENT_ID` und `ENTRA_SSO_CLIENT_SECRET`.
6. **Authority/Issuer**: `https://login.microsoftonline.com/common/v2.0`. Kein
   Admin-Consent nötig — die delegierten Scopes `openid profile email` darf der Nutzer
   selbst zustimmen (User-Consent).

Der Provider-Admin selbst nutzt **keinen** Entra-Login, sondern Passkey (siehe
`docs/ARCHITECTURE.md`). Die SSO-App ist ausschließlich für Endnutzer.

## Teil 6 — Redirect-URIs und Betriebsmodus

Alle Redirect-URIs hängen an der **öffentlichen URL** und am **Betriebsmodus**, die im
Setup-Wizard gesetzt werden (`RESTOW_PUBLIC_URL`, `RESTOW_MODE`; siehe
`docs/ARCHITECTURE.md`, „Setup und Betriebsmodi"). Der Wizard leitet daraus die exakten
URIs ab und zeigt sie an, damit sie 1:1 in Entra kopiert werden können:

- **Modus `public`** (Produktiv): öffentliche Domain plus gültiges TLS. Beispiel mit
  `RESTOW_PUBLIC_URL=https://restow.example.com`:
  - Admin-Consent-Rückweg (Backup-App):
    `https://restow.example.com/api/v1/sources/m365/consent/callback`
  - OIDC-Callback (SSO-App):
    `https://restow.example.com/api/auth/callback/microsoft`
- **Modus `local`** (nur Entwicklung/Test, über IP oder localhost): Entra verlangt für
  Redirect-URIs HTTPS, Ausnahme ist ausschließlich `http://localhost`. Über eine
  bloße IP funktioniert der Entra-Login nicht. In `local` bleibt außerdem der
  Passkey-Weg verborgen (keine registrierbare HTTPS-Domain), es greift der
  Notfall-Passwortweg mit TOTP-Pflicht (`passkey_ready`-Check, `docs/ARCHITECTURE.md`).
  Für Endnutzer-SSO ist `local` daher nur zum Ausprobieren mit localhost gedacht, nicht
  für Kunden.

Wichtig: Ändert sich `RESTOW_PUBLIC_URL` (neue Domain), müssen die Umleitungs-URIs in
**beiden** App-Registrierungen nachgezogen werden. Der Wizard nennt die alten und neuen
Werte; ein Origin-Mismatch macht sich sofort als fehlgeschlagener Login/Consent
bemerkbar. Die Redirect-URIs nie mit Pfad-Parametern oder personenbezogenen Daten in der
Query erweitern.

## Teil 7 — Journaling-Regel und Journal-Adresse (kurz)

Für das **Archiv** (nicht Backup) kommt Mail zusätzlich per Exchange-Online-Journaling
herein; das ist von der App-Registrierung getrennt und läuft ohne Graph:

- Der Kunden-Admin legt im Exchange Admin Center (Compliance) eine **Journalregel** an,
  Journalempfänger extern = die **mandantenspezifische** Journal-Adresse von Restow, z. B.
  `journal+<token>@archive.<domain>`. Der Hostname `archive.<domain>` ist `JOURNAL_HOSTNAME`;
  die vollständige Adresse zeigt Restow im Archiv (Abschnitt "Exchange-Journaling").
- Voraussetzung im Kunden-Tenant: eine gesetzte Adresse für nicht zustellbare
  Journalberichte (Undeliverable Journal Reports), sonst verwirft Exchange Reports still.
- Je Mandant eine **eigene** Journal-Adresse mit zufälligem Token; der Empfänger nimmt nur
  bekannte Adressen an, verlangt STARTTLS (Exchange Online stellt nur über TLS zu; ohne
  Zertifikat startet der Empfänger nicht, und eine Sitzung ohne STARTTLS wird mit `530`
  abgewiesen), mit Rate- und Größenlimit (150 MB). Die Absenderprüfung (SPF,
  Microsoft-Adressbereiche) ist noch nicht umgesetzt. Der Empfänger gehört zu Edition
  Business und Service Provider und braucht `JOURNAL_SMTP_PORT`, `JOURNAL_HOSTNAME` und die
  TLS-Dateien. Schritt für Schritt, auch zum Zertifikat: `docs/ARCHIVE.md` (Abschnitte
  „Exchange-Online-Journaling einrichten“ und „TLS-Zertifikat“); Details und GoBD-Bezug in
  `docs/MICROSOFT.md` (Abschnitt „Journaling“).

Journaling liefert die Kopie **vor** Zustellung inklusive Envelope-/BCC-Empfänger, die über Graph nicht sichtbar sind.

## Checkliste

- [ ] Backup-App (Multi-Tenant) registriert, Client-ID unter **Installation → Microsoft-Multi-Tenant-App** eingetragen (oder in `ENTRA_CLIENT_ID`; die Umgebung hat Vorrang).
- [ ] Neun Pflicht-Anwendungsberechtigungen gesetzt; `Mail.Send` nur bei Graph-Versand.
- [ ] Delegierte Scopes `openid` und `profile` in der Backup-App eingetragen (bestätigende Anmeldung).
- [ ] Zertifikat **oder** Secret (≤ 24 Monate) unter **Installation → Microsoft-Multi-Tenant-App** hinterlegt (verschlüsselt gespeichert) bzw. per `ENTRA_CLIENT_CERT_PATH` / `ENTRA_CLIENT_SECRET`; „Verbindung testen“ zeigt alle Pflichtrechte als erteilt.
- [ ] Admin-Consent-Rückweg als Web-Redirect in der Backup-App eingetragen.
- [ ] SSO-App (Multi-Tenant `common`) registriert, delegierte Scopes `openid profile email`, Callback als Web-Redirect; `ENTRA_SSO_CLIENT_ID`/`ENTRA_SSO_CLIENT_SECRET` gesetzt.
- [ ] `RESTOW_PUBLIC_URL`/`RESTOW_MODE` im Wizard gesetzt; angezeigte Redirect-URIs 1:1 in beide Apps übernommen.
- [ ] Je Kunde: Admin-Consent-Link zugestellt, Zustimmung und bestätigende Anmeldung durch einen Global Admin, danach Rechte in Restow als erteilt angezeigt.
- [ ] Je Archiv-Kunde: Journalregel auf die mandantenspezifische Journal-Adresse gesetzt.
