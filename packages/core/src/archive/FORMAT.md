# Archive on-disk format

This documents exactly what `writeArchiveItem` (`writer.ts`) puts in storage,
so that a standalone restore tool (`packages/cli`, or an operator with the
tenant's exported key and nothing else) can read an archived item back
without a running Restow server or its database. Postgres (the
`ArchiveCatalog` implementation that ships with the SMTP receiver,
ARCHIVE-JOURNAL) is a search and reporting index over the same facts; the
objects described here are the source of truth, exactly as
`docs/ARCHITECTURE.md` states for backup manifests: the object in storage,
not the database, is what a standalone restore trusts.

## Two kinds of object, one item

An archived item is split across two things in storage, both under the
tenant's own prefix and both encrypted with the tenant's data-encryption key
(DEK):

1. **Chunks of the original message**, written through the exact same
   content-defined-chunking pack store a backup uses
   (`engine/chunkstore.ts`, `engine/layout.ts`):

   ```
   tenants/<tenantId>/packs/<xx>/<packId>
   ```

   This is deliberate, not a shortcut: it gives archived mail the same
   per-tenant deduplication a backup gets (the same message journaled to two
   mailboxes costs storage once), the same AES-256-GCM sealing bound to each
   chunk's content address, and the same multi-target write/read fallback
   (primary plus copies) — all without a single new code path to audit for
   the integrity properties that matter most here.

2. **The item's own record** — a small, sealed JSON document that ties a set
   of chunks together with the envelope, the hash chain and retention:

   ```
   tenants/<tenantId>/archive/<year>/<month>/<itemId>.json
   ```

   `<year>/<month>` are the UTC calendar year and zero-padded month of the
   item's `receivedAt` (`layout.ts`, `archiveItemKey`). `<itemId>` is
   whatever id the caller (the journal receiver) assigned; it never changes
   once written.

## The item record

Sealed layout (`format.ts`):

```
codec tag 0x01 (1 byte) | sealed blob (crypto.ts layout: magic "RSRC",
format version, key version, AAD length + AAD, IV, auth tag, ciphertext)
```

The sealed blob is AES-256-GCM under the tenant's current DEK, exactly like
`engine/sealed-manifest.ts` seals a snapshot manifest. Its AAD (bound and
authenticated, not secret) is the item's own storage key — the
`tenants/<tenantId>/archive/<year>/<month>/<itemId>.json` string above — so a
record copied to another key, or handed to the wrong tenant's key, refuses
to open (`openArchiveItem` checks the AAD against the key it was read from,
and separately checks that the *decrypted* record's own `tenantId`/`id`
fields reproduce that same key).

The plaintext JSON (`ArchiveItemRecord`, see `types.ts` for the field-by-field
documentation):

```json
{
  "id": "…",
  "tenantId": "…",
  "receivedAt": "2026-03-01T10:15:00.000Z",
  "itemHash": "<sha-256 hex of the original, byte-exact>",
  "prevChainHash": "<hex, or null for the first item>",
  "chainHash": "<hex>",
  "size": 48213,
  "chunks": ["<stored chunk id hex>", "…"],
  "envelope": { "sender": "…", "subject": "…", "messageId": "…", "onBehalfOf": null, "recipients": [...] },
  "flags": ["…"],
  "source": "journal",
  "legalHold": false,
  "retentionUntil": "2036-01-01T00:00:00.000Z",
  "createdAt": "2026-03-01T10:15:03.000Z",
  "bodyHash": "<sha-256 hex of the normalized body; from 0.4.4, absent before>",
  "supersedesItemId": "<id of the weaker item of the same mail; only when there is one>"
}
```

`source` is one of `journal`, `smtp_forward` (a plain copy a mail provider
forwarded to an archive address at transport, 0.4.4), `graph_sync`, `imap_sync`
and `file_import`. Readers never validate it: a value a later version writes is
shown as it is. `flags` holds the journal parser's flags and, from 0.4.4,
`captured-late` (taken over by the one-time backfill of a mailbox way, received
before live capture of the mailbox began) and `message-id-conflict` (the archive
already held another mail with the same Message-ID but a different body).
`bodyHash` and `supersedesItemId` are written only when set, so a record from
before 0.4.4 serializes and reads exactly as it did; a reader that does not know
them ignores them.

`chunks` is ordered; concatenating the chunks it names, in that order,
reproduces the original message byte-for-byte (`reader.ts`,
`archiveItemAsManifestObject` + `ChunkReader.readObject`, which also verifies
`size` and `itemHash` before handing any bytes back — the same
`RestoreIntegrityError` a corrupted backup restore would raise).

`legalHold` is sealed into the record at write time and never rewritten
afterwards: a later `ArchiveCatalog.setLegalHold` call updates only the
catalog's own row, not this object. A standalone reader (or a copy of this
record read straight from storage) therefore always sees the hold value as
of capture, which can be stale. The catalog is the authoritative, current
value; this field is a capture-time record, useful for evidence of what the
hold state was when the item was written, not for deciding whether it may be
deleted today.

## Write-once

`writeArchiveItem` checks whether the item record's key already exists
before writing anything, and refuses with `ArchiveWriteOnceError` if it does.
This is an application-level guarantee, and it is a read-then-write, not an
atomic conditional create: two concurrent writers of the same item id can
both pass the `head` check before either `put` lands, and the second `put`
would then overwrite the first on a backend without its own conditional
write. Callers must serialize writes per item id themselves (the journal
receiver's own transaction, or an advisory lock); a backend that offers a
conditional create (If-None-Match, `O_EXCL`) should be used for it where
available.

On a storage target with hardware object-lock (S3 Compliance Mode), the
write also carries `retainUntil` (the item's computed retention date)
through the ordinary `StorageBackend.put(key, data, { retainUntil })` option
(`storage/backend.ts`) — no change to that interface was needed, it already
supports this. On a target without object-lock support, that option is
simply ignored by the backend; the UI is expected to say so plainly
(docs/ARCHIVE.md: no hardware WORM on this storage target).

### Object-lock covers the record, not the pack

That `retainUntil` only reaches the item's own small sealed record at
`tenants/<tenantId>/archive/<year>/<month>/<itemId>.json`. The message's
actual bytes live in the shared pack files at `tenants/<tenantId>/packs/...`
(see "Two kinds of object" above), written through the same pack store a
backup uses, with no `retainUntil` of their own — scrub GC (`verify/gc.ts`)
is free to re-pack or, once a chunk is unreferenced past its grace period,
delete the pack that holds them (see "Chunk liveness" below for why
archived chunks stay referenced in the meantime). Hardware WORM therefore
does **not** yet protect the archived message content itself, only the
record that names it. This is a known gap, filed as a follow-up for
ARCHIVE-JOURNAL/STORAGE-CLASSIFICATION: either separate archive packs
that carry their own `retainUntil` and are excluded from GC re-packing, or
an equivalent design that extends real object-lock to the message bytes.

### Chunk liveness

`writeArchiveItem` pins every chunk it writes with `ChunkIndex.addReferences`
right after the write, exactly as a backup's `engine/snapshot.ts` pins its
chunks on commit. Without this, a chunk that no backup happens to share
would sit at refcount 0 and scrub GC would reclaim it once its grace period
elapsed — the sealed item record would still look intact, but
`readArchiveItemOriginal` (`reader.ts`) and the standalone restore could no
longer rebuild the original from it. References are released only by the
retention deletion run (ARCHIVE-JOURNAL), never by the writer itself.

## One mail, several captures (0.4.4)

Every writer appends through `append.ts` (`captureArchiveItem`). A capture is the
same mail as an archived item when the normalized Message-ID
(`lower(btrim(message_id, '<> '))`, `identity.ts` `messageKey`) matches and
either the exact bytes (`itemHash`) or the body (`bodyHash`: the bytes after the
first empty line, CRLF line ends, trailing spaces and tabs of every line and
trailing empty lines removed) match; without a Message-ID only the exact bytes
count. Ways rank `journal` = `smtp_forward` (at transport) above `graph_sync` =
`imap_sync` (from the mailbox) above `file_import`.

- A capture that is not stronger than the strongest item it matches becomes no
  item: Postgres records it as a row of `archive_item_captures` (the item, the
  way, the mailbox, the bytes' hash, where it was found, when). These rows are
  evidence next to the chain, not part of it, and there is no storage object for
  them; the capture's bytes are never referenced (scrub GC reclaims them).
- A stronger capture becomes a new item whose record names the weaker one in
  `supersedesItemId`. The weaker item stays untouched; search hides superseded
  items by default.
- The same Message-ID with another body is a different mail: both are kept and
  the newer one carries `message-id-conflict`.

The journal receiver and the file import keep every report and message as an
item of their own (policy `keep`), as before 0.4.4; a journal report that
arrives after a mailbox capture of the same mail still names it in
`supersedesItemId`.

## The hash chain

`chainHash = SHA-256(prevChainHash || itemHash || receivedAt.toISOString())`
(`chain.ts`, `computeArchiveChainHash`), one chain per tenant, entries in
append order. Append order is (`createdAt`, `id`) order: under the tenant's chain
lock a writer takes the last item in that order as its predecessor and gives its
own item a `createdAt` strictly after it (`append.ts`), whatever the clocks of
the writing processes say, so the chain cannot fork. The original bytes are
uploaded before the lock is taken; only linking, sealing the record and the
catalog row happen under it. `verifyChain` walks a chain and recomputes every entry's hash
from its predecessor; a tampered `itemHash`, a deleted entry or two swapped
entries all show up the same way — a mismatch at the first position they
affect — because each of those changes the predecessor a later entry's
stored hash no longer agrees with.

Daily anchors (`buildDailyAnchor`, `verifyAnchor`) catch what an internal
chain walk cannot: items deleted off the *end* of the chain, where nothing
downstream is left to disagree with anything. An anchor is just "as of the
last item captured on this UTC day, the chain had this many entries and this
chain hash"; `verifyAnchor` checks that the chain still has at least that
many entries and that the entry at that position still carries that hash.

## Retention

Pure functions in `retention.ts`; nothing here touches storage or the
catalog. `retentionUntil(receivedAt, policy)` computes the date an item
becomes eligible for deletion (or `null` for unlimited retention), for two
modes:

- `from_capture`: exactly `policy.years` years after `receivedAt`.
- `end_of_year`: the AO §147 Abs. 4 calculation — the clock starts at the end
  of the calendar year `receivedAt` falls in, then runs `policy.years` full
  calendar years, landing on 1 January of `year(receivedAt) + years + 1`.

`isDueForDeletion(retentionUntilDate, legalHold, now)` is what a retention
run (ARCHIVE-JOURNAL) is expected to call before deleting anything: a legal
hold always wins, regardless of how far past its retention date an item is.

## What is deliberately not here

- **Which mailbox an item belongs to, its further captures, and multi-mailbox dedup bookkeeping**
  (docs/ARCHIVE.md: the same mail journaled to two mailboxes is one original,
  several associations) is catalog/Postgres bookkeeping, not part of this
  storage-independent core. The chunk-level dedup this format gets for free
  already makes that cheap to build on: two items with identical original
  bytes will naturally share every chunk.
- **The Postgres `ArchiveCatalog` implementation**, `archive_anchor`
  persistence, and wiring the SMTP receiver to call `writeArchiveItem` land
  with ARCHIVE-JOURNAL.
- **The mailbox capture ways** (Graph and IMAP, apps/worker/src/archive-capture)
  reuse this same append and format (`source` `graph_sync` or `imap_sync`, the
  envelope taken from the mail's own headers).
