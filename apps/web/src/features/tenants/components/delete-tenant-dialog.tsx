import { useQueryClient } from "@tanstack/react-query";
import { TriangleAlert } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/sonner";
import { useSession } from "@/lib/session";

import { tenantKeys } from "../api";
import { useDeleteTenant } from "../hooks";
import { fallbackTenant, genericError } from "../presenters";
import type { TenantItem } from "../types";

interface DeleteTenantDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tenant: Pick<TenantItem, "id" | "name" | "slug">;
  /** Called after the API accepted the deletion (e.g. to leave the detail page). */
  onDeleted?: () => void;
}

/**
 * Delete a tenant after typing its slug. The API marks the tenant for
 * deletion and ends every sign-in to it right away; the stored data is
 * removed afterwards by an audited job. If the operator was working in that
 * tenant, the session moves on to another one.
 */
export function DeleteTenantDialog({
  open,
  onOpenChange,
  tenant,
  onDeleted,
}: DeleteTenantDialogProps) {
  const { t } = useTranslation("tenants");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("delete.title", { name: tenant.name })}</DialogTitle>
          <DialogDescription>{t("delete.description")}</DialogDescription>
        </DialogHeader>
        {/* Mounted only while open: the confirmation starts empty every time. */}
        <DeleteTenantForm
          tenant={tenant}
          onCancel={() => onOpenChange(false)}
          onDeleted={() => {
            onOpenChange(false);
            onDeleted?.();
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

interface DeleteTenantFormProps {
  tenant: DeleteTenantDialogProps["tenant"];
  onCancel: () => void;
  onDeleted: () => void;
}

function DeleteTenantForm({ tenant, onCancel, onDeleted }: DeleteTenantFormProps) {
  const { t } = useTranslation("tenants");
  const queryClient = useQueryClient();
  const { activeTenant, setActiveTenant } = useSession();
  const remove = useDeleteTenant();
  const [confirmation, setConfirmation] = React.useState("");
  const confirmed = confirmation.trim() === tenant.slug;

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!confirmed || remove.isPending) {
      return;
    }
    // Read before the mutation refreshes the list.
    const known = queryClient.getQueryData<TenantItem[]>(tenantKeys.list) ?? [];
    remove.mutate(tenant.id, {
      onSuccess: () => {
        if (activeTenant?.id === tenant.id) {
          const next = fallbackTenant(known, tenant.id);
          if (next) {
            setActiveTenant(next.id);
          }
        }
        toast.success(t("toasts.deleted", { name: tenant.name }));
        onDeleted();
      },
    });
  };

  const error = remove.error ? genericError(remove.error) : null;

  return (
    <form onSubmit={submit} className="space-y-4">
      <ul className="list-disc space-y-1.5 pl-5 text-sm text-muted-foreground">
        <li>{t("delete.points.access")}</li>
        <li>{t("delete.points.data")}</li>
        <li>{t("delete.points.audit")}</li>
      </ul>
      <div className="space-y-1.5">
        <Label htmlFor="tenant-delete-confirm">
          {t("delete.confirmLabel", { slug: tenant.slug })}
        </Label>
        <Input
          id="tenant-delete-confirm"
          autoComplete="off"
          spellCheck={false}
          className="font-mono"
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
        />
      </div>
      {error ? (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertDescription>{t(error.key, error.values)}</AlertDescription>
        </Alert>
      ) : null}
      <DialogFooter>
        <Button variant="outline" onClick={onCancel} disabled={remove.isPending}>
          {t("common:actions.cancel")}
        </Button>
        <Button
          type="submit"
          variant="destructive"
          disabled={!confirmed}
          loading={remove.isPending}
        >
          {t("delete.confirm")}
        </Button>
      </DialogFooter>
    </form>
  );
}
