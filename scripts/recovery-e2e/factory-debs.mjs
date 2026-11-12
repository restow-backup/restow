/**
 * Which .deb files the factory disk carries (run.mjs factoryDisk): debootstrap and every
 * package it needs that the recovery ISO does not have (wget, distro-info and their
 * libraries). The ISO's package list stays as it is; the factory installs these into the
 * live overlay with `dpkg -i`, which installs nothing else, so the list must be complete.
 *
 * Input is the output of `apt-cache depends --recurse --no-recommends --no-suggests
 * --no-conflicts --no-breaks --no-replaces --no-enhances <roots>` from the ISO's own
 * snapshot and the names in integrations/recovery/packages.lock. Of each group of
 * alternatives ("|Depends: a" then "Depends: b") one is enough: a group is met when the
 * ISO or the list already holds one of them, else its first alternative is taken; a
 * virtual package (<name>) is met by one of its providers, else its first provider is
 * taken. A package the ISO has is not followed, because its own dependencies are met
 * in the ISO.
 */

const DEPENDENCY = /^ (\||\s)(?:Pre)?Depends: (\S+)/;
const PROVIDER = /^ {4}(\S+)$/;

/** The package names of packages.lock (lines `<package> <version> <sha256>`). */
export function lockedPackages(lockText) {
  const names = new Set();
  for (const line of lockText.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    names.add(trimmed.split(/\s+/)[0]);
  }
  return names;
}

/** A name of apt-cache's output without architecture qualifier and version. */
function bare(name) {
  return name.replace(/:[a-z0-9-]+$/, "");
}

/**
 * The dependency groups of every package in the output: Map<package, Array<Array<{ name,
 * virtual, providers }>>>.
 */
export function parseDepends(text) {
  const packages = new Map();
  let groups = null;
  let open = false;
  let last = null;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    if (!line.startsWith(" ")) {
      const name = line.trim();
      groups = [];
      open = false;
      last = null;
      if (!name.startsWith("<")) packages.set(bare(name), groups);
      continue;
    }
    if (!groups) throw new Error(`apt-cache depends: a dependency before a package: ${line}`);
    const dependency = DEPENDENCY.exec(line);
    if (dependency) {
      const raw = dependency[2];
      const virtual = raw.startsWith("<") && raw.endsWith(">");
      last = { name: bare(virtual ? raw.slice(1, -1) : raw), virtual, providers: [] };
      if (open) groups[groups.length - 1].push(last);
      else groups.push([last]);
      open = dependency[1] === "|";
      continue;
    }
    const provider = PROVIDER.exec(line);
    if (provider && last) {
      last.providers.push(bare(provider[1]));
      continue;
    }
    throw new Error(`apt-cache depends: an unknown line: ${line}`);
  }
  return packages;
}

/**
 * The packages to download for `roots`, sorted: the roots that the ISO lacks and, from
 * there, every dependency the ISO and the list do not meet yet.
 */
export function factoryDebs(dependsText, lockText, roots) {
  const packages = parseDepends(dependsText);
  const iso = lockedPackages(lockText);
  const chosen = new Set();
  const queue = [];
  const take = (name) => {
    if (iso.has(name) || chosen.has(name)) return;
    if (!packages.has(name)) throw new Error(`apt-cache depends does not name the package ${name}`);
    chosen.add(name);
    queue.push(name);
  };
  const met = (name) => iso.has(name) || chosen.has(name);
  for (const root of roots) take(root);
  while (queue.length > 0) {
    const name = queue.shift();
    for (const group of packages.get(name)) {
      const satisfied = group.some((alternative) =>
        alternative.virtual ? alternative.providers.some(met) : met(alternative.name),
      );
      if (satisfied) continue;
      const first = group[0];
      if (first.virtual) {
        if (first.providers.length === 0) {
          throw new Error(`${name}: nothing provides ${first.name}`);
        }
        take(first.providers[0]);
      } else {
        take(first.name);
      }
    }
  }
  return [...chosen].sort();
}
