CREATE TABLE "calculators" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "public_key" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'Калькулятор',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "install_domain" TEXT NOT NULL DEFAULT '',
    "config" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "calculators_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "calculator_leads" (
    "id" TEXT NOT NULL,
    "calculator_id" TEXT NOT NULL,
    "contact" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "answers" JSONB NOT NULL DEFAULT '[]',
    "calculated_price" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'RUB',
    "url" TEXT,
    "ip" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "calculator_leads_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "calculators_public_key_key" ON "calculators"("public_key");
CREATE INDEX "calculators_user_id_idx" ON "calculators"("user_id");
CREATE INDEX "calculator_leads_calculator_id_idx" ON "calculator_leads"("calculator_id");
CREATE INDEX "calculator_leads_calculator_id_ip_idx" ON "calculator_leads"("calculator_id", "ip");

ALTER TABLE "calculators" ADD CONSTRAINT "calculators_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "calculator_leads" ADD CONSTRAINT "calculator_leads_calculator_id_fkey" FOREIGN KEY ("calculator_id") REFERENCES "calculators"("id") ON DELETE CASCADE ON UPDATE CASCADE;
