import { createHash } from "node:crypto";
import type { EndpointOsName } from "@restow/core";
import { isSafeOrigin } from "./distribution.js";

/**
 * The commands the wizard shows (docs/AGENT.md, "Enrollment"). The one-time
 * token is not part of any command: the install script asks for it on the
 * terminal (hidden input), so it never appears in a URL, a command line, the
 * process list or the shell history. For unattended installs the token comes
 * from a file only root (Windows: SYSTEM and Administrators) can read.
 *
 * Windows (0.5.0, preview): Windows PowerShell 5.1 as administrator. TLS 1.2 is
 * switched on first (Server 2016 offers TLS 1.0 only otherwise) and
 * `-UseBasicParsing` keeps Server Core working; the unattended command pins
 * the release key (docs/WINDOWS-AGENT.md, section 14.1).
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

/** A value that is safe inside single quotes of PowerShell (a quote is doubled). */
export function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

const SCRIPT: Record<EndpointOsName, string> = {
  linux: "linux.sh",
  darwin: "macos.sh",
  windows: "windows.ps1",
};

/** Where the installed agent lives (writable by root or Administrators only, see agent/README.md). */
export const INSTALLED_AGENT: Record<EndpointOsName, string> = {
  linux: "/opt/restow-agent/bin/restow-agent",
  darwin: "/Library/Application Support/Restow/bin/restow-agent",
  windows: "C:\\Program Files\\Restow\\bin\\restow-agent.exe",
};

/**
 * The token file the unattended command reads (the operator puts the token
 * there first, readable by root only); in root's home folder of the system, on
 * Windows in the profile of SYSTEM, where RMM tools running as SYSTEM can write.
 */
export const TOKEN_FILE: Record<EndpointOsName, string> = {
  linux: "/root/restow-enrollment.token",
  darwin: "/var/root/restow-enrollment.token",
  windows: "C:\\Windows\\System32\\config\\systemprofile\\restow-enrollment.token",
};

/** Switches Windows PowerShell 5.1 to TLS 1.2 before it fetches anything. */
const PS_TLS12 = "[Net.ServicePointManager]::SecurityProtocol = 'Tls12'";

export interface InstallCommandOptions {
  /**
   * Windows: the SHA256 fingerprint of the release signing key (`SHA256:...`, as `ssh-keygen -l`
   * prints it), pinned in the unattended command; null when the installation ships no key.
   */
  releaseKeyFingerprint?: string | null;
}

/** A fingerprint as `ssh-keygen -l` writes it: nothing that needs quoting. */
const FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/;

/**
 * The install and uninstall commands for a system. The instance URL must be a
 * plain origin (scheme, host, port); it is quoted all the same.
 */
export function installCommands(
  os: EndpointOsName,
  instanceUrl: string,
  options: InstallCommandOptions = {},
): InstallCommands {
  const base = instanceUrl.replace(/\/+$/, "");
  if (!isSafeOrigin(base)) {
    throw new TypeError("unsafe instance URL for an install command");
  }
  if (os === "windows") {
    return windowsCommands(base, options.releaseKeyFingerprint ?? null);
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

function windowsCommands(base: string, fingerprint: string | null): InstallCommands {
  const script = psQuote(`${base}/install/${SCRIPT.windows}`);
  const fetch = `irm -UseBasicParsing ${script}`;
  const agent = psQuote(INSTALLED_AGENT.windows);
  const pin =
    fingerprint && FINGERPRINT.test(fingerprint)
      ? `$env:RESTOW_RELEASE_KEY_FINGERPRINT = ${psQuote(fingerprint)}; `
      : "";
  return {
    install: `${PS_TLS12}; iex (${fetch})`,
    installUnattended: `$env:RESTOW_TOKEN_FILE = ${psQuote(TOKEN_FILE.windows)}; ${pin}${PS_TLS12}; iex (${fetch})`,
    tokenFile: TOKEN_FILE.windows,
    uninstallScript: `${PS_TLS12}; & ([scriptblock]::Create((${fetch}))) -Uninstall`,
    uninstallAgent: `& ${agent} uninstall`,
    hooksScripts: `& ${agent} hooks scripts`,
    hooksAny: `& ${agent} hooks any`,
  };
}

/** The SHA256 fingerprint of an OpenSSH public key line, as `ssh-keygen -l` prints it. */
export function releaseKeyFingerprint(keyLine: string): string | null {
  const blob = keyLine.trim().split(/\s+/)[1];
  if (!blob) {
    return null;
  }
  const digest = createHash("sha256").update(Buffer.from(blob, "base64")).digest("base64");
  return `SHA256:${digest.replace(/=+$/, "")}`;
}
