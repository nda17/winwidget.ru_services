-- CreateEnum
CREATE TYPE "VerificationChallengeType" AS ENUM ('EMAIL', 'PHONE');

-- CreateEnum
CREATE TYPE "VerificationChallengePurpose" AS ENUM ('REGISTER', 'BIND_IDENTITY');

-- CreateTable
CREATE TABLE "verification_challenges" (
    "id" TEXT NOT NULL,
    "user_id" TEXT,
    "type" "VerificationChallengeType" NOT NULL,
    "purpose" "VerificationChallengePurpose" NOT NULL,
    "value" TEXT NOT NULL,
    "password_hash" TEXT,
    "code_hash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "last_sent_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "verification_challenges_pkey" PRIMARY KEY ("id")
);

-- Backfill email registration challenges
INSERT INTO "verification_challenges" (
    "id",
    "user_id",
    "type",
    "purpose",
    "value",
    "password_hash",
    "code_hash",
    "attempts",
    "expires_at",
    "last_sent_at",
    "created_at",
    "updated_at"
)
SELECT
    "id",
    NULL,
    'EMAIL'::"VerificationChallengeType",
    'REGISTER'::"VerificationChallengePurpose",
    "email",
    "password_hash",
    "code_hash",
    "attempts",
    "expires_at",
    "last_sent_at",
    "created_at",
    "updated_at"
FROM "pending_email_registrations";

-- Backfill phone registration challenges
INSERT INTO "verification_challenges" (
    "id",
    "user_id",
    "type",
    "purpose",
    "value",
    "password_hash",
    "code_hash",
    "attempts",
    "expires_at",
    "last_sent_at",
    "created_at",
    "updated_at"
)
SELECT
    md5("phone" || '_' || "purpose"::text),
    NULL,
    'PHONE'::"VerificationChallengeType",
    'REGISTER'::"VerificationChallengePurpose",
    "phone",
    NULL,
    "code_hash",
    "attempts",
    "expires_at",
    "updated_at",
    "created_at",
    "updated_at"
FROM "phone_verification_codes";

-- Backfill identity binding challenges
INSERT INTO "verification_challenges" (
    "id",
    "user_id",
    "type",
    "purpose",
    "value",
    "password_hash",
    "code_hash",
    "attempts",
    "expires_at",
    "last_sent_at",
    "created_at",
    "updated_at"
)
SELECT
    "id",
    "user_id",
    CASE
        WHEN "type" = 'EMAIL'::"AuthIdentityType" THEN 'EMAIL'::"VerificationChallengeType"
        ELSE 'PHONE'::"VerificationChallengeType"
    END,
    'BIND_IDENTITY'::"VerificationChallengePurpose",
    "value",
    NULL,
    "code_hash",
    "attempts",
    "expires_at",
    "last_sent_at",
    "created_at",
    "updated_at"
FROM "pending_user_identity_bindings";

-- CreateIndex
CREATE UNIQUE INDEX "verification_challenges_user_id_type_purpose_key" ON "verification_challenges"("user_id", "type", "purpose");

-- CreateIndex
CREATE UNIQUE INDEX "verification_challenges_type_purpose_value_key" ON "verification_challenges"("type", "purpose", "value");

-- CreateIndex
CREATE INDEX "verification_challenges_expires_at_idx" ON "verification_challenges"("expires_at");

-- AddForeignKey
ALTER TABLE "verification_challenges"
ADD CONSTRAINT "verification_challenges_user_id_fkey"
FOREIGN KEY ("user_id")
REFERENCES "User"("id")
ON DELETE CASCADE
ON UPDATE CASCADE;

-- DropTable
DROP TABLE "pending_user_identity_bindings";

-- DropTable
DROP TABLE "phone_verification_codes";

-- DropTable
DROP TABLE "pending_email_registrations";

-- DropEnum
DROP TYPE "PhoneVerificationPurpose";
