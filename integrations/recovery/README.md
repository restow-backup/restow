# Restow recovery ISO

The build recipe of the Restow recovery ISO: a Debian 13 (trixie) live image that
restores a Linux machine from its whole machine backup in Restow onto new disks. It
starts with UEFI Secure Boot (shim, GRUB and kernel signed for Debian) and with legacy
BIOS, and runs the recovery program `restow-agent recover` on the first console.

This folder is a **separate work under the GNU General Public License, version 3 or
later** (`LICENSE`), not part of the Apache-2.0 core of Restow: it follows live-build
(GPL-3.0-or-later). It holds shell scripts and configuration only. The two programs in
the image, `restow-agent` and `restic`, are independent programs that the build copies
from an agent build into the image (`/usr/lib/restow-recovery/`, with their notices in
`THIRD_PARTY_NOTICES.txt`); they are not part of this work.

## Build

```sh
integrations/recovery/build.sh --agent-dist agent/dist/linux-amd64 --version 0.5.0 --out out/
```

- Needs Docker with `--privileged` (live-build mounts and chroots) and about 10 GB of
  free space. The build runs in `debian:trixie` pinned by digest (`snapshot.env`), with
  `SOURCE_DATE_EPOCH` set to the snapshot time, time zone UTC, `umask 022`, locale
  `C.UTF-8` and a fixed host name. The container gets exactly the build variables
  (`--env-file`), never the environment of the caller.
- Writes `restow-recovery_<v>_amd64.iso`, its `.sha256` and
  `restow-recovery_<v>_FIRMWARE-LICENSES.txt`; with `--sources` also the source bundle.
- `restow-agent version --short` of the given agent must equal `--version`.

## Reproducible build

Every package comes from one time of `snapshot.debian.org` (`SNAPSHOT_TIMESTAMP`:
`main`, `non-free-firmware` and `debian-security` of that time). apt checks the
signatures of the package lists with the `debian-archive-keyring` of the pinned image;
the old lists need `Check-Valid-Until=false`, which the build allows only together with
the lock (or while `--update-lock` writes it). The same setting holds for apt in the
build container and in live-build's chroot, in the chroot and the binary stage: the build
writes it with `rr_apt_conf` into `config/apt/apt.conf`, the one file live-build copies
there (`lb chroot_apt`), and live-build removes it before the image is packed.
`packages.lock` names every installed package with its version and the
SHA-256 of its `.deb`; a hook compares the image with it and the build fails on any
difference. The hook reads the `.deb`s apt installed in the chroot and those debootstrap
installed, which live-build keeps outside the chroot (`cache/packages.bootstrap`;
`build-inner.sh` runs the stages of `lb build` one by one and links them into
`config/restow/bootstrap-debs` before the chroot stage), matched by package, version and
architecture. `build.sh --update-lock` writes the lock anew (by hand only; review the
diff); a package without its `.deb` fails that build, and a lock entry without a
SHA-256 is never accepted. Forbidden anywhere in the configuration, and checked: `trusted=yes`,
`--allow-unauthenticated`, `AllowInsecureRepositories`.

Every Restow release takes a new snapshot time (security updates); `snapshot.env` and
`packages.lock` are set in the release commit and so are part of the tag. From the tag
the ISO can be rebuilt bit for bit. The CI builds it twice, on two different runner
images with a different time zone and umask, and compares the SHA-256; only when both
are equal does the release list it in its signed checksums.

## Check

- `test/unit.sh`: the self-tests of the shell helpers (no root, no Docker).
- `test/check-image.sh <iso> <version>`: the firmware packages in the image equal the
  list, the Intel `ice` DDP package is there, every program the recovery program calls
  is found (from `restow-agent recover --list-tools`), the version, the BIOS and UEFI
  boot entries, the size (below 900 MiB), the keyboard layouts (the image's `ckbcomp`
  and `loadkeys --unicode --parse --bkeymap`, which needs no console) and `mdadm.conf`.
  Firmware counts only when installed: with a pattern, `dpkg-query` also names
  packages it knows only from other packages' fields.
- `test/no-secrets.sh <dir>`: no private key, recovery code, rebind token, instance
  address or SSH host key in the unpacked image. A private key is a PEM block with its
  base64 body (OpenSSH and GLib carry the header line alone as a format string). Tokens
  and recovery codes are looked for in every file but ELF programs and libraries:
  instance data reaches an image only as a file, and a program's read-only data runs
  strings together (the agent holds the prefix `rset_` next to other text and the
  placeholder `RC-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX`).
- `test/no-autoactivation.sh`: run inside the started ISO with a disk that carries an
  md array, a volume group and swap: nothing of it may be active.
- `test/machines/`: the factory of the source machines for the end-to-end tests.

## Verify and write a downloaded ISO

The ISO is listed in the release's signed `agent-SHA256SUMS`
(`recovery/restow-recovery_<v>_amd64.iso`). Check the signature with the release key
**from the Git tag** (`agent/release-signing.pub`), never with a key an instance hands
you, and then the hash:

```sh
scripts/release/verify-agent-signature.sh agent-SHA256SUMS agent-SHA256SUMS.sig release-signing.pub
grep ' recovery/restow-recovery_0.5.0_amd64.iso$' agent-SHA256SUMS | sed 's# recovery/# #' | sha256sum -c -
```

Write it to a USB stick as it is (`dd`, or a tool in "DD image" mode), or attach it as a
virtual medium. Secure Boot protects the boot chain up to the kernel, not the live file
system: only the signature check above proves the ISO is genuine.

## Firmware

The fixed list of non-free firmware, with the reason and licence of each package, is in
[firmware.md](firmware.md).

## Rebuild at the maintainer

Before signing a release, the maintainer rebuilds the ISO from the tag on a host of
their own and signs only when its SHA-256 equals the line the two CI builds agreed on
(`scripts/release/sign-agent.sh <tag> --key <key> --iso <rebuilt ISO>`). A runner that
produced the same tampered ISO twice is caught there.

## Source code of the packages

`sources.sh` (or `build.sh --sources`) downloads the Debian source package of exactly
the version of every package in the lock from the same snapshot time and writes
`restow-recovery_<v>_sources.tar` (in parts `…_sources.tar.part-000`, `-001`, … of
1900 MiB once it reaches 2 GiB) and `restow-recovery_<v>_sources.txt` (package,
version, URL). Both are attachments of the release the ISO belongs to.
