# Speicherknoten für unveränderbare Sicherungen (Entwurf, Roadmap 0.7.0)

Stand: Planung, nichts davon ist umgesetzt. Entscheidung des Maintainers (November 2026):

- Der Speicherknoten kommt auf die Roadmap für **0.7.0**.
- Der Knoten bekommt eine **minimalistische Weboberfläche, nur lesend**.
- Der Knoten liefert unter **Repositories** Metriken: Belegung, Fehlerrate, defekte Platten,
  Erfolg und Misserfolg der SMART-Tests und mehr.
- Der Knoten schickt **bei Bedarf selbst eine Mail an den Admin**, ohne Umweg über den
  Restow-Server.
- **Erweiterte Notfall-Übungen** (Disaster-Recovery-Tests) gehören dazu.

Dieses Dokument hält fest, wie das gebaut würde und was vorher zu klären ist.

## 0. Kurzfassung

- Restow ist heute nur so unveränderbar wie der Speicher, den der Admin mitbringt: ein
  S3-Dienst mit Object Lock oder ein NAS mit WORM-Freigabe. Für ein Verzeichnis gibt es nur die
  Löschverzögerung, und `docs/STORAGE.md` sagt dazu offen: "A truly hardened repository needs a
  separate machine that Restow cannot log in to." Der Speicherknoten ist diese Maschine.
- **Ein Dienst, zwei Auslieferungen**: `restow-store` als eigenes Docker-Image und als eigenes
  ISO (Appliance). Beides entsteht im Haupt-Repository und wird mit dem Server zusammen
  veröffentlicht; ein eigenes Repository gibt es nicht.
- **Was jede Auslieferung verspricht**, steht fest und wird in der Oberfläche so benannt:
  das Image ist **getrennter Speicher** (hält gegen einen übernommenen Restow-Server, ein
  gestohlenes Admin-Konto und eine verkürzte Aufbewahrung), nur das ISO ist **unveränderbar**
  (hält zusätzlich gegen jeden, der sich am Speicher-Host anmelden könnte, weil sich dort
  niemand anmelden kann).
- Der Knoten kennt **drei Regeln**: einmal schreiben, nie überschreiben, löschen erst nach dem
  Sperrdatum. Das Sperrdatum lässt sich verlängern und nie verkürzen. Es gibt keinen Aufruf,
  der den Knoten leert.
- Der Knoten sieht **nur Chiffrat**. Schlüssel, Datenbank und Server-Code liegen nie auf ihm.
- **Anbinden mit einem Code** aus URL und Einmal-Token, wie bei den Agenten.
- Das ISO richtet die Platten selbst ein: **btrfs RAID1 oder RAID10** mit Prüfsummen und
  monatlichem Scrub (stille Fehler werden aus dem Spiegel repariert).
- Der Knoten liefert **Metriken** an die Seite Repositories und **mailt dem Admin selbst**, auch
  wenn der Restow-Server ausgefallen oder übernommen ist (Abschnitt 11).
- Eine **eigene Statusseite, nur lesend**, zeigt dieselben Metriken direkt am Knoten
  (Abschnitt 12).
- **Notfall-Übungen** beweisen regelmäßig, dass sich vom Knoten wiederherstellen lässt, auch
  ohne den Restow-Server (Abschnitt 13).

## 1. Ausgangslage

| Speicher heute | Schutz | Grenze |
|---|---|---|
| S3 mit Object Lock | unveränderbar bis zum Sperrdatum (COMPLIANCE) | der Admin braucht einen solchen Dienst; bisher nur gegen simuliertes S3 getestet |
| NAS mit WORM-Freigabe (write-once) | der Speicher verweigert Löschen und Überschreiben | Restow kann die Sperre nicht steuern und gibt nie Platz frei |
| Verzeichnis (`local`) | Löschverzögerung: Restows eigener Code löscht nicht vor Ablauf | hält nicht gegen Zugriff auf Server oder Freigabe |

Die Mechanik für unveränderbare Ziele existiert bereits und wird wiederverwendet
(`packages/core/src/storage/immutability.ts`): Sperrklassen je Schlüssel (`lockClassOf`),
Sperrdauer N Tage plus 7 Tage Puffer, tägliche Verlängerung für alles, was noch gebraucht wird,
aufgeschobene Löschungen (`immutability_deferred_deletions`) und die Stichprobe, die das
Sperrdatum beim Speicher abfragt. Die Schnittstelle `StorageBackend` hat dafür schon
`retention()` und `setRetention()`.

## 2. Ziele und Nicht-Ziele

Ziele:

- Unveränderbare Sicherungen ohne fremden S3-Dienst und ohne NAS mit WORM-Lizenz, auf eigener
  Hardware oder in einer VM.
- Einrichtung in Minuten: ISO starten, Platten wählen, Code eingeben.
- Der Knoten ist als primäres Ziel und als Kopie-Ziel nutzbar, für die Installation oder je
  Mandant, mit denselben Präfixen wie heute.
- Wiederherstellung auch dann, wenn der Restow-Server verloren ist (Abschnitt 10).

Nicht-Ziele:

- Kein allgemeiner S3-Dienst. Der Knoten spricht nur mit Restow.
- Kein Schutz gegen physischen Zugriff (Platten ausbauen, Hardware zerstören). Dagegen helfen
  eine zweite Kopie an einem anderen Ort und später das Band (`docs/TAPE.md`).
- Kein Cluster aus mehreren Knoten in 0.7.0. Mehrere Knoten sind mehrere Ziele; die Verteilung
  macht Restow wie heute über Kopien.
- Keine Parität (RAID5/6) in 0.7.0, siehe Abschnitt 7.

## 3. Wer nichts löschen können darf

| Angreifer | Image | ISO |
|---|---|---|
| Übernommener Restow-Server (Root, Datenbank, alle Schlüssel) | hält | hält |
| Gestohlenes Admin-Konto, absichtlich verkürzte Aufbewahrung | hält | hält |
| Mitgeschnittenes oder gestohlenes Zugangszertifikat des Servers | hält | hält |
| Root auf dem Host des Knotens | hält nicht (das Volume lässt sich löschen) | es gibt keine Anmeldung |
| Verstellte Uhr (Sperren sollen "ablaufen") | hält (Abschnitt 6) | hält |
| Manipuliertes Update | hält (Abschnitt 9) | hält |
| Physischer Zugriff | hält nicht | hält nicht |

Die Folge für den Zugang des Servers: Er darf schreiben, lesen, auflisten, das Sperrdatum nach
hinten setzen und nach Ablauf löschen. Mehr gibt es in der Schnittstelle nicht.

## 4. Der Dienst `restow-store`

- **Go**, im Modul der Agenten (`agent/`), damit Signaturprüfung, atomares Schreiben und die
  Build-Kette geteilt werden. Ein statisches Binary, keine Datenbank.
- **Schnittstelle**: HTTPS mit gegenseitigen Zertifikaten. Die Aufrufe bilden `StorageBackend`
  ab: `put`, `get` (auch als Bereich), `head`, `list` (mit Größen), `delete`, `retention`,
  `setRetention`, `freeSpace`, `rootState`. Auf der Restow-Seite ist der Knoten damit eine dritte
  Art von Speicherziel (`node`) neben `s3` und `local`; alles darüber (Chunk-Store, restic-Schicht,
  Kopien, Prüfungen) bleibt unverändert.
- **Regeln, die der Knoten selbst durchsetzt**:
  - `put` auf einen Schlüssel mit laufender Sperre wird abgelehnt (kein Überschreiben). Gleicher
    Inhalt ist kein Fehler, damit ein wiederholter Upload nach einem Abbruch durchgeht.
  - `delete` auf einen Schlüssel mit laufender Sperre wird abgelehnt. Restow behandelt das wie
    heute bei S3 als "noch nicht" und führt die Löschung später aus.
  - `setRetention` nimmt nur ein späteres Datum an als das gespeicherte.
  - Schlüssel ohne Sperre (Prüfpunkte, Staging, restic-`locks/` und `index/`) dürfen
    überschrieben und gelöscht werden. Welche Klasse gesperrt wird, entscheidet weiter
    `lockClassOf`; der Knoten erzwingt zusätzlich eine **Mindestsperre**, die bei der Einrichtung
    an der Konsole gesetzt wird: Schlüssel unter den Daten-Präfixen (Packs, Manifeste, Schlüssel,
    restic `data/`, `snapshots/`, `keys/`, `config`) bekommen sie auch dann, wenn der Server
    keine Sperre mitschickt. Ein übernommener Server kann so nicht "ohne Sperre" schreiben und
    dann löschen.
  - Es gibt keine Versionierung. Die Sonderwege von S3 (Löschmarker, alle Versionen löschen)
    entfallen.
- **Ablage**: jeder Schlüssel eine Datei, geschrieben in eine temporäre Datei, mit `fsync`
  abgeschlossen und atomar umbenannt. Das Sperrdatum steht in einem angehängten Journal mit
  Prüfsumme je Eintrag und zusätzlich als erweitertes Attribut an der Datei; beim Start werden
  beide abgeglichen, das spätere Datum gilt.
- **Kein Inhalt im Klartext**: Chunk-Store und restic-Repositories sind verschlüsselt, bevor sie
  den Server verlassen. Der Knoten kann nichts lesen und braucht deshalb keine eigene
  Plattenverschlüsselung.

## 5. Anbinden: Code aus URL und Token

1. In Restow: Repositories › Speicherknoten hinzufügen. Restow zeigt einen **Code**, eine
   Zeichenkette aus der URL der Instanz und einem Einmal-Token (eine Stunde gültig), auch als
   QR-Code.
2. Am Knoten: Der Code wird an der Konsole eingegeben (ISO) oder als Umgebungsvariable oder
   Datei übergeben (Image), dazu die Adresse, unter der Restow den Knoten erreicht.
3. Der Knoten erzeugt sein Schlüsselpaar, meldet sich mit dem Token bei Restow und nennt
   Adresse, Zertifikat, Version, Kapazität und Mindestsperre. Restow stellt dem Knoten sein
   Client-Zertifikat vor; beide Seiten merken sich das Zertifikat der Gegenseite (Pinning).
   Danach verbindet sich nur noch Restow zum Knoten.
4. Der Knoten zeigt einmalig einen **Notfall-Lesezugang** (Abschnitt 10), der mit dem
   Master-Key verwahrt wird.

Ein Knoten gehört zu genau einer Restow-Instanz. Eine neue Instanz (nach Verlust des Servers)
wird an der Konsole angebunden; die Daten und ihre Sperren bleiben.

## 6. Uhr

Wer die Uhr vorstellt, lässt Sperren ablaufen. Der Knoten vertraut deshalb weder dem Server noch
blind einem Zeitserver:

- Er führt eine eigene, gespeicherte Zeit, die nur vorwärts läuft und der Systemuhr höchstens
  begrenzt folgt (Vorschlag: eine Abweichung nach vorn wird mit höchstens einer Stunde je Tag
  eingeholt).
- Ein größerer Sprung nach vorn (leere Uhrenbatterie, falsche Zeit nach einem Tausch) braucht
  eine Bestätigung an der Konsole. Bis dahin gelten alle Sperren weiter, gelöscht wird nichts.
- Eine Abweichung zur Zeit des Servers meldet Restow als Warnung am Repository.

## 7. Platten und Selbstheilung (ISO)

- **Standard: btrfs RAID1** für Daten und Metadaten, ab vier Platten **RAID10**. Die Prüfsummen
  erkennen stille Fehler beim Lesen, ein **monatlicher Scrub** liest alles und repariert aus dem
  Spiegel.
- **Kein btrfs RAID5/6**: wegen der bekannten Schwäche bei Stromausfall während des Schreibens
  nicht für Sicherungen. Parität ist eine offene Frage für später (mdadm RAID6 mit
  dm-integrity darunter).
- **Kein ZFS im ISO**: Die Lizenz erlaubt kein mitgeliefertes Kernelmodul, und ein Modul, das
  auf der Appliance gebaut werden muss, ist eine Fehlerquelle bei jedem Kernel-Update.
- **Zweite Verteidigungslinie**: stündliche schreibgeschützte Snapshots des Datenbereichs, die
  nur der Knoten selbst nach Ablauf entfernt. Sie fangen einen Fehler im Dienst ab, der eine
  Sperre übersieht.
- **Plattentausch** an der Konsole: defekte Platte anzeigen, neue wählen, Wiederaufbau mit
  Fortschritt. Erweitern um weitere Platten ebenso.
- **SMART**: kurzer Selbsttest wöchentlich, langer monatlich, je Platte; die Ergebnisse gehen
  in die Metriken (Abschnitt 11).
- Der Installer nutzt den Platten-Code des Recovery-ISO (`agent/internal/baremetal`,
  `agent/internal/recovery`): Erkennen der Platten mit eindeutiger Identität, Bestätigung vor
  dem Löschen, Partitionieren.

Im **Image** verwaltet der Knoten keine Platten; für Spiegel und Scrub ist der Host zuständig,
und die Oberfläche sagt das. Belegung, Fehlerraten der Schnittstelle und die Fehlerzähler des
Dateisystems liefert das Image immer. Für SMART und den Zustand einzelner Platten braucht der
Container die Geräte (`devices:` und das Recht für SMART-Abfragen); ohne sie zeigt Restow an der
Stelle "vom Host nicht freigegeben" statt eines grünen Hakens.

## 8. Härtung der Appliance (ISO)

- Basis **Debian 13** wie das Recovery-ISO, mit derselben reproduzierbaren Build-Kette.
- Kein SSH, keine Shell. Verändert wird nur an der Konsole; die Statusseite (Abschnitt 12)
  liest nur. Die Konsole zeigt ein Menü: Zustand, Netzwerk, Anbinden, Platten,
  Uhr bestätigen, Update-Zustand, Zurücksetzen.
- Nach außen sind nur der Port der Schnittstelle und, wenn eingeschaltet, der der Statusseite
  offen.
- System schreibgeschützt in zwei Abbildern (A/B); der Datenbereich ist getrennt.
- **Zurücksetzen** (alles löschen) nur an der Konsole, mit Wartefrist (Vorschlag 7 Tage), in
  der Restow täglich alarmiert und das Zurücksetzen an der Konsole abgebrochen werden kann.
- Die Konsole ist mit einem Kennwort geschützt, das bei der Einrichtung gesetzt wird. Es öffnet
  das Menü, keinen Systemzugang.

## 9. Updates

- Der Knoten **holt** Updates selbst und prüft die Release-Signatur wie der Updater. Restow
  kann kein Update einspielen: sonst wäre ein übernommener Server ein übernommener Knoten.
- ISO: neues Abbild in den freien Platz (A/B), Neustart, Rückfall auf das alte Abbild, wenn der
  Dienst nicht startet. Image: der Admin zieht das neue Image; der Knoten prüft beim Start nur
  sein eigenes Format.
- Restow zeigt die Version des Knotens und warnt, wenn sie zu alt für den Server ist. Das
  Protokoll ist versioniert; der Server spricht die Version des Knotens.

## 10. Wiederherstellung ohne Restow-Server

Ist der Restow-Server verloren, hat niemand mehr sein Client-Zertifikat. Zwei Wege:

- **Notfall-Lesezugang**: Bei der Einrichtung erzeugt der Knoten einen Zugang, der nur lesen
  und auflisten darf, und zeigt ihn einmal an. Mit ihm und dem Master-Key liest
  `restow-restore` direkt vom Knoten.
- **Neue Instanz anbinden** (Abschnitt 5): Der neue Server übernimmt die vorhandenen Daten wie
  heute beim Wiederherstellungsmodus; die Sperren laufen weiter.

## 11. Metriken und Meldungen

**Unter Repositories** bekommt ein Speicherknoten eine eigene Karte und eine Detailseite. Restow
holt die Metriken mit dem signierten Zustand ab (Abschnitt 14) und hebt den Verlauf auf.

| Gruppe | Metriken |
|---|---|
| Belegung | belegt, frei, davon gesperrt und bis wann, Zuwachs je Tag, Hochrechnung "voll in N Tagen", Belegung je Mandant (aus den Präfixen) |
| Platten | je Platte: Modell, Seriennummer, Alter in Betriebsstunden, Temperatur, SMART-Gesamturteil, neu zugewiesene und schwebende Sektoren, Verschleiß bei SSD und NVMe; defekte und fehlende Platten |
| SMART-Tests | je Platte: letzter kurzer und langer Selbsttest mit Datum und Ergebnis (bestanden, fehlgeschlagen, abgebrochen), überfällige Tests |
| Verbund | Zustand (vollständig, degradiert, Wiederaufbau mit Fortschritt), Fehlerzähler des Dateisystems je Platte (Lesen, Schreiben, Prüfsumme), letzter Scrub mit Dauer, reparierten und nicht reparierbaren Fehlern |
| Schnittstelle | Aufrufe und Fehlerrate je Art (Schreiben, Lesen, Löschen), abgelehnte Aufrufe unter Sperre, abgelehnte Zertifikate, Durchsatz und Antwortzeiten |
| Knoten | Auslieferung (Image oder ISO), Version, Update-Zustand, Laufzeit, Abweichung der Uhr, letzter Kontakt des Servers, Auslastung von Prozessor und Speicher, Temperatur |

Schwellen (Vorschlag, je Repository einstellbar): Belegung 80 und 90 Prozent, "voll in" unter 14
Tagen, jede nicht reparierbare Prüfsumme, jeder fehlgeschlagene SMART-Test, jede neu
zugewiesene Sektorzahl über null bei steigender Tendenz, degradierter Verbund sofort.

**Zwei Wege für Meldungen**, damit ein Ausfall des einen den anderen nicht stumm macht:

- **Über Restow**: Die Zustände des Knotens sind Ereignisse wie alle anderen (Alarm am
  Repository, Benachrichtigungen, Digest, Berichte, Webhooks).
- **Direkt vom Knoten per Mail**: Der Knoten hat eigene SMTP-Einstellungen und Empfänger,
  gesetzt an der Konsole (ISO) oder über die Konfiguration (Image), mit Testmail bei der
  Einrichtung. Er mailt selbst bei:
  - defekter oder fehlender Platte, degradiertem Verbund, fehlgeschlagenem SMART-Test,
    nicht reparierbarem Scrub-Fehler, Füllstand über der Schwelle;
  - **Funkstille**: Restow hat sich seit N Stunden nicht gemeldet oder seit N Tagen nichts
    geschrieben (Vorschlag 24 Stunden und 3 Tage). Das ist der Fall, in dem der Server
    ausgefallen ist oder jemand die Sicherungen abgestellt hat, und in dem von Restow keine
    Mail mehr kommt;
  - auffälligen Aufrufen: viele abgelehnte Löschungen unter Sperre, abgelehnte Zertifikate,
    ein angefordertes Zurücksetzen, ein bestätigter Sprung der Uhr;
  - fehlgeschlagenem Update und Rückfall auf das alte Abbild.
  Jede Mail nennt Knoten, Ereignis, Zeit und den nächsten Schritt, nie Schlüssel oder Inhalte.
  Wiederholungen sind gedrosselt (ein Ereignis einmal, danach täglich eine Erinnerung), und eine
  Mail, die nicht zugestellt werden konnte, steht an der Konsole und in den Metriken.
- Die Empfänger des Knotens können sich von denen in Restow unterscheiden. Empfohlen ist
  mindestens eine Adresse außerhalb der gesicherten Umgebung.

## 12. Weboberfläche des Knotens (nur lesend)

Der Knoten bekommt eine eigene, kleine Statusseite. Sie ist für den Fall da, in dem Restow nicht
erreichbar ist oder man dem Server nicht mehr traut, und für den Techniker vor Ort.

- **Nur lesend, ohne Ausnahme.** Die Seite kennt nur Abrufe; es gibt kein Formular und keinen
  Aufruf, der etwas ändert. Anbinden, Netzwerk, Plattentausch, Uhr bestätigen und Zurücksetzen
  bleiben an der Konsole (ISO) oder in der Konfiguration (Image). Damit kann auch ein gestohlenes
  Kennwort der Seite nichts verändern.
- **Inhalt**: dieselben Metriken wie unter Repositories (Abschnitt 11) mit dem Stand von jetzt
  und dem Verlauf der letzten 30 Tage, dazu die letzten Ereignisse, die letzten Mails des
  Knotens mit Zustellstatus, der Zustand der Sperren (wie viel ist bis wann gesperrt) und der
  Fingerabdruck des Zertifikats. Keine Schlüssel, keine Objektnamen, keine Mandantennamen
  (nur die Belegung je Präfix).
- **Minimal gebaut**: vom Dienst selbst ausgeliefertes HTML ohne Fremdquellen und ohne
  Framework, eigener Port, eigene Rechte im Dienst (die Seite kann nur die Metriken lesen,
  nicht die Ablage). Strenge Kopfzeilen, kein Cookie, das mehr als die Anmeldung trägt.
- **Zugang**: HTTPS mit dem Zertifikat des Knotens; der Fingerabdruck steht an der Konsole.
  Anmeldung mit einem eigenen Lesekennwort, das bei der Einrichtung gesetzt wird (nicht das
  der Konsole), mit Sperre nach Fehlversuchen. Die Seite lässt sich auf bestimmte Netze
  beschränken oder ganz abschalten.
- **Maschinenlesbar**: derselbe Stand als JSON und im üblichen Textformat für
  Überwachungssysteme, damit ein vorhandenes Monitoring den Knoten ohne Restow abfragen kann.
- Restow verlinkt von der Repository-Seite auf die Statusseite des Knotens.

## 13. Notfall-Übungen (erweiterte Disaster-Recovery-Tests)

Die Prüfungen von heute lesen Stichproben zurück. Eine Übung beweist mehr: dass der ganze Weg im
Ernstfall trägt, und wie lange er dauert. Jede Übung läuft nach Zeitplan oder auf Knopfdruck,
schreibt nur in ein Übungsziel, räumt hinter sich auf und hinterlässt einen Bericht mit
gemessener Dauer. Eine überfällige oder fehlgeschlagene Übung ist ein Alarm.

| Übung | Was sie beweist | Takt (Vorschlag) |
|---|---|---|
| **Server verloren** | Eine Stichprobe je Mandant wird nur mit Notfall-Lesezugang, Master-Key und `restow-restore` vom Knoten gelesen, ohne Datenbank und ohne Server | monatlich |
| **Ganzes Objekt** | Ein vollständiges Postfach, ein Rechner oder ein Gast wird in ein Übungsziel zurückgeschrieben, verglichen und gelöscht; die Dauer ergibt eine belegte Wiederherstellungszeit | vierteljährlich |
| **Kopie statt Primärziel** | Dieselbe Stichprobe wird vom Knoten als Kopie gelesen, während das Primärziel als nicht erreichbar gilt | monatlich |
| **Löschversuch** | Restow versucht mit seinem eigenen Zugang, ein gesperrtes Objekt zu löschen, zu überschreiben und die Sperre zu verkürzen; der Knoten muss alle drei ablehnen | wöchentlich |
| **Neue Instanz** | Eine leere Restow-Instanz in einer Übungsumgebung bindet den Knoten nur lesend an, findet Mandanten und Wiederherstellungspunkte und stellt eine Stichprobe wieder her | halbjährlich, geführt |
| **Plattenausfall** (ISO) | An der Konsole wird eine Platte aus dem Verbund genommen; Alarm, Mail des Knotens, Wiederaufbau und Scrub danach werden abgehakt | halbjährlich, geführt |
| **Funkstille** | Restow schweigt gegenüber dem Knoten für die Dauer der Schwelle; die Mail des Knotens muss ankommen | halbjährlich |

Geführte Übungen brauchen einen Menschen (Übungsumgebung, Konsole); Restow führt durch die
Schritte und hält das Ergebnis fest. Die übrigen laufen von selbst.

Die Seite Wiederherstellbarkeit zeigt je Repository die letzte bestandene Übung jeder Art und
die gemessene Wiederherstellungszeit. Die Übungen "Server verloren", "Ganzes Objekt" und
"Kopie statt Primärziel" sind nicht an den Speicherknoten gebunden und gelten für jedes
Speicherziel; sie können vor 0.7.0 kommen.

## 14. Prüfung ("grün heißt Beweis")

- Die bestehende Stichprobe fragt das Sperrdatum frisch geschriebener Objekte beim Knoten ab.
- "Unveränderbar bis <Datum>" ist an einem Wiederherstellungspunkt nur grün, wenn der Knoten
  selbst das Datum gemeldet hat **und** ein ISO-Knoten ist. Ein Image-Knoten wird neutral
  angezeigt, wie heute GOVERNANCE.
- Der Knoten signiert seinen Zustand und seine Metriken (Auslieferung, Version, Uhr,
  Mindestsperre, Zustand des Verbunds, letzter Scrub, Abschnitt 11). Restow zeigt ihn am
  Repository und prüft die Signatur gegen das gemerkte Zertifikat.
- Die Aussagen dieses Dokuments kommen in das Aussagen-Register (`docs/CLAIMS.md`), sobald es
  besteht, jede mit ihrem Test.

## 15. Tests

- Die Vertragstests von `StorageBackend` laufen gegen den Knoten wie gegen `local` und `s3`,
  ebenso die Tests der Unveränderbarkeit (Verlängerung, aufgeschobene Löschung).
- Regeln des Knotens: Überschreiben, Löschen und Verkürzen unter Sperre, Mindestsperre ohne
  mitgeschickte Sperre, jeder Aufruf mit einem Zertifikat ohne Recht.
- Uhr: Vorstellen, Zurückstellen, Sprung mit und ohne Bestätigung.
- Abbruch: Stromausfall während `put` (kein halbes Objekt, kein Objekt ohne Sperre), Journal
  und Attribut widersprechen sich.
- Platten (als Root auf Loop-Geräten und in einer VM in der CI): eine Seite des Spiegels
  beschädigen, Scrub repariert und meldet; eine Platte entfernen, Verbund degradiert, Alarm;
  Tausch und Wiederaufbau.
- ISO: Bau reproduzierbar, Start in einer VM, Einrichtung über die Konsole, Update A/B mit
  Rückfall.
- Fehlerinjektion von der Restow-Seite: Knoten nicht erreichbar, Knoten voll, Zertifikat
  abgelehnt; jeweils Zustand und Alarm.
- Metriken und Mail: SMART-Daten aus aufgezeichneten Ausgaben echter Platten (gesund, mit
  Vorwarnung, defekt, ohne SMART), jede Schwelle löst Ereignis und Mail aus, Funkstille löst
  die Mail des Knotens aus, Drosselung und nicht zustellbare Mail.
- Statusseite: jeder Pfad antwortet nur auf Abrufe, kein Pfad ändert Zustand (als Test über
  alle Routen), Anmeldung mit Sperre, keine Schlüssel, Objekt- oder Mandantennamen in der
  Ausgabe.
- Jede Notfall-Übung als Test gegen einen Knoten in der CI, einschließlich der Fälle, in denen
  sie fehlschlagen muss (Notfall-Lesezugang widerrufen, Objekt fehlt, Knoten lehnt nicht ab).

## 16. Meilensteine (Vorschlag)

| | Inhalt |
|---|---|
| N1 | Dienst `restow-store` mit den Regeln und der Ablage, Vertragstests, Speicherziel `node` in Restow |
| N2 | Anbinden mit Code, Zertifikate, Notfall-Lesezugang, `restow-restore` liest vom Knoten |
| N3 | Uhr, signierter Zustand, Metriken unter Repositories, Alarme in Restow, eigene Mail des Knotens mit Funkstille, Statusseite (nur lesend), Docker-Image ("getrennter Speicher") |
| N4 | ISO: Installer, btrfs-Verbund, Scrub, SMART-Tests, Snapshots, Plattentausch, Konsole, Härtung |
| N5 | Updates (A/B, Signatur), Tests auf echter Hardware, Doku, Aussagen im Register |
| N6 | Notfall-Übungen: Löschversuch, Server verloren, Kopie statt Primärziel, Ganzes Objekt, danach die geführten |

Voraussetzung für N4: Das Recovery-ISO baut in der CI (0.5.0), denn Build-Kette und
Platten-Code werden geteilt.

## 17. Offene Fragen an den Maintainer

1. **Edition**: Community oder kostenpflichtig? Vorschlag: Image in der Community-Edition, ISO
   kostenpflichtig, oder beides wie die übrige Unveränderbarkeit.
2. **Band und Speicherknoten in derselben Version**: Beide sind für 0.7 vorgesehen. Reicht die
   Zeit für beides, oder hat eines Vorrang?
3. **Standard der Mindestsperre** (Vorschlag 30 Tage) und der Wartefrist beim Zurücksetzen
   (Vorschlag 7 Tage).
4. **Secure Boot** für das ISO: mit signiertem Startpfad oder zunächst ohne?
5. **Parität** (RAID6) für große Knoten: in 0.7.0 weglassen (Vorschlag) oder gleich mitbauen?
6. **Testhardware**: ein kleiner Rechner mit mindestens zwei, besser vier Platten.
7. **Notfall-Übungen vor 0.7.0**: Die drei Übungen, die jedes Speicherziel betreffen ("Server
   verloren", "Ganzes Objekt", "Kopie statt Primärziel"), schon in 0.5.x oder 0.6 bauen?
8. **Schwellen und Takte** der Metriken und Übungen wie vorgeschlagen?
9. **Statusseite**: beim ISO ab Werk eingeschaltet (Vorschlag) oder erst nach Einschalten an
   der Konsole?
