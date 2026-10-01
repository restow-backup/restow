import { useTranslation } from "react-i18next";

/** Id of the main content region every layout renders; the skip link targets it. */
export const MAIN_CONTENT_ID = "main";

/**
 * "Skip to content": the first focusable element of every layout. Hidden
 * until focused, it lets keyboard and screen-reader users jump past the
 * navigation straight to the page.
 */
export function SkipLink() {
  const { t } = useTranslation();
  return (
    <a
      href={`#${MAIN_CONTENT_ID}`}
      data-slot="skip-link"
      // Move focus without a hash in the URL, which the router would record
      // as a navigation.
      onClick={(event) => {
        const main = document.getElementById(MAIN_CONTENT_ID);
        if (main) {
          event.preventDefault();
          main.focus();
        }
      }}
      className="sr-only rounded-md bg-background px-4 py-2 text-sm font-medium text-foreground shadow-md ring-2 ring-ring outline-none focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[100]"
    >
      {t("shell.skipToContent")}
    </a>
  );
}
