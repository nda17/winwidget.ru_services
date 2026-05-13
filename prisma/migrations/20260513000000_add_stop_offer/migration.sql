CREATE TABLE "stop_offers" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "public_key" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'Стоп-оффер',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "install_domain" TEXT NOT NULL DEFAULT '',
    "config" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stop_offers_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "stop_offer_leads" (
    "id" TEXT NOT NULL,
    "stop_offer_id" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "url" TEXT,
    "ip" TEXT,
    "reset_token" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stop_offer_leads_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "stop_offers_public_key_key" ON "stop_offers"("public_key");
CREATE INDEX "stop_offers_user_id_idx" ON "stop_offers"("user_id");
CREATE INDEX "stop_offer_leads_stop_offer_id_idx" ON "stop_offer_leads"("stop_offer_id");
CREATE INDEX "stop_offer_leads_stop_offer_id_ip_idx" ON "stop_offer_leads"("stop_offer_id", "ip");
CREATE INDEX "stop_offer_leads_stop_offer_id_reset_token_idx" ON "stop_offer_leads"("stop_offer_id", "reset_token");
CREATE INDEX "stop_offer_leads_stop_offer_id_reset_token_ip_idx" ON "stop_offer_leads"("stop_offer_id", "reset_token", "ip");

ALTER TABLE "stop_offers" ADD CONSTRAINT "stop_offers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "stop_offer_leads" ADD CONSTRAINT "stop_offer_leads_stop_offer_id_fkey" FOREIGN KEY ("stop_offer_id") REFERENCES "stop_offers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
