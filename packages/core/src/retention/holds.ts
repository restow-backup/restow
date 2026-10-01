/** Which objects a tenant's active legal holds cover. */
export interface LegalHoldScope {
  /** An active hold with no object covers the whole tenant. */
  readonly tenantWide: boolean;
  readonly protectedObjectIds: ReadonlySet<string>;
}

export const NO_HOLDS: LegalHoldScope = { tenantWide: false, protectedObjectIds: new Set() };

/** Whether a legal hold suspends pruning for this object. */
export function isHeld(holds: LegalHoldScope, protectedObjectId: string): boolean {
  return holds.tenantWide || holds.protectedObjectIds.has(protectedObjectId);
}
