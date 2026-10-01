import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { i18n } from "@/i18n";

import type { EntryPreview, Snapshot, SnapshotObject, TreeEntry } from "../api.js";
import { restoreKeys } from "../api.js";
import { type DetailsActions, DetailsPanel } from "./details-panel.js";

vi.mock("@/lib/session", () => ({
  useSession: () => ({
    status: "authenticated",
    activeTenant: { id: "t-1", name: "Contoso", role: "tenant_admin" },
    isProviderAdmin: false,
  }),
}));

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

const object: SnapshotObject = {
  id: "o1",
  kind: "mailbox",
  externalId: "anna@example.com",
  displayName: "Anna Example",
  status: "active",
  sourceKind: "m365",
  ownerEmail: "anna@example.com",
  own: true,
  snapshotCount: 2,
  latestSnapshotId: "s1",
  latestSnapshotAt: "2026-09-20T10:00:00.000Z",
  readiness: "green",
};

const snapshot: Snapshot = {
  id: "s1",
  objectId: "o1",
  sequence: 2,
  itemCount: 10,
  byteSize: 4096,
  startedAt: "2026-09-20T09:00:00.000Z",
  completedAt: "2026-09-20T10:00:00.000Z",
  createdAt: "2026-09-20T10:00:00.000Z",
};

const mail = {
  subject: "Contract draft",
  from: "legal@example.com",
  to: "anna@example.com",
  cc: null,
  toCount: 1,
  ccCount: 0,
  date: "2026-09-19T08:00:00.000Z",
  sentDateTime: "2026-09-19T07:58:00.000Z",
  hasAttachments: false,
  isRead: true,
  flagged: false,
  protection: null,
} satisfies TreeEntry["mail"];

const mailEntry: TreeEntry = {
  id: "e1",
  kind: "mail",
  name: "contract.eml",
  path: "Inbox/contract.eml",
  parentPath: "Inbox",
  size: 2048,
  mtime: "2026-09-19T08:00:00.000Z",
  itemId: "item-1",
  deleted: false,
  implicit: false,
  contentType: "message/rfc822",
  mail,
};

const preview: EntryPreview = {
  previewable: true,
  headers: {
    subject: "Contract draft",
    from: "legal@example.com",
    to: ["anna@example.com"],
    cc: [],
    date: "2026-09-19T08:00:00.000Z",
    messageId: "<contract@example.com>",
  },
  body: { kind: "html", content: "<p>Please review.</p>" },
  attachments: [],
};

const actions: DetailsActions = {
  onClose: () => {},
  onOpenFolder: () => {},
  onReveal: () => {},
  onRestore: () => {},
  onShowVersion: () => {},
  onRestoreVersion: () => {},
  onDownloadStored: () => {},
};

function render(entry: TreeEntry): string {
  const client = new QueryClient();
  client.setQueryData(restoreKeys.preview("t-1", "s1", entry.id), preview);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={i18n}>
        <DetailsPanel
          entry={entry}
          object={object}
          snapshot={snapshot}
          canReveal={false}
          {...actions}
        />
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

describe("DetailsPanel", () => {
  it("puts the reading pane ahead of the restore/download actions for a mail entry", () => {
    const html = render(mailEntry);
    const readingPaneAt = html.indexOf("Please review.");
    const restoreButtonAt = html.indexOf(">Restore …<");
    expect(readingPaneAt).toBeGreaterThan(-1);
    expect(restoreButtonAt).toBeGreaterThan(readingPaneAt);
  });

  it("shows a protection hint next to Download for a protected mail", () => {
    const client = new QueryClient();
    const protectedEntry: TreeEntry = {
      ...mailEntry,
      mail: { ...mail, protection: "rights-protected" },
    };
    client.setQueryData(restoreKeys.preview("t-1", "s1", protectedEntry.id), {
      previewable: false,
      reason: "rights-protected",
      headers: preview.headers,
      attachments: [],
    } satisfies EntryPreview);
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <I18nextProvider i18n={i18n}>
          <DetailsPanel
            entry={protectedEntry}
            object={object}
            snapshot={snapshot}
            canReveal={false}
            {...actions}
          />
        </I18nextProvider>
      </QueryClientProvider>,
    );
    expect(html).toContain("Rights-protected by Microsoft Purview");
  });

  it("also shows the Download hint when only the loaded preview (not the tree listing) reports protection", () => {
    // An older restore point: the tree listing never learned this mail is
    // protected (`mail.protection` is null), only the preview did once it
    // loaded. The hint next to Download must not depend on the listing.
    const client = new QueryClient();
    client.setQueryData(restoreKeys.preview("t-1", "s1", mailEntry.id), {
      previewable: false,
      reason: "smime-encrypted",
      headers: preview.headers,
      attachments: [],
    } satisfies EntryPreview);
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <I18nextProvider i18n={i18n}>
          <DetailsPanel
            entry={mailEntry}
            object={object}
            snapshot={snapshot}
            canReveal={false}
            {...actions}
          />
        </I18nextProvider>
      </QueryClientProvider>,
    );
    expect(mailEntry.mail?.protection).toBeNull();
    // Specifically the Download hint's own wording, not just the reading
    // pane's separate "cannot be shown here" notice (which also mentions
    // "S/MIME-encrypted" and would otherwise make this assertion pass even
    // if the hint itself were missing). Stops short of the apostrophe in
    // "recipient's", which `renderToStaticMarkup` HTML-escapes to `&#x27;`.
    expect(html).toContain("S/MIME-encrypted: the downloaded EML needs the");
  });
});
