import { useTranslation } from "react-i18next";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { TenantRole } from "@/lib/api";
import { cn } from "@/lib/utils";

export const TENANT_ROLES: readonly TenantRole[] = ["tenant_admin", "tenant_user"];

interface RoleSelectProps {
  id?: string;
  value: TenantRole;
  onChange: (role: TenantRole) => void;
  disabled?: boolean;
  /** Accessible name when no visible label points at the control. */
  label?: string;
  describedBy?: string;
  className?: string;
}

/** Tenant role picker (tenant admin or user); names come from the translations. */
export function RoleSelect({
  id,
  value,
  onChange,
  disabled = false,
  label,
  describedBy,
  className,
}: RoleSelectProps) {
  const { t } = useTranslation("tenants");
  return (
    <Select
      value={value}
      onValueChange={(next) => onChange(next === "tenant_admin" ? "tenant_admin" : "tenant_user")}
      disabled={disabled}
    >
      <SelectTrigger
        id={id}
        aria-label={label}
        aria-describedby={describedBy}
        className={cn("w-full sm:w-48", className)}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {TENANT_ROLES.map((role) => (
          <SelectItem key={role} value={role}>
            {t(`members.roles.${role}`)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
