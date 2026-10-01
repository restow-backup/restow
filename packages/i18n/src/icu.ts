import ICU from "i18next-icu";
import { IntlMessageFormat } from "intl-messageformat";

/**
 * The ICU message-format plugin for i18next, identical in browsers and Node.
 *
 * i18next-icu's ESM build default-imports `intl-messageformat`, whose Node
 * entry point is CommonJS. Bundlers pick the package's ESM build, so browsers
 * work; under Node (the API's notifications, vitest) the default import is the
 * module namespace, constructing it throws, and the plugin's error handler
 * returns the raw ICU source ("{count, plural, ...}") instead of the text.
 *
 * This subclass builds its formatters from the named `IntlMessageFormat`
 * export, which resolves the same way everywhere, and keeps the rest of the
 * plugin (options, formats, variable escaping, lookup behaviour) unchanged.
 */

type Formats = ConstructorParameters<typeof IntlMessageFormat>[2];

/** What i18next-icu keeps on the instance after `init` (not part of its typings). */
interface IcuState {
  options: {
    memoize: boolean;
    memoizeFallback: boolean;
    parseLngForICU: (lng: string) => string;
    parseErrorHandler: (error: unknown, key: string, res: string, values: unknown) => string;
  };
  formats?: Formats;
  escapeVariableValues(values: unknown): Record<string, unknown> | undefined;
}

/** The lookup details i18next passes to a format plugin. */
interface LookupInfo {
  resolved?: { res?: unknown };
}

export class PortableIcu extends ICU {
  private readonly formatters = new Map<string, IntlMessageFormat>();

  /** Format `res` (an ICU message) with `values`; called by i18next for every translation. */
  parse(
    res: string,
    values: unknown,
    lng: string,
    ns: string,
    key: string,
    info?: LookupInfo,
  ): string {
    const state = this as unknown as IcuState;
    const cacheKey = `${lng}\u0000${ns}\u0000${key}`;
    try {
      let formatter = state.options.memoize ? this.formatters.get(cacheKey) : undefined;
      if (!formatter) {
        formatter = new IntlMessageFormat(res, state.options.parseLngForICU(lng), state.formats, {
          // Keep <0>...</0> placeholders for react-i18next's <Trans>.
          ignoreTag: true,
        });
        const found = Boolean(info?.resolved?.res);
        if (state.options.memoize && (state.options.memoizeFallback || !info || found)) {
          this.formatters.set(cacheKey, formatter);
        }
      }
      const formatted = formatter.format(state.escapeVariableValues(values));
      return Array.isArray(formatted) ? formatted.join("") : String(formatted);
    } catch (error) {
      return state.options.parseErrorHandler(error, key, res, values);
    }
  }

  clearCache(): void {
    super.clearCache();
    this.formatters.clear();
  }
}
