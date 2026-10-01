import { beforeAll, describe, expect, it, vi } from "vitest";

import { i18n } from "@/i18n";

import { ConfirmDialog, confirmationMatches } from "./confirm-dialog.js";
import { render } from "./test-utils.js";

// Server rendering has no document to portal into (Radix renders nothing
// there), so these tests swap only the portal for one that renders in place.
// Everything inside it is the production path: the shadcn AlertDialogContent
// with its overlay, classes and data slots, around the Radix primitive.
vi.mock("radix-ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("radix-ui")>();
  const InPlacePortal = ({ children }: { children?: unknown }) => children;
  return { ...actual, AlertDialog: { ...actual.AlertDialog, Portal: InPlacePortal } };
});

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

const base = {
  title: "Delete the storage target?",
  description: "Snapshots on this target can no longer be restored through Restow.",
  confirmLabel: "Delete target",
  onConfirm: () => {},
};

/** The opening tag of the button whose label is `label`. */
function buttonTag(html: string, label: string): string {
  const buttons = html.match(/<button\b[^>]*>(?:(?!<\/button>).)*<\/button>/g) ?? [];
  const button = buttons.find((candidate) => candidate.includes(label));
  if (!button) {
    throw new Error(`no button labelled ${label}`);
  }
  return button.slice(0, button.indexOf(">") + 1);
}

describe("ConfirmDialog", () => {
  it("renders an alertdialog with title, description and both buttons", () => {
    const html = render(<ConfirmDialog open {...base} />);
    expect(html).toContain('role="alertdialog"');
    expect(html).toContain(base.title);
    expect(html).toContain(base.description);
    expect(html).toContain("Cancel");
    expect(buttonTag(html, "Delete target")).toContain('type="submit"');
    expect(buttonTag(html, "Delete target")).toContain('data-variant="default"');
  });

  it("renders the styled shadcn panel and its overlay", () => {
    const html = render(<ConfirmDialog open {...base} />);
    expect(html).toContain('data-slot="alert-dialog-overlay"');
    expect(html).toMatch(/<div[^>]*role="alertdialog"[^>]*data-slot="alert-dialog-content"/);
    expect(html).toContain('data-slot="alert-dialog-footer"');
  });

  it("renders nothing while closed", () => {
    const html = render(<ConfirmDialog open={false} {...base} />);
    expect(html).not.toContain("alertdialog");
    expect(html).not.toContain("alert-dialog-overlay");
  });

  it("renders only its trigger until opened (uncontrolled use)", () => {
    const html = render(
      <ConfirmDialog
        trigger={<button type="button">Delete</button>}
        {...base}
        onConfirm={() => Promise.resolve()}
      />,
    );
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('data-state="closed"');
    expect(html).not.toContain("alertdialog");
  });

  it("styles the confirm button as destructive", () => {
    const html = render(<ConfirmDialog open destructive {...base} />);
    expect(buttonTag(html, "Delete target")).toContain('data-variant="destructive"');
  });

  it("keeps the confirm button disabled until the text is typed", () => {
    const html = render(<ConfirmDialog open destructive confirmationText="backup-eu" {...base} />);
    expect(html).toContain("To confirm, type the following:");
    expect(html).toMatch(/<code[^>]*>backup-eu<\/code>/);
    expect(buttonTag(html, "Delete target")).toContain('disabled=""');
    expect(html).toContain('autoComplete="off"');
  });

  it("shows the error inside the dialog", () => {
    const html = render(
      <ConfirmDialog open {...base} error="The target is still used by 3 policies." />,
    );
    expect(html).toContain('role="alertdialog"');
    expect(html).toContain('role="alert"');
    expect(html).toContain("The target is still used by 3 policies.");
  });

  it("is busy and cannot be cancelled while pending", () => {
    const html = render(<ConfirmDialog open pending {...base} />);
    expect(buttonTag(html, "Delete target")).toContain('aria-busy="true"');
    expect(buttonTag(html, "Cancel")).toContain('disabled=""');
  });

  it("uses the caller's cancel label and extra content", () => {
    const html = render(
      <ConfirmDialog open cancelLabel="Keep target" {...base}>
        <ul>
          <li>3 snapshots</li>
        </ul>
      </ConfirmDialog>,
    );
    expect(html).toContain("Keep target");
    expect(html).toContain("<li>3 snapshots</li>");
  });
});

describe("confirmationMatches", () => {
  it("requires the exact text, ignoring surrounding spaces", () => {
    expect(confirmationMatches(undefined, "")).toBe(true);
    expect(confirmationMatches("backup-eu", "")).toBe(false);
    expect(confirmationMatches("backup-eu", "Backup-EU")).toBe(false);
    expect(confirmationMatches("backup-eu", " backup-eu ")).toBe(true);
  });
});
