/**
 * Where Restow's own database listens (docs/DATABASES.md 4.2). The reading of the database URL
 * lives in @restow/core (databases/own-database.ts), so the worker's health checks refuse the
 * same addresses as the API's connection tests.
 */
export {
  databaseUrlTargets,
  type OwnDatabaseTarget,
  OwnDatabaseUnknownError,
} from "@restow/core";
