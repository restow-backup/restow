import { Save } from "lucide-react";
import type * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it } from "vitest";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";
import { i18n } from "@/i18n";

/** Static markup is enough for these contracts; no DOM needed. */
function render(node: React.ReactNode): string {
  return renderToStaticMarkup(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>);
}

const svgCount = (html: string) => html.match(/<svg\b/g)?.length ?? 0;

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

describe("Button", () => {
  it("replaces the leading icon with the spinner while loading", () => {
    const html = render(
      <Button loading>
        <Save />
        Save
      </Button>,
    );
    expect(svgCount(html)).toBe(1);
    expect(html).toContain('data-slot="spinner"');
    expect(html).not.toContain("lucide-save");
    expect(html).toContain("Save");
  });

  it("puts the spinner before a text-only label", () => {
    const html = render(<Button loading>Save</Button>);
    expect(svgCount(html)).toBe(1);
    expect(html).toMatch(/data-slot="spinner".*Save<\/button>/);
  });

  it("keeps a wrapper element that is not an icon", () => {
    const html = render(
      <Button loading>
        <span>Save</span>
      </Button>,
    );
    expect(svgCount(html)).toBe(1);
    expect(html).toContain("<span>Save</span>");
  });

  it("is disabled and busy while loading, and plain otherwise", () => {
    const loading = render(<Button loading>Save</Button>);
    expect(loading).toContain(' disabled=""');
    expect(loading).toContain('aria-busy="true"');

    const idle = render(
      <Button>
        <Save />
        Save
      </Button>,
    );
    expect(svgCount(idle)).toBe(1);
    expect(idle).toContain("lucide-save");
    expect(idle).not.toContain("aria-busy");
    expect(idle).not.toContain(' disabled=""');
  });

  it("never submits a form unless asked to", () => {
    expect(render(<Button>Go</Button>)).toContain('type="button"');
    expect(render(<Button type="submit">Go</Button>)).toContain('type="submit"');
  });

  it("keeps the icon sizes feature code uses", () => {
    expect(render(<Button size="icon-sm">x</Button>)).toContain("size-8");
    expect(render(<Button size="icon">x</Button>)).toContain("size-9");
  });
});

describe("Alert", () => {
  it("interrupts screen readers only for destructive and warning", () => {
    const roleOf = (variant: React.ComponentProps<typeof Alert>["variant"]) =>
      render(
        <Alert variant={variant}>
          <AlertTitle>Title</AlertTitle>
          <AlertDescription>Text</AlertDescription>
        </Alert>,
      ).includes('role="alert"');

    expect(roleOf("destructive")).toBe(true);
    expect(roleOf("warning")).toBe(true);
    expect(roleOf("info")).toBe(false);
    expect(roleOf("success")).toBe(false);
    expect(roleOf("default")).toBe(false);
    expect(roleOf(undefined)).toBe(false);
  });

  it("lets the caller override the role", () => {
    const html = render(
      <Alert variant="info" role="alert">
        <AlertTitle>Session expires in one minute</AlertTitle>
      </Alert>,
    );
    expect(html).toContain('role="alert"');
  });

  it("styles status variants with their text-safe token", () => {
    expect(render(<Alert variant="warning" />)).toContain("text-warning-text");
    expect(render(<Alert variant="info" />)).toContain("text-info-text");
  });
});

describe("Badge", () => {
  it("offers every status tone with a text-safe token", () => {
    expect(render(<Badge variant="success">ok</Badge>)).toContain("text-success-text");
    expect(render(<Badge variant="warning">!</Badge>)).toContain("text-warning-text");
    expect(render(<Badge variant="destructive">x</Badge>)).toContain("text-destructive-text");
    expect(render(<Badge variant="info">i</Badge>)).toContain("text-info-text");
    expect(render(<Badge variant="muted">-</Badge>)).toContain("text-muted-foreground");
  });

  it("never clips a long label", () => {
    const html = render(<Badge variant="warning">3 objects with failed items</Badge>);
    expect(html).not.toContain("overflow-hidden");
    expect(html).not.toContain("whitespace-nowrap");
    expect(html).toContain("3 objects with failed items");
  });
});

describe("Checkbox", () => {
  it("renders the indeterminate state as mixed with a dash", () => {
    const html = render(<Checkbox checked="indeterminate" aria-label="Select all" />);
    expect(html).toContain('aria-checked="mixed"');
    expect(html).toContain('data-state="indeterminate"');
    expect(html).toContain("lucide-minus");
  });

  it("renders checked and unchecked states", () => {
    expect(render(<Checkbox checked aria-label="One" />)).toContain('aria-checked="true"');
    expect(render(<Checkbox checked={false} aria-label="One" />)).toContain('aria-checked="false"');
  });
});

describe("Spinner", () => {
  it("shows its label, or announces loading when it has none", () => {
    expect(render(<Spinner label="Checking" />)).toContain("Checking");
    const bare = render(<Spinner />);
    expect(bare).toContain('class="sr-only"');
    expect(bare).toContain(i18n.t("loading.label"));
  });
});

describe("Progress", () => {
  const attribute = (html: string, name: string) =>
    new RegExp(` ${name}="([^"]*)"`).exec(html)?.[1] ?? null;

  it("hands its value to assistive technology", () => {
    const html = render(<Progress value={42} aria-label="Upload" />);
    expect(attribute(html, "role")).toBe("progressbar");
    expect(attribute(html, "aria-valuenow")).toBe("42");
    expect(attribute(html, "aria-valuemin")).toBe("0");
    expect(attribute(html, "aria-valuemax")).toBe("100");
    expect(attribute(html, "aria-label")).toBe("Upload");
    expect(attribute(html, "data-state")).toBe("loading");
    expect(html).toContain("translateX(-58%)");
  });

  it("announces zero and a finished bar as numbers, not as unknown", () => {
    const empty = render(<Progress value={0} aria-label="Upload" />);
    expect(attribute(empty, "aria-valuenow")).toBe("0");
    expect(empty).toContain("translateX(-100%)");
    const done = render(<Progress value={100} aria-label="Upload" />);
    expect(attribute(done, "aria-valuenow")).toBe("100");
    expect(attribute(done, "data-state")).toBe("complete");
  });

  it("clamps a value outside the range instead of turning indeterminate", () => {
    expect(attribute(render(<Progress value={140} aria-label="x" />), "aria-valuenow")).toBe("100");
    expect(attribute(render(<Progress value={-5} aria-label="x" />), "aria-valuenow")).toBe("0");
  });

  it("carries no number while the amount of work is unknown", () => {
    for (const node of [
      <Progress key="none" aria-label="x" />,
      <Progress key="null" value={null} aria-label="x" />,
      <Progress key="nan" value={Number.NaN} aria-label="x" />,
    ]) {
      const html = render(node);
      expect(attribute(html, "role")).toBe("progressbar");
      expect(attribute(html, "aria-valuenow")).toBeNull();
      expect(attribute(html, "data-state")).toBe("indeterminate");
    }
  });

  it("follows a custom maximum", () => {
    const html = render(<Progress value={5} max={10} aria-label="x" />);
    expect(attribute(html, "aria-valuenow")).toBe("5");
    expect(attribute(html, "aria-valuemax")).toBe("10");
    expect(html).toContain("translateX(-50%)");
  });
});
