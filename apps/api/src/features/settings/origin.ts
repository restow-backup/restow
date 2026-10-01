/**
 * The origin the admin's browser is on, for the passkey gate's origin check.
 * The rules (Origin, Referer, X-Forwarded-Proto/-Host, request URL) are shared
 * with every other route through lib/request.ts.
 */
export { browserOrigin, type HeaderReader } from "../../lib/request.js";
