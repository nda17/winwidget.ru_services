-- CreateTable
CREATE TABLE "callbacks" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "public_key" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'Обратный звонок',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "config" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "callbacks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "callback_leads" (
    "id" TEXT NOT NULL,
    "callback_id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "time_slot" TEXT NOT NULL DEFAULT '',
    "timezone" TEXT NOT NULL DEFAULT '',
    "url" TEXT,
    "ip" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "callback_leads_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "callbacks_public_key_key" ON "callbacks"("public_key");
CREATE INDEX "callbacks_user_id_idx" ON "callbacks"("user_id");
CREATE INDEX "callback_leads_callback_id_idx" ON "callback_leads"("callback_id");
CREATE INDEX "callback_leads_callback_id_ip_idx" ON "callback_leads"("callback_id", "ip");

-- AddForeignKey
ALTER TABLE "callbacks" ADD CONSTRAINT "callbacks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "callback_leads" ADD CONSTRAINT "callback_leads_callback_id_fkey" FOREIGN KEY ("callback_id") REFERENCES "callbacks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
