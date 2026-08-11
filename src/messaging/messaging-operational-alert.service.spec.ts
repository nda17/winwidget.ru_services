import { MessagingOperationalAlertService } from '@/messaging/messaging-operational-alert.service';
import {
	CORE_OWNED_MESSAGING_KINDS,
	getMessagingQueueHealthExpectations,
	MESSAGING_QUEUE_NAMES,
	WIDGETS_PROVIDER_INTEGRATION_KINDS
} from '@/messaging/messaging.constants';
import type { NotificationDeliveryClientService } from '@/messaging/notification-delivery-client.service';
import type { RabbitMqManagementService } from '@/messaging/rabbitmq-management.service';
import type { WidgetsDeliveryFailuresClientService } from '@/messaging/widgets-delivery-failures-client.service';
import type { PrismaService } from '@/prisma.service';
import type { TelegramBotService } from '@/telegram-bot/telegram-bot.service';
import type { ConfigService } from '@nestjs/config';
import type { BillingCoreStateService } from '@/billing-boundary/billing-core-state.service';
import type { BillingMessagingClientService } from '@/messaging/billing-messaging-client.service';

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
			lastSuccessfulConsumeAt: '2026-07-27T11:59:45.000Z'
		},
		{
			service: 'widgets-publisher' as const,
			status: 'ok' as const,
			activeInstances: 1,
			lastSeenAt: '2026-07-27T11:59:55.000Z',
			lastSuccessfulPublishAt: '2026-07-27T11:59:50.000Z'
		}
	]
});

const createNotificationDeliveryOverview = () => ({
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
	heartbeat: {
		service: 'notification-delivery-worker' as const,
		status: 'ok' as const,
		activeInstances: 1,
		lastSeenAt: '2026-07-27T11:59:55.000Z',
		lastSuccessfulPublishAt: null,
		lastSuccessfulConsumeAt: '2026-07-27T11:59:50.000Z'
	}
});

describe('MessagingOperationalAlertService', () => {
	afterEach(() => {
		jest.useRealTimers();
	});

	const createService = (acquired = true) => {
		const state = {
			id: '11111111-1111-4111-8111-111111111111',
			status: 'SUCCEEDED',
			availableAt: new Date(0),
			checkpoint: {},
			result: { signature: 'healthy' }
		};
		const transaction = {
			$queryRaw: jest.fn().mockResolvedValue([{ acquired }]),
			scheduledJobRun: {
				findUnique: jest.fn().mockResolvedValue(null),
				create: jest.fn().mockResolvedValue(state),
				update: jest.fn().mockResolvedValue(state)
			}
		};
		const prisma = {
			$transaction: jest.fn(callback => callback(transaction)),
			$executeRaw: jest.fn().mockResolvedValue(1)
		} as unknown as PrismaService;
		const telegramBot = {
			sendMessagingOperationalAlert: jest.fn().mockResolvedValue(undefined)
		} as unknown as TelegramBotService;
		const service = new MessagingOperationalAlertService(
			prisma,
			telegramBot,
			{ get: jest.fn() } as unknown as ConfigService,
			{} as RabbitMqManagementService,
			{
				getOverview: jest.fn()
			} as unknown as NotificationDeliveryClientService,
			{
				getOverview: jest.fn()
			} as unknown as WidgetsDeliveryFailuresClientService
		);
		return { service, prisma, telegramBot, transaction };
	};

	const createCheckService = (
		notificationDelivery: Partial<NotificationDeliveryClientService>,
		widgets: Partial<WidgetsDeliveryFailuresClientService> = {
			getOverview: jest.fn().mockResolvedValue(createWidgetsOverview())
		},
		billing?: {
			state: Partial<BillingCoreStateService>;
			client: Partial<BillingMessagingClientService>;
		}
	) => {
		const now = new Date('2026-07-27T12:00:00.000Z');
		const prisma = {
			outboxEvent: {
				count: jest
					.fn()
					.mockResolvedValueOnce(0)
					.mockResolvedValueOnce(0)
					.mockResolvedValueOnce(0)
			},
			integrationDeliveryFailure: {
				count: jest.fn().mockResolvedValue(0),
				groupBy: jest.fn().mockResolvedValue([])
			},
			scheduledJobRun: {
				count: jest.fn().mockResolvedValue(0)
			},
			messagingHeartbeat: {
				findMany: jest.fn().mockResolvedValue([
					{
						service: 'outbox-publisher',
						lastSeenAt: now,
						metadata: {
							lastSuccessfulPollAt: now.toISOString(),
							lastSuccessfulPublishAt: now.toISOString()
						}
					},
					{
						service: 'integration-worker',
						lastSeenAt: now,
						metadata: {}
					},
					{
						service: 'maintenance-worker',
						lastSeenAt: now,
						metadata: {}
					}
				])
			}
		} as unknown as PrismaService;
		const queues = getMessagingQueueHealthExpectations({
			billingOwner: Boolean(billing)
		}).map(expectation => ({
			name: expectation.name,
			messages: expectation.name === MESSAGING_QUEUE_NAMES.email ? 1 : 0,
			messages_ready:
				expectation.name === MESSAGING_QUEUE_NAMES.email ? 1 : 0,
			messages_unacknowledged: 0,
			consumers:
				expectation.consumerExpectation === 'at-least-one' ? 1 : 0,
			state: 'running'
		}));
		const rabbitManagement = {
			getMessagingQueues: jest.fn().mockResolvedValue(queues),
			getBrokerHealth: jest.fn().mockResolvedValue({
				nodes: [{ name: 'rabbit@local', running: true }],
				alarmNodes: [],
				stoppedNodes: [],
				partitionedNodes: []
			})
		} as unknown as RabbitMqManagementService;
		const service = new MessagingOperationalAlertService(
			prisma,
			{
				sendMessagingOperationalAlert: jest.fn()
			} as unknown as TelegramBotService,
			{
				get: jest.fn((key: string) =>
					key === 'MESSAGING_ACTIVITY_STALE_MS' ? '300000' : undefined
				)
			} as unknown as ConfigService,
			rabbitManagement,
			notificationDelivery as NotificationDeliveryClientService,
			widgets as WidgetsDeliveryFailuresClientService,
			billing?.state as BillingCoreStateService | undefined,
			billing?.client as BillingMessagingClientService | undefined
		);
		jest
			.spyOn(service as any, 'sendAlertIfChanged')
			.mockResolvedValue(undefined);
		return { service, prisma, queues };
	};

	it('claims durable alert state before sending a changed alert', async () => {
		const { service, prisma, telegramBot, transaction } = createService();

		await (service as any).sendAlertIfChanged(
			'outbox-failed=1',
			'problem'
		);

		expect(transaction.scheduledJobRun.update).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: 'SUCCEEDED',
					checkpoint: expect.objectContaining({
						pendingSignature: expect.stringMatching(/^[a-f0-9]{64}$/),
						claimToken: expect.any(String),
						claimExpiresAt: expect.any(String)
					})
				})
			})
		);
		expect(telegramBot.sendMessagingOperationalAlert).toHaveBeenCalledWith(
			'problem'
		);
		expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
	});

	it('does not send when another replica owns the advisory lock', async () => {
		const { service, telegramBot, transaction } = createService(false);

		await (service as any).sendAlertIfChanged(
			'outbox-failed=1',
			'problem'
		);

		expect(transaction.scheduledJobRun.create).not.toHaveBeenCalled();
		expect(
			telegramBot.sendMessagingOperationalAlert
		).not.toHaveBeenCalled();
	});

	it('initializes healthy state without a recovery notification', async () => {
		const { service, telegramBot } = createService();

		await (service as any).sendAlertIfChanged('', 'recovered');

		expect(
			telegramBot.sendMessagingOperationalAlert
		).not.toHaveBeenCalled();
	});

	it('keeps empty Widgets provider DLQ healthy without consumers', async () => {
		jest
			.useFakeTimers()
			.setSystemTime(new Date('2026-07-27T12:00:00.000Z'));
		const { service, queues } = createCheckService({
			getOverview: jest
				.fn()
				.mockResolvedValue(createNotificationDeliveryOverview())
		});
		const passiveQueueNames: string[] =
			WIDGETS_PROVIDER_INTEGRATION_KINDS.map(
				kind => `${MESSAGING_QUEUE_NAMES[kind]}.dead-letter`
			);

		expect(
			queues
				.filter(queue => passiveQueueNames.includes(queue.name))
				.map(queue => [queue.name, queue.consumers])
		).toEqual(passiveQueueNames.map(queue => [queue, 0]));

		await (service as any).check();

		const [signature] = (service as any).sendAlertIfChanged.mock.calls[0];
		expect(signature).toBe('');
	});

	it('alerts when a Widgets provider main queue loses its consumer', async () => {
		jest
			.useFakeTimers()
			.setSystemTime(new Date('2026-07-27T12:00:00.000Z'));
		const { service, queues } = createCheckService({
			getOverview: jest
				.fn()
				.mockResolvedValue(createNotificationDeliveryOverview())
		});
		const mainQueue = MESSAGING_QUEUE_NAMES.webhook;
		const queue = queues.find(item => item.name === mainQueue)!;
		queue.consumers = 0;

		await (service as any).check();

		const [signature] = (service as any).sendAlertIfChanged.mock.calls[0];
		expect(signature).toContain(`consumers=0:${mainQueue}`);
	});

	it('alerts on the first message in a passive Widgets provider DLQ', async () => {
		jest
			.useFakeTimers()
			.setSystemTime(new Date('2026-07-27T12:00:00.000Z'));
		const { service, queues } = createCheckService({
			getOverview: jest
				.fn()
				.mockResolvedValue(createNotificationDeliveryOverview())
		});
		const deadLetterQueue = `${MESSAGING_QUEUE_NAMES.webhook}.dead-letter`;
		const queue = queues.find(item => item.name === deadLetterQueue)!;
		queue.messages_ready = 1;

		await (service as any).check();

		const [signature, message] = (service as any).sendAlertIfChanged.mock
			.calls[0];
		expect(signature).toContain(`backlog:${deadLetterQueue}=1`);
		expect(signature).not.toContain(`consumers=0:${deadLetterQueue}`);
		expect(message).toContain(deadLetterQueue);
	});

	it('alerts on an unexpected consumer draining a passive DLQ', async () => {
		jest
			.useFakeTimers()
			.setSystemTime(new Date('2026-07-27T12:00:00.000Z'));
		const { service, queues } = createCheckService({
			getOverview: jest
				.fn()
				.mockResolvedValue(createNotificationDeliveryOverview())
		});
		const deadLetterQueue = `${MESSAGING_QUEUE_NAMES.webhook}.dead-letter`;
		const queue = queues.find(item => item.name === deadLetterQueue)!;
		queue.consumers = 1;

		await (service as any).check();

		const [signature] = (service as any).sendAlertIfChanged.mock.calls[0];
		expect(signature).toContain(`consumers>0:${deadLetterQueue}`);
	});

	it('still requires a consumer for an active DLQ', async () => {
		jest
			.useFakeTimers()
			.setSystemTime(new Date('2026-07-27T12:00:00.000Z'));
		const { service, queues } = createCheckService({
			getOverview: jest
				.fn()
				.mockResolvedValue(createNotificationDeliveryOverview())
		});
		const deadLetterQueue = `${MESSAGING_QUEUE_NAMES.email}.dead-letter`;
		const queue = queues.find(item => item.name === deadLetterQueue)!;
		queue.consumers = 0;

		await (service as any).check();

		const [signature] = (service as any).sendAlertIfChanged.mock.calls[0];
		expect(signature).toContain(`consumers=0:${deadLetterQueue}`);
	});

	it('switches auto-renewal DLQ ownership only after Billing handoff', () => {
		const deadLetterQueue = `${MESSAGING_QUEUE_NAMES['auto-renewal']}.dead-letter`;
		const getExpectation = (billingOwner: boolean) =>
			getMessagingQueueHealthExpectations({ billingOwner }).find(
				expectation => expectation.name === deadLetterQueue
			);

		expect(getExpectation(false)?.consumerExpectation).toBe(
			'at-least-one'
		);
		expect(getExpectation(true)?.consumerExpectation).toBe('none');
	});

	it('assigns moved queue activity only to Notification Delivery', async () => {
		jest
			.useFakeTimers()
			.setSystemTime(new Date('2026-07-27T12:00:00.000Z'));
		const { service, prisma } = createCheckService({
			getOverview: jest.fn().mockResolvedValue({
				outbox: {
					PENDING: 0,
					PUBLISHING: 0,
					PUBLISHED: 0,
					FAILED: 0
				},
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
				heartbeat: {
					service: 'notification-delivery-worker',
					status: 'ok',
					activeInstances: 1,
					lastSeenAt: '2026-07-27T11:59:55.000Z',
					lastSuccessfulPublishAt: null,
					lastSuccessfulConsumeAt: '2026-07-27T11:50:00.000Z'
				}
			})
		});

		await (service as any).check();

		const [signature] = (service as any).sendAlertIfChanged.mock.calls[0];
		expect(signature).toContain('notification-delivery-consume=stale');
		expect(signature).not.toContain('integration-consume=stale');
		expect(prisma.outboxEvent.count).toHaveBeenNthCalledWith(2, {
			where: {
				OR: [
					{
						status: 'PENDING',
						availableAt: {
							lt: new Date('2026-07-27T11:45:00.000Z')
						}
					},
					{
						status: 'PUBLISHING',
						OR: [
							{ lockedAt: null },
							{
								lockedAt: {
									lt: new Date('2026-07-27T11:44:00.000Z')
								}
							}
						]
					}
				]
			}
		});
		expect(prisma.outboxEvent.count).toHaveBeenNthCalledWith(3, {
			where: {
				OR: [
					{
						status: 'PENDING',
						availableAt: {
							lte: new Date('2026-07-27T12:00:00.000Z')
						}
					},
					{
						status: 'PUBLISHING',
						OR: [
							{ lockedAt: null },
							{
								lockedAt: {
									lte: new Date('2026-07-27T11:59:00.000Z')
								}
							}
						]
					}
				]
			}
		});
		expect(prisma.integrationDeliveryFailure.count).toHaveBeenCalledWith({
			where: {
				resolvedAt: null,
				integration: {
					in: [...CORE_OWNED_MESSAGING_KINDS]
				}
			}
		});
	});

	it('turns an unavailable Notification Delivery API into an alert problem', async () => {
		jest
			.useFakeTimers()
			.setSystemTime(new Date('2026-07-27T12:00:00.000Z'));
		const { service } = createCheckService({
			getOverview: jest
				.fn()
				.mockRejectedValue(new Error('connect ECONNREFUSED'))
		});

		await expect((service as any).check()).resolves.toBeUndefined();

		const [signature, message] = (service as any).sendAlertIfChanged.mock
			.calls[0];
		expect(signature).toContain(
			'notification-delivery-api=connect ECONNREFUSED'
		);
		expect(message).toContain(
			'Notification Delivery: <b>internal API недоступен: connect ECONNREFUSED'
		);
	});

	it('turns an unavailable Widgets API into an alert problem', async () => {
		jest
			.useFakeTimers()
			.setSystemTime(new Date('2026-07-27T12:00:00.000Z'));
		const { service } = createCheckService(
			{
				getOverview: jest.fn().mockResolvedValue({
					outbox: {
						PENDING: 0,
						PUBLISHING: 0,
						PUBLISHED: 0,
						FAILED: 0
					},
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
					heartbeat: {
						service: 'notification-delivery-worker',
						status: 'ok',
						activeInstances: 1,
						lastSeenAt: '2026-07-27T11:59:55.000Z',
						lastSuccessfulPublishAt: null,
						lastSuccessfulConsumeAt: '2026-07-27T11:59:50.000Z'
					}
				})
			},
			{
				getOverview: jest
					.fn()
					.mockRejectedValue(new Error('widgets connect ECONNREFUSED'))
			}
		);

		await expect((service as any).check()).resolves.toBeUndefined();

		const [signature, message] = (service as any).sendAlertIfChanged.mock
			.calls[0];
		expect(signature).toContain(
			'widgets-api=widgets connect ECONNREFUSED'
		);
		expect(message).toContain(
			'Widgets: <b>internal API недоступен: widgets connect ECONNREFUSED'
		);
	});

	it('uses Billing overview after ownership and excludes legacy auto-renewal failures', async () => {
		jest
			.useFakeTimers()
			.setSystemTime(new Date('2026-07-27T12:00:00.000Z'));
		const billingOverview = jest.fn().mockResolvedValue({
			schemaVersion: 1,
			generatedAt: '2026-07-27T12:00:00.000Z',
			outbox: { PENDING: 2, PROCESSING: 0, PUBLISHED: 5 },
			oldestPendingAt: null,
			unresolvedFailures: 4,
			retryingFailures: 0,
			deliveredLast24Hours: 3
		});
		const { service, prisma } = createCheckService(
			{
				getOverview: jest.fn().mockResolvedValue({
					outbox: {
						PENDING: 0,
						PUBLISHING: 0,
						PUBLISHED: 0,
						FAILED: 0
					},
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
					heartbeat: {
						service: 'notification-delivery-worker',
						status: 'ok',
						activeInstances: 1,
						lastSeenAt: '2026-07-27T11:59:55.000Z',
						lastSuccessfulPublishAt: null,
						lastSuccessfulConsumeAt: '2026-07-27T11:59:50.000Z'
					}
				})
			},
			undefined,
			{
				state: {
					isBillingOwner: jest.fn().mockResolvedValue(true)
				},
				client: { getOverview: billingOverview }
			}
		);

		await (service as any).check();

		expect(billingOverview).toHaveBeenCalledTimes(1);
		expect(prisma.integrationDeliveryFailure.count).toHaveBeenCalledWith({
			where: {
				resolvedAt: null,
				integration: {
					in: expect.not.arrayContaining(['auto-renewal'])
				}
			}
		});
		const [signature, message] = (service as any).sendAlertIfChanged.mock
			.calls[0];
		expect(signature).toContain('dlq=4');
		expect(message).toContain('Billing: <b>Outbox=2, DLQ=4</b>');
	});
});
