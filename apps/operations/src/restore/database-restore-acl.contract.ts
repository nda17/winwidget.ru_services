import { DatabaseRestoreTarget } from './database-restore.contract';

export interface DatabaseRestoreAclContract {
	profile: 'standard' | 'platform' | 'widgets';
	routines: readonly string[];
	runtimeRoutines: readonly string[];
}

const STANDARD = (
	routines: readonly string[] = []
): DatabaseRestoreAclContract => ({
	profile: 'standard',
	routines,
	runtimeRoutines: []
});

export const DATABASE_RESTORE_ACL_CONTRACTS: Record<
	DatabaseRestoreTarget,
	DatabaseRestoreAclContract
> = {
	'notification-delivery': STANDARD(),
	campaigns: STANDARD(),
	reporting: STANDARD(['reject_report_run_snapshot_mutation()']),
	widgets: {
		profile: 'widgets',
		routines: [
			'enforce_ai_consent_receipt_immutability()',
			'guard_wincrm_connector_update()',
			'reject_wincrm_evidence_mutation()'
		],
		runtimeRoutines: []
	},
	identity: STANDARD(),
	platform: {
		profile: 'platform',
		routines: [
			'current_semantic_fingerprint()',
			'enforce_billing_offer_producer_cursor()',
			'enforce_current_semantic_fingerprint()',
			'enforce_service_identity_integrity()',
			'refresh_current_semantic_fingerprint(text)'
		],
		runtimeRoutines: [
			'current_semantic_fingerprint()',
			'refresh_current_semantic_fingerprint(text)'
		]
	},
	support: STANDARD(['enforce_service_identity_integrity()'])
};
