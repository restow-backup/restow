# @restow/cli — `restow-restore`

The standalone restore tool. It reconstructs files from a Restow chunk store and a
snapshot manifest **without a running Restow server and without a database**. Restow is
designed so that a restore never depends on the Restow server: the storage format is open
(described in `docs/ARCHITECTURE.md`, which is written in German), and this package is the
tool that proves it. It needs the key material (see below); anyone who holds that key and
can read the storage can decrypt the data.

It reads the open storage format defined in `@restow/core`: encrypted pack files, sealed
AES-256-GCM chunks, and the self-contained snapshot manifest.

## Commands

```
restow-restore restore --manifest <path> --storage <dir> [--storage <dir> ...] --key <file|env> --out <dir>
restow-restore verify  --manifest <path> --storage <dir> [--storage <dir> ...] --key <file|env>
restow-restore endpoint-password --storage <dir> [--storage <dir> ...] --key <file|env> --endpoint <id> [--out <file>]
```

- `--manifest` A snapshot manifest. Either a local file, or a key inside the store
  (for example `tenants/<tid>/manifests/<snapshot>.json.zst`). The serialized
  on-disk form is accepted, and so is plain text: either the uncompressed line form
  (a header line with `objectCount`, then one object per line) or one JSON document.
  The line form is read line by line, so a manifest with millions of objects never has
  to fit into a single string; a manifest with fewer object lines than its header
  announces is rejected as truncated. Restow stores manifests sealed with the tenant
  key, so object names and hashes are not readable from the storage target. The sealed
  header names the storage key the manifest belongs to and with it the tenant, so the
  tool loads that tenant's keys from `--key` first and then opens the manifest. Read
  from the store, a sealed manifest must sit under the key it was sealed for; a copy
  under another snapshot's key is refused. A local copy of the file can be anywhere.
- `--storage` Path to a local storage backend root (a mounted S3 bucket, NFS/SMB
  share or plain directory — anything the local backend can read). Repeatable: give
  the current primary first, then any earlier target a "keep" storage-target
  replacement left attached read-only (`docs/STORAGE.md`, "Replace the primary").
  Backup dedupes through the server's Postgres chunk index, which is not available
  here, so this tool rebuilds its own pack index by scanning every `--storage` root
  given; a snapshot written after a "keep" switch can reference packs that live only
  on the retired target, and restoring or verifying it needs that root passed too.
  Pack and key material are read from whichever root has them, primary first; only
  the primary is ever a candidate to write to (this tool never writes to storage).
  With one `--storage` the tool behaves exactly as before.
- `--key` The key material (see below). A file path, or the name of an environment
  variable holding the same content. Never pass raw key bytes on the command line.
- `--out` (`restore` only) Directory to write the reconstructed files into. Object
  paths from the manifest are preserved and cannot escape this directory.

`restore` rebuilds the files; `verify` runs the identical reconstruction path but
writes nothing and hash-checks instead. Both exit non-zero if any object fails.

Folder objects (mailbox areas and folders, IMAP mailboxes, OneDrive folders) become
directories, so empty folders restore too. Records that carry no content, such as
OneDrive shortcuts into another drive, are listed as `skip` with the reason and counted
separately; they do not fail the run.

## Supplying the key

Two self-contained ways, auto-detected from the `--key` input:

1. **Key-encryption key (KEK).** The 32-byte KEK the operator normally keeps in the
   environment or a KMS, as raw bytes, hex or base64. The wrapped tenant data keys
   already live in the store under `tenants/<tid>/keys/`; the tool reads and unwraps
   them with the KEK. This is the recommended path.

2. **Exported keyring.** A small JSON document carrying the tenant data key material
   directly, for when the key was exported out of band:

   ```json
   {
     "tenantId": "<tid>",
     "keys": [{ "version": 1, "material": "<base64-or-hex 32 bytes>" }],
     "hmacKey": "<base64-or-hex 32 bytes, optional>"
   }
   ```

   `keys` may hold more than one entry when chunks were sealed under several key
   versions after a rotation. The optional `hmacKey` lets `verify` recompute each
   chunk's stored id from the decrypted plaintext for a full content hash check.

## Integrity

Every sealed chunk is authenticated on decryption (AES-256-GCM). `verify` additionally
checks that each stored chunk carries the id the manifest referenced and that each
reassembled object matches the size in the manifest; with `hmacKey` present it also
recomputes the content-derived stored id.

A pack that cannot be opened (truncated or damaged, for example an orphan left behind
by a worker that was killed mid-write) does not stop the run. The tool lists every
skipped pack as a warning before it starts, restores everything whose chunks sit in
intact packs, and reports the objects that needed a chunk from a skipped pack as
failed. A manifest that cannot be decoded is reported with the real cause (such as an
unknown codec or a runtime without zstd support), not as a JSON error.

## Servers and clients (endpoint repositories)

The backups of servers and clients are plain restic repositories under
`endpoints/<endpoint id>/` in the tenant's primary storage target (`docs/AGENT.md`). restic
restores them on its own; what it needs is the repository password. The server keeps it
in its database and also next to the repository, sealed with the tenant data key:
`endpoints/<endpoint id>/restow-repository-password.json`. The server writes it when a
machine enrolls, and the daily retention run and the weekly check write it again when it is
missing or damaged. The KEK (or an exported keyring) and the storage are therefore enough:

```
restow-restore endpoint-password --storage /mnt/restow-storage --key KEK_FILE \
  --endpoint 0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d --out /root/endpoint-password
restic -r /mnt/restow-storage/endpoints/0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d \
  --password-file /root/endpoint-password restore latest --target /srv/restore
```

- `--endpoint` The endpoint id, which is the folder name under `endpoints/` (the web
  app shows it on the machine's page and in the repository password card).
- `--out` Writes the password into a new file with mode 0600 and refuses to overwrite an
  existing one. Without it the password goes to standard output and nothing else does;
  the warning and the restic command line go to standard error.
- `--key` and `--storage` work as for `restore`.

The password opens every backup of that machine: keep it out of shell histories,
tickets and logs, and delete the file when the restore is done. The sealed document is
bound to its tenant and endpoint; copied into another endpoint's folder it does not open.

## Development

```
pnpm --filter @restow/cli build       # tsc -> dist/, produces the restow-restore bin
pnpm --filter @restow/cli typecheck
pnpm --filter @restow/cli test         # server-less restore round-trip
pnpm --filter @restow/cli start -- restore --help   # run from source via tsx
```
