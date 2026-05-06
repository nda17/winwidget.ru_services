CREATE TABLE "quizzes" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "public_key" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'Квиз',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "config" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "quizzes_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "quiz_leads" (
    "id" TEXT NOT NULL,
    "quiz_id" TEXT NOT NULL,
    "contact" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "answers" JSONB NOT NULL DEFAULT '[]',
    "result" TEXT,
    "url" TEXT,
    "ip" TEXT,
    "quiz_reset_token" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quiz_leads_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "quizzes_public_key_key" ON "quizzes"("public_key");
CREATE INDEX "quizzes_user_id_idx" ON "quizzes"("user_id");
CREATE INDEX "quiz_leads_quiz_id_idx" ON "quiz_leads"("quiz_id");
CREATE INDEX "quiz_leads_quiz_id_ip_idx" ON "quiz_leads"("quiz_id", "ip");

ALTER TABLE "quizzes" ADD CONSTRAINT "quizzes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "quiz_leads" ADD CONSTRAINT "quiz_leads_quiz_id_fkey" FOREIGN KEY ("quiz_id") REFERENCES "quizzes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "widgets" ADD COLUMN "install_domain" TEXT NOT NULL DEFAULT '';
ALTER TABLE "quizzes" ADD COLUMN "install_domain" TEXT NOT NULL DEFAULT '';
ALTER TABLE "callbacks" ADD COLUMN "install_domain" TEXT NOT NULL DEFAULT '';
ALTER TABLE "countdown_timers" ADD COLUMN "install_domain" TEXT NOT NULL DEFAULT '';
