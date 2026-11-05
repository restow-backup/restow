-- 0.5.0: the archive's deletion run pages the items whose retention ended in (retention_until,
-- id) order, batch by batch, instead of loading every due item of a tenant at once (with the
-- default end_of_year policy a whole capture year falls due on the same 1 January). This index
-- makes each page a range scan. Nothing existing is rewritten.
--> statement-breakpoint
CREATE INDEX "archive_items_tenant_retention_idx" ON "archive_items" USING btree ("tenant_id","retention_until","id");