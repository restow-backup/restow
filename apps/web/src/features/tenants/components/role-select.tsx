import { useTranslation } from "react-i18next";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TENANT_ROLES, type TenantRole, isTenantRole } from "@/lib/api";
import { cn } from "@/lib/utils";

export { TENANT_ROLES };

interface RoleSelectProps {
  id?: string;
  /** Null until a role is chosen: a new person never gets a role nobody picked. */
  value: TenantRole | null;
  onChange: (role: TenantRole) => void;
  disabled?: boolean;
  /** Marks the control invalid (no role chosen where one is required). */
  invalid?: boolean;
  /** Accessible name when no visible label points at the control. */
  label?: string;
  describedBy?: string;
  className?: string;
}

/** Tenant role picker (admin, restore operator or user); names come from the translations. */
export function RoleSelect({
  id,
  value,
  onChange,
  disabled = false,
  invalid = false,
  label,
  describedBy,
  className,
}: RoleSelectProps) {
  const { t } = useTranslation("tenants");
  return (
    <Select
      value={value ?? ""}
      onValueChange={(next) => {
        if (isTenantRole(next)) {
          onChange(next);
        }
      }}
      disabled={disabled}
    >
      <SelectTrigger
        id={id}
        aria-label={label}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        className={cn("w-full sm:w-48", className)}
      >
        <SelectValue placeholder={t("members.rolePlaceholder")} />
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
