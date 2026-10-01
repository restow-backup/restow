/**
 * Pure helpers of the release pipeline (.github/workflows/release.yml): tag
 * parsing, the Docker tags a version gets, the CHANGELOG section of a version
 * and the release notes built from it. No I/O here, so the rules are covered by
 * scripts/ci/release-lib.test.mjs; the command line wrappers are
 * check-release.mjs and release-notes.mjs.
 *
 * The rules (docs/CI.md, release pipeline):
 * SemVer tags vMAJOR.MINOR.PATCH, pre-releases as vX.Y.Z-rc.N, Docker tags
 * :<version> always, :beta for 0.x, and :MAJOR.MINOR, :MAJOR and :latest only
 * for a stable release from 1.0.0 on.
 */

const TAG_PATTERN =
  /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

/** The sections every release carries (docs/releases/TEMPLATE.md), in the order they appear. */
export const REQUIRED_SECTIONS = [
  "Summary",
  "Breaking Changes",
  "Added",
  "Changed",
  "Fixed",
  "Security",
  "Upgrade Notes",
  "Known Issues",
  "Verification",
];

/** Text that marks a Verification section nobody has filled in yet. */
const VERIFICATION_PLACEHOLDER = /to be filled/i;

/**
 * Parse a release tag. Returns null when it is not `vMAJOR.MINOR.PATCH` with an
 * optional pre-release suffix (`v0.2.0-rc.1`).
 */
export function parseTag(tag) {
  const match = TAG_PATTERN.exec(tag);
  if (!match) {
    return null;
  }
  const [, major, minor, patch, prerelease] = match;
  return {
    tag,
    version: tag.slice(1),
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: prerelease ?? null,
  };
}

/**
 * The Docker tags a version publishes and the channel it belongs to.
 *
 *   0.x.y            :<version> and :beta            (channel "beta")
 *   x.y.z, x >= 1    :<version>, :x.y, :x and :latest (channel "stable")
 *   any -rc.N        :<version> only                 (channel "prerelease")
 */
export function dockerTags(parsed) {
  const exact = parsed.version;
  if (parsed.prerelease) {
    return { channel: "prerelease", tags: [exact] };
  }
  if (parsed.major === 0) {
    return { channel: "beta", tags: [exact, "beta"] };
  }
  return {
    channel: "stable",
    tags: [exact, `${parsed.major}.${parsed.minor}`, `${parsed.major}`, "latest"],
  };
}

/** True for a real calendar date written YYYY-MM-DD. */
export function isCalendarDate(text) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return false;
  }
  const parsed = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text;
}

/**
 * The CHANGELOG section of `version`: the `## [version] - date` heading, the
 * date as written and the body up to the next `## ` heading. Returns null when
 * no section for that version exists.
 */
export function findChangelogSection(changelog, version) {
  const lines = changelog.split(/\r?\n/);
  const headingPattern = /^## \[([^\]]+)\](?:\s+-\s+(.*?))?\s*$/;
  let start = -1;
  let date = "";
  for (let index = 0; index < lines.length; index += 1) {
    const match = headingPattern.exec(lines[index]);
    if (match && match[1] === version) {
      start = index;
      date = (match[2] ?? "").trim();
      break;
    }
  }
  if (start === -1) {
    return null;
  }
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^## /.test(lines[index])) {
      end = index;
      break;
    }
  }
  return {
    heading: lines[start],
    date,
    body: lines
      .slice(start + 1, end)
      .join("\n")
      .replace(/^\n+/, "")
      .replace(/\n+$/, ""),
  };
}

/** Level-3 sections of a changelog body: `{ title, content }` in document order. */
export function splitSections(body) {
  const sections = [];
  let current = null;
  for (const line of body.split("\n")) {
    const match = /^### (.+?)\s*$/.exec(line);
    if (match) {
      current = { title: match[1], lines: [] };
      sections.push(current);
    } else if (current) {
      current.lines.push(line);
    }
  }
  return sections.map((section) => ({
    title: section.title,
    content: section.lines.join("\n").replace(/^\n+/, "").replace(/\n+$/, ""),
  }));
}

/**
 * Check a release. `today` is a YYYY-MM-DD string (UTC); a release dated later
 * than tomorrow is refused so a typo in the year cannot slip through.
 *
 * Returns `{ errors, warnings, parsed, channel, tags }`; the release may only
 * go ahead with no errors.
 */
export function validateRelease({ tag, packageVersion, changelog, today }) {
  const errors = [];
  const warnings = [];
  const parsed = parseTag(tag);
  if (!parsed) {
    errors.push(
      `The tag "${tag}" is not a release tag: expected vMAJOR.MINOR.PATCH, or vMAJOR.MINOR.PATCH-rc.N for a pre-release.`,
    );
    return { errors, warnings, parsed: null, channel: null, tags: [] };
  }
  if (packageVersion !== parsed.version) {
    errors.push(
      `The tag ${tag} does not match the version in package.json (${packageVersion ?? "missing"}). ` +
        `Set "version" to ${parsed.version} in package.json (and the workspace packages) before tagging.`,
    );
  }
  const section = findChangelogSection(changelog, parsed.version);
  if (!section) {
    errors.push(
      `CHANGELOG.md has no section "## [${parsed.version}] - YYYY-MM-DD". Write the patch notes before tagging.`,
    );
  } else {
    if (!isCalendarDate(section.date)) {
      errors.push(
        `The CHANGELOG.md section for ${parsed.version} has no real release date (found "${section.date || "nothing"}"). Write the date as YYYY-MM-DD.`,
      );
    } else {
      const latest = new Date(`${today}T00:00:00Z`);
      latest.setUTCDate(latest.getUTCDate() + 1);
      if (new Date(`${section.date}T00:00:00Z`) > latest) {
        errors.push(
          `The CHANGELOG.md section for ${parsed.version} is dated ${section.date}, which lies in the future (today is ${today}).`,
        );
      }
    }
    const sections = splitSections(section.body);
    for (const title of REQUIRED_SECTIONS) {
      const found = sections.find((entry) => entry.title.toLowerCase() === title.toLowerCase());
      if (!found) {
        errors.push(
          `The CHANGELOG.md section for ${parsed.version} lacks the required "### ${title}" heading (docs/releases/TEMPLATE.md).`,
        );
      } else if (found.content.length === 0) {
        errors.push(
          `The "### ${title}" section of ${parsed.version} is empty: write "None." rather than leaving it blank.`,
        );
      }
    }
    const verification = sections.find((entry) => entry.title === "Verification");
    if (verification && VERIFICATION_PLACEHOLDER.test(verification.content)) {
      warnings.push(
        `The "### Verification" section of ${parsed.version} still holds the placeholder text; the release notes replace it with the result of this run's smoke report.`,
      );
    }
  }
  const { channel, tags } = dockerTags(parsed);
  return { errors, warnings, parsed, channel, tags };
}

/** Parse the check table of smoke-report.md into `{ id, name, result, duration }` rows. */
export function parseSmokeReport(report) {
  const rows = [];
  for (const line of report.split("\n")) {
    const match =
      /^\|\s*(\d+[a-z]?)\s*\|\s*([^|]+?)\s*\|\s*(PASS|PARTIAL|FAIL|SKIPPED)\s*\|\s*([^|]*?)\s*\|/.exec(
        line,
      );
    if (match) {
      rows.push({ id: match[1], name: match[2], result: match[3], duration: match[4] });
    }
  }
  return rows;
}

/**
 * A short markdown summary of a smoke report: one line per check with its
 * result and, for a skipped check, the reason, so the release notes say
 * plainly what ran and what did not.
 */
export function summarizeSmokeReport(report) {
  const rows = parseSmokeReport(report);
  if (rows.length === 0) {
    return "";
  }
  const lines = ["| Check | Result | Duration |", "| --- | --- | --- |"];
  for (const row of rows) {
    lines.push(`| ${row.id}. ${row.name} | ${row.result} | ${row.duration || "-"} |`);
  }
  const skipped = rows.filter((row) => row.result === "SKIPPED").length;
  const partial = rows.filter((row) => row.result === "PARTIAL").length;
  const failed = rows.filter((row) => row.result === "FAIL").length;
  lines.push(
    "",
    `${rows.length - skipped - partial - failed} of ${rows.length} checks passed in full, ${partial} partly, ${skipped} skipped, ${failed} failed. The full report, including the reason for every skipped or partial check, is attached to the release as smoke-report.md.`,
  );
  return lines.join("\n");
}

/**
 * The release notes: the changelog body of the version, with its Verification
 * section completed by the smoke report. A Verification section that still
 * holds the placeholder is replaced; a written one is kept and the pipeline
 * result follows it.
 */
export function buildReleaseNotes({ version, section, smokeSummary, date, channel }) {
  const generated = smokeSummary ?? "";
  const verification = splitSections(section.body).find((entry) => entry.title === "Verification");
  let body = section.body;
  if (generated) {
    const block = `Release pipeline, ${date}:\n\n${generated}`;
    if (verification) {
      const kept =
        verification.content && !VERIFICATION_PLACEHOLDER.test(verification.content)
          ? `${verification.content}\n\n`
          : "";
      // Replace the Verification section in place; sections after it stay.
      const lines = body.split("\n");
      const from = lines.findIndex((line) => /^### Verification\s*$/.test(line));
      let to = lines.findIndex((line, index) => index > from && /^### /.test(line));
      if (to === -1) {
        to = lines.length;
      }
      const tail = lines.slice(to).join("\n");
      body =
        `${lines.slice(0, from).join("\n")}\n### Verification\n\n${kept}${block}\n${tail ? `\n${tail}` : ""}`
          .replace(/^\n+/, "")
          .replace(/\n+$/, "");
    } else {
      body = `${body}\n\n### Verification\n\n${block}`;
    }
  }
  const header = `Restow ${version}. Released ${section.date}${channel ? `, channel ${channel}` : ""}.\n\n`;
  return `${header}${body}\n`;
}

function compareVersions(left, right) {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

/**
 * The newest stable release below `currentVersion` among the published release
 * tags, as a version without the leading v, or null when there is none (the
 * first release, or only pre-releases so far). The upgrade check of the smoke
 * starts from this version.
 */
export function previousRelease(currentVersion, tags) {
  const current = parseTag(`v${currentVersion}`);
  if (!current) {
    return null;
  }
  const older = tags
    .map((tag) => parseTag(tag.trim()))
    .filter((parsed) => parsed && !parsed.prerelease && compareVersions(parsed, current) < 0)
    .sort(compareVersions);
  return older.length > 0 ? older[older.length - 1].version : null;
}
