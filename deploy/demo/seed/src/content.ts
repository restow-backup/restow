import type { Rng } from "./prng.js";
import { pick, randomInt } from "./prng.js";

/**
 * Content templates for the synthetic mail generator (deploy/demo/README.md):
 * invoices, orders, newsletters and everyday correspondence in German and
 * English, for a fictional company on the IANA-reserved `example.org`/
 * `example.com` domains. Every name is a placeholder ("Doe", "Sample",
 * "Placeholder"); nothing here refers to a real person, company or address.
 * The demo generates English only (generate-mail.ts); the German templates
 * stay for tests and for installations that want German sample mail.
 */

export type MailKind = "invoice" | "order" | "newsletter" | "meeting" | "general";
export type Language = "de" | "en";

export interface Correspondent {
  name: string;
  email: string;
}

const EXTERNAL_PEOPLE: readonly Correspondent[] = [
  { name: "Jane Doe", email: "jane.doe@example.com" },
  { name: "John Sample", email: "john.sample@example.com" },
  { name: "Alex Placeholder", email: "alex.placeholder@example.net" },
  { name: "Sam Template", email: "sam.template@example.net" },
  { name: "Chris Example", email: "chris.example@example.com" },
  { name: "Taylor Demo", email: "taylor.demo@example.net" },
];

const EXTERNAL_COMPANIES: readonly string[] = [
  "Sample & Sons Ltd",
  "Placeholder Inc.",
  "Sample Corp",
  "Example Works Ltd",
  "Template Logistics Ltd",
];

const PRODUCTS: readonly string[] = [
  "Binders, 500 pieces",
  "Office chairs, Comfort model",
  "Label printer XT-200",
  "Cardboard boxes, one pallet",
  "Laptop stands, 20 pieces",
  "Thermal paper, 40 rolls",
  "Packing tape, 24 rolls",
  "Whiteboard, 120x90cm",
];

/** Deterministic pick of a correspondent, so a given index always names the same person. */
export function correspondentOf(rng: Rng): Correspondent {
  return pick(rng, EXTERNAL_PEOPLE);
}

export function companyOf(rng: Rng): string {
  return pick(rng, EXTERNAL_COMPANIES);
}

export function productOf(rng: Rng): string {
  return pick(rng, PRODUCTS);
}

export interface GeneratedMessage {
  subject: string;
  /** Plain-text body; the generator wraps it as text/plain (mime.ts). */
  body: string;
}

function invoiceNumber(rng: Rng, date: Date, language: Language): string {
  return `${language === "de" ? "RE" : "INV"}-${date.getUTCFullYear()}-${String(randomInt(rng, 1, 9999)).padStart(4, "0")}`;
}

function orderNumber(rng: Rng, date: Date, language: Language): string {
  return `${language === "de" ? "BE" : "PO"}-${date.getUTCFullYear()}-${String(randomInt(rng, 1, 9999)).padStart(4, "0")}`;
}

function amount(rng: Rng, language: Language): string {
  const value = randomInt(rng, 5000, 480000) / 100;
  return language === "de" ? value.toFixed(2).replace(".", ",") : value.toFixed(2);
}

/** An invoice, in German or English, from a fictional supplier. */
export function invoiceMessage(rng: Rng, date: Date, language: Language): GeneratedMessage {
  const company = companyOf(rng);
  const number = invoiceNumber(rng, date, language);
  const total = amount(rng, language);
  const product = productOf(rng);
  if (language === "de") {
    return {
      subject: `Rechnung ${number} von ${company}`,
      body: [
        "Sehr geehrte Damen und Herren,",
        "",
        `anbei erhalten Sie die Rechnung ${number} für Ihre Bestellung.`,
        "",
        `Position: ${product}`,
        `Rechnungsbetrag: ${total} EUR (inkl. MwSt.)`,
        "Zahlungsziel: 14 Tage netto",
        "",
        "Mit freundlichen Grüßen",
        company,
      ].join("\n"),
    };
  }
  return {
    subject: `Invoice ${number} from ${company}`,
    body: [
      "Dear Sir or Madam,",
      "",
      `please find attached invoice ${number} for your order.`,
      "",
      `Item: ${product}`,
      `Total: EUR ${total} (incl. VAT)`,
      "Payment terms: net 14 days",
      "",
      "Kind regards,",
      company,
    ].join("\n"),
  };
}

/** A purchase order confirmation, in German or English. */
export function orderMessage(rng: Rng, date: Date, language: Language): GeneratedMessage {
  const company = companyOf(rng);
  const number = orderNumber(rng, date, language);
  const product = productOf(rng);
  const quantity = randomInt(rng, 1, 50);
  if (language === "de") {
    return {
      subject: `Auftragsbestätigung ${number}`,
      body: [
        "Vielen Dank für Ihre Bestellung.",
        "",
        `Auftragsnummer: ${number}`,
        `Position: ${product}`,
        `Menge: ${quantity}`,
        "Voraussichtlicher Versand: in 3-5 Werktagen",
        "",
        "Mit freundlichen Grüßen",
        company,
      ].join("\n"),
    };
  }
  return {
    subject: `Order confirmation ${number}`,
    body: [
      "Thank you for your order.",
      "",
      `Order number: ${number}`,
      `Item: ${product}`,
      `Quantity: ${quantity}`,
      "Estimated shipping: 3-5 business days",
      "",
      "Kind regards,",
      company,
    ].join("\n"),
  };
}

/** A company newsletter, in German or English. */
export function newsletterMessage(rng: Rng, _date: Date, language: Language): GeneratedMessage {
  const topics =
    language === "de"
      ? ["neue Öffnungszeiten", "unser Frühjahrssortiment", "ein Update zu unserem Support"]
      : ["new opening hours", "our spring lineup", "a support update"];
  const topic = pick(rng, topics);
  if (language === "de") {
    return {
      subject: `Newsletter: ${topic}`,
      body: [
        "Hallo,",
        "",
        `in dieser Ausgabe: ${topic}.`,
        "Wie immer freuen wir uns über Ihr Feedback.",
        "",
        "Viele Grüße",
        "Ihr Beispiel-Team",
      ].join("\n"),
    };
  }
  return {
    subject: `Newsletter: ${topic}`,
    body: [
      "Hello,",
      "",
      `In this issue: ${topic}.`,
      "As always, we welcome your feedback.",
      "",
      "Best regards,",
      "Your Example Team",
    ].join("\n"),
  };
}

/** An everyday message between colleagues or with a customer. */
export function generalMessage(
  rng: Rng,
  correspondent: Correspondent,
  language: Language,
): GeneratedMessage {
  const subjects =
    language === "de"
      ? ["Kurze Rückfrage", "Termin nächste Woche", "Unterlagen anbei", "Rückmeldung ausstehend"]
      : ["Quick question", "Meeting next week", "Documents attached", "Awaiting your reply"];
  const subject = pick(rng, subjects);
  if (language === "de") {
    return {
      subject,
      body: [
        `Hallo ${correspondent.name.split(" ")[0]},`,
        "",
        "kurze Rückmeldung zu unserem letzten Austausch: alles auf einem guten Weg.",
        "Melde mich, sobald es Neuigkeiten gibt.",
        "",
        "Viele Grüße",
      ].join("\n"),
    };
  }
  return {
    subject,
    body: [
      `Hi ${correspondent.name.split(" ")[0]},`,
      "",
      "Quick update on our last exchange: everything is on track.",
      "I will follow up as soon as there is news.",
      "",
      "Best,",
    ].join("\n"),
  };
}

/** A meeting invitation; the .ics attachment is built separately (ics.ts). */
export function meetingMessage(rng: Rng, _date: Date, language: Language): GeneratedMessage {
  const topics =
    language === "de"
      ? ["Quartalsplanung", "Projekt-Sync", "Kundentermin", "Teambesprechung"]
      : ["quarterly planning", "project sync", "customer call", "team meeting"];
  const topic = pick(rng, topics);
  if (language === "de") {
    return {
      subject: `Einladung: ${topic}`,
      body: [`Einladung zum Termin "${topic}". Details siehe angehängte Kalendereinladung.`].join(
        "\n",
      ),
    };
  }
  return {
    subject: `Invitation: ${topic}`,
    body: [`Invitation to "${topic}". See the attached calendar invite for details.`].join("\n"),
  };
}
