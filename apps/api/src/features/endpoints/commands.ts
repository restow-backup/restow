import type { EndpointOsName } from "@restow/core";
import { isSafeOrigin } from "./distribution.js";

/**
 * The commands the wizard shows (docs/AGENT.md, "Enrollment"). The one-time
 * token is not part of any command: the install script asks for it on the
 * terminal (hidden input), so it never appears in a URL, a command line, the
 * process list or the shell history. For unattended installs the token comes
 * from a file only root can read.
 */

export interface InstallCommands {
  /** Run on the machine, as root; it asks for the token. */
  install: string;
  /** The same for unattended installs (RMM): the token comes from a root-only file. */
  installUnattended: string;
  /** The file `installUnattended` reads the token from. */
  tokenFile: string;
  /** The same script removes the agent again. */
  uninstallScript: string;
  /** With the agent installed. */
  uninstallAgent: string;
  /** Run on the machine by its administrator to allow hooks from the server (scripts or any command). */
  hooksScripts: string;
  hooksAny: string;
}

/** A value that is safe inside single quotes of a POSIX shell. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

const SCRIPT: Record<"linux" | "darwin", string> = { linux: "linux.sh", darwin: "macos.sh" };

/** Where the installed agent lives (root-owned, see agent/README.md). */
export const INSTALLED_AGENT: Record<"linux" | "darwin", string> = {
  linux: "/opt/restow-agent/bin/restow-agent",
  darwin: "/Library/Application Support/Restow/bin/restow-agent",
};

/**
 * The token file the unattended command reads (the operator puts the token
 * there first, readable by root only); in root's home folder of the system.
 */
export const TOKEN_FILE: Record<"linux" | "darwin", string> = {
  linux: "/root/restow-enrollment.token",
  darwin: "/var/root/restow-enrollment.token",
};

/**
 * The install and uninstall commands for a system; Windows has none in 0.1.0.
 * The instance URL must be a plain origin (scheme, host, port); it is quoted
 * all the same.
 */
export function installCommands(
  os: Exclude<EndpointOsName, "windows">,
  instanceUrl: string,
): InstallCommands {
  const base = instanceUrl.replace(/\/+$/, "");
  if (!isSafeOrigin(base)) {
    throw new TypeError("unsafe instance URL for an install command");
  }
  const script = shellQuote(`${base}/install/${SCRIPT[os]}`);
  return {
    install: `curl -fsSL ${script} | sudo sh`,
    installUnattended: `curl -fsSL ${script} | sudo RESTOW_TOKEN_FILE=${TOKEN_FILE[os]} sh`,
    tokenFile: TOKEN_FILE[os],
    uninstallScript: `curl -fsSL ${script} | sudo sh -s -- --uninstall`,
    uninstallAgent: `sudo ${shellQuote(INSTALLED_AGENT[os])} uninstall`,
    hooksScripts: `sudo ${shellQuote(INSTALLED_AGENT[os])} hooks scripts`,
    hooksAny: `sudo ${shellQuote(INSTALLED_AGENT[os])} hooks any`,
  };
}
