/**
 * The curated name signatures of ransomware (docs/RANSOMWARE.md, "Names"): file name
 * extensions that encrypting malware appends or substitutes, and the names of the ransom notes
 * it drops into the folders it encrypted. They are matched on the server against what a backup
 * saw new or changed (the extension counts and the repeated note-like names a runner reports,
 * the names a OneDrive backup downloaded); nothing here is sent to an agent.
 *
 * The list is versioned: every result records the version it was judged with, so a finding can
 * be told apart from one an older list would not have made. Change the version with every
 * change to a list, and keep the lists conservative: an extension that ordinary software uses
 * (`.enc`, `.java`, `.xyz`, `.abc`) stays out, however many families used it, because the cost
 * of a false alarm is an admin who stops reading them.
 */

/** Bumped with every change to the lists below (docs/RANSOMWARE.md lists the history). */
export const RANSOMWARE_SIGNATURES_VERSION = "2026.10-1";

/**
 * Extensions (lower case, without the dot) that ransomware families leave on the files they
 * encrypted. Several families use a random extension per victim; those are not here (the
 * rename and entropy signals catch them).
 */
export const RANSOMWARE_EXTENSIONS: readonly string[] = [
  "locked",
  "locky",
  "zepto",
  "odin",
  "thor",
  "aesir",
  "encrypted",
  "encrypt",
  "crypted",
  "cryptolocker",
  "crypz",
  "cryp1",
  "crinf",
  "cerber",
  "cerber2",
  "cerber3",
  "wncry",
  "wnry",
  "wncryt",
  "wcry",
  "dharma",
  "arena",
  "adobe",
  "combo",
  "phobos",
  "eking",
  "eight",
  "devos",
  "makop",
  "djvu",
  "djvus",
  "rumba",
  "coharos",
  "basta",
  "lockbit",
  "conti",
  "ryk",
  "ryuk",
  "rapid",
  "sodinokibi",
  "maze",
  "egregor",
  "clop",
  "cl0p",
  "ragnar_locked",
  "darkside",
  "akira",
  "8base",
  "medusa",
  "rhysida",
  "lockfile",
  "babyk",
  "babuk",
  "avos",
  "avos2",
  "avoslinux",
  "vvv",
  "ecc",
  "ezz",
  "exx",
  "zzzzz",
  "micro",
  "r5a",
  "kraken",
  "sage",
  "purge",
  "paym",
  "paymts",
  "rdm",
  "rrk",
  "legion",
  "fantom",
  "bart",
  "crjoker",
  "enigma",
  "cbf",
  "venus",
  "pay2key",
  "nefilim",
  "nephilim",
  "mamba",
  "lockergoga",
  "ekans",
  "netwalker",
  "wannacry",
  "petya",
  "ransom",
  "ransomware",
  "pysa",
  "hellokitty",
  "darkpower",
  "nokoyawa",
  "mallox",
  "bianlian",
  "trigona",
  "cuba",
  "quantum",
  "lorenz",
  "blackmatter",
  "ranzy",
  "seven_seas",
];

/**
 * Exact ransom note names (lower case) of families whose note has a fixed name that the
 * keyword rule below would not catch.
 */
export const RANSOM_NOTE_NAMES: readonly string[] = [
  "_readme.txt",
  "info.hta",
  "ryukreadme.txt",
  "ryukreadme.html",
  "readme.lockbit.txt",
  "restore-my-files.txt",
  "akira_readme.txt",
  "readme_for_decrypt.txt",
  "how_to_back_files.html",
  "!!!_read_me_!!!.txt",
  "#readme.hta",
  "readme.hta",
  "decrypt_instruction.txt",
  "decrypt_instructions.html",
  "files encrypted.txt",
  "!!! your files are encrypted !!!.txt",
  "unlock_files_info.txt",
  "!_!email__ we can decrypt your files !_!.txt",
];

/** The extensions a note is written with: text, a web page or an HTML application. */
export const RANSOM_NOTE_EXTENSIONS: readonly string[] = [
  "txt",
  "html",
  "htm",
  "hta",
  "rtf",
  "url",
];

/** One of these in the name, together with one of {@link NOTE_SUBJECT_WORDS}, makes a note. */
const NOTE_ACTION_WORDS = ["decrypt", "restore", "recover", "unlock", "encrypted", "unencrypt"];
const NOTE_SUBJECT_WORDS = [
  "readme",
  "read_me",
  "read-me",
  "how_to",
  "how-to",
  "howto",
  "help",
  "instruction",
  "files",
  "data",
  "info",
  "note",
  "your",
  "!!",
];

/** The extension of a name, lower case and without the dot ("" when it has none). */
export function extensionOf(name: string): string {
  const base = baseNameOf(name);
  const dot = base.lastIndexOf(".");
  return dot <= 0 || dot === base.length - 1 ? "" : base.slice(dot + 1).toLowerCase();
}

/** The last segment of a `/` or `\` separated path. */
export function baseNameOf(path: string): string {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut === -1 ? path : path.slice(cut + 1);
}

/** Normalise an extension as a runner may send it (".LOCKED", "locked") for the lookups. */
export function normaliseExtension(value: string): string {
  return value.trim().replace(/^\.+/, "").toLowerCase();
}

const EXTENSIONS = new Set(RANSOMWARE_EXTENSIONS);
const NOTE_NAMES = new Set(RANSOM_NOTE_NAMES);
const NOTE_EXTENSIONS = new Set(RANSOM_NOTE_EXTENSIONS);

/** Whether `extension` (with or without the dot) is a known ransomware extension. */
export function isRansomwareExtension(extension: string): boolean {
  return EXTENSIONS.has(normaliseExtension(extension));
}

/**
 * Whether a file name looks like a ransom note: one of the fixed names, or a text or web page
 * whose name pairs an action ("decrypt", "restore", ...) with a subject ("readme", "how_to",
 * "files", ...), like `HOW_TO_DECRYPT_FILES.txt` or `README-to-restore.html`.
 */
export function isRansomNoteName(name: string): boolean {
  const base = baseNameOf(name).trim().toLowerCase();
  if (base.length === 0 || base.length > 120) {
    return false;
  }
  if (NOTE_NAMES.has(base)) {
    return true;
  }
  if (!NOTE_EXTENSIONS.has(extensionOf(base))) {
    return false;
  }
  const stem = base.slice(0, base.lastIndexOf("."));
  return (
    NOTE_ACTION_WORDS.some((word) => stem.includes(word)) &&
    NOTE_SUBJECT_WORDS.some((word) => stem.includes(word))
  );
}
