ALTER TABLE "countdown_timer_leads"
ADD COLUMN "timer_reset_token" TEXT NOT NULL DEFAULT '';

CREATE INDEX "countdown_timer_leads_countdown_timer_id_timer_reset_token_idx"
ON "countdown_timer_leads"("countdown_timer_id", "timer_reset_token");

CREATE INDEX "countdown_timer_leads_countdown_timer_id_timer_reset_token_ip_idx"
ON "countdown_timer_leads"("countdown_timer_id", "timer_reset_token", "ip");
