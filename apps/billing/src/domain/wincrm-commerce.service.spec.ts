import {
	CrmEntitlementStatus,
	type CrmOrder
} from '@prisma/billing-client';
import { WincrmCommerceService } from './wincrm-commerce.service';
import { CrmEntitlementService } from './crm-entitlement.service';
import {
	WINCRM_PROVIDER_CONSUMER,
	WincrmProviderResponseError
} from './wincrm-commerce.contract';
import {
	wincrmCommerceRequestHash,
	wincrmDecimal,
	wincrmPeriodEnd,
	wincrmPrice,
	readWincrmPriceSnapshot,
	commerceText,
	commerceVersion
} from './wincrm-commerce.helpers';

const W = '11111111-1111-4111-8111-111111111111';
const O = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const P = '44444444-4444-4444-8444-444444444444';
const E = '55555555-5555-4555-8555-555555555555';
const T = '66666666-6666-4666-8666-666666666666';
const NOW = new Date('2026-09-09T12:00:00.000Z');
const snapshot = {
	policyVersion: 1,
	monthlyPriceMinor: 99000,
	yearlyPriceMinor: 990000,
	additionalSeatMonthlyPriceMinor: 29000,
	additionalSeatYearlyPriceMinor: 290000,
	includedSeats: 2,
	graceDays: 3
};
const fence = {
	operationId: C,
	requestHash: 'a'.repeat(64),
	fenceRevision: 1,
	targetSeats: 2
};
const order = (changes: Record<string, unknown> = {}) =>
	({
		id: O,
		workspaceId: W,
		ownerSubject: 'owner',
		commandId: C,
		capacityCommandId: C,
		capacityFence: fence,
		version: 1,
		kind: 'ONE_TIME',
		status: 'PENDING',
		cycle: 'MONTHLY',
		totalSeats: 2,
		amountMinor: 99000n,
		currency: 'RUB',
		policyVersion: 1,
		priceSnapshot: snapshot,
		autoRenew: false,
		consentVersion: null,
		consentText: null,
		consentedAt: null,
		customerEmail: 'owner@example.test',
		customerPhone: null,
		providerPaymentId: null,
		providerIdempotencyKey: 'b'.repeat(64),
		providerStatus: null,
		confirmationUrl: null,
		checkoutExpiresAt: new Date(NOW.getTime() + 3600000),
		succeededAt: null,
		cancellationReason: null,
		recurringCycleKey: null,
		recurringAttempt: 0,
		expectedRenewalVersion: null,
		createdAt: NOW,
		updatedAt: NOW,
		...changes
	}) as CrmOrder;
const claim = { operationId: P, eventId: E, leaseToken: T, version: 2 };
const operation = (changes: Record<string, unknown> = {}) => ({
	id: P,
	workspaceId: W,
	orderId: O,
	kind: 'CREATE',
	status: 'PROCESSING',
	version: 2,
	idempotencyKey: 'b'.repeat(64),
	providerPaymentId: null,
	firstDispatchAt: null,
	dispatchAttempt: 0,
	retryAttempt: 0,
	availableAt: NOW,
	leaseToken: T,
	leaseUntil: new Date(NOW.getTime() + 60000),
	pendingEventId: E,
	outboxId: E,
	requestSnapshot: {
		orderId: O,
		workspaceId: W,
		kind: 'CREATE',
		amountMinor: '99000',
		currency: 'RUB',
		providerKey: 'b'.repeat(64),
		returnUrl: `https://crm.winwidget.ru/billing/return?workspaceId=${W}&orderId=${O}`,
		paymentMethodCiphertext: null
	},
	lastErrorCode: null,
	createdAt: NOW,
	updatedAt: NOW,
	order: order(),
	...changes
});

function fixture(current = operation()) {
	const tx = {
		$executeRaw: jest.fn().mockResolvedValue(1),
		crmProviderOperation: {
			findUnique: jest.fn().mockResolvedValue(current),
			findUniqueOrThrow: jest.fn().mockResolvedValue(current),
			create: jest.fn(async ({ data }) => ({
				...data,
				status: 'PENDING',
				version: 1
			})),
			update: jest.fn(async ({ data }) => ({ ...current, ...data })),
			updateMany: jest.fn().mockResolvedValue({ count: 1 }),
			count: jest.fn().mockResolvedValue(0)
		},
		crmProviderDelivery: {
			findUnique: jest.fn().mockResolvedValue(null),
			upsert: jest.fn().mockResolvedValue({}),
			update: jest.fn().mockResolvedValue({})
		},
		crmOrder: {
			findFirst: jest.fn().mockResolvedValue(current.order),
			update: jest.fn().mockResolvedValue({}),
			updateMany: jest.fn().mockResolvedValue({ count: 1 }),
			count: jest.fn().mockResolvedValue(0)
		},
		crmCommerceAccount: {
			findUnique: jest.fn().mockResolvedValue({
				workspaceId: W,
				ownerSubject: 'owner',
				version: 1n,
				capacityCommandId: C,
				capacityFence: fence
			}),
			update: jest.fn().mockResolvedValue({})
		},
		crmCommerceCommand: {
			findUnique: jest.fn().mockResolvedValue({
				commandId: C,
				workspaceId: W,
				actorSubject: 'owner',
				status: 'PENDING',
				capacityFence: fence
			}),
			updateMany: jest.fn().mockResolvedValue({ count: 1 })
		},
		crmAutoRenewal: {
			findUnique: jest.fn().mockResolvedValue(null),
			findUniqueOrThrow: jest.fn().mockResolvedValue({
				paymentMethodCiphertext: 'v1:immutable:cipher:text'
			})
		},
		billingCommandReceipt: {
			findUnique: jest.fn().mockResolvedValue(null),
			create: jest.fn().mockResolvedValue({})
		},
		outboxEvent: { create: jest.fn().mockResolvedValue({}) }
	};
	const prisma = {
		...tx,
		$transaction: jest.fn(
			async (callback: (arg: typeof tx) => Promise<unknown>) =>
				callback(tx)
		)
	};
	return {
		tx,
		prisma,
		service: new WincrmCommerceService(
			prisma as never,
			{
				encrypt: jest.fn().mockReturnValue('v1:encrypted:method:evidence')
			} as never
		)
	};
}

describe('WincrmCommerce deterministic contracts', () => {
	it.each([
		['MONTHLY', 2, 99000n],
		['MONTHLY', 3, 128000n],
		['YEARLY', 2, 990000n],
		['YEARLY', 10000, 2900410000n]
	])('computes snapshot %s seats %s exactly', (cycle, seats, amount) =>
		expect(wincrmPrice(snapshot, cycle as 'MONTHLY', seats)).toBe(amount)
	);
	it.each([0, 1, 10001, 2.5, NaN, Infinity])(
		'rejects invalid seats %s',
		seats =>
			expect(() => wincrmPrice(snapshot, 'MONTHLY', seats)).toThrow()
	);
	it.each([
		null,
		[],
		{},
		{ ...snapshot, monthlyPriceMinor: null },
		{ ...snapshot, monthlyPriceMinor: '99000' },
		{ ...snapshot, includedSeats: 1 },
		{ ...snapshot, graceDays: 4 },
		{ ...snapshot, extra: 1 },
		{ ...snapshot, additionalSeatMonthlyPriceMinor: -1 }
	])('rejects malformed snapshot %#', value =>
		expect(() => readWincrmPriceSnapshot(value)).toThrow()
	);
	it('allows a zero extra-seat price but never zero base', () =>
		expect(
			wincrmPrice(
				{ ...snapshot, additionalSeatMonthlyPriceMinor: 0 },
				'MONTHLY',
				10000
			)
		).toBe(99000n));
	it.each([
		['2024-01-31T12:34:56.789Z', 'MONTHLY', '2024-02-29T12:34:56.789Z'],
		['2024-02-29T12:34:56.789Z', 'YEARLY', '2025-02-28T12:34:56.789Z'],
		['2026-12-31T12:00:00.000Z', 'MONTHLY', '2027-01-31T12:00:00.000Z']
	])('calendar-clamps %s', (date, cycle, result) =>
		expect(
			wincrmPeriodEnd(new Date(date), cycle as 'MONTHLY').toISOString()
		).toBe(result)
	);
	it('rejects date overflow', () =>
		expect(() =>
			wincrmPeriodEnd(new Date(8640000000000000), 'YEARLY')
		).toThrow());
	it.each([0n, -1n, 1000000000001n])('rejects invalid money %s', value =>
		expect(() => wincrmDecimal(value)).toThrow()
	);
	it('formats minor units without floating point', () => {
		expect(wincrmDecimal(1n)).toBe('0.01');
		expect(wincrmDecimal(1000000000000n)).toBe('10000000000.00');
	});
	it.each(['\ud800', '\udc00', '\ufffd', '\u0000', ['RUB'], {}])(
		'rejects unsupported text %#',
		value => expect(commerceText(value, 256)).toBe(false)
	);
	it('preserves valid emoji', () =>
		expect(commerceText('Оплата 🧩', 256)).toBe(true));
	it.each(['-1', '00', '9223372036854775808', 1, null])(
		'rejects invalid version %#',
		value => expect(commerceVersion(value)).toBe(false)
	);
	it('accepts initial version zero and BigInt maximum', () => {
		expect(commerceVersion('0')).toBe(true);
		expect(commerceVersion('9223372036854775807')).toBe(true);
	});
	it('hashes exact actor-bound user request, ignoring only the separately bound capacity fence', () => {
		const command = {
			schemaVersion: 1,
			workspaceId: W,
			actorSubject: 'owner',
			commandId: C,
			expectedBillingVersion: '0'
		};
		const hash = wincrmCommerceRequestHash(
			'WINCRM_CHECKOUT',
			command as never
		);
		expect(
			wincrmCommerceRequestHash('WINCRM_CHECKOUT', {
				...command,
				capacityFence: fence
			} as never)
		).toBe(hash);
		expect(
			wincrmCommerceRequestHash('WINCRM_CHECKOUT', {
				...command,
				actorSubject: 'other'
			} as never)
		).not.toBe(hash);
		expect(
			wincrmCommerceRequestHash('WINCRM_SEAT_CHANGE', command as never)
		).not.toBe(hash);
	});
});

describe('WincrmCommerce provider safety', () => {
	let flag: string | undefined;
	beforeEach(() => {
		flag = process.env.BILLING_WINCRM_PAYMENTS_ENABLED;
		process.env.BILLING_WINCRM_PAYMENTS_ENABLED = 'true';
		jest.useFakeTimers().setSystemTime(NOW);
	});
	afterEach(() => {
		if (flag === undefined)
			delete process.env.BILLING_WINCRM_PAYMENTS_ENABLED;
		else process.env.BILLING_WINCRM_PAYMENTS_ENABLED = flag;
		jest.useRealTimers();
	});
	it('takes a durable receipt and lease before any external provider call', async () => {
		const f = fixture(
			operation({
				status: 'PENDING',
				leaseToken: null,
				leaseUntil: null,
				version: 1
			})
		);
		await expect(
			f.service.claimProviderOperation({
				schemaVersion: 1,
				eventType: 'billing.wincrm.provider-operation.requested.v1',
				eventId: E,
				operationId: P
			})
		).resolves.toMatchObject({ state: 'CLAIMED' });
		expect(f.tx.crmProviderDelivery.upsert).toHaveBeenCalledWith(
			expect.objectContaining({
				create: expect.objectContaining({
					eventId: E,
					consumer: WINCRM_PROVIDER_CONSUMER,
					leaseToken: expect.any(String)
				})
			})
		);
	});
	it('does not reclaim another live lease', async () => {
		const f = fixture();
		await expect(
			f.service.claimProviderOperation({
				schemaVersion: 1,
				eventType: 'billing.wincrm.provider-operation.requested.v1',
				eventId: E,
				operationId: P
			})
		).resolves.toEqual({ state: 'BUSY' });
		expect(f.tx.crmProviderOperation.update).not.toHaveBeenCalled();
	});
	it('durable terminal receipt suppresses a duplicate', async () => {
		const f = fixture();
		f.tx.crmProviderDelivery.findUnique.mockResolvedValue({
			payloadHash: 'mismatch'
		});
		await expect(
			f.service.claimProviderOperation({
				schemaVersion: 1,
				eventType: 'billing.wincrm.provider-operation.requested.v1',
				eventId: E,
				operationId: P
			})
		).rejects.toThrow('BINDING_CONFLICT');
	});
	it('keeps original return URL across environment changes without reading a mutable renewal', async () => {
		const f = fixture(),
			old = process.env.BILLING_WINCRM_FRONTEND_ORIGIN;
		try {
			process.env.BILLING_WINCRM_FRONTEND_ORIGIN =
				'https://changed.example.test';
			const prepared = await f.service.prepareProviderOperation(claim);
			expect(prepared).toMatchObject({
				action: 'CREATE',
				request: { returnUrl: operation().requestSnapshot.returnUrl }
			});
			expect(f.tx.crmAutoRenewal.findUnique).not.toHaveBeenCalled();
		} finally {
			if (old === undefined)
				delete process.env.BILLING_WINCRM_FRONTEND_ORIGIN;
			else process.env.BILLING_WINCRM_FRONTEND_ORIGIN = old;
		}
	});
	it('uses only the encrypted recurring method captured by the operation', async () => {
		const current = operation({
			order: order({ kind: 'RECURRING', autoRenew: true }),
			requestSnapshot: {
				...operation().requestSnapshot,
				returnUrl: null,
				paymentMethodCiphertext: 'v1:original:encrypted:method'
			}
		});
		const f = fixture(current);
		expect(await f.service.prepareProviderOperation(claim)).toMatchObject({
			action: 'CREATE',
			request: {
				paymentMethodCiphertext: 'v1:original:encrypted:method',
				returnUrl: null
			}
		});
		expect(f.tx.crmAutoRenewal.findUnique).not.toHaveBeenCalled();
	});
	it('captures immutable CREATE fields in the same transaction as its Outbox', async () => {
		const f = fixture();
		f.tx.crmProviderOperation.findUnique.mockResolvedValue(null);
		await f.service['enqueue'](
			f.tx as never,
			order(),
			'CREATE',
			'c'.repeat(64)
		);
		expect(f.tx.crmProviderOperation.create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					requestSnapshot: expect.objectContaining({
						returnUrl: expect.stringContaining(
							'/billing/return?workspaceId='
						),
						paymentMethodCiphertext: null
					})
				})
			})
		);
		expect(f.tx.outboxEvent.create).toHaveBeenCalledTimes(1);
	});
	it.each([
		'PROVIDER_BINDING_MISMATCH',
		'PROVIDER_INVALID_RESPONSE'
	] as const)(
		'does not retry malformed provider response %s forever',
		code =>
			expect(new WincrmProviderResponseError(code)).toMatchObject({
				code,
				retryable: false
			})
	);
	it.each([
		{ id: 'provider-a', metadata: {} },
		{
			id: 'provider-b',
			metadata: {
				productCode: 'WINCRM',
				paymentId: O,
				plan: 'WINCRM',
				billingPeriod: 'MONTHLY',
				kind: 'ONE_TIME'
			},
			amount: { currency: 'RUB', value: '990.00' },
			status: 'succeeded',
			paid: true
		}
	])(
		'never mutates an order from a mismatched verification %#',
		async value => {
			const f = fixture(
				operation({
					kind: 'VERIFY',
					providerPaymentId: 'provider-a',
					order: order({ providerPaymentId: 'provider-a' })
				})
			);
			await expect(
				f.service.settleProviderOperation(claim, value)
			).rejects.toBeInstanceOf(WincrmProviderResponseError);
			expect(f.tx.crmOrder.update).not.toHaveBeenCalled();
			expect(f.tx.crmProviderOperation.update).not.toHaveBeenCalled();
		}
	);
	it('first-dispatch evidence keeps a crash/redelivery authorization failure UNKNOWN and creates an actual DLQ Outbox', async () => {
		const f = fixture(
			operation({ firstDispatchAt: NOW, dispatchAttempt: 1 })
		);
		await f.service.failProviderOperation(claim, {
			code: 'AUTHORIZATION_REVOKED',
			ambiguous: false,
			retryable: false
		});
		expect(f.tx.crmOrder.update).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ status: 'UNKNOWN' })
			})
		);
		expect(f.tx.crmCommerceCommand.updateMany).not.toHaveBeenCalled();
		expect(f.tx.outboxEvent.create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					exchange: 'winwidget.billing.wincrm-provider.dead-letter',
					payload: expect.objectContaining({ operationId: P })
				})
			})
		);
	});
	it('keeps a failed CREATE response ID only as operation evidence', async () => {
		const f = fixture(
			operation({ firstDispatchAt: NOW, dispatchAttempt: 1 })
		);
		await f.service.failProviderOperation(claim, {
			code: 'PROVIDER_BINDING_MISMATCH',
			ambiguous: true,
			retryable: false,
			providerPaymentId: 'unverified-provider'
		});
		expect(f.tx.crmProviderOperation.update).toHaveBeenCalledWith(
			expect.objectContaining({
				data: { providerPaymentId: 'unverified-provider' }
			})
		);
		for (const [input] of f.tx.crmOrder.update.mock.calls)
			expect(input.data).not.toHaveProperty('providerPaymentId');
	});
	it('VERIFY failure does not cancel a genuine order', async () => {
		const f = fixture(
			operation({
				kind: 'VERIFY',
				providerPaymentId: 'known',
				firstDispatchAt: null
			})
		);
		await f.service.failProviderOperation(claim, {
			code: 'PROVIDER_BINDING_MISMATCH',
			ambiguous: false,
			retryable: false
		});
		expect(f.tx.crmOrder.update).not.toHaveBeenCalled();
		expect(f.tx.crmOrder.updateMany).not.toHaveBeenCalled();
	});
	it('retry is PG-delayed and preserves the operation/provider key', async () => {
		const f = fixture();
		await f.service.failProviderOperation(claim, {
			code: 'TRANSPORT_UNKNOWN',
			ambiguous: true,
			retryable: true
		});
		expect(f.tx.crmProviderOperation.update).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: 'PENDING',
					pendingEventId: expect.any(String),
					availableAt: new Date(NOW.getTime() + 5000)
				})
			})
		);
		expect(f.tx.crmProviderOperation.create).not.toHaveBeenCalled();
		expect(f.tx.outboxEvent.create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					exchange: 'winwidget.events',
					availableAt: new Date(NOW.getTime() + 5000)
				})
			})
		);
	});
	it('never issues another CREATE after the 23-hour idempotency window', async () => {
		const f = fixture(
			operation({
				firstDispatchAt: new Date(NOW.getTime() - 23 * 3600000)
			})
		);
		await f.service.failProviderOperation(claim, {
			code: 'TRANSPORT_UNKNOWN',
			ambiguous: true,
			retryable: true
		});
		expect(f.tx.crmProviderOperation.update).not.toHaveBeenCalled();
		expect(f.tx.crmProviderOperation.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ status: 'UNKNOWN' })
			})
		);
	});
	it('flag disabled wins before dispatch and no firstDispatchAt is written', async () => {
		const f = fixture();
		process.env.BILLING_WINCRM_PAYMENTS_ENABLED = 'false';
		expect(await f.service.beginProviderDispatch(claim)).toEqual({
			action: 'SKIP'
		});
		expect(f.tx.crmProviderOperation.update).not.toHaveBeenCalled();
		expect(f.tx.crmOrder.update).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ status: 'CANCELLED' })
			})
		);
	});
	it('stale lease cannot settle or emit anything', async () => {
		const f = fixture(operation({ leaseUntil: NOW }));
		await expect(
			f.service.settleProviderOperation(claim, {})
		).rejects.toThrow('LEASE_LOST');
		expect(f.tx.outboxEvent.create).not.toHaveBeenCalled();
	});
	it('empty receipt list is pending fiscal evidence, never a delivered receipt', async () => {
		const f = fixture(
			operation({
				kind: 'SYNC_RECEIPT',
				providerPaymentId: 'known',
				order: order({ status: 'SUCCEEDED', providerPaymentId: 'known' })
			})
		);
		process.env.BILLING_WINCRM_PAYMENTS_ENABLED = 'false';
		await f.service.settleProviderOperation(claim, { items: [] });
		expect(f.tx.crmProviderOperation.update).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: 'PENDING',
					availableAt: new Date(NOW.getTime() + 60000)
				})
			})
		);
		expect(f.tx.crmProviderDelivery.update).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ status: 'RETRY_SCHEDULED' })
			})
		);
		expect(f.tx.outboxEvent.create).toHaveBeenCalledTimes(1);
		expect(f.tx.crmOrder.update).not.toHaveBeenCalled();
	});
	it('DEV retry denies ADMIN and unbound UNKNOWN evidence', async () => {
		const f = fixture(operation({ status: 'UNKNOWN' }));
		await expect(
			f.service.retryProviderOperation(
				P,
				{ schemaVersion: 1, commandId: C, expectedVersion: 2 },
				{ id: 'admin', role: 'ADMIN' }
			)
		).rejects.toMatchObject({ status: 403 });
		await expect(
			f.service.retryProviderOperation(
				P,
				{ schemaVersion: 1, commandId: C, expectedVersion: 2 },
				{ id: 'dev', role: 'DEV' }
			)
		).rejects.toMatchObject({ status: 409 });
		expect(f.tx.crmProviderOperation.create).not.toHaveBeenCalled();
	});
	it('DEV retry creates only a new GET operation, receipt and audit atomically', async () => {
		const f = fixture(
			operation({ status: 'UNKNOWN', providerPaymentId: 'known' })
		);
		f.tx.crmCommerceCommand.findUnique.mockResolvedValue(null);
		f.tx.crmProviderOperation.findUnique
			.mockResolvedValueOnce(
				operation({ status: 'UNKNOWN', providerPaymentId: 'known' })
			)
			.mockResolvedValueOnce(null);
		await f.service.retryProviderOperation(
			P,
			{ schemaVersion: 1, commandId: C, expectedVersion: 2 },
			{ id: 'dev', role: 'DEV' }
		);
		expect(f.tx.crmProviderOperation.create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					kind: 'VERIFY',
					providerPaymentId: 'known'
				})
			})
		);
		expect(f.tx.billingCommandReceipt.create).toHaveBeenCalled();
		expect(f.tx.outboxEvent.create).toHaveBeenCalledTimes(2);
	});
});

describe('WinCRM paid entitlement provenance', () => {
	afterEach(() => jest.useRealTimers());
	it.each([
		['2026-09-09T12:00:00.000Z', 'ACTIVE'],
		['2026-10-09T12:00:00.000Z', 'GRACE'],
		['2026-10-12T12:00:00.000Z', 'READ_ONLY']
	])(
		'resolves PAID at %s without replacing original Trial provenance',
		async (date, status) => {
			jest.useFakeTimers().setSystemTime(new Date(date));
			const base = {
				id: E,
				workspaceId: W,
				productCode: 'WINCRM',
				planCode: 'TRIAL',
				status: CrmEntitlementStatus.ACTIVE,
				seatLimit: 2,
				policyVersion: 1,
				trialStartedAt: new Date('2026-09-04T12:00:00.000Z'),
				effectiveFrom: new Date('2026-09-04T12:00:00.000Z'),
				effectiveUntil: NOW,
				graceUntil: new Date('2026-09-12T12:00:00.000Z'),
				provisioningCommandId: C,
				provisioningCommandType: 'ACTIVATE_WINCRM_TRIAL',
				activatedByUserId: 'owner',
				aggregateVersion: 5n,
				sourceSequence: 20n
			};
			const paid = {
				id: P,
				workspaceId: W,
				startsAt: NOW,
				expiresAt: new Date('2026-10-09T12:00:00.000Z'),
				graceUntil: new Date('2026-10-12T12:00:00.000Z'),
				totalSeats: 4,
				priceSnapshot: snapshot
			};
			const prisma = {
				crmEntitlement: {
					findUnique: jest.fn().mockResolvedValue(base),
					update: jest.fn()
				},
				crmPaidPeriod: { findFirst: jest.fn().mockResolvedValue(paid) }
			};
			expect(
				await new CrmEntitlementService(prisma as never).get(W)
			).toMatchObject({
				status,
				entitlement: {
					planCode: 'PAID',
					seatLimit: 4,
					provisioningCommandId: C,
					provisioningCommandType: 'ACTIVATE_WINCRM_TRIAL',
					trialStartedAt: base.trialStartedAt.toISOString()
				}
			});
			expect(prisma.crmEntitlement.update).not.toHaveBeenCalled();
			expect(prisma.crmPaidPeriod.findFirst).toHaveBeenCalledWith(
				expect.objectContaining({
					where: { workspaceId: W, startsAt: { lte: new Date(date) } }
				})
			);
		}
	);
});
