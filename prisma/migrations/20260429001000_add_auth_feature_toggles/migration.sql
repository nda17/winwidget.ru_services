ALTER TABLE "site_settings"
ADD COLUMN "recaptcha_enabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "google_auth_enabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "yandex_auth_enabled" BOOLEAN NOT NULL DEFAULT true;
