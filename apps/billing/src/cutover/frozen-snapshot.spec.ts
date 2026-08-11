import { createHash } from 'node:crypto';
import {
	AUTO_RENEWAL_CONSENT_TEXT,
	AUTO_RENEWAL_CONSENT_VERSION
} from '../domain/billing-legal.constants';
import {
	computeSnapshotFingerprint,
	parseFrozenBillingSnapshot
} from './frozen-snapshot';

describe('frozen Billing snapshot contract', () => {
	const revision = 'a'.repeat(40);
	const timestamp = '2026-08-11T00:00:00.000Z';

	const snapshot = () => {
		const content = '<section>Billing offer</section>';
		const value: Record<string, unknown> = {
			schemaVersion: 1,
			action: 'freeze-export',
			revision,
			generation: '1',
			frozenAt: timestamp,
			sourceCutoff: timestamp,
			sourceFingerprint: '',
			coreState: {
				id: 'singleton',
				ownership: 'CORE',
				sourceProducersEnabled: false,
				legacyRoutesEnabled: true,
				schedulerEnabled: false,
				legacyConsumerEnabled: false,
				projectionConsumerEnabled: true,
				generation: '1',
				preparedRevision: revision,
				ownershipRevision: null,
				activatedAt: null,
				updatedAt: timestamp
			},
			continuity: {
				reportingHighWater: '0',
				billingHighWater: '2',
				maxHighWater: '2',
				nextSourceSequence: '3',
				entityCounts: {
					identity: 0,
					notificationRouting: 0,
					settings: 1,
					offer: 1,
					payments: 0,
					paymentReceipts: 0,
					subscriptions: 0,
					subscriptionHistory: 0,
					subscriptionExpiryReminders: 0,
					autoRenewals: 0,
					autoRenewalConsentEvents: 0,
					tariffPrices: 0,
					affiliateReferrals: 0,
					integrationDeliveryFailures: 0,
					integrationDeliveryReceipts: 0
				},
				reportingAggregateVersions: [],
				billingAggregateVersions: [
					{
						aggregateType: 'billing.settings',
						aggregateId: 'singleton',
						aggregateVersion: '1',
						lastSourceSequence: '1'
					},
					{
						aggregateType: 'billing.offer',
						aggregateId: 'offer',
						aggregateVersion: '1',
						lastSourceSequence: '2'
					}
				]
			},
			identity: [],
			notificationRouting: [],
			settings: {
				id: 'singleton',
				paymentEnabled: true,
				autoRenewalSignupEnabled: true,
				autoRenewalChargesEnabled: false,
				autoRenewalChargesEnabledAt: timestamp,
				affiliateProgramEnabled: true,
				affiliateCashbackPercent: 10,
				updatedAt: timestamp
			},
			offer: {
				id: 'offer',
				content,
				sha256: createHash('sha256').update(content).digest('hex'),
				updatedAt: timestamp,
				consentVersion: AUTO_RENEWAL_CONSENT_VERSION,
				consentText: AUTO_RENEWAL_CONSENT_TEXT
			},
			payments: [],
			paymentReceipts: [],
			subscriptions: [],
			subscriptionHistory: [],
			subscriptionExpiryReminders: [],
			autoRenewals: [],
			autoRenewalConsentEvents: [],
			tariffPrices: [],
			affiliateReferrals: [],
			integrationDeliveryFailures: [],
			integrationDeliveryReceipts: []
		};
		value.sourceFingerprint = computeSnapshotFingerprint(value);
		return value;
	};

	it('accepts the exact frozen, forward-only Core state', () => {
		const value = snapshot();

		expect(parseFrozenBillingSnapshot(JSON.stringify(value))).toEqual(
			value
		);
	});

	it('rejects unknown top-level fields even with a recomputed fingerprint', () => {
		const value = snapshot();
		value.unreviewedPayload = { secret: true };
		value.sourceFingerprint = computeSnapshotFingerprint(value);

		expect(() =>
			parseFrozenBillingSnapshot(JSON.stringify(value))
		).toThrow('SNAPSHOT_CONTRACT_INVALID');
	});

	it('rejects a snapshot taken before all legacy writers were fenced', () => {
		const value = snapshot();
		(value.coreState as Record<string, unknown>).schedulerEnabled = true;
		value.sourceFingerprint = computeSnapshotFingerprint(value);

		expect(() =>
			parseFrozenBillingSnapshot(JSON.stringify(value))
		).toThrow('SNAPSHOT_CORE_STATE_INVALID');
	});

	it('rejects duplicate or zero continuity rows', () => {
		const duplicate = snapshot();
		const continuity = duplicate.continuity as Record<string, unknown>;
		continuity.reportingAggregateVersions = [
			{
				aggregateType: 'billing.settings',
				aggregateId: 'singleton',
				aggregateVersion: '1',
				lastSourceSequence: '0'
			}
		];
		duplicate.sourceFingerprint = computeSnapshotFingerprint(duplicate);

		expect(() =>
			parseFrozenBillingSnapshot(JSON.stringify(duplicate))
		).toThrow(/SNAPSHOT_REPORTING_CONTINUITY_INVALID/);
	});

	it('rejects any fingerprint mismatch', () => {
		const value = snapshot();
		(value.settings as Record<string, unknown>).paymentEnabled = false;

		expect(() =>
			parseFrozenBillingSnapshot(JSON.stringify(value))
		).toThrow('SNAPSHOT_FINGERPRINT_MISMATCH');
	});
});
