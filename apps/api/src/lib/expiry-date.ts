import { parseExpiryDate } from "@restow/core";
import { z } from "zod";

/**
 * The expiry date of a Microsoft 365 app secret as a request field (Settings → Microsoft 365,
 * a source's own app): the date an admin noted from the Entra portal, `2027-03-01` (a time
 * after it ignored), stored as midnight UTC in ISO 8601 (@restow/core entra/expiry.ts,
 * parseExpiryDate). Empty or null means unknown and becomes null; anything else that is no
 * valid calendar date is refused with the issue message `date`, which the web maps onto its
 * translation. Never echoes the submitted value.
 */
export function expiryDateField() {
  return z
    .string({ invalid_type_error: "date" })
    .trim()
    .nullish()
    .transform((value) => (value && value.length > 0 ? value : null))
    .transform((value, ctx) => {
      if (value === null) {
        return null;
      }
      const date = parseExpiryDate(value);
      if (!date) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "date" });
        return z.NEVER;
      }
      return date;
    });
}
