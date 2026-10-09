# Proxmox VE backup for Restow: research and design proposal

Status: design for 0.3.0, written 2026-10-03. Phase 1 (section 3) is implemented; what exists and how to run it is in [PVE.md](PVE.md), the helper protocol in [PVE-PROTOCOL.md](PVE-PROTOCOL.md) and the test on a real node in [PVE-HOST-TEST.md](PVE-HOST-TEST.md). Deviations from this design: PVE jobs live in their own table (`pve_jobs`) instead of `backup_jobs.kind = pve`; the worker plans them instead of the scheduler; container repositories lie under `pve-guests/<guest id>/` instead of `endpoints/`; GC counts one reference per distinct chunk and restore point (the delta scheme of 2.4 remains a follow-up, R7).
Audience: Restow maintainers. Scope: Proxmox VE (PVE) VMs and LXC containers, per the website roadmap:

> "Virtual machines and LXC containers from Proxmox VE 8.4 or newer, through Proxmox's official backup
> interface: only changed blocks leave the host, straight into your Restow repositories. Restore points
> are immutable, and a restore creates a new VM beside the original. Onboarding is an API token plus
> one command per node."

The i18n text already in the repo (`packages/i18n/resources/*/endpoints.json`, key `proxmox`) says the same.

How this document marks evidence:

- **[V]** means verified in Proxmox source code. I read the official Proxmox git repositories through
  their read-only GitHub mirrors (`github.com/proxmox/*`, cloned 2026-10-03; commits listed in
  section 9). The cited file and line numbers refer to those commits.
- **[S]** means taken from a web search result snippet whose page I could not open (see the note below).
- **[I]** means inferred or from memory. It needs a check on a real cluster before anything depends on it.

Note on sources: the egress proxy of this research session blocked every `*.proxmox.com` host
(pve.proxmox.com, git.proxmox.com, lists/lore, forum, bugzilla), as well as qemu.readthedocs.io and
helpcenter.veeam.com. I therefore read the canonical code from the GitHub mirrors, which hold the
same git history as git.proxmox.com. Release-note wording (for example, whether Proxmox ever called
the API a "technology preview") could not be checked against pve.proxmox.com and is marked as such.

---

## 0. Summary and recommendation

1. **The Backup Provider API exists and is the right foundation.** It shipped with PVE 8.4 (April 2025;
   libpve-storage-perl 8.3.5, qemu-server 8.3.10, pve-container 5.2.5, pve-manager 8.3.6) [V]. It is
   still present and unchanged in current PVE 9.2 sources (storage `APIVER 15`, `APIAGE 6`; the API was
   introduced with storage API version 11) [V]. I found no "experimental" or "preview" marker in the
   source documentation (`PVE::BackupProvider::Plugin::Base`) or in `ApiChangeLog` [V]. I could not
   verify the release notes' wording.
2. **A provider must be a Perl storage plugin** in `/usr/share/perl5/PVE/Storage/Custom/` that declares
   `features => { 'backup-provider' => 1 }` and returns a provider object from `new_backup_provider()` [V].
   Restow therefore needs a **thin Perl shim** that calls a **Go helper (`restow-pve`)**. The Go helper does
   the real work, uses only the standard library, and follows the agent's build, sign and update chain.
   The shim subclasses AGPL-3+ code from pve-storage, so its license needs a maintainer decision (section 2.2).
3. **VMs:** use the mechanism `nbd` with the per-device dirty bitmap. QEMU exports a point-in-time
   "snapshot access" plus the bitmap (granularity 4 MiB) over a Unix-socket NBD export [V]. The helper reads
   only the dirty 4 MiB blocks, hashes them, uploads blocks whose hash changed, and the server commits a
   **per-disk block map**. Each map is a complete list of all blocks: unchanged entries point to the
   chunks of the previous restore point, so **every restore point is a synthetic full**.
4. **Store VM blocks in Restow's own chunk store, with server-side ingest.** The node sends plaintext
   blocks over TLS, and the API encrypts and packs them with the tenant DEK, as the server already does
   for mail. Do not use restic for VM disks: restic cannot apply a dirty-block delta to a previous
   snapshot without re-reading the whole disk.
5. **Containers:** use the mechanism `directory`, which is the only container backup mechanism [V]. The
   helper runs **restic** over that directory into a per-guest restic repository behind the existing
   append-only restic-REST endpoint, the same model as the endpoint agent. Restore uses the `directory`
   mechanism with a `restic mount`ed snapshot (or a temporary restore). PVE refuses to restore
   privileged containers from external providers [V].
6. **Restore** goes through PVE's own restore path (`POST /nodes/{node}/qemu` or `/lxc` with
   `archive=<restow-storage>:backup/...`) into a **new VMID** inside a dedicated pool. For VMs the helper
   serves the synthetic full image as an NBD URI to `qemu-img convert` [V that NBD URIs are allowed;
   [I] that it works end to end]. Live restore is not supported for providers [V].
7. **Fleecing is mandatory** for provider VM backups ("cannot setup backup access without fleecing") [V].
   As a consequence, **VM templates cannot be backed up** through the provider API (fleecing is forced off
   for templates) [V]. Onboarding has to pick a thin-provisioned fleecing storage on every node.
8. **Bitmaps are in-memory QEMU state** named after the target (`snapshot-access:<storeid>`) [V]. They are
   lost when the QEMU process ends (VM stop/start, a "stop" mode backup, a backup of a powered-off VM that
   PVE starts paused) [V for the logic, I for every case]. Live migration probably carries them along
   (QEMU `dirty-bitmaps` migration capability) [I]. After a loss, the helper reads the whole disk but still
   uploads only blocks whose hash changed. "Only changed blocks leave the host" still holds; "only changed
   blocks are read" does not.
9. **Realistic 0.3.0 (phase 1):** node helper and enrollment, inventory, VM backup (nbd and bitmap, full
   re-read fallback), CT backup (restic), restore as new VM/CT, retention, verify (restore-test light),
   Linux amd64 only, one tenant per PVE cluster. **Later:** S3 Object Lock for packs, single-file
   restore from VM images, privileged CT restore, multi-tenant clusters, PBS-style live restore (not
   possible through this API today).

---

## 1. Research findings

### 1.1 Status and versions

| Item | Finding | Evidence |
| --- | --- | --- |
| First release | libpve-storage-perl 8.3.5 (2025-04-06): "add new_backup_provider plugin method to allow creating a storage that implements backup functionality that natively integrates into PVE"; qemu-server 8.3.10 (2025-04-06): "implement backup and restore operations for external provider storage plugins"; pve-container 5.2.5 (2025-04-07); pve-manager 8.3.6 (2025-04-08). These are the packages of the PVE 8.4 release. | [V] `debian/changelog` of each repo |
| Storage API version | Introduced with `APIVER` 11 (`features` in plugindata, `new_backup_provider()`, sensitive properties). Current source: `APIVER 15`, `APIAGE 6`, so plugins declaring api 9..15 load. No provider-related API change since version 11. | [V] pve-storage `ApiChangeLog`, `src/PVE/Storage.pm:44-48` |
| Stability label | No preview or experimental note in the in-source docs. Press coverage of 8.4 describes it as "an API simplifying the development of plugins by external backup solution providers ... fully integrated in the backup stack and in the web interface" [S]. Whether the 8.4 roadmap called it a tech preview: **unverified** (pve.proxmox.com blocked). | [V]/[S] |
| Fixes since | e.g. qemu-server 9.0.x "fix #6882: backup provider api: fix backup with TPM state by correctly generating node name". The API is maintained in 9.x. | [V] qemu-server changelog |
| PVE 8 lifecycle | PVE 8 (Debian 12) is at or near end of life by now [I]. Supporting "8.4 or newer" costs little because the API is identical, but test matrix effort should go to 9.x. | [I] |

### 1.2 Registration: a storage plugin with the `backup-provider` feature

- Third-party plugins are loaded from `/usr/share/perl5/PVE/Storage/Custom/*.pm`. Each must derive from
  `PVE::Storage::Plugin`, provide `api()`, and its API version must lie within `APIVER-APIAGE..APIVER`;
  otherwise it is skipped with a warning [V] (`src/PVE/Storage.pm:69-105`).
- A provider plugin returns `features => { 'backup-provider' => 1 }` in `plugindata()` and implements
  `new_backup_provider($class, $scfg, $storeid, $log_function)`, which returns a blessed object of a class
  deriving from `PVE::BackupProvider::Plugin::Base` [V] (`ApiChangeLog` "Version 11";
  `src/PVE/Storage/Plugin.pm:2624-2636`).
- vzdump detects such a storage via `storage_has_feature($cfg, $storage, 'backup-provider')`. It then
  uses the provider instead of writing `.vma` or `.tar` files, or instead of PBS [V]
  (`pve-manager PVE/VZDump.pm:213-216`).
- "The rest of the plugin methods, e.g. listing content, providing usage information, etc., follow the
  same API as usual" [V]. Restow's plugin must therefore also implement `list_volumes`, `parse_volname`,
  `status`, `activate_storage` and related methods so that backups appear in the PVE UI and restores can
  be started there.
- Sensitive storage properties go to `/etc/pve/priv/storage/` (cluster-wide pmxcfs) [V]. Restow should
  **not** use this for node credentials (see 2.8).
- `storage.cfg` is cluster-wide. The Perl module must be installed on **every** node that may use the
  storage, or the storage can be limited with the `nodes` option [I, standard PVE behaviour].

### 1.3 The Backup Provider API (verbatim method set)

Source: `pve-storage/src/PVE/BackupProvider/Plugin/Base.pm` (1147 lines of POD and stubs) [V].

**Backup side.** Call order, quoted: "First, job_init() is called ... Then for each guest backup_init()
followed by backup_vm() or backup_container() and finally backup_cleanup(). Afterwards job_cleanup() is
called. For containers, there is an additional backup_container_prepare() call while still privileged."

| Method | Purpose and key parameters |
| --- | --- |
| `new($class, $storage_plugin, $scfg, $storeid, $log_function)` | Constructor; `$log_function->('info'/'warn'/'err', $msg)` writes to the PVE task log. |
| `provider_name()` | Name shown in logs. |
| `job_init($start_time)` / `job_cleanup()` | Per vzdump job; check server availability, open connection. Cleanup runs on success and failure. |
| `backup_init($vmid, $vmtype, $start_time)` returns `{ 'archive-name' => ... }` | Archive name, chars of `SAFE_CHAR_CLASS_RE` plus `/` and `:`. `$vmtype` is `qemu` or `lxc`. |
| `backup_get_mechanism($vmid, $vmtype)` | Returns `nbd` or `file-handle` (qemu) and `directory` (lxc). Implementing one per guest type is enough. |
| `backup_vm_query_incremental($vmid, $volumes)` | `$volumes->{$device}{size}`; returns `{ $device => 'new' or 'use' }`. Devices left out get no bitmap and existing bitmaps are discarded. "If the size does not match what you expect on the backup server side, the bitmap will not exist anymore on the QEMU side." |
| `backup_vm($vmid, $guest_config, $volumes, $info)` | Raw guest config; per device `size`, `bitmap-mode` (`none`/`new`/`reuse`); for `nbd`: `nbd-path` (Unix socket) and `bitmap-name`; for `file-handle`: `file-handle` and `next-dirty-region`. `$info`: `bandwidth-limit` (bytes/s), `firewall-config`. |
| `backup_container_prepare($vmid, $info)` | Runs privileged; prepare credentials for the unprivileged call. |
| `backup_container($vmid, $guest_config, $exclude_patterns, $info)` | Runs **as the ID-mapped container root** (e.g. uid 100000) in a forked context, so changes to `$self` are lost. `$info`: `directory`, `sources` (mount points incl. "."), `backup-user-id`, `bandwidth-limit`, `firewall-config`. |
| `backup_cleanup($vmid, $vmtype, $success, $info)` returns `{ stats => { 'archive-size' } }` | Called on success and failure; `$info->{error}`. |
| `backup_handle_log_file($vmid, $filename)` | Gets the task log, for example to upload it. |

Important text on the VM snapshot access, quoted [V]:

> "If a bitmap is used, the 'snapshot access' is really only the dirty parts of the image. You have to
> query the bitmap to see which parts of the image are accessible/present. Reading ... outside of the
> dirty parts of the image will result in an error. In particular, if there were no new writes since
> the last successful backup ... the image cannot be accessed at all, you can only query the dirty
> bitmap."
>
> "After backing up each part of the disk, it should be discarded in the export to avoid unnecessary
> space usage on the Proxmox VE side (there is an associated fleecing image)."

**Restore side** [V]:

| Method | Purpose |
| --- | --- |
| `restore_get_mechanism($volname)` returns `($mechanism, $vmtype)` | `qemu-img` for VMs; `tar` or `directory` for CTs. |
| `archive_get_guest_config($volname)` / `archive_get_firewall_config($volname)` | Raw config contents (also used for the "show configuration" view in PVE). |
| `restore_vm_init($volname)` returns `{ $device => { size } }` / `restore_vm_cleanup` | Per-archive VM setup and teardown. |
| `restore_vm_volume_init($volname, $device, $info)` returns `{ 'qemu-img-path' => $path }` / `restore_vm_volume_cleanup` | "A path to the volume that qemu-img can use as a source for the qemu-img convert command. For example, the path could also be an NBD URI. The image contents are interpreted as being in raw format." |
| `restore_container_init($volname, $info)` returns `{ 'tar-path' }` or `{ 'archive-directory' }` / `restore_container_cleanup` | tar: a (possibly compressed) tar file; directory: PVE streams it with `tar cpf - ... | tar x` into the new rootfs. |

### 1.4 How PVE drives a VM backup through a provider [V]

`qemu-server src/PVE/VZDump/QemuServer.pm`, `archive_external()` (line 1502 ff.):

1. `enforce_vm_running_for_backup()`: a stopped VM is **started paused** just to read its disks (l. 1167).
2. QEMU must report `backup-access-api` in `query-proxmox-support`; otherwise PVE fails with "backups
   access API required ... not supported by the running QEMU version ... the VM has been restarted". A VM
   started before the QEMU upgrade must be restarted once.
3. **Fleecing is required**: `check_and_prepare_fleecing(...)`, then `die "cannot setup backup access
   without fleecing\n" if !$fleecing`. Fleecing is forced off for templates (`!$is_template`, l. 679), so
   **templates cannot be backed up through a provider**.
4. `backup_get_mechanism()`, then `backup_vm_query_incremental()`. Device names are QEMU drive ids (e.g.
   `drive-scsi0`; TPM appears as `drive-tpmstate0-backup`).
5. `qga_fs_freeze()` (if the agent is enabled with `freeze-fs` not 0, the agent is running, and the
   filesystems are not already frozen), then QMP `backup-access-setup` with `target-id =
   "snapshot-access:<storeid>"`, then thaw. The freeze window covers only the setup call.
6. The NBD server is started on `/run/qemu-server/<vmid>.backup-access.<pid>/<vmid>-nbd.backup-access`. One
   **writable** export per device (writable so the provider can discard). If a bitmap is used it is
   attached to the export, so a client sees it as the NBD metadata context `qemu:dirty-bitmap:<name>`.
   The code comment says "the first bit of 'type' is set when the bitmap is dirty".
7. `backup_vm()` is called. If it returns, the teardown is flagged `success`; if it dies, `success=0`.
8. `backup-access-teardown(success)`: on success QEMU clears the bitmap and merges the background bitmap
   (writes during the backup); on failure it merges, so nothing is lost (pve-qemu patch 0042 commit
   message) [V].

Bitmap details from pve-qemu `debian/patches/pve/0042-PVE-backup-implement-backup-access-setup-and-teardow.patch` [V]:

- The bitmap name equals the target id (`const char *bitmap_name = target_id;`), so there is **one
  bitmap per (device, PVE storage id)**. Two Restow jobs that write to the same PVE storage share it.
- Granularity: `PROXMOX_BACKUP_DEFAULT_CHUNK_SIZE` = 4 MiB (proxmox-backup-qemu `src/lib.rs:30`).
- Modes: `none` (remove bitmap), `new` (recreate, all dirty), `use` (reuse, or create all-dirty if missing,
  reported as `missing-recreated`). PVE maps the QEMU actions to the provider's `bitmap-mode`: `used`
  becomes `reuse`; `new`, `invalid` and `missing-recreated` become `new`; `not-used*` becomes `none`.
- "There can only be one regular backup or one active backup access at a time" per VM.
- Bitmaps are non-persistent QEMU objects. pve-qemu has patches that migrate dirty bitmaps with live
  migration and savevm (0031, 0032), and qemu-server enables the `dirty-bitmaps` migration capability when
  QEMU reports `pbs-dirty-bitmap-migration` (`QemuMigrate/Helpers.pm:116-130`) [V]. Whether the
  backup-access bitmap survives a live migration in practice: **[I], must test.**

When the provider should expect a full read (`bitmap-mode` `new`): first backup; VM was powered off
(started paused for backup); VM was shut down and started again (a reboot that goes through PVE restarts
QEMU [I]); `stop` mode backups (they stop the VM) [I]; disk resized (size mismatch); disk detached or
re-attached; QEMU upgraded and VM restarted; possibly a disk move or storage migration [I]; the provider
asked for `new`.

### 1.5 How PVE drives a container backup [V]

`pve-container src/PVE/VZDump/LXC.pm:404-445`:

- Only mechanism `directory` is accepted. `$info = { directory => $snapdir, sources => [...],
  'backup-user-id' => $root_uid }`.
- `backup_container_prepare()` runs as root, then `backup_container()` runs inside
  `PVE::LXC::Namespaces::run_in_userns(..., $id_map)` for unprivileged CTs, so file owners appear as
  the container sees them.
- Privileged CTs: warning "external backup of privileged container can only be restored as unprivileged
  which might not work in all cases"; restore then refuses: `die "refusing to restore privileged
  container backup from external source\n" if !$conf->{unprivileged}` (`LXC/Create.pm:238`).
- Container modes are vzdump's usual ones (documented in `pve-docs/vzdump.adoc`):
  - `snapshot`: needs every backed-up volume on snapshot-capable storage (ZFS, LVM-thin, Ceph RBD, Btrfs
    [I for the list; V for the requirement]). Otherwise vzdump logs "mode failure - some volumes do not
    support snapshots" and **falls back to `suspend`** (`PVE/VZDump.pm:1079-1088`).
  - `suspend`: rsync to `tmpdir`, suspend, second rsync, resume. Needs temporary space the size of the CT.
  - `stop`: stops the CT for the whole backup.
  - Mount points other than rootfs are only included with `backup=1`; bind and device mounts never are.

### 1.6 Restore through PVE [V]

- VM (`qemu-server src/PVE/QemuServer.pm:7118 restore_external_archive`): `live` restore is refused
  ("live restore from backup provider is not implemented"). PVE reads the guest config, allocates the
  disks on the target storage, and runs `qemu-img convert` from `qemu-img-path` (raw) per disk after a
  safety check `file_size_info($source_path, undef, 'raw', 1)`. It rewrites the config (`unique` regenerates
  MACs). The **firewall config is copied to `/etc/pve/firewall/<vmid>.fw`**.
- CT (`pve-container src/PVE/LXC/Create.pm:235`): `tar` (regular file required) or `directory` (tarred
  and extracted with the ID mapping of the new CT).
- Both are started from the normal create-guest APIs with `archive=<storeid>:<volname>`.

### 1.7 Permissions [V]

From pve-manager `PVE/API2/VZDump.pm`, qemu-server `API2/Qemu.pm`, pve-container `API2/LXC.pm` and
pve-storage `check_volume_access`:

| Action | Required privileges |
| --- | --- |
| List nodes, guests, storages | `Sys.Audit` on `/nodes/{node}`; `VM.Audit` on `/vms/{vmid}` (list filters by it); `Datastore.Audit` on `/storage/{id}` [V for VM.Audit filter; I for the other paths] |
| `POST /nodes/{node}/vzdump` | "`VM.Backup` permissions on any VM, and `Datastore.AllocateSpace` on the backup storage (and fleecing storage when fleecing is used)". `bwlimit`/`performance`/`ionice` need `Sys.Modify` on `/`; `script`, `dumpdir`, `tmpdir`, `job-id` are root@pam only. |
| Read a backup volume for restore | `Datastore.AllocateSpace` on the storage **and** `VM.Backup` on the owner VM (`check_volume_access`, vtype `backup`) |
| Restore as a **new** VM/CT | `VM.Allocate` on `/vms/{newid}` **or on `/pool/{pool}`** if `pool` is given; `Datastore.AllocateSpace` on the target storage; `SDN.Use` on the bridges or vnets in the config (`check_bridge_access`) and access to mapped devices (`check_mapping_access`); `VM.PowerMgmt` only if `start=1` |
| Create PVE backup jobs (`/cluster/backup`) | Not needed if Restow schedules itself (recommended). |

API tokens: `pveum user token add <user> <name> --privsep 1` gives a token whose rights are the
intersection of the user's ACLs and the token's own ACLs [I, standard PVE behaviour, documented in
`pve-docs/pveum.adoc`].

### 1.8 vzdump hook scripts [V]

Phases (`pve-manager/vzdump-hook-script.pl`): `job-init`, `job-start`, `job-end`, `job-abort`,
`backup-start`, `backup-end`, `backup-abort`, `log-end`, `pre-stop`, `pre-restart`, `post-restart`. With a
provider storage, `backup-start` runs after `backup_init()` has set the target name. Hooks are root-only
(`script` parameter) and are not needed for the provider design.

### 1.9 Example and third-party implementations

- **Proxmox examples**: `pve-storage-examples` repository with a `DirectoryExample` and a `Borg` backup
  provider (`src/PVE/BackupProvider/Plugin/{DirectoryExample,Borg}.pm`), initial commit posted
  2025-04 [S]: <https://lists.proxmox.com/pipermail/pve-devel/2025-April/070210.html>; the earlier POC
  "Borg example plugin": <https://lists.proxmox.com/pipermail/pve-devel/2025-April/069715.html>. Not
  mirrored on GitHub; read at <https://git.proxmox.com/?p=pve-storage-examples.git> (blocked here).
  **These are the reference to port from**: the DirectoryExample covers `nbd` and `file-handle`, bitmaps,
  `directory` CT and both restore mechanisms [S/I].
- **Bareos** discussed integrating via `new_backup_provider()` on pve-devel (2025-04) [S].
- **Veeam** ("Veeam Plug-in for Proxmox VE") uses worker VMs in its own architecture [S]. Whether it
  uses the provider API: unverified. Vinchin and Storware advertise "agentless" PVE backup via the PVE
  API [S]. I found no open-source production provider to reuse.

### 1.10 Alternatives to the provider API

| Option | How | Pros | Cons |
| --- | --- | --- | --- |
| **A. Backup Provider API (recommended)** | Perl storage plugin plus helper | Official, supported in 8.4 and 9.x; UI integration (backup jobs, restore dialog, config view); dirty bitmaps; fleecing; fs-freeze handled by PVE; CT ID mapping handled by PVE | Perl plugin per node; fleecing storage required; templates unsupported; no live restore; bitmap volatile; plugin runs inside PVE daemons (bugs hurt PVE) |
| B. vzdump to a dir/NFS storage plus hook script | vzdump writes `.vma.zst` or `.tar.zst`; a `backup-end` hook uploads and deletes it | Works on every PVE version; no Perl | Full read **and** full local write every time; needs scratch space the size of the VM; no incremental; `.vma` would need parsing (format documented in pve-qemu `vma_spec.txt` [I]); `script` param is root@pam only |
| C. Emulate a PBS server | Restow implements the PBS HTTP/2 backup protocol and the `.fidx`/`.didx`/blob formats; PVE's built-in `pbs` storage type talks to it | Native PVE UX incl. live restore, file restore, persistent "known chunks"; nothing to install on the node | Protocol not formally specified, moving target, AGPL reference implementation (proxmox-backup, proxmox-backup-qemu are **AGPL-3+** [V `debian/copyright`]; a clean-room reimplementation is legally fine, but copying code is not compatible with Apache-2.0 core); large surface; Proxmox may break compatibility without notice; the data path is PVE pushing into Restow (needs inbound reachability of Restow from PVE, which is normally fine) |
| D. Direct QMP and bitmaps | Helper talks to `/var/run/qemu-server/<vmid>.qmp`, creates its own bitmaps and NBD exports | Full control | Unsupported; races with qemu-server locks, qmeventd, migrations and PVE's own backups; would break on PVE updates. **Not acceptable.** |

Option C is a viable **later** strategy for live restore and file restore. It would be a separate
project (estimated as large as the whole 0.3.0 scope) [I].

### 1.11 Consistency

- **VMs** [V]: PVE calls `guest-fsfreeze-freeze`/`thaw` around `backup-access-setup` when `agent: 1` and
  `freeze-fs` is not 0 (aliases `freeze-fs-on-backup`, `guest-fsfreeze`) and the agent answers. Otherwise
  the result is crash-consistent. Windows needs VSS through the guest agent; the docs warn when other
  in-guest backup software is used (`vzdump.adoc` "qm_qga_fsfreeze") [V]. Storage type does not matter:
  "{pve} live backup provides snapshot-like semantics on any storage type" [V].
- **CTs** [V]: `snapshot` mode on ZFS, LVM-thin, RBD or Btrfs [I list] gives a consistent filesystem
  snapshot (the CT is frozen while the snapshot is taken). On `dir`/NFS/CIFS-backed CTs it falls back to
  `suspend` (two rsync passes, short suspend, needs tmpdir space). `stop` gives full consistency with
  downtime. Databases inside CTs still need dumps for application consistency. Restow can surface
  "your CT runs on dir storage, so it falls back to suspend" from the task log.

---

## 2. Design

### 2.1 Architecture

```
PVE node (one per node)                                              Restow instance
+------------------------------------------------------+            +--------------------------------------+
| pvedaemon / vzdump worker (root)                     |            | Caddy                                |
|   PVE::Storage::Custom::RestowPlugin  (Perl shim)    |            |  /agent/v1/*      helper API (JSON)  |
|     new_backup_provider -> RestowProvider (Perl)     |   HTTPS    |  /agent/pve/v1/*  block ingest/read  |
|       every callback = exec restow-pve <verb>  ------+---------->|  /agent/restic/:repo  restic REST v2 |
|                          (JSON over stdin/stdout,    | outbound   | apps/api  (auth, authz, ingest ->    |
|                           fds and sockets passed)    | only       |   ChunkWriter, tenant DEK)           |
|                                                      |            | apps/worker (retention, verify, GC)  |
| restow-pve (Go, stdlib)                              |            | apps/scheduler (plans VM/CT jobs)    |
|   service: heartbeat, tasks, inventory               |            | Postgres: pve_clusters, pve_nodes,   |
|   NBD client (backup) / NBD server (restore)         |            |   pve_guests, pve_disks, runs ...    |
|   restic (pinned, same binary as the agent)          |            | Storage target: tenants/<tid>/packs, |
|   local PVE API client -> https://127.0.0.1:8006 ----+--+         |   manifests; endpoints/<repo>/ restic|
|   with API token (least privilege)                   |  |         +--------------------------------------+
+------------------------------------------------------+  |
| QEMU (snapshot-access, bitmap, NBD export via unix)  |<-+ vzdump / create-from-archive via the local PVE API
+------------------------------------------------------+
```

Key decisions:

1. **Outbound only, like the agent.** The Restow server never calls the PVE API. The node helper polls
   for tasks (heartbeat) and calls the **local** PVE API with the token. This keeps Restow's
   "no inbound port" principle (docs/AGENT.md "Grundsätze"). It works for MSPs whose PVE sits behind
   NAT, and a compromised Restow server cannot issue arbitrary PVE API calls. It can only queue the
   helper's small set of verbs, and the helper validates each one.
2. **The PVE API token stays on the node** (root-only state file), never in Restow. Reason: the token can
   create VMs in the restore pool. Keeping it local limits the damage a compromised Restow can do to
   "request a backup or a restore" (section 2.8).
3. **Restow schedules.** The scheduler plans per-guest backup runs from Restow jobs (kind `pve`). The
   helper starts them as `POST /nodes/{local}/vzdump` with `vmid`, `storage=<restow storeid>`,
   `mode` (default `snapshot`), `fleecing=enabled=1,storage=<node fleecing storage>`, `notes-template`.
   Backups that an admin starts from the PVE UI (or a PVE backup job) onto the Restow storage also work.
   They are reported as runs with origin `pve` and keep the same block-map chain.
4. **One helper process tree per node, with no long-lived state in Perl.** Each Perl callback runs
   `restow-pve provider <verb>` with a JSON request on stdin and gets JSON back on stdout. Logs go to
   stderr and are relayed to `$log_function`. `backup_vm` is one long call: Go reads the NBD socket path
   from the request. State that must cross callbacks (`archive-name`, run id) goes into a per-job file
   under `/run/restow-pve/` (0700). This is required anyway for `backup_container`, which runs forked and
   unprivileged.

### 2.2 Components

**`restow-pve` (Go).** Lives in `agent/` as a second command (`agent/cmd/restow-pve`). It shares
`internal/api`, `internal/release`, `internal/update`, `internal/state`, `internal/redact` and
`internal/lock`, is built by `agent/build.sh` for the **linux-amd64** target only (PVE does not support
arm64 officially [I]), and its binary goes into the same signed `SHA256SUMS`. It needs no third-party
module:

| Needed | Stdlib approach | Note |
| --- | --- | --- |
| NBD client (fixed newstyle handshake, `OPT_STRUCTURED_REPLY`, `OPT_SET_META_CONTEXT` for `qemu:dirty-bitmap:<name>`, `OPT_GO`, `CMD_READ`, `CMD_BLOCK_STATUS`, `CMD_TRIM`, `CMD_DISC`) | `net` (unix socket), `encoding/binary` | About 1,000 LOC plus tests. The NBD protocol spec is public (NetworkBlockDevice/nbd `doc/proto.md`). Test against `qemu-nbd` and `qemu-storage-daemon` in CI. |
| NBD server (restore: read-only export of a synthetic full; `OPT_GO`, `CMD_READ`, optional `BLOCK_STATUS` for zero runs) | same | qemu-img connects via `nbd+unix:///<dev>?socket=...` |
| SHA-256 per 4 MiB block, zero detection | `crypto/sha256`, `bytes` | SHA-NI makes this cheap. |
| PVE API client | `net/http`, `crypto/tls` | Talks to 127.0.0.1:8006. The node certificate is self-signed `pve-ssl.pem`, signed by the cluster CA `/etc/pve/pve-root-ca.pem`; pin that CA. |
| restic | the pinned restic binary already shipped | Used for CTs. |

If writing an NBD client turns out too costly, the fallback is mechanism `file-handle`: PVE then
provides an `nbdfuse` file and `next-dirty-region` via `nbdinfo` (needs package `libnbd-bin` on the node
[V]). That is slower (FUSE, O_DIRECT) and adds an apt dependency. **No third-party Go module is
needed in either case.**

**Perl shim (`RestowPlugin.pm`, `RestowProvider.pm`).** About 400 to 600 lines. It contains no
crypto and no network code; it only turns callbacks into helper calls. Two points:

- *License:* it must `use base qw(PVE::Storage::Plugin)` and `PVE::BackupProvider::Plugin::Base`, which
  are **AGPL-3+** [V `pve-storage/debian/copyright`]. AGPL is not on Restow's allowlist
  (`scripts/ci/license-policy.json`). Options: (a) ship the shim as a separate work under AGPL-3.0-or-later
  (it is a plugin loaded into an AGPL program, much like Proxmox's own example plugins), keep the Go
  helper Apache-2.0 (separate program, exec boundary); (b) seek legal advice on whether subclassing via
  Perl `use base` makes a derivative work. **Maintainer decision required before 0.3.0.**
- *Robustness:* `status()` is polled by `pvestatd` every few seconds on every node [I]. It must return
  cached values from a local file the helper maintains and must never block on the network. `list_volumes`
  likewise reads a local cache, refreshed by the helper and on demand with a short timeout.
  `free_image`/volume removal and `prune_backups` refuse with a clear message ("retention is managed in
  Restow").

**Server.** New module `apps/api/src/features/pve` and `packages/core/src/pve`, jobs under
`apps/worker/src/pve`, schema in `packages/db`. It reuses enrollment, heartbeat, tasks, runs, failure
causes, audit, rate limits and the restic-REST endpoint (for CT repositories).

### 2.3 Backup flow (VM)

```
scheduler -> task backup{guest:101} on helper of the node that hosts 101 (inventory says where)
helper -> POST /api2/json/nodes/<node>/vzdump {vmid:101, storage:"restow", mode:"snapshot",
          fleecing:"enabled=1,storage=<fleecing>"}                    (local PVE API, token)
vzdump -> job_init           -> restow-pve provider job-init   -> POST /agent/pve/v1/runs (open run)
       -> backup_init(101)   -> archive-name "backup/vm/101/2026-10-03T22:00:00Z"
       -> backup_get_mechanism -> "nbd"
       -> backup_vm_query_incremental({drive-scsi0:{size}})
            helper asks server: last committed snapshot of (cluster, 101, drive-scsi0)?
            same size and chain intact -> "use"; otherwise "new"
       -> backup_vm(... nbd-path, bitmap-name, bitmap-mode reuse|new|none)
            for each device:
              BLOCK_STATUS on qemu:dirty-bitmap:<name>  -> dirty 4 MiB extents
              (mode new|none: all extents)
              READ extent -> per 4 MiB block: zero? sha256 == previous map[i]? else upload
              TRIM extent after the server acknowledged the blocks (frees fleecing space)
            POST commit {device -> changed entries, size, bitmap-mode, config, fw}
            server builds the full map = previous map + changes, seals manifest, records snapshot
            helper returns only after the commit is acknowledged
       -> backup_cleanup(success)  -> stats {archive-size}
       -> backup_handle_log_file   -> upload log tail to the run
       -> job_cleanup
```

Correctness rules (bitmap and chain):

1. **The helper returns from `backup_vm` only after the server has durably committed the restore point.**
   Returning tells PVE "success", QEMU then clears the bitmap [V], and the changes are no longer
   tracked anywhere else.
2. If anything fails before commit, `backup_vm` dies and QEMU merges the bitmap back [V]. The next run
   reuses it.
3. A commit that the server receives but whose acknowledgement the helper loses must be idempotent
   (commit id chosen by the helper). On retry the server answers "already committed". If the helper
   cannot learn the outcome, it **dies**. A spare full-read on the next run is cheaper than a broken chain.
4. `backup_cleanup($success=0)` after a successful `backup_vm` (for example, a later failure in vzdump)
   must **not** delete the committed snapshot, because the bitmap was already cleared.
5. `query_incremental` returns `use` only if the server's latest committed snapshot for that (guest,
   device) was written **through the same PVE storage id**, its size equals the current size, and the
   helper's local journal says the last backup of that device through this storage id was that snapshot.
   Otherwise it returns `new`. The bitmap name is per storage id [V], so all Restow jobs for a cluster
   must use one PVE storage id per tenant. Two storages for the same guest would each get their own
   bitmap, which is safe but wasteful.
6. Verified-full safety net: every N-th backup (default 30) or on request, ask for `new` (full read,
   upload still only changed hashes). This catches silent bitmap bugs. The UI calls it "verify read".

Stopped VMs: PVE starts them paused, so the bitmap is always `new` and the whole disk is read every
time [V/I]. Uploads are still only the blocks whose hash changed, which for a powered-off VM means none.
Document this ("backups of powered-off VMs read the whole disk locally but transfer almost nothing").

### 2.4 Data format for VM disks in Restow repositories

**Block size 4 MiB**, aligned to the QEMU bitmap granularity [V]. The last block may be short.

**Ingest (server side).** `PUT /agent/pve/v1/runs/:run/blocks` carries a batch of up to 16 blocks as a
binary frame: device index, block index, length, sha256, bytes. The server

1. verifies sha256(plaintext) against the claim (as the restic route verifies names) and rejects
   mismatches,
2. passes each block to the existing `ChunkWriter.write()` as one object. It is FastCDC-chunked into
   chunks of 256 KiB to 4 MiB, encrypted with AES-256-GCM, packed into 64 MiB packs, and deduplicated
   per tenant via HMAC ids,
3. returns, per block, the stored chunk id list. That list is never sent to the node; the server keeps
   it in the run's staging table.

The chunk format, crypto, packs, key rotation, GC model and standalone restore stay as they are. Only
new manifest and object types are added.

**Manifest of a VM restore point** (sealed manifest format 2, NDJSON). The header names the kind
`pve-vm`, cluster id, VMID, node, time, PVE version, the bitmap modes used, the base snapshot id, and the
guest config plus firewall config (both are small; they could also be objects). Then one object per disk:

```json
{"path":"disk/drive-scsi0","size":107374182400,"blockSize":4194304,
 "map":{"chunks":["<stored id>", "..."],"sha256":"<of the map plaintext>","entries":25600},
 "zeroBlocks":18211,"changedBlocks":37,"bitmapMode":"reuse"}
```

The **block map** is itself a binary object stored through `ChunkWriter`. Per block it holds one
fixed-size record: flags (zero / present), plaintext sha256 of the 4 MiB block, and a reference into a
deduplicated list of stored chunk ids. 100 GiB is 25,600 blocks, about 1 to 2 MiB of map. Consecutive
maps differ in a handful of records, so CDC over the map deduplicates nearly all of it between restore
points. **Every manifest contains the complete map.** No restore point depends on a previous manifest
at read time, so retention may delete any restore point without rebasing ("synthetic full").

**Previous map for the helper.** The helper needs the previous per-block sha256 values to skip
unchanged rewrites. It caches them locally (`/var/lib/restow-pve/maps/<vmid>/<device>`, root 0600,
about 32 bytes per block) and validates the cache against the map sha256 that the server returns in
`query_incremental`. If the cache is missing, the helper fetches the hash column of the latest map from
the server.

**Zero blocks** are not stored. Restore writes them as holes, so `qemu-img convert` keeps the target
sparse (`is-zero-initialized` / sparseinit [V]).

**Garbage collection and reference counting.** Today's GC counts references in Postgres per snapshot
and chunk. A 1 TiB disk would add about 262k to 1M reference rows per restore point, which is too
much. Proposal: reference **map chunks and a per-snapshot "chunk set" digest** instead. GC does a
mark phase over the maps of active snapshots (streaming, tenant by tenant) and counts the result into
the existing refcount at commit time as deltas: `+added_chunks`, `-removed_chunks` versus the base map.
This needs a design spike (risk R7).

**Compression.** The chunk format (`RSRC` v1) has no compression [V repo `packages/core/src/crypto.ts`].
VM disks compress well (zero runs are already skipped, but OS and log data are not). Option: chunk format
v2 with a zstd flag inside the sealed plaintext (Node ≥ 22.15 / 23.8 has zstd in `zlib` [I]). This is
not needed for phase 1 but improves storage cost noticeably.

**Why not restic for VM disks.** restic can store a disk as one file (`--stdin`), but it must re-read
and re-chunk the whole stream each time, so it cannot use the bitmap. Writing restic trees and blobs
directly from the helper is possible in principle (the format is documented and open), but needs
Poly1305-AES (not exported by the Go stdlib; would need x/crypto or own code), must stay compatible with
restic prune and check, and puts the repository password on the node. One upside is restore without
Restow via `restic dump`. Restow's own standalone restore (`packages/cli`) gets the same property once
it learns the `pve-vm` manifest (section 2.6). **Rejected for phase 1.**

**Why server-side ingest instead of client-side encryption.** The tenant DEK also protects mail and
OneDrive data. Giving it to a PVE node would let a compromised node read every backup of the tenant.
Server-side ingest keeps the agent rule "the node never gets storage credentials or keys"
(docs/AGENT.md). The cost is CPU and bandwidth through the API. That is acceptable because only changed
blocks travel, and AES-GCM and SHA-256 run at GB/s per core. A dedicated ingest worker process can come
later if needed. Transport is TLS, so plaintext is exposed only to the Restow server, which holds the
keys anyway.

### 2.5 Containers: restic over the `directory` mechanism (recommended)

- `backup_get_mechanism(lxc)` returns `directory`.
- `backup_container_prepare` (root): the helper fetches a short-lived **per-run** restic-REST credential
  and the repository password for this guest's repository. It writes them to
  `/run/restow-pve/run-<id>/` with owner `backup-user-id` and mode 0400, and prepares a restic cache dir
  owned by that uid (or uses `--no-cache`).
- `backup_container` (as uid 100000 in the user namespace): runs `restic backup` on `directory` for each
  entry of `sources`, translates `$exclude_patterns` (vzdump globs) to restic `--exclude`, and tags
  `vmid=<id>`, `cluster=<id>`, `run=<id>`. It also stores `pct.conf` and the firewall config as files in
  the snapshot (e.g. `/.restow/pct.conf`) or as restic snapshot metadata. Network access works because
  only the user namespace changes [I, test].
- **One restic repository per guest** under `endpoints/<repoId>/` (same layout, authz matrix, quota and
  lock handling as the agent). Retention, check and restore-test run on the server through the existing
  loopback maintenance path. Reasons: a guest migrates between nodes, per-guest retention and quotas
  apply, prune does not block other guests' backups, and "restore without Restow" stays a plain
  `restic restore`.
- **Credential scope:** the restic-REST principal for a run is limited to that guest's repository and
  expires with the run. A node holds no long-lived restic credential.
- Alternative considered: CT file trees into the chunk store via server-side ingest. That would mean
  writing a new file-tree format and a file walker in Go and losing restic's maturity. Rejected.
- The phrase "only changed blocks leave the host" is true for CTs at the restic chunk level, not the
  block level. The UI and docs should say "only changed data".

### 2.6 Restore

**Restore as new guest from Restow (the main path):**

1. The admin picks a restore point in Restow. Options: target node (default: original node), target
   storage, new VMID (default: next free id), start after restore (off), keep MACs (off; PVE's `unique`
   regenerates them).
2. The server queues task `restore` to that node's helper.
3. The helper calls `POST /nodes/{node}/qemu` with `vmid=<new>`, `archive=restow:backup/vm/101/<time>`,
   `storage=<target>`, `unique=1`, `pool=restow-restore`, optionally `bwlimit`. For CTs it calls
   `POST /nodes/{node}/lxc` with `ostemplate=<archive>`, `restore=1`, `unprivileged=1`.
4. PVE calls the plugin. `restore_vm_init` lists the devices and sizes; `restore_vm_volume_init` makes
   the helper start an NBD server that serves the synthetic full of that disk and returns
   `nbd+unix:///drive-scsi0?socket=/run/restow-pve/restore-<id>.sock`. The server reads the map and
   streams chunks with readahead (sequential, 8 to 16 blocks in flight).
5. CTs: `restore_container_init` returns `archive-directory` = a `restic mount` of the snapshot (FUSE is
   present on PVE because pmxcfs uses it [I]) or, as a fallback, a `restic restore` into a temporary
   directory on a local storage with enough free space. PVE then tars it into the new rootfs with the ID
   mapping.
6. The run ends with the new VMID. The original guest is never touched; Restow never passes `force=1`.

The restore pool `restow-restore` limits `VM.Allocate` (create and **delete**) to guests in that pool
(see 2.8). Admins move a restored guest out of the pool once they accept it.

**Restore from the PVE UI** (Storage view, restow storage, Backups, Restore) works through the same
plugin. The admin's own PVE permissions apply, and the run is reported to Restow with origin `pve`.

**Not possible in phase 1:** live restore (refused by PVE for providers [V]); restore of privileged CTs
via PVE (refused [V]; later: helper restores the files to a new unprivileged CT and documents the
caveats, or creates it itself); in-place restore (by design).

**Single-file restore from VM images (phase 3).** Options:

- (a) The helper exposes the synthetic full as a read-only NBD device on the node (`nbd` kernel module),
  activates partitions or LVM read-only in a private mount namespace, mounts ext4/xfs/btrfs/ntfs3
  read-only, and streams a ZIP to the server. Risks: hostile guest filesystems parsed by the host kernel
  (Proxmox runs its file-restore in a dedicated micro-VM for exactly this reason [I]).
- (b) A small restore VM per request (Restow-built image) on the node.
- (c) A worker on the Restow server with a user-space filesystem reader (none exists in the stack).

Recommended: (b) or a sandboxed (a) variant using a throwaway micro-VM, after phase 2.

**Standalone restore (contractual).** `packages/cli` (`restow-restore`) must learn `pve-vm` manifests:
write each disk as a raw (sparse) file from the map, plus `qemu-server.conf`. CT repositories are plain
restic repositories (password export as for endpoints).

### 2.7 Onboarding: "API token plus one command per node"

> **As implemented (docs/PVE.md, Onboarding):** simpler than designed here. The wizard shows one
> ready-to-run command per node with the enrollment token in the environment; the installer sets up
> user, roles, pool and ACLs idempotently on every run, creates the node's own token
> `restow@pve!<node>`, checks its privileges and picks the fleecing storage, without prompts. An
> admin may hand over an existing token instead (sealed in Restow until the node enrolled). The
> commands below remain the manual reference.

In Restow (wizard "Connect Proxmox"):

1. Choose the tenant. The wizard shows the PVE-side commands to run **once per cluster**, as root on any
   node:
   ```
   pveum user add restow@pve --comment "Restow backup"
   pveum pool add restow-restore --comment "Guests restored by Restow"
   pveum role add RestowBackup --privs "VM.Audit,VM.Backup,Datastore.Audit,Datastore.AllocateSpace,Sys.Audit"
   pveum role add RestowRestore --privs "VM.Allocate,VM.Config.Disk,Datastore.AllocateSpace,SDN.Use"
   pveum acl modify / --users restow@pve --roles RestowBackup
   pveum acl modify /pool/restow-restore --users restow@pve --roles RestowRestore
   pveum acl modify /storage --users restow@pve --roles RestowRestore   # AllocateSpace on target storages
   pveum acl modify /sdn --users restow@pve --roles RestowRestore       # SDN.Use for bridges
   pveum user token add restow@pve restow --privsep 0
   ```
   Exact privilege sets per PVE version must be validated (risk R9). The installer can run these
   itself with `--setup-pve-user` when started as root on the first node. In that case the token never
   has to be copied by hand on that node, but it still has to be entered on the other nodes. Another
   option: the first node stores it in a cluster-readable root-only file under `/etc/pve/priv/` [I, see 2.8
   for the trade-off].
2. Restow creates a one-time **enrollment token** (`rset_`-style, 24 h, single use, bound to tenant and
   "pve cluster"), as for the agent.
3. **One command per node:**
   ```
   curl -fsSL 'https://<instance>/install/pve.sh' | sh
   ```
   The script (same signature checks as `linux.sh`) checks that the node runs PVE ≥ 8.4 (`pveversion`,
   `query-proxmox-support` on a running VM is not needed), installs `restow-pve`, `restic` and the Perl
   shim, and asks (via `/dev/tty`) for the enrollment token, the PVE API token (`restow@pve!restow=<uuid>`)
   and the fleecing storage for this node (it offers local thin storages: `local-lvm`, `local-zfs`). It then
   - enrolls (`POST /agent/v1/enroll` with `kind=pve-node`, cluster name and id from
     `/etc/pve/.members` / `corosync.conf`, node name, PVE version) and receives `nodeId` plus
     `agentSecret`; the first node of a cluster creates the cluster record, later nodes join it
     (the server matches the cluster fingerprint),
   - adds the storage once per cluster: `pvesm add restow restow-<tenantshort> --content backup
     --restow-url https://<instance> --restow-cluster <id>`. No secrets go into `storage.cfg`. The
     storage stays limited to nodes with the plugin installed (`--nodes`),
   - restarts `pvedaemon`, `pveproxy`, `pvestatd` and `pvescheduler` so the plugin loads [I which ones are
     needed],
   - registers the systemd unit `restow-pve.service` (heartbeat, tasks, inventory, caches).
4. Inventory appears within one heartbeat. Guests are *not* backed up until they are in a Restow job, the
   same rule as "Rechner ohne Job" since 0.2.1.

Uninstall: `restow-pve uninstall` removes the shim, the unit and the binaries. The PVE storage is removed
by the last node (or by the admin). Backups stay in Restow.

### 2.8 Security model

| Asset | Where | Protection |
| --- | --- | --- |
| Node secret (`rsea_`) | `/etc/restow-pve/state.json` 0600 root, local disk (not pmxcfs) | Server keeps SHA-256 only. One secret per node, revocable per node. |
| PVE API token | same file | Never sent to Restow (default; an admin-supplied existing token passes through Restow once, sealed, see docs/PVE.md). Least privilege (2.7). `VM.Allocate` only on `/pool/restow-restore`, so the token cannot delete production guests. Its `VM.Backup` on `/` allows backup and restore-over-existing *only with `force`*; the helper never uses `force` and the server cannot instruct it to. |
| Restic repo password (CT) | Restow server (KEK and tenant DEK), handed to the node per run | As with endpoints. The node can read its guests' CT backups. |
| Tenant DEK | Restow server only | Server-side ingest: nodes never see keys. |
| Node to server authorization | `/agent/pve/v1/*` | A node may only open runs for guests of its own cluster and tenant (inventory), append blocks to its own open run, commit, and read maps and blocks of its own cluster's guests (restore). No delete; no overwrite of a committed snapshot. Hash-verified block uploads. Quotas per guest and tenant, as `endpoint-quota`. |
| Compromised node | n/a | Can read and add backups of its cluster, fill quota, and stall runs. It cannot delete or alter restore points (append-only enforced server-side, as for endpoints). It already has root over the guests anyway. |
| Compromised Restow server | n/a | Can read all backups (as today). Through the helper it can only request backups and restores into the restore pool. Mitigate further with an optional node-side allowlist ("allow restores: yes/no", like the agent hook policy `off/scripts/any`, decided on the node). |

**Tenant separation.** Phase 1 allows **one tenant per PVE cluster**. The cluster record carries
`tenant_id`, RLS as for all tenant tables, and data under `tenants/<tid>/...` and
`endpoints/<repo>/...` of that tenant's primary target. Multi-tenant clusters (an MSP hosting several
customers on one cluster) come later: several Restow storages (`restow-<tenant>`), each bound to a
tenant, with a guest-to-tenant mapping by PVE pool. The helper then holds one secret per (node, tenant).

**Immutability.**

- *Logical (phase 1):* nodes are append-only and cannot delete or overwrite; retention runs only on
  the server. PVE's "remove backup" and prune are refused by the plugin and would be refused by the
  server anyway.
- *Physical (phase 2): S3 Object Lock for packs and manifests* of `pve-vm` snapshots. Today packs carry
  no retention and GC repacks (docs/ARCHITECTURE.md, docs/STORAGE.md). Required changes: set
  `RetainUntil` = (latest retention end of any snapshot referencing chunks in the pack) + safety margin,
  extend it when a new snapshot references an old pack (PutObjectRetention can only extend in compliance
  mode [I]), and make GC delete packs only after their retention has passed. No repacking of locked packs;
  dead space is reclaimed later. CT restic repositories get the same treatment for `data/` objects.
- *Local and NFS targets:* logical immutability only. The UI must say so, consistent with STORAGE.md.

### 2.9 UI touch points

- **Server & Clients, Inventar:** new filters "VMs" and "Container". A row per guest with kind
  `vm`/`ct`, cluster, current node, status, OS (guest agent `get-osinfo` if available, later), disks and
  size, last backup, bitmap state ("incremental" / "full read: VM was restarted"), and the job. Clusters
  and nodes show as a group header or filter, with per-node helper health (version, last heartbeat,
  fleecing storage, PVE version, QEMU backup-access support).
- **Detail page** `/inventory/<id>` for a guest: restore points (time, mode, changed/read bytes, bitmap
  mode, consistency: "fs-freeze OK" / "no guest agent" from the task log), "Back up now", "Restore as new
  VM/CT", "Verify read".
- **Jobs:** new kind `pve` (`backup_jobs.kind`). Scope `selected` or `all` (all guests of the tenant's
  clusters, including new ones; respects a PVE tag or pool filter later). Settings: mode
  (snapshot/suspend/stop), fleecing storage override, bandwidth (kbit/s, passed as `bwlimit`; note that
  `bwlimit` needs `Sys.Modify` on `/` [V], so it is enforced in the helper instead), retention, verify-read
  interval, exclude disks (`backup=0` is PVE's own setting).
- **Wizard** "Connect Proxmox" (2.7). The existing i18n entry `endpoints.proxmox` becomes active.
- **History/live:** runs of kind `pve-backup`/`pve-restore` in `RunDto`, with throughput from
  `run_samples` (bytes read vs. uploaded).
- **Problem types and failure causes:** `pve.fleecing_missing`, `pve.qemu_restart_required` (no
  `backup-access-api`), `pve.template_unsupported`, `pve.privileged_ct_restore`, `pve.token_invalid`,
  `pve.permission_missing`, `pve.plugin_not_loaded`, `pve.storage_snapshot_unsupported` (CT fallback to
  suspend, warning), `pve.bitmap_reset` (info).

### 2.10 Data model (sketch)

`pve_clusters` (tenant, name, cluster fingerprint, storage id, created), `pve_nodes` (cluster, name, helper
version, PVE version, secret_hash, fleecing storage, last_seen, status), `pve_guests` (cluster, vmid,
kind vm/ct, name, node, tags, pool, template flag, privileged flag, status, last_backup_at, job membership
via `backup_job_members.pve_guest_id`), `pve_disks` (guest, device, size, last snapshot, bitmap chain
state), `pve_snapshots` (guest, manifest key, time, base, stats, origin `restow`/`pve`), `pve_runs`
(as `endpoint_runs`), and CT repositories reuse the `endpoints` repository machinery or a sibling table.
All tables carry `tenant_id` with RLS.

---

## 3. Phases

### Phase 1: 0.3.0 (realistic scope)

1. `restow-pve` helper (linux-amd64): enrollment, heartbeat, tasks, inventory, self-update, signed
   release, systemd unit, uninstall.
2. Perl shim: storage plugin (content `backup`, listing from cache, status from cache, refuse deletion
   and prune) plus provider for `nbd` (VM) and `directory` (CT); restore `qemu-img` and `directory`.
3. Go NBD client (backup) and NBD server (restore), with CI tests against `qemu-nbd`/QEMU.
4. VM backup with bitmaps, the full-read fallback, hash-skip, zero-skip, TRIM, idempotent commit,
   synthetic-full block maps in the chunk store, server-side ingest.
5. CT backup with restic per guest; restore via `restic mount` or a temporary directory.
6. Restore as a new VM/CT into `restow-restore` pool, from Restow and from the PVE UI.
7. Restow jobs of kind `pve`, scheduler, retention (snapshot deletion, GC with map-aware references),
   weekly "verify": re-read a random sample of stored blocks and compare to the map hashes (server-side),
   plus a monthly restore-test: restore a CT or a small VM into the pool, check it boots or that files
   are present, then delete it (opt-in, since it needs capacity).
8. Inventory UI, detail, jobs, wizard, failure causes, docs (`docs/PVE.md`), known limits stated
   clearly (no templates, no live restore, no privileged CT restore, no file restore, no Object Lock).
9. One tenant per cluster; PVE 9.x as the primary target, 8.4 as best effort.

Cut first if time runs short: PVE-UI-initiated restore (keep it working but untested), `restic mount`
(use a temporary directory only), verify-read automation.

### Phase 2: 0.3.x / 0.4

S3 Object Lock for `pve-vm` packs and manifests and CT repositories; zstd chunk compression; multi-tenant
clusters (pool-to-tenant); privileged CT restore path; Windows VSS guidance and guest-agent checks in the
UI; per-node bandwidth windows; restore to another cluster (cross-cluster: create via the other
cluster's helper); copy targets for VM data (already generic in the chunk store).

### Phase 3: later

Single-file restore from VM images (sandboxed); instant or live restore (would need option C, PBS
emulation, or a future PVE provider extension); application-aware hints (guest agent hooks); PBS
interoperability (import PBS snapshots into Restow).

---

## 4. Risks and unknowns (need a real PVE test cluster)

| # | Risk or unknown | Why it matters | How to resolve |
| --- | --- | --- | --- |
| R1 | Bitmap survival across live migration, `qm reboot`, guest-internal reboot, suspend/hibernate, disk move, disk resize, QEMU package upgrade | Determines how often full reads happen; wrong assumptions would break chains | Matrix test (5.2) on a 3-node cluster with Ceph and with local ZFS/LVM-thin |
| R2 | Correctness of `reuse`: are writes during the backup really in the next bitmap (background bitmap merge) | Silent data loss if wrong | Test with a writer process inside the guest during backup, then compare the restored image to a frozen reference; periodic verify-read |
| R3 | Fleecing storage requirements: space spikes, non-thin storages reserve full size [V], NFS without discard | Backups fail or fill node storage | Wizard checks the storage type; document; alert on fleecing failures |
| R4 | `qemu-img convert` from an NBD URI passes `file_size_info(..., 'raw', 1)` | Restore path | Test early (week 1 spike) |
| R5 | CT backup as uid 100000: network, restic cache, credential files, `restic mount` and FUSE availability on PVE 8/9 | CT path | Spike |
| R6 | Perl shim inside PVE daemons: load-time errors, slow `status()` blocking pvestatd, plugin upgrade while a backup runs | Stability of customers' PVE | Cache-only status and list; integration tests; restart sequence in the installer |
| R7 | GC and refcounting at block-map scale (1M chunk refs per snapshot-TiB) | Postgres load, GC time | Design spike before implementation; load test with synthetic 10 TiB maps |
| R8 | Server ingest throughput (Node.js API process): target ≥ 300 MB/s per node of changed data | First full backups of multi-TiB clusters | Benchmark; dedicated ingest worker if needed; parallel uploads per disk |
| R9 | Minimal privilege set per PVE version (8.4, 9.0, 9.2); privilege names change (e.g. `VM.Monitor` was removed in 9 [I]; `SDN.Use` for bridges) | Onboarding errors | Test matrix; the installer validates with `GET /access/permissions` |
| R10 | Licensing of the Perl shim (AGPL base classes) | Release blocker | Maintainer or legal decision (2.2) |
| R11 | Status of the API (preview vs. stable) per Proxmox's official roadmap | Support statement | Read pve.proxmox.com Roadmap "Proxmox VE 8.4" and "9.x" (blocked during this research) |
| R12 | Multiple disks and TPM/EFI: device naming (`drive-tpmstate0-backup`), EFI disk size vs. block-node size [V comments], cloud-init drives (skipped on restore [V]) | Restores that do not boot | Test UEFI+TPM Windows VM restore |
| R13 | The same VM backed up by PBS *and* Restow: "only one regular backup or one active backup access at a time" [V] | Job collisions, failed runs | Detect "backup already running" and retry later; document |
| R14 | HA-managed guests: restore with `ha_managed` needs `Sys.Console` [V]; backups of HA guests during failover | Edge cases | Restore never adds HA; document |
| R15 | PVE 8.4 behind on fixes (e.g. #6882 TPM fix only in 9.x [V]) | "8.4 or newer" promise | Minimum version check per feature; recommend 9.x |
| R16 | Stopped-VM backups start the VM paused (PVE shows it as running briefly [V docs]) | Admin confusion; full read each time | UI note; schedule stopped VMs less often |

---

## 5. Test plan

### 5.1 Automated (CI, no PVE)

- Go unit tests: NBD client and server against `qemu-nbd` (export with a dirty bitmap created via
  `qemu-img bitmap --add` on a qcow2 and `qemu-nbd -B <bitmap>`), including structured replies,
  block-status extents larger and smaller than 4 MiB, TRIM, disconnects mid-read, and short last
  blocks.
- Go: block pipeline (zero-detect, hash-skip, resume after upload failure, idempotent commit, die-on-unknown).
- Server: ingest authz matrix (as `restic-authz`): other cluster, other tenant, committed snapshot, hash
  mismatch, quota; map building (base plus delta equals full); manifest sealing; GC with maps; standalone
  `restow-restore` of a `pve-vm` manifest to a raw file, compared bit for bit.
- Perl shim: `perl -c` against pinned pve-storage, pve-container and qemu-server sources (vendored as test
  fixtures, not shipped); a mock vzdump driver that calls the provider methods in the documented order with
  fake NBD sockets.
- `scripts/ci/check-go-deps.mjs` stays green (stdlib only).

### 5.2 Integration on real PVE (nested PVE in CI or a lab cluster; 3 nodes, PVE 9.2 and 8.4)

Storage matrix: LVM-thin, ZFS (sparse), Ceph RBD, dir (qcow2), NFS.
Guests: Debian (virtio-scsi, guest agent), Windows Server (UEFI, TPM, VSS via agent), a VM without agent,
a VM template, privileged and unprivileged CTs on each storage, CTs with extra mount points
(`backup=1`/`0`).

1. Onboarding: installer on each node, token validation, missing privilege, missing fleecing storage,
   re-run (idempotent), uninstall and reinstall.
2. Backup: first (full), second (reuse, small delta), no-change (clean bitmap: no reads at all), with
   heavy guest writes during the backup (R2), after `qm shutdown && qm start` (expect `new`), after live
   migration (R1), after disk resize, after disk move, powered-off VM, `stop` and `suspend` modes,
   template (expect a clear refusal), concurrent PBS backup (R13), node reboot mid-backup (expect
   failure, then the next run is correct), network loss to Restow mid-upload (expect failure and the
   bitmap merged back), Restow API restart during commit (idempotency).
3. Consistency: guest agent fs-freeze logged; database inside guest (write load) restores crash-consistent;
   CT on dir storage falls back to suspend (warning surfaced).
4. Restore: VM to the same node and storage, another node, another storage type; UEFI+TPM Windows boots;
   CT unprivileged restore; privileged CT refused with a clear message; restore from the PVE UI; restore
   while the source VM runs (no impact); restore with missing bridge permission (clear error).
5. Correctness oracle: for each test VM, take a reference image at backup time (`qemu-img convert` from a
   storage snapshot) and compare sha256 of the restored disk to the reference, for full, incremental and
   after-migration chains, including after retention deleted intermediate restore points.
6. Security: node A cannot read cluster B's guests; a revoked node gets 401; delete attempts via the PVE
   UI are refused and audited; the token cannot destroy a VM outside the restore pool (`pvesh delete`
   with the token returns 403).
7. Performance: 1 TiB VM first backup and 1% daily change; record read MB/s, upload MB/s, server CPU,
   fleecing space peak, and guest IO latency during backup.
8. Upgrade: helper self-update during idle and refused during a running backup; PVE minor upgrade (plugin
   still loads; APIVER warning behaviour); PVE 8.4 to 9 upgrade with the plugin installed.

### 5.3 Exit criteria for 0.3.0

Every case in 5.2 sections 1, 2, 4 and 5 passes on PVE 9.2 with LVM-thin, ZFS and Ceph. 8.4 passes on at
least LVM-thin. No data mismatch in 5.2.5 across 30 consecutive incremental runs with migrations in
between.

---

## 6. What is verified vs. inferred (summary)

Verified in Proxmox source (GitHub mirrors of git.proxmox.com):

- the provider method set and semantics, call order, mechanisms (`nbd`, `file-handle`, `directory`;
  restore `qemu-img`, `tar`, `directory`),
- plugin registration (Custom dir, APIVER/APIAGE, `features.backup-provider`, `new_backup_provider`),
- release versions and dates (April 2025, PVE 8.4 packages),
- fleecing is mandatory and templates are excluded,
- bitmap name = `snapshot-access:<storeid>`, 4 MiB granularity, modes and action mapping, success and
  failure merge semantics,
- stopped VMs start paused, fs-freeze handling,
- live restore refused, privileged CT restore refused,
- permissions of vzdump, create and restore, and volume access,
- CT snapshot mode fallback to suspend,
- AGPL license of pve-storage and proxmox-backup-qemu.

Inferred or unverified: release-note "preview" status; exact cases where bitmaps survive (migration,
reboot); behaviour of `qemu-img` with our NBD URI end to end; network and FUSE inside the CT user
namespace; `pvestatd` polling frequency; the snapshot-capable storage list for CTs; PVE 8 EOL date;
third-party vendor implementations (search snippets only); the content of the pve-storage-examples
repository (search snippets only).

---

## 7. Restow-side references (this repository)

- docs/ARCHITECTURE.md: chunk store (FastCDC, HMAC ids, AES-256-GCM, packs, sealed manifests, GC),
  jobs, restore rules (never replace).
- docs/AGENT.md: enrollment, `/agent/v1`, restic-REST authz matrix, quotas, locks, signed releases,
  security model.
- docs/STORAGE.md: targets, Object Lock only for archive records today, endpoint repositories not moved.
- agent/README.md: stdlib-only rule, build and sign chain.
- packages/core/src/engine/chunkstore.ts (`ChunkWriter.write`), packages/core/src/crypto.ts (chunk format v1,
  no compression).
- scripts/ci/license-policy.json, scripts/ci/check-go-deps.mjs.

## 8. External sources

Proxmox source (read via the GitHub mirrors; canonical at git.proxmox.com):

- Provider API docs: <https://github.com/proxmox/pve-storage/blob/f1a6ef435f53/src/PVE/BackupProvider/Plugin/Base.pm>
  (canonical: <https://git.proxmox.com/?p=pve-storage.git;a=blob;f=src/PVE/BackupProvider/Plugin/Base.pm>)
- Storage plugin API changelog: <https://github.com/proxmox/pve-storage/blob/f1a6ef435f53/ApiChangeLog>
- Plugin loader and `new_backup_provider`: <https://github.com/proxmox/pve-storage/blob/f1a6ef435f53/src/PVE/Storage.pm>,
  <https://github.com/proxmox/pve-storage/blob/f1a6ef435f53/src/PVE/Storage/Plugin.pm>
- VM backup via provider (`archive_external`, fleecing, freeze): <https://github.com/proxmox/qemu-server/blob/a7b4240bba1d/src/PVE/VZDump/QemuServer.pm>
- VM restore via provider: <https://github.com/proxmox/qemu-server/blob/a7b4240bba1d/src/PVE/QemuServer.pm> (`restore_external_archive`)
- VM create/restore permissions: <https://github.com/proxmox/qemu-server/blob/a7b4240bba1d/src/PVE/API2/Qemu.pm>
- Bitmap migration capability: <https://github.com/proxmox/qemu-server/blob/a7b4240bba1d/src/PVE/QemuMigrate/Helpers.pm>
- CT backup via provider: <https://github.com/proxmox/pve-container/blob/de0ddd657525/src/PVE/VZDump/LXC.pm>
- CT restore via provider: <https://github.com/proxmox/pve-container/blob/de0ddd657525/src/PVE/LXC/Create.pm>
- vzdump integration and permissions: <https://github.com/proxmox/pve-manager/blob/58350116c198/PVE/VZDump.pm>,
  <https://github.com/proxmox/pve-manager/blob/58350116c198/PVE/API2/VZDump.pm>,
  hook phases <https://github.com/proxmox/pve-manager/blob/58350116c198/vzdump-hook-script.pl>
- QEMU backup-access patch (bitmap semantics): <https://github.com/proxmox/pve-qemu/blob/cb85b70c40df/debian/patches/pve/0042-PVE-backup-implement-backup-access-setup-and-teardow.patch>
- Bitmap migration patches: `.../debian/patches/pve/0031-PVE-Migrate-dirty-bitmap-state-via-savevm.patch`,
  `.../0032-migration-block-dirty-bitmap-migrate-other-bitmaps-e.patch` (same repo and commit)
- 4 MiB chunk size and AGPL: <https://github.com/proxmox/proxmox-backup-qemu/blob/aa56aa34c1fc/src/lib.rs>,
  <https://github.com/proxmox/proxmox-backup-qemu/blob/aa56aa34c1fc/debian/copyright>
- Backup modes, fleecing, CT modes: <https://github.com/proxmox/pve-docs/blob/b423460d22af/vzdump.adoc>
  (rendered: <https://pve.proxmox.com/pve-docs/chapter-vzdump.html>); privileges:
  <https://github.com/proxmox/pve-docs/blob/b423460d22af/pveum.adoc> (rendered: <https://pve.proxmox.com/pve-docs/chapter-pveum.html>)

pve-devel mailing list (seen through search results only; host blocked here):

- `new_backup_provider()` patch series v9: <https://lists.proxmox.com/pipermail/pve-devel/2025-April/070015.html>
- pve-storage-examples initial commit (DirectoryExample, Borg): <https://lists.proxmox.com/pipermail/pve-devel/2025-April/070210.html>
- Borg example plugin (POC v7): <https://lists.proxmox.com/pipermail/pve-devel/2025-April/069715.html>
- Series cover letter (v5, March 2025): <https://lore.proxmox.com/pve-devel/20250321134852.103871-1-f.ebner@proxmox.com/T/>

Release and press (search snippets): <https://www.proxmox.com/en/about/press-releases/proxmox-virtual-environment-8-4>,
<https://www.storagereview.com/news/proxmox-ve-8-4-arrives-with-new-tools-for-live-migration-and-backup-integration>.
Third parties (snippets): Veeam <https://helpcenter.veeam.com/docs/vbproxmoxve/userguide/infrastructure_components.html>,
overview <https://devopscube.com/proxmox-backup-software/>.

QEMU NBD dirty-bitmap metadata context: <https://qemu.readthedocs.io/en/master/interop/nbd.html> (blocked here;
semantics taken from the qemu-server code comment). NBD protocol: <https://github.com/NetworkBlockDevice/nbd/blob/master/doc/proto.md>.

## 9. Source commits read

| Repo (GitHub mirror) | Commit | Date |
| --- | --- | --- |
| proxmox/pve-storage | f1a6ef435f53 | 2026-09-30 |
| proxmox/qemu-server | a7b4240bba1d | 2026-09-24 |
| proxmox/pve-container | de0ddd657525 | 2026-09-24 |
| proxmox/pve-manager | 58350116c198 | 2026-09-30 |
| proxmox/pve-docs | b423460d22af | 2026-09-24 |
| proxmox/pve-qemu | cb85b70c40df | 2026-09-30 |
| proxmox/proxmox-backup-qemu | aa56aa34c1fc | 2026-09-16 |

