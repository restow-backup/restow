# Licence notices of the recovery lab image (restow-lab)

The recovery lab runs the boot probe of whole machine backups (docs/BAREMETAL.md 12.3). Its image
holds the lab's own files of Restow (Apache-2.0, see LICENSE and NOTICE next to this file) and
these separate programs and data, unmodified. Each runs as a program of its own; the lab starts
them, it does not link them.

## Debian packages

From Debian 13 ("trixie"), installed unmodified from snapshot.debian.org at the time the
Dockerfile names (`ARG LAB_SNAPSHOT`, on the Debian image `ARG LAB_DEBIAN_IMAGE`). The exact packages and
versions the image added are listed in `/usr/share/doc/restow-lab/packages.txt`; each package's
own copyright and licence text is in `/usr/share/doc/<package>/copyright`.

| Component | Packages | Licence |
| --- | --- | --- |
| QEMU | qemu-system-x86, qemu-utils | GPL-2.0-only (parts under other GPL-compatible licences, see the copyright file) |
| SeaBIOS | seabios | LGPL-3.0-only |
| OVMF (EDK II) | ovmf | BSD-2-Clause-Patent (parts under other licences, see the copyright file) |
| virt-firmware | python3-virt-firmware | GPL-2.0-only |
| their dependencies | see packages.txt | see each copyright file |

**Source code.** Every Restow release attaches the Debian source packages of exactly the
versions in `packages.txt` (`restow-lab_<version>_sources.tar` and `restow-lab_<version>_sources.txt`,
made by `scripts/docker/lab-sources.sh`). They are also available from snapshot.debian.org at the
same time, as for the recovery ISO.

## Node.js

The `node` binary of the official Node.js 22 image (MIT; its licence and the licences of the
libraries it bundles are at https://github.com/nodejs/node/blob/v22.x/LICENSE).

## UEFI revocation list (DBX)

The forbidden signature database written into the firmware's variable store of a Secure Boot
probe comes from https://github.com/microsoft/secureboot_objects at commit
`3d762aecbaecd12402efd21ba89c8c7bd40da4bd`, unmodified:

| File in the image | Source path | SHA-256 |
| --- | --- | --- |
| /usr/share/restow-lab/dbx/dbx-kek2011-amd64.bin | PostSignedObjects/DBX/amd64/DBXUpdate.bin | 2089e3125e611376cb44326b5765674255443b2484f88de97251939d18055f68 |
| /usr/share/restow-lab/dbx/dbx-kek2023-x64.efiauth2 | PostSignedObjects/SignedByKEK2023/dbx_x64.efiauth2 | 524c796ade42db0048b656f6cf3863832174ae7f58cad6986d1ccae1e3d3ecd1 |
| /usr/share/doc/restow-lab/secureboot_objects-LICENSE.txt | License.txt | 840a8918b28ff140fa720bd3d1b4845a74047914d16883ea74df6977234845fb |

Licence: BSD-2-Clause-Patent. Copyright (C) Microsoft Corporation. All rights reserved. The full
licence text, with its conditions and disclaimer, is in `secureboot_objects-LICENSE.txt` next to
this file. The lab joins both lists into one update for the variable store (the union of their
entries); the files themselves are not changed.
