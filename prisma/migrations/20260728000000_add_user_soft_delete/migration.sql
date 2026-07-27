-- Nullable and without a default so existing users remain active without a
-- table-wide data backfill.
ALTER TABLE "User"
	ADD COLUMN "deleted_at" TIMESTAMP(3);

CREATE INDEX "User_deleted_at_idx"
	ON "User"("deleted_at");
