ALTER TABLE "widgets" ADD COLUMN "install_domain" TEXT NOT NULL DEFAULT '';
ALTER TABLE "quizzes" ADD COLUMN "install_domain" TEXT NOT NULL DEFAULT '';
ALTER TABLE "callbacks" ADD COLUMN "install_domain" TEXT NOT NULL DEFAULT '';
ALTER TABLE "countdown_timers" ADD COLUMN "install_domain" TEXT NOT NULL DEFAULT '';
