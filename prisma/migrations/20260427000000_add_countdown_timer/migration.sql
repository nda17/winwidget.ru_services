-- CreateTable
CREATE TABLE "countdown_timers" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "public_key" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'Таймер',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "config" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "countdown_timers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "countdown_timer_leads" (
    "id" TEXT NOT NULL,
    "countdown_timer_id" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "url" TEXT,
    "ip" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "countdown_timer_leads_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "countdown_timers_public_key_key" ON "countdown_timers"("public_key");
CREATE INDEX "countdown_timers_user_id_idx" ON "countdown_timers"("user_id");
CREATE INDEX "countdown_timer_leads_countdown_timer_id_idx" ON "countdown_timer_leads"("countdown_timer_id");
CREATE INDEX "countdown_timer_leads_countdown_timer_id_ip_idx" ON "countdown_timer_leads"("countdown_timer_id", "ip");

-- AddForeignKey
ALTER TABLE "countdown_timers" ADD CONSTRAINT "countdown_timers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "countdown_timer_leads" ADD CONSTRAINT "countdown_timer_leads_countdown_timer_id_fkey" FOREIGN KEY ("countdown_timer_id") REFERENCES "countdown_timers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
