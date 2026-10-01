import { Check, Copy } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/sonner";
import { cn } from "@/lib/utils";

interface CopyFieldProps {
  id: string;
  value: string;
  /** Accessible name of the field (a visible label should point at `id`). */
  label: string;
  className?: string;
}

/** A read-only value (link, redirect URI) with a copy button that says whether it worked. */
export function CopyField({ id, value, label, className }: CopyFieldProps) {
  const { t } = useTranslation("sources");
  const [copied, setCopied] = React.useState(false);

  React.useEffect(() => {
    if (!copied) {
      return;
    }
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast.success(t("toasts.copied"));
    } catch {
      toast.error(t("toasts.copyFailed"));
    }
  };

  return (
    <div className={cn("flex gap-2", className)}>
      <Input
        id={id}
        readOnly
        value={value}
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
