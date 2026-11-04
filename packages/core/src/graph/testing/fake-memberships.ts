/**
 * A stateful fake of the owners, members and group-connected sites of Microsoft 365 groups
 * behind Microsoft Graph, for the membership sync tests (directory/memberships.ts): `$batch`
 * dispatched to the same handlers as direct calls, `$top` paging with `@odata.nextLink`,
 * throttling of sub-responses (429 with Retry-After), and refusals (403) or missing groups (404).
 */
import {
  type FixtureResponse,
  type FixtureRoute,
  graphError,
  type RecordedCall,
} from "./fake-graph.js";

export interface FakeGroupMembers {
  owners: string[];
  members: string[];
  /** Devices, contacts or service principals among the members (not users). */
  others?: string[];
  /** Graph id of the group-connected site; null: none (404). */
  siteId?: string | null;
}

const BASE = "https://graph.microsoft.com/v1.0";

export class FakeMembershipDirectory {
  readonly groups = new Map<string, FakeGroupMembers>();
  /** Entries per page (Graph serves up to 999). */
  pageSize = 999;
  /** Owners and members of every group answer 403 (no Group.Read.All / GroupMember.Read.All). */
  refuse = false;
  /** Owners and members of these groups answer 403 (hidden membership, say). */
  readonly refuseGroups = new Set<string>();
  /** Sites answer 403 (no Sites.Read.All). */
  refuseSites = false;
  /** Sub-requests of these groups answer 429 this many more times before they succeed. */
  readonly throttle = new Map<string, number>();
  /** Groups whose next pages (after the first) answer 503 every time. */
  readonly failNextPages = new Set<string>();
  /** Sub-requests answered, by group id (owners, members and site count separately). */
  readonly served: string[] = [];

  set(groupId: string, members: FakeGroupMembers): void {
    this.groups.set(groupId, members);
  }

  routes(): FixtureRoute[] {
    return [
      {
        method: "POST",
        url: (url) => url.pathname === "/v1.0/$batch",
        respond: (call) => this.batch(call),
      },
      {
        method: "GET",
        url: (url) => /^\/v1\.0\/groups\/[^/]+\/(owners|members|sites\/root)$/.test(url.pathname),
        respond: (call) => this.answer(new URL(call.url)),
      },
    ];
  }

  private batch(call: RecordedCall): FixtureResponse {
    const payload = call.json as { requests: Array<{ id: string; method: string; url: string }> };
    return {
      status: 200,
      json: {
        responses: payload.requests.map((sub) => {
          const answer = this.answer(new URL(`${BASE}${sub.url}`));
          return { id: sub.id, status: answer.status, headers: answer.headers, body: answer.json };
        }),
      },
    };
  }

  private answer(url: URL): FixtureResponse {
    const match = /^\/v1\.0\/groups\/([^/]+)\/(owners|members|sites\/root)$/.exec(url.pathname);
    const groupId = decodeURIComponent(match?.[1] ?? "");
    const what = match?.[2] ?? "";
    const group = this.groups.get(groupId);
    this.served.push(groupId);
    if (!group) {
      return { status: 404, json: graphError("Request_ResourceNotFound", "group not found") };
    }
    const left = this.throttle.get(groupId) ?? 0;
    if (left > 0) {
      this.throttle.set(groupId, left - 1);
      return {
        status: 429,
        headers: { "retry-after": "1" },
        json: graphError("TooManyRequests", "throttled"),
      };
    }
    if (what === "sites/root") {
      if (this.refuseSites) {
        return { status: 403, json: graphError("accessDenied", "Sites.Read.All missing") };
      }
      return group.siteId
        ? { status: 200, json: { id: group.siteId } }
        : { status: 404, json: graphError("itemNotFound", "no site") };
    }
    if (this.refuse || this.refuseGroups.has(groupId)) {
      return {
        status: 403,
        json: graphError("Authorization_RequestDenied", "Insufficient privileges"),
      };
    }
    const skip = Number(url.searchParams.get("$skiptoken") ?? "0");
    if (skip > 0 && this.failNextPages.has(groupId)) {
      return { status: 503, json: graphError("serviceNotAvailable", "unavailable") };
    }
    const entries =
      what === "owners"
        ? group.owners.map((id) => ({ "@odata.type": "#microsoft.graph.user", id }))
        : [
            ...group.members.map((id) => ({ "@odata.type": "#microsoft.graph.user", id })),
            ...(group.others ?? []).map((id) => ({ "@odata.type": "#microsoft.graph.device", id })),
          ];
    const page = entries.slice(skip, skip + this.pageSize);
    const next = skip + this.pageSize;
    return {
      status: 200,
      json: {
        value: page,
        ...(next < entries.length
          ? {
              "@odata.nextLink": `${BASE}/groups/${encodeURIComponent(groupId)}/${what}?$select=id&$top=${this.pageSize}&$skiptoken=${next}`,
            }
          : {}),
      },
    };
  }
}
