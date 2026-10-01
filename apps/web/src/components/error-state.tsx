import { AlertTriangle, RotateCw } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { errorMessageKey } from "@/lib/api";
import { cn } from "@/lib/utils";

interface ErrorStateProps {
  title?: string;
  /** Replaces the cause mapped from `error` when the caller knows better. */
  description?: string;
  error: unknown;
  onRetry?: () => void;
  retrying?: boolean;
  className?: string;
}

/**
 * Honest failure display: what failed, the mapped cause and, when the caller
 * can try again, a retry button. Used by the kit's table and chart states and
 * directly by pages.
 */
export function ErrorState({
  title,
  description,
  error,
  onRetry,
  retrying = false,
  className,
}: ErrorStateProps) {
  const { t } = useTranslation();
  return (
    <Alert variant="destructive" className={cn("text-left", className)}>
      <AlertTriangle />
      <AlertTitle>{title ?? t("errors.title")}</AlertTitle>
      <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <span>{description ?? t(errorMessageKey(error))}</span>
        {onRetry ? (
          <Button
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={onRetry}
            loading={retrying}
          >
            <RotateCw aria-hidden="true" />
            {t("actions.retry")}
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}
