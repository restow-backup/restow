import { CircleCheck, CircleX, ImageUp, Info, Send, Trash2, TriangleAlert } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { Field, messageId } from "@/components/forms/field";
import { ReadOnlyGroup } from "@/components/kit";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import { Textarea } from "@/components/ui/textarea";
import { errorMessageKey } from "@/lib/api";
import { cn } from "@/lib/utils";

import type { BrandingDto, MailSenderFacts, PreviewKind } from "./api";
import {
  type BrandingScope,
  useBrandingPreview,
  useRemoveLogo,
  useSaveBranding,
  useSendBrandingTest,
  useUploadLogo,
} from "./hooks";
import {
  accentReadout,
  type BrandingField,
  type BrandingFormValues,
  brandingFormFrom,
  brandingProblem,
  FOOTER_MAX,
  logoFileProblem,
  MIN_CONTRAST,
  SENDER_NAME_MAX,
  toBrandingInput,
  validateBranding,
} from "./presenters";

/**
 * The branding form (0.5.0), the same for the provider's branding (Installation › Branding) and
 * a tenant's own (the tenant page's Branding): the logo, the sender name, From and Reply-To, the
 * accent colour with its contrast, the footer with the imprint, a preview of the saved branding
 * in a sandboxed frame and a test mail. Every check the server makes is made here first, so the
 * save button says what is wrong before the server does.
 */

export interface BrandingEditorProps {
  scope: BrandingScope;
  /** What is saved now. */
  branding: BrandingDto;
  mail: MailSenderFacts;
  /** The product name, which the messages carry where no sender name is set. */
  productName: string;
  /** Chat services fetch the logo themselves: only over a public https address. */
  publicUrlHttps: boolean;
  /** Why changing is closed (the provider role, the demo); the parent shows the sentence. */
  readOnly: boolean;
  /** Whether the viewer may send the test mail. */
  canTest: boolean;
  /** The preview kinds offered (the customer report only where it exists). */
  previewKinds: readonly PreviewKind[];
}

export function BrandingEditor(props: BrandingEditorProps) {
  return (
    <div className="space-y-6" data-slot="branding-editor">
      {props.publicUrlHttps ? null : <HttpsNote />}
      <ReadOnlyGroup closed={props.readOnly} className="space-y-6">
        <LogoCard scope={props.scope} branding={props.branding} />
        <FieldsCard {...props} />
      </ReadOnlyGroup>
      <PreviewCard
        scope={props.scope}
        kinds={props.previewKinds}
        stamp={props.branding.updatedAt ?? ""}
        canTest={props.canTest}
      />
    </div>
  );
}

function HttpsNote() {
  const { t } = useTranslation("settings");
  return (
    <Alert variant="info" data-slot="branding-https-note">
      <Info />
      <AlertDescription>{t("branding.httpsNote")}</AlertDescription>
    </Alert>
  );
}

// --- Logo ---------------------------------------------------------------------------------

function LogoCard({ scope, branding }: { scope: BrandingScope; branding: BrandingDto }) {
  const { t } = useTranslation("settings");
  const { t: tc } = useTranslation();
  const upload = useUploadLogo(scope);
  const remove = useRemoveLogo(scope);
  const [problem, setProblem] = React.useState<string | null>(null);
  const [dragging, setDragging] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const logo = branding.logo;

  function take(file: File | null | undefined) {
    if (!file) return;
    const local = logoFileProblem(file);
    if (local) {
      setProblem(`branding.errors.${local}`);
      return;
    }
    setProblem(null);
    upload.mutate(file, {
      onSuccess: () => toast.success(t("branding.logo.uploaded")),
      onError: (error) => {
        const refusal = brandingProblem(error);
        if (refusal) setProblem(refusal.key);
        else toast.error(tc(errorMessageKey(error)));
      },
    });
  }

  return (
    <Card data-slot="branding-logo">
      <CardHeader>
        <CardTitle className="text-base">{t("branding.logo.title")}</CardTitle>
        <CardDescription>{t("branding.logo.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
          <div className="flex h-24 w-full shrink-0 items-center justify-center rounded-md border bg-white p-2 sm:w-56">
            {logo ? (
              <img
                src={logo.url}
                alt={t("branding.logo.alt")}
                className="max-h-full max-w-full object-contain"
                data-slot="branding-logo-image"
              />
            ) : (
              <span className="text-xs text-muted-foreground">{t("branding.logo.none")}</span>
            )}
          </div>
          {/* A drop zone and a button: the file goes through the same checks either way. */}
          {/* biome-ignore lint/a11y/noStaticElementInteractions: dropping is the mouse's way; the button inside is the keyboard's */}
          <div
            className={cn(
              "flex min-h-24 flex-1 flex-col items-center justify-center gap-2 rounded-md border border-dashed p-4 text-center text-sm",
              dragging ? "border-primary bg-primary/5" : "border-border",
            )}
            data-slot="branding-dropzone"
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              take(event.dataTransfer.files?.[0]);
            }}
          >
            <span className="text-muted-foreground">{t("branding.logo.drop")}</span>
            <input
              ref={inputRef}
              id="branding-logo-file"
              type="file"
              accept="image/png,image/jpeg"
              className="sr-only"
              aria-describedby="branding-logo-rules"
              onChange={(event) => {
                take(event.target.files?.[0]);
                event.target.value = "";
              }}
            />
            <div className="flex flex-wrap justify-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                loading={upload.isPending}
                onClick={() => inputRef.current?.click()}
              >
                {upload.isPending ? null : <ImageUp aria-hidden="true" />}
                {logo ? t("branding.logo.replace") : t("branding.logo.choose")}
              </Button>
              {logo ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  loading={remove.isPending}
                  onClick={() =>
                    remove.mutate(undefined, {
                      onSuccess: () => toast.success(t("branding.logo.removed")),
                      onError: (error) => toast.error(tc(errorMessageKey(error))),
                    })
                  }
                >
                  {remove.isPending ? null : <Trash2 aria-hidden="true" />}
                  {t("branding.logo.remove")}
                </Button>
              ) : null}
            </div>
          </div>
        </div>
        <p id="branding-logo-rules" className="text-xs text-muted-foreground">
          {t("branding.logo.rules")}
          {logo
            ? ` ${t("branding.logo.current", {
                width: logo.width,
                height: logo.height,
                size: Math.max(1, Math.round(logo.bytes / 1024)),
              })}`
            : ""}
        </p>
        {problem ? (
          <Alert variant="destructive" data-slot="branding-logo-error">
            <TriangleAlert />
            <AlertDescription>{t(problem)}</AlertDescription>
          </Alert>
        ) : null}
      </CardContent>
    </Card>
  );
}

// --- Sender, colour, footer ------------------------------------------------------------------

function FieldsCard({ scope, branding, mail, productName, readOnly }: BrandingEditorProps) {
  const { t } = useTranslation("settings");
  const { t: tc } = useTranslation();
  const save = useSaveBranding(scope);
  const saved = React.useMemo(() => brandingFormFrom(branding), [branding]);
  const [values, setValues] = React.useState<BrandingFormValues>(saved);
  const [serverErrors, setServerErrors] = React.useState<Partial<Record<BrandingField, string>>>(
    {},
  );
  const [submitError, setSubmitError] = React.useState<string | null>(null);

  // Follow a save elsewhere (another tab, the tenant's inherit switch) when nothing is edited.
  const savedKey = JSON.stringify(saved);
  const [lastSaved, setLastSaved] = React.useState(savedKey);
  if (savedKey !== lastSaved) {
    setLastSaved(savedKey);
    setValues(saved);
  }

  const errors = { ...validateBranding(values, mail), ...serverErrors };
  const dirty = JSON.stringify(values) !== savedKey;
  const blocked = Object.keys(validateBranding(values, mail)).length > 0;
  const readout = accentReadout(values.accentColor);

  const set = (field: BrandingField, value: string) => {
    setValues((current) => ({ ...current, [field]: value }));
    setServerErrors((current) => {
      const { [field]: _gone, ...rest } = current;
      return rest;
    });
  };

  async function onSave() {
    setSubmitError(null);
    if (blocked) return;
    try {
      await save.mutateAsync(toBrandingInput(values));
      toast.success(t("branding.saved"));
    } catch (error) {
      const refusal = brandingProblem(error);
      if (refusal?.field && refusal.field !== "logo") {
        setServerErrors({ [refusal.field]: refusal.key });
      } else {
        setSubmitError(refusal ? t(refusal.key) : tc(errorMessageKey(error)));
      }
    }
  }

  const message = (field: BrandingField) =>
    errors[field] ? t(errors[field] as string) : undefined;

  return (
    <Card data-slot="branding-fields">
      <CardHeader>
        <CardTitle className="text-base">{t("branding.fields.title")}</CardTitle>
        <CardDescription>{t("branding.fields.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <Field
          id="branding-sender-name"
          label={t("branding.fields.senderName")}
          hint={t("branding.fields.senderNameHint", { appName: productName })}
          error={message("senderName")}
        >
          <Input
            id="branding-sender-name"
            value={values.senderName}
            maxLength={SENDER_NAME_MAX}
            placeholder={productName}
            aria-invalid={errors.senderName !== undefined}
            aria-describedby={messageId("branding-sender-name")}
            onChange={(event) => set("senderName", event.target.value)}
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            id="branding-from"
            label={t("branding.fields.from")}
            hint={
              mail.fromLocked
                ? t("branding.fields.fromLocked", { sender: mail.defaultFrom ?? "" })
                : mail.transport === "smtp"
                  ? t("branding.fields.fromHint", { sender: mail.defaultFrom ?? "" })
                  : t("branding.fields.fromNoTransport")
            }
            error={message("fromAddress")}
          >
            <Input
              id="branding-from"
              type="email"
              autoComplete="off"
              spellCheck={false}
              value={mail.fromLocked ? (mail.defaultFrom ?? "") : values.fromAddress}
              placeholder={mail.defaultFrom ?? ""}
              disabled={mail.fromLocked}
              aria-invalid={errors.fromAddress !== undefined}
              aria-describedby={messageId("branding-from")}
              onChange={(event) => set("fromAddress", event.target.value)}
            />
          </Field>
          <Field
            id="branding-reply-to"
            label={t("branding.fields.replyTo")}
            hint={t("branding.fields.replyToHint")}
            error={message("replyTo")}
          >
            <Input
              id="branding-reply-to"
              type="email"
              autoComplete="off"
              spellCheck={false}
              value={values.replyTo}
              aria-invalid={errors.replyTo !== undefined}
              aria-describedby={messageId("branding-reply-to")}
              onChange={(event) => set("replyTo", event.target.value)}
            />
          </Field>
        </div>
        <AccentField
          value={values.accentColor}
          error={message("accentColor")}
          onChange={(value) => set("accentColor", value)}
          readout={readout}
        />
        <Field
          id="branding-footer"
          label={t("branding.fields.footer")}
          hint={t("branding.fields.footerHint", {
            used: values.footerText.length,
            max: FOOTER_MAX,
          })}
          error={message("footerText")}
        >
          <Textarea
            id="branding-footer"
            rows={4}
            maxLength={FOOTER_MAX}
            value={values.footerText}
            aria-invalid={errors.footerText !== undefined}
            aria-describedby={messageId("branding-footer")}
            onChange={(event) => set("footerText", event.target.value)}
          />
        </Field>
        {submitError ? (
          <Alert variant="destructive">
            <TriangleAlert />
            <AlertDescription>{submitError}</AlertDescription>
          </Alert>
        ) : null}
        {readOnly ? null : (
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button
              type="button"
              variant="outline"
              disabled={!dirty || save.isPending}
              onClick={() => {
                setValues(saved);
                setServerErrors({});
                setSubmitError(null);
              }}
            >
              {t("branding.discard")}
            </Button>
            <Button
              type="button"
              disabled={!dirty || blocked}
              loading={save.isPending}
              onClick={() => void onSave()}
              data-slot="branding-save"
            >
              {t("branding.save")}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function AccentField({
  value,
  error,
  onChange,
  readout,
}: {
  value: string;
  error: string | undefined;
  onChange: (value: string) => void;
  readout: ReturnType<typeof accentReadout>;
}) {
  const { t } = useTranslation("settings");
  const picker = readout ? value.trim().toLowerCase() : "#2b4c9b";
  return (
    <div className="space-y-2">
      <Field
        id="branding-accent"
        label={t("branding.fields.accent")}
        hint={t("branding.fields.accentHint")}
        error={error}
      >
        <div className="flex items-center gap-2">
          <input
            type="color"
            aria-label={t("branding.fields.accentPicker")}
            className="h-9 w-12 shrink-0 cursor-pointer rounded-md border bg-transparent p-1"
            value={picker}
            onChange={(event) => onChange(event.target.value)}
          />
          <Input
            id="branding-accent"
            className="max-w-40 font-mono"
            value={value}
            placeholder="#2b4c9b"
            spellCheck={false}
            aria-invalid={error !== undefined}
            aria-describedby={messageId("branding-accent")}
            onChange={(event) => onChange(event.target.value)}
          />
          {value ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => onChange("")}>
              {t("branding.fields.accentClear")}
            </Button>
          ) : null}
        </div>
      </Field>
      {readout ? (
        <div
          className="flex flex-wrap items-center gap-3 text-xs"
          data-slot="branding-contrast"
          aria-live="polite"
        >
          <span
            className="inline-flex h-7 items-center rounded-md px-3 font-medium"
            style={{
              backgroundColor: value.trim().toLowerCase(),
              color: readout.onAccent === "dark" ? "#0f1b2d" : "#ffffff",
            }}
          >
            {t("branding.contrast.sample")}
          </span>
          <ContrastFact label={t("branding.contrast.white")} ratio={readout.white} />
          <ContrastFact label={t("branding.contrast.dark")} ratio={readout.dark} />
          <span className="text-muted-foreground">
            {readout.onAccent === null
              ? t("branding.contrast.fails", { min: MIN_CONTRAST })
              : readout.linksUseAccent
                ? t("branding.contrast.links")
                : t("branding.contrast.linksDefault")}
          </span>
        </div>
      ) : null}
    </div>
  );
}

function ContrastFact({ label, ratio }: { label: string; ratio: number }) {
  const { t, i18n } = useTranslation("settings");
  const passes = ratio >= MIN_CONTRAST;
  const Icon = passes ? CircleCheck : CircleX;
  return (
    <Badge
      variant={passes ? "outline" : "destructive"}
      data-slot="branding-contrast-ratio"
      data-pass={passes}
    >
      <Icon aria-hidden="true" />
      {t("branding.contrast.ratio", {
        label,
        ratio: ratio.toLocaleString(i18n.resolvedLanguage ?? i18n.language, {
          maximumFractionDigits: 2,
        }),
        verdict: passes ? t("branding.contrast.pass") : t("branding.contrast.fail"),
      })}
    </Badge>
  );
}

// --- Preview and test -----------------------------------------------------------------------

function PreviewCard({
  scope,
  kinds,
  stamp,
  canTest,
}: {
  scope: BrandingScope;
  kinds: readonly PreviewKind[];
  /** Changes with every save, so the preview reloads. */
  stamp: string;
  canTest: boolean;
}) {
  const { t, i18n } = useTranslation("settings");
  const { t: tc } = useTranslation();
  const [kind, setKind] = React.useState<PreviewKind>(kinds[0] ?? "alert");
  const tenantId = scope.kind === "tenant" ? scope.tenantId : null;
  const lang = (i18n.resolvedLanguage ?? i18n.language) === "de" ? "de" : "en";
  const preview = useBrandingPreview(kind, tenantId, lang);
  const test = useSendBrandingTest();
  const { refetch } = preview;

  React.useEffect(() => {
    if (stamp) void refetch();
  }, [stamp, refetch]);

  return (
    <Card data-slot="branding-preview">
      <CardHeader>
        <CardTitle className="text-base">{t("branding.preview.title")}</CardTitle>
        <CardDescription>{t("branding.preview.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div
          role="tablist"
          aria-label={t("branding.preview.kinds")}
          className="flex flex-wrap gap-2"
        >
          {kinds.map((candidate) => (
            <Button
              key={candidate}
              type="button"
              role="tab"
              size="sm"
              variant={candidate === kind ? "secondary" : "outline"}
              aria-selected={candidate === kind}
              onClick={() => setKind(candidate)}
            >
              {t(`branding.preview.tabs.${candidate}`)}
            </Button>
          ))}
        </div>
        {preview.isPending ? (
          <Skeleton className="h-96 w-full" />
        ) : preview.isError || !preview.data ? (
          <Alert variant="destructive">
            <TriangleAlert />
            <AlertDescription>{tc(errorMessageKey(preview.error))}</AlertDescription>
          </Alert>
        ) : (
          <div className="space-y-2">
            <p className="text-sm">
              <span className="text-muted-foreground">{t("branding.preview.subject")}</span>{" "}
              <span className="font-medium" data-slot="branding-preview-subject">
                {preview.data.subject}
              </span>
            </p>
            {/*
             * The mail's HTML in a frame without any permission: no scripts, no forms, no
             * navigation, an origin of its own. Only the logo loads, from this instance.
             */}
            <iframe
              title={t("branding.preview.frame")}
              sandbox=""
              srcDoc={preview.data.html}
              referrerPolicy="no-referrer"
              className="h-[32rem] w-full rounded-md border bg-white"
              data-slot="branding-preview-frame"
            />
          </div>
        )}
        <div className="flex flex-col gap-2 border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-muted-foreground">{t("branding.test.description")}</p>
          <Button
            type="button"
            variant="outline"
            disabled={!canTest}
            loading={test.isPending}
            onClick={() =>
              test.mutate(tenantId, {
                onSuccess: (result) => toast.success(t("branding.test.sent", { to: result.to })),
                onError: (error) => toast.error(tc(errorMessageKey(error))),
              })
            }
          >
            {test.isPending ? null : <Send aria-hidden="true" />}
            {t("branding.test.send")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
