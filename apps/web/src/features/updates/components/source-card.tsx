import { Info, TriangleAlert } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { useConfirmIdentity } from "@/components/confirm-identity-dialog";
import { Field, messageId } from "@/components/forms/field";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/sonner";
import { Switch } from "@/components/ui/switch";
import { isRecentSignInRequired } from "@/lib/recent-sign-in";

import {
  MAX_SOURCE_URL_LENGTH,
  MAX_TOKEN_LENGTH,
  UPDATE_CHANNELS,
  type UpdateChannel,
  type UpdatesView,
} from "../api";
import { useSaveUpdateSettings } from "../hooks";
import {
  type SettingsForm,
  buildSettingsPatch,
  defaultSourceUrl,
  settingsFormOf,
  sourceUrlIssueKey,
  tokenIntentReady,
  updatesErrorKey,
  validateSourceUrl,
} from "../presenters";
import { ChoiceOption } from "./choice-option";

const FORM_ID = "updates-source-form";

/** Where releases come from: the daily check, the source, the channel and the access token. */
export function SourceCard({ view, canChange }: { view: UpdatesView; canChange: boolean }) {
  const { t } = useTranslation("updates");
  const { t: tc } = useTranslation();
  const save = useSaveUpdateSettings();
  const identity = useConfirmIdentity();
  const locked = view.environmentOverride !== null;

  const stored = settingsFormOf(view);
  const storedKey = JSON.stringify(stored);
  const [form, setForm] = React.useState<SettingsForm>(stored);
  const [submitError, setSubmitError] = React.useState<unknown>(null);
  const [urlTouched, setUrlTouched] = React.useState(false);

  const patch = buildSettingsPatch(form, view);
  const dirty = patch !== null;
  const dirtyRef = React.useRef(dirty);
  dirtyRef.current = dirty;

  // Follow changes made elsewhere (a poll, another admin) without throwing away what is being edited.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key stands for `stored`.
  React.useEffect(() => {
    if (!dirtyRef.current) {
      setForm(settingsFormOf(view));
    }
  }, [storedKey]);

  const urlIssue = locked ? null : validateSourceUrl(form.sourceUrl);
  const tokenReady = tokenIntentReady(form.token);
  const canSave = canChange && dirty && urlIssue === null && tokenReady;
  const disabled = !canChange || save.isPending;
  const placeholder = t("source.url.placeholder", { url: defaultSourceUrl(view) });

  const update = (next: Partial<SettingsForm>) => {
    setSubmitError(null);
    setForm((current) => ({ ...current, ...next }));
  };

  const discard = () => {
    setSubmitError(null);
    setUrlTouched(false);
    setForm(settingsFormOf(view));
  };

  const onSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    setUrlTouched(true);
    if (!patch || !canSave) {
      return;
    }
    submit(patch);
  };

  // The source and the token need a recent sign-in (apps/api lib/recent-sign-in.ts):
  // the change is repeated as it was once the person confirmed it is them.
  const submit = (changes: NonNullable<typeof patch>) => {
    setSubmitError(null);
    save.mutate(changes, {
      onSuccess: (next) => {
        setForm(settingsFormOf(next));
        setUrlTouched(false);
        toast.success(t("toasts.saved"));
      },
      onError: (error) => {
        setSubmitError(error);
        if (isRecentSignInRequired(error)) {
          identity.ask(() => submit(changes));
        }
      },
    });
  };

  const enabledShown = locked ? view.check.enabled : form.enabled;
  const showUrlError = urlIssue !== null && urlTouched;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("source.title")}</CardTitle>
        <CardDescription>{t("source.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <form id={FORM_ID} onSubmit={onSubmit} noValidate className="space-y-6">
          {locked && view.environmentOverride ? (
            <Alert variant="info" data-slot="environment-override">
              <Info />
              <AlertTitle>{t("source.environment.title")}</AlertTitle>
              <AlertDescription>
                <p>{t("source.environment.description")}</p>
                <code
                  className="block max-w-full overflow-x-auto rounded border border-border bg-background px-2 py-1 font-mono text-xs [overflow-wrap:anywhere]"
                  data-slot="environment-url"
                >
                  {view.environmentOverride.url}
                </code>
              </AlertDescription>
            </Alert>
          ) : null}

          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <Label htmlFor="updates-check-enabled" className="leading-normal">
                {t("source.enabled.label")}
              </Label>
              <p id="updates-check-enabled-hint" className="text-sm text-muted-foreground">
                {t("source.enabled.hint")}
              </p>
            </div>
            <Switch
              id="updates-check-enabled"
              aria-describedby="updates-check-enabled-hint"
              checked={enabledShown}
              disabled={disabled || locked}
              onCheckedChange={(enabled) => update({ enabled })}
            />
          </div>

          <div className="space-y-3">
            <Field
              id="updates-source-url"
              label={t("source.url.label")}
              error={showUrlError && urlIssue ? t(sourceUrlIssueKey(urlIssue)) : undefined}
              hint={locked ? t("source.url.lockedHint") : t("source.url.hint")}
            >
              <div className="flex gap-2">
                <Input
                  id="updates-source-url"
                  type="url"
                  inputMode="url"
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={MAX_SOURCE_URL_LENGTH + 50}
                  placeholder={placeholder}
                  value={locked ? (view.environmentOverride?.url ?? "") : form.sourceUrl}
                  readOnly={locked}
                  disabled={disabled}
                  aria-invalid={showUrlError}
                  aria-describedby={messageId("updates-source-url")}
                  onChange={(event) => update({ sourceUrl: event.target.value })}
                  onBlur={() => setUrlTouched(true)}
                />
                {!locked && form.sourceUrl.length > 0 ? (
                  <Button
                    type="button"
                    variant="outline"
                    className="shrink-0"
                    disabled={disabled}
                    onClick={() => {
                      update({ sourceUrl: "" });
                      setUrlTouched(false);
                    }}
                  >
                    {t("source.url.reset")}
                  </Button>
                ) : null}
              </div>
            </Field>

            <div
              className="flex flex-col gap-2 rounded-lg border border-border p-3 text-sm sm:flex-row sm:items-start sm:gap-3"
              data-slot="update-mode"
              data-mode={view.mode}
            >
              <Badge variant={view.mode === "image" ? "info" : "secondary"} className="shrink-0">
                {t(`source.mode.${view.mode}.label`)}
              </Badge>
              <p className="text-muted-foreground">{t(`source.mode.${view.mode}.description`)}</p>
            </div>
          </div>

          <fieldset className="space-y-2" disabled={disabled}>
            <legend className="mb-2 text-sm leading-none font-medium">
              {t("source.channel.label")}
            </legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {UPDATE_CHANNELS.map((channel) => (
                <ChoiceOption
                  key={channel}
                  name="updates-channel"
                  value={channel}
                  checked={form.channel === channel}
                  disabled={disabled}
                  onSelect={(value) => update({ channel: value as UpdateChannel })}
                >
                  <span className="block font-medium">{t(`source.channel.${channel}.label`)}</span>
                  <span className="block text-xs text-muted-foreground">
                    {t(`source.channel.${channel}.description`)}
                  </span>
                </ChoiceOption>
              ))}
            </div>
          </fieldset>

          <TokenField
            view={view}
            form={form}
            disabled={disabled || locked}
            locked={locked}
            onChange={(token) => update({ token })}
          />

          {submitError ? (
            <Alert variant="destructive">
              <TriangleAlert />
              <AlertDescription>{t(updatesErrorKey(submitError))}</AlertDescription>
            </Alert>
          ) : null}
        </form>
      </CardContent>
      <CardFooter className="flex flex-col-reverse gap-3 border-t border-border pt-6 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-muted-foreground" aria-live="polite">
          {dirty ? t("form.unsaved") : t("form.saved")}
        </p>
        <div className="flex flex-col-reverse gap-2 sm:flex-row">
          <Button variant="outline" onClick={discard} disabled={!dirty || save.isPending}>
            {t("form.discard")}
          </Button>
          <Button type="submit" form={FORM_ID} loading={save.isPending} disabled={!canSave}>
            {tc("actions.save")}
          </Button>
        </div>
      </CardFooter>
      {identity.dialog}
    </Card>
  );
}

/**
 * The access token for a private repository. Its value never comes back from
 * the api and is never rendered: a stored token is only announced, and can be
 * replaced or removed; what is typed lives in a password field.
 */
function TokenField({
  view,
  form,
  disabled,
  locked,
  onChange,
}: {
  view: UpdatesView;
  form: SettingsForm;
  disabled: boolean;
  locked: boolean;
  onChange: (token: SettingsForm["token"]) => void;
}) {
  const { t } = useTranslation("updates");
  const stored = view.settings.tokenSet;
  const intent = form.token;
  const showInput = !stored || intent.kind === "replace";

  return (
    <div className="space-y-2" data-slot="token">
      <Label htmlFor={showInput ? "updates-token" : undefined} className="leading-normal">
        {t("source.token.label")}
      </Label>

      {stored && intent.kind === "remove" ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-3 text-sm">
          <span>{t("source.token.willRemove")}</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={() => onChange({ kind: "keep" })}
          >
            {t("source.token.undo")}
          </Button>
        </div>
      ) : null}

      {stored && intent.kind === "keep" ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-3 text-sm">
          <span data-slot="token-stored">{t("source.token.stored")}</span>
          <span className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled}
              onClick={() => onChange({ kind: "replace", value: "" })}
            >
              {t("source.token.replace")}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled}
              onClick={() => onChange({ kind: "remove" })}
            >
              {t("source.token.remove")}
            </Button>
          </span>
        </div>
      ) : null}

      {showInput ? (
        <div className="flex gap-2">
          <Input
            id="updates-token"
            name="update-access-token"
            type="password"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            data-1p-ignore
            data-lpignore="true"
            maxLength={MAX_TOKEN_LENGTH}
            disabled={disabled}
            aria-describedby="updates-token-hint"
            placeholder={stored ? t("source.token.newPlaceholder") : t("source.token.placeholder")}
            value={intent.kind === "replace" ? intent.value : ""}
            onChange={(event) =>
              onChange(
                event.target.value.length > 0 || stored
                  ? { kind: "replace", value: event.target.value }
                  : { kind: "keep" },
              )
            }
          />
          {stored ? (
            <Button
              type="button"
              variant="outline"
              className="shrink-0"
              disabled={disabled}
              onClick={() => onChange({ kind: "keep" })}
            >
              {t("source.token.cancel")}
            </Button>
          ) : null}
        </div>
      ) : null}

      <p id="updates-token-hint" className="text-xs text-muted-foreground">
        {locked ? t("source.token.lockedHint") : t("source.token.hint")}
      </p>
    </div>
  );
}
