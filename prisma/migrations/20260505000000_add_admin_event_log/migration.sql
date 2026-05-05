-- CreateTable
CREATE TABLE "admin_event_logs" (
    "id" TEXT NOT NULL,
    "admin_id" TEXT,
    "admin_name" TEXT,
    "admin_email" TEXT,
    "section" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "entity_type" TEXT,
    "entity_id" TEXT,
    "entity_label" TEXT,
    "target_user_id" TEXT,
    "target_user_name" TEXT,
    "target_user_email" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "ip" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_event_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "admin_event_logs_admin_id_idx" ON "admin_event_logs"("admin_id");

-- CreateIndex
CREATE INDEX "admin_event_logs_target_user_id_idx" ON "admin_event_logs"("target_user_id");

-- CreateIndex
CREATE INDEX "admin_event_logs_section_idx" ON "admin_event_logs"("section");

-- CreateIndex
CREATE INDEX "admin_event_logs_action_idx" ON "admin_event_logs"("action");

-- CreateIndex
CREATE INDEX "admin_event_logs_entity_type_entity_id_idx" ON "admin_event_logs"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "admin_event_logs_created_at_idx" ON "admin_event_logs"("created_at");

-- AddForeignKey
ALTER TABLE "admin_event_logs" ADD CONSTRAINT "admin_event_logs_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_event_logs" ADD CONSTRAINT "admin_event_logs_target_user_id_fkey" FOREIGN KEY ("target_user_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
