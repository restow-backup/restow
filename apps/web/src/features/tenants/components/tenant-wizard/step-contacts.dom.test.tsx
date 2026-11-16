// @vitest-environment happy-dom
import { act } from "react";
import { type UseFormReturn, useForm } from "react-hook-form";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { enableActEnvironment, flush, type Mounted, mount } from "@/features/updates/testing";
import { i18n } from "@/i18n";
import { zodResolver } from "@/lib/form";

import "../../i18n";
import {
  emptyContact,
  emptyTenantWizardForm,
  type TenantWizardValues,
  tenantWizardSchema,
} from "../../forms";
import { ContactsStep } from "./step-contacts";

/**
 * "Receives the monthly report" per contact (0.5.0): offered on the tenant page where the
 * customer monthly report exists, never in the wizard; a contact who receives it needs an
 * e-mail address.
 */

enableActEnvironment();

let mounted: Mounted | null = null;
let form: UseFormReturn<TenantWizardValues> | null = null;

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  form = null;
  document.body.innerHTML = "";
});

function Harness({ monthlyReport }: { monthlyReport: boolean }) {
  const own = useForm<TenantWizardValues>({
    resolver: zodResolver(tenantWizardSchema),
    defaultValues: {
      ...emptyTenantWizardForm("en"),
      name: "Contoso GmbH",
      slug: "contoso",
      contacts: [{ ...emptyContact(true), name: "Alice" }],
    },
  });
  form = own;
  return <ContactsStep form={own} monthlyReport={monthlyReport} />;
}

describe("ContactsStep and the monthly report", () => {
  it("is not offered in the wizard", async () => {
    mounted = mount(<Harness monthlyReport={false} />);
    await flush(2);
    expect(document.querySelector("[data-slot=contact-monthly-report]")).toBeNull();
  });

  it("is ticked per contact and refuses a contact without an address", async () => {
    mounted = mount(<Harness monthlyReport />);
    await flush(2);
    const box = document.querySelector<HTMLButtonElement>("#wizard-contact-0-monthly");
    expect(box?.getAttribute("aria-checked")).toBe("false");
    await act(async () => box?.click());
    await flush(2);
    expect(form?.getValues("contacts.0.monthlyReport")).toBe(true);
    let valid = true;
    await act(async () => {
      valid = (await form?.trigger()) ?? true;
    });
    await flush(2);
    expect(valid).toBe(false);
    expect(document.body.textContent).toContain(
      "A contact who receives the monthly report needs an e-mail address.",
    );
  });
});
