import { MessagingOperationalAlertService } from '@/messaging/messaging-operational-alert.service';
import {
	MESSAGING_KINDS,
	MESSAGING_QUEUE_NAMES
} from '@/messaging/messaging.constants';
import type { NotificationDeliveryClientService } from '@/messaging/notification-delivery-client.service';
import type { RabbitMqManagementService } from '@/messaging/rabbitmq-management.service';
import type { PrismaService } from '@/prisma.service';
import type { TelegramBotService } from '@/telegram-bot/telegram-bot.service';
import type { ConfigService } from '@nestjs/config';

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
			} as unknown as NotificationDeliveryClientService
		);
		return { service, prisma, telegramBot, transaction };
	};

	const createCheckService = (
		notificationDelivery: Partial<NotificationDeliveryClientService>
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
		const queues = MESSAGING_KINDS.flatMap(kind => {
			const mainQueue = MESSAGING_QUEUE_NAMES[kind];
			return [
				{
					name: mainQueue,
					messages: kind === 'email' ? 1 : 0,
					messages_ready: kind === 'email' ? 1 : 0,
					messages_unacknowledged: 0,
					consumers: 1,
					state: 'running'
				},
				{
					name: `${mainQueue}.dead-letter`,
					messages: 0,
					messages_ready: 0,
					messages_unacknowledged: 0,
					consumers: 1,
					state: 'running'
				}
			];
		});
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
			notificationDelivery as NotificationDeliveryClientService
		);
		jest
			.spyOn(service as any, 'sendAlertIfChanged')
			.mockResolvedValue(undefined);
		return { service, prisma };
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
		expect(prisma.integrationDeliveryFailure.count).toHaveBeenCalledWith({
			where: {
				resolvedAt: null,
				integration: {
					notIn: [
						'email',
						'telegram',
						'payment-email',
						'payment-telegram',
						'limit-email',
						'limit-telegram'
					]
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
});
