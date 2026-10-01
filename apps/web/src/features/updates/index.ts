/**
 * Updates feature. Not a navigation item: the Updates tab is a section of the
 * settings page (`updates-section.tsx`), and the maintenance shell below is
 * mounted once in the app shell for every signed-in user.
 */
import "./i18n";

export { MaintenanceBanner } from "./maintenance/maintenance-banner";
export { MaintenanceModal, ShellMaintenanceModal } from "./maintenance/maintenance-modal";
export { MaintenanceProvider } from "./maintenance/use-maintenance";
export { UpdatesSection } from "./updates-section";
