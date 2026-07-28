import { WidgetRuntimeService } from '@/widget-runtime/widget-runtime.service';
import { Plan, SubscriptionStatus } from '@prisma/client';
import { Request } from 'express';

const makeWidget = (overrides: Record<string, unknown> = {}) => ({
	id: 'widget-1',
	userId: 'user-1',
	publicKey: 'public-key',
	isActive: true,
	installDomain: 'example.com',
	config: { dataType: 'PHONE' },
	publishedVersion: 1,
	publishedAt: new Date('2026-07-28T00:00:00.000Z'),
	...overrides
});

const makePrisma = () => {
	const prisma = {
		widget: {
			findUnique: jest.fn()
		},
		quiz: {
			findUnique: jest.fn()
		},
		callback: {
			findUnique: jest.fn()
		},
		countdownTimer: {
			findUnique: jest.fn()
		},
		stopOffer: {
			findUnique: jest.fn()
		},
		onlineConsultant: {
			findUnique: jest.fn()
		},
		calculator: {
			findUnique: jest.fn()
		},
		widgetRuntimePresence: {
			upsert: jest.fn(),
			findUnique: jest.fn()
		},
		widgetRuntimeDailyMetric: {
			upsert: jest.fn(),
			findMany: jest.fn()
		},
		$queryRaw: jest.fn().mockResolvedValue([{ id: 'widget-1' }]),
		$transaction: jest.fn()
	};
	prisma.$transaction.mockImplementation(
		async (
			operation:
				| Array<Promise<unknown>>
				| ((transaction: typeof prisma) => Promise<unknown>)
		) =>
			typeof operation === 'function'
				? operation(prisma)
				: Promise.all(operation)
	);

	return prisma;
};

const makeSubscriptionService = () => ({
	checkAndResetPeriod: jest.fn().mockResolvedValue({
		status: SubscriptionStatus.ACTIVE,
		plan: Plan.HARD
	})
});

describe('WidgetRuntimeService', () => {
	it('records an aggregate event only for the published install domain', async () => {
		const prisma = makePrisma();
		prisma.widget.findUnique.mockResolvedValue(makeWidget());
		prisma.widgetRuntimePresence.upsert.mockResolvedValue({});
		prisma.widgetRuntimeDailyMetric.upsert.mockResolvedValue({});
		const service = new WidgetRuntimeService(
			prisma as any,
			makeSubscriptionService() as any
		);

		await service.recordEvent(
			'wheel',
			'public-key',
			{ event: 'OPEN', runtimeVersion: '2026.07' },
			{
				headers: { origin: 'https://shop.example.com' }
			} as Request
		);

		expect(prisma.widgetRuntimePresence.upsert).toHaveBeenCalledWith(
			expect.objectContaining({
				create: expect.objectContaining({
					widgetType: 'WHEEL',
					widgetId: 'widget-1',
					installDomain: 'example.com',
					runtimeVersion: '2026.07'
				})
			})
		);
		expect(prisma.widgetRuntimeDailyMetric.upsert).toHaveBeenCalledWith(
			expect.objectContaining({
				create: expect.objectContaining({
					impressions: 0,
					opens: 1,
					starts: 0
				}),
				update: { opens: { increment: 1 } }
			})
		);
	});

	it('ignores preview and unrelated domains without disclosing widget state', async () => {
		const prisma = makePrisma();
		prisma.widget.findUnique.mockResolvedValue(makeWidget());
		const service = new WidgetRuntimeService(
			prisma as any,
			makeSubscriptionService() as any
		);

		await service.recordEvent(
			'wheel',
			'public-key',
			{ event: 'IMPRESSION', runtimeVersion: '2026.07' },
			{
				headers: { origin: 'https://winwidget.ru' }
			} as Request
		);

		expect(prisma.widgetRuntimePresence.upsert).not.toHaveBeenCalled();
		expect(prisma.widgetRuntimeDailyMetric.upsert).not.toHaveBeenCalled();
		expect(prisma.$transaction).toHaveBeenCalledTimes(1);
		expect(prisma.$queryRaw.mock.calls[0][0].join('')).toContain(
			'FOR KEY SHARE'
		);
	});

	it('does not recreate runtime rows after the widget disappeared', async () => {
		const prisma = makePrisma();
		prisma.$queryRaw.mockResolvedValue([]);
		const service = new WidgetRuntimeService(
			prisma as any,
			makeSubscriptionService() as any
		);

		await service.recordEvent(
			'wheel',
			'public-key',
			{ event: 'IMPRESSION', runtimeVersion: '2026.07' },
			{
				headers: { origin: 'https://shop.example.com' }
			} as Request
		);

		expect(prisma.widget.findUnique).not.toHaveBeenCalled();
		expect(prisma.widgetRuntimePresence.upsert).not.toHaveBeenCalled();
		expect(prisma.widgetRuntimeDailyMetric.upsert).not.toHaveBeenCalled();
	});

	it('does not reuse an installation signal from an old domain', async () => {
		const prisma = makePrisma();
		prisma.widget.findUnique.mockResolvedValue(makeWidget());
		prisma.widgetRuntimePresence.findUnique.mockResolvedValue({
			installDomain: 'old-example.com',
			firstSeenAt: new Date('2026-07-27T10:00:00.000Z'),
			lastSeenAt: new Date('2026-07-27T11:00:00.000Z'),
			runtimeVersion: '2026.06'
		});
		const service = new WidgetRuntimeService(
			prisma as any,
			makeSubscriptionService() as any
		);

		const result = await service.getStatus('user-1', 'wheel', 'widget-1');

		expect(result.installation).toEqual({
			state: 'NOT_SEEN',
			domain: 'example.com',
			firstSeenAt: null,
			lastSeenAt: null,
			runtimeVersion: null
		});
	});

	it('combines anonymous runtime metrics with daily lead totals', async () => {
		const prisma = makePrisma();
		const today = new Date();
		const utcToday = new Date(
			Date.UTC(
				today.getUTCFullYear(),
				today.getUTCMonth(),
				today.getUTCDate()
			)
		);
		prisma.widget.findUnique.mockResolvedValue(makeWidget());
		prisma.widgetRuntimePresence.findUnique.mockResolvedValue({
			firstSeenAt: new Date(utcToday.getTime() - 24 * 60 * 60 * 1000)
		});
		prisma.widgetRuntimeDailyMetric.findMany.mockResolvedValue([
			{
				date: utcToday,
				impressions: 20,
				opens: 10,
				starts: 5
			}
		]);
		prisma.$queryRaw.mockResolvedValue([
			{ date: utcToday, count: BigInt(2) }
		]);
		const service = new WidgetRuntimeService(
			prisma as any,
			makeSubscriptionService() as any
		);

		const result = await service.getAnalytics(
			'user-1',
			'wheel',
			'widget-1',
			30
		);

		expect(result.totals).toEqual({
			impressions: 20,
			opens: 10,
			starts: 5,
			submits: 2
		});
		expect(result.conversion).toEqual({
			openRate: 50,
			startRate: 50,
			submitRate: 40
		});
		expect(result.daily.at(-1)).toEqual(
			expect.objectContaining({
				impressions: 20,
				opens: 10,
				starts: 5,
				submits: 2
			})
		);
	});

	it('keeps historical lead totals visible after contact collection is disabled', async () => {
		const prisma = makePrisma();
		const today = new Date();
		const utcToday = new Date(
			Date.UTC(
				today.getUTCFullYear(),
				today.getUTCMonth(),
				today.getUTCDate()
			)
		);
		prisma.widget.findUnique.mockResolvedValue(
			makeWidget({ config: { dataType: 'NONE' } })
		);
		prisma.widgetRuntimePresence.findUnique.mockResolvedValue({
			firstSeenAt: new Date(utcToday.getTime() - 24 * 60 * 60 * 1000)
		});
		prisma.widgetRuntimeDailyMetric.findMany.mockResolvedValue([]);
		prisma.$queryRaw.mockResolvedValue([
			{ date: utcToday, count: BigInt(2) }
		]);
		const service = new WidgetRuntimeService(
			prisma as any,
			makeSubscriptionService() as any
		);

		const result = await service.getAnalytics(
			'user-1',
			'wheel',
			'widget-1',
			30
		);

		expect(result.submitAvailable).toBe(false);
		expect(result.totals.submits).toBe(2);
		expect(result.daily.at(-1)?.submits).toBe(2);
	});

	it('does not mix leads created before runtime tracking into the funnel', async () => {
		const prisma = makePrisma();
		prisma.widget.findUnique.mockResolvedValue(makeWidget());
		prisma.widgetRuntimePresence.findUnique.mockResolvedValue(null);
		prisma.widgetRuntimeDailyMetric.findMany.mockResolvedValue([]);
		const service = new WidgetRuntimeService(
			prisma as any,
			makeSubscriptionService() as any
		);

		const result = await service.getAnalytics(
			'user-1',
			'wheel',
			'widget-1',
			30
		);

		expect(result.trackingStartedAt).toBeNull();
		expect(result.isPartialPeriod).toBe(true);
		expect(prisma.$queryRaw).not.toHaveBeenCalled();
		expect(result.totals.submits).toBe(0);
	});

	it('allows funnel analytics only for an active Hard subscription', async () => {
		const prisma = makePrisma();
		const subscriptionService = makeSubscriptionService();
		prisma.widget.findUnique.mockResolvedValue(makeWidget());
		subscriptionService.checkAndResetPeriod.mockResolvedValue({
			status: SubscriptionStatus.ACTIVE,
			plan: Plan.EASY
		});
		const service = new WidgetRuntimeService(
			prisma as any,
			subscriptionService as any
		);

		await expect(
			service.getAnalytics('user-1', 'wheel', 'widget-1', 30)
		).rejects.toThrow(
			'Аналитика виджетов доступна только на активном тарифе Hard'
		);
		expect(
			prisma.widgetRuntimeDailyMetric.findMany
		).not.toHaveBeenCalled();
	});
});
