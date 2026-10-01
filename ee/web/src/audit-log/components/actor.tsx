import { Check, Copy } from "lucide-react";
import * as React from "react";

import { Button } from "@/components/ui/button";
import type { AuditFormat } from "../hooks";
import { describeActor } from "../presenters";

/** An actor label in words: `system`, API keys and user ids get a name. */
export function actorText(actor: string, format: AuditFormat): string {
  const view = describeActor(actor);
  switch (view.kind) {
    case "system":
      return format.t("actor.system");
    case "adminConsent":
      return format.t("actor.adminConsent");
    case "apiKey":
      return format.t("actor.apiKey", { id: view.id });
    case "user":
      return format.t("actor.user", { id: view.id });
    case "label":
      return view.label;
  }
}

function clipboardAvailable(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.clipboard?.writeText === "function";
}

/**
 * Copy a value (hash, id) to the clipboard. Browsers offer the clipboard only
 * on secure origins, so on a plain-HTTP installation the button is left out
 * and the value stays selectable as text.
 */
export function CopyButton({
  value,
  label,
  format,
}: { value: string; label: string; format: AuditFormat }) {
  const [copied, setCopied] = React.useState(false);
  React.useEffect(() => {
    if (!copied) {
      return;
    }
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  if (!clipboardAvailable()) {
    return null;
  }
  const text = copied ? format.t("entry.copied") : format.t("entry.copy", { label });
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      className="shrink-0"
      aria-label={text}
      title={text}
      onClick={() => {
        navigator.clipboard.writeText(value).then(
          () => setCopied(true),
          () => setCopied(false),
        );
      }}
    >
      {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
    </Button>
  );
}
