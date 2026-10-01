import type { KeyObject } from "node:crypto";

/** A key request, as the real issuer receives it. */
export interface TestLicenseRequest {
  edition: "business" | "service_provider";
  licensee: string;
  installationId: string;
  issuedAt?: Date;
}

/** The signed payload in its wire spelling (ee/licensing/src/token.ts). */
export interface TestLicensePayload {
  edition: string;
  mailbox_limit: number | null;
  multi_tenant: boolean;
  licensee: string;
  installation_id: string;
  issued_at: string;
}

export interface TestLicenseSigner {
  /** Raw Ed25519 public key, base64url: the value for RESTOW_LICENSE_PUBLIC_KEY. */
  readonly publicKey: string;
  readonly publicKeyObject: KeyObject;
  payload(request: TestLicenseRequest): TestLicensePayload;
  sign(request: TestLicenseRequest): string;
  signPayload(payload: Record<string, unknown>): string;
  signRaw(payloadText: string): string;
}

export function createTestLicenseSigner(): TestLicenseSigner;
