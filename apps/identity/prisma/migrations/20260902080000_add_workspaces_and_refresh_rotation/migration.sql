BEGIN;

CREATE TYPE "identity"."WorkspaceType" AS ENUM ('PERSONAL', 'ORGANIZATION');
CREATE TYPE "identity"."WorkspaceStatus" AS ENUM ('ACTIVE', 'INACTIVE');
CREATE TYPE "identity"."WorkspaceMemberRole" AS ENUM ('OWNER', 'MEMBER');
CREATE TYPE "identity"."WorkspaceMemberStatus" AS ENUM ('ACTIVE', 'INACTIVE');

ALTER TABLE "identity"."user_sessions"
    ADD COLUMN "previous_refresh_token_hash" TEXT,
    ADD COLUMN "refresh_rotated_at" TIMESTAMP(3),
    ADD CONSTRAINT "user_sessions_previous_refresh_pair_check" CHECK (
        ("previous_refresh_token_hash" IS NULL) = ("refresh_rotated_at" IS NULL)
    );

CREATE TABLE "identity"."workspaces" (
    "id" UUID NOT NULL,
    "type" "identity"."WorkspaceType" NOT NULL DEFAULT 'PERSONAL',
    "status" "identity"."WorkspaceStatus" NOT NULL DEFAULT 'ACTIVE',
    "personal_owner_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspaces_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "workspaces_personal_owner_check" CHECK (
        ("type" = 'PERSONAL' AND "personal_owner_user_id" IS NOT NULL)
        OR ("type" = 'ORGANIZATION' AND "personal_owner_user_id" IS NULL)
    )
);

CREATE TABLE "identity"."workspace_members" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" "identity"."WorkspaceMemberRole" NOT NULL DEFAULT 'MEMBER',
    "status" "identity"."WorkspaceMemberStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspace_members_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "workspaces_personal_owner_user_id_key"
    ON "identity"."workspaces"("personal_owner_user_id");
CREATE INDEX "workspaces_status_idx"
    ON "identity"."workspaces"("status");
CREATE UNIQUE INDEX "workspace_members_workspace_id_user_id_key"
    ON "identity"."workspace_members"("workspace_id", "user_id");
CREATE INDEX "workspace_members_user_id_status_idx"
    ON "identity"."workspace_members"("user_id", "status");
CREATE INDEX "workspace_members_workspace_id_status_idx"
    ON "identity"."workspace_members"("workspace_id", "status");

ALTER TABLE "identity"."workspaces"
    ADD CONSTRAINT "workspaces_personal_owner_user_id_fkey"
    FOREIGN KEY ("personal_owner_user_id") REFERENCES "identity"."users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "identity"."workspace_members"
    ADD CONSTRAINT "workspace_members_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "identity"."workspaces"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "identity"."workspace_members"
    ADD CONSTRAINT "workspace_members_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "identity"."users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

WITH inserted_workspaces AS (
    INSERT INTO "identity"."workspaces" (
        "id",
        "type",
        "status",
        "personal_owner_user_id",
        "created_at",
        "updated_at"
    )
    SELECT
        gen_random_uuid(),
        'PERSONAL'::"identity"."WorkspaceType",
        'ACTIVE'::"identity"."WorkspaceStatus",
        "id",
        "created_at",
        CURRENT_TIMESTAMP
    FROM "identity"."users"
    WHERE "status" IN (
        'ACTIVE'::"identity"."UserStatus",
        'DEACTIVATED'::"identity"."UserStatus"
    )
    RETURNING "id", "personal_owner_user_id", "created_at", "updated_at"
)
INSERT INTO "identity"."workspace_members" (
    "id",
    "workspace_id",
    "user_id",
    "role",
    "status",
    "created_at",
    "updated_at"
)
SELECT
    gen_random_uuid(),
    "id",
    "personal_owner_user_id",
    'OWNER'::"identity"."WorkspaceMemberRole",
    'ACTIVE'::"identity"."WorkspaceMemberStatus",
    "created_at",
    "updated_at"
FROM inserted_workspaces;

DO $identity_personal_workspace_backfill$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM "identity"."users" AS users
        LEFT JOIN "identity"."workspaces" AS workspaces
            ON workspaces."personal_owner_user_id" = users."id"
            AND workspaces."type" = 'PERSONAL'
        WHERE users."status" IN ('ACTIVE', 'DEACTIVATED')
        GROUP BY users."id"
        HAVING count(workspaces."id") <> 1
    ) THEN
        RAISE EXCEPTION 'Identity personal workspace backfill is incomplete';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM "identity"."workspaces" AS workspaces
        LEFT JOIN "identity"."workspace_members" AS members
            ON members."workspace_id" = workspaces."id"
            AND members."user_id" = workspaces."personal_owner_user_id"
            AND members."role" = 'OWNER'
            AND members."status" = 'ACTIVE'
        WHERE workspaces."type" = 'PERSONAL'
        GROUP BY workspaces."id"
        HAVING count(members."id") <> 1
    ) THEN
        RAISE EXCEPTION 'Identity personal workspace owner backfill is incomplete';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM "identity"."workspace_members" AS members
        WHERE members."id" = members."workspace_id"
    ) THEN
        RAISE EXCEPTION 'Identity workspace and member IDs must be distinct';
    END IF;
END
$identity_personal_workspace_backfill$;

COMMIT;
