-- CreateEnum
CREATE TYPE "AuthIdentityType" AS ENUM ('EMAIL', 'PHONE', 'GOOGLE', 'GITHUB');

-- CreateTable
CREATE TABLE "auth_identities" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "type" "AuthIdentityType" NOT NULL,
    "value" TEXT NOT NULL,
    "verified_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "auth_identities_pkey" PRIMARY KEY ("id")
);

-- Backfill email identities from existing users
INSERT INTO "auth_identities" (
    "id",
    "user_id",
    "type",
    "value",
    "verified_at",
    "created_at",
    "updated_at"
)
SELECT
    CONCAT("id", '_email'),
    "id",
    'EMAIL'::"AuthIdentityType",
    "email",
    "created_at",
    "created_at",
    "updated_at"
FROM "User"
WHERE "email" IS NOT NULL
  AND LENGTH(TRIM("email")) > 0;

-- Backfill phone identities from existing users
INSERT INTO "auth_identities" (
    "id",
    "user_id",
    "type",
    "value",
    "verified_at",
    "created_at",
    "updated_at"
)
SELECT
    CONCAT("id", '_phone'),
    "id",
    'PHONE'::"AuthIdentityType",
    "phone",
    CASE
        WHEN "is_phone_verified" THEN "updated_at"
        ELSE NULL
    END,
    "created_at",
    "updated_at"
FROM "User"
WHERE "phone" IS NOT NULL
  AND LENGTH(TRIM("phone")) > 0;

-- CreateIndex
CREATE UNIQUE INDEX "auth_identities_type_value_key" ON "auth_identities"("type", "value");

-- CreateIndex
CREATE UNIQUE INDEX "auth_identities_user_id_type_key" ON "auth_identities"("user_id", "type");

-- CreateIndex
CREATE INDEX "auth_identities_user_id_idx" ON "auth_identities"("user_id");

-- AddForeignKey
ALTER TABLE "auth_identities"
ADD CONSTRAINT "auth_identities_user_id_fkey"
FOREIGN KEY ("user_id")
REFERENCES "User"("id")
ON DELETE CASCADE
ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "User"
DROP COLUMN "email",
DROP COLUMN "phone",
DROP COLUMN "is_phone_verified";
