ALTER TYPE "AuthIdentityType" ADD VALUE 'VK';

ALTER TABLE "site_settings"
ADD COLUMN "vk_auth_enabled" BOOLEAN NOT NULL DEFAULT false;
