/**
 * The failure behind a red "Verify permissions" result of a Microsoft 365
 * source (entra/verify.ts): a refused token, missing application permissions,
 * or a Graph test call that failed. Turns the result the API already stores
 * into a cause, so the source page explains it like a failed job.
 */
import type { ConnectionVerification } from "../entra/verify.js";
import { GraphError } from "../graph/errors.js";
import { buildCause } from "./classify.js";
import { classifyGraphError } from "./graph.js";
import { redactSensitiveText } from "./redact.js";
import type { FailureCause, FailureParams, FailureTechnical } from "./types.js";

/** Permission names shown in a cause; the checklist on the source page lists the rest. */
const MAX_LISTED_PERMISSIONS = 6;

/** The cause of a verification that did not come back green, or null when it did. */
export function causeOfVerification(verification: ConnectionVerification): FailureCause | null {
  if (verification.ok) {
    return null;
  }
  if (verification.tokenError) {
    const { hint, aadsts, code, status, message } = verification.tokenError;
    const technical: FailureTechnical = { message: redactSensitiveText(message) };
    if (aadsts) {
      technical.aadsts = aadsts;
    }
    if (code) {
      technical.errorCode = redactSensitiveText(code, 120);
    }
    if (status !== null) {
      technical.httpStatus = status;
    }
    const params: FailureParams = {};
    if (aadsts) {
      params.aadsts = aadsts;
    }
    switch (hint) {
      case "consent_missing":
        return buildCause("graph.consent_missing", params, technical);
      case "invalid_credentials":
        return buildCause(
          "graph.app_credentials_invalid",
          { ...params, reason: "invalid_secret" },
          technical,
        );
      case "credentials_expired":
        return buildCause(
          "graph.app_credentials_invalid",
          { ...params, reason: "secret_expired" },
          technical,
        );
      case "tenant_unknown":
        return buildCause("graph.tenant_not_found", params, technical);
      default:
        return buildCause("graph.token_rejected", params, technical);
    }
  }
  const permissions = verification.permissions;
  if (permissions && !permissions.complete) {
    const names = [...new Set(permissions.missing)];
    const readOnly = permissions.readOnlyInstead.map((entry) => entry.granted);
    return buildCause(
      "graph.permission_missing",
      {
        permission: names.slice(0, MAX_LISTED_PERMISSIONS).join(", "),
        count: names.length,
        ...(readOnly.length > 0 ? { grantedInstead: readOnly.join(", ") } : {}),
      },
      { message: redactSensitiveText(`missing: ${names.join(", ")}`) },
    );
  }
  const testCall = verification.testCall;
  if (testCall && !testCall.ok) {
    const status = testCall.status ?? 0;
    const graphError = new GraphError({
      status,
      method: "GET",
      url: "/users",
      payload: { error: { code: testCall.code ?? undefined, message: testCall.message } },
    });
    return classifyGraphError(graphError);
  }
  return buildCause("unknown", {}, { message: "the verification did not succeed" });
}
