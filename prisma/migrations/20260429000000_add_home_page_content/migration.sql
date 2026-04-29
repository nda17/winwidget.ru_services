CREATE TABLE "home_page_content" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "content" JSONB NOT NULL DEFAULT '{}',
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "home_page_content_pkey" PRIMARY KEY ("id")
);
