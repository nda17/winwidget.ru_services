-- CreateTable
CREATE TABLE "tariff_prices" (
    "id" TEXT NOT NULL,
    "plan" "Plan" NOT NULL,
    "billing_period" "BillingPeriod" NOT NULL,
    "amount" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tariff_prices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tariff_prices_plan_billing_period_key" ON "tariff_prices"("plan", "billing_period");

-- Seed current paid tariff prices.
INSERT INTO "tariff_prices" ("id", "plan", "billing_period", "amount", "created_at", "updated_at")
VALUES
    ('easy_monthly', 'EASY', 'MONTHLY', 990, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('easy_yearly', 'EASY', 'YEARLY', 4680, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('hard_monthly', 'HARD', 'MONTHLY', 1690, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('hard_yearly', 'HARD', 'YEARLY', 9480, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("plan", "billing_period") DO NOTHING;
