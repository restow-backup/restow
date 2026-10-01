import { z } from "zod";

/**
 * POST /api/v1/license. The key is pasted text; line breaks a mail client
 * wrapped into it are tolerated (the verifier strips whitespace). The length
 * bound only protects the endpoint; the verifier applies the exact format.
 */
export const installLicenseSchema = z.object({
  key: z.string().trim().min(1).max(16_384),
});

export type InstallLicenseInput = z.infer<typeof installLicenseSchema>;
