import type { NotificationDeliveryPrismaService } from '../prisma/notification-delivery-prisma.service';
import { messagingContextMiddleware } from '../../messaging/messaging-context';
import {
	NotificationDeliveryControlActionKind,
	NotificationDeliveryExchange,
	NotificationDeliveryOutboxStatus,
	NotificationDeliveryReceiptStatus
} from '@prisma/notification-delivery-client';
import { ConflictException, NotFoundException } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { NotificationDeliveryControlService } from './notification-delivery-control.service';

const EVENT_ID = '11111111-1111-4111-8111-111111111111';
const FAILURE_ID = '22222222-2222-4222-8222-222222222222';

const createFailure = (overrides: Record<string, unknown> = {}) => ({
	id: FAILURE_ID,
	eventId: EVENT_ID,
	consumer: 'email',
	routingKey: 'lead.integration.email.v2',
	payload: {
		schemaVersion: 2,
		eventType: 'lead.integration.requested.v2',
		integration: 'email',
		source: 'widget',
		entity: { id: 'widget-1', name: 'Колесо' },
		lead: {
			id: 'lead-1',
			createdAt: '2026-07-27T00:00:00.000Z'
		},
		destination: { email: 'owner@example.com' }
	},
	headers: {},
	attempts: 4,
	lastError: 'timeout',
	category: 'TRANSIENT',
	normalizedCode: 'TIMEOUT',
	safeReason: 'Provider request timed out',
	httpStatus: null,
	providerCode: null,
	retryable: true,
	classificationVersion: 1,
	firstFailedAt: new Date('2026-07-27T00:00:00.000Z'),
	failedAt: new Date('2026-07-27T00:01:00.000Z'),
	retryingAt: null,
	activeRetryToken: null,
	resolvedAt: null,
	resolution: null,
	resolutionComment: null,
	resolvedById: null,
	createdAt: new Date('2026-07-27T00:01:00.000Z'),
	updatedAt: new Date('2026-07-27T00:01:00.000Z'),
	...overrides
});

const createOverviewPrisma = (
	heartbeats: Array<{
		service: string;
		instanceId: string;
		metadata: Record<string, unknown>;
		lastSeenAt: Date;
	}>
) =>
	({
		notificationDeliveryOutboxEvent: {
			groupBy: jest.fn().mockResolvedValue([
				{
					status: 'PENDING',
					_count: { _all: 2 }
				},
				{
					status: 'FAILED',
					_count: { _all: 1 }
				}
			]),
			findFirst: jest
				.fn()
				.mockResolvedValueOnce({
					availableAt: new Date('2026-07-27T11:59:00.000Z')
				})
				.mockResolvedValueOnce({
					leaseExpiresAt: new Date('2026-07-27T11:59:30.000Z')
				}),
			count: jest.fn().mockResolvedValueOnce(2).mockResolvedValueOnce(1)
		},
		notificationDeliveryFailure: {
			count: jest.fn().mockResolvedValueOnce(4).mockResolvedValueOnce(1),
			groupBy: jest.fn().mockResolvedValue([
				{
					category: 'TRANSIENT',
					normalizedCode: 'TIMEOUT',
					_count: { _all: 2 }
				},
				{
					category: 'TRANSIENT',
					normalizedCode: 'UNCLASSIFIED',
					_count: { _all: 1 }
				},
				{
					category: 'RATE_LIMIT',
					normalizedCode: 'TELEGRAM_RATE_LIMIT',
					_count: { _all: 1 }
				}
			])
		},
		notificationDeliveryReceipt: {
			count: jest.fn().mockResolvedValue(7)
		},
		notificationDeliveryHeartbeat: {
			findMany: jest.fn().mockResolvedValue(heartbeats)
		}
	}) as unknown as NotificationDeliveryPrismaService;

describe('NotificationDeliveryControlService', () => {
	afterEach(() => {
		jest.useRealTimers();
	});

	it('reports active heartbeat instances and latest worker activity', async () => {
		jest
			.useFakeTimers()
			.setSystemTime(new Date('2026-07-27T12:00:00.000Z'));
		const prisma = createOverviewPrisma([
			{
				service: 'notification-delivery-worker',
				instanceId: 'active',
				lastSeenAt: new Date('2026-07-27T11:59:50.000Z'),
				metadata: {
					status: 'running',
					lastSuccessfulConsumeAt: '2026-07-27T11:59:45.000Z',
					lastSuccessfulPublishAt: '2026-07-27T11:59:40.000Z'
				}
			},
			{
				service: 'notification-delivery-worker',
				instanceId: 'stale',
				lastSeenAt: new Date('2026-07-27T11:58:00.000Z'),
				metadata: {
					status: 'running',
					lastSuccessfulConsumeAt: 'invalid-date',
					lastSuccessfulPublishAt: '2026-07-27T11:59:55.000Z'
				}
			},
			{
				service: 'notification-delivery-worker',
				instanceId: 'stopping',
				lastSeenAt: new Date('2026-07-27T11:59:59.000Z'),
				metadata: {
					status: 'stopping',
					lastSuccessfulConsumeAt: '2026-07-27T11:59:59.000Z',
					lastSuccessfulPublishAt: '2026-07-27T11:59:59.000Z'
				}
			}
		]);
		const service = new NotificationDeliveryControlService(prisma);

		const overview = await service.getOverview();

		expect(overview.heartbeat).toEqual({
			service: 'notification-delivery-worker',
			status: 'ok',
			activeInstances: 1,
			lastSeenAt: '2026-07-27T11:59:50.000Z',
			lastSuccessfulPublishAt: '2026-07-27T11:59:55.000Z',
			lastSuccessfulConsumeAt: '2026-07-27T11:59:45.000Z'
		});
		expect(overview.operational).toEqual({
			staleOutbox: 2,
			dueOutbox: 1,
			unresolvedFailuresByCategory: {
				TRANSIENT: 2,
				RATE_LIMIT: 1,
				PERMANENT: 0,
				AUTH_CONFIGURATION: 0,
				UNCLASSIFIED: 1
			}
		});
		expect(overview.oldestPendingAt).toBe('2026-07-27T11:59:00.000Z');
		expect(overview.outbox.FAILED).toBe(1);
		expect(
			prisma.notificationDeliveryFailure.groupBy
		).toHaveBeenCalledWith(
			expect.objectContaining({
				by: ['category', 'normalizedCode']
			})
		);
		expect(
			prisma.notificationDeliveryHeartbeat.findMany
		).toHaveBeenCalledWith({
			where: { service: 'notification-delivery-worker' },
			orderBy: { lastSeenAt: 'desc' }
		});
	});

	it('excludes future pending work and uses an expired publishing lease for backlog age', async () => {
		jest
			.useFakeTimers()
			.setSystemTime(new Date('2026-07-27T12:00:00.000Z'));
		const prisma = createOverviewPrisma([]);
		(prisma.notificationDeliveryOutboxEvent.findFirst as jest.Mock)
			.mockReset()
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce({
				leaseExpiresAt: new Date('2026-07-27T11:59:45.000Z')
			});
		const service = new NotificationDeliveryControlService(prisma);

		const overview = await service.getOverview();

		expect(overview.oldestPendingAt).toBe('2026-07-27T11:59:45.000Z');
		expect(
			prisma.notificationDeliveryOutboxEvent.findFirst
		).toHaveBeenNthCalledWith(1, {
			where: {
				status: NotificationDeliveryOutboxStatus.PENDING,
				availableAt: { lte: new Date('2026-07-27T12:00:00.000Z') }
			},
			orderBy: { availableAt: 'asc' },
			select: { availableAt: true }
		});
		expect(
			prisma.notificationDeliveryOutboxEvent.findFirst
		).toHaveBeenNthCalledWith(2, {
			where: {
				status: NotificationDeliveryOutboxStatus.PUBLISHING,
				leaseExpiresAt: {
					lte: new Date('2026-07-27T12:00:00.000Z')
				}
			},
			orderBy: { leaseExpiresAt: 'asc' },
			select: { leaseExpiresAt: true }
		});
		expect(
			prisma.notificationDeliveryOutboxEvent.count
		).toHaveBeenNthCalledWith(1, {
			where: {
				OR: [
					{
						status: NotificationDeliveryOutboxStatus.PENDING,
						availableAt: {
							lt: new Date('2026-07-27T11:45:00.000Z')
						}
					},
					{
						status: NotificationDeliveryOutboxStatus.PUBLISHING,
						leaseExpiresAt: {
							lt: new Date('2026-07-27T11:45:00.000Z')
						}
					}
				]
			}
		});
		expect(
			prisma.notificationDeliveryOutboxEvent.count
		).toHaveBeenNthCalledWith(2, {
			where: {
				OR: [
					{
						status: NotificationDeliveryOutboxStatus.PENDING,
						availableAt: {
							lte: new Date('2026-07-27T12:00:00.000Z')
						}
					},
					{
						status: NotificationDeliveryOutboxStatus.PUBLISHING,
						leaseExpiresAt: {
							lte: new Date('2026-07-27T12:00:00.000Z')
						}
					}
				]
			}
		});
	});

	it.each([
		{
			label: 'stale',
			heartbeats: [
				{
					service: 'notification-delivery-worker',
					instanceId: 'stale',
					lastSeenAt: new Date('2026-07-27T11:59:00.000Z'),
					metadata: { status: 'running' }
				}
			],
			lastSeenAt: '2026-07-27T11:59:00.000Z'
		},
		{
			label: 'missing',
			heartbeats: [],
			lastSeenAt: null
		}
	])(
		'normalizes a $label worker heartbeat to the compatible down status',
		async ({ heartbeats, lastSeenAt }) => {
			jest
				.useFakeTimers()
				.setSystemTime(new Date('2026-07-27T12:00:00.000Z'));
			const service = new NotificationDeliveryControlService(
				createOverviewPrisma(heartbeats)
			);

			const overview = await service.getOverview();

			expect(overview.heartbeat).toEqual({
				service: 'notification-delivery-worker',
				status: 'down',
				activeInstances: 0,
				lastSeenAt,
				lastSuccessfulPublishAt: null,
				lastSuccessfulConsumeAt: null
			});
		}
	);

	it('queues an isolated manual retry in the service outbox transaction', async () => {
		const failure = createFailure();
		const transaction = {
			notificationDeliveryFailure: {
				findUnique: jest.fn().mockResolvedValue(failure),
				updateMany: jest.fn().mockResolvedValue({ count: 1 })
			},
			notificationDeliveryReceipt: {
				updateMany: jest.fn().mockResolvedValue({ count: 1 })
			},
			notificationDeliveryOutboxEvent: {
				create: jest.fn().mockResolvedValue({ id: 'outbox-1' })
			},
			notificationDeliveryControlAction: {
				create: jest.fn().mockResolvedValue({ id: 'action-1' })
			}
		};
		const prisma = {
			$transaction: jest.fn(async callback => callback(transaction))
		} as unknown as NotificationDeliveryPrismaService;
		const service = new NotificationDeliveryControlService(prisma);
		const request = {
			headers: {
				'x-request-id': 'admin-request-123',
				'x-correlation-id': 'admin-correlation-456'
			}
		} as unknown as Request;
		const response = {
			setHeader: jest.fn()
		} as unknown as Response;

		const result = await new Promise<{
			id: string;
			eventId: string;
			integration: string;
			retryingAt: string;
		}>((resolve, reject) => {
			messagingContextMiddleware(request, response, (() => {
				void service
					.retryFailure(FAILURE_ID, 'admin-user-id')
					.then(resolve, reject);
			}) as NextFunction);
		});

		expect(
			transaction.notificationDeliveryFailure.updateMany
		).toHaveBeenCalledWith({
			where: expect.objectContaining({
				id: FAILURE_ID,
				consumer: 'email',
				resolvedAt: null
			}),
			data: {
				retryingAt: expect.any(Date),
				activeRetryToken: expect.any(String)
			}
		});
		expect(
			transaction.notificationDeliveryReceipt.updateMany
		).toHaveBeenCalledWith({
			where: expect.objectContaining({
				eventId: EVENT_ID,
				consumer: 'email'
			}),
			data: expect.objectContaining({
				status: NotificationDeliveryReceiptStatus.RETRY_SCHEDULED,
				retryAttempt: 0,
				retryAvailableAt: expect.any(Date),
				retryToken: expect.any(String)
			})
		});
		expect(
			transaction.notificationDeliveryOutboxEvent.create
		).toHaveBeenCalledWith({
			data: expect.objectContaining({
				messageId: EVENT_ID,
				deduplicationKey: expect.stringMatching(
					/^manual-retry:22222222-2222-4222-8222-222222222222:/
				),
				exchange: NotificationDeliveryExchange.EVENTS,
				eventType: 'lead.integration.requested.v2',
				routingKey: 'manual.email',
				payload: failure.payload,
				headers: expect.objectContaining({
					'x-retry-attempt': 0,
					'x-delivery-token': expect.any(String),
					'x-control-actor-id': 'admin-user-id',
					'x-correlation-id': 'admin-correlation-456',
					'x-request-id': 'admin-request-123',
					'x-causation-id': EVENT_ID
				})
			})
		});
		expect(
			transaction.notificationDeliveryControlAction.create
		).toHaveBeenCalledWith({
			data: {
				action: NotificationDeliveryControlActionKind.RETRY,
				failureId: FAILURE_ID,
				eventId: EVENT_ID,
				kind: 'email',
				actorId: 'admin-user-id',
				comment: null,
				createdAt: expect.any(Date)
			}
		});
		expect(result).toEqual({
			id: FAILURE_ID,
			eventId: EVENT_ID,
			integration: 'email',
			retryingAt: expect.any(String)
		});
	});

	it('rejects a malformed event before changing state', async () => {
		const failure = createFailure({
			payload: {
				eventType: 'lead.integration.requested.v2',
				integration: 'email'
			}
		});
		const updateFailure = jest.fn();
		const updateReceipt = jest.fn();
		const createOutbox = jest.fn();
		const transaction = {
			notificationDeliveryFailure: {
				findUnique: jest.fn().mockResolvedValue(failure),
				updateMany: updateFailure
			},
			notificationDeliveryReceipt: { updateMany: updateReceipt },
			notificationDeliveryOutboxEvent: { create: createOutbox }
		};
		const prisma = {
			$transaction: jest.fn(async callback => callback(transaction))
		} as unknown as NotificationDeliveryPrismaService;
		const service = new NotificationDeliveryControlService(prisma);

		await expect(
			service.retryFailure(FAILURE_ID, 'admin-user-id')
		).rejects.toThrow(ConflictException);
		expect(updateFailure).not.toHaveBeenCalled();
		expect(updateReceipt).not.toHaveBeenCalled();
		expect(createOutbox).not.toHaveBeenCalled();
	});

	it('does not expose or operate on a consumer owned by another service', async () => {
		const transaction = {
			notificationDeliveryFailure: {
				findUnique: jest
					.fn()
					.mockResolvedValue(createFailure({ consumer: 'webhook' }))
			}
		};
		const prisma = {
			$transaction: jest.fn(async callback => callback(transaction))
		} as unknown as NotificationDeliveryPrismaService;
		const service = new NotificationDeliveryControlService(prisma);

		await expect(
			service.retryFailure(FAILURE_ID, 'admin-user-id')
		).rejects.toThrow(NotFoundException);
	});

	it('requires campaign retries to go through Campaigns API', async () => {
		const updateFailure = jest.fn();
		const updateReceipt = jest.fn();
		const createOutbox = jest.fn();
		const transaction = {
			notificationDeliveryFailure: {
				findUnique: jest
					.fn()
					.mockResolvedValue(
						createFailure({ consumer: 'campaign-email' })
					),
				updateMany: updateFailure
			},
			notificationDeliveryReceipt: { updateMany: updateReceipt },
			notificationDeliveryOutboxEvent: { create: createOutbox }
		};
		const prisma = {
			$transaction: jest.fn(async callback => callback(transaction))
		} as unknown as NotificationDeliveryPrismaService;
		const service = new NotificationDeliveryControlService(prisma);

		await expect(
			service.retryFailure(FAILURE_ID, 'admin-user-id')
		).rejects.toThrow(
			'Повтор доставки кампании доступен только через Campaigns API'
		);
		expect(updateFailure).not.toHaveBeenCalled();
		expect(updateReceipt).not.toHaveBeenCalled();
		expect(createOutbox).not.toHaveBeenCalled();
	});

	it('closes the receipt and failure atomically without publishing', async () => {
		const failure = createFailure();
		const transaction = {
			notificationDeliveryFailure: {
				findUnique: jest.fn().mockResolvedValue(failure),
				updateMany: jest.fn().mockResolvedValue({ count: 1 })
			},
			notificationDeliveryReceipt: {
				updateMany: jest.fn().mockResolvedValue({ count: 1 })
			},
			notificationDeliveryOutboxEvent: {
				create: jest.fn()
			},
			notificationDeliveryControlAction: {
				create: jest.fn().mockResolvedValue({ id: 'action-1' })
			}
		};
		const prisma = {
			$transaction: jest.fn(async callback => callback(transaction))
		} as unknown as NotificationDeliveryPrismaService;
		const service = new NotificationDeliveryControlService(prisma);

		const result = await service.closeFailure(
			FAILURE_ID,
			'admin-user-id',
			'Проверено и закрыто вручную'
		);

		expect(
			transaction.notificationDeliveryFailure.updateMany
		).toHaveBeenCalledWith({
			where: {
				id: FAILURE_ID,
				consumer: 'email',
				resolvedAt: null,
				retryingAt: null,
				activeRetryToken: null
			},
			data: {
				resolvedAt: expect.any(Date),
				resolution: 'CLOSED_NO_RETRY',
				resolutionComment: 'Проверено и закрыто вручную',
				resolvedById: 'admin-user-id',
				activeRetryToken: null
			}
		});
		expect(
			transaction.notificationDeliveryReceipt.updateMany
		).toHaveBeenCalledWith({
			where: {
				eventId: EVENT_ID,
				consumer: 'email',
				status: NotificationDeliveryReceiptStatus.DEAD_LETTERED
			},
			data: {
				status: NotificationDeliveryReceiptStatus.CLOSED_NO_RETRY,
				lockedAt: null,
				lockedBy: null,
				lockToken: null,
				leaseExpiresAt: null,
				deliveredAt: null,
				retryAttempt: null,
				retryAvailableAt: null,
				retryToken: null
			}
		});
		expect(
			transaction.notificationDeliveryOutboxEvent.create
		).not.toHaveBeenCalled();
		expect(
			transaction.notificationDeliveryControlAction.create
		).toHaveBeenCalledWith({
			data: {
				action: NotificationDeliveryControlActionKind.CLOSE,
				failureId: FAILURE_ID,
				eventId: EVENT_ID,
				kind: 'email',
				actorId: 'admin-user-id',
				comment: 'Проверено и закрыто вручную',
				createdAt: expect.any(Date)
			}
		});
		expect(result).toEqual({
			id: FAILURE_ID,
			eventId: EVENT_ID,
			integration: 'email',
			resolvedAt: expect.any(String),
			resolution: 'CLOSED_NO_RETRY',
			resolutionComment: 'Проверено и закрыто вручную'
		});
	});

	it('keeps the internal failure query scoped to owned consumers', async () => {
		const findMany = jest.fn().mockResolvedValue([]);
		const count = jest.fn().mockResolvedValue(0);
		const prisma = {
			notificationDeliveryFailure: { findMany, count },
			$transaction: jest.fn(async queries => Promise.all(queries))
		} as unknown as NotificationDeliveryPrismaService;
		const service = new NotificationDeliveryControlService(prisma);

		await service.getFailures({ page: 2, limit: 10_000 });

		expect(findMany).toHaveBeenCalledWith({
			where: {
				consumer: {
					in: [
						'email',
						'telegram',
						'payment-email',
						'payment-telegram',
						'limit-email',
						'limit-telegram',
						'campaign-email',
						'campaign-telegram',
						'daily-summary-delivery-telegram',
						'subscription-expiry-email',
						'subscription-expiry-telegram'
					]
				}
			},
			orderBy: [{ failedAt: 'desc' }, { id: 'desc' }],
			skip: 10_000,
			take: 10_000
		});
	});
});
