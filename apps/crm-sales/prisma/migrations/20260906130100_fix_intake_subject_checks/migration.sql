BEGIN;

-- PostgreSQL counted regex repetitions stop at 255. Keep the 256-character
-- subject contract explicit and use an unbounded negative character check.
ALTER TABLE crm_sales.intake_operation_slots
  DROP CONSTRAINT intake_operation_slots_actor_subject_check,
  ADD CONSTRAINT intake_operation_slots_actor_subject_check
    CHECK (length(actor_subject) BETWEEN 1 AND 256 AND actor_subject !~ '[[:space:][:cntrl:]]');
ALTER TABLE crm_sales.intake_operation_commands
  DROP CONSTRAINT intake_operation_commands_actor_subject_check,
  ADD CONSTRAINT intake_operation_commands_actor_subject_check
    CHECK (length(actor_subject) BETWEEN 1 AND 256 AND actor_subject !~ '[[:space:][:cntrl:]]');

COMMIT;
