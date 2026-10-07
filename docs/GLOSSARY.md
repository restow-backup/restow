# Glossary

One word per thing, in the web interface, mails, PDFs, webhooks and docs.
Every user-facing string follows this list; a new term is added here first.
German addresses the reader formally ("Sie") and never names the product
literally (use `{appName}`).

| Thing | English | Deutsch | Not |
| --- | --- | --- | --- |
| A computer with the agent | machine (server, client) | Rechner (Server, Client) | Maschine, Endpoint, Gerät |
| One stored state of a backup that can be restored | restore point | Sicherungsstand | Snapshot, Wiederherstellungspunkt, Sicherung #, Version |
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
| Where backups are stored | storage location | Speicherort | Repository (in the UI), Ziel (alone) |
| A customer organisation in the installation | tenant | Mandant | Kunde, Tenant, Organisation (for a tenant) |
| A person who administers the installation | member (owner, admin, …) | Mitglied (Inhaber, Administrator, …) | Owner, Teammitglied |
| A person of a tenant | tenant user | Benutzer des Mandanten | Kunde |
| The long-term, tamper-evident mail store | archive | Archiv | Journal |
| A network share mounted by the mounter | network share | Netzlaufwerk | Mount, Freigabe (in the UI) |
| A VM or container of Proxmox VE | guest (VM, container) | Gast (VM, Container) | Instanz, Maschine, CT |
| A Proxmox VE server with the node helper | node | Knoten | Host, Hypervisor (for a node) |

Times are relative where they describe the past ("vor 3 Stunden") and
absolute with the time zone where they plan the future ("morgen, 22:00").

Gendered forms: neutral wording ("Personen", "wer …"), no slashes or stars.
