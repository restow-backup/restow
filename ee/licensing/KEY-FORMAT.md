# Licence key format v1: the contract for the issuer

This file is the contract between this repository, which only **verifies** licence
keys, and the licence server, which **issues** them. Everything a build from 0.4.5 on
accepts is described here; `src/token.ts` implements it and `src/token.test.ts`
checks the examples below against it. The rules a key's update terms stand for are
in [docs/LICENSING.md](../../docs/LICENSING.md).

## Token

```
restow-license-v1.<payload>.<signature>
```

| Part | Content |
| --- | --- |
| `restow-license-v1` | The format prefix, literally. |
| `<payload>` | base64url without padding (RFC 4648 §5) of the UTF-8 JSON object below. |
| `<signature>` | base64url without padding of the 64-byte Ed25519 signature (RFC 8032, pure Ed25519) over the ASCII bytes `restow-license-v1.<payload>`, i.e. the prefix, a dot and the payload exactly as it appears in the token. |

- The token is at most 8192 characters. Whitespace anywhere (line breaks from mail
  clients) is ignored on input.
- The installation verifies offline. Nothing is ever sent anywhere; nothing in a key
  expires, and no member is compared with a clock.
- The JSON text is not canonicalised: the signature covers the bytes as issued, so the
  member order and spacing are the issuer's choice.

## Payload members

Six members are **required** (every key ever issued has them). Three are **optional**
(0.4.5). Any further member is **ignored** by builds from 0.4.5 on.

| Member | Required | Type and rule | Meaning |
| --- | --- | --- | --- |
| `edition` | yes | `"business"` or `"service_provider"` | The edition the key unlocks. |
| `mailbox_limit` | yes | `null`, or an integer > 0 | Reserved. Issue `null`. A number is accepted and has no effect. |
| `multi_tenant` | yes | boolean, `true` exactly for `service_provider` | Must match the edition, or the key is refused. |
| `licensee` | yes | string, not blank, at most 200 characters | Shown on the licence page. |
| `installation_id` | yes | string, not blank, at most 200 characters | The installation ID the operator quotes (a UUID, compared without regard to case). |
| `issued_at` | yes | `YYYY-MM-DDTHH:MM:SSZ` or with `.sss` milliseconds, UTC (`Z`) | Informational; never an expiry. |
| `series` | no | string, a major version: `"0"` or `"1"` to `"9999"` without leading zero; `null` = absent | The major version series a key **without** update period covers. Absent: `"1"`. |
| `updates_until` | no | `YYYY-MM-DD`, a real calendar day; `null` = absent | Last day (UTC) of the update period. Absent: no update period, `series` decides. |
| `kid` | no | string `[A-Za-z0-9_-]{1,64}`; `null` = absent | The signing key, see below. Absent: the original vendor key. |

A key with a required member missing, a member of the wrong type, an `updates_until`
that is no calendar day (`2027-02-30`) or a timestamp, or a contradiction between
`edition` and `multi_tenant` is refused as `invalid_payload`.

### What the update terms mean

- **No `updates_until`** (the beta licences, every key sold before 1.0): the key covers
  every release whose major version is the series; series `"1"` also covers every 0.x
  release. A beta key is issued without `series` or with `"series": "1"`.
- **`updates_until`**: the key covers every release made up to the end of that day,
  23:59:59.999 UTC, whatever its version. The release date is the date the release's
  images carry (the commit date of the release tag, `RESTOW_RELEASED_AT`, also published
  as the `released:` line of the release notes). `series` is informational for such a key;
  issue `"1"` for keys sold in the 1.x series.
- A renewal (one more year of updates) is a **new key of the same edition** whose
  `updates_until` is one year after the previous one (chained, not counted from the
  purchase). Installing it replaces the active key, which stays in the installation's
  history.
- Releases a key does not cover keep every release it does cover working forever, with
  all modules. A later release starts with the key's modules off only when the operator
  asks for it (`RESTOW_RUN_AS_COMMUNITY=1`), otherwise it does not start and the previous
  release runs on (docs/LICENSING.md).
- A key is refused on installation (`outside_update_period`) when it does not cover the
  release the installation runs.

### Signing keys and `kid`

The `kid` of an Ed25519 public key is the first 16 lowercase hex digits of SHA-256 over
its raw 32 bytes. Both sides derive it from the key, so no naming is agreed.

| Key | Raw public key (base64url) | `kid` |
| --- | --- | --- |
| Original vendor key (2026-09-24) | `jTH9dQE90rwOooSYx3Gs2wnuhrxoD5Kcqw1wNR7g9Wk` | `9f58f8deb1a097c1` |

- A key **without** `kid` is verified with the original vendor key, forever.
- A key with `kid` is verified with the key of that id among the keys the build knows
  (`EMBEDDED_LICENSE_PUBLIC_KEY` and `EMBEDDED_ADDITIONAL_LICENSE_PUBLIC_KEYS` in
  `src/public-key.ts`). An unknown `kid` is refused as `unknown_signing_key` ("update
  first, then install the key").
- After a rotation, every key signed with a new signing key **must** carry its `kid`,
  and the new public key must ship in a release before the first such key is issued.
  Keys signed with the original key may carry `"kid": "9f58f8deb1a097c1"` or none.

## Compatibility with builds before 0.4.5

Keys with optional members are for Restow 0.4.5 and later. Builds up to 0.4.4 accept
**exactly** the six required members and refuse a key with any further member as
`invalid_payload`; such an installation updates to 0.4.5 first, with its current key. Only
when a key must work on 0.4.4 or older, issue the six-member form (the beta key below,
without `series`). Every member added later must be optional and safe to ignore, since
builds from 0.4.5 on ignore what they do not know.

## Examples

A beta licence (sold before 1.0; covers every 0.x and 1.x release; also valid on 0.4.4):

```json
{
  "edition": "business",
  "mailbox_limit": null,
  "multi_tenant": false,
  "licensee": "Example GmbH",
  "installation_id": "7d3c1f0e-8a4b-4c2d-9e6f-1a2b3c4d5e6f",
  "issued_at": "2026-11-02T09:00:00Z"
}
```

The same with the series named (builds from 0.4.5 on only):

```json
{
  "edition": "business",
  "mailbox_limit": null,
  "multi_tenant": false,
  "licensee": "Example GmbH",
  "installation_id": "7d3c1f0e-8a4b-4c2d-9e6f-1a2b3c4d5e6f",
  "issued_at": "2026-11-02T09:00:00Z",
  "series": "1"
}
```

A key sold after 1.0, with twelve months of updates:

```json
{
  "edition": "service_provider",
  "mailbox_limit": null,
  "multi_tenant": true,
  "licensee": "Example IT-Service GmbH",
  "installation_id": "0b6e2c1a-4f3d-4e5a-9b8c-7d6e5f4a3b2c",
  "issued_at": "2028-01-15T10:30:00Z",
  "series": "1",
  "updates_until": "2029-01-15",
  "kid": "9f58f8deb1a097c1"
}
```

Its renewal one year later (the same edition and installation; it replaces the key above):

```json
{
  "edition": "service_provider",
  "mailbox_limit": null,
  "multi_tenant": true,
  "licensee": "Example IT-Service GmbH",
  "installation_id": "0b6e2c1a-4f3d-4e5a-9b8c-7d6e5f4a3b2c",
  "issued_at": "2029-01-10T08:00:00Z",
  "series": "1",
  "updates_until": "2030-01-15",
  "kid": "9f58f8deb1a097c1"
}
```

## Reasons a key is refused

| `reason` (422 `urn:restow:problem:license-invalid`) | Cause |
| --- | --- |
| `malformed` | Not three dot-separated parts, wrong prefix, not base64url, signature not 64 bytes, longer than 8192 characters. |
| `unknown_signing_key` | `kid` names a key this build does not know. |
| `bad_signature` | The signature does not verify with the key `kid` names (or the original key). |
| `invalid_payload` | Not JSON, or a member breaks a rule above. |
| `installation_mismatch` | `installation_id` is not this installation's ID. |
| `outside_update_period` | Valid, but it does not cover the release the installation runs. |
