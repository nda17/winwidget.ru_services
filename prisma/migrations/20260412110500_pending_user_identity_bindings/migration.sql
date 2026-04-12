-- CreateTable
CREATE TABLE "pending_user_identity_bindings" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "type" "AuthIdentityType" NOT NULL,
    "value" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "last_sent_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pending_user_identity_bindings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "pending_user_identity_bindings_user_id_type_key" ON "pending_user_identity_bindings"("user_id", "type");

-- CreateIndex
CREATE UNIQUE INDEX "pending_user_identity_bindings_type_value_key" ON "pending_user_identity_bindings"("type", "value");

-- CreateIndex
CREATE INDEX "pending_user_identity_bindings_expires_at_idx" ON "pending_user_identity_bindings"("expires_at");

-- AddForeignKey
ALTER TABLE "pending_user_identity_bindings"
ADD CONSTRAINT "pending_user_identity_bindings_user_id_fkey"
FOREIGN KEY ("user_id")
REFERENCES "User"("id")
ON DELETE CASCADE
ON UPDATE CASCADE;
