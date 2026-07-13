import { SubscriptionService } from './subscription.service';
import { ForbiddenException } from '@nestjs/common';
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

describe('SubscriptionService atomic limits', () => {
	let subscription: Subscription;
	let transaction: any;
	let prisma: any;
	let service: SubscriptionService;

	beforeEach(() => {
		subscription = createSubscription();
		transaction = {
			$queryRaw: jest.fn().mockResolvedValue([{ id: subscription.id }]),
			subscription: {
				findUnique: jest.fn().mockImplementation(async () => subscription),
				update: jest.fn()
			},
			widget: { count: jest.fn().mockResolvedValue(0) },
			quiz: { count: jest.fn().mockResolvedValue(0) },
			callback: { count: jest.fn().mockResolvedValue(0) },
			countdownTimer: { count: jest.fn().mockResolvedValue(0) },
			stopOffer: { count: jest.fn().mockResolvedValue(0) },
			onlineConsultant: { count: jest.fn().mockResolvedValue(0) },
			calculator: { count: jest.fn().mockResolvedValue(0) }
		};
		prisma = {
			$transaction: jest.fn((operation: (tx: any) => unknown) =>
				operation(transaction)
			),
			subscription: {
				findUnique: jest.fn().mockImplementation(async () => subscription),
				create: jest.fn().mockImplementation(async () => subscription)
			}
		};
		service = new SubscriptionService(prisma);
	});

	it('принимает последнюю доступную заявку и сообщает о достижении лимита', async () => {
		subscription = createSubscription({ leadsThisPeriod: 9 });
		transaction.subscription.update.mockResolvedValue(
			createSubscription({ leadsThisPeriod: 10 })
		);
		const createLead = jest.fn().mockResolvedValue({ id: 'lead-1' });

		await expect(
			service.createLeadWithinLimit(subscription.userId, createLead)
		).resolves.toEqual({
			lead: { id: 'lead-1' },
			newCount: 10,
			limitReached: true
		});
		expect(createLead).toHaveBeenCalledWith(transaction);
	});

	it('не создаёт заявку после исчерпания лимита', async () => {
		subscription = createSubscription({ leadsThisPeriod: 10 });
		const createLead = jest.fn();

		await expect(
			service.createLeadWithinLimit(subscription.userId, createLead)
		).rejects.toBeInstanceOf(ForbiddenException);
		expect(createLead).not.toHaveBeenCalled();
		expect(transaction.subscription.update).not.toHaveBeenCalled();
	});

	it('учитывает заявки unlimited-тарифа без сигнала о лимите', async () => {
		subscription = createSubscription({
			plan: Plan.HARD,
			leadsThisPeriod: 200
		});
		transaction.subscription.update.mockResolvedValue(
			createSubscription({ plan: Plan.HARD, leadsThisPeriod: 201 })
		);

		await expect(
			service.createLeadWithinLimit(subscription.userId, async () => ({
				id: 'lead-1'
			}))
		).resolves.toEqual({
			lead: { id: 'lead-1' },
			newCount: 201,
			limitReached: false
		});
	});

	it('не увеличивает счётчик, если создание заявки завершилось ошибкой', async () => {
		const error = new Error('lead create failed');

		await expect(
			service.createLeadWithinLimit(subscription.userId, async () => {
				throw error;
			})
		).rejects.toBe(error);
		expect(transaction.subscription.update).not.toHaveBeenCalled();
	});

	it('сбрасывает просроченный период перед созданием заявки', async () => {
		subscription = createSubscription({
			plan: Plan.EASY,
			leadsThisPeriod: 100,
			periodResetsAt: new Date('2020-01-01T00:00:00.000Z')
		});
		transaction.subscription.update
			.mockResolvedValueOnce(
				createSubscription({
					plan: Plan.EASY,
					leadsThisPeriod: 0,
					periodResetsAt: new Date('2099-02-01T00:00:00.000Z')
				})
			)
			.mockResolvedValueOnce(
				createSubscription({
					plan: Plan.EASY,
					leadsThisPeriod: 1,
					periodResetsAt: new Date('2099-02-01T00:00:00.000Z')
				})
			);

		const result = await service.createLeadWithinLimit(
			subscription.userId,
			async () => ({ id: 'lead-1' })
		);

		expect(result.newCount).toBe(1);
		expect(transaction.subscription.update).toHaveBeenNthCalledWith(1, {
			where: { userId: subscription.userId },
			data: {
				leadsThisPeriod: 0,
				periodResetsAt: expect.any(Date)
			}
		});
		expect(
			transaction.subscription.update.mock.calls[0][0].data.periodResetsAt.getTime()
		).toBeGreaterThan(Date.now());
	});

	it('помечает истёкшую подписку и не создаёт заявку', async () => {
		subscription = createSubscription({
			expiresAt: new Date('2020-01-01T00:00:00.000Z')
		});
		transaction.subscription.update.mockResolvedValue(
			createSubscription({
				expiresAt: subscription.expiresAt,
				status: SubscriptionStatus.EXPIRED
			})
		);
		const createLead = jest.fn();
		let transactionCompleted = false;
		prisma.$transaction.mockImplementationOnce(
			async (operation: (tx: any) => unknown) => {
				const result = await operation(transaction);
				transactionCompleted = true;
				return result;
			}
		);

		await expect(
			service.createLeadWithinLimit(subscription.userId, createLead)
		).rejects.toBeInstanceOf(ForbiddenException);
		expect(transaction.subscription.update).toHaveBeenCalledWith({
			where: { userId: subscription.userId },
			data: { status: SubscriptionStatus.EXPIRED }
		});
		expect(transactionCompleted).toBe(true);
		expect(createLead).not.toHaveBeenCalled();
	});

	it('отклоняет создание виджета при общем лимите', async () => {
		transaction.widget.count.mockResolvedValue(1);
		const createWidget = jest.fn();

		await expect(
			service.createWidgetWithinLimit(subscription.userId, createWidget)
		).rejects.toThrow('Достигнут лимит виджетов для вашего тарифа');
		expect(createWidget).not.toHaveBeenCalled();
	});

	it('создаёт виджет внутри той же транзакции после общей проверки', async () => {
		const createWidget = jest.fn().mockResolvedValue({ id: 'widget-1' });

		await expect(
			service.createWidgetWithinLimit(subscription.userId, createWidget)
		).resolves.toEqual({ id: 'widget-1' });
		expect(createWidget).toHaveBeenCalledWith(transaction);
	});
});
