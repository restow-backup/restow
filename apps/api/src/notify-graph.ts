import {
  type AppCredentials,
  ClientCredentialsTokenProvider,
  FetchGraphClient,
  TokenAcquisitionError,
  appCredentialsFingerprint,
} from "@restow/core";
import type { SupportedLanguage } from "@restow/i18n";
import {
  type MailFailureReason,
  type NotificationMessage,
  type Notifier,
  type NotifyResult,
  errorMessage,
  failed,
  testNotification,
} from "./notify-core.js";

/**
 * Microsoft 365 transport: Microsoft Graph `sendMail` as an application
 * (client credentials, application permission `Mail.Send`, docs/MICROSOFT.md
 * "Benachrichtigungs-Mail"). The app registration is either the operator's
 * own one for notifications (Settings, sealed in the installation secret
 * store) or the backup app registration; the caller resolves which.
 *
 * Failures are mapped onto reasons the UI can explain: the token endpoint's
 * AADSTS codes (wrong secret, expired secret, unknown app or tenant, rejected
 * certificate) and Graph's answers (403 without Mail.Send or outside an access
 * policy, 404 for an unknown sender).
 */

export interface GraphNotifierOptions {
  /** The sender mailbox (UPN or primary SMTP address). */
  sender: string;
  /** Directory (tenant) of the sender mailbox; null when none is known. */
  tenantId: string | null;
  /** The app registration to authenticate as; null when none is usable. */
  app: AppCredentials | null;
  /** For tests: replaces `fetch` for the token request and Graph. */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** Map an AADSTS code (or the token endpoint's error text) onto a reason. */
export function graphTokenFailureReason(message: string, code?: string): MailFailureReason {
  const aadsts = /AADSTS(\d+)/.exec(message)?.[1];
  switch (aadsts) {
    case "7000215":
      return "graph_secret_invalid";
    case "7000222":
      return "graph_secret_expired";
    case "700027":
    case "700024":
    case "700023":
    case "7000274":
      return "graph_certificate_invalid";
    case "700016":
    case "7000112":
      return "graph_app_not_found";
    case "90002":
    case "900023":
    case "90023":
      return "graph_tenant_not_found";
    default:
      break;
  }
  if (code === "invalid_tenant") {
    return "graph_tenant_not_found";
  }
  return "graph_token_failed";
}

interface GraphErrorBody {
  error?: { code?: unknown; message?: unknown };
}

/** The `error.code` and `error.message` of a Graph error body, when present. */
function graphError(body: unknown): { code: string | null; message: string | null } {
  const error = (body as GraphErrorBody | null | undefined)?.error;
  return {
    code: typeof error?.code === "string" ? error.code : null,
    message: typeof error?.message === "string" ? error.message : null,
  };
}

const SENDER_CODES: ReadonlySet<string> = new Set([
  "ErrorInvalidUser",
  "MailboxNotEnabledForRESTAPI",
  "MailboxNotHostedInExchangeOnline",
  "ResourceNotFound",
  "Request_ResourceNotFound",
]);

/** Map a non-2xx sendMail answer onto a reason. */
export function graphSendFailureReason(status: number, body: unknown): MailFailureReason {
  const { code } = graphError(body);
  if (status === 401) {
    return "graph_token_failed";
  }
  if (status === 403) {
    return "graph_send_denied";
  }
  if (status === 404 || (code !== null && SENDER_CODES.has(code))) {
    return "graph_sender_not_found";
  }
  return "transport_error";
}

function sendFailureDetail(status: number, body: unknown): string {
  const { code, message } = graphError(body);
  const suffix = code ? ` (${code})` : "";
  return message
    ? `Graph sendMail returned ${status}${suffix}: ${message}`
    : `Graph sendMail returned ${status}${suffix}.`;
}

const TOKEN_PROVIDER_LIMIT = 16;

/**
 * Token providers (with their cached token) per credential and tenant. The key
 * is the registration's fingerprint, so a replaced secret or certificate gets a
 * new provider instead of reusing the old token; it is never logged.
 */
const tokenProviders = new Map<string, ClientCredentialsTokenProvider>();

function tokenProviderFor(app: AppCredentials, tenantId: string): ClientCredentialsTokenProvider {
  const key = `${appCredentialsFingerprint(app)}:${tenantId}`;
  let provider = tokenProviders.get(key);
  if (!provider) {
    provider = new ClientCredentialsTokenProvider({ tenantId, app });
    if (tokenProviders.size >= TOKEN_PROVIDER_LIMIT) {
      const oldest = tokenProviders.keys().next().value;
      if (oldest !== undefined) {
        tokenProviders.delete(oldest);
      }
    }
    tokenProviders.set(key, provider);
  }
  return provider;
}

class GraphTokenFailure extends Error {
  constructor(
    readonly reason: MailFailureReason,
    message: string,
  ) {
    super(message);
  }
}

/** Microsoft Graph `sendMail` transport (client credentials + the throttling client). */
export class GraphNotifier implements Notifier {
  private readonly sender: string;
  private readonly tenantId: string | null;
  private readonly provider: ClientCredentialsTokenProvider | null;
  private readonly graph: FetchGraphClient;

  constructor(options: GraphNotifierOptions) {
    this.sender = options.sender;
    this.tenantId = options.tenantId;
    const { app, tenantId } = options;
    this.provider =
      app && tenantId
        ? options.fetchImpl || options.now
          ? new ClientCredentialsTokenProvider({
              tenantId,
              app,
              fetchImpl: options.fetchImpl,
              now: options.now,
            })
          : tokenProviderFor(app, tenantId)
        : null;
    this.graph = new FetchGraphClient({
      accessTokenProvider: () => this.acquireToken(),
      fetchImpl: options.fetchImpl,
      // A notification must not keep a test send waiting for minutes.
      maxRetries: 2,
    });
  }

  private async acquireToken(): Promise<string> {
    if (!this.provider) {
      throw new GraphTokenFailure(
        this.tenantId ? "graph_app_missing" : "graph_tenant_missing",
        this.tenantId
          ? "No Microsoft 365 app registration is configured for Graph sendMail."
          : "No Entra tenant is configured for the sender mailbox.",
      );
    }
    try {
      return await this.provider.getToken();
    } catch (error) {
      const message = errorMessage(error);
      const code = error instanceof TokenAcquisitionError ? error.code : undefined;
      throw new GraphTokenFailure(graphTokenFailureReason(message, code), message);
    }
  }

  async send(message: NotificationMessage): Promise<NotifyResult> {
    try {
      const response = await this.graph.request({
        method: "POST",
        url: `/users/${encodeURIComponent(this.sender)}/sendMail`,
        body: {
          message: {
            subject: message.subject,
            body: {
              contentType: message.html ? "HTML" : "Text",
              content: message.html ?? message.text,
            },
            toRecipients: [{ emailAddress: { address: message.to } }],
          },
          saveToSentItems: false,
        },
      });
      if (response.status >= 200 && response.status < 300) {
        return { ok: true };
      }
      if (response.status === 401) {
        this.provider?.invalidate();
      }
      return failed(
        graphSendFailureReason(response.status, response.body),
        sendFailureDetail(response.status, response.body),
      );
    } catch (err) {
      if (err instanceof GraphTokenFailure) {
        return failed(err.reason, err.message);
      }
      return failed("transport_error", errorMessage(err));
    }
  }

  async sendTest(to: string, language: SupportedLanguage): Promise<NotifyResult> {
    return this.send({ to, ...testNotification(language) });
  }
}
