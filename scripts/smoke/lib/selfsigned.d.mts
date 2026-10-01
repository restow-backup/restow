export interface SelfSignedOptions {
  /** Subject CN (default "localhost"). */
  commonName?: string;
  /** Subject alternative names (default: the common name). */
  dnsNames?: string[];
  /** Default: one hour ago. */
  notBefore?: Date;
  /** Default: in seven days. */
  notAfter?: Date;
}

export interface SelfSignedCertificate {
  certPem: string;
  keyPem: string;
}

export function createSelfSignedCertificate(options?: SelfSignedOptions): SelfSignedCertificate;
