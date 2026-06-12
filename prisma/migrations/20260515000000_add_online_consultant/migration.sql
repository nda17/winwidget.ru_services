-- CreateTable
CREATE TABLE "online_consultants" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "public_key" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'Онлайн-консультант',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "install_domain" TEXT NOT NULL DEFAULT '',
    "config" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "online_consultants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "online_consultant_leads" (
    "id" TEXT NOT NULL,
    "online_consultant_id" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "action_label" TEXT NOT NULL DEFAULT '',
    "action_value" TEXT NOT NULL DEFAULT '',
    "url" TEXT,
    "ip" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "online_consultant_leads_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "online_consultants_public_key_key" ON "online_consultants"("public_key");

-- CreateIndex
CREATE INDEX "online_consultants_user_id_idx" ON "online_consultants"("user_id");

-- CreateIndex
CREATE INDEX "online_consultant_leads_online_consultant_id_idx" ON "online_consultant_leads"("online_consultant_id");

-- CreateIndex
CREATE INDEX "online_consultant_leads_online_consultant_id_ip_idx" ON "online_consultant_leads"("online_consultant_id", "ip");

-- AddForeignKey
ALTER TABLE "online_consultants" ADD CONSTRAINT "online_consultants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "online_consultant_leads" ADD CONSTRAINT "online_consultant_leads_online_consultant_id_fkey" FOREIGN KEY ("online_consultant_id") REFERENCES "online_consultants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
