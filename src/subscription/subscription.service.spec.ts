import { SubscriptionService } from './subscription.service';
import { BadRequestException } from '@nestjs/common';
import {
	BillingPeriod,
	Plan,
	Subscription,
	SubscriptionStatus
} from '@prisma/client';

const createSubscription = (
	overrides: Partial<Subscription> = {}
): Subscription => ({
	id: 'subscription-1',
	userId: 'user-1',
	plan: Plan.TRIAL,
	billingPeriod: BillingPeriod.MONTHLY,
	status: SubscriptionStatus.ACTIVE,
	startsAt: new Date('2026-01-01T00:00:00.000Z'),
	expiresAt: new Date('2099-01-01T00:00:00.000Z'),
	leadsThisPeriod: 0,
	periodResetsAt: null,
	createdAt: new Date('2026-01-01T00:00:00.000Z'),
	updatedAt: new Date('2026-01-01T00:00:00.000Z'),
	...overrides
});

describe('SubscriptionService operational lifecycle', () => {
	let subscription: Subscription;
	let transaction: any;
	let service: SubscriptionService;

	beforeEach(() => {
		subscription = createSubscription();
		transaction = {
			$queryRaw: jest.fn().mockResolvedValue([{ id: subscription.id }]),
			subscription: {
				findUnique: jest.fn().mockImplementation(async () => subscription),
				update: jest.fn()
			}
		};
		service = new SubscriptionService({
			$transaction: jest.fn((operation: (tx: any) => unknown) =>
				operation(transaction)
			)
		} as any);
	});

	it('locks the subscription only for an active non-deleted owner', async () => {
		await service.checkAndResetPeriod(subscription.userId);

		const query = transaction.$queryRaw.mock.calls[0][0];
		const queryText = query.strings.join(' ');

		expect(queryText).toContain('JOIN "User" u');
		expect(queryText).toContain(`u."status" = 'ACTIVE'`);
		expect(queryText).toContain('u."deleted_at" IS NULL');
		expect(queryText).toContain('FOR UPDATE OF s, u');
	});

	it('returns null when the owner does not pass the operational check', async () => {
		transaction.$queryRaw.mockResolvedValue([]);

		await expect(
			service.checkAndResetPeriod(subscription.userId)
		).resolves.toBeNull();
		expect(transaction.subscription.findUnique).not.toHaveBeenCalled();
	});

	it('resets an expired billing period without owning Widgets usage', async () => {
		subscription = createSubscription({
			plan: Plan.EASY,
			leadsThisPeriod: 100,
			periodResetsAt: new Date('2020-01-01T00:00:00.000Z')
		});
		transaction.subscription.update.mockResolvedValue(
			createSubscription({
				plan: Plan.EASY,
				leadsThisPeriod: 0,
				periodResetsAt: new Date('2099-02-01T00:00:00.000Z')
			})
		);

		await service.checkAndResetPeriod(subscription.userId);

		expect(transaction.subscription.update).toHaveBeenCalledWith({
			where: { userId: subscription.userId },
			data: {
				periodResetsAt: expect.any(Date)
			}
		});
	});

	it('marks an expired subscription', async () => {
		subscription = createSubscription({
			expiresAt: new Date('2020-01-01T00:00:00.000Z')
		});
		transaction.subscription.update.mockResolvedValue(
			createSubscription({
				expiresAt: subscription.expiresAt,
				status: SubscriptionStatus.EXPIRED
			})
		);

		await service.checkAndResetPeriod(subscription.userId);

		expect(transaction.subscription.update).toHaveBeenCalledWith({
			where: { userId: subscription.userId },
			data: { status: SubscriptionStatus.EXPIRED }
		});
	});
});

describe('SubscriptionService admin soft-delete protection', () => {
	let prisma: any;
	let service: SubscriptionService;

	beforeEach(() => {
		prisma = {
			user: {
				findUnique: jest.fn(),
				findMany: jest.fn()
			},
			subscription: {
				findUnique: jest.fn(),
				findMany: jest.fn(),
				count: jest.fn(),
				upsert: jest.fn()
			},
			subscriptionHistory: {
				findMany: jest.fn(),
				count: jest.fn()
			},
			$transaction: jest.fn()
		};
		service = new SubscriptionService(prisma);
	});

	it('не активирует подписку soft-deleted пользователя', async () => {
		prisma.user.findUnique.mockResolvedValue({
			deletedAt: new Date('2026-07-28T00:00:00.000Z')
		});

		await expect(
			service.adminActivateSubscription(
				'deleted-user',
				Plan.EASY,
				BillingPeriod.MONTHLY
			)
		).rejects.toThrow(
			new BadRequestException(
				'Нельзя изменить подписку удалённого пользователя'
			)
		);
		expect(prisma.user.findUnique).toHaveBeenCalledWith({
			where: { id: 'deleted-user' },
			select: { deletedAt: true }
		});
		expect(prisma.subscription.findUnique).not.toHaveBeenCalled();
		expect(prisma.subscription.upsert).not.toHaveBeenCalled();
	});

	it('не начисляет бонусные дни soft-deleted пользователю по ID', async () => {
		prisma.user.findUnique.mockResolvedValue({
			deletedAt: new Date('2026-07-28T00:00:00.000Z')
		});

		await expect(
			service.adminExtendSubscriptionDays({
				userId: 'deleted-user',
				days: 3,
				adminId: 'admin-user',
				audience: 'SINGLE'
			})
		).rejects.toThrow('Нельзя изменить подписку удалённого пользователя');
		expect(prisma.subscription.findUnique).not.toHaveBeenCalled();
		expect(prisma.$transaction).not.toHaveBeenCalled();
	});

	it.each([
		[
			'ACTIVE_SUBSCRIPTION',
			{
				deletedAt: null,
				subscription: {
					is: {
						status: SubscriptionStatus.ACTIVE,
						OR: [
							{ expiresAt: null },
							{ expiresAt: { gt: expect.any(Date) } }
						]
					}
				}
			}
		],
		[
			'INACTIVE_SUBSCRIPTION',
			{
				deletedAt: null,
				OR: [
					{ subscription: { is: null } },
					{
						subscription: {
							isNot: {
								status: SubscriptionStatus.ACTIVE,
								OR: [
									{ expiresAt: null },
									{ expiresAt: { gt: expect.any(Date) } }
								]
							}
						}
					}
				]
			}
		],
		['ALL', { deletedAt: null }]
	] as const)(
		'исключает soft-deleted пользователей из аудитории %s',
		async (audience, expectedWhere) => {
			prisma.user.findMany.mockResolvedValue([]);

			await expect(
				service.adminExtendSubscriptionDays({
					days: 3,
					adminId: 'admin-user',
					audience
				})
			).rejects.toThrow('Пользователи для начисления не найдены');
			expect(prisma.user.findMany).toHaveBeenCalledWith({
				where: expectedWhere,
				select: {
					id: true,
					subscription: true
				},
				orderBy: {
					createdAt: 'asc'
				}
			});
		}
	);

	it('сохраняет удалённых пользователей в исторических списках подписок', async () => {
		prisma.subscription.findMany.mockResolvedValue([]);
		prisma.subscription.count.mockResolvedValue(0);
		prisma.subscriptionHistory.findMany.mockResolvedValue([]);
		prisma.subscriptionHistory.count.mockResolvedValue(0);

		await service.adminGetAllSubscriptions();
		await service.adminGetSubscriptionHistory();

		expect(prisma.subscription.findMany).toHaveBeenCalledWith(
			expect.objectContaining({ where: {} })
		);
		expect(prisma.subscription.count).toHaveBeenCalledWith({ where: {} });
		expect(prisma.subscriptionHistory.findMany).toHaveBeenCalledWith(
			expect.objectContaining({ where: {} })
		);
		expect(prisma.subscriptionHistory.count).toHaveBeenCalledWith({
			where: {}
		});
	});
});
