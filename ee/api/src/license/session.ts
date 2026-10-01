import type { SessionFieldContribution } from "../../../../apps/api/src/extensions.js";
import { currentEdition } from "./gate.js";

/**
 * `extensions.edition` of `GET /api/v1/me`: the edition in effect, which the
 * web modules of ee/ read to unlock their menu entries and pages
 * (ee/web/src/license). Read per request like every other gate.
 */
export const editionSessionField: SessionFieldContribution = {
  key: "edition",
  load: ({ db }) => currentEdition(db),
};
