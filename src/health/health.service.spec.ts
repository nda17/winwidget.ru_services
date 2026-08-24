import { HealthService } from '@/health/health.service';
import type { BillingCoreStateService } from '@/billing-boundary/billing-core-state.service';
import {
	getMessagingQueueHealthExpectations,
	BILLING_NOTIFICATION_OUTCOME_QUEUE_NAME,
	BILLING_OWNED_QUEUE_NAMES,
	MESSAGING_QUEUE_NAMES
} from '@/messaging/messaging.constants';
import type { BillingMessagingClientService } from '@/messaging/billing-messaging-client.service';
import type { NotificationDeliveryClientService } from '@/messaging/notification-delivery-client.service';
import type { RabbitMqManagementService } from '@/messaging/rabbitmq-management.service';
import type { WidgetsDeliveryFailuresClientService } from '@/messaging/widgets-delivery-failures-client.service';
import type { PrismaService } from '@/prisma.service';
import type { IdentityInternalClient } from '@/identity-boundary/identity-internal.client';
import type { PlatformMessagingClientService } from '@/messaging/platform-messaging-client.service';
import type { ConfigService } from '@nestjs/config';

const createOverview = () => ({
	outbox: {
		PENDING: 1,
		PUBLISHING: 0,
		PUBLISHED: 10,
		FAILED: 2
	},
	oldestPendingAt: '2026-07-27T11:58:00.000Z',
	operational: {
		staleOutbox: 1,
		dueOutbox: 1,
		unresolvedFailuresByCategory: {
			TRANSIENT: 2,
			RATE_LIMIT: 0,
			PERMANENT: 1,
			AUTH_CONFIGURATION: 0,
			UNCLASSIFIED: 0
		}
	},
	unresolvedFailures: 3,
	retryingFailures: 0,
	deliveredLast24Hours: 10,
	heartbeat: {
		service: 'notification-delivery-worker' as const,
		status: 'ok' as const,
		activeInstances: 1,
		lastSeenAt: '2026-07-27T11:59:55.000Z',
		lastSuccessfulPublishAt: '2026-07-27T11:59:50.000Z',
		lastSuccessfulConsumeAt: '2026-07-27T11:59:45.000Z'
	}
});

const createWidgetsOverview = () => ({
	outbox: { PENDING: 0, PUBLISHING: 0, PUBLISHED: 0, FAILED: 0 },
	oldestPendingAt: null,
	operational: {
		staleOutbox: 0,
		dueOutbox: 0,
		unresolvedFailuresByCategory: {
			TRANSIENT: 0,
			RATE_LIMIT: 0,
			PERMANENT: 0,
			AUTH_CONFIGURATION: 0,
			UNCLASSIFIED: 0
		}
	},
	unresolvedFailures: 0,
	retryingFailures: 0,
	deliveredLast24Hours: 0,
	heartbeats: [
		{
			service: 'widgets-api' as const,
			status: 'ok' as const,
			activeInstances: 1,
			lastSeenAt: '2026-07-27T11:59:55.000Z'
		},
		{
			service: 'widgets-worker' as const,
			status: 'ok' as const,
			activeInstances: 1,
			lastSeenAt: '2026-07-27T11:59:55.000Z',
			lastSuccessfulConsumeAt: null
		},
		{
			service: 'widgets-publisher' as const,
			status: 'ok' as const,
			activeInstances: 1,
			lastSeenAt: '2026-07-27T11:59:55.000Z',
			lastSuccessfulPublishAt: null
		}
	]
});

const createBillingOverview = (withProviders = true) => ({
	schemaVersion: 1 as const,
	generatedAt: '2026-07-27T12:00:00.000Z',
	outbox: { PENDING: 0, PROCESSING: 0, PUBLISHED: 0 },
	oldestPendingAt: null,
	unresolvedFailures: 0,
	retryingFailures: 0,
	deliveredLast24Hours: 0,
	...(withProviders ? { providers: { yookassa: true } } : {}),
	heartbeats: [
		'billing-api',
		'billing-scheduler',
		'billing-worker',
		'billing-outbox-publisher'
	].map(service => ({
		service: service as
			| 'billing-api'
			| 'billing-scheduler'
			| 'billing-worker'
			| 'billing-outbox-publisher',
		status: 'ok' as const,
		activeInstances: 1,
		lastSeenAt: '2026-07-27T11:59:55.000Z',
		revision: 'a'.repeat(40)
	}))
});

const createPlatformOverview = () => ({
	schemaVersion: 1 as const,
	generatedAt: '2026-07-27T12:00:00.000Z',
	outbox: { PENDING: 0, PROCESSING: 0, PUBLISHED: 0 },
	oldestPendingAt: null,
	operational: { dueOutbox: 0, staleOutbox: 0 },
	heartbeats: [
		{
			service: 'platform-api' as const,
			status: 'ok' as const,
			activeInstances: 1,
			lastSeenAt: '2026-07-27T11:59:55.000Z',
			revision: 'a'.repeat(40)
		},
		{
			service: 'platform-outbox-publisher' as const,
			status: 'ok' as const,
			activeInstances: 1,
			lastSeenAt: '2026-07-27T11:59:55.000Z',
			revision: 'a'.repeat(40)
		}
	]
});

const createRabbitQueues = (billingOwner = false) =>
	getMessagingQueueHealthExpectations({ billingOwner }).map(
		expectation => ({
			name: expectation.name,
			messages: 0,
			messages_ready: 0,
			messages_unacknowledged: 0,
			consumers:
				expectation.consumerExpectation === 'at-least-one' ? 1 : 0,
			state: 'running'
		})
	);

const createRabbitManagement = (
	queues: ReturnType<typeof createRabbitQueues>
) =>
	({
		checkConnection: jest.fn().mockResolvedValue('RabbitMQ 4.1.0'),
		getBrokerHealth: jest.fn().mockResolvedValue({
			nodes: [{ name: 'rabbit@local', running: true }],
			alarmNodes: [],
			stoppedNodes: [],
			partitionedNodes: []
		}),
		getMessagingQueues: jest.fn().mockResolvedValue(queues)
	}) as unknown as RabbitMqManagementService;

const createService = (
	notificationDelivery: Partial<NotificationDeliveryClientService> = {
		getOverview: jest.fn().mockResolvedValue(createOverview())
	},
	widgets: Partial<WidgetsDeliveryFailuresClientService> = {
		getOverview: jest.fn().mockResolvedValue(createWidgetsOverview())
	},
	rabbitManagement: Partial<RabbitMqManagementService> = {},
	billingState: Partial<BillingCoreStateService> = {
		isBillingOwner: jest.fn().mockResolvedValue(false)
	},
	billing: Partial<BillingMessagingClientService> = {
		getOverview: jest.fn().mockResolvedValue(createBillingOverview())
	},
	identity: Partial<IdentityInternalClient> = {
		getProviderHealth: jest.fn().mockResolvedValue([
			{
				id: 'smtp',
				title: 'Email SMTP',
				status: 'ok',
				message: 'Подключение работает'
			},
			{
				id: 'smsaero',
				title: 'SMS Aero',
				status: 'ok',
				message: 'Подключение работает'
			},
			{
				id: 'recaptcha',
				title: 'reCAPTCHA',
				status: 'ok',
				message: 'Ключ настроен'
			}
		])
	},
	platform: Partial<PlatformMessagingClientService> = {
		getOverview: jest.fn().mockResolvedValue(createPlatformOverview())
	}
) => {
	const configService = { get: jest.fn() };
	const prisma = {
		$queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
		outboxEvent: {
			count: jest.fn().mockResolvedValue(1),
			findFirst: jest.fn().mockResolvedValue(null)
		},
		integrationDeliveryFailure: {
			count: jest.fn().mockResolvedValue(4)
		}
	} as unknown as PrismaService;
	const service = new HealthService(
		prisma,
		configService as unknown as ConfigService,
		rabbitManagement as RabbitMqManagementService,
		notificationDelivery as NotificationDeliveryClientService,
		widgets as WidgetsDeliveryFailuresClientService,
		billingState as BillingCoreStateService,
		billing as BillingMessagingClientService,
		identity as IdentityInternalClient,
		platform as PlatformMessagingClientService
	);
	return { service, prisma, configService };
};

describe('HealthService notification delivery monitoring', () => {
	afterEach(() => {
		jest.useRealTimers();
	});

	it('accepts empty passive Widgets DLQ without consumers', async () => {
		const queues = createRabbitQueues();
		const { service } = createService(
			undefined,
			undefined,
			createRabbitManagement(queues)
		);

		await expect((service as any).checkRabbitMq()).resolves.toMatchObject({
			id: 'rabbitmq',
			status: 'ok'
		});
	});

	it('reports Platform role readiness and includes its oldest Outbox item', async () => {
		jest
			.useFakeTimers()
			.setSystemTime(new Date('2026-07-27T12:00:00.000Z'));
		const platformOverview = createPlatformOverview();
		platformOverview.outbox.PENDING = 2;
		platformOverview.operational.dueOutbox = 2;
		platformOverview.oldestPendingAt = '2026-07-27T11:58:00.000Z' as never;
		const { service } = createService(
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			{ getOverview: jest.fn().mockResolvedValue(platformOverview) }
		);
		const result = (service as any).getPlatformResult();

		await expect(
			(service as any).checkPlatform(result)
		).resolves.toMatchObject({
			id: 'platform',
			status: 'ok'
		});
		await expect(
			(service as any).checkMessagingBacklog(
				(service as any).getNotificationDeliveryResult(),
				(service as any).getWidgetsResult(),
				(service as any).getBillingResult(),
				result
			)
		).resolves.toMatchObject({
			status: 'warning',
			message: expect.stringContaining('старейшее ожидание: 120 сек.')
		});
	});

	it('keeps three stable provider checks when Identity health is unavailable', async () => {
		const { service } = createService(
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			{
				getProviderHealth: jest
					.fn()
					.mockRejectedValue(new Error('identity unavailable'))
			}
		);

		const checks = await Promise.all(
			await (service as any).getIdentityProviderChecks()
		);
		expect(checks).toEqual([
			expect.objectContaining({ id: 'smtp', status: 'down' }),
			expect.objectContaining({ id: 'smsaero', status: 'down' }),
			expect.objectContaining({ id: 'recaptcha', status: 'down' })
		]);
	});

	it('warns when a provider main queue loses its consumer', async () => {
		const queues = createRabbitQueues();
		const mainQueue = queues.find(
			queue => queue.name === MESSAGING_QUEUE_NAMES.webhook
		)!;
		mainQueue.consumers = 0;
		const { service } = createService(
			undefined,
			undefined,
			createRabbitManagement(queues)
		);

		await expect((service as any).checkRabbitMq()).resolves.toMatchObject({
			status: 'warning',
			message: expect.stringContaining('без обязательных consumers: 1')
		});
	});

	it('warns on the first message in a passive Widgets DLQ', async () => {
		const queues = createRabbitQueues();
		const deadLetterQueue = queues.find(
			queue =>
				queue.name === `${MESSAGING_QUEUE_NAMES.webhook}.dead-letter`
		)!;
		deadLetterQueue.messages_unacknowledged = 1;
		const { service } = createService(
			undefined,
			undefined,
			createRabbitManagement(queues)
		);

		await expect((service as any).checkRabbitMq()).resolves.toMatchObject({
			status: 'warning',
			message: expect.stringContaining('пассивные DLQ с сообщениями: 1')
		});
	});

	it('warns when a passive DLQ gets an unexpected consumer', async () => {
		const queues = createRabbitQueues();
		const deadLetterQueue = queues.find(
			queue =>
				queue.name === `${MESSAGING_QUEUE_NAMES.webhook}.dead-letter`
		)!;
		deadLetterQueue.consumers = 1;
		const { service } = createService(
			undefined,
			undefined,
			createRabbitManagement(queues)
		);

		await expect((service as any).checkRabbitMq()).resolves.toMatchObject({
			status: 'warning',
			message: expect.stringContaining('неожиданные consumers: 1')
		});
	});

	it('switches auto-renewal DLQ monitoring with Billing ownership', async () => {
		const coreQueues = createRabbitQueues(false);
		const billingQueues = createRabbitQueues(true);
		const coreService = createService(
			undefined,
			undefined,
			createRabbitManagement(coreQueues)
		).service;
		const billingService = createService(
			undefined,
			undefined,
			createRabbitManagement(billingQueues),
			{ isBillingOwner: jest.fn().mockResolvedValue(true) }
		).service;

		await expect(
			(coreService as any).checkRabbitMq()
		).resolves.toMatchObject({
			status: 'ok'
		});
		await expect(
			(billingService as any).checkRabbitMq()
		).resolves.toMatchObject({ status: 'ok' });
	});

	it('treats the Identity destination DLQ as a passive alerting queue', () => {
		const expectation = getMessagingQueueHealthExpectations({
			billingOwner: false
		}).find(
			item =>
				item.name ===
				`${MESSAGING_QUEUE_NAMES['telegram-destination-unavailable']}.dead-letter`
		);

		expect(expectation).toEqual({
			name: `${MESSAGING_QUEUE_NAMES['telegram-destination-unavailable']}.dead-letter`,
			consumerExpectation: 'none',
			alertOnAnyMessage: true
		});
	});

	it('requires every Billing main queue and keeps its retry and DLQ queues passive after handoff', () => {
		const expectations = getMessagingQueueHealthExpectations({
			billingOwner: true
		});
		const billingExpectations = expectations.filter(expectation =>
			BILLING_OWNED_QUEUE_NAMES.some(
				queue =>
					expectation.name === queue ||
					expectation.name.startsWith(`${queue}.`)
			)
		);

		expect(BILLING_OWNED_QUEUE_NAMES).toHaveLength(8);
		expect(BILLING_OWNED_QUEUE_NAMES).not.toContain(
			'winwidget.billing.settings-source.v1'
		);
		expect(BILLING_OWNED_QUEUE_NAMES).toContain(
			BILLING_NOTIFICATION_OUTCOME_QUEUE_NAME
		);
		expect(billingExpectations).toHaveLength(40);
		expect(
			billingExpectations.filter(expectation =>
				BILLING_OWNED_QUEUE_NAMES.includes(expectation.name)
			)
		).toEqual(
			BILLING_OWNED_QUEUE_NAMES.map(name => ({
				name,
				consumerExpectation: 'at-least-one',
				alertOnAnyMessage: false
			}))
		);
		expect(
			billingExpectations.filter(expectation =>
				expectation.name.includes('.retry.')
			)
		).toHaveLength(24);
		expect(
			billingExpectations.filter(expectation =>
				expectation.name.endsWith('.dead-letter')
			)
		).toEqual(
			BILLING_OWNED_QUEUE_NAMES.map(name => ({
				name: `${name}.dead-letter`,
				consumerExpectation: 'none',
				alertOnAnyMessage: true
			}))
		);
	});

	it('warns when a Billing main queue is missing after handoff', async () => {
		const queues = createRabbitQueues(true).filter(
			queue => queue.name !== BILLING_NOTIFICATION_OUTCOME_QUEUE_NAME
		);
		const { service } = createService(
			undefined,
			undefined,
			createRabbitManagement(
				queues as ReturnType<typeof createRabbitQueues>
			),
			{ isBillingOwner: jest.fn().mockResolvedValue(true) }
		);

		await expect((service as any).checkRabbitMq()).resolves.toMatchObject({
			status: 'warning',
			message: expect.stringContaining('отсутствуют очереди: 1')
		});
	});

	it('warns on an unexpected Billing retry consumer and the first Billing DLQ message', async () => {
		const queues = createRabbitQueues(true);
		const retryQueue = queues.find(
			queue =>
				queue.name === `${BILLING_NOTIFICATION_OUTCOME_QUEUE_NAME}.retry.1`
		)!;
		const deadLetterQueue = queues.find(
			queue =>
				queue.name ===
				`${BILLING_NOTIFICATION_OUTCOME_QUEUE_NAME}.dead-letter`
		)!;
		retryQueue.consumers = 1;
		deadLetterQueue.messages_ready = 1;
		const { service } = createService(
			undefined,
			undefined,
			createRabbitManagement(queues),
			{ isBillingOwner: jest.fn().mockResolvedValue(true) }
		);

		await expect((service as any).checkRabbitMq()).resolves.toMatchObject({
			status: 'warning',
			message: expect.stringContaining('неожиданные consumers: 1')
		});
		await expect((service as any).checkRabbitMq()).resolves.toMatchObject({
			message: expect.stringContaining('пассивные DLQ с сообщениями: 1')
		});
	});

	it('reports Billing role readiness and includes Billing backlog after handoff', async () => {
		jest
			.useFakeTimers()
			.setSystemTime(new Date('2026-07-27T12:00:00.000Z'));
		const billingOverview = createBillingOverview();
		billingOverview.unresolvedFailures = 2;
		billingOverview.oldestPendingAt = '2026-07-27T11:58:00.000Z' as never;
		const { service, prisma } = createService(
			undefined,
			undefined,
			undefined,
			{ isBillingOwner: jest.fn().mockResolvedValue(true) },
			{ getOverview: jest.fn().mockResolvedValue(billingOverview) }
		);
		const resultPromise = (service as any).getBillingResult();

		await expect(
			(service as any).checkBilling(resultPromise)
		).resolves.toMatchObject({
			id: 'billing',
			status: 'ok'
		});
		await expect(
			(service as any).checkMessagingBacklog(
				(service as any).getNotificationDeliveryResult(),
				(service as any).getWidgetsResult(),
				resultPromise
			)
		).resolves.toMatchObject({
			status: 'warning',
			message: expect.stringContaining('DLQ: 9')
		});
		expect(prisma.integrationDeliveryFailure.count).toHaveBeenCalledWith({
			where: {
				resolvedAt: null,
				integration: {
					in: expect.not.arrayContaining(['auto-renewal'])
				}
			}
		});
	});

	it('reports YooKassa from Billing worker without reading Core secrets', async () => {
		const billingOverview = createBillingOverview();
		const { service, configService } = createService(
			undefined,
			undefined,
			undefined,
			{ isBillingOwner: jest.fn().mockResolvedValue(true) },
			{ getOverview: jest.fn().mockResolvedValue(billingOverview) }
		);

		await expect(
			(service as any).checkYooKassa((service as any).getBillingResult())
		).resolves.toEqual({
			id: 'yookassa',
			title: 'ЮKassa',
			status: 'ok',
			message: 'Платёжные ключи настроены в Billing worker'
		});
		expect(configService.get).not.toHaveBeenCalled();
	});

	it('warns without crashing during a rolling Billing overview upgrade', async () => {
		const billingOverview = createBillingOverview(false);
		const { service } = createService(
			undefined,
			undefined,
			undefined,
			{ isBillingOwner: jest.fn().mockResolvedValue(true) },
			{ getOverview: jest.fn().mockResolvedValue(billingOverview) }
		);

		await expect(
			(service as any).checkYooKassa((service as any).getBillingResult())
		).resolves.toMatchObject({
			id: 'yookassa',
			status: 'warning',
			message: expect.stringContaining('ещё не опубликовал')
		});
	});

	it('warns when Billing worker reports missing YooKassa credentials', async () => {
		const billingOverview = {
			...createBillingOverview(),
			providers: { yookassa: false }
		};
		const { service } = createService(
			undefined,
			undefined,
			undefined,
			{ isBillingOwner: jest.fn().mockResolvedValue(true) },
			{ getOverview: jest.fn().mockResolvedValue(billingOverview) }
		);

		await expect(
			(service as any).checkYooKassa((service as any).getBillingResult())
		).resolves.toMatchObject({
			id: 'yookassa',
			status: 'warning',
			message: 'Платёжные ключи не настроены в Billing worker'
		});
	});

	it('combines Core and service-owned backlog without Billing failures', async () => {
		jest
			.useFakeTimers()
			.setSystemTime(new Date('2026-07-27T12:00:00.000Z'));
		const { service, prisma } = createService();
		const resultPromise = (service as any).getNotificationDeliveryResult();
		const widgetsResultPromise = (service as any).getWidgetsResult();

		const check = await (service as any).checkMessagingBacklog(
			resultPromise,
			widgetsResultPromise
		);

		expect(prisma.integrationDeliveryFailure.count).toHaveBeenCalledWith({
			where: {
				resolvedAt: null,
				integration: {
					in: [
						'campaign-admin-audit',
						'reporting-admin-audit',
						'widgets-admin-audit',
						'billing-admin-audit',
						'identity-admin-audit',
						'platform-admin-audit',
						'support-admin-audit',
						'billing-payment-projection',
						'billing-subscription-projection',
						'billing-affiliate-projection',
						'database-backup'
					]
				}
			}
		});
		expect(check).toMatchObject({
			id: 'messaging_backlog',
			status: 'warning',
			message: 'Outbox FAILED: 3, DLQ: 7, старейшее ожидание: 120 сек.'
		});
		expect(prisma.outboxEvent.findFirst).toHaveBeenNthCalledWith(1, {
			where: {
				status: 'PENDING',
				availableAt: {
					lte: new Date('2026-07-27T12:00:00.000Z')
				}
			},
			orderBy: { availableAt: 'asc' },
			select: { availableAt: true }
		});
		expect(prisma.outboxEvent.findFirst).toHaveBeenNthCalledWith(2, {
			where: {
				status: 'PUBLISHING',
				lockedAt: {
					lte: new Date('2026-07-27T11:59:00.000Z')
				}
			},
			orderBy: { lockedAt: 'asc' },
			select: { lockedAt: true }
		});
	});

	it('reports an unavailable internal API without throwing the admin checks', async () => {
		const { service } = createService({
			getOverview: jest
				.fn()
				.mockRejectedValue(new Error('connect ECONNREFUSED'))
		});
		const resultPromise = (service as any).getNotificationDeliveryResult();
		const widgetsResultPromise = (service as any).getWidgetsResult();

		await expect(
			(service as any).checkNotificationDelivery(resultPromise)
		).resolves.toMatchObject({
			id: 'notification_delivery',
			status: 'down',
			message: 'connect ECONNREFUSED'
		});
		await expect(
			(service as any).checkMessagingBacklog(
				resultPromise,
				widgetsResultPromise
			)
		).resolves.toMatchObject({
			status: 'warning',
			message: expect.stringContaining(
				'Notification Delivery metrics недоступны'
			)
		});
	});

	it('degrades Widgets health and backlog when its internal API is unavailable', async () => {
		const { service } = createService(
			{ getOverview: jest.fn().mockResolvedValue(createOverview()) },
			{
				getOverview: jest
					.fn()
					.mockRejectedValue(new Error('widgets connect ECONNREFUSED'))
			}
		);
		const notificationResultPromise = (
			service as any
		).getNotificationDeliveryResult();
		const widgetsResultPromise = (service as any).getWidgetsResult();

		await expect(
			(service as any).checkWidgets(widgetsResultPromise)
		).resolves.toMatchObject({
			id: 'widgets',
			status: 'down',
			message: 'widgets connect ECONNREFUSED'
		});
		await expect(
			(service as any).checkMessagingBacklog(
				notificationResultPromise,
				widgetsResultPromise
			)
		).resolves.toMatchObject({
			status: 'warning',
			message: expect.stringContaining('Widgets metrics недоступны')
		});
	});

	it('keeps API readiness independent from Notification Delivery', async () => {
		const getOverview = jest
			.fn()
			.mockRejectedValue(new Error('service is down'));
		const { service } = createService({ getOverview });

		await expect(service.getReadinessHealth()).resolves.toEqual(
			expect.objectContaining({
				status: 'ready',
				service: 'api'
			})
		);
		expect(getOverview).not.toHaveBeenCalled();
	});
});

describe('HealthService Telegram proxy routing', () => {
	afterEach(() => {
		jest.restoreAllMocks();
	});

	it('checks Telegram getMe through the HTTPS reverse proxy', async () => {
		const { service, configService } = createService();
		configService.get.mockImplementation((key: string) => {
			if (key === 'MODE') return 'production';
			if (key === 'TELEGRAM_API_BASE_URL')
				return 'https://tg.winwidget.ru/telegram-api';
			if (key === 'TELEGRAM_INFO_BOT_TOKEN') return 'info-token';
			if (key === 'TELEGRAM_INFO_BOT_USERNAME') return 'info-bot';
			return undefined;
		});
		const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
			ok: true,
			status: 200,
			json: jest.fn().mockResolvedValue({ ok: true })
		} as unknown as Response);

		await expect((service as any).checkInfoTelegramBot()).resolves.toEqual(
			expect.objectContaining({ status: 'ok' })
		);
		expect(fetchMock.mock.calls[0][0]).toBe(
			'https://tg.winwidget.ru/telegram-api/botinfo-token/getMe'
		);
	});

	it('checks Support readiness without reading the retired Core bot token', async () => {
		const { service, configService } = createService();
		configService.get.mockImplementation((key: string) =>
			key === 'SUPPORT_INTERNAL_BASE_URL'
				? 'http://127.0.0.1:5100'
				: undefined
		);
		const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
			ok: true,
			status: 200,
			json: jest
				.fn()
				.mockResolvedValue({ status: 'ready', service: 'support' })
		} as unknown as Response);

		await expect((service as any).checkSupportService()).resolves.toEqual(
			expect.objectContaining({ id: 'support_service', status: 'ok' })
		);
		expect(fetchMock.mock.calls[0][0]).toBe(
			'http://127.0.0.1:5100/health/ready'
		);
		expect(configService.get).not.toHaveBeenCalledWith(
			'TELEGRAM_SUPPORT_BOT_TOKEN'
		);
	});
});
