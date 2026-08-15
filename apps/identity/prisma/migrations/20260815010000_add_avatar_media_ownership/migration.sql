-- CreateEnum
CREATE TYPE "identity"."AvatarCleanupKind" AS ENUM ('STAGING', 'RETIRED');

-- CreateEnum
CREATE TYPE "identity"."AvatarCleanupStatus" AS ENUM ('PENDING', 'PROCESSING', 'DELIVERED', 'BLOCKED');

-- CreateEnum
CREATE TYPE "identity"."AvatarMediaOwnershipPhase" AS ENUM ('PREPARED', 'ACTIVE');

-- AlterTable
ALTER TABLE "identity"."users"
ADD COLUMN "avatar_object_key" VARCHAR(1024);

-- CreateTable
CREATE TABLE "identity"."avatar_cleanup_jobs" (
    "id" UUID NOT NULL,
    "object_key" VARCHAR(1024) NOT NULL,
    "owner_fingerprint" CHAR(64) NOT NULL,
    "kind" "identity"."AvatarCleanupKind" NOT NULL,
    "status" "identity"."AvatarCleanupStatus" NOT NULL DEFAULT 'PENDING',
    "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_token" UUID,
    "lease_expires_at" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "delivered_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "avatar_cleanup_jobs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "avatar_cleanup_jobs_owner_fingerprint_check"
        CHECK ("owner_fingerprint" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "avatar_cleanup_jobs_object_key_check"
        CHECK (
            char_length("object_key") BETWEEN 1 AND 1024
            AND "object_key" !~ '(^/|//)'
            AND "object_key" !~ '(^|/)\.{1,2}(/|$)'
        ),
    CONSTRAINT "avatar_cleanup_jobs_attempts_check"
        CHECK ("attempts" >= 0),
    CONSTRAINT "avatar_cleanup_jobs_state_check"
        CHECK (
            (
                "status" = 'PENDING'::"identity"."AvatarCleanupStatus"
                AND "lease_token" IS NULL
                AND "lease_expires_at" IS NULL
                AND "delivered_at" IS NULL
            ) OR (
                "status" = 'PROCESSING'::"identity"."AvatarCleanupStatus"
                AND "lease_token" IS NOT NULL
                AND "lease_expires_at" IS NOT NULL
                AND "delivered_at" IS NULL
            ) OR (
                "status" = 'BLOCKED'::"identity"."AvatarCleanupStatus"
                AND "lease_token" IS NULL
                AND "lease_expires_at" IS NULL
                AND "delivered_at" IS NULL
                AND char_length("last_error") > 0
            ) OR (
                "status" = 'DELIVERED'::"identity"."AvatarCleanupStatus"
                AND "lease_token" IS NULL
                AND "lease_expires_at" IS NULL
                AND "delivered_at" IS NOT NULL
                AND "last_error" IS NULL
            )
        )
);

-- CreateTable
CREATE TABLE "identity"."avatar_media_ownership" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "phase" "identity"."AvatarMediaOwnershipPhase" NOT NULL DEFAULT 'PREPARED',
    "activated_revision" VARCHAR(64),
    "inventory_sha256" CHAR(64),
    "status_sha256" CHAR(64),
    "activated_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "avatar_media_ownership_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "avatar_media_ownership_singleton_check"
        CHECK ("id" = 'singleton'),
    CONSTRAINT "avatar_media_ownership_state_check"
        CHECK (
            (
                "phase" = 'PREPARED'::"identity"."AvatarMediaOwnershipPhase"
                AND "activated_revision" IS NULL
                AND "inventory_sha256" IS NULL
                AND "status_sha256" IS NULL
                AND "activated_at" IS NULL
            ) OR (
                "phase" = 'ACTIVE'::"identity"."AvatarMediaOwnershipPhase"
                AND "activated_revision" ~ '^[0-9a-f]{40}$'
                AND "inventory_sha256" ~ '^[0-9a-f]{64}$'
                AND "status_sha256" ~ '^[0-9a-f]{64}$'
                AND "activated_at" IS NOT NULL
            )
        )
);

-- SeedSingleton
INSERT INTO "identity"."avatar_media_ownership" ("id")
VALUES ('singleton');

-- CreateIndex
CREATE UNIQUE INDEX "users_avatar_object_key_key"
ON "identity"."users"("avatar_object_key");

-- CreateIndex
CREATE UNIQUE INDEX "avatar_cleanup_jobs_object_key_key"
ON "identity"."avatar_cleanup_jobs"("object_key");

-- CreateIndex
CREATE INDEX "avatar_cleanup_jobs_status_available_at_created_at_idx"
ON "identity"."avatar_cleanup_jobs"("status", "available_at", "created_at");

-- CreateIndex
CREATE INDEX "avatar_cleanup_jobs_status_lease_expires_at_idx"
ON "identity"."avatar_cleanup_jobs"("status", "lease_expires_at");

-- CreateIndex
CREATE INDEX "avatar_cleanup_jobs_delivered_at_idx"
ON "identity"."avatar_cleanup_jobs"("delivered_at");
