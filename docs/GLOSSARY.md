# Glossary

One word per thing, in the web interface, mails, PDFs, webhooks and docs.
Every user-facing string follows this list; a new term is added here first.
Where a second term is listed as "also", both are fine: familiar technical words
like snapshot stay where administrators expect them.
German addresses the reader formally ("Sie") and never names the product
literally (use `{appName}`).

| Thing | English | Deutsch | Not |
| --- | --- | --- | --- |
| A computer with the agent | machine (server, client) | Rechner (Server, Client) | Maschine, Endpoint, Gerät |
| One stored state of a backup that can be restored | restore point (also: snapshot, version) | Sicherungsstand (auch: Snapshot, Version) | Wiederherstellungspunkt, Sicherung # |
| The configuration that says what is backed up and when | backup job | Backup-Job | Auftrag, Sicherungsjob |
| One execution of a backup job, restore, export, import or check | run | Lauf | Job (for a run), Auftrag |
| Waiting in the queue, not started yet | waiting | Wartet | Eingereiht, Wartend, Queued (as a state label) |
| Running now | running | Läuft | Aktiv (for a run) |
| Restoring a VM or container to a temporary guest, starting it and waiting for its guest agent, to prove it boots | boot test | Startprüfung | Boot-Test, Bootprüfung, Starttest |
| Reading data back to prove a restore works | restore check | Restore-Prüfung | Wiederherstellungstest, Wiederherstellungsprüfung, Restore-Test, Verify, Verifizierung |
| Readiness: proven by a passed restore check | ready | Bereit | Verifiziert, Wiederherstellbar (as a state label) |
| Readiness: backed up, but no recent restore check | unverified | Nicht nachgewiesen | Ungeprüft, Unbestätigt |
| Readiness: last restore check failed or no usable backup | not restorable | Nicht wiederherstellbar | Nicht bereit |
| Getting data back | restore | Wiederherstellung (verb: wiederherstellen) | Restore (alone), Rücksicherung |
| Mailbox, OneDrive, IMAP account or machine that a job covers | protected object | geschütztes Objekt | Element, Quelle (for the object) |
| A run that went through but could not back up some items | warning (with warnings) | Warnung (mit Warnungen) | Teilfehler, teilweise erfolgreich |
| Accepting a warning after looking at its causes, so it no longer counts | acknowledge (acknowledgement) | bestätigen (Bestätigung) | quittieren, ignorieren, ausblenden |
| Where backups are stored (a tenant's primary, copy or retired target, or the installation default) | repository (plural: repositories) | Repository (Plural: Repositories) | storage location, Speicherort, storage target (in the UI), Ziel (alone) |
| A customer organisation in the installation | tenant | Mandant | Kunde, Tenant, Organisation (for a tenant) |
| A person who administers the installation | member (owner, admin, …) | Mitglied (Inhaber, Administrator, …) | Owner, Teammitglied |
| A person of a tenant | tenant user | Benutzer des Mandanten | Kunde |
| The long-term, tamper-evident mail store | archive | Archiv | Journal |
| A network share mounted by the mounter as storage (docs/MOUNTS.md) | network share | Netzlaufwerk | Mount |
| An SMB share or NFS export Restow backs up and restores into (docs/FILESHARES.md) | file share | Freigabe | Netzlaufwerk (that is the storage mount), Share, Dateifreigabe (alone is fine in prose) |
| The short-lived container that mounts a file share for one run | runner (operators only) | Runner (nur Betrieb) | Agent, Helfer |
| The NTFS or NFS permissions of files and folders | permissions | Berechtigungen | ACLs (in the UI), Rechte |
| The optional container that mounts network shares and starts the runners (docs/MOUNTS.md) | mounter | Mounter | Mount-Dienst, Agent |
| A job that writes the newest verified restore point of one file share into a folder of another | copy job | Kopierjob | Sicherungsjob, Spiegel (for the job) |
| Restoring into the share the data came from | original location | ursprünglicher Ort | Quelle |
| A restore point that shows signs of ransomware (docs/RANSOMWARE.md) | suspicious | verdächtig | infiziert, kompromittiert (it is a sign, not a proof) |
| An administrator's verdict that a finding was harmless | false alarm | Fehlalarm | Fehlalarm bestätigen, ignorieren |
| The copy of a SQL Server database the check restores from the repository and drops again; named `<db>__restow_verify_<time>` (docs/BAREMETAL-WINDOWS.md 5.1.7) | check database (its name: check name) | Prüfdatenbank (ihr Name: Prüfname) | Testdatenbank, Verify-DB |
| What the agent reads about the SQL Server instances and databases of a machine and sends with its heartbeat | SQL inventory | SQL-Inventar | SQL-Scan, Datenbankliste |
| The native backup of SQL Server databases by the agent (copy-only fulls, W2a) | native SQL Server backup | native SQL-Server-Sicherung | SQL-Hook, Datenbank-Dump |
| The newest restore point without findings | last clean restore point | letzter unauffälliger Sicherungsstand | letzter sauberer Stand, letzte gute Sicherung |
| A VM or container of Proxmox VE | guest (VM, container) | Gast (VM, Container) | Instanz, Maschine, CT |
| Backups the storage itself refuses to delete or change before a date (S3 Object Lock, docs/STORAGE.md) | immutable backups (immutability) | unveränderbare Backups (Unveränderbarkeit) | WORM-Backups, Immutable, unlöschbar |
| Restow itself not deleting backup files of a directory before a period has passed; no immutability | deletion delay | Löschverzögerung | Sperre, Unveränderbarkeit (for a directory) |
| A Proxmox VE server with the node helper | node | Knoten | Host, Hypervisor (for a node) |
| An IMAP account whose login the server keeps refusing, until an administrator answers whether it was shut down (docs/IMAP.md) | login refused | Anmeldung abgelehnt | Login-Fehler, gesperrt |
| An IMAP account an administrator confirmed as shut down; its login is still checked once a week | account shut down | Konto abgeschaltet | gelöscht, deaktiviert (that is Microsoft 365) |
| A one-time code an admin issues so the recovery ISO can restore one machine on new hardware (docs/BAREMETAL.md 9) | recovery code | Wiederherstellungscode | Recovery-Code, Wiederherstellungsschlüssel, Token (for the code) |
| The six digits the ISO and the web interface both show before the session is released | match number | Prüfzahl | PIN, Bestätigungscode |
| The first 80 bits of the SHA-256 of the instance's TLS public key, typed into the ISO when it does not trust the certificate | instance check value | Prüfwert der Instanz | Fingerprint (alone), Zertifikats-Hash |
| An admin letting a redeemed recovery code read the backups, after comparing the match number | release the session | die Sitzung freigeben (Freigabe der Sitzung) | genehmigen, zulassen |
| Giving an existing machine a new agent secret after a restore or reinstall, with a token of its own (docs/BAREMETAL.md 11) | reconnect (rebind) | wieder anbinden (Wiederanbindung) | neu registrieren, neu einrichten (that makes a new machine) |
| The signed live image that restores a Linux machine from its whole machine backup onto new disks (`restow-recovery_<v>_amd64.iso`, built from the separate work `integrations/recovery`, docs/BAREMETAL.md 8) | recovery ISO | Recovery-ISO | Rettungs-CD, Boot-Stick, Image (for the ISO) |
| What the recovery ISO reports at the end: ten checks with findings and evidence (`restow-verify-v1`, docs/BAREMETAL.md 10.17) | check after the restore | Prüfung nach der Wiederherstellung | Test, Validierung |
| Restoring a whole machine onto new disks (Linux, preview) | bare metal restore | Bare-Metal-Wiederherstellung (ein Rechner wird als Ganzes wiederhergestellt) | Image-Restore, Plattenabbild |

Repository: maintainer decision 2026-10-10, replacing "storage location" /
"Speicherort". German uses the neuter ("das Repository", "des Repositorys") and the
plural "Repositories", as most German IT interfaces do, not the Duden plural
"Repositorys". The code, the API (`/api/v1/storage`) and the technical docs keep the
name storage target. A Restow repository is the storage target as a whole; the restic
repositories of servers, clients and containers are folders inside it
(`endpoints/<id>/`, `pve-guests/<id>/`, `file-shares/<id>/`) and are called
"restic repository" (restic-Repository) where the UI has to name them.

File share: Phase C of docs/FILESHARES.md (2026-10-10). "Freigabe" means a file share
and nothing else, except in "die Sitzung freigeben" / "Freigabe der Sitzung" of a bare metal
recovery (docs/BAREMETAL.md 9.4), which always names the session; the storage mount of the mounter stays "Netzlaufwerk". A copy job of
file shares is labelled "Not a backup: no versions on the target" ("Keine Sicherung:
keine Versionen am Ziel"). Phase D adds the mounter and the copy job rows; the button that starts the
mounter through the updater is "Enable network shares" ("Netzlaufwerke einschalten"), since
the mounter serves both network shares and file shares.

Times are relative where they describe the past ("vor 3 Stunden") and
absolute with the time zone where they plan the future ("morgen, 22:00").

Gendered forms: neutral wording ("Personen", "wer …"), no slashes or stars.
