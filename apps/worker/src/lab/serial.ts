/**
 * What the lab reads on the serial consoles of a probe (docs/BAREMETAL.md 12.3). The lab only
 * steers by it (cut the network, type the passphrase, stop waiting); the server rates the boot
 * from the console text the lab hands in (@restow/core `classifyProbeSerial`).
 */

/** `recover` ended its access to the repository: the lab takes the network away. */
export const RELEASED_LINE = /RESTOW-PROBE phase=released/;

/** The restored system reached multi-user.target (restow-probe.service). */
export const OK_LINE = /RESTOW-PROBE-OK [0-9a-f-]{32,36} \S{1,128}/;

/**
 * The passphrase prompts of an encrypted root on the serial console, Plymouth off: systemd's
 * cryptsetup and dracut ("Please enter passphrase for disk ..."), cryptsetup itself ("Enter
 * passphrase for ..."), initramfs-tools of Debian and Ubuntu ("Please unlock disk ...").
 */
export const PASSPHRASE_PROMPT =
  /Please enter passphrase for disk|Enter passphrase for |Please enter passphrase|Please unlock disk /g;

/** How many passphrase prompts the console shows. */
export function passphrasePrompts(text: string): number {
  return text.match(PASSPHRASE_PROMPT)?.length ?? 0;
}

/** At most this many passphrases are typed at the serial console (a wrong one asks again). */
export const MAX_PASSPHRASE_TRIES = 3;

/**
 * GRUB asks for the passphrase of an encrypted /boot only on the screen: when the console of the
 * restored disks stays silent this long (the kernel prints on ttyS0 within seconds otherwise), the
 * lab types the passphrase once on the keyboard.
 */
export const GRUB_SILENCE_MS = 45_000;
