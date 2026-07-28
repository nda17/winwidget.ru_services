import { RecordWidgetRuntimeEventDto } from '@/widget-runtime/widget-runtime.dto';
import { WidgetRuntimeService } from '@/widget-runtime/widget-runtime.service';
import { Plan, SubscriptionStatus } from '@prisma/client';
import { validate } from 'class-validator';
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
		widgetRuntimeDailyStepMetric: {
			upsert: jest.fn(),
			findMany: jest.fn().mockResolvedValue([])
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
	it('validates the public step key allowlist and required value', async () => {
		const missingStepKey = Object.assign(
			new RecordWidgetRuntimeEventDto(),
			{
				event: 'STEP',
				runtimeVersion: '2026.07',
				publishedVersion: 1
			}
		);
		const unsafeStepKey = Object.assign(
			new RecordWidgetRuntimeEventDto(),
			{
				event: 'STEP',
				runtimeVersion: '2026.07',
				publishedVersion: 1,
				stepKey: 'question:../../../secret'
			}
		);
		const validStepKey = Object.assign(new RecordWidgetRuntimeEventDto(), {
			event: 'STEP',
			runtimeVersion: '2026.08',
			publishedVersion: 1,
			stepKey: 'field:20'
		});
		const validCompletion = Object.assign(
			new RecordWidgetRuntimeEventDto(),
			{
				event: 'COMPLETE',
				runtimeVersion: '2026.08',
				publishedVersion: 1
			}
		);
		const missingPublishedVersion = Object.assign(
			new RecordWidgetRuntimeEventDto(),
			{
				event: 'OPEN',
				runtimeVersion: '2026.08'
			}
		);

		expect(await validate(missingStepKey)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ property: 'stepKey' })
			])
		);
		expect(await validate(unsafeStepKey)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ property: 'stepKey' })
			])
		);
		expect(await validate(validStepKey)).toEqual([]);
		expect(await validate(validCompletion)).toEqual([]);
		expect(await validate(missingPublishedVersion)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ property: 'publishedVersion' })
			])
		);
	});

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
			{
				event: 'OPEN',
				runtimeVersion: '2026.07',
				publishedVersion: 1
			},
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
					runtimeVersion: '2026.07',
					publishedVersion: 1
				})
			})
		);
		expect(prisma.widgetRuntimeDailyMetric.upsert).toHaveBeenCalledWith(
			expect.objectContaining({
				create: expect.objectContaining({
					impressions: 0,
					opens: 1,
					starts: 0,
					completions: 0,
					publishedVersion: 1
				}),
				update: { opens: { increment: 1 } }
			})
		);
	});

	it('records a configured quiz step with an atomic daily upsert', async () => {
		const prisma = makePrisma();
		prisma.quiz.findUnique.mockResolvedValue(
			makeWidget({
				config: {
					dataType: 'PHONE',
					questions: [{ text: 'Первый вопрос' }, { text: 'Второй вопрос' }]
				}
			})
		);
		prisma.widgetRuntimePresence.upsert.mockResolvedValue({});
		prisma.widgetRuntimeDailyStepMetric.upsert.mockResolvedValue({});
		const service = new WidgetRuntimeService(
			prisma as any,
			makeSubscriptionService() as any
		);

		await service.recordEvent(
			'quiz',
			'public-key',
			{
				event: 'STEP',
				runtimeVersion: '2026.07',
				publishedVersion: 1,
				stepKey: 'question:2'
			},
			{
				headers: { origin: 'https://shop.example.com' }
			} as Request
		);

		expect(
			prisma.widgetRuntimeDailyStepMetric.upsert
		).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					widgetType_widgetId_publishedVersion_date_stepKey:
						expect.objectContaining({
							widgetType: 'QUIZ',
							widgetId: 'widget-1',
							publishedVersion: 1,
							stepKey: 'question:2'
						})
				},
				create: expect.objectContaining({
					stepKey: 'question:2',
					publishedVersion: 1,
					count: 1
				}),
				update: { count: { increment: 1 } }
			})
		);
		expect(prisma.widgetRuntimeDailyMetric.upsert).not.toHaveBeenCalled();
	});

	it('records a real completion in the current published version', async () => {
		const prisma = makePrisma();
		prisma.widget.findUnique.mockResolvedValue(
			makeWidget({ publishedVersion: 4 })
		);
		prisma.widgetRuntimeDailyMetric.upsert.mockResolvedValue({});
		const service = new WidgetRuntimeService(
			prisma as any,
			makeSubscriptionService() as any
		);

		await service.recordEvent(
			'wheel',
			'public-key',
			{
				event: 'COMPLETE',
				runtimeVersion: '2026.08',
				publishedVersion: 4
			},
			{
				headers: { origin: 'https://shop.example.com' }
			} as Request
		);

		expect(prisma.widgetRuntimeDailyMetric.upsert).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					widgetType_widgetId_publishedVersion_date:
						expect.objectContaining({
							widgetType: 'WHEEL',
							widgetId: 'widget-1',
							publishedVersion: 4
						})
				},
				create: expect.objectContaining({
					publishedVersion: 4,
					completions: 1
				}),
				update: { completions: { increment: 1 } }
			})
		);
	});

	it('starts a fresh installation signal after publishing a new version', async () => {
		const prisma = makePrisma();
		prisma.widget.findUnique.mockResolvedValue(
			makeWidget({ publishedVersion: 3 })
		);
		prisma.widgetRuntimePresence.findUnique.mockResolvedValue({
			publishedVersion: 2
		});
		prisma.widgetRuntimeDailyMetric.upsert.mockResolvedValue({});
		const service = new WidgetRuntimeService(
			prisma as any,
			makeSubscriptionService() as any
		);

		await service.recordEvent(
			'wheel',
			'public-key',
			{
				event: 'IMPRESSION',
				runtimeVersion: '2026.08',
				publishedVersion: 3
			},
			{
				headers: { origin: 'https://shop.example.com' }
			} as Request
		);

		expect(prisma.widgetRuntimePresence.upsert).toHaveBeenCalledWith(
			expect.objectContaining({
				update: expect.objectContaining({
					publishedVersion: 3,
					firstSeenAt: expect.any(Date)
				})
			})
		);
	});

	it('ignores telemetry emitted by a page with an older published config', async () => {
		const prisma = makePrisma();
		prisma.widget.findUnique.mockResolvedValue(
			makeWidget({ publishedVersion: 3 })
		);
		const service = new WidgetRuntimeService(
			prisma as any,
			makeSubscriptionService() as any
		);

		await service.recordEvent(
			'wheel',
			'public-key',
			{
				event: 'COMPLETE',
				runtimeVersion: '2026.08',
				publishedVersion: 2
			},
			{
				headers: { origin: 'https://shop.example.com' }
			} as Request
		);

		expect(prisma.widgetRuntimePresence.upsert).not.toHaveBeenCalled();
		expect(prisma.widgetRuntimeDailyMetric.upsert).not.toHaveBeenCalled();
	});

	it('rejects step events for unsupported widget types', async () => {
		const prisma = makePrisma();
		const service = new WidgetRuntimeService(
			prisma as any,
			makeSubscriptionService() as any
		);

		await expect(
			service.recordEvent(
				'wheel',
				'public-key',
				{
					event: 'STEP',
					runtimeVersion: '2026.07',
					publishedVersion: 1,
					stepKey: 'question:1'
				},
				{
					headers: { origin: 'https://shop.example.com' }
				} as Request
			)
		).rejects.toThrow('Шаги доступны только для квиза и калькулятора');
		expect(prisma.$transaction).not.toHaveBeenCalled();
	});

	it('rejects stepKey for regular funnel events', async () => {
		const prisma = makePrisma();
		const service = new WidgetRuntimeService(
			prisma as any,
			makeSubscriptionService() as any
		);

		await expect(
			service.recordEvent(
				'quiz',
				'public-key',
				{
					event: 'OPEN',
					runtimeVersion: '2026.07',
					publishedVersion: 1,
					stepKey: 'question:1'
				},
				{
					headers: { origin: 'https://shop.example.com' }
				} as Request
			)
		).rejects.toThrow('stepKey допустим только для события STEP');
		expect(prisma.$transaction).not.toHaveBeenCalled();
	});

	it('rejects a step key outside the published widget configuration', async () => {
		const prisma = makePrisma();
		prisma.quiz.findUnique.mockResolvedValue(
			makeWidget({
				config: {
					dataType: 'PHONE',
					questions: [{ text: 'Единственный вопрос' }]
				}
			})
		);
		const service = new WidgetRuntimeService(
			prisma as any,
			makeSubscriptionService() as any
		);

		await expect(
			service.recordEvent(
				'quiz',
				'public-key',
				{
					event: 'STEP',
					runtimeVersion: '2026.07',
					publishedVersion: 1,
					stepKey: 'question:2'
				},
				{
					headers: { origin: 'https://shop.example.com' }
				} as Request
			)
		).rejects.toThrow('Некорректный шаг виджета');
		expect(prisma.widgetRuntimePresence.upsert).not.toHaveBeenCalled();
		expect(
			prisma.widgetRuntimeDailyStepMetric.upsert
		).not.toHaveBeenCalled();
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
			{
				event: 'IMPRESSION',
				runtimeVersion: '2026.07',
				publishedVersion: 1
			},
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
			{
				event: 'IMPRESSION',
				runtimeVersion: '2026.07',
				publishedVersion: 1
			},
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
			runtimeVersion: '2026.06',
			publishedVersion: 1
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

	it('does not reuse an installation signal from an older publication', async () => {
		const prisma = makePrisma();
		prisma.widget.findUnique.mockResolvedValue(
			makeWidget({ publishedVersion: 3 })
		);
		prisma.widgetRuntimePresence.findUnique.mockResolvedValue({
			installDomain: 'example.com',
			firstSeenAt: new Date('2026-07-27T10:00:00.000Z'),
			lastSeenAt: new Date('2026-07-27T11:00:00.000Z'),
			runtimeVersion: '2026.08',
			publishedVersion: 2
		});
		const service = new WidgetRuntimeService(
			prisma as any,
			makeSubscriptionService() as any
		);

		const result = await service.getStatus('user-1', 'wheel', 'widget-1');

		expect(result.installation.state).toBe('NOT_SEEN');
		expect(result.installation.lastSeenAt).toBeNull();
	});

	it('returns the current publication funnel with real completions', async () => {
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
			firstSeenAt: new Date(utcToday.getTime() - 24 * 60 * 60 * 1000),
			publishedVersion: 1
		});
		prisma.widgetRuntimeDailyMetric.findMany.mockResolvedValue([
			{
				date: utcToday,
				impressions: 20,
				opens: 10,
				starts: 5,
				completions: 2
			}
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
		expect(result.completionLabel).toBe('Заявки');
		expect(result.stepRateBasis).toBeNull();
		expect(result.steps).toEqual([]);
		expect(result.daily.at(-1)).toEqual(
			expect.objectContaining({
				impressions: 20,
				opens: 10,
				starts: 5,
				submits: 2
			})
		);
		expect(prisma.widgetRuntimeDailyMetric.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					publishedVersion: 1
				})
			})
		);
	});

	it('shows only real completion events when contact collection is disabled', async () => {
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
			firstSeenAt: new Date(utcToday.getTime() - 24 * 60 * 60 * 1000),
			publishedVersion: 1
		});
		prisma.widgetRuntimeDailyMetric.findMany.mockResolvedValue([
			{
				date: utcToday,
				impressions: 4,
				opens: 3,
				starts: 2,
				completions: 1
			}
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
		expect(result.completionLabel).toBe('Завершения');
		expect(result.totals.submits).toBe(1);
		expect(result.daily.at(-1)?.submits).toBe(1);
	});

	it('returns configured quiz steps in order with conversion from the previous step', async () => {
		const prisma = makePrisma();
		const today = new Date();
		const utcToday = new Date(
			Date.UTC(
				today.getUTCFullYear(),
				today.getUTCMonth(),
				today.getUTCDate()
			)
		);
		prisma.quiz.findUnique.mockResolvedValue(
			makeWidget({
				config: {
					dataType: 'PHONE',
					questions: [
						{ text: 'Какой у вас бюджет?' },
						{ text: 'Когда нужен результат?' }
					]
				}
			})
		);
		prisma.widgetRuntimePresence.findUnique.mockResolvedValue({
			firstSeenAt: new Date(utcToday.getTime() - 24 * 60 * 60 * 1000),
			publishedVersion: 1
		});
		prisma.widgetRuntimeDailyMetric.findMany.mockResolvedValue([
			{
				date: utcToday,
				impressions: 20,
				opens: 12,
				starts: 10,
				completions: 4
			}
		]);
		prisma.widgetRuntimeDailyStepMetric.findMany.mockResolvedValue([
			{ stepKey: 'question:1', count: 8 },
			{ stepKey: 'question:1', count: 1 },
			{ stepKey: 'question:2', count: 6 }
		]);
		const service = new WidgetRuntimeService(
			prisma as any,
			makeSubscriptionService() as any
		);

		const result = await service.getAnalytics(
			'user-1',
			'quiz',
			'widget-1',
			30
		);

		expect(result.steps).toEqual([
			{
				key: 'question:1',
				label: 'Какой у вас бюджет?',
				count: 9,
				conversionRate: 90
			},
			{
				key: 'question:2',
				label: 'Когда нужен результат?',
				count: 6,
				conversionRate: 66.7
			}
		]);
		expect(result.stepRateBasis).toBe('PREVIOUS_STEP');
		expect(
			prisma.widgetRuntimeDailyStepMetric.findMany
		).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					publishedVersion: 1,
					stepKey: { in: ['question:1', 'question:2'] }
				})
			})
		);
	});

	it('calculates calculator field engagement from starts independently', async () => {
		const prisma = makePrisma();
		const today = new Date();
		const utcToday = new Date(
			Date.UTC(
				today.getUTCFullYear(),
				today.getUTCMonth(),
				today.getUTCDate()
			)
		);
		prisma.calculator.findUnique.mockResolvedValue(
			makeWidget({
				publishedVersion: 5,
				config: {
					dataType: 'NONE',
					fields: [{ label: 'Площадь' }, { label: 'Этаж' }]
				}
			})
		);
		prisma.widgetRuntimePresence.findUnique.mockResolvedValue({
			firstSeenAt: new Date(utcToday.getTime() - 24 * 60 * 60 * 1000),
			publishedVersion: 5
		});
		prisma.widgetRuntimeDailyMetric.findMany.mockResolvedValue([
			{
				date: utcToday,
				impressions: 20,
				opens: 15,
				starts: 10,
				completions: 4
			}
		]);
		prisma.widgetRuntimeDailyStepMetric.findMany.mockResolvedValue([
			{ stepKey: 'field:1', count: 8 },
			{ stepKey: 'field:2', count: 5 }
		]);
		const service = new WidgetRuntimeService(
			prisma as any,
			makeSubscriptionService() as any
		);

		const result = await service.getAnalytics(
			'user-1',
			'calculator',
			'widget-1',
			30
		);

		expect(result.stepRateBasis).toBe('START');
		expect(result.steps).toEqual([
			{
				key: 'field:1',
				label: 'Площадь',
				count: 8,
				conversionRate: 80
			},
			{
				key: 'field:2',
				label: 'Этаж',
				count: 5,
				conversionRate: 50
			}
		]);
		expect(
			prisma.widgetRuntimeDailyStepMetric.findMany
		).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					publishedVersion: 5
				})
			})
		);
	});

	it('does not mix metrics or presence from older publications', async () => {
		const prisma = makePrisma();
		prisma.widget.findUnique.mockResolvedValue(
			makeWidget({ publishedVersion: 2 })
		);
		prisma.widgetRuntimePresence.findUnique.mockResolvedValue({
			firstSeenAt: new Date(),
			publishedVersion: 1
		});
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
		expect(result.totals.submits).toBe(0);
		expect(prisma.widgetRuntimeDailyMetric.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					publishedVersion: 2
				})
			})
		);
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
