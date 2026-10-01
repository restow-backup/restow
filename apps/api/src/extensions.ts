import type { BetterAuthPlugin } from "better-auth";
import type { Hono, MiddlewareHandler } from "hono";
import type { GatedFeature } from "./lib/features.js";
import type { ProviderRouteRule } from "./lib/provider-access.js";
import type { SignInSettings } from "./lib/sign-in-options.js";
import type { DbExecutor } from "./lib/tenant-context.js";
import type { ProblemError } from "./problem.js";
import type { IntegrationApi, V1Deps } from "./routes/v1/api.js";

/**
 * Extension points of the api app: the only way code outside the core
 * (the Business and Service Provider modules under `ee/api`, see
 * ee/README.md) adds behaviour to it. The core never imports `ee/`; the one
 * designated loader (`./ee.ts`) imports the `ee/api` entry and hands what it
 * exports to the registration functions below. Every consumer in the core
 * reads the registry when it builds its part of the app, so an installation
 * without `ee/` (or a test that never loads it) simply has nothing
 * registered.
 *
 * This module imports types only, so registering never pulls in the database
 * pools or better-auth.
 */

/**
 * better-auth plugins. Read once, when `auth.ts` builds the better-auth
 * instance, so they must be registered before anything imports `auth.ts`
 * (the loader registers them first, see ./ee.ts).
 */
export interface AuthExtension {
  readonly plugins: readonly BetterAuthPlugin[];
}

/**
 * A session-authenticated route group of the web UI, mounted under
 * `/api/v1<path>` after the core feature routes.
 */
export interface SessionRouteContribution {
  /** Mount path below `/api/v1`, e.g. `/archive/legal-holds`. */
  readonly path: string;
  /**
   * Runs ahead of every route of the group: the extension's own decision
   * whether the group answers right now. ee/ answers with the app's
   * not-found handler (problem.ts `notFoundHandler`) when the installation's
   * license lacks the feature, so a locked feature is indistinguishable from
   * an absent one. Without a guard the group always answers.
   */
  readonly guard?: MiddlewareHandler;
  // biome-ignore lint/suspicious/noExplicitAny: each group declares its own session env.
  readonly routes: Hono<any>;
}

/**
 * Decides the core functions that exist only when an extension enables them
 * (lib/features.ts, {@link GatedFeature}). Without any gate registered every
 * one of them is off: the core alone offers exactly its own features.
 */
export interface FeatureGate {
  /** Whether `feature` is on right now. Asked per request, never cached by the core. */
  isEnabled(db: DbExecutor, feature: GatedFeature): Promise<boolean>;
  /**
   * The problem the core answers while `feature` is off, e.g. one naming
   * what would enable it. Without it the core answers its own 403
   * `urn:restow:problem:feature-unavailable`.
   */
  unavailable?(db: DbExecutor, feature: GatedFeature): Promise<ProblemError>;
}

/**
 * Extra fields of `GET /api/v1/me`, under `extensions.<key>`: what an
 * extension's web module needs to know about the signed-in session (ee/ adds
 * the edition in effect). The core passes them through without reading them.
 */
export interface SessionFieldContribution {
  /** The key below `extensions`, e.g. `edition`. Unique across extensions. */
  readonly key: string;
  load(input: {
    /** The installation pool (apps/api/src/db.ts `providerDb`). */
    readonly db: DbExecutor;
    readonly userId: string;
    readonly isProviderAdmin: boolean;
  }): Promise<unknown>;
}

/**
 * Middleware that runs ahead of better-auth's own handler for the given
 * paths (below `/api/auth`), e.g. to answer 404 for the sign-in endpoints of
 * a plugin the extension keeps switched off.
 */
export interface AuthRouteGuard {
  /** Hono path patterns, e.g. `/api/auth/oauth2/*`. */
  readonly paths: readonly string[];
  readonly handler: MiddlewareHandler;
}

/** Registers operations on the integration API (routes/v1.ts `buildV1`). */
export type IntegrationRouteRegistrar = (api: IntegrationApi, deps: V1Deps) => void;

/** A sign-in method beyond passkey and the emergency password, e.g. Microsoft. */
export interface SignInProvider {
  /** Matches the flag the public setup state reports (`microsoftSignIn`). */
  readonly id: "microsoft";
  /** Whether the login page offers it right now. */
  available(settings: SignInSettings): Promise<boolean>;
}

/** A long-lived listener started next to the HTTP server (server.ts). */
export interface BackgroundService {
  readonly name: string;
  /** Starts the service, or returns null when it has nothing to do in this installation. */
  start(): Promise<{ close(): void } | null>;
}

/** Everything one extension module contributes; each part is optional. */
export interface ApiExtension {
  readonly name: string;
  readonly authRouteGuards?: readonly AuthRouteGuard[];
  readonly sessionRoutes?: readonly SessionRouteContribution[];
  readonly integrationRoutes?: readonly IntegrationRouteRegistrar[];
  readonly signInProviders?: readonly SignInProvider[];
  readonly services?: readonly BackgroundService[];
  /** Named hooks into core features (see {@link FeatureHooks}). */
  readonly hooks?: Partial<FeatureHooks>;
  readonly featureGate?: FeatureGate;
  readonly sessionFields?: readonly SessionFieldContribution[];
  /**
   * Provider team rules (lib/provider-access.ts) for the routes this
   * extension registers, keyed `METHOD /path` exactly as the router
   * registers them (e.g. `GET /api/v1/license`). The core's table covers
   * only the core's routes.
   */
  readonly providerRouteRules?: Readonly<Record<string, ProviderRouteRule>>;
}

/**
 * Hooks into core features whose shape the feature itself defines; declared
 * here by name so the registry stays one typed object. Features augment this
 * interface from their own module (declaration merging), which keeps the
 * types next to the code that calls the hook.
 */
// biome-ignore lint/suspicious/noEmptyInterface: augmented by feature modules.
export interface FeatureHooks {}

const authExtensions: AuthExtension[] = [];
const apiExtensions: ApiExtension[] = [];

export function registerAuthExtension(extension: AuthExtension): void {
  authExtensions.push(extension);
}

export function registerApiExtension(extension: ApiExtension): void {
  if (apiExtensions.some((existing) => existing.name === extension.name)) {
    throw new Error(`api extension ${extension.name} is already registered`);
  }
  const keys = new Set(sessionFieldContributions().map((field) => field.key));
  for (const field of extension.sessionFields ?? []) {
    if (keys.has(field.key)) {
      throw new Error(`session field ${field.key} is already registered`);
    }
  }
  apiExtensions.push(extension);
}

/** Every registered better-auth plugin, in registration order. */
export function authPlugins(): BetterAuthPlugin[] {
  return authExtensions.flatMap((extension) => [...extension.plugins]);
}

export function authRouteGuards(): AuthRouteGuard[] {
  return apiExtensions.flatMap((extension) => [...(extension.authRouteGuards ?? [])]);
}

export function sessionRouteContributions(): SessionRouteContribution[] {
  return apiExtensions.flatMap((extension) => [...(extension.sessionRoutes ?? [])]);
}

export function integrationRouteRegistrars(): IntegrationRouteRegistrar[] {
  return apiExtensions.flatMap((extension) => [...(extension.integrationRoutes ?? [])]);
}

export function signInProvider(id: SignInProvider["id"]): SignInProvider | null {
  for (const extension of apiExtensions) {
    const provider = extension.signInProviders?.find((candidate) => candidate.id === id);
    if (provider) {
      return provider;
    }
  }
  return null;
}

export function backgroundServices(): BackgroundService[] {
  return apiExtensions.flatMap((extension) => [...(extension.services ?? [])]);
}

/** Every registered feature gate, in registration order. */
export function featureGates(): FeatureGate[] {
  return apiExtensions.flatMap((extension) =>
    extension.featureGate ? [extension.featureGate] : [],
  );
}

export function sessionFieldContributions(): SessionFieldContribution[] {
  return apiExtensions.flatMap((extension) => [...(extension.sessionFields ?? [])]);
}

/** The provider team rule an extension registered for `key` (`METHOD /path`), or null. */
export function extensionProviderRouteRule(key: string): ProviderRouteRule | null {
  for (const extension of apiExtensions) {
    const rule = extension.providerRouteRules?.[key];
    if (rule) {
      return rule;
    }
  }
  return null;
}

/** The registered implementation of a feature hook, or null when none is. */
export function featureHook<K extends keyof FeatureHooks>(name: K): FeatureHooks[K] | null {
  for (const extension of apiExtensions) {
    const hook = extension.hooks?.[name];
    if (hook) {
      return hook as FeatureHooks[K];
    }
  }
  return null;
}

/** Test support: forget every registration (the registry is process-wide). */
export function resetExtensionsForTesting(): void {
  authExtensions.length = 0;
  apiExtensions.length = 0;
}
