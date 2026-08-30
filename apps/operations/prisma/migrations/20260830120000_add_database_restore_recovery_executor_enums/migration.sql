BEGIN;

ALTER TYPE "operations"."DatabaseRestoreJobPhase" ADD VALUE IF NOT EXISTS 'FENCING';
ALTER TYPE "operations"."DatabaseRestoreJobPhase" ADD VALUE IF NOT EXISTS 'FENCED';
ALTER TYPE "operations"."DatabaseRestoreJobPhase" ADD VALUE IF NOT EXISTS 'UNFENCING';
ALTER TYPE "operations"."DatabaseRestoreJobPhase" ADD VALUE IF NOT EXISTS 'UNFENCED';

ALTER TYPE "operations"."DatabaseRestoreRecoveryActionStatus" ADD VALUE IF NOT EXISTS 'PROCESSING';
ALTER TYPE "operations"."DatabaseRestoreRecoveryActionStatus" ADD VALUE IF NOT EXISTS 'RESOLVED';
ALTER TYPE "operations"."DatabaseRestoreRecoveryActionStatus" ADD VALUE IF NOT EXISTS 'BLOCKED';

CREATE TYPE "operations"."DatabaseRestoreRecoveryActionPhase" AS ENUM (
    'PREPARING',
    'FENCING',
    'FENCED',
    'MUTATING',
    'VERIFYING',
    'VERIFIED',
    'UNFENCING',
    'RESOLVED'
);

CREATE TYPE "operations"."DatabaseRestoreExecutionOperationType" AS ENUM (
    'RESTORE',
    'RECOVERY',
    'RECONCILIATION'
);

COMMIT;
