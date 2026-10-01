import { Check, Copy, KeyRound, ShieldAlert } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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

interface SecretRevealProps {
  /** An API key token or a webhook signing secret. */
  kind: "key" | "secret";
  value: string;
  /** Reports whether the user copied or confirmed storing the value (the dialog may close). */
  onReadyChange: (ready: boolean) => void;
  onDone: () => void;
}

const TEXT = {
  key: {
    title: "reveal.keyTitle",
    description: "reveal.keyDescription",
    label: "reveal.keyLabel",
  },
  secret: {
    title: "reveal.secretTitle",
    description: "reveal.secretDescription",
    label: "reveal.secretLabel",
  },
} as const;

/**
 * The one moment a token or secret is visible. Closing needs a copy or an
 * explicit "I have stored it", so it cannot be lost by a stray click; the
 * value lives only in this component's props and is gone once it unmounts.
 */
export function SecretReveal({ kind, value, onReadyChange, onDone }: SecretRevealProps) {
  const { t } = useTranslation("integrations");
  const [copied, setCopied] = React.useState(false);
  const [acknowledged, setAcknowledged] = React.useState(false);
  const ready = copied || acknowledged;
  const text = TEXT[kind];
  const fieldId = `reveal-${kind}`;

  React.useEffect(() => {
    onReadyChange(ready);
  }, [ready, onReadyChange]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast.success(t("reveal.copied"));
    } catch {
      toast.error(t("reveal.copyFailed"));
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <KeyRound className="size-5 text-primary" aria-hidden="true" />
          {t(text.title)}
        </DialogTitle>
        <DialogDescription>{t(text.description)}</DialogDescription>
      </DialogHeader>

      <div className="space-y-2">
        <Label htmlFor={fieldId}>{t(text.label)}</Label>
        <div className="flex gap-2">
          <Input
            id={fieldId}
            readOnly
            value={value}
            spellCheck={false}
            autoComplete="off"
            className="font-mono text-xs"
            onFocus={(event) => event.currentTarget.select()}
          />
          <Button variant="outline" onClick={() => void copy()} className="shrink-0">
            {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
            {t("reveal.copy")}
          </Button>
        </div>
        {kind === "key" ? (
          <p className="text-xs text-muted-foreground">{t("reveal.keyUsage")}</p>
        ) : null}
      </div>

      <Alert variant="warning">
        <ShieldAlert />
        <AlertDescription>
          <label htmlFor={`${fieldId}-stored`} className="flex cursor-pointer items-start gap-2">
            <Checkbox
              id={`${fieldId}-stored`}
              checked={acknowledged}
              onCheckedChange={(checked) => setAcknowledged(checked === true)}
              className="mt-0.5"
            />
            <span>{t("reveal.acknowledge")}</span>
          </label>
        </AlertDescription>
      </Alert>

      <DialogFooter>
        <Button onClick={onDone} disabled={!ready}>
          {t("reveal.done")}
        </Button>
      </DialogFooter>
    </>
  );
}

interface SecretRevealDialogProps {
  kind: SecretRevealProps["kind"];
  /** The value to show; the dialog is open while it is set. */
  value: string | null;
  onClose: () => void;
}

/** A dialog that only shows a freshly issued value (e.g. after rotating a secret). */
export function SecretRevealDialog({ kind, value, onClose }: SecretRevealDialogProps) {
  const [ready, setReady] = React.useState(false);
  const close = () => {
    setReady(false);
    onClose();
  };
  return (
    <Dialog
      open={value !== null}
      onOpenChange={(open) => {
        if (!open && ready) {
          close();
        }
      }}
    >
      <DialogContent className="sm:max-w-xl" onInteractOutside={(event) => event.preventDefault()}>
        {value !== null ? (
          <SecretReveal kind={kind} value={value} onReadyChange={setReady} onDone={close} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
