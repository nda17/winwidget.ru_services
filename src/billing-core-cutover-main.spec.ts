import {
	assertBillingSnapshotContinuity,
	assertAutoRenewalDeliveryTransfer,
	calculateProjectionLag,
	calculateSourceFingerprint,
	parseBillingCoreCutoverArgs,
	requireBillingSettingsSnapshot,
	serializeBillingOfferSnapshot
} from './billing-core-cutover-main';
import { createHash } from 'node:crypto';

describe('Billing Core cutover CLI contract', () => {
	const revision = 'a'.repeat(40);

	it.each([
		['--file', '/private/tmp/evidence.json'],
		['--evidence-file', '/private/tmp/evidence.json'],
		['--snapshot-file', '/private/tmp/snapshot.json']
	])('accepts the %s atomic output alias', (flag, file) => {
		expect(
			parseBillingCoreCutoverArgs([
				'prepare',
				'--revision',
				revision,
				'--generation',
				'7',
				flag,
				file
			])
		).toEqual({
			action: 'prepare',
			revision,
			generation: 7n,
			file
		});
	});

	it('rejects a non-absolute evidence target', () => {
		expect(() =>
			parseBillingCoreCutoverArgs(['status', '--file', 'evidence.json'])
		).toThrow('Output file must be an absolute path');
	});

	it('fingerprints exactly the parsed document without sourceFingerprint', () => {
		const document = {
			schemaVersion: 1,
			action: 'freeze-export',
			revision,
			generation: '7',
			identity: [{ id: 'user-1', roles: ['ADMIN'] }],
			offer: {
				id: 'offer',
				content: 'offer',
				sha256: createHash('sha256').update('offer').digest('hex'),
				updatedAt: '2026-08-11T00:00:00.000Z',
				consentVersion: 'auto-renewal-2026-07-28-v4',
				consentText: 'terms'
			}
		};
		const expected = createHash('sha256')
			.update(JSON.stringify(document), 'utf8')
			.digest('hex');

		expect(calculateSourceFingerprint(document)).toBe(expected);
	});

	it('requires seeded continuity for every canonical frozen aggregate', () => {
		const versions = [
			['billing.identity', 'user-1'],
			['billing.notification-routing', 'singleton'],
			['billing.settings', 'singleton'],
			['billing.offer', 'offer']
		].map(([aggregateType, aggregateId], index) => ({
			aggregateType,
			aggregateId,
			version: 1n,
			sourceSequence: BigInt(index + 1)
		}));

		expect(() =>
			assertBillingSnapshotContinuity({
				versions,
				reportingVersions: [
					{
						aggregateType: 'billing.payment',
						aggregateId: 'payment-1',
						version: 1n,
						sourceSequence: 5n
					},
					{
						aggregateType: 'billing.subscription',
						aggregateId: 'subscription-1',
						version: 1n,
						sourceSequence: 6n
					}
				],
				identityIds: ['user-1'],
				notificationRoutingIds: ['singleton'],
				settingsIds: ['singleton'],
				paymentIds: ['payment-1'],
				subscriptionIds: ['subscription-1'],
				offerRequired: true
			})
		).not.toThrow();
		expect(() =>
			assertBillingSnapshotContinuity({
				versions: versions.filter(
					item => item.aggregateType !== 'billing.offer'
				),
				reportingVersions: [],
				identityIds: ['user-1'],
				notificationRoutingIds: ['singleton'],
				settingsIds: ['singleton'],
				paymentIds: [],
				subscriptionIds: [],
				offerRequired: true
			})
		).toThrow(
			'Billing snapshot continuity is missing for billing.offer/offer'
		);
	});

	it('requires reporting continuity for every frozen payment and subscription', () => {
		expect(() =>
			assertBillingSnapshotContinuity({
				versions: [],
				reportingVersions: [
					{
						aggregateType: 'billing.payment',
						aggregateId: 'payment-1',
						version: 1n,
						sourceSequence: 1n
					}
				],
				identityIds: [],
				notificationRoutingIds: [],
				settingsIds: [],
				paymentIds: ['payment-1'],
				subscriptionIds: ['subscription-1'],
				offerRequired: false
			})
		).toThrow(
			'Billing snapshot continuity is missing for billing.subscription/subscription-1'
		);
	});

	it('rejects active or non-UUID auto-renewal delivery transfer rows', () => {
		const failure = {
			id: '11111111-1111-4111-8111-111111111111',
			eventId: '22222222-2222-4222-8222-222222222222',
			integration: 'auto-renewal',
			retryingAt: null,
			activeRetryToken: null
		};
		const receipt = {
			id: '33333333-3333-4333-8333-333333333333',
			eventId: failure.eventId,
			integration: 'auto-renewal',
			status: 'DELIVERED'
		};

		expect(() =>
			assertAutoRenewalDeliveryTransfer([failure], [receipt])
		).not.toThrow();
		expect(() =>
			assertAutoRenewalDeliveryTransfer(
				[{ ...failure, retryingAt: new Date() }],
				[receipt]
			)
		).toThrow('active auto-renewal failure retry');
		expect(() =>
			assertAutoRenewalDeliveryTransfer(
				[failure],
				[{ ...receipt, status: 'PROCESSING' }]
			)
		).toThrow('active auto-renewal receipt lease');
		expect(() =>
			assertAutoRenewalDeliveryTransfer(
				[{ ...failure, id: 'not-a-uuid' }],
				[receipt]
			)
		).toThrow('auto-renewal failures are inconsistent');
	});

	it('requires a concrete offer and preserves its exact hash', () => {
		const updatedAt = new Date('2026-08-11T00:00:00.000Z');
		expect(() => serializeBillingOfferSnapshot(null)).toThrow(
			'Billing offer snapshot is missing'
		);
		expect(
			serializeBillingOfferSnapshot({ content: 'offer', updatedAt })
		).toEqual(
			expect.objectContaining({
				id: 'offer',
				content: 'offer',
				sha256: createHash('sha256').update('offer').digest('hex'),
				updatedAt
			})
		);
	});

	it('requires the canonical settings singleton', () => {
		expect(() => requireBillingSettingsSnapshot(null)).toThrow(
			'Billing settings snapshot is missing'
		);
		expect(requireBillingSettingsSnapshot({ id: 'singleton' })).toEqual({
			id: 'singleton'
		});
	});

	it('keeps every projection lag term in the bigint domain', async () => {
		const row = {
			legacyPayments: 0n,
			projectedPayments: 0n,
			paymentIdLag: 0n,
			paymentVersionLag: 0n,
			legacySubscriptions: 0n,
			projectedSubscriptions: 0n,
			subscriptionIdLag: 0n,
			subscriptionVersionLag: 0n,
			legacyAffiliates: 0n,
			projectedAffiliates: 0n,
			affiliateIdLag: 0n,
			affiliateVersionLag: 0n,
			legacySettings: 1n,
			projectedSettings: 1n,
			settingsIdLag: 0n,
			settingsVersionLag: 0n
		};
		const transaction = {
			$queryRaw: jest.fn().mockResolvedValue([row])
		};

		await expect(
			calculateProjectionLag(transaction as never)
		).resolves.toEqual({ total: 0n, row });
		const query = transaction.$queryRaw.mock.calls[0][0];
		expect(query.strings.join('')).toContain('THEN 0::BIGINT');
		expect(query.strings.join('')).toContain('ELSE 1::BIGINT');
	});
});
