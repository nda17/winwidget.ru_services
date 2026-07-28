import { AutoRenewalService } from '@/payment/auto-renewal.service';
import { AutoRenewalSchedulerService } from '@/payment/auto-renewal-scheduler.service';
import {
	AUTO_RENEWAL_RETRY_DISPATCH_GRACE_MS,
	isAutoRenewalOfferCompatible
} from '@/payment/payment.constants';
import {
	AutoRenewal,
	AutoRenewalStatus,
	BillingPeriod,
	Payment,
	PaymentKind,
	PaymentStatus,
	Plan,
	SubscriptionStatus,
	UserStatus
} from '@prisma/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('Auto-renewal legal version', () => {
	it('accepts only the reviewed offer section shipped by the migration', () => {
		const migration = readFileSync(
			join(
				process.cwd(),
				'prisma/migrations/20260728010000_add_recurring_payments/migration.sql'
			),
			'utf8'
		);

		expect(isAutoRenewalOfferCompatible(migration)).toBe(true);
		expect(
			isAutoRenewalOfferCompatible(
				migration.replace('ориентировочно через 24 часа', 'через 25 часов')
			)
		).toBe(false);
	});
});

describe('AutoRenewalService consent ordering', () => {
	it('does not reactivate auto-renewal when consent was disabled after checkout', async () => {
		const consentedAt = new Date('2026-07-28T09:00:00.000Z');
		const currentRenewal = {
			id: 'renewal-1',
			userId: 'user-1',
			status: AutoRenewalStatus.USER_DISABLED,
			disabledAt: new Date('2026-07-28T09:05:00.000Z')
		} as AutoRenewal;
		const transaction = {
			$queryRaw: jest.fn().mockResolvedValue([{ id: currentRenewal.id }]),
			autoRenewal: {
				findUnique: jest.fn().mockResolvedValue(currentRenewal),
				upsert: jest.fn()
			},
			autoRenewalConsentEvent: {
				create: jest.fn()
			}
		};
		const crypto = {
			encrypt: jest.fn()
		};
		const service = new AutoRenewalService({} as never, crypto as never);
		const payment = {
			id: 'payment-1',
			userId: 'user-1',
			status: PaymentStatus.SUCCEEDED,
			kind: PaymentKind.ONE_TIME,
			autoRenew: true,
			plan: Plan.EASY,
			billingPeriod: BillingPeriod.MONTHLY,
			amount: '990.00',
			currency: 'RUB',
			consentedAt,
			consentVersion: 'v1',
			consentText: 'consent',
			offerSnapshot: 'offer',
			offerSha256: 'sha256',
			offerUpdatedAt: new Date('2026-07-28T08:00:00.000Z')
		} as Payment;

		const result =
			await service.activateFromSuccessfulPaymentInTransaction(
				transaction as never,
				payment,
				{
					id: 'saved-method-1',
					saved: true,
					type: 'bank_card'
				},
				new Date('2026-08-28T09:00:00.000Z')
			);

		expect(result).toBe(currentRenewal);
		expect(crypto.encrypt).not.toHaveBeenCalled();
		expect(transaction.autoRenewal.upsert).not.toHaveBeenCalled();
		expect(
			transaction.autoRenewalConsentEvent.create
		).not.toHaveBeenCalled();
	});

	it('rejects price confirmation when the published offer is incompatible', async () => {
		const renewal = {
			id: 'renewal-1',
			userId: 'user-1',
			status: AutoRenewalStatus.ACTIVE,
			plan: Plan.EASY,
			billingPeriod: BillingPeriod.MONTHLY,
			amount: '990.00',
			pendingAmount: '1200.00',
			nextChargeAt: new Date('2099-08-28T09:00:00.000Z'),
			nextRetryAt: null,
			stateVersion: 1
		} as AutoRenewal;
		const updateMany = jest.fn();
		const transaction = {
			$queryRaw: jest.fn().mockResolvedValue([{ id: renewal.id }]),
			autoRenewal: {
				findUnique: jest.fn().mockResolvedValue(renewal),
				updateMany
			},
			user: {
				findUnique: jest.fn().mockResolvedValue({
					status: UserStatus.ACTIVE,
					deletedAt: null,
					subscription: {
						status: SubscriptionStatus.ACTIVE,
						expiresAt: new Date('2099-08-28T09:00:00.000Z'),
						plan: Plan.EASY,
						billingPeriod: BillingPeriod.MONTHLY
					}
				})
			},
			tariffPrice: {
				findUnique: jest.fn().mockResolvedValue({ amount: 1200 })
			},
			legalPage: {
				findUnique: jest.fn().mockResolvedValue({
					content:
						'<section data-winwidget-section="auto-renewal-v1">Изменённые условия</section>',
					updatedAt: new Date('2026-07-28T08:00:00.000Z')
				})
			}
		};
		const prisma = {
			$transaction: jest.fn(
				async (
					callback: (client: typeof transaction) => Promise<unknown>
				) => callback(transaction)
			)
		};
		const service = new AutoRenewalService(prisma as never, {} as never);

		await expect(
			service.confirmCurrentPrice('user-1', {})
		).rejects.toThrow(
			'Условия автопродления обновляются. Повторите подтверждение позже'
		);
		expect(updateMany).not.toHaveBeenCalled();
	});
});

describe('AutoRenewalService payment-method cleanup', () => {
	it('cancels unsent intents and clears recurring payment ciphertexts', async () => {
		const updateMany = jest.fn().mockResolvedValue({ count: 1 });
		const service = new AutoRenewalService({} as never, {} as never);
		const clearFutureRecurringPaymentMethods = Reflect.get(
			service,
			'clearFutureRecurringPaymentMethods'
		) as (
			transaction: { payment: { updateMany: typeof updateMany } },
			userId: string,
			reason: string
		) => Promise<void>;

		await clearFutureRecurringPaymentMethods.call(
			service,
			{ payment: { updateMany } },
			'user-1',
			'user_disabled_before_provider_call'
		);

		expect(updateMany).toHaveBeenCalledTimes(3);
		expect(updateMany).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				where: expect.objectContaining({
					userId: 'user-1',
					kind: PaymentKind.RECURRING,
					status: PaymentStatus.PENDING,
					yookassaId: null,
					providerStatus: { in: ['queued', 'not_sent'] }
				}),
				data: expect.objectContaining({
					status: PaymentStatus.CANCELLED,
					paymentMethodCiphertext: null
				})
			})
		);
		expect(updateMany).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				where: expect.objectContaining({ providerStatus: 'creating' }),
				data: expect.objectContaining({
					status: PaymentStatus.EXPIRED,
					providerStatus: 'unknown',
					paymentMethodCiphertext: null
				})
			})
		);
		expect(updateMany).toHaveBeenNthCalledWith(
			3,
			expect.objectContaining({
				where: expect.objectContaining({
					paymentMethodCiphertext: { not: null }
				}),
				data: { paymentMethodCiphertext: null }
			})
		);
	});
});

describe('AutoRenewalService public status copy', () => {
	it('does not expose an administrator free-text reason to the user', () => {
		const service = new AutoRenewalService({} as never, {} as never);
		const getPublicDisableReason = Reflect.get(
			service,
			'getPublicDisableReason'
		) as (renewal: AutoRenewal) => string | null;
		const internalReason =
			'Внутренний тикет SUP-42, персональные данные обращения';

		const result = getPublicDisableReason.call(service, {
			status: AutoRenewalStatus.ADMIN_PAUSED,
			disableReason: internalReason
		} as AutoRenewal);

		expect(result).toBe(
			'Автопродление временно приостановлено службой поддержки.'
		);
		expect(result).not.toContain(internalReason);
	});
});

describe('AutoRenewalSchedulerService retry deadline', () => {
	it('stops treating a one-time payment as blocking at the exact checkout deadline', () => {
		const service = new AutoRenewalSchedulerService(
			{} as never,
			{} as never
		);
		const now = new Date('2026-07-29T09:00:00.000Z');
		const getBlockingPaymentWhere = Reflect.get(
			service,
			'getBlockingPaymentWhere'
		) as (userId: string, checkedAt: Date) => unknown;

		expect(getBlockingPaymentWhere.call(service, 'user-1', now)).toEqual({
			userId: 'user-1',
			OR: [
				{
					kind: PaymentKind.RECURRING,
					status: PaymentStatus.PENDING
				},
				{
					kind: PaymentKind.ONE_TIME,
					status: PaymentStatus.PENDING,
					checkoutExpiresAt: { gt: now }
				},
				{
					kind: PaymentKind.RECURRING,
					status: PaymentStatus.EXPIRED,
					OR: [{ providerStatus: 'pending' }, { yookassaId: null }]
				},
				{
					kind: PaymentKind.RECURRING,
					status: PaymentStatus.CANCELLED,
					providerStatus: 'pending'
				}
			]
		});
	});

	it('anchors the retry checkout deadline to dueAt instead of dispatch time', () => {
		const service = new AutoRenewalSchedulerService(
			{} as never,
			{} as never
		);
		const method = Reflect.get(service, 'getCheckoutExpiresAt') as (
			now: Date,
			dueAt: Date,
			isRetry: boolean
		) => Date;
		const dueAt = new Date('2026-07-29T09:00:00.000Z');
		const delayedDispatchAt = new Date('2026-07-29T09:45:00.000Z');

		const expiresAt = method.call(service, delayedDispatchAt, dueAt, true);

		expect(expiresAt.getTime()).toBe(
			dueAt.getTime() + AUTO_RENEWAL_RETRY_DISPATCH_GRACE_MS
		);
	});

	it('does not catch up a charge missed before global re-enable', () => {
		const service = new AutoRenewalSchedulerService(
			{} as never,
			{} as never
		);
		const method = Reflect.get(service, 'isMissedDuringGlobalPause') as (
			dueAt: Date,
			chargesEnabledAt: Date
		) => boolean;
		const chargesEnabledAt = new Date('2026-07-29T12:00:00.000Z');

		expect(
			method.call(
				service,
				new Date('2026-07-29T11:59:59.999Z'),
				chargesEnabledAt
			)
		).toBe(true);
		expect(method.call(service, chargesEnabledAt, chargesEnabledAt)).toBe(
			false
		);
	});
});
