/**
 * Check 9: the image scan (Trivy) finds no critical vulnerability that has a
 * fix, and `pnpm audit` finds no high or critical advisory.
 *
 * Critical findings that the distribution has not fixed yet (the Debian base
 * image) cannot be acted on; they are listed in the report, not counted,
 * unless the run asks for --trivy-strict.
 */
import { run } from "../lib/exec.mjs";

async function trivy(ctx, args) {
  return run(
    "docker",
    [
      "run",
      "--rm",
      "-v",
      "/var/run/docker.sock:/var/run/docker.sock",
      "-v",
      "restow-smoke-trivy-cache:/root/.cache",
      ctx.images.trivy,
      "image",
      "--quiet",
      ...args,
      ctx.images.app,
    ],
    { allowFailure: true, timeoutMs: 600_000 },
  );
}

export function summarizeTrivy(report) {
  const findings = [];
  for (const result of report.Results ?? []) {
    for (const vulnerability of result.Vulnerabilities ?? []) {
      findings.push({
        id: vulnerability.VulnerabilityID,
        severity: vulnerability.Severity,
        pkg: vulnerability.PkgName,
        installed: vulnerability.InstalledVersion,
        fixed: vulnerability.FixedVersion || "",
        target: result.Target,
      });
    }
  }
  return findings;
}

export async function scans(ctx, check) {
  await check.step(
    "Trivy: no critical vulnerability with an available fix in the image",
    async () => {
      const result = await trivy(ctx, ["--severity", "CRITICAL,HIGH", "--format", "json"]);
      if (result.code !== 0 && !result.stdout.trim().startsWith("{")) {
        throw new Error(
          `Trivy could not scan the image: ${result.stderr.trim().split("\n").slice(-4).join(" | ")}`,
        );
      }
      const findings = summarizeTrivy(JSON.parse(result.stdout));
      const critical = findings.filter((finding) => finding.severity === "CRITICAL");
      const fixable = critical.filter((finding) => finding.fixed !== "");
      const unfixed = critical.filter((finding) => finding.fixed === "");
      const high = findings.filter((finding) => finding.severity === "HIGH").length;
      const counted = ctx.options.trivyStrict ? critical : fixable;
      if (counted.length > 0) {
        throw new Error(
          `${counted.length} critical finding${counted.length === 1 ? "" : "s"}: ${counted
            .slice(0, 6)
            .map(
              (finding) =>
                `${finding.id} ${finding.pkg}@${finding.installed}${finding.fixed ? ` (fixed in ${finding.fixed})` : ""}`,
            )
            .join("; ")}`,
        );
      }
      const note =
        unfixed.length > 0
          ? `; ${unfixed.length} critical without a fix in the base image, not counted: ${[...new Set(unfixed.map((finding) => `${finding.id} ${finding.pkg}`))].join(", ")}`
          : "";
      return `0 critical with a fix (${high} high findings listed by Trivy, not gating)${note}`;
    },
  );

  await check.step("pnpm audit: no high or critical advisory", async () => {
    const attempts = [
      ["pnpm", ["audit", "--audit-level", "high"]],
      ["corepack", ["pnpm", "audit", "--audit-level", "high"]],
    ];
    let last = null;
    for (const [command, args] of attempts) {
      try {
        last = await run(command, args, {
          cwd: ctx.repoRoot,
          allowFailure: true,
          timeoutMs: 120_000,
        });
      } catch {
        continue; // the command does not exist here
      }
      break;
    }
    if (!last) {
      throw new Error("neither pnpm nor corepack is available to run the audit");
    }
    const output = `${last.stdout}${last.stderr}`;
    if (last.code !== 0) {
      throw new Error(
        `pnpm audit exited ${last.code}: ${output.trim().split("\n").slice(-6).join(" | ")}`,
      );
    }
    const severity = /Severity:\s*(.+)/u.exec(output)?.[1]?.trim();
    return severity ? `no high or critical advisory (${severity})` : "no advisory found";
  });
}
