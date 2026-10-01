import { useQuery } from "@tanstack/react-query";
import { Check, Copy } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/sonner";
import { cn } from "@/lib/utils";
import { setupStateQueryOptions } from "@/routes/tree";

import { invitationLink } from "../paths";

/** How long the copy button shows its check mark. */
const COPIED_FEEDBACK_MS = 2_000;

/** Copy `value` to the clipboard with a toast either way; `copied` flips for feedback. */
function useCopy(value: string) {
  const { t } = useTranslation("tenants");
  const [copied, setCopied] = React.useState(false);

  React.useEffect(() => {
    if (!copied) {
      return;
    }
    const timer = window.setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = React.useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast.success(t("toasts.copied"));
    } catch {
      toast.error(t("toasts.copyFailed"));
    }
  }, [t, value]);

  return { copied, copy };
}

/**
 * The address invitees open: the installation's public URL when one is set
 * (the admin may be on an internal address), else the current origin.
 */
export function useInvitationLink(invitationId: string): string {
  const setup = useQuery(setupStateQueryOptions);
  const base = setup.data?.publicUrl ?? window.location.origin;
  return invitationLink(base, invitationId);
}

interface InvitationLinkFieldProps {
  id: string;
  invitationId: string;
  label: string;
  className?: string;
}

/** A read-only invitation link with a copy button. */
export function InvitationLinkField({
  id,
  invitationId,
  label,
  className,
}: InvitationLinkFieldProps) {
  const { t } = useTranslation("tenants");
  const link = useInvitationLink(invitationId);
  const { copied, copy } = useCopy(link);
  return (
    <div className={cn("flex gap-2", className)}>
      <Input
        id={id}
        readOnly
        value={link}
        aria-label={label}
        className="font-mono text-xs"
        onFocus={(event) => event.currentTarget.select()}
      />
      <Button
        variant="outline"
        size="icon"
        onClick={() => void copy()}
        aria-label={t("actions.copyLink")}
        title={t("actions.copyLink")}
      >
        {copied ? <Check /> : <Copy />}
      </Button>
    </div>
  );
}

/** Icon button that copies an invitation link (for table rows). */
export function CopyInvitationLinkButton({
  invitationId,
  email,
}: { invitationId: string; email: string }) {
  const { t } = useTranslation("tenants");
  const link = useInvitationLink(invitationId);
  const { copied, copy } = useCopy(link);
  const label = t("members.invitations.copyFor", { email });
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      onClick={() => void copy()}
      aria-label={label}
      title={label}
    >
      {copied ? <Check /> : <Copy />}
    </Button>
  );
}
