/**
 * The service an object belongs to, as the alert texts name it (0.5.0). A person's mailbox and
 * OneDrive share the person's name, so a message that named only the person would not say which
 * one it is about. The bell and the mails translate `details.objectKind` themselves; these
 * English labels are for the stored message text.
 */
export const SERVICE_LABELS: Readonly<Record<string, string>> = {
  mailbox: "Mailbox",
  onedrive: "OneDrive",
  site: "SharePoint site",
  group: "Microsoft 365 group",
  imap: "IMAP mailbox",
};

/** "OneDrive · msp@contoso.example"; the bare name for a kind without a label. */
export function serviceLabel(kind: string | null | undefined, name: string): string {
  const service = kind ? SERVICE_LABELS[kind] : undefined;
  return service ? `${service} · ${name}` : name;
}

/** The object with its service, from a protected object reference. */
export function serviceObjectLabel(object: {
  readonly kind: string;
  readonly displayName?: string | null;
  readonly externalId: string;
}): string {
  return serviceLabel(object.kind, object.displayName ?? object.externalId);
}
