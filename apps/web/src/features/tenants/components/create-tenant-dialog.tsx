import { TenantWizard } from "./tenant-wizard/tenant-wizard";

interface CreateTenantDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * "+ New tenant", opened from the Tenants page header and the empty state:
 * the tenant wizard (organisation, contacts, notification recipients,
 * administrators to invite, first source, review). Kept as its own module
 * (rather than inlining `TenantWizard` at the call sites) so the entry point
 * the rest of the feature imports stays stable if the wizard's own
 * composition changes.
 */
export function CreateTenantDialog({ open, onOpenChange }: CreateTenantDialogProps) {
  return <TenantWizard open={open} onOpenChange={onOpenChange} />;
}
