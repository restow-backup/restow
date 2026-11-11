# Notifications, reports and branding

This page is for operators. It explains who receives alerts and reports, when they are sent,
what happens when a notification cannot be delivered, and how mails, reports and chat webhooks
carry your branding (0.5.0). The rules, the notification matrix and the delivery log are
described in [ARCHITECTURE.md](ARCHITECTURE.md), "Berichte und Benachrichtigungen".

## Editions

| Function | Edition | Capability | Gated feature |
| --- | --- | --- | --- |
| Notification recipients of the provider, the floor, digests, delivery failure alerts | all editions | – | – |
| Daily, weekly and monthly summary reports (per tenant and across tenants), with the PDF statistics | Business | `reports.scheduled` | `reports.timed` |
| Branding of the provider (logo, accent, sender name, From, Reply-To, footer) | Business | `branding.provider` | `branding.provider` |
| A tenant's own branding, overriding the provider's | Service Provider | `branding.tenant` | `branding.tenant` |
| Customer monthly report (HTML mail and PDF) to a tenant's contacts | Service Provider | `reports.customer` | `reports.customer` |

Community keeps the product name only (`RESTOW_PRODUCT_NAME`). Stored branding is ignored as soon
as its gate is closed, for example after a downgrade: mails and posts go out with the product
name again, and the stored values come back with the edition.

## Recipients and the floor

Installation › Notifications lists the provider's own recipients. They receive alerts about every
tenant, and the installation's own events (updates, disk space, the central app's credential).
Each recipient has a column of events, the summary reports it wants (daily, weekly, monthly) and a
delivery mode per severity (see Digests).

- **Owners.** Every owner of the provider team (a provider admin without a team role, or with the
  role "owner") is a recipient of their own. The list follows the team: a new owner appears, an
  owner who becomes an administrator turns into an ordinary recipient. An owner cannot be removed
  from the list.
- **Mandatory recipients.** An owner can mark any recipient as mandatory; only owners can set or
  clear the mark, change a mandatory recipient's address or remove it. An administrator who saves
  the list keeps every mandatory recipient with its address (the API answers 403
  `owner-required` otherwise).
- **The floor.** Owners and mandatory recipients always receive the critical events and failed
  deliveries, whatever their column says. An alert about ransomware, a failed restore check or a
  corrupt repository can never end with nobody.

The provider's deliveries carry no tenant. Row Level Security hides them from every tenant
session, so a customer never sees the provider's addresses. In the cross-tenant delivery log and
its CSV export they appear as "Installation".

A tenant's own recipients (tenant page › Notifications) work as before; each now has a delivery
mode per severity too, and can choose the daily, weekly and monthly report.

## Critical events

These events are security or data-loss events: `backup.suspicious` (ransomware signs),
`endpoint.suspicious_snapshot`, `endpoint.backups_deletion_scheduled` (the backups of a removed
machine are due for deletion in seven days, so the floor learns of it while it can still be
stopped), `scrub.corrupt`, `verify.red`, `backup.unusually_large` (a run held before it filled the
storage, docs/STORAGE.md "Unusually large runs"), `installation.disk_low` and
`installation.disk_reserve_released` (the emergency disk reserve was freed, docs/DATABASE.md
"Disk full").
They are always sent at once (never held for a digest), always reach the floor, and always appear
in the bell: the bell's column can no longer switch them off.

## Digests

Every recipient chooses per severity (error, warning, notice): immediately, an hourly digest or a
daily digest.

- The hourly digest goes out at the next full hour (UTC).
- The daily digest goes out at 07:00 in the tenant's time zone (the installation's for the
  provider's recipients and for a tenant without one: the zone chosen in the setup wizard or
  under Installation › Server, else `RESTOW_TIME_ZONE`, else `TZ`; the same whether the worker
  or the API raised the alert).
- Critical events and failed deliveries are always sent at once.
- Digests are for e-mail only. Webhooks and the bell always get every alert at once. Summary and
  customer reports are never collected.

One digest mail lists the alerts grouped by tenant and severity, at most 200 lines and the number
of the rest. The delivery log shows a held row as "Waiting for the digest" with the time it goes out.

## Delivery failures

When a notification cannot be delivered, `notification.delivery_failed` is raised: it always
reaches the bell and the floor, and it is never sent through the channel that failed.

What is detected:

- **A refused address.** The mail server refused the recipient or the message for good (an SMTP
  550, 551, 553 or 554 answer to RCPT TO or DATA that does not name the sender, Microsoft Graph
  `ErrorInvalidRecipients`). Such a mail is not retried any more (until 0.4 it was retried four
  times).
- **A mail that failed after every retry** (1, 5, 15 and 60 minutes).
- **The mail transport as a whole**: not configured, the login refused, the server unreachable,
  TLS failing, the sender refused (`smtp_sender_rejected`, retried like the others: an SMTP 5xx
  answer to MAIL FROM, or to RCPT TO or DATA that names the sender, such as "Sender address
  rejected", "not owned by user" or Exchange's `5.2.252 SendAsDenied`, e.g. a branded From the
  server will not send as), no token from Microsoft 365 or Google Workspace, a timeout. Its alert
  is the installation's: it reaches the provider's bell and recipients (never by e-mail) and the
  webhooks of every tenant whose rules listen for `notification.delivery_failed`. It names no
  tenant's rule and carries only the reason, not the server's answer, since the transport
  concerns them all and the answer can name one tenant's branded From, the relay or its login;
  the answer stays with the failed delivery in that tenant's delivery log.
- **A webhook that keeps failing**: at once on an answer a retry cannot change (410, a chat
  service's 400, 401, 403, 404, 413 or 422, a blocked address), otherwise after three failed
  attempts in a row whose first failure is at least 15 minutes old. A paused webhook is no failure.

What is not detected: an asynchronous bounce (a delivery status notification that arrives after
the server accepted the mail). The notification mail has no mailbox that receives them.

Episodes, so that one problem gives one alert:

- the transport as a whole: one alert until a mail gets through again;
- a notification recipient (tenant or provider): one alert until a mail to that address gets
  through again; the recipient shows a failure badge meanwhile;
- an address typed into one rule only: at most one alert per address and 24 hours;
- a webhook: one alert until a delivery gets through again; the webhook shows its health.

An alert about a failed delivery that fails itself raises no further alert: it is only logged
and recorded.

From 0.5.0 on every installation has recipients: the owners of the provider team, who receive
the critical events and the installation's own events by e-mail. An installation without a mail
transport therefore gets one such alert (in the bell and through webhooks) that lasts until a
transport is configured, instead of silence. If the operator marked the notification mail as
not needed (the Start checklist), no mail is planned for the provider's recipients and no alert
about the missing transport is raised, as until 0.4; the bell still shows every event.

## Summary reports

A schedule rule can have a calendar cadence:

- **daily**: the previous calendar day,
- **weekly**: the previous Monday to Sunday (until 0.4 the weekly report covered the seven days
  up to Monday 07:00; the rule of the tenant's notification recipients changes to the calendar
  week with the update),
- **monthly**: the previous calendar month,

each in the rule's time zone, sent at 07:00. A rule with its own interval or cron keeps its rolling
period. "Attach PDF" adds the statistics report as a PDF (the same document as the statistics page's
download, in the mail's branding).

The provider's own summary across tenants (Installation › Notifications) sums every active
tenant; in Business that is the installation's tenant or tenants. The statistics page across
tenants stays Service Provider.

## Customer monthly report

On the tenant page (Service Provider), the provider sets up a monthly report for the customer: the
day (1 to 28) and the hour it goes out, the language, and which contacts receive it (master data ›
contacts › "Receives the monthly report", which needs an e-mail address). It covers the previous
calendar month: what is protected, how reliably it was backed up and checked, restores, the
storage used, the most frequent causes of failed backups and the number of suspicious findings, in
plain language and without prices. The mail carries the PDF; both are in the provider's branding
or the tenant's own.

## Branding

Installation › Branding (Business) and the tenant page › Branding (Service Provider).

- **Logo**: PNG or JPEG, at most 512 KiB, 16 to 2000 pixels per side, at most 4 megapixels. Every
  SVG is refused: an SVG can carry scripts and references to other files, and turning it into a
  picture safely would need an image library the server does not ship. GIF, WebP and animated PNG
  are refused too. A PNG's header must be one the PNG specification allows, and its image data
  must inflate to exactly the size the header announces; it is inflated with that size as the
  limit, so a small file that would inflate to far more (a decompression bomb) is refused without
  costing memory. Every row of the image data must name one of the five filter types the PNG
  specification defines. Metadata is removed before the logo is stored: of a PNG every chunk
  except the image's own and the few that change how it looks (transparency, gamma,
  chromaticity, sRGB, significant bits, background, pixel size), so text, time, EXIF, the ICC
  profile and unknown chunks go; of a JPEG EXIF, XMP, ICC and comments. The picture itself stays as it was.
- **Accent colour**: text on the accent has to reach a contrast of 4.5:1, white or dark; a colour
  where neither does is refused, and the page shows both ratios. Links take the accent only when it
  reads on white, else they keep the default blue.
- **Sender name, From and Reply-To**:
  - SMTP: a From address must be the configured sender or match an entry of "Allowed sender
    addresses" (Installation › Notification mail): an exact address or `@domain`. Add the address
    there before you brand it, and make sure your mail server lets the account send as it (SPF and
    DKIM included). The check runs again for every mail: once the allowed senders, the configured
    sender or the transport no longer allow a stored From, mails go out from the configured
    sender with the brand's name, until the branding or the mail settings are corrected.
  - Microsoft 365 and Google Workspace always send from the configured mailbox: only the sender
    name and Reply-To are branded. Exchange may show the mailbox's own display name instead of
    the sender name.
- **Footer and imprint**: up to 2000 characters, shown under every mail.

How mails carry it: the logo travels inside the mail as an inline attachment the HTML refers to by
its Content-ID (`cid:`). Nothing is loaded from outside when the mail is opened, there are no
tracking pixels, and every text from data is escaped as before. The preview on the branding page
shows the mail in a sandboxed frame without scripts.

### Webhook branding

- **Discord**: the brand name as the sender (`username`) and the logo as the avatar. Discord
  refuses names that contain "discord" or "clyde"; such a name is left out and the webhook's own
  name shows. The accent colours summary reports; alerts keep their severity colour.
- **Slack**: the brand name only (`username`). Incoming webhooks of Slack apps created in recent
  years ignore it and show the app's name and icon; older ones honour it.
- **Microsoft Teams**: the card starts with a thin band in the accent and shows the logo next to
  the title. Teams knows only named colours, so the band is a 1×1 image in the accent the instance
  serves.
- The footer of every chat message names the brand.
- The signed `restow` JSON format is never branded.

Logos and the accent band are fetched by the chat services themselves, from
`/api/v1/public/branding/…` on your public URL. That route needs no sign-in, serves only the image
by an unguessable token (no tenant data), and is cached for a year. A replaced logo keeps working
for 30 days, so messages already sent still show it. Without a public **https** address there is
no logo and no band in chat messages (the page says so).
