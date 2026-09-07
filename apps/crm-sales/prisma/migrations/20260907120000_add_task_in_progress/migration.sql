-- Commit the enum extension before the next migration uses it in constraints.
-- Existing task values and immutable command results are not rewritten.
ALTER TYPE crm_sales."SalesTaskStatus" ADD VALUE 'IN_PROGRESS';
