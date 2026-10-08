import { useTranslation } from "react-i18next";

import { Checkbox } from "@/components/ui/checkbox";

import { eventKey, toggleItem } from "../presenters";
import { WEBHOOK_EVENTS, type WebhookEvent } from "../types";

interface EventPickerProps {
  value: WebhookEvent[];
  onChange: (events: WebhookEvent[]) => void;
  error?: string;
  /** Alert and report rules that send to this webhook as well (whatever is chosen here). */
  rules?: number;
}

/** The subscribable events, each with what it means for the receiver. */
export function EventPicker({ value, onChange, error, rules = 0 }: EventPickerProps) {
  const { t } = useTranslation("integrations");
  return (
    <fieldset className="space-y-3" aria-describedby="webhook-events-message">
      <legend className="text-sm font-medium">{t("webhookForm.events")}</legend>
      <ul className="grid gap-3 sm:grid-cols-2">
        {WEBHOOK_EVENTS.map((event) => {
          const id = `webhook-event-${eventKey(event)}`;
          return (
            <li key={event}>
              <label htmlFor={id} className="flex cursor-pointer items-start gap-2.5">
                <Checkbox
                  id={id}
                  checked={value.includes(event)}
                  onCheckedChange={(checked) =>
                    onChange(toggleItem(value, event, checked === true, WEBHOOK_EVENTS))
                  }
                  className="mt-0.5"
                />
                <span className="space-y-0.5">
                  <span className="flex flex-wrap items-center gap-x-2 text-sm font-medium">
                    {t(`events.${eventKey(event)}.label`)}
                    <code className="text-xs font-normal text-muted-foreground">{event}</code>
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {t(`events.${eventKey(event)}.description`)}
                  </span>
                </span>
              </label>
            </li>
          );
        })}
      </ul>
      <p
        id="webhook-events-message"
        role={error ? "alert" : undefined}
        className={error ? "text-xs text-destructive" : "text-xs text-muted-foreground"}
      >
        {error ?? t("webhookForm.eventsHint")}
      </p>
      {rules > 0 ? (
        <p className="text-xs text-muted-foreground" data-slot="webhook-rule-count">
          {t("webhookForm.eventsRules", { count: rules })}
        </p>
      ) : null}
    </fieldset>
  );
}
