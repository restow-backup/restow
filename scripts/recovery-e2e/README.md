# Recovery end-to-end tests

The bare metal restore in QEMU/KVM, from a backup of a real source machine to the first
boot of the restored disks on other hardware (docs/BAREMETAL.md 21.2). The driver is
`run.mjs`; the cases are in `cases.mjs`, the QEMU layer in `lib/qemu.mjs`, the cloud images
of the cases E3 to E6b in `images.json`. The source machines of the other cases come from the
test machine factory of the recovery ISO (`integrations/recovery/test/machines/`).

```sh
node scripts/recovery-e2e/run.mjs --iso out/restow-recovery_0.5.0_amd64.iso \
  --agent-dist agent/dist --cases per-pr
```

- CI: E1 and E2 run in the job `recovery-e2e` of `.github/workflows/ci.yml` when the restore
  changed; E1b and E3 to E10 every night and before each release
  (`.github/workflows/recovery-nightly.yml`).
- Needs `/dev/kvm` (the run stops with a clear message without it: TCG would take hours),
  `qemu-system-x86_64`, `qemu-img`, OVMF, `virt-fw-vars`, `xorriso`, Docker with compose and
  `ssh-keygen`.
- The test instance gets an agent folder whose `SHA256SUMS` lists the ISO, signed with a key
  made for the run and deleted right after signing; never a release key.
- The driver judges by the API (the recovery's status and verification report) and by the
  line `E2E-BOOT <hostname> <sha256 of the marker>` the restored machine prints on its serial
  console. `RESTOW-RECOVER-RESULT` on the ISO's console is a debugging aid only.
- `no-autoactivation.mjs --iso <iso>`: the "no auto-activation" test of the ISO (CI job
  `recovery-iso`): two direct kernel boots of the ISO, the first prepares a second disk with an
  md RAID1, a volume group with an ext4 LV and a swap partition, the second starts normally and
  runs `integrations/recovery/test/no-autoactivation.sh`; it fails when anything is active.
- NVMe disks of the cases carry a fixed EUI-64 (`eui64` in `cases.mjs`); the ISO identifies them
  as `eui.<hex>`, the other disks as `serial.<serial>` (`identityOf`, pinned against the agent by
  `agent/internal/recovery/testdata/hw/qemu-e2e.json`).
- `node --test scripts/recovery-e2e/run.test.mjs` tests the answers file, the case filter and
  the QEMU command lines without KVM.
