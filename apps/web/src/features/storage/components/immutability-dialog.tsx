import { TriangleAlert } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { useConfirmIdentity } from "@/components/confirm-identity-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { toast } from "@/components/ui/sonner";
import { isRecentSignInRequired } from "@/lib/recent-sign-in";
import { availableModes, lowers } from "../immutability";
import { storageErrorKey, targetDisplayName } from "../presenters";
import type { ImmutabilityMode, StorageTargetDto } from "../types";
import { useSetImmutability } from "../use-storage";

const MIN_DAYS = 1;
const MAX_DAYS = 3650;
const DEFAULT_DAYS = 30;

type Choice = ImmutabilityMode | "off";

/**
 * Turn immutable backups on, change them or switch them off for one
 * repository. Says what the setting protects against and what it does not,
 * plainly and before the click: Object Lock on S3 is enforced by the storage;
 * a directory only gets a deletion delay that Restow itself keeps. Lowering
 * is for the provider owner, with a fresh confirmation, and never reaches
 * back to what is already written. Mounted only while open, so it starts from
 * the saved setting every time.
 */
export function ImmutabilityDialog({
  open,
  onOpenChange,
  target,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: StorageTargetDto;
}) {
  const { t } = useTranslation("storage");
  const { t: tc } = useTranslation();
  const identity = useConfirmIdentity();
  const save = useSetImmutability();
  const current = target.immutability;
  const modes = availableModes(target.kind);
  const [choice, setChoice] = React.useState<Choice>(current?.mode ?? "off");
  const [daysText, setDaysText] = React.useState(String(current?.days || DEFAULT_DAYS));
  const formId = React.useId();
  const name = targetDisplayName(target, t);

  const days = Number(daysText);
  const daysValid = Number.isInteger(days) && days >= MIN_DAYS && days <= MAX_DAYS;
  const next = { mode: choice === "off" ? null : choice, days: choice === "off" ? 0 : days };
  const isLowering = lowers({ mode: current?.mode ?? null, days: current?.days ?? 0 }, next);
  const unchanged = (current?.mode ?? null) === next.mode && (current?.days ?? 0) === next.days;
  const blocked = isLowering && !current?.canLower;
  const objectLock = target.kind === "s3";

  const submit = async (): Promise<void> => {
    try {
      await save.mutateAsync({
        targetId: target.id,
        input: next.mode ? { mode: next.mode, days: next.days } : { mode: null },
      });
      toast.success(t("immutability.saved", { name }));
      onOpenChange(false);
    } catch (error) {
      if (isRecentSignInRequired(error)) {
        identity.ask(() => void submit());
      }
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("immutability.dialog.title", { name })}</DialogTitle>
          <DialogDescription>
            {t(
              objectLock
                ? "immutability.dialog.introObjectLock"
                : "immutability.dialog.introDirectory",
            )}
          </DialogDescription>
        </DialogHeader>

        <form
          id={formId}
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <RadioGroup
            value={choice}
            onValueChange={(value) => setChoice(value as Choice)}
            className="gap-3"
          >
            {(["off", ...modes] as Choice[]).map((value) => (
              <div key={value} className="flex items-start gap-2">
                <RadioGroupItem value={value} id={`${formId}-${value}`} className="mt-0.5" />
                <Label htmlFor={`${formId}-${value}`} className="flex flex-col items-start gap-0.5">
                  <span className="font-medium">{t(`immutability.modes.${value}`)}</span>
                  <span className="text-xs font-normal text-muted-foreground">
                    {t(`immutability.modes.${value}Hint`)}
                  </span>
                </Label>
              </div>
            ))}
          </RadioGroup>

          {choice !== "off" ? (
            <div className="space-y-1.5">
              <Label htmlFor={`${formId}-days`}>{t("immutability.dialog.days")}</Label>
              <Input
                id={`${formId}-days`}
                type="number"
                inputMode="numeric"
                min={MIN_DAYS}
                max={MAX_DAYS}
                value={daysText}
                onChange={(event) => setDaysText(event.target.value)}
                aria-invalid={!daysValid}
                className="w-32"
              />
              <p className="text-xs text-muted-foreground">
                {daysValid
                  ? t(
                      objectLock
                        ? "immutability.dialog.daysHintObjectLock"
                        : "immutability.dialog.daysHintDirectory",
                      { days, total: days + (current?.renewalBufferDays ?? 7) },
                    )
                  : t("immutability.dialog.daysInvalid", { min: MIN_DAYS, max: MAX_DAYS })}
              </p>
            </div>
          ) : null}

          <div className="grid gap-3 text-sm sm:grid-cols-2">
            <div className="space-y-1">
              <p className="font-medium">{t("immutability.dialog.protects")}</p>
              <p className="text-muted-foreground">
                {t(
                  objectLock
                    ? "immutability.dialog.protectsObjectLock"
                    : "immutability.dialog.protectsDirectory",
                )}
              </p>
            </div>
            <div className="space-y-1">
              <p className="font-medium">{t("immutability.dialog.notProtects")}</p>
              <p className="text-muted-foreground">
                {t(
                  objectLock
                    ? "immutability.dialog.notProtectsObjectLock"
                    : "immutability.dialog.notProtectsDirectory",
                )}
              </p>
            </div>
          </div>

          {choice === "governance" ? (
            <p className="text-xs text-muted-foreground">
              {t("immutability.dialog.governanceNote")}
            </p>
          ) : null}

          {isLowering ? (
            <Alert variant="warning">
              <TriangleAlert />
              <AlertTitle>{t("immutability.dialog.loweringTitle")}</AlertTitle>
              <AlertDescription>
                {t(
                  blocked
                    ? "immutability.dialog.loweringOwnerOnly"
                    : "immutability.dialog.loweringNotRetroactive",
                )}
              </AlertDescription>
            </Alert>
          ) : null}

          {save.error && !isRecentSignInRequired(save.error) ? (
            <p role="alert" className="text-sm text-destructive">
              {tc(storageErrorKey(save.error))}
            </p>
          ) : null}
        </form>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("immutability.dialog.cancel")}
          </Button>
          <Button
            type="submit"
            form={formId}
            loading={save.isPending}
            disabled={unchanged || blocked || (choice !== "off" && !daysValid)}
          >
            {t("immutability.dialog.save")}
          </Button>
        </DialogFooter>
        {identity.dialog}
      </DialogContent>
    </Dialog>
  );
}
