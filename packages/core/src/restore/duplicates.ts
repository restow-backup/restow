/**
 * Duplicate detection by Message-ID for one restore run.
 *
 * A mail folder can hold two different messages with the same Message-ID
 * (the direct copy and the mailing-list copy of one mail), and so can a
 * backup. Asking the target "is a message with this Message-ID here?" right
 * before each message would then take a copy this run restored a moment ago
 * for one the target already had: "rename" would skip the second message as
 * the work of an earlier attempt.
 *
 * So the target is asked once per folder and Message-ID, before this run
 * writes anything there. The copies found then are the copies the target
 * already had; what this run writes never joins them. A mailbox restore
 * never removes them either way (docs/ARCHITECTURE.md, Restore: a restore
 * never replaces an original) — the point of asking is only to recognise them:
 *
 * - "rename": a copy counts as this message restored by an earlier attempt of
 *   the job only when its content matches where the target can tell (IMAP:
 *   SHA-256 of the stored bytes), and each copy stands for one message only.
 * - "skip": a Message-ID the folder already had is skipped for every message
 *   that carries it.
 *
 * Only Message-IDs the plan holds more than once keep state between messages;
 * every other message behaves exactly as a group of one.
 */
import type { ManifestObject } from "../manifest.js";
import { messageIdOf } from "./conventions.js";

const SEPARATOR = "\u0000";

interface GroupState<Id> {
  /** Copies the target had before this run wrote to the group, not yet claimed; undefined until asked. */
  copies: Id[] | undefined;
  /** Messages of the group not settled yet. */
  pending: number;
}

/** A copy an earlier attempt of the job restored for a message. */
export interface EarlierCopy<Id> {
  readonly copy: Id;
  /** True when the target confirmed that it holds the backed-up content. */
  readonly confirmed: boolean;
}

/** One message's view of its group; call {@link settle} however the message ends. */
export interface DuplicateSlot<Id> {
  readonly messageId: string | undefined;
  /**
   * The copies the target already had under this Message-ID in `container`
   * (none without a Message-ID), minus copies another message of this run
   * claimed. `lookup` asks the target; it runs once per group.
   */
  existing(container: string, lookup: (messageId: string) => Promise<Id[]>): Promise<readonly Id[]>;
  /**
   * "rename": the copy an earlier attempt of this job restored for this
   * message, if any. A copy whose content `sameContent` confirms is preferred;
   * one it cannot judge (undefined) is accepted unconfirmed; one known to
   * differ never is. The copy is claimed: it stands for no other message of
   * this run.
   */
  claimEarlierCopy(
    sameContent: (copy: Id) => Promise<boolean | undefined>,
  ): Promise<EarlierCopy<Id> | undefined>;
  /** A copy this run wrote for the message (never a duplicate of a later message). */
  wrote(container: string, copy: Id | undefined): void;
  /** Finish the message, however it ended. Safe to call more than once. */
  settle(): void;
}

export class MessageIdDuplicates<Id> {
  /** Message-IDs the plan holds more than once. */
  private readonly recurring = new Set<string>();
  /** Messages per group, for groups of recurring Message-IDs. */
  private readonly sizes = new Map<string, number>();
  private readonly groups = new Map<string, GroupState<Id>>();
  /** Copies this run wrote, by container and recurring Message-ID. */
  private readonly written = new Map<string, Id[]>();

  /**
   * `groupOf` names the target folder a message lands in without resolving
   * it (its folder chain), so the groups are known before anything runs.
   */
  constructor(
    messages: readonly ManifestObject[],
    private readonly groupOf: (message: ManifestObject) => string,
  ) {
    const counts = new Map<string, number>();
    for (const message of messages) {
      const messageId = messageIdOf(message);
      if (messageId !== undefined) {
        counts.set(messageId, (counts.get(messageId) ?? 0) + 1);
      }
    }
    for (const [messageId, count] of counts) {
      if (count > 1) {
        this.recurring.add(messageId);
      }
    }
    for (const message of messages) {
      const messageId = messageIdOf(message);
      if (messageId !== undefined && this.recurring.has(messageId)) {
        const key = this.groupKey(message, messageId);
        this.sizes.set(key, (this.sizes.get(key) ?? 0) + 1);
      }
    }
  }

  private groupKey(message: ManifestObject, messageId: string): string {
    return `${this.groupOf(message)}${SEPARATOR}${messageId}`;
  }

  /** Start on one message of the plan. */
  slot(message: ManifestObject): DuplicateSlot<Id> {
    const messageId = messageIdOf(message);
    const shared = messageId !== undefined && this.recurring.has(messageId);
    let state: GroupState<Id>;
    let key: string | undefined;
    if (shared) {
      key = this.groupKey(message, messageId);
      const open = this.groups.get(key);
      if (open) {
        state = open;
      } else {
        state = { copies: undefined, pending: this.sizes.get(key) ?? 1 };
        this.groups.set(key, state);
      }
    } else {
      state = { copies: undefined, pending: 1 };
    }
    let settled = false;

    return {
      messageId,
      existing: async (container, lookup) => {
        if (messageId === undefined) {
          return [];
        }
        if (state.copies === undefined) {
          const found = await lookup(messageId);
          const ours = shared
            ? this.written.get(`${container}${SEPARATOR}${messageId}`)
            : undefined;
          state.copies = ours ? found.filter((copy) => !ours.includes(copy)) : found;
        }
        return [...state.copies];
      },
      claimEarlierCopy: async (sameContent) => {
        const copies = state.copies ?? [];
        let accepted: EarlierCopy<Id> | undefined;
        for (const copy of copies) {
          const same = await sameContent(copy);
          if (same === true) {
            accepted = { copy, confirmed: true };
            break;
          }
          if (same === undefined && accepted === undefined) {
            accepted = { copy, confirmed: false };
          }
        }
        if (accepted !== undefined) {
          const claimed = accepted.copy;
          state.copies = copies.filter((copy) => copy !== claimed);
        }
        return accepted;
      },
      wrote: (container, copy) => {
        if (!shared || copy === undefined || messageId === undefined) {
          return;
        }
        const containerKey = `${container}${SEPARATOR}${messageId}`;
        const list = this.written.get(containerKey);
        if (list) {
          list.push(copy);
        } else {
          this.written.set(containerKey, [copy]);
        }
      },
      settle: () => {
        if (settled) {
          return;
        }
        settled = true;
        state.pending--;
        if (state.pending <= 0 && key !== undefined) {
          this.groups.delete(key);
        }
      },
    };
  }
}
