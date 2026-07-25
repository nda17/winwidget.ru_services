-- PostgreSQL requires newly added enum values to be committed before another
-- migration can use them in constraints or data changes.
ALTER TYPE "IntegrationDeliveryReceiptStatus"
	ADD VALUE IF NOT EXISTS 'RETRY_SCHEDULED';
ALTER TYPE "IntegrationDeliveryReceiptStatus"
	ADD VALUE IF NOT EXISTS 'DEAD_LETTERED';
ALTER TYPE "IntegrationDeliveryReceiptStatus"
	ADD VALUE IF NOT EXISTS 'CLOSED_NO_RETRY';
