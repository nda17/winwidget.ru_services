ALTER TYPE "AuthIdentityType" ADD VALUE 'TELEGRAM';
ALTER TYPE "VerificationChallengeType" ADD VALUE 'TELEGRAM';
ALTER TYPE "VerificationChallengePurpose" ADD VALUE 'LOGIN';

ALTER TABLE "verification_challenges"
ADD COLUMN "telegram_user_id" TEXT,
ADD COLUMN "telegram_chat_id" TEXT,
ADD COLUMN "telegram_username" TEXT,
ADD COLUMN "telegram_first_name" TEXT,
ADD COLUMN "telegram_last_name" TEXT;

CREATE INDEX "verification_challenges_telegram_user_id_idx" ON "verification_challenges"("telegram_user_id");
