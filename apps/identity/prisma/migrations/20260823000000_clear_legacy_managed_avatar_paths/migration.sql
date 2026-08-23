CREATE TYPE "identity"."AvatarMediaObjectStatus" AS ENUM (
    'PREPARED',
    'ACTIVE',
    'DELETE_PENDING',
    'DELETING'
);

CREATE TABLE "identity"."avatar_media_objects" (
    "id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "object_key" VARCHAR(500) NOT NULL,
    "public_url" VARCHAR(2000) NOT NULL,
    "status" "identity"."AvatarMediaObjectStatus" NOT NULL DEFAULT 'PREPARED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "delete_passes" INTEGER NOT NULL DEFAULT 0,
    "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_token" UUID,
    "lease_expires_at" TIMESTAMP(3),
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "avatar_media_objects_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "avatar_media_objects_object_key_key"
ON "identity"."avatar_media_objects"("object_key");

CREATE UNIQUE INDEX "avatar_media_objects_public_url_key"
ON "identity"."avatar_media_objects"("public_url");

CREATE INDEX "avatar_media_objects_status_available_at_created_at_idx"
ON "identity"."avatar_media_objects"("status", "available_at", "created_at");

CREATE INDEX "avatar_media_objects_status_lease_expires_at_idx"
ON "identity"."avatar_media_objects"("status", "lease_expires_at");

CREATE INDEX "avatar_media_objects_user_id_status_idx"
ON "identity"."avatar_media_objects"("user_id", "status");

-- Core generated avatar names as `<epoch-ms>-<8 base36 chars>.<extension>`
-- under `user-avatar`. Preserve OAuth/provider URLs and every unrelated path.
UPDATE "identity"."users"
SET "avatar_path" = NULL,
    "updated_at" = CURRENT_TIMESTAMP
WHERE "avatar_path" ~ '^/uploads/user-avatar/[0-9]{13}-[a-z0-9]{8}\.[A-Za-z0-9]+$'
   OR "avatar_path" ~ '^https?://[^?#]+/user-avatar/[0-9]{13}-[a-z0-9]{8}\.[A-Za-z0-9]+(?:[?#].*)?$';
