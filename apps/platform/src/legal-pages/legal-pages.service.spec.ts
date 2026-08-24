import { ServiceUnavailableException } from '@nestjs/common';
import type { BillingOfferProducerState } from '@prisma/platform-client';
import * as continuity from '../domain/billing-offer-continuity';
import { PlatformLegalPagesService } from './legal-pages.service';

const actor = {
	active: true as const,
	subject: 'admin-1',
	sessionId: 'session-1',
	roles: ['ADMIN' as const]
};

const activeProducer = (): BillingOfferProducerState => ({
	id: 'offer',
	phase: 'ACTIVE' as const,
	producerContractVersion: 2,
	sourceSequenceScope: 'billing.offer:offer',
	importedAggregateVersion: 41n,
	importedSourceSequence: 870n,
	currentAggregateVersion: 41n,
	currentSourceSequence: 870n,
	sourceFenceFingerprint: 'a'.repeat(64),
	importedAt: new Date('2026-08-23T10:00:00.000Z'),
	activatedAt: new Date('2026-08-23T10:01:00.000Z'),
	createdAt: new Date('2026-08-23T10:00:00.000Z'),
	updatedAt: new Date('2026-08-23T10:01:00.000Z')
});

function transaction(producer = activeProducer(), advancedCount = 1) {
	const page = {
		slug: 'oferta',
		content: '<p>sanitized offer</p>',
		aggregateVersion: 9n,
		sourceSequence: 17n,
		createdAt: new Date('2026-08-23T09:00:00.000Z'),
		updatedAt: new Date('2026-08-23T12:00:00.000Z')
	};
	return {
		$queryRaw: jest
			.fn()
			.mockResolvedValue([{ fingerprint: 'a'.repeat(64) }]),
		billingOfferProducerState: {
			findUnique: jest.fn().mockResolvedValue(producer),
			updateMany: jest.fn().mockResolvedValue({ count: advancedCount })
		},
		platformSourceSequence: {
			upsert: jest.fn().mockResolvedValue({ nextValue: 18n })
		},
		legalPage: { upsert: jest.fn().mockResolvedValue(page) },
		outboxEvent: { create: jest.fn().mockResolvedValue({}) }
	};
}

function service(tx: ReturnType<typeof transaction>) {
	const prisma = {
		$transaction: jest
			.fn()
			.mockImplementation((work: (value: unknown) => unknown) => work(tx))
	};
	return { value: new PlatformLegalPagesService(prisma as never), prisma };
}

describe('PlatformLegalPagesService offer continuity', () => {
	beforeEach(() => {
		jest
			.spyOn(continuity, 'isAutoRenewalOfferCompatible')
			.mockReturnValue(true);
		jest
			.spyOn(continuity, 'buildBillingOfferChangedEvent')
			.mockImplementation(({ content, updatedAt, cursor }) => ({
				schemaVersion: 2,
				eventType: 'billing.offer.changed.v2',
				eventId: '11111111-1111-4111-8111-111111111111',
				aggregateId: 'offer',
				aggregateVersion: cursor.aggregateVersion.toString(),
				sourceSequenceContractVersion: 2,
				sourceSequenceScope: 'billing.offer:offer',
				sourceSequence: cursor.sourceSequence.toString(),
				occurredAt: updatedAt.toISOString(),
				tombstone: false,
				state: {
					id: 'offer',
					content,
					sha256: 'b'.repeat(64),
					updatedAt: updatedAt.toISOString(),
					consentVersion: continuity.AUTO_RENEWAL_CONSENT_VERSION,
					consentText: continuity.AUTO_RENEWAL_CONSENT_TEXT
				}
			}));
	});

	afterEach(() => jest.restoreAllMocks());

	it('rejects BLOCKED before any legal-page, sequence or Outbox write', async () => {
		const tx = transaction({
			...activeProducer(),
			phase: 'BLOCKED',
			activatedAt: null
		});
		const current = service(tx);

		await expect(
			current.value.update(
				'oferta',
				{ content: '<p>offer</p>' },
				{ actor }
			)
		).rejects.toBeInstanceOf(ServiceUnavailableException);
		expect(tx.platformSourceSequence.upsert).not.toHaveBeenCalled();
		expect(tx.legalPage.upsert).not.toHaveBeenCalled();
		expect(tx.outboxEvent.create).not.toHaveBeenCalled();
	});

	it('atomically advances only the scoped offer cursor and enqueues v2', async () => {
		const tx = transaction();
		const current = service(tx);

		await current.value.update(
			'oferta',
			{ content: '<p>offer</p>' },
			{ actor }
		);

		expect(tx.billingOfferProducerState.updateMany).toHaveBeenCalledWith({
			where: expect.objectContaining({
				id: 'offer',
				phase: 'ACTIVE',
				producerContractVersion: 2,
				sourceSequenceScope: 'billing.offer:offer',
				currentAggregateVersion: 41n,
				currentSourceSequence: 870n,
				sourceFenceFingerprint: 'a'.repeat(64)
			}),
			data: {
				currentAggregateVersion: 42n,
				currentSourceSequence: 871n
			}
		});
		expect(tx.outboxEvent.create).toHaveBeenNthCalledWith(1, {
			data: expect.objectContaining({
				eventId: '11111111-1111-4111-8111-111111111111',
				messageId: '11111111-1111-4111-8111-111111111111',
				deduplicationKey:
					'billing.offer.changed.v2:billing.offer:offer:42',
				eventType: 'billing.offer.changed.v2',
				aggregateType: 'billing.offer',
				aggregateId: 'offer',
				aggregateVersion: 42n,
				sourceSequence: 871n,
				routingKey: 'billing.offer.changed.v2',
				payload: expect.objectContaining({
					aggregateVersion: '42',
					sourceSequence: '871',
					sourceSequenceContractVersion: 2,
					sourceSequenceScope: 'billing.offer:offer'
				})
			})
		});
		expect(tx.outboxEvent.create).toHaveBeenCalledTimes(2);
	});

	it('fails the transaction on a concurrent cursor CAS conflict', async () => {
		const tx = transaction(activeProducer(), 0);
		const current = service(tx);

		await expect(
			current.value.update(
				'oferta',
				{ content: '<p>offer</p>' },
				{ actor }
			)
		).rejects.toBeInstanceOf(ServiceUnavailableException);
		expect(tx.billingOfferProducerState.updateMany).toHaveBeenCalledTimes(
			1
		);
		expect(tx.outboxEvent.create).toHaveBeenCalledTimes(1);
	});
});
