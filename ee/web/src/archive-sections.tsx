import { JournalSection } from "./journal/journal-section";
import { LegalHoldsSection } from "./legal-holds/legal-holds-section";

/**
 * The Business sections of the archive page. The core's slot
 * `archive.sections` renders one component, so the modules that contribute to
 * it are composed here; each section decides by itself whether the edition
 * and the signed-in user see it.
 */
export function ArchiveSections() {
  return (
    <>
      <JournalSection />
      <LegalHoldsSection />
    </>
  );
}
