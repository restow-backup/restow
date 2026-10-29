/**
 * Confirming, at backup time, that a mailbox is inactive rather than broken.
 *
 * A mailbox whose user was disabled or lost the Exchange Online licence fails its backup until
 * the next directory sync notices (the probe in ./sync.ts). When a backup fails with a code that
 * may mean exactly that, the worker asks Graph once more, the same way the sync's probe does,
 * and treats the mailbox as inactive only when Microsoft clearly answers "the user exists, but
 * has no mailbox". Every other answer keeps the failure a failure: a 401 or 403 is a permission
 * problem (consent, an Application Access Policy, RBAC for Applications) and never reads as
 * inactive, a user that is gone (404) is left to the sync, which orphans it without a reason,
 * and throttling or a service error says nothing at all (docs/MICROSOFT.md "Disabled and
 * unlicensed accounts").
 */
import type { BatchRequest, GraphClient } from "../graph/client.js";
import { query, userPath } from "../graph/resources/common.js";
import type { ObjectStatusReason } from "./plan.js";
import { inactiveReason } from "./rules.js";
import { isNoMailbox, probeRequest } from "./sync.js";

export interface MailboxInactive {
  readonly reason: ObjectStatusReason;
}

const USER_ID = "user";

/** Statuses a "no mailbox" answer may come with; 401 and 403 are permission problems. */
function isDefiniteStatus(status: number): boolean {
  return status === 400 || status === 404;
}

/**
 * Whether Graph confirms that the user exists but Exchange Online hosts no mailbox for them;
 * null when it does not say so clearly (see the module comment). Never throws for a Graph
 * answer: a failed batch is no confirmation either.
 */
export async function confirmMailboxInactive(
  client: GraphClient,
  userId: string,
): Promise<MailboxInactive | null> {
  const mailbox = probeRequest("mailbox", userId);
  const requests: BatchRequest[] = [
    {
      id: USER_ID,
      method: "GET",
      url: `${userPath(userId)}${query({ $select: "accountEnabled,mail,userType" })}`,
    },
    mailbox,
  ];
  let responses: Awaited<ReturnType<GraphClient["batch"]>>;
  try {
    responses = await client.batch(requests);
  } catch {
    return null;
  }
  const user = responses.find((response) => response.id === USER_ID);
  const answer = responses.find((response) => response.id === mailbox.id);
  if (!user || !answer || user.status !== 200) {
    return null;
  }
  if (!isDefiniteStatus(answer.status) || !isNoMailbox(answer, mailbox.url)) {
    return null;
  }
  const body = (user.body ?? {}) as { accountEnabled?: unknown; userType?: unknown };
  if (typeof body.userType === "string" && body.userType.toLowerCase() === "guest") {
    // A guest has no mailbox in the tenant at all; the sync orphans such an object.
    return null;
  }
  return {
    reason: inactiveReason({
      accountEnabled: typeof body.accountEnabled === "boolean" ? body.accountEnabled : null,
    }),
  };
}
