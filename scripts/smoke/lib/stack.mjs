/**
 * The stack under test: the release compose file (deploy/release), copied into
 * a working directory next to a generated .env and the smoke overlay
 * (docker-compose.smoke.yml), and driven through `docker compose`. The repository's
 * own files are never written to. Secrets are generated per run and live only in
 * the working directory, which is git-ignored and removed with the stack.
 */
import { randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run, sleep, waitFor } from "./exec.mjs";
import { createSelfSignedCertificate } from "./selfsigned.mjs";

export const APP_IMAGE = "restow-smoke/app";
export const WEB_IMAGE = "restow-smoke/web";

const hex = (bytes) => randomBytes(bytes).toString("hex");
const base64 = (bytes) => randomBytes(bytes).toString("base64");

/** Every port of a stack, derived from one base so two stacks never collide. */
export function portsFor(base) {
  return {
    api: base,
    journal: base + 25,
    https: base + 43,
    http: base + 80,
    imap: base + 14,
    s3: base + 90,
  };
}

/** The journal host of the stack: the address check 6 reads from the API is `journal+<token>@` this. */
export const JOURNAL_HOST = "archive.smoke.test";

/** Where the release compose mounts the operator's certificate directory in the api container. */
export const JOURNAL_TLS_MOUNT = "/etc/restow/journal-tls";

export const MAILBOXES = ["alice", "bob", "s3box", "localbox", "nfsbox", "upgrade"].map(
  (name) => `${name}@smoke.test`,
);

export class Stack {
  /**
   * @param {object} options
   * @param {string} options.repoRoot   the repository
   * @param {string} options.dir        working directory of this stack
   * @param {string} options.project    compose project name
   * @param {number} options.portBase
   * @param {string} options.tag        image tag both images carry (APP_IMAGE / WEB_IMAGE)
   * @param {string} [options.garageImage]
   * @param {string} [options.licensePublicKey]
   *   verification key of the run's throwaway license signer (full build, lib/license.mjs);
   *   the api trusts keys signed with it. Absent for the community build and the upgrade stack.
   */
  constructor(options) {
    this.repoRoot = options.repoRoot;
    this.dir = options.dir;
    this.project = options.project;
    this.ports = portsFor(options.portBase);
    this.tag = options.tag;
    this.garageImage = options.garageImage;
    this.licensePublicKey = options.licensePublicKey ?? null;
    this.imapPassword = hex(12);
    this.postgresPassword = hex(16);
    this.appPassword = hex(16);
    this.providerPassword = hex(16);
    this.masterKey = base64(32);
    this.authSecret = base64(32);
    this.garageRpcSecret = hex(32);
    this.garageAdminToken = hex(16);
    this.nfsDir = join(this.dir, "nfs-sim");
    // The journal receiver refuses to start without a certificate, so the stack gets a
    // throwaway self-signed one for the journal host; check 6's SMTP client trusts exactly
    // this certificate and checks the host name against it (the real TLS path, no opt-out).
    this.journalTlsDir = join(this.dir, "journal-tls");
    this.journalCertificate = createSelfSignedCertificate({
      commonName: JOURNAL_HOST,
      dnsNames: [JOURNAL_HOST],
    });
    this.publicUrl = `https://localhost:${this.ports.https}`;
    this.apiUrl = `http://127.0.0.1:${this.ports.api}`;
  }

  /** Write .env, the compose files and the Garage config into the working directory. */
  writeFiles() {
    mkdirSync(this.dir, { recursive: true });
    mkdirSync(this.nfsDir, { recursive: true });
    // Mounted read-only as the server-side import folder; Docker would create it as root.
    mkdirSync(join(this.dir, "import"), { recursive: true });
    // Mounted read-only into the api (JOURNAL_TLS_DIR); the files are read inside the
    // container, which runs as root, so the key can stay private to this user.
    mkdirSync(this.journalTlsDir, { recursive: true });
    writeFileSync(join(this.journalTlsDir, "fullchain.pem"), this.journalCertificate.certPem, {
      mode: 0o644,
    });
    writeFileSync(join(this.journalTlsDir, "privkey.pem"), this.journalCertificate.keyPem, {
      mode: 0o600,
    });
    copyFileSync(
      join(this.repoRoot, "deploy/release/docker-compose.yml"),
      join(this.dir, "docker-compose.yml"),
    );
    copyFileSync(
      join(this.repoRoot, "scripts/smoke/docker-compose.smoke.yml"),
      join(this.dir, "docker-compose.smoke.yml"),
    );
    const database = "restow";
    const env = {
      RESTOW_IMAGE: `${APP_IMAGE}:${this.tag}`,
      RESTOW_WEB_IMAGE: `${WEB_IMAGE}:${this.tag}`,
      // The opt-in updater's own image, which the release compose file requires for the
      // `updater` profile; check 1 validates the file with that profile. The profile is
      // never started here.
      RESTOW_UPDATER_IMAGE: `${APP_IMAGE}:${this.tag}`,
      RESTOW_PUBLIC_URL: this.publicUrl,
      // Caddy issues a certificate from its own CA for localhost: the passkey
      // origin is a real https origin, the browser of the E2E ignores the CA.
      RESTOW_APP_DOMAIN: "localhost",
      RESTOW_API_PORT: this.ports.api,
      RESTOW_HTTP_PORT: this.ports.http,
      RESTOW_HTTPS_PORT: this.ports.https,
      JOURNAL_SMTP_PORT: this.ports.journal,
      // The host of the journal addresses the api hands out (check 6); no DNS is involved.
      JOURNAL_HOSTNAME: JOURNAL_HOST,
      JOURNAL_TLS_DIR: this.journalTlsDir,
      JOURNAL_TLS_CERT_PATH: `${JOURNAL_TLS_MOUNT}/fullchain.pem`,
      JOURNAL_TLS_KEY_PATH: `${JOURNAL_TLS_MOUNT}/privkey.pem`,
      POSTGRES_PASSWORD: this.postgresPassword,
      DATABASE_MIGRATION_URL: `postgres://restow:${this.postgresPassword}@postgres:5432/${database}`,
      DATABASE_URL: `postgres://restow_app:${this.appPassword}@postgres:5432/${database}`,
      DATABASE_PROVIDER_URL: `postgres://restow_provider:${this.providerPassword}@postgres:5432/${database}`,
      RESTOW_MASTER_KEY: this.masterKey,
      BETTER_AUTH_SECRET: this.authSecret,
      STORAGE_TARGET: "local",
      STORAGE_LOCAL_PATH: "/data/chunks",
      // The test IMAP server has no TLS and sits on a private network.
      IMAP_ALLOW_INSECURE: "true",
      IMAP_ALLOW_PRIVATE_NETWORKS: "true",
      SMOKE_NFS_DIR: this.nfsDir,
      SMOKE_REPO_ROOT: this.repoRoot,
      SMOKE_IMAP_MAILBOXES: MAILBOXES.join(","),
      SMOKE_IMAP_PASSWORD: this.imapPassword,
      SMOKE_IMAP_PORT: this.ports.imap,
      SMOKE_S3_PORT: this.ports.s3,
      SMOKE_GARAGE_CONFIG: join(this.dir, "garage.toml"),
    };
    if (this.garageImage) {
      env.SMOKE_GARAGE_IMAGE = this.garageImage;
    }
    if (this.licensePublicKey) {
      // The Business archive layer (journal receiver) and several tenants need a license
      // key; check 3 installs one signed by this run's throwaway signer (lib/license.mjs).
      env.RESTOW_LICENSE_PUBLIC_KEY = this.licensePublicKey;
    }
    writeFileSync(
      join(this.dir, ".env"),
      `${Object.entries(env)
        .map(([key, value]) => `${key}=${value}`)
        .join("\n")}\n`,
      { mode: 0o600 },
    );
    writeFileSync(
      join(this.dir, "garage.toml"),
      [
        'metadata_dir = "/var/lib/garage/meta"',
        'data_dir = "/var/lib/garage/data"',
        'db_engine = "sqlite"',
        "replication_factor = 1",
        'rpc_bind_addr = "0.0.0.0:3901"',
        'rpc_public_addr = "127.0.0.1:3901"',
        `rpc_secret = "${this.garageRpcSecret}"`,
        "",
        "[s3_api]",
        's3_region = "garage"',
        'api_bind_addr = "0.0.0.0:3900"',
        'root_domain = ".s3.garage.smoke"',
        "",
        "[admin]",
        'api_bind_addr = "0.0.0.0:3903"',
        `admin_token = "${this.garageAdminToken}"`,
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
  }

  /** Change the tag both Restow images run (an upgrade in place). */
  setTag(tag) {
    this.tag = tag;
    this.addEnv({ RESTOW_IMAGE: `${APP_IMAGE}:${tag}`, RESTOW_WEB_IMAGE: `${WEB_IMAGE}:${tag}` });
  }

  /** Add or replace variables of the stack's .env (applied by the next `up`). */
  addEnv(values) {
    const path = join(this.dir, ".env");
    const lines = readEnv(path).filter((line) => !Object.hasOwn(values, line.split("=")[0]));
    for (const [key, value] of Object.entries(values)) {
      lines.push(`${key}=${value}`);
    }
    writeFileSync(path, `${lines.join("\n")}\n`, { mode: 0o600 });
  }

  composeArgs(args) {
    return [
      "compose",
      "--project-name",
      this.project,
      "--project-directory",
      this.dir,
      "--env-file",
      join(this.dir, ".env"),
      "-f",
      join(this.dir, "docker-compose.yml"),
      "-f",
      join(this.dir, "docker-compose.smoke.yml"),
      ...args,
    ];
  }

  compose(args, options = {}) {
    return run("docker", this.composeArgs(args), { cwd: this.dir, ...options });
  }

  async up(services = [], { forceRecreate = false, ...options } = {}) {
    const flags = forceRecreate ? ["--force-recreate"] : [];
    return this.compose(["up", "--detach", "--quiet-pull", ...flags, ...services], {
      timeoutMs: 600_000,
      ...options,
    });
  }

  async down() {
    return this.compose(["down", "--volumes", "--remove-orphans", "--timeout", "10"], {
      allowFailure: true,
      timeoutMs: 180_000,
    });
  }

  async exec(service, command, options = {}) {
    return this.compose(["exec", "-T", service, ...command], options);
  }

  /** Run a SQL statement as the database owner; returns the unaligned, tuples-only output. */
  async sql(statement) {
    const result = await this.exec("postgres", [
      "psql",
      "-U",
      "restow",
      "-d",
      "restow",
      "-At",
      "-c",
      statement,
    ]);
    return result.stdout.trim();
  }

  async logs(service, tail = 200) {
    const result = await this.compose(["logs", "--no-color", "--tail", String(tail), service], {
      allowFailure: true,
    });
    return result.stdout + result.stderr;
  }

  /** {service: {state, health, restarts}} for every container of the project. */
  async containers() {
    const listed = await this.compose(["ps", "--all", "--format", "json"], { allowFailure: true });
    const rows = listed.stdout
      .split("\n")
      .filter((line) => line.trim().startsWith("{"))
      .map((line) => JSON.parse(line));
    const result = {};
    for (const row of rows) {
      const inspected = await run("docker", ["inspect", "--format", "{{.RestartCount}}", row.ID], {
        allowFailure: true,
      });
      result[row.Service] = {
        state: row.State,
        health: row.Health || "",
        restarts: Number.parseInt(inspected.stdout.trim(), 10) || 0,
        name: row.Name,
      };
    }
    return result;
  }

  /** The named Docker volume of a compose volume key. */
  volume(name) {
    return `${this.project}_${name}`;
  }

  async waitForApi({ timeoutMs = 240_000 } = {}) {
    await waitFor(
      "the api to answer /healthz",
      async () => {
        const response = await fetch(`${this.apiUrl}/healthz`, {
          signal: AbortSignal.timeout(3000),
        });
        return response.ok;
      },
      { timeoutMs, intervalMs: 2000 },
    );
  }
}

function readEnv(path) {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.length > 0);
}

export { sleep };
