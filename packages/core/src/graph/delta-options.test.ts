/**
 * The options of every delta stream Restow stores links of, written down once. Graph binds a
 * delta link to the options of the request it came from (`$select`, `Prefer`) and refuses it
 * with 410 once they change: 0.5.0 added `Prefer: deltashowsharingchanges` to the drive delta
 * and every OneDrive kept failing on the links 0.4.x had stored. A change of the options is a
 * change of the stored state, not only of the request.
 *
 * When this test fails, the request options of a stream changed. Before you update the table:
 *   - bump the stream's version (`version` below names the constant), which drops the stored
 *     links before the next run (a stream without one: add one first, the way
 *     backup/onedrive/state.ts DRIVE_DELTA_VERSION and backup/exchange/state.ts
 *     MAIL_SELECT_VERSION do it);
 *   - add an `[upgrade]` test that runs the stream once with the old options and once with the
 *     new ones (backup/onedrive/engine.test.ts has one).
 * The page size (`odata.maxpagesize`) is no option of the link and is left out.
 */
import { describe, expect, it } from "vitest";
import { MAIL_EXTRA_SELECT } from "../backup/exchange/mail.js";
import { MAIL_SELECT_VERSION } from "../backup/exchange/state.js";
import { walkDriveDelta } from "../backup/onedrive/delta.js";
import { DRIVE_DELTA_VERSION } from "../backup/onedrive/state.js";
import { InMemoryDeltaTokenStore } from "./delta.js";
import { groupsDelta } from "./resources/groups.js";
import { messagesDelta } from "./resources/mail.js";
import { usersDelta } from "./resources/users.js";
import { createFakeGraph } from "./testing/fake-graph.js";

/** The first request a stream makes, as path, query and the `Prefer` options that bind. */
async function firstRequest(
  start: (graph: ReturnType<typeof createFakeGraph>) => AsyncGenerator<unknown, unknown, unknown>,
): Promise<string> {
  const graph = createFakeGraph([
    {
      url: /delta/,
      respond: {
        status: 200,
        json: { value: [], "@odata.deltaLink": "https://graph.microsoft.com/v1.0/x/delta?token=D" },
      },
    },
  ]);
  const generator = start(graph);
  await generator.next();
  const call = graph.calls[0];
  if (!call) throw new Error("the stream made no request");
  const url = new URL(call.url);
  const prefer = (call.headers.prefer ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "" && !value.startsWith("odata.maxpagesize"))
    .sort()
    .join(", ");
  return `${decodeURIComponent(url.pathname)}${decodeURIComponent(url.search)} | Prefer: ${prefer || "-"}`;
}

describe("the options of the delta streams Restow stores links of", () => {
  it("are those the stored links were built with, under the version that says so", async () => {
    const streams = {
      drive: await firstRequest((graph) =>
        walkDriveDelta({
          client: graph.client(),
          driveId: "DRIVE",
          start: { url: null, mode: "initial" },
        }),
      ),
      mail: await firstRequest((graph) =>
        messagesDelta(graph.client(), new InMemoryDeltaTokenStore(), "USER", "FOLDER", {
          extraSelect: [...MAIL_EXTRA_SELECT],
          maxPageSize: 50,
        }),
      ),
      users: await firstRequest((graph) =>
        usersDelta(graph.client(), new InMemoryDeltaTokenStore()),
      ),
      groups: await firstRequest((graph) =>
        groupsDelta(graph.client(), new InMemoryDeltaTokenStore()),
      ),
    };
    // Every version a stream has had, with its options: never edit an entry, add one.
    const history = {
      drive: {
        1: "/v1.0/drives/DRIVE/root/delta | Prefer: -",
        2: "/v1.0/drives/DRIVE/root/delta | Prefer: deltashowsharingchanges",
      },
      mail: {
        2: "/v1.0/users/USER/mailFolders/FOLDER/messages/delta?$select=id,internetMessageId,subject,receivedDateTime,lastModifiedDateTime,isRead,flag,categories,hasAttachments,parentFolderId,from,toRecipients,ccRecipients,isDraft,bodyPreview,importance | Prefer: -",
      },
    } as const;
    expect(streams.drive).toBe(history.drive[DRIVE_DELTA_VERSION as keyof typeof history.drive]);
    expect(streams.mail).toBe(history.mail[MAIL_SELECT_VERSION as keyof typeof history.mail]);

    // No version of their own yet: the directory sync keeps their links in the source's
    // configuration. Changing these options needs a version first (see the top of this file).
    expect(streams.users).toBe(
      "/v1.0/users/delta?$select=id,userPrincipalName,displayName,givenName,surname,mail,mailNickname,proxyAddresses,accountEnabled,userType,jobTitle,department,assignedLicenses,assignedPlans,onPremisesSyncEnabled,createdDateTime,deletedDateTime | Prefer: -",
    );
    expect(streams.groups).toBe(
      "/v1.0/groups/delta?$select=id,displayName,description,mail,mailEnabled,groupTypes,resourceProvisioningOptions | Prefer: -",
    );
  });
});
