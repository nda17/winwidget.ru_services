-- CreateEnum
CREATE TYPE "AffiliateReferralStatus" AS ENUM ('REGISTERED', 'REWARD_PENDING', 'CANCELLED', 'PAID');

-- AlterTable
ALTER TABLE "site_settings"
ADD COLUMN "affiliate_program_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "affiliate_cashback_percent" INTEGER NOT NULL DEFAULT 10;

-- CreateTable
CREATE TABLE "affiliate_referrals" (
    "id" TEXT NOT NULL,
    "referrer_id" TEXT NOT NULL,
    "referred_user_id" TEXT NOT NULL,
    "first_payment_id" TEXT,
    "status" "AffiliateReferralStatus" NOT NULL DEFAULT 'REGISTERED',
    "payment_amount" INTEGER,
    "cashback_percent" INTEGER,
    "cashback_amount" INTEGER,
    "available_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "paid_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "affiliate_referrals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "affiliate_referrals_referred_user_id_key" ON "affiliate_referrals"("referred_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "affiliate_referrals_first_payment_id_key" ON "affiliate_referrals"("first_payment_id");

-- CreateIndex
CREATE INDEX "affiliate_referrals_referrer_id_idx" ON "affiliate_referrals"("referrer_id");

-- CreateIndex
CREATE INDEX "affiliate_referrals_status_idx" ON "affiliate_referrals"("status");

-- CreateIndex
CREATE INDEX "affiliate_referrals_available_at_idx" ON "affiliate_referrals"("available_at");

-- AddForeignKey
ALTER TABLE "affiliate_referrals" ADD CONSTRAINT "affiliate_referrals_referrer_id_fkey" FOREIGN KEY ("referrer_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "affiliate_referrals" ADD CONSTRAINT "affiliate_referrals_referred_user_id_fkey" FOREIGN KEY ("referred_user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "affiliate_referrals" ADD CONSTRAINT "affiliate_referrals_first_payment_id_fkey" FOREIGN KEY ("first_payment_id") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
