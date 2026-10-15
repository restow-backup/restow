import type { CreateContainerBody } from "../updater/engine-api.js";
import { REDACTED, type Redactor } from "../updater/redact.js";
import { PROBE_LABEL } from "./protocol.js";
import {
  RUNNER_BINARY,
  RUNNER_CACHE_LABEL,
  RUNNER_DEADLINE_LABEL,
  RUNNER_KIND_LABEL,
  RUNNER_LABEL,
  RUNNER_SHARE_LABEL,
  RUNNER_VOLUME_LABEL,
  type RunnerExecRequest,
  type RunnerFailureCode,
  type RunnerRunKind,
  type ShareSpec,
} from "./runner-protocol.js";

/**
 * Pure building blocks of the runner (docs/FILESHARES.md 3.3-3.7): the volume options
 * of a share, the redaction of everything that could carry its password, the
 * classification of Docker's mount errors and the container specifications. Nothing
 * here talks to Docker; runner-engine.ts does.
 */

/** The SELinux label a container needs to read a cifs or nfs mount (3.3). */
export const SELINUX_CONTEXT = 'context="system_u:object_r:container_file_t:s0"';

/** Doubled commas: the kernel's escape for a literal comma in `password=` [K]. */
export function escapeOptionValue(value: string): string {
  return value.replace(/,/g, ",,");
}

export interface VolumeOptions {
  type: "cifs" | "nfs";
  device: string;
  o: string;
}

function joinSubfolder(base: string, subfolder: string): string {
  return subfolder === "" ? base : `${base}/${subfolder}`;
}

/**
 * The volume driver options of a share (3.3). Built only here, from validated
 * fields, never from text a request carries.
 */
export function shareVolumeOptions(
  spec: ShareSpec,
  access: "ro" | "rw",
  selinux = false,
): VolumeOptions {
  const context = selinux ? [SELINUX_CONTEXT] : [];
  if (spec.protocol === "smb") {
    const options = [
      `addr=${spec.address}`,
      `vers=${spec.smbVersion}`,
      "sec=ntlmssp",
      `username=${spec.username}`,
      `password=${escapeOptionValue(spec.password)}`,
      ...(spec.domain ? [`domain=${spec.domain}`] : []),
      ...(spec.seal ? ["seal"] : []),
      access,
      "soft",
      "echo_interval=30",
      "actimeo=1",
      "nodfs",
      "noperm",
      "backupuid=0",
      "uid=0",
      "gid=0",
      "file_mode=0644",
      "dir_mode=0755",
      "nobrl",
      "nostrictsync",
      ...context,
    ];
    return {
      type: "cifs",
      device: joinSubfolder(`//${spec.server}/${spec.share}`, spec.subfolder),
      o: options.join(","),
    };
  }
  const options = [
    `addr=${spec.address}`,
    `vers=${spec.nfsVersion}`,
    access,
    "soft",
    "timeo=600",
    "retrans=3",
    "noatime",
    ...(spec.nfsVersion === "3" ? ["nolock"] : []),
    ...context,
  ];
  const path =
    spec.export === "/" ? `/${spec.subfolder}` : joinSubfolder(spec.export, spec.subfolder);
  return { type: "nfs", device: `:${path}`, o: options.join(",") };
}

/** Docker's error lines put the option string after `data: ` (3.7). */
const DATA_SECTION = /data: [^\n]*/g;

/** errno texts a mount error ends with, kept when the `data:` section is cut. */
const ERRNO_TEXTS = [
  "permission denied",
  "key has expired",
  "no route to host",
  "host is down",
  "connection refused",
  "connection timed out",
  "network is unreachable",
  "no such file or directory",
  "no such device or address",
  "no such device",
  "operation not supported",
  "protocol not supported",
  "invalid argument",
  "resource temporarily unavailable",
];

/**
 * A redactor for one runner request (3.7): it knows the password, its comma-doubled
 * form, the user name and the whole option string, and removes `password=...`,
 * `pass=...` and Docker's `data: ...` section in addition to the mounter's own
 * patterns (secrets, tokens). Every detail, stderr tail, log line and HTTP error of a
 * runner operation passes through it.
 */
export class RunnerRedactor {
  private readonly base: Redactor;
  private readonly exact: string[] = [];

  constructor(base: Redactor, values: readonly (string | null | undefined)[]) {
    this.base = base;
    for (const value of values) {
      // Even short values: a user name of four letters is still a user name. Values
      // of fewer than 3 characters would destroy the text and are left to the patterns.
      if (value && value.length >= 3 && !this.exact.includes(value)) {
        this.exact.push(value);
      }
    }
    this.exact.sort((a, b) => b.length - a.length);
  }

  static forShare(base: Redactor, spec: ShareSpec, extra: readonly string[] = []): RunnerRedactor {
    const values: string[] = [...extra];
    if (spec.protocol === "smb") {
      values.push(spec.password, escapeOptionValue(spec.password), spec.username);
      values.push(shareVolumeOptions(spec, "ro").o, shareVolumeOptions(spec, "rw").o);
      values.push(shareVolumeOptions(spec, "ro", true).o, shareVolumeOptions(spec, "rw", true).o);
    }
    return new RunnerRedactor(base, values);
  }

  redact(text: string): string {
    let out = text;
    for (const value of this.exact) {
      out = out.split(value).join(REDACTED);
    }
    out = out.replace(DATA_SECTION, (section) => {
      const lower = section.toLowerCase();
      const errno = ERRNO_TEXTS.find((candidate) => lower.endsWith(`: ${candidate}`));
      return errno ? `data: ${REDACTED}: ${errno}` : `data: ${REDACTED}`;
    });
    out = out.replace(/\b(pass(?:word)?=)[^,\s]*/gi, `$1${REDACTED}`);
    out = out.replace(/\b(username=)[^,\s]*/gi, `$1${REDACTED}`);
    return this.base.redact(out);
  }

  oneLine(text: string, max = 500): string {
    const line = this.redact(text).replace(/\s+/g, " ").trim();
    return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
  }

  tail(text: string, maxChars = 4096): string {
    const redacted = this.redact(text).replace(/\r/g, "").trim();
    return redacted.length <= maxChars ? redacted : `...${redacted.slice(-maxChars)}`;
  }
}

/**
 * Classifies Docker's start error of a runner container, which is the mount error
 * (3.6): "failed to mount local volume: mount ...: <strerror>". Classify the raw
 * text, then redact what is shown.
 */
export function classifyMountError(message: string, hasVersion = true): RunnerFailureCode {
  const lower = message.toLowerCase();
  if (/unknown filesystem type|no such device(?! or address)/.test(lower)) {
    return "mount.client_missing";
  }
  if (/permission denied|key has expired/.test(lower)) {
    return "mount.auth_failed";
  }
  if (
    /no route to host|host is down|connection refused|connection timed out|network is unreachable|timed out/.test(
      lower,
    )
  ) {
    return "mount.unreachable";
  }
  if (/no such file or directory|no such device or address/.test(lower)) {
    return "mount.not_found";
  }
  if (
    /operation not supported|protocol not supported/.test(lower) ||
    (hasVersion && /invalid argument/.test(lower))
  ) {
    return "mount.version";
  }
  return "mount.failed";
}

/** EKEYEXPIRED: the account's password expired (the cause carries `expired`). */
export function isExpiredKey(message: string): boolean {
  return /key has expired/i.test(message);
}

// ---------------------------------------------------------------------------
// Container specifications (3.4)
// ---------------------------------------------------------------------------

export const RUNNER_PATH = "/usr/local/bin:/usr/bin:/bin";
const MIB = 1024 * 1024;

/** Capabilities per kind: the file ones a backup or restore needs, nothing else. */
export function capabilitiesFor(kind: RunnerRunKind | "exec"): string[] {
  const read = ["DAC_READ_SEARCH", "DAC_OVERRIDE"];
  return kind === "restore" ? [...read, "CHOWN", "FOWNER", "FSETID"] : read;
}

function hostBase(memoryMiB: number) {
  return {
    ReadonlyRootfs: true,
    Tmpfs: { "/tmp": "size=64m,mode=1777" },
    CapDrop: ["ALL"],
    SecurityOpt: ["no-new-privileges:true"],
    Privileged: false,
    Memory: memoryMiB * MIB,
    MemorySwap: memoryMiB * MIB,
    PidsLimit: 256,
    LogConfig: { Type: "json-file", Config: { "max-size": "1m", "max-file": "1" } },
    AutoRemove: false,
  };
}

/** Names of a run's volumes and container. */
export function runNames(runId: string, cacheKey: string, role: "source" | "target") {
  const short = runId.replace(/-/g, "").slice(0, 8);
  return {
    container: `restow-runner-${runId}`,
    shareVolume: `restow-share-${short}-${role}`,
    scratchVolume: `restow-share-scratch-${runId}`,
    cacheVolume: `restow-share-cache-${cacheKey}`,
  };
}

/** Labels every container and volume of a run carries. */
export function runLabels(
  runId: string,
  kind: RunnerRunKind,
  deadline: string,
  shareId: string,
): Record<string, string> {
  return {
    [RUNNER_LABEL]: runId,
    [RUNNER_KIND_LABEL]: kind,
    [RUNNER_DEADLINE_LABEL]: deadline,
    [RUNNER_SHARE_LABEL]: shareId,
  };
}

export interface RunContainerInput {
  image: string;
  runId: string;
  kind: RunnerRunKind;
  token: string;
  apiUrl: string;
  network: string;
  protocol: "smb" | "nfs";
  shareVolume: string;
  scratchVolume: string;
  cacheVolume: string;
  readOnly: boolean;
  memoryMiB: number;
  goMemLimitMiB: number;
  deadline: string;
  shareId: string;
}

/** The container of a backup or restore run. */
export function runContainerSpec(input: RunContainerInput): CreateContainerBody {
  return {
    Image: input.image,
    Entrypoint: [RUNNER_BINARY],
    Cmd: ["run"],
    WorkingDir: "/",
    Env: [
      `RESTOW_SHARE_API_URL=${input.apiUrl}`,
      `RESTOW_SHARE_RUN_ID=${input.runId}`,
      `RESTOW_SHARE_RUN_TOKEN=${input.token}`,
      `RESTOW_SHARE_EXPECT=${input.protocol}`,
      `GOMEMLIMIT=${input.goMemLimitMiB}MiB`,
      "TMPDIR=/cache/tmp",
      "RESTIC_CACHE_DIR=/cache/restic",
      "HOME=/tmp",
      `PATH=${RUNNER_PATH}`,
    ],
    Labels: runLabels(input.runId, input.kind, input.deadline, input.shareId),
    HostConfig: {
      ...hostBase(input.memoryMiB),
      Binds: [
        `${input.shareVolume}:/share${input.readOnly ? ":ro" : ""}`,
        `${input.scratchVolume}:/.restow`,
        `${input.cacheVolume}:/cache`,
      ],
      NetworkMode: input.network,
      CapAdd: capabilitiesFor(input.kind),
    },
  };
}

export interface ExecContainerInput {
  image: string;
  request: RunnerExecRequest;
  volume: string;
}

/** Memory of a test or list container. */
export const EXEC_MEMORY_MIB = 256;

/** The container of a test or list: no network, read-only share, labelled as a probe. */
export function execContainerSpec(input: ExecContainerInput): CreateContainerBody {
  const { request } = input;
  const cmd =
    request.op === "probe"
      ? ["probe", "--expect", request.share.protocol]
      : ["list", "--path", request.path ?? "", "--limit", String(request.limit ?? 500)];
  return {
    Image: input.image,
    Entrypoint: [RUNNER_BINARY],
    Cmd: cmd,
    WorkingDir: "/",
    Env: [`RESTOW_SHARE_EXPECT=${request.share.protocol}`, "HOME=/tmp", `PATH=${RUNNER_PATH}`],
    Labels: { [PROBE_LABEL]: "1" },
    NetworkDisabled: true,
    HostConfig: {
      ...hostBase(EXEC_MEMORY_MIB),
      Binds: [`${input.volume}:/share:ro`],
      NetworkMode: "none",
      CapAdd: capabilitiesFor("exec"),
    },
  };
}

/** Labels of a run's share and scratch volumes (removed with the run). */
export function runVolumeLabels(
  runId: string,
  kind: RunnerRunKind,
  deadline: string,
  shareId: string,
): Record<string, string> {
  return { ...runLabels(runId, kind, deadline, shareId), [RUNNER_VOLUME_LABEL]: "1" };
}

/** Labels of a share's cache volume (kept between runs, removed with the share). */
export function cacheVolumeLabels(shareId: string): Record<string, string> {
  return { [RUNNER_CACHE_LABEL]: shareId };
}
