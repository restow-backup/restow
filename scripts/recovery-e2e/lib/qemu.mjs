/**
 * The QEMU layer of the recovery end-to-end tests (docs/BAREMETAL.md 21.2) is the recovery lab's
 * (apps/worker/src/lab/qemu.ts, M5): the same disks, firmware, fw_cfg answers, serial console and
 * QMP for the cases and for the boot probe. Node runs the TypeScript file as it is (type
 * stripping, Node 22.18 and later).
 */
export * from "../../../apps/worker/src/lab/qemu.ts";
