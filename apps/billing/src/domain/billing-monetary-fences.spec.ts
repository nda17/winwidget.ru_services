import {
	AffiliateReferralStatus,
	AutoRenewalConsentEventType,
	AutoRenewalStatus,
	BillingPeriod,
	PaymentKind,
	PaymentStatus,
	Plan,
	ProviderOperationStatus,
	SubscriptionStatus
} from '@prisma/billing-client';
import { ConflictException } from '@nestjs/common';
import { InternalCommandsService } from './internal-commands.service';
import { PaymentDomainService } from './payment-domain.service';
import { SubscriptionDomainService } from './subscription-domain.service';
import { TariffAffiliateService } from './tariff-affiliate.service';

describe('Billing monetary operation fences', () => {
	it('keeps an empty import target empty during public Billing reads', async () => {
		const tariffMutations = {
			create: jest.fn(),
			update: jest.fn(),
			upsert: jest.fn()
		};
		const settingsMutations = {
			create: jest.fn(),
			update: jest.fn(),
			upsert: jest.fn()
		};
		const prisma = {
			tariffPrice: {
				findMany: jest.fn().mockResolvedValue([]),
				...tariffMutations
			},
			billingSettings: {
				findUnique: jest.fn().mockResolvedValue(null),
				...settingsMutations
			}
		};
		const service = new TariffAffiliateService(prisma as never);

		await expect(service.tariffPrices()).resolves.toEqual([]);
		await expect(service.affiliateSettings()).resolves.toEqual({
			enabled: false,
			cashbackPercent: 10
		});

		expect(prisma.tariffPrice.findMany).toHaveBeenCalledWith({
			where: { plan: { in: [Plan.EASY, Plan.HARD] } },
			orderBy: [{ plan: 'asc' }, { billingPeriod: 'asc' }]
		});
		expect(prisma.billingSettings.findUnique).toHaveBeenCalledWith({
			where: { id: 'singleton' },
			select: {
				affiliateProgramEnabled: true,
				affiliateCashbackPercent: true
			}
		});
		for (const mutation of [
			...Object.values(tariffMutations),
			...Object.values(settingsMutations)
		]) {
			expect(mutation).not.toHaveBeenCalled();
		}
	});

	it('returns persisted public Billing values without changing them', async () => {
		const persistedPrices = [
			{
				id: 'price-easy-monthly',
				plan: Plan.EASY,
				billingPeriod: BillingPeriod.MONTHLY,
				amount: 1090,
				createdAt: new Date('2026-08-01T00:00:00.000Z'),
				updatedAt: new Date('2026-08-11T00:00:00.000Z')
			}
		];
		const settings = {
			affiliateProgramEnabled: true,
			affiliateCashbackPercent: 27
		};
		const tariffMutations = {
			create: jest.fn(),
			update: jest.fn(),
			upsert: jest.fn()
		};
		const settingsMutations = {
			create: jest.fn(),
			update: jest.fn(),
			upsert: jest.fn()
		};
		const prisma = {
			tariffPrice: {
				findMany: jest.fn().mockResolvedValue(persistedPrices),
				...tariffMutations
			},
			billingSettings: {
				findUnique: jest.fn().mockResolvedValue(settings),
				...settingsMutations
			}
		};
		const service = new TariffAffiliateService(prisma as never);

		await expect(service.tariffPrices()).resolves.toEqual(persistedPrices);
		await expect(service.affiliateSettings()).resolves.toEqual({
			enabled: true,
			cashbackPercent: 27
		});
		for (const mutation of [
			...Object.values(tariffMutations),
			...Object.values(settingsMutations)
		]) {
			expect(mutation).not.toHaveBeenCalled();
		}
	});

	it('blocks identity deactivation while an expired provider lease remains ambiguous', async () => {
		const transaction = {
			$queryRaw: jest.fn().mockResolvedValue([]),
			billingCommandReceipt: {
				findUnique: jest.fn().mockResolvedValue(null),
				create: jest.fn()
			},
			providerOperation: {
				findFirst: jest.fn().mockResolvedValue({
					id: 'operation-1',
					status: ProviderOperationStatus.PROCESSING,
					leaseUntil: new Date('2026-08-10T00:00:00.000Z')
				}),
				updateMany: jest.fn()
			},
			autoRenewal: {
				findUnique: jest.fn(),
				update: jest.fn()
			},
			autoRenewalConsentEvent: { create: jest.fn() },
			payment: { findMany: jest.fn(), update: jest.fn() }
		};
		const prisma = {
			billingCommandReceipt: {
				findUnique: jest.fn().mockResolvedValue(null)
			},
			$transaction: jest.fn(
				async (callback: (client: typeof transaction) => unknown) =>
					callback(transaction)
			)
		};
		const service = new InternalCommandsService(
			prisma as never,
			{} as never,
			{} as never
		);

		await expect(
			service.revokeBeforeDeactivate({
				schemaVersion: 1,
				commandId: 'c7de40a7-b401-41d5-92ef-2c437180e201',
				userId: 'user-1',
				reason: 'USER_DEACTIVATION',
				actorId: 'admin-1',
				actorRole: 'ADMIN',
				occurredAt: '2026-08-11T00:00:00.000Z'
			})
		).rejects.toBeInstanceOf(ConflictException);

		expect(transaction.providerOperation.findFirst).toHaveBeenCalledWith({
			where: {
				payment: { userId: 'user-1' },
				status: {
					in: [
						ProviderOperationStatus.PROCESSING,
						ProviderOperationStatus.UNKNOWN
					]
				}
			},
			select: { id: true, status: true }
		});
		expect(
			transaction.providerOperation.updateMany
		).not.toHaveBeenCalled();
		expect(transaction.payment.update).not.toHaveBeenCalled();
	});

	it('does not clear a recurring intent that may already have reached the provider', async () => {
		const transaction = {
			$queryRaw: jest.fn().mockResolvedValue([]),
			payment: {
				findMany: jest.fn().mockResolvedValue([
					{
						id: 'payment-1',
						kind: PaymentKind.RECURRING,
						status: PaymentStatus.PENDING,
						yookassaId: null,
						providerStatus: 'creating'
					}
				]),
				update: jest.fn()
			},
			providerOperation: {
				findFirst: jest.fn().mockResolvedValue({ id: 'operation-1' }),
				updateMany: jest.fn()
			}
		};
		const service = new PaymentDomainService({} as never, {} as never);

		await expect(
			(
				service as unknown as {
					clearFutureRecurringPayments(
						client: typeof transaction,
						userId: string,
						reason: string
					): Promise<void>;
				}
			).clearFutureRecurringPayments(
				transaction,
				'user-1',
				'user_disabled_before_provider_call'
			)
		).rejects.toBeInstanceOf(ConflictException);

		expect(
			transaction.providerOperation.updateMany
		).not.toHaveBeenCalled();
		expect(transaction.payment.update).not.toHaveBeenCalled();
	});

	it('blocks an administrative subscription cancellation on UNKNOWN provider state', async () => {
		const current = { id: 'subscription-1', userId: 'user-1' };
		const transaction = {
			$queryRaw: jest.fn().mockResolvedValue([]),
			providerOperation: {
				findFirst: jest.fn().mockResolvedValue({ id: 'operation-1' })
			},
			subscription: { update: jest.fn() }
		};
		const prisma = {
			subscription: { findUnique: jest.fn().mockResolvedValue(current) },
			$transaction: jest.fn(
				async (callback: (client: typeof transaction) => unknown) =>
					callback(transaction)
			)
		};
		const service = new SubscriptionDomainService(
			prisma as never,
			{} as never
		);

		await expect(
			service.cancel('user-1', {
				id: 'admin-1',
				role: 'ADMIN',
				ip: null,
				userAgent: null
			})
		).rejects.toBeInstanceOf(ConflictException);

		expect(transaction.providerOperation.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					status: {
						in: [
							ProviderOperationStatus.PROCESSING,
							ProviderOperationStatus.UNKNOWN
						]
					}
				})
			})
		);
		expect(transaction.subscription.update).not.toHaveBeenCalled();
	});

	it('persists client context in the immutable renewal consent event', async () => {
		const transaction = {
			autoRenewalConsentEvent: { create: jest.fn().mockResolvedValue({}) }
		};
		const service = new PaymentDomainService({} as never, {} as never);
		const renewal = {
			id: 'renewal-1',
			userId: 'user-1',
			status: AutoRenewalStatus.ACTIVE,
			consentVersion: 'consent-v1',
			consentText: 'consent text',
			offerSnapshot: '<section>offer</section>',
			offerSha256: 'offer-sha',
			offerUpdatedAt: new Date('2026-08-10T00:00:00.000Z'),
			plan: Plan.EASY,
			billingPeriod: BillingPeriod.MONTHLY,
			amount: '990.00',
			currency: 'RUB'
		};

		await (
			service as unknown as {
				createRenewalEvent(
					client: typeof transaction,
					autoRenewal: typeof renewal,
					type: AutoRenewalConsentEventType,
					actor: {
						id: string;
						role: string;
						ip: string;
						userAgent: string;
					},
					source: string,
					reason: string
				): Promise<void>;
			}
		).createRenewalEvent(
			transaction,
			renewal,
			AutoRenewalConsentEventType.USER_DISABLED,
			{
				id: 'user-1',
				role: 'USER',
				ip: '203.0.113.7',
				userAgent: 'billing-contract-agent'
			},
			'CABINET',
			'Отключено пользователем'
		);

		expect(
			transaction.autoRenewalConsentEvent.create
		).toHaveBeenCalledWith({
			data: expect.objectContaining({
				autoRenewalId: 'renewal-1',
				userId: 'user-1',
				type: AutoRenewalConsentEventType.USER_DISABLED,
				actorUserId: 'user-1',
				actorRole: 'USER',
				ip: '203.0.113.7',
				userAgent: 'billing-contract-agent'
			})
		});
	});

	it('keeps indefinite subscriptions in the active audience without using null as an extension base', () => {
		const service = new SubscriptionDomainService(
			{} as never,
			{} as never
		);
		const helpers = service as unknown as {
			isActiveFuture(
				subscription: {
					status: SubscriptionStatus;
					expiresAt: Date | null;
				},
				now: Date
			): boolean;
			isActiveForAudience(
				subscription: {
					status: SubscriptionStatus;
					expiresAt: Date | null;
				},
				now: Date
			): boolean;
		};
		const indefinite = {
			status: SubscriptionStatus.ACTIVE,
			expiresAt: null
		};

		expect(helpers.isActiveForAudience(indefinite, new Date())).toBe(true);
		expect(helpers.isActiveFuture(indefinite, new Date())).toBe(false);
	});

	it('preserves the legacy tariff validation error before starting a transaction', async () => {
		const prisma = { $transaction: jest.fn() };
		const service = new TariffAffiliateService(prisma as never);

		await expect(
			service.updateTariffPrices(
				{
					prices: [
						{
							plan: Plan.EASY,
							billingPeriod: BillingPeriod.MONTHLY,
							amount: 990
						},
						{
							plan: Plan.EASY,
							billingPeriod: BillingPeriod.YEARLY,
							amount: 4680
						},
						{
							plan: Plan.HARD,
							billingPeriod: BillingPeriod.MONTHLY,
							amount: 1690
						},
						{
							plan: Plan.HARD,
							billingPeriod: BillingPeriod.YEARLY,
							amount: 9480
						},
						{
							plan: Plan.TRIAL,
							billingPeriod: BillingPeriod.MONTHLY,
							amount: 1
						}
					]
				} as never,
				{
					id: 'admin-1',
					role: 'ADMIN',
					ip: null,
					userAgent: null
				}
			)
		).rejects.toMatchObject({
			message: 'Можно менять цены только для тарифов Easy и Hard'
		});
		expect(prisma.$transaction).not.toHaveBeenCalled();
	});

	it('normalizes the legacy affiliate status filter with surrounding whitespace', async () => {
		const service = new TariffAffiliateService({} as never);
		const affiliateList = jest.fn().mockResolvedValue({ items: [] });
		(
			service as unknown as {
				affiliateList: typeof affiliateList;
			}
		).affiliateList = affiliateList;

		await service.adminReferrals(1, 20, ' registered ');

		expect(affiliateList).toHaveBeenCalledWith(1, 20, {
			status: AffiliateReferralStatus.REGISTERED
		});
	});

	it('rejects a delayed referral request when a payment already existed at request time', async () => {
		const transaction = {
			$executeRaw: jest.fn().mockResolvedValue(0),
			affiliateReferral: {
				findUnique: jest.fn().mockResolvedValue(null),
				create: jest.fn()
			},
			billingSettings: {
				upsert: jest
					.fn()
					.mockResolvedValue({ affiliateProgramEnabled: true })
			},
			identityContactProjection: {
				findUnique: jest.fn().mockResolvedValue({
					status: 'ACTIVE',
					deletedAt: null
				})
			},
			payment: {
				findFirst: jest
					.fn()
					.mockResolvedValueOnce({
						id: 'payment-before-referral',
						createdAt: new Date('2026-08-10T23:59:59.000Z')
					})
					.mockResolvedValueOnce(null)
			},
			billingSourceSequence: { upsert: jest.fn() }
		};
		const prisma = {
			$transaction: jest.fn(
				async (callback: (client: typeof transaction) => unknown) =>
					callback(transaction)
			)
		};
		const service = new TariffAffiliateService(prisma as never);

		await expect(
			service.registerReferral(
				'referrer-1',
				'referred-1',
				'2026-08-11T00:00:00.000Z'
			)
		).resolves.toBeNull();
		expect(transaction.affiliateReferral.create).not.toHaveBeenCalled();
		expect(
			transaction.billingSourceSequence.upsert
		).not.toHaveBeenCalled();
	});

	it('retries a referral request until its validated referrer projection arrives', async () => {
		const transaction = {
			$executeRaw: jest.fn().mockResolvedValue(0),
			affiliateReferral: { findUnique: jest.fn().mockResolvedValue(null) },
			billingSettings: {
				upsert: jest
					.fn()
					.mockResolvedValue({ affiliateProgramEnabled: true })
			},
			identityContactProjection: {
				findUnique: jest.fn().mockResolvedValue(null)
			},
			payment: {
				findFirst: jest.fn().mockResolvedValue(null)
			}
		};
		const prisma = {
			$transaction: jest.fn(
				async (callback: (client: typeof transaction) => unknown) =>
					callback(transaction)
			)
		};
		const service = new TariffAffiliateService(prisma as never);

		await expect(
			service.registerReferral(
				'referrer-1',
				'referred-1',
				'2026-08-11T00:00:00.000Z'
			)
		).rejects.toThrow(
			'Referral referrer identity projection is unavailable'
		);
	});
});
