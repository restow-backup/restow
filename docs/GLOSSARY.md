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
| A VM or container of Proxmox VE | guest (VM, container) | Gast (VM, Container) | Instanz, Maschine, CT |
| A Proxmox VE server with the node helper | node | Knoten | Host, Hypervisor (for a node) |

Repository: maintainer decision 2026-10-10, replacing "storage location" /
"Speicherort". German uses the neuter ("das Repository", "des Repositorys") and the
plural "Repositories", as most German IT interfaces do, not the Duden plural
"Repositorys". The code, the API (`/api/v1/storage`) and the technical docs keep the
name storage target. A Restow repository is the storage target as a whole; the restic
repositories of servers, clients and containers are folders inside it
(`endpoints/<id>/`, `pve-guests/<id>/`, `file-shares/<id>/`) and are called
"restic repository" (restic-Repository) where the UI has to name them.

File share: Phase C of docs/FILESHARES.md (2026-10-10). "Freigabe" means a file share
and nothing else; the storage mount of the mounter stays "Netzlaufwerk". A copy job of
file shares is labelled "Not a backup: no versions on the target" ("Keine Sicherung:
keine Versionen am Ziel"). Phase D adds the mounter and the copy job rows; the button that starts the
mounter through the updater is "Enable network shares" ("Netzlaufwerke einschalten"), since
the mounter serves both network shares and file shares.

Times are relative where they describe the past ("vor 3 Stunden") and
absolute with the time zone where they plan the future ("morgen, 22:00").

Gendered forms: neutral wording ("Personen", "wer …"), no slashes or stars.
