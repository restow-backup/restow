<!-- SPDX-License-Identifier: GPL-3.0-or-later -->

# Non-free firmware in the recovery ISO (fixed list)

Only firmware without which a common **wired network card or storage controller** in
servers and workstations does not work, or works only in a reduced mode. No Wi-Fi,
Bluetooth, graphics or sound firmware (the ISO has no Wi-Fi; the console runs on
`efifb`/`simplefb` or VGA text) and no CPU microcode (a restore does not need it, and
it keeps the image small). The packages come from Debian's `non-free-firmware` area,
which Debian ships in its own installer and live media since Debian 12.

The list is `config/package-lists/firmware.list.chroot`. The CI job `recovery-iso`
checks that the image holds exactly these packages (`test/check-image.sh`), and the
build writes `FIRMWARE-LICENSES.txt` from their copyright files into the image
(`/usr/share/doc/restow-recovery/`) and next to the ISO, as a release attachment.
A change of the list is a change of this file with its reason, and a line in the
CHANGELOG.

| Package | What for | Licence (from `/usr/share/doc/<package>/copyright`) |
| --- | --- | --- |
| `firmware-bnx2` | Broadcom NetXtreme II 1 GbE (`bnx2`: BCM5706/5708/5709/5716), in many servers | Broadcom; redistribution in unmodified form allowed, not free |
| `firmware-bnx2x` | Broadcom/QLogic NetXtreme II 10 GbE (`bnx2x`: BCM57710/57711/57712/578xx) | as above |
| `firmware-qlogic` | QLogic `qed`/`qede` (25/40/100 GbE), `qla2xxx` (FC HBAs, so that disks behind an FC HBA are visible; SAN LUNs are targets only when chosen explicitly) | QLogic/Marvell; redistribution allowed, not free |
| `firmware-realtek` | Realtek `r8169` (`rtl_nic/*`: RTL8125/8126/8168/8111 in workstations and small servers) | Realtek; redistribution allowed, not free |
| `firmware-misc-nonfree` | `tg3` (`tigon/*`, older Broadcom cards), further network and controller firmware | differs per file, all released for redistribution |
| `firmware-intel-misc` | the Intel `ice` DDP package (`intel/ice/ddp/ice.pkg`, Intel E810): without it `ice` starts in a reduced "safe mode" only | Intel; redistribution allowed, not free |

The name `firmware-intel-misc` is the package of Debian 13 that carries
`intel/ice/ddp/ice.pkg` after `firmware-nonfree` was split into smaller packages; the
image check fails when that file is missing, so a wrong name cannot go unnoticed.

Not needed (drivers that load no firmware): Intel `e1000e`, `igb`, `igc`, `ixgbe`,
`i40e`, Mellanox `mlx4`/`mlx5`, Broadcom `bnxt_en`, Aquantia `atlantic`,
`virtio_net`, `vmxnet3`, `hv_netvsc`; storage `ahci`, `nvme`, `vmd`,
`megaraid_sas`, `mpt3sas`, `mpi3mr`, `smartpqi`, `aacraid`, `hpsa`,
`virtio_blk`/`virtio_scsi`, `vmw_pvscsi`, `hv_storvsc`.

## No graphics drivers that need firmware

Because there is no GPU firmware, the ISO also does not load the GPU drivers that would
need it: `amdgpu`, `radeon`, `nouveau` and `xe` would take the screen over from `efifb`
and then fail without their firmware, and the screen would stay black. The default
kernel command line therefore has `modprobe.blacklist=amdgpu,radeon,nouveau,xe`; the
menu entry "Restow Recovery (with graphics drivers)" leaves it out for hardware where
the plain frame buffer does not work.
