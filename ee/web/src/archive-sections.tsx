import { JournalHostNote } from "./journal/journal-host-note";
import { JournalSection } from "./journal/journal-section";
import { LegalHoldsSection } from "./legal-holds/legal-holds-section";

/**
 * The Business sections around the archive. The core's slot `archive.sections`
 * (the Archive page) renders one component, the slot `tenant.archiveSettings`
 * (Archive on the tenant page) another, so the modules that contribute to them
 * are composed here; each section decides by itself whether the edition and the
 * signed-in user see it. The journal address is part of the daily archive; legal
 * holds are a setting of the tenant, and the journal host is shown beside them
 * read-only, because the installation sets it.
 */
export function ArchiveSections() {
  return <JournalSection />;
}

export function ArchiveSettingsSections() {
  return (
    <>
      <LegalHoldsSection />
      <JournalHostNote />
    </>
  );
}
