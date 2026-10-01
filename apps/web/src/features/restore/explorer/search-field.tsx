import { Search, X } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const DEBOUNCE_MS = 300;

/**
 * Search within the browsed snapshot. Typing is local and debounced; the
 * committed query lives in the URL so results survive reloads and links.
 */
export function SearchField({
  value,
  onCommit,
  disabled = false,
}: {
  value: string;
  onCommit: (query: string) => void;
  /** No restore point to search within yet. */
  disabled?: boolean;
}) {
  const { t } = useTranslation("restore");
  const [text, setText] = React.useState(value);
  const id = "restore-search";

  // Follow the URL when it changes elsewhere (back/forward, a cleared search).
  React.useEffect(() => {
    setText(value);
  }, [value]);

  React.useEffect(() => {
    if (text === value) {
      return;
    }
    const timer = window.setTimeout(() => onCommit(text), DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [text, value, onCommit]);

  const clear = () => {
    setText("");
    onCommit("");
  };

  return (
    <div className="min-w-0 space-y-1.5">
      <Label htmlFor={id}>{t("explorer.search.label")}</Label>
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          id={id}
          type="search"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && text.length > 0) {
              event.preventDefault();
              clear();
            }
          }}
          placeholder={t("explorer.search.placeholder")}
          className="pl-8 pr-8 [&::-webkit-search-cancel-button]:hidden"
          autoComplete="off"
          maxLength={200}
          disabled={disabled}
        />
        {!disabled && text.length > 0 ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={clear}
            className="absolute right-0.5 top-1/2 size-8 -translate-y-1/2"
            aria-label={t("explorer.search.clear")}
          >
            <X />
          </Button>
        ) : null}
      </div>
    </div>
  );
}
