import type { AdminEventLogService } from '@/admin-event-log/admin-event-log.service';
import type { BillingCoreStateService } from '@/billing-boundary/billing-core-state.service';
import {
	BillingMessagingClientService,
	BillingMessagingInternalApiError
} from '@/messaging/billing-messaging-client.service';
import type { IdentityMessagingClientService } from '@/messaging/identity-messaging-client.service';
import { MessagingAdminService } from '@/messaging/messaging-admin.service';
import {
	CORE_ARCHIVED_FAILURE_HISTORY_KINDS,
	CORE_OWNED_MESSAGING_KINDS
} from '@/messaging/messaging.constants';
import {
	NOTIFICATION_DELIVERY_DAILY_SUMMARY_ADMIN_KIND,
	NotificationDeliveryClientService,
	NotificationDeliveryInternalApiError
} from '@/messaging/notification-delivery-client.service';
import type { ServiceOwnedMessagingOverviewClientService } from '@/messaging/service-owned-messaging-overview-client.service';
import type { RabbitMqManagementService } from '@/messaging/rabbitmq-management.service';
import type { WidgetsDeliveryFailuresClientService } from '@/messaging/widgets-delivery-failures-client.service';
import type { PrismaService } from '@/prisma.service';
import {
	BadRequestException,
	ConflictException,
	Logger
} from '@nestjs/common';

describe('MessagingAdminService', () => {
	const notificationDelivery =
		{} as unknown as NotificationDeliveryClientService;
	const widgetsFailures =
		{} as unknown as WidgetsDeliveryFailuresClientService;
	const remoteFailure = (
		id: string,
		integration: string,
		failedAt: string
	) => ({
		id,
		eventId: id,
		integration,
		attempts: 1,
		lastError: 'timeout',
		category: 'TRANSIENT',
		normalizedCode: 'TIMEOUT',
		safeReason: 'Provider request timed out',
		httpStatus: null,
		providerCode: null,
		retryable: true,
		failedAt,
		retryingAt: null,
		resolvedAt: null,
		resolution: null,
		resolutionComment: null,
		source: null,
		entity: {},
		lead: {
			id: null,
			contact: null,
			phone: null,
			email: null,
			url: null,
			createdAt: null
		}
	});

	afterEach(() => {
		jest.restoreAllMocks();
	});

	it('aggregates service-owned Widgets metrics and heartbeats', async () => {
		const prisma = {
			outboxEvent: {
				groupBy: jest.fn().mockResolvedValue([
					{ status: 'PENDING', _count: { _all: 1 } },
					{ status: 'PUBLISHED', _count: { _all: 5 } }
				]),
				findFirst: jest.fn().mockResolvedValue(null)
			},
			integrationDeliveryFailure: {
				count: jest.fn().mockResolvedValueOnce(2).mockResolvedValueOnce(1)
			},
			integrationDeliveryReceipt: {
				count: jest.fn().mockResolvedValue(3)
			},
			scheduledJobRun: {
				count: jest.fn().mockResolvedValue(4)
			},
			messagingHeartbeat: {
				findMany: jest.fn().mockResolvedValue([])
			}
		} as unknown as PrismaService;
		const notification = {
			getOverview: jest.fn().mockResolvedValue({
				outbox: { PENDING: 2, PUBLISHING: 0, PUBLISHED: 6, FAILED: 0 },
				oldestPendingAt: null,
				unresolvedFailures: 5,
				retryingFailures: 2,
				deliveredLast24Hours: 7,
				heartbeat: {
					service: 'notification-delivery-worker',
					status: 'ok',
					activeInstances: 1,
					lastSeenAt: '2026-08-05T11:59:55.000Z'
				}
			})
		} as unknown as NotificationDeliveryClientService;
		const widgets = {
			getOverview: jest.fn().mockResolvedValue({
				outbox: { PENDING: 3, PUBLISHING: 1, PUBLISHED: 8, FAILED: 1 },
				oldestPendingAt: '2026-08-05T11:58:00.000Z',
				unresolvedFailures: 6,
				retryingFailures: 3,
				deliveredLast24Hours: 9,
				heartbeats: [
					{
						service: 'widgets-api',
						status: 'ok',
						activeInstances: 1,
						lastSeenAt: '2026-08-05T11:59:55.000Z'
					},
					{
						service: 'widgets-worker',
						status: 'ok',
						activeInstances: 1,
						lastSeenAt: '2026-08-05T11:59:55.000Z'
					},
					{
						service: 'widgets-publisher',
						status: 'ok',
						activeInstances: 1,
						lastSeenAt: '2026-08-05T11:59:55.000Z'
					}
				]
			})
		} as unknown as WidgetsDeliveryFailuresClientService;
		const service = new MessagingAdminService(
			prisma,
			{
				getMessagingQueues: jest.fn().mockResolvedValue([])
			} as unknown as RabbitMqManagementService,
			{} as AdminEventLogService,
			notification,
			widgets
		);

		await expect(service.getOverview()).resolves.toEqual(
			expect.objectContaining({
				outbox: { PENDING: 6, PUBLISHING: 1, PUBLISHED: 19, FAILED: 1 },
				oldestPendingAt: '2026-08-05T11:58:00.000Z',
				unresolvedFailures: 13,
				retryingFailures: 6,
				processedLast24Hours: 19,
				completedBackupsLast24Hours: 4,
				widgetsError: null,
				heartbeats: expect.arrayContaining([
					expect.objectContaining({ service: 'widgets-publisher' })
				])
			})
		);
		expect(prisma.scheduledJobRun.count).toHaveBeenCalledWith({
			where: {
				jobType: {
					in: [
						'DATABASE_BACKUP',
						'NOTIFICATION_DELIVERY_DATABASE_BACKUP',
						'CAMPAIGNS_DATABASE_BACKUP',
						'REPORTING_DATABASE_BACKUP',
						'WIDGETS_DATABASE_BACKUP',
						'BILLING_DATABASE_BACKUP',
						'IDENTITY_DATABASE_BACKUP'
					]
				},
				status: 'SUCCEEDED',
				finishedAt: { gte: expect.any(Date) }
			}
		});
	});

	it('keeps Campaigns metrics while Reporting is unavailable and reports that owner as down', async () => {
		const prisma = {
			outboxEvent: {
				groupBy: jest.fn().mockResolvedValue([]),
				findFirst: jest.fn().mockResolvedValue(null)
			},
			integrationDeliveryFailure: {
				count: jest.fn().mockResolvedValue(0)
			},
			integrationDeliveryReceipt: {
				count: jest.fn().mockResolvedValue(1)
			},
			scheduledJobRun: {
				count: jest.fn().mockResolvedValue(2)
			},
			messagingHeartbeat: {
				findMany: jest.fn().mockResolvedValue([])
			}
		} as unknown as PrismaService;
		const campaignsOverview = {
			schemaVersion: 1 as const,
			generatedAt: '2026-08-15T12:00:00.000Z',
			outbox: { PENDING: 1, PUBLISHING: 2, PUBLISHED: 3, FAILED: 4 },
			oldestPendingAt: '2026-08-15T11:59:00.000Z',
			unresolvedFailures: 5,
			retryingFailures: 6,
			processedLast24Hours: 7,
			heartbeats: [
				{
					service: 'campaigns-api' as const,
					status: 'ok' as const,
					activeInstances: 1,
					lastSeenAt: '2026-08-15T12:00:00.000Z'
				},
				{
					service: 'campaigns-worker' as const,
					status: 'down' as const,
					activeInstances: 0,
					lastSeenAt: null
				},
				{
					service: 'campaigns-outbox-publisher' as const,
					status: 'down' as const,
					activeInstances: 0,
					lastSeenAt: null
				}
			]
		};
		const serviceOwnedOverview = {
			getCampaignsOverview: jest.fn().mockResolvedValue(campaignsOverview),
			getReportingOverview: jest
				.fn()
				.mockRejectedValue(new Error('Reporting overview timeout'))
		} as unknown as ServiceOwnedMessagingOverviewClientService;
		const service = new MessagingAdminService(
			prisma,
			{
				getMessagingQueues: jest.fn().mockResolvedValue([])
			} as unknown as RabbitMqManagementService,
			{} as AdminEventLogService,
			{
				getOverview: jest
					.fn()
					.mockRejectedValue(
						new Error('Notification Delivery unavailable')
					)
			} as unknown as NotificationDeliveryClientService,
			{
				getOverview: jest
					.fn()
					.mockRejectedValue(new Error('Widgets unavailable'))
			} as unknown as WidgetsDeliveryFailuresClientService,
			undefined,
			undefined,
			undefined,
			serviceOwnedOverview
		);

		await expect(service.getOverview()).resolves.toEqual(
			expect.objectContaining({
				outbox: { PENDING: 1, PUBLISHING: 2, PUBLISHED: 3, FAILED: 4 },
				oldestPendingAt: '2026-08-15T11:59:00.000Z',
				unresolvedFailures: 5,
				retryingFailures: 6,
				processedLast24Hours: 8,
				completedBackupsLast24Hours: 2,
				campaignsError: null,
				reportingError: 'Reporting overview timeout',
				heartbeats: expect.arrayContaining([
					expect.objectContaining({
						service: 'campaigns-api',
						status: 'ok',
						activeInstances: 1
					}),
					expect.objectContaining({
						service: 'reporting-api',
						status: 'down',
						activeInstances: 0
					}),
					expect.objectContaining({
						service: 'reporting-scheduler',
						status: 'down',
						activeInstances: 0
					})
				])
			})
		);
		expect(
			serviceOwnedOverview.getCampaignsOverview
		).toHaveBeenCalledTimes(1);
		expect(
			serviceOwnedOverview.getReportingOverview
		).toHaveBeenCalledTimes(1);
	});

	it('routes an Identity-owned destination retry without touching the Core Outbox', async () => {
		const result = {
			id: '22222222-2222-4222-8222-222222222222',
			eventId: '11111111-1111-4111-8111-111111111111',
			integration: 'telegram-destination-unavailable' as const,
			retryingAt: '2026-08-14T12:00:00.000Z'
		};
		const transaction = jest.fn();
		const prisma = {
			integrationDeliveryFailure: {
				findFirst: jest.fn().mockResolvedValue(null)
			},
			$transaction: transaction
		} as unknown as PrismaService;
		const identityRetry = jest.fn().mockResolvedValue(result);
		const service = new MessagingAdminService(
			prisma,
			{} as RabbitMqManagementService,
			{} as AdminEventLogService,
			notificationDelivery,
			widgetsFailures,
			undefined,
			undefined,
			{
				retryFailure: identityRetry
			} as unknown as IdentityMessagingClientService
		);

		await expect(
			service.retryFailure(result.id, 'admin-1')
		).resolves.toEqual(result);
		expect(identityRetry).toHaveBeenCalledWith(result.id, 'admin-1');
		expect(transaction).not.toHaveBeenCalled();
	});

	it('queues a Reporting audit retry through the same transaction as its receipt claim', async () => {
		const eventId = '11111111-1111-4111-8111-111111111111';
		const failure = {
			id: '22222222-2222-4222-8222-222222222222',
			eventId,
			integration: 'reporting-admin-audit',
			payload: {
				schemaVersion: 1,
				eventType: 'admin.audit.event.v1',
				eventId,
				occurredAt: '2026-07-31T12:00:00.000Z',
				correlationId: 'request:reporting-settings-42',
				actorId: 'admin-user-id',
				action: 'REPORTING_DAILY_SUMMARY_SETTINGS_UPDATE',
				target: { reportingSettingsId: 'daily-summary' },
				metadata: { changedFields: ['enabled'] }
			},
			category: 'TRANSIENT',
			resolvedAt: null,
			retryingAt: null
		};
		const transaction = {
			$queryRaw: jest.fn().mockResolvedValue([{ id: 'receipt-1' }]),
			integrationDeliveryFailure: {
				findUnique: jest.fn().mockResolvedValue(failure),
				updateMany: jest.fn().mockResolvedValue({ count: 1 })
			},
			outboxEvent: {
				create: jest.fn().mockResolvedValue({ id: 'outbox-1' })
			}
		};
		const prisma = {
			integrationDeliveryFailure: {
				findFirst: jest.fn().mockResolvedValue({ id: failure.id })
			},
			$transaction: jest.fn(async callback => callback(transaction))
		} as unknown as PrismaService;
		const adminEventLog = {
			recordInTransaction: jest.fn().mockResolvedValue({})
		} as unknown as AdminEventLogService;
		const service = new MessagingAdminService(
			prisma,
			{} as RabbitMqManagementService,
			adminEventLog,
			notificationDelivery,
			widgetsFailures
		);

		await service.retryFailure(failure.id, 'dev-user-id');

		expect(transaction.$queryRaw).toHaveBeenCalledTimes(1);
		expect(transaction.outboxEvent.create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				messageId: eventId,
				eventType: 'admin.audit.event.v1',
				routingKey: 'manual.reporting-admin-audit',
				payload: failure.payload,
				headers: expect.objectContaining({
					'x-retry-attempt': 0,
					'x-delivery-token': expect.any(String)
				})
			})
		});
		expect(adminEventLog.recordInTransaction).toHaveBeenCalledWith(
			transaction,
			expect.objectContaining({
				adminId: 'dev-user-id',
				action: 'MESSAGING_FAILURE_RETRY',
				metadata: {
					eventId,
					integration: 'reporting-admin-audit'
				}
			})
		);
	});

	it('routes a Widgets-owned provider retry without querying Core history', async () => {
		const id = '22222222-2222-4222-8222-222222222222';
		const result = {
			id,
			eventId: '11111111-1111-4111-8111-111111111111',
			integration: 'webhook' as const,
			retryingAt: '2026-08-05T00:00:00.000Z'
		};
		const transaction = jest.fn();
		const prisma = {
			integrationDeliveryFailure: {
				findFirst: jest.fn().mockResolvedValue(null)
			},
			$transaction: transaction
		} as unknown as PrismaService;
		const remote = {
			retryFailure: jest
				.fn()
				.mockRejectedValue(
					new NotificationDeliveryInternalApiError(404, 'Не найдено')
				)
		} as unknown as NotificationDeliveryClientService;
		const widgets = {
			retryFailure: jest.fn().mockResolvedValue(result)
		} as unknown as WidgetsDeliveryFailuresClientService;
		const service = new MessagingAdminService(
			prisma,
			{} as RabbitMqManagementService,
			{} as AdminEventLogService,
			remote,
			widgets
		);

		await expect(service.retryFailure(id, 'cuid-admin')).resolves.toEqual(
			result
		);
		expect(
			prisma.integrationDeliveryFailure.findFirst
		).toHaveBeenCalledWith({
			where: {
				id,
				integration: {
					in: [...CORE_OWNED_MESSAGING_KINDS]
				}
			},
			select: { id: true }
		});
		expect(transaction).not.toHaveBeenCalled();
	});

	it('routes a Widgets-owned provider close without writing a duplicate Core audit', async () => {
		const id = '22222222-2222-4222-8222-222222222222';
		const result = {
			id,
			eventId: '11111111-1111-4111-8111-111111111111',
			integration: 'amo-crm' as const,
			resolvedAt: '2026-08-05T00:00:00.000Z',
			resolution: 'CLOSED_NO_RETRY' as const,
			resolutionComment: 'Проверено вручную'
		};
		const transaction = jest.fn();
		const prisma = {
			integrationDeliveryFailure: {
				findFirst: jest.fn().mockResolvedValue(null)
			},
			$transaction: transaction
		} as unknown as PrismaService;
		const notificationClose = jest
			.fn()
			.mockRejectedValue(
				new NotificationDeliveryInternalApiError(404, 'Не найдено')
			);
		const widgetsClose = jest.fn().mockResolvedValue(result);
		const adminEventLog = {
			record: jest.fn(),
			recordInTransaction: jest.fn()
		} as unknown as AdminEventLogService;
		const service = new MessagingAdminService(
			prisma,
			{} as RabbitMqManagementService,
			adminEventLog,
			{
				closeFailure: notificationClose
			} as unknown as NotificationDeliveryClientService,
			{
				closeFailure: widgetsClose
			} as unknown as WidgetsDeliveryFailuresClientService
		);

		await expect(
			service.closeFailure(
				id,
				'cm0abc1230000qwertyuiopas',
				'Проверено вручную'
			)
		).resolves.toEqual(result);
		expect(widgetsClose).toHaveBeenCalledWith(
			id,
			'cm0abc1230000qwertyuiopas',
			'Проверено вручную'
		);
		expect(transaction).not.toHaveBeenCalled();
		expect(adminEventLog.record).not.toHaveBeenCalled();
		expect(adminEventLog.recordInTransaction).not.toHaveBeenCalled();
	});

	it('rejects a malformed non-lead retry before changing its state', async () => {
		const failure = {
			id: '22222222-2222-4222-8222-222222222222',
			eventId: '11111111-1111-4111-8111-111111111111',
			integration: 'reporting-admin-audit',
			payload: {
				schemaVersion: 1,
				eventType: 'payment.succeeded.v1',
				payment: {
					id: 'payment-1'
				}
			},
			resolvedAt: null,
			retryingAt: null
		};
		const updateMany = jest.fn();
		const outboxCreate = jest.fn();
		const transaction = {
			integrationDeliveryFailure: {
				findUnique: jest.fn().mockResolvedValue(failure),
				updateMany
			},
			outboxEvent: {
				create: outboxCreate
			}
		};
		const prisma = {
			integrationDeliveryFailure: {
				findFirst: jest.fn().mockResolvedValue({ id: failure.id })
			},
			$transaction: jest.fn(async callback => callback(transaction))
		} as unknown as PrismaService;
		const service = new MessagingAdminService(
			prisma,
			{} as RabbitMqManagementService,
			{
				recordInTransaction: jest.fn()
			} as unknown as AdminEventLogService,
			notificationDelivery,
			widgetsFailures
		);

		await expect(
			service.retryFailure(failure.id, 'admin-1')
		).rejects.toThrow(
			'Повтор события с некорректным контрактом недоступен'
		);
		expect(updateMany).not.toHaveBeenCalled();
		expect(outboxCreate).not.toHaveBeenCalled();
	});

	it.each([
		'DATABASE_BACKUP',
		'NOTIFICATION_DELIVERY_DATABASE_BACKUP',
		'CAMPAIGNS_DATABASE_BACKUP',
		'REPORTING_DATABASE_BACKUP',
		'WIDGETS_DATABASE_BACKUP',
		'BILLING_DATABASE_BACKUP',
		'IDENTITY_DATABASE_BACKUP'
	])(
		'reopens a failed %s job in the same transaction as manual retry Outbox',
		async jobType => {
			const eventId = '11111111-1111-4111-8111-111111111111';
			const failure = {
				id: '22222222-2222-4222-8222-222222222222',
				eventId,
				integration: 'database-backup',
				payload: {
					schemaVersion: 1,
					eventType: 'database.backup.requested.v1',
					jobId: eventId,
					jobType,
					scheduleKey: `manual:${eventId}`,
					periodStart: null,
					periodEnd: null
				},
				resolvedAt: null,
				retryingAt: null
			};
			const transaction = {
				$queryRaw: jest.fn().mockResolvedValue([{ id: 'receipt-1' }]),
				integrationDeliveryFailure: {
					findUnique: jest.fn().mockResolvedValue(failure),
					updateMany: jest.fn().mockResolvedValue({ count: 1 })
				},
				scheduledJobRun: {
					updateMany: jest.fn().mockResolvedValue({ count: 1 })
				},
				outboxEvent: {
					create: jest.fn().mockResolvedValue({ id: 'outbox-1' })
				}
			};
			const prisma = {
				integrationDeliveryFailure: {
					findUnique: jest.fn().mockResolvedValue(failure),
					findFirst: jest.fn().mockResolvedValue({ id: failure.id })
				},
				$transaction: jest.fn(async callback => callback(transaction))
			} as unknown as PrismaService;
			const service = new MessagingAdminService(
				prisma,
				{} as RabbitMqManagementService,
				{
					recordInTransaction: jest.fn().mockResolvedValue({})
				} as unknown as AdminEventLogService,
				notificationDelivery,
				widgetsFailures
			);

			await service.retryFailure(failure.id, 'admin-1');

			expect(transaction.scheduledJobRun.updateMany).toHaveBeenCalledWith({
				where: {
					id: eventId,
					jobType,
					status: 'FAILED'
				},
				data: expect.objectContaining({
					status: 'QUEUED',
					maxAttempts: { increment: 4 },
					finishedAt: null,
					leaseOwner: null,
					leaseToken: null,
					leaseExpiresAt: null
				})
			});
			expect(transaction.outboxEvent.create).toHaveBeenCalledWith({
				data: {
					messageId: eventId,
					eventType: 'database.backup.requested.v1',
					routingKey: 'manual.database-backup',
					payload: failure.payload,
					headers: {
						'x-correlation-id': eventId,
						'x-request-id': eventId,
						'x-causation-id': eventId
					}
				}
			});
		}
	);

	it('labels a failed Billing backup job in the federated failure view', () => {
		const service = new MessagingAdminService(
			{} as PrismaService,
			{} as RabbitMqManagementService,
			{} as AdminEventLogService,
			notificationDelivery,
			widgetsFailures
		);
		const result = (service as any).serializeFailure({
			id: '22222222-2222-4222-8222-222222222222',
			eventId: '11111111-1111-4111-8111-111111111111',
			integration: 'database-backup',
			attempts: 1,
			lastError: 'backup failed',
			category: 'TRANSIENT',
			normalizedCode: 'BACKUP_FAILED',
			safeReason: 'Backup failed',
			httpStatus: null,
			providerCode: null,
			retryable: true,
			failedAt: new Date('2026-08-11T00:00:00.000Z'),
			retryingAt: null,
			resolvedAt: null,
			resolution: null,
			resolutionComment: null,
			payload: {
				jobId: '33333333-3333-4333-8333-333333333333',
				jobType: 'BILLING_DATABASE_BACKUP'
			}
		});

		expect(result.entity).toEqual({
			id: '33333333-3333-4333-8333-333333333333',
			name: 'Backup PostgreSQL Billing'
		});
	});

	it('closes an unresolved Core-owned failure without publishing', async () => {
		const failure = {
			id: '22222222-2222-4222-8222-222222222222',
			eventId: '11111111-1111-4111-8111-111111111111',
			integration: 'widgets-admin-audit',
			payload: {},
			resolvedAt: null,
			retryingAt: null
		};
		const transaction = {
			$queryRaw: jest.fn().mockResolvedValue([{ id: 'receipt-1' }]),
			integrationDeliveryFailure: {
				findUnique: jest.fn().mockResolvedValue(failure),
				updateMany: jest.fn().mockResolvedValue({ count: 1 })
			},
			integrationDeliveryReceipt: {
				findUnique: jest.fn()
			},
			outboxEvent: {
				create: jest.fn()
			}
		};
		const prisma = {
			integrationDeliveryFailure: {
				findFirst: jest.fn().mockResolvedValue({ id: failure.id })
			},
			$transaction: jest.fn(async callback => callback(transaction))
		} as unknown as PrismaService;
		const adminEventLog = {
			recordInTransaction: jest.fn().mockResolvedValue({})
		} as unknown as AdminEventLogService;
		const service = new MessagingAdminService(
			prisma,
			{} as RabbitMqManagementService,
			adminEventLog,
			notificationDelivery,
			widgetsFailures
		);

		const result = await service.closeFailure(
			failure.id,
			'admin-1',
			'Причина устранена вручную'
		);

		expect(
			transaction.integrationDeliveryFailure.updateMany
		).toHaveBeenCalledWith({
			where: {
				id: failure.id,
				resolvedAt: null,
				retryingAt: null
			},
			data: {
				resolvedAt: expect.any(Date),
				resolution: 'CLOSED_NO_RETRY',
				resolutionComment: 'Причина устранена вручную',
				resolvedById: 'admin-1',
				activeRetryToken: null
			}
		});
		expect(transaction.outboxEvent.create).not.toHaveBeenCalled();
		expect(adminEventLog.recordInTransaction).toHaveBeenCalledWith(
			transaction,
			expect.objectContaining({
				action: 'MESSAGING_FAILURE_CLOSE_WITHOUT_RETRY',
				entityId: failure.id,
				adminId: 'admin-1'
			})
		);
		expect(result.resolution).toBe('CLOSED_NO_RETRY');
	});

	it('does not close a failure while a manual retry is in progress', async () => {
		const transaction = {
			$queryRaw: jest.fn().mockResolvedValue([]),
			integrationDeliveryFailure: {
				findUnique: jest.fn().mockResolvedValue({
					id: '22222222-2222-4222-8222-222222222222',
					resolvedAt: null,
					retryingAt: new Date()
				}),
				updateMany: jest.fn()
			}
		};
		const prisma = {
			integrationDeliveryFailure: {
				findFirst: jest.fn().mockResolvedValue({
					id: '22222222-2222-4222-8222-222222222222'
				})
			},
			$transaction: jest.fn(async callback => callback(transaction))
		} as unknown as PrismaService;
		const service = new MessagingAdminService(
			prisma,
			{} as RabbitMqManagementService,
			{
				recordInTransaction: jest.fn().mockResolvedValue({})
			} as unknown as AdminEventLogService,
			notificationDelivery,
			widgetsFailures
		);

		await expect(
			service.closeFailure(
				'22222222-2222-4222-8222-222222222222',
				'admin-1',
				'Повтор уже выполняется'
			)
		).rejects.toBeInstanceOf(ConflictException);
		expect(
			transaction.integrationDeliveryFailure.updateMany
		).not.toHaveBeenCalled();
	});

	it('does not close a failure while its delivery receipt is processing', async () => {
		const failure = {
			id: '22222222-2222-4222-8222-222222222222',
			eventId: '11111111-1111-4111-8111-111111111111',
			integration: 'widgets-admin-audit',
			resolvedAt: null,
			retryingAt: null
		};
		const transaction = {
			$queryRaw: jest
				.fn()
				.mockResolvedValueOnce([{ id: failure.id }])
				.mockResolvedValueOnce([]),
			integrationDeliveryFailure: {
				findUnique: jest.fn().mockResolvedValue(failure),
				updateMany: jest.fn()
			},
			integrationDeliveryReceipt: {
				findUnique: jest.fn().mockResolvedValue({
					status: 'PROCESSING'
				})
			}
		};
		const service = new MessagingAdminService(
			{
				integrationDeliveryFailure: {
					findFirst: jest.fn().mockResolvedValue({ id: failure.id })
				},
				$transaction: jest.fn(async callback => callback(transaction))
			} as unknown as PrismaService,
			{} as RabbitMqManagementService,
			{
				recordInTransaction: jest.fn().mockResolvedValue({})
			} as unknown as AdminEventLogService,
			notificationDelivery,
			widgetsFailures
		);

		await expect(
			service.closeFailure(failure.id, 'admin-1', 'Закрыть нельзя')
		).rejects.toBeInstanceOf(ConflictException);
		expect(
			transaction.integrationDeliveryFailure.updateMany
		).not.toHaveBeenCalled();
	});

	it('returns a successful remote retry when the global audit write fails', async () => {
		const remoteResult = {
			id: '22222222-2222-4222-8222-222222222222',
			eventId: '11111111-1111-4111-8111-111111111111',
			integration: 'email' as const,
			retryingAt: '2026-07-27T12:00:00.000Z'
		};
		const remote = {
			retryFailure: jest.fn().mockResolvedValue(remoteResult)
		} as unknown as NotificationDeliveryClientService;
		const adminEventLog = {
			record: jest.fn().mockRejectedValue(new Error('audit unavailable'))
		} as unknown as AdminEventLogService;
		const logger = jest
			.spyOn(Logger.prototype, 'error')
			.mockImplementation(() => undefined);
		const service = new MessagingAdminService(
			{
				integrationDeliveryFailure: {
					findFirst: jest.fn().mockResolvedValue(null)
				}
			} as unknown as PrismaService,
			{} as RabbitMqManagementService,
			adminEventLog,
			remote,
			widgetsFailures
		);

		await expect(
			service.retryFailure(remoteResult.id, 'admin-1')
		).resolves.toEqual(remoteResult);
		expect(adminEventLog.record).toHaveBeenCalledTimes(1);
		expect(logger).toHaveBeenCalledWith(
			expect.stringContaining(
				'"event":"notification_delivery.global_audit_failed"'
			)
		);
	});

	it('returns a successful remote close when the global audit write fails', async () => {
		const remoteResult = {
			id: '22222222-2222-4222-8222-222222222222',
			eventId: '11111111-1111-4111-8111-111111111111',
			integration: 'telegram' as const,
			resolvedAt: '2026-07-27T12:00:00.000Z',
			resolution: 'CLOSED_NO_RETRY' as const,
			resolutionComment: 'Проверено вручную'
		};
		const remote = {
			closeFailure: jest.fn().mockResolvedValue(remoteResult)
		} as unknown as NotificationDeliveryClientService;
		const adminEventLog = {
			record: jest.fn().mockRejectedValue(new Error('audit unavailable'))
		} as unknown as AdminEventLogService;
		const logger = jest
			.spyOn(Logger.prototype, 'error')
			.mockImplementation(() => undefined);
		const service = new MessagingAdminService(
			{
				integrationDeliveryFailure: {
					findFirst: jest.fn().mockResolvedValue(null)
				}
			} as unknown as PrismaService,
			{} as RabbitMqManagementService,
			adminEventLog,
			remote,
			widgetsFailures
		);

		await expect(
			service.closeFailure(remoteResult.id, 'admin-1', 'Проверено вручную')
		).resolves.toEqual(remoteResult);
		expect(adminEventLog.record).toHaveBeenCalledTimes(1);
		expect(logger).toHaveBeenCalledWith(
			expect.stringContaining('"action":"CLOSE"')
		);
	});

	it('rejects a merged failure window over 10000 before querying either store', async () => {
		const localFindMany = jest.fn();
		const localCount = jest.fn();
		const remoteGetFailures = jest.fn();
		const service = new MessagingAdminService(
			{
				integrationDeliveryFailure: {
					findMany: localFindMany,
					count: localCount
				},
				$transaction: jest.fn()
			} as unknown as PrismaService,
			{} as RabbitMqManagementService,
			{} as AdminEventLogService,
			{
				getFailures: remoteGetFailures
			} as unknown as NotificationDeliveryClientService,
			widgetsFailures
		);

		await expect(service.getFailures(101, 100)).rejects.toBeInstanceOf(
			BadRequestException
		);
		expect(localFindMany).not.toHaveBeenCalled();
		expect(localCount).not.toHaveBeenCalled();
		expect(remoteGetFailures).not.toHaveBeenCalled();
	});

	it('merges Core, Notification Delivery, and Widgets failures before slicing the requested page', async () => {
		const coreFailures = [
			{
				...remoteFailure(
					'cccccccc-cccc-4ccc-8ccc-ccccccccccc5',
					'widgets-admin-audit',
					'2026-08-05T12:05:00.000Z'
				),
				failedAt: new Date('2026-08-05T12:05:00.000Z'),
				payload: {}
			},
			{
				...remoteFailure(
					'cccccccc-cccc-4ccc-8ccc-ccccccccccc3',
					'reporting-admin-audit',
					'2026-08-05T12:03:00.000Z'
				),
				failedAt: new Date('2026-08-05T12:03:00.000Z'),
				payload: {}
			}
		];
		const coreFindMany = jest.fn().mockResolvedValue(coreFailures);
		const coreCount = jest.fn().mockResolvedValue(2);
		const transaction = jest.fn(async operations =>
			Promise.all(operations)
		);
		const notificationItems = [
			remoteFailure(
				'nnnnnnnn-nnnn-4nnn-8nnn-nnnnnnnnnn04',
				'email',
				'2026-08-05T12:04:00.000Z'
			),
			remoteFailure(
				'nnnnnnnn-nnnn-4nnn-8nnn-nnnnnnnnnn01',
				'telegram',
				'2026-08-05T12:01:00.000Z'
			)
		];
		const widgetsItems = [
			remoteFailure(
				'wwwwwwww-wwww-4www-8www-wwwwwwwwww06',
				'webhook',
				'2026-08-05T12:06:00.000Z'
			),
			remoteFailure(
				'wwwwwwww-wwww-4www-8www-wwwwwwwwww02',
				'bitrix24',
				'2026-08-05T12:02:00.000Z'
			)
		];
		const notificationGetFailures = jest.fn().mockResolvedValue({
			items: notificationItems,
			total: 2,
			page: 1,
			limit: 4,
			totalPages: 1
		});
		const widgetsGetFailures = jest.fn().mockResolvedValue({
			items: widgetsItems,
			total: 2,
			page: 1,
			limit: 4,
			totalPages: 1
		});
		const service = new MessagingAdminService(
			{
				integrationDeliveryFailure: {
					findMany: coreFindMany,
					count: coreCount
				},
				$transaction: transaction
			} as unknown as PrismaService,
			{} as RabbitMqManagementService,
			{} as AdminEventLogService,
			{
				getFailures: notificationGetFailures
			} as unknown as NotificationDeliveryClientService,
			{
				getFailures: widgetsGetFailures
			} as unknown as WidgetsDeliveryFailuresClientService
		);

		const result = await service.getFailures(2, 2);
		expect(result).toEqual(
			expect.objectContaining({
				total: 6,
				page: 2,
				limit: 2,
				totalPages: 3
			})
		);
		expect(result.items.map(item => item.id)).toEqual([
			notificationItems[0].id,
			coreFailures[1].id
		]);
		expect(coreFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					OR: [
						{
							integration: { in: [...CORE_OWNED_MESSAGING_KINDS] }
						},
						{
							AND: [
								{
									integration: {
										in: ['telegram-destination-unavailable']
									}
								},
								{ resolvedAt: { not: null } }
							]
						}
					]
				},
				take: 4
			})
		);
		expect(notificationGetFailures).toHaveBeenCalledWith(1, 4, {});
		expect(widgetsGetFailures).toHaveBeenCalledWith(1, 4, {});
	});

	it('returns available failures and explicit coverage when one owner rejects', async () => {
		const coreFailure = {
			...remoteFailure(
				'cccccccc-cccc-4ccc-8ccc-ccccccccccc1',
				'reporting-admin-audit',
				'2026-08-15T12:01:00.000Z'
			),
			failedAt: new Date('2026-08-15T12:01:00.000Z'),
			payload: {}
		};
		const widgetsFailure = remoteFailure(
			'wwwwwwww-wwww-4www-8www-wwwwwwwwww02',
			'webhook',
			'2026-08-15T12:02:00.000Z'
		);
		const transaction = jest.fn().mockResolvedValue([[coreFailure], 1]);
		const notificationGetFailures = jest
			.fn()
			.mockRejectedValue(new Error('contract drift'));
		const widgetsGetFailures = jest.fn().mockResolvedValue({
			items: [widgetsFailure],
			total: 1,
			page: 1,
			limit: 20,
			totalPages: 1
		});
		const identityGetFailures = jest.fn().mockResolvedValue({
			items: [],
			total: 0,
			page: 1,
			limit: 20,
			totalPages: 1
		});
		jest
			.spyOn(Logger.prototype, 'warn')
			.mockImplementation(() => undefined);
		const service = new MessagingAdminService(
			{
				integrationDeliveryFailure: {
					findMany: jest.fn(),
					count: jest.fn()
				},
				$transaction: transaction
			} as unknown as PrismaService,
			{} as RabbitMqManagementService,
			{} as AdminEventLogService,
			{
				getFailures: notificationGetFailures
			} as unknown as NotificationDeliveryClientService,
			{
				getFailures: widgetsGetFailures
			} as unknown as WidgetsDeliveryFailuresClientService,
			undefined,
			undefined,
			{
				getFailures: identityGetFailures
			} as unknown as IdentityMessagingClientService
		);

		await expect(service.getFailures(1, 20)).resolves.toEqual({
			items: [
				expect.objectContaining({ id: widgetsFailure.id }),
				expect.objectContaining({ id: coreFailure.id })
			],
			total: 2,
			page: 1,
			limit: 20,
			totalPages: 1,
			sourceErrors: {
				notificationDelivery: 'Источник ошибок временно недоступен'
			},
			coverage: {
				core: 'complete',
				notificationDelivery: 'unavailable',
				widgets: 'complete',
				billing: 'not_queried',
				identity: 'complete'
			}
		});
		expect(transaction).toHaveBeenCalledTimes(1);
		expect(notificationGetFailures).toHaveBeenCalledTimes(1);
		expect(widgetsGetFailures).toHaveBeenCalledTimes(1);
		expect(identityGetFailures).toHaveBeenCalledTimes(1);
	});

	it('returns an empty partial page with every relevant source error instead of throwing', async () => {
		const transaction = jest
			.fn()
			.mockRejectedValue(new Error('core down'));
		const notificationGetFailures = jest
			.fn()
			.mockRejectedValue(new Error('notification down'));
		const widgetsGetFailures = jest
			.fn()
			.mockRejectedValue(new Error('widgets down'));
		const billingGetFailures = jest
			.fn()
			.mockRejectedValue(new Error('billing down'));
		const identityGetFailures = jest
			.fn()
			.mockRejectedValue(new Error('identity down'));
		jest
			.spyOn(Logger.prototype, 'warn')
			.mockImplementation(() => undefined);
		const service = new MessagingAdminService(
			{
				integrationDeliveryFailure: {
					findMany: jest.fn(),
					count: jest.fn()
				},
				$transaction: transaction
			} as unknown as PrismaService,
			{} as RabbitMqManagementService,
			{} as AdminEventLogService,
			{
				getFailures: notificationGetFailures
			} as unknown as NotificationDeliveryClientService,
			{
				getFailures: widgetsGetFailures
			} as unknown as WidgetsDeliveryFailuresClientService,
			{
				isBillingOwner: jest.fn().mockResolvedValue(true)
			} as unknown as BillingCoreStateService,
			{
				getFailures: billingGetFailures
			} as unknown as BillingMessagingClientService,
			{
				getFailures: identityGetFailures
			} as unknown as IdentityMessagingClientService
		);

		await expect(service.getFailures(1, 20)).resolves.toEqual({
			items: [],
			total: 0,
			page: 1,
			limit: 20,
			totalPages: 1,
			sourceErrors: {
				core: 'Источник ошибок временно недоступен',
				notificationDelivery: 'Источник ошибок временно недоступен',
				widgets: 'Источник ошибок временно недоступен',
				billing: 'Источник ошибок временно недоступен',
				identity: 'Источник ошибок временно недоступен'
			},
			coverage: {
				core: 'unavailable',
				notificationDelivery: 'unavailable',
				widgets: 'unavailable',
				billing: 'unavailable',
				identity: 'unavailable'
			}
		});
		expect(transaction).toHaveBeenCalledTimes(1);
		expect(notificationGetFailures).toHaveBeenCalledTimes(1);
		expect(widgetsGetFailures).toHaveBeenCalledTimes(1);
		expect(billingGetFailures).toHaveBeenCalledTimes(1);
		expect(identityGetFailures).toHaveBeenCalledTimes(1);
	});

	it('routes the service-owned Daily Summary failure filter only to Notification Delivery', async () => {
		const notificationGetFailures = jest.fn().mockResolvedValue({
			items: [],
			total: 0,
			page: 1,
			limit: 20,
			totalPages: 1
		});
		const coreTransaction = jest.fn();
		const widgetsGetFailures = jest.fn();
		const service = new MessagingAdminService(
			{
				integrationDeliveryFailure: {
					findMany: jest.fn(),
					count: jest.fn()
				},
				$transaction: coreTransaction
			} as unknown as PrismaService,
			{} as RabbitMqManagementService,
			{} as AdminEventLogService,
			{
				getFailures: notificationGetFailures
			} as unknown as NotificationDeliveryClientService,
			{
				getFailures: widgetsGetFailures
			} as unknown as WidgetsDeliveryFailuresClientService
		);

		await expect(
			service.getFailures(1, 20, {
				integration: NOTIFICATION_DELIVERY_DAILY_SUMMARY_ADMIN_KIND,
				status: 'FAILED'
			})
		).resolves.toEqual({
			items: [],
			total: 0,
			page: 1,
			limit: 20,
			totalPages: 1,
			sourceErrors: {},
			coverage: {
				core: 'not_queried',
				notificationDelivery: 'complete',
				widgets: 'not_queried',
				billing: 'not_queried',
				identity: 'not_queried'
			}
		});
		expect(notificationGetFailures).toHaveBeenCalledWith(1, 20, {
			integration: NOTIFICATION_DELIVERY_DAILY_SUMMARY_ADMIN_KIND,
			status: 'FAILED'
		});
		expect(coreTransaction).not.toHaveBeenCalled();
		expect(widgetsGetFailures).not.toHaveBeenCalled();
	});

	it('adds resolved archived Core rows to unfiltered history only after Billing takes ownership', async () => {
		const archivedFailure = {
			...remoteFailure(
				'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
				'notification-delivery-outcome',
				'2026-08-10T12:00:00.000Z'
			),
			payload: {},
			failedAt: new Date('2026-08-10T12:00:00.000Z'),
			resolvedAt: new Date('2026-08-10T12:01:00.000Z'),
			resolution: 'DELIVERED',
			createdAt: new Date('2026-08-10T12:00:00.000Z'),
			updatedAt: new Date('2026-08-10T12:01:00.000Z')
		};
		const coreFindMany = jest.fn().mockResolvedValue([archivedFailure]);
		const coreCount = jest.fn().mockResolvedValue(1);
		const transaction = jest.fn(async operations =>
			Promise.all(operations)
		);
		const emptyPage = {
			items: [],
			total: 0,
			page: 1,
			limit: 20,
			totalPages: 1
		};
		const service = new MessagingAdminService(
			{
				integrationDeliveryFailure: {
					findMany: coreFindMany,
					count: coreCount
				},
				$transaction: transaction
			} as unknown as PrismaService,
			{} as RabbitMqManagementService,
			{} as AdminEventLogService,
			{
				getFailures: jest.fn().mockResolvedValue(emptyPage)
			} as unknown as NotificationDeliveryClientService,
			{
				getFailures: jest.fn().mockResolvedValue(emptyPage)
			} as unknown as WidgetsDeliveryFailuresClientService,
			{
				isBillingOwner: jest.fn().mockResolvedValue(true)
			} as unknown as BillingCoreStateService,
			{
				getFailures: jest.fn().mockResolvedValue({
					...emptyPage,
					schemaVersion: 1
				})
			} as unknown as BillingMessagingClientService
		);

		await expect(service.getFailures(1, 20)).resolves.toEqual(
			expect.objectContaining({
				items: [
					expect.objectContaining({
						id: archivedFailure.id,
						integration: 'notification-delivery-outcome',
						resolvedAt: '2026-08-10T12:01:00.000Z'
					})
				],
				total: 1
			})
		);
		expect(coreFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					OR: [
						{
							integration: { in: [...CORE_OWNED_MESSAGING_KINDS] }
						},
						{
							AND: [
								{
									integration: {
										in: [...CORE_ARCHIVED_FAILURE_HISTORY_KINDS]
									}
								},
								{ resolvedAt: { not: null } }
							]
						}
					]
				}
			})
		);
	});

	it('merges archived and Billing notification outcome history for a terminal filter', async () => {
		const archivedFailure = {
			...remoteFailure(
				'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
				'notification-delivery-outcome',
				'2026-08-10T12:00:00.000Z'
			),
			payload: {},
			failedAt: new Date('2026-08-10T12:00:00.000Z'),
			resolvedAt: new Date('2026-08-10T12:01:00.000Z'),
			resolution: 'CLOSED_NO_RETRY',
			resolutionComment: 'Проверено до cutover',
			createdAt: new Date('2026-08-10T12:00:00.000Z'),
			updatedAt: new Date('2026-08-10T12:01:00.000Z')
		};
		const billingFailure = {
			id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
			eventId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
			consumer: 'notification-outcome' as const,
			routingKey: 'notification.delivery.outcome.v1',
			errorCode: 'TRANSIENT',
			errorSafe: 'Billing outcome failed',
			attempt: 2,
			status: 'RESOLVED' as const,
			category: 'TRANSIENT' as const,
			normalizedCode: 'TRANSIENT',
			safeReason: 'Billing outcome failed',
			httpStatus: null,
			providerCode: null,
			retryable: true,
			classificationVersion: 1,
			firstFailedAt: '2026-08-11T12:00:00.000Z',
			failedAt: '2026-08-11T12:00:00.000Z',
			retryingAt: null,
			resolvedAt: '2026-08-11T12:01:00.000Z',
			resolution: 'CLOSED_NO_RETRY' as const,
			resolutionComment: 'Проверено после cutover',
			createdAt: '2026-08-11T12:00:00.000Z',
			updatedAt: '2026-08-11T12:01:00.000Z'
		};
		const coreFindMany = jest.fn().mockResolvedValue([archivedFailure]);
		const transaction = jest.fn(async operations =>
			Promise.all(operations)
		);
		const billingGetFailures = jest.fn().mockResolvedValue({
			schemaVersion: 1,
			items: [billingFailure],
			total: 1,
			page: 1,
			limit: 20,
			totalPages: 1
		});
		const service = new MessagingAdminService(
			{
				integrationDeliveryFailure: {
					findMany: coreFindMany,
					count: jest.fn().mockResolvedValue(1)
				},
				$transaction: transaction
			} as unknown as PrismaService,
			{} as RabbitMqManagementService,
			{} as AdminEventLogService,
			{} as NotificationDeliveryClientService,
			{} as WidgetsDeliveryFailuresClientService,
			{
				isBillingOwner: jest.fn().mockResolvedValue(true)
			} as unknown as BillingCoreStateService,
			{
				getFailures: billingGetFailures
			} as unknown as BillingMessagingClientService
		);

		const result = await service.getFailures(1, 20, {
			integration: 'notification-delivery-outcome',
			status: 'CLOSED'
		});
		expect(result.items.map(item => item.id)).toEqual([
			billingFailure.id,
			archivedFailure.id
		]);
		expect(result.total).toBe(2);
		expect(coreFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					AND: [
						{
							integration: 'notification-delivery-outcome',
							resolution: 'CLOSED_NO_RETRY'
						},
						{ resolvedAt: { not: null } }
					]
				}
			})
		);
		expect(billingGetFailures).toHaveBeenCalledWith(1, 20, {
			consumer: 'notification-outcome',
			status: 'CLOSED'
		});
	});

	it('keeps unresolved archived rows out of the failed history after ownership handoff', async () => {
		const coreFindMany = jest.fn().mockResolvedValue([]);
		const transaction = jest.fn(async operations =>
			Promise.all(operations)
		);
		const service = new MessagingAdminService(
			{
				integrationDeliveryFailure: {
					findMany: coreFindMany,
					count: jest.fn().mockResolvedValue(0)
				},
				$transaction: transaction
			} as unknown as PrismaService,
			{} as RabbitMqManagementService,
			{} as AdminEventLogService,
			{} as NotificationDeliveryClientService,
			{} as WidgetsDeliveryFailuresClientService,
			{
				isBillingOwner: jest.fn().mockResolvedValue(true)
			} as unknown as BillingCoreStateService,
			{
				getFailures: jest.fn().mockResolvedValue({
					schemaVersion: 1,
					items: [],
					total: 0,
					page: 1,
					limit: 20,
					totalPages: 1
				})
			} as unknown as BillingMessagingClientService
		);

		await expect(
			service.getFailures(1, 20, {
				integration: 'notification-delivery-outcome',
				status: 'FAILED'
			})
		).resolves.toEqual(expect.objectContaining({ items: [], total: 0 }));
		expect(coreFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					AND: [
						{
							integration: 'notification-delivery-outcome',
							resolvedAt: null,
							retryingAt: null
						},
						{ resolvedAt: { not: null } }
					]
				}
			})
		);
	});

	it('does not expose archived Core history before Billing ownership', async () => {
		const transaction = jest.fn();
		const service = new MessagingAdminService(
			{
				integrationDeliveryFailure: {
					findMany: jest.fn(),
					count: jest.fn()
				},
				$transaction: transaction
			} as unknown as PrismaService,
			{} as RabbitMqManagementService,
			{} as AdminEventLogService,
			{} as NotificationDeliveryClientService,
			{} as WidgetsDeliveryFailuresClientService,
			{
				isBillingOwner: jest.fn().mockResolvedValue(false)
			} as unknown as BillingCoreStateService
		);

		await expect(
			service.getFailures(1, 20, {
				integration: 'notification-delivery-outcome',
				status: 'ALL'
			})
		).resolves.toEqual({
			items: [],
			total: 0,
			page: 1,
			limit: 20,
			totalPages: 1,
			sourceErrors: {},
			coverage: {
				core: 'not_queried',
				notificationDelivery: 'not_queried',
				widgets: 'not_queried',
				billing: 'not_queried',
				identity: 'not_queried'
			}
		});
		expect(transaction).not.toHaveBeenCalled();
	});

	it('queries only Widgets for a provider integration while preserving pagination', async () => {
		const widgetsItems = [
			remoteFailure(
				'widget-failure-1',
				'webhook',
				'2026-08-05T12:05:00.000Z'
			),
			remoteFailure(
				'widget-failure-2',
				'webhook',
				'2026-08-05T12:04:00.000Z'
			),
			remoteFailure(
				'widget-failure-3',
				'webhook',
				'2026-08-05T12:03:00.000Z'
			),
			remoteFailure(
				'widget-failure-4',
				'webhook',
				'2026-08-05T12:02:00.000Z'
			)
		];
		const coreTransaction = jest.fn();
		const notificationGetFailures = jest.fn();
		const widgetsGetFailures = jest.fn().mockResolvedValue({
			items: widgetsItems,
			total: 5,
			page: 1,
			limit: 4,
			totalPages: 2
		});
		const service = new MessagingAdminService(
			{
				integrationDeliveryFailure: {
					findMany: jest.fn(),
					count: jest.fn()
				},
				$transaction: coreTransaction
			} as unknown as PrismaService,
			{} as RabbitMqManagementService,
			{} as AdminEventLogService,
			{
				getFailures: notificationGetFailures
			} as unknown as NotificationDeliveryClientService,
			{
				getFailures: widgetsGetFailures
			} as unknown as WidgetsDeliveryFailuresClientService
		);

		await expect(
			service.getFailures(2, 2, { integration: 'webhook' })
		).resolves.toEqual({
			items: widgetsItems.slice(2, 4),
			total: 5,
			page: 2,
			limit: 2,
			totalPages: 3,
			sourceErrors: {},
			coverage: {
				core: 'not_queried',
				notificationDelivery: 'not_queried',
				widgets: 'complete',
				billing: 'not_queried',
				identity: 'not_queried'
			}
		});
		expect(coreTransaction).not.toHaveBeenCalled();
		expect(notificationGetFailures).not.toHaveBeenCalled();
		expect(widgetsGetFailures).toHaveBeenCalledWith(1, 4, {
			integration: 'webhook'
		});
	});

	it('aggregates Billing metrics without counting legacy auto-renewal rows twice', async () => {
		const prisma = {
			outboxEvent: {
				groupBy: jest.fn().mockResolvedValue([]),
				findFirst: jest.fn().mockResolvedValue(null)
			},
			integrationDeliveryFailure: {
				count: jest.fn().mockResolvedValue(2)
			},
			integrationDeliveryReceipt: {
				count: jest.fn().mockResolvedValue(3)
			},
			scheduledJobRun: { count: jest.fn().mockResolvedValue(0) },
			messagingHeartbeat: { findMany: jest.fn().mockResolvedValue([]) }
		} as unknown as PrismaService;
		const emptyOverview = {
			outbox: { PENDING: 0, PUBLISHING: 0, PUBLISHED: 0, FAILED: 0 },
			oldestPendingAt: null,
			unresolvedFailures: 0,
			retryingFailures: 0,
			deliveredLast24Hours: 0
		};
		const billing = {
			getOverview: jest.fn().mockResolvedValue({
				schemaVersion: 1,
				generatedAt: '2026-08-11T00:00:00.000Z',
				outbox: { PENDING: 4, PROCESSING: 1, PUBLISHED: 7 },
				oldestPendingAt: '2026-08-11T00:00:00.000Z',
				unresolvedFailures: 5,
				retryingFailures: 1,
				deliveredLast24Hours: 8,
				heartbeats: [
					'billing-api',
					'billing-scheduler',
					'billing-worker',
					'billing-outbox-publisher'
				].map(service => ({
					service,
					status: 'ok',
					activeInstances: 1,
					lastSeenAt: '2026-08-11T00:00:00.000Z',
					revision: 'a'.repeat(40)
				}))
			})
		} as unknown as BillingMessagingClientService;
		const service = new MessagingAdminService(
			prisma,
			{
				getMessagingQueues: jest.fn().mockResolvedValue([])
			} as unknown as RabbitMqManagementService,
			{} as AdminEventLogService,
			{
				getOverview: jest.fn().mockResolvedValue({
					...emptyOverview,
					heartbeat: {
						service: 'notification-delivery-worker',
						status: 'ok',
						activeInstances: 1,
						lastSeenAt: '2026-08-11T00:00:00.000Z'
					}
				})
			} as unknown as NotificationDeliveryClientService,
			{
				getOverview: jest.fn().mockResolvedValue({
					...emptyOverview,
					heartbeats: []
				})
			} as unknown as WidgetsDeliveryFailuresClientService,
			{
				isBillingOwner: jest.fn().mockResolvedValue(true)
			} as unknown as BillingCoreStateService,
			billing
		);

		await expect(service.getOverview()).resolves.toEqual(
			expect.objectContaining({
				outbox: expect.objectContaining({
					PENDING: 4,
					PUBLISHING: 1,
					PUBLISHED: 7
				}),
				unresolvedFailures: 7,
				retryingFailures: 3,
				processedLast24Hours: 11,
				completedBackupsLast24Hours: 0,
				billingError: null,
				heartbeats: expect.arrayContaining([
					expect.objectContaining({
						service: 'billing-api',
						status: 'ok'
					}),
					expect.objectContaining({
						service: 'billing-outbox-publisher',
						status: 'ok'
					})
				])
			})
		);
		for (const call of (
			prisma.integrationDeliveryFailure.count as jest.Mock
		).mock.calls) {
			expect(call[0].where.integration.in).not.toContain('auto-renewal');
		}
		expect(
			(prisma.integrationDeliveryReceipt.count as jest.Mock).mock
				.calls[0][0].where.integration.in
		).not.toContain('auto-renewal');
	});

	it('delegates the auto-renewal filtered page to Billing and preserves public classification fields', async () => {
		const billingItem = {
			id: '22222222-2222-4222-8222-222222222222',
			eventId: '11111111-1111-4111-8111-111111111111',
			consumer: 'auto-renewal-charge' as const,
			routingKey: 'payment.auto-renewal.charge.requested.v1',
			errorCode: 'PROVIDER_TIMEOUT',
			errorSafe: 'Provider request timed out',
			attempt: 2,
			status: 'RESOLVED' as const,
			category: 'TRANSIENT' as const,
			normalizedCode: 'PROVIDER_TIMEOUT',
			safeReason: 'Provider request timed out',
			httpStatus: 504,
			providerCode: null,
			retryable: true,
			classificationVersion: 1,
			firstFailedAt: '2026-08-11T00:00:00.000Z',
			failedAt: '2026-08-11T00:01:00.000Z',
			retryingAt: null,
			resolvedAt: '2026-08-11T00:02:00.000Z',
			resolution: 'CLOSED_NO_RETRY' as const,
			resolutionComment: 'closed',
			createdAt: '2026-08-11T00:00:00.000Z',
			updatedAt: '2026-08-11T00:02:00.000Z'
		};
		const coreTransaction = jest.fn();
		const billing = {
			getFailures: jest.fn().mockResolvedValue({
				schemaVersion: 1,
				items: [billingItem],
				total: 1,
				page: 1,
				limit: 20,
				totalPages: 1
			})
		} as unknown as BillingMessagingClientService;
		const notificationGetFailures = jest.fn();
		const widgetsGetFailures = jest.fn();
		const service = new MessagingAdminService(
			{
				integrationDeliveryFailure: {
					findMany: jest.fn(),
					count: jest.fn()
				},
				$transaction: coreTransaction
			} as unknown as PrismaService,
			{} as RabbitMqManagementService,
			{} as AdminEventLogService,
			{
				getFailures: notificationGetFailures
			} as unknown as NotificationDeliveryClientService,
			{
				getFailures: widgetsGetFailures
			} as unknown as WidgetsDeliveryFailuresClientService,
			{
				isBillingOwner: jest.fn().mockResolvedValue(true)
			} as unknown as BillingCoreStateService,
			billing
		);

		await expect(
			service.getFailures(1, 20, {
				integration: 'auto-renewal',
				category: 'TRANSIENT',
				status: 'CLOSED'
			})
		).resolves.toEqual({
			items: [
				expect.objectContaining({
					id: billingItem.id,
					integration: 'auto-renewal',
					category: 'TRANSIENT',
					normalizedCode: 'PROVIDER_TIMEOUT',
					httpStatus: 504,
					failedAt: billingItem.failedAt
				})
			],
			total: 1,
			page: 1,
			limit: 20,
			totalPages: 1,
			sourceErrors: {},
			coverage: {
				core: 'not_queried',
				notificationDelivery: 'not_queried',
				widgets: 'not_queried',
				billing: 'complete',
				identity: 'not_queried'
			}
		});
		expect(coreTransaction).not.toHaveBeenCalled();
		expect(notificationGetFailures).not.toHaveBeenCalled();
		expect(widgetsGetFailures).not.toHaveBeenCalled();
		expect(billing.getFailures).toHaveBeenCalledWith(1, 20, {
			consumer: 'auto-renewal-charge',
			category: 'TRANSIENT',
			status: 'CLOSED'
		});
	});

	it('routes imported auto-renewal UUID actions directly to Billing with no Core fallback', async () => {
		const id = '22222222-2222-4222-8222-222222222222';
		const eventId = '11111111-1111-4111-8111-111111111111';
		const prismaTransaction = jest.fn();
		const notificationRetry = jest.fn();
		const notificationClose = jest.fn();
		const widgetsRetry = jest.fn();
		const widgetsClose = jest.fn();
		const billing = {
			retryFailure: jest.fn().mockResolvedValue({
				schemaVersion: 1,
				id,
				eventId,
				consumer: 'auto-renewal-charge',
				status: 'RETRY_PENDING',
				retryOutboxId: 'billing-outbox-1',
				retryingAt: '2026-08-11T00:00:00.000Z',
				duplicate: false
			}),
			closeFailure: jest.fn().mockResolvedValue({
				schemaVersion: 1,
				id,
				eventId,
				consumer: 'auto-renewal-charge',
				status: 'RESOLVED',
				resolvedAt: '2026-08-11T00:01:00.000Z',
				resolution: 'CLOSED_NO_RETRY',
				resolutionComment: 'Проверено вручную',
				duplicate: false
			})
		} as unknown as BillingMessagingClientService;
		const service = new MessagingAdminService(
			{
				integrationDeliveryFailure: {
					findFirst: jest.fn().mockResolvedValue({ id })
				},
				$transaction: prismaTransaction
			} as unknown as PrismaService,
			{} as RabbitMqManagementService,
			{} as AdminEventLogService,
			{
				retryFailure: notificationRetry,
				closeFailure: notificationClose
			} as unknown as NotificationDeliveryClientService,
			{
				retryFailure: widgetsRetry,
				closeFailure: widgetsClose
			} as unknown as WidgetsDeliveryFailuresClientService,
			{
				isBillingOwner: jest.fn().mockResolvedValue(true)
			} as unknown as BillingCoreStateService,
			billing
		);

		await expect(service.retryFailure(id, 'dev-1')).resolves.toEqual({
			id,
			eventId,
			integration: 'auto-renewal',
			retryingAt: '2026-08-11T00:00:00.000Z'
		});
		await expect(
			service.closeFailure(id, 'dev-1', 'Проверено вручную')
		).resolves.toEqual({
			id,
			eventId,
			integration: 'auto-renewal',
			resolvedAt: '2026-08-11T00:01:00.000Z',
			resolution: 'CLOSED_NO_RETRY',
			resolutionComment: 'Проверено вручную'
		});
		expect(notificationRetry).not.toHaveBeenCalled();
		expect(notificationClose).not.toHaveBeenCalled();
		expect(widgetsRetry).not.toHaveBeenCalled();
		expect(widgetsClose).not.toHaveBeenCalled();
		expect(prismaTransaction).not.toHaveBeenCalled();
	});

	it('fails closed for an imported auto-renewal UUID missing from Billing', async () => {
		const id = '22222222-2222-4222-8222-222222222222';
		const notificationRetry = jest.fn();
		const widgetsRetry = jest.fn();
		const service = new MessagingAdminService(
			{
				integrationDeliveryFailure: {
					findFirst: jest.fn().mockResolvedValue({ id })
				}
			} as unknown as PrismaService,
			{} as RabbitMqManagementService,
			{} as AdminEventLogService,
			{
				retryFailure: notificationRetry
			} as unknown as NotificationDeliveryClientService,
			{
				retryFailure: widgetsRetry
			} as unknown as WidgetsDeliveryFailuresClientService,
			{
				isBillingOwner: jest.fn().mockResolvedValue(true)
			} as unknown as BillingCoreStateService,
			{
				retryFailure: jest
					.fn()
					.mockRejectedValue(
						new BillingMessagingInternalApiError(404, 'not found')
					)
			} as unknown as BillingMessagingClientService
		);

		await expect(service.retryFailure(id, 'dev-1')).rejects.toThrow(
			'Ошибка доставки не найдена'
		);
		expect(notificationRetry).not.toHaveBeenCalled();
		expect(widgetsRetry).not.toHaveBeenCalled();
	});

	it('keeps archived Core failures read-only without delegating actions', async () => {
		const id = '22222222-2222-4222-8222-222222222222';
		const findFirst = jest.fn().mockImplementation(({ where }) => {
			if (where.integration === 'auto-renewal')
				return Promise.resolve(null);
			if (
				Array.isArray(where.integration?.in) &&
				where.integration.in.includes('notification-delivery-outcome')
			) {
				return Promise.resolve({ id });
			}
			return Promise.resolve(null);
		});
		const transaction = jest.fn();
		const notificationRetry = jest.fn();
		const notificationClose = jest.fn();
		const widgetsRetry = jest.fn();
		const widgetsClose = jest.fn();
		const billingRetry = jest.fn();
		const billingClose = jest.fn();
		const service = new MessagingAdminService(
			{
				integrationDeliveryFailure: { findFirst },
				$transaction: transaction
			} as unknown as PrismaService,
			{} as RabbitMqManagementService,
			{} as AdminEventLogService,
			{
				retryFailure: notificationRetry,
				closeFailure: notificationClose
			} as unknown as NotificationDeliveryClientService,
			{
				retryFailure: widgetsRetry,
				closeFailure: widgetsClose
			} as unknown as WidgetsDeliveryFailuresClientService,
			{
				isBillingOwner: jest.fn().mockResolvedValue(true)
			} as unknown as BillingCoreStateService,
			{
				retryFailure: billingRetry,
				closeFailure: billingClose
			} as unknown as BillingMessagingClientService
		);

		await expect(service.retryFailure(id, 'dev-1')).rejects.toMatchObject({
			message: 'Архивная ошибка доступна только для чтения',
			status: 409
		});
		await expect(
			service.closeFailure(id, 'dev-1', 'Проверено вручную')
		).rejects.toMatchObject({
			message: 'Архивная ошибка доступна только для чтения',
			status: 409
		});
		expect(transaction).not.toHaveBeenCalled();
		expect(notificationRetry).not.toHaveBeenCalled();
		expect(notificationClose).not.toHaveBeenCalled();
		expect(widgetsRetry).not.toHaveBeenCalled();
		expect(widgetsClose).not.toHaveBeenCalled();
		expect(billingRetry).not.toHaveBeenCalled();
		expect(billingClose).not.toHaveBeenCalled();
	});
});
