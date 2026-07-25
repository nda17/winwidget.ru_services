import type { AdminEventLogService } from '@/admin-event-log/admin-event-log.service';
import { MessagingAdminService } from '@/messaging/messaging-admin.service';
import type { RabbitMqManagementService } from '@/messaging/rabbitmq-management.service';
import type { LeadIntegrationDestinationService } from '@/messaging/lead-integration-destination.service';
import type { PrismaService } from '@/prisma.service';
import { ConflictException } from '@nestjs/common';

describe('MessagingAdminService', () => {
	it('queues a manual retry through the transactional Outbox', async () => {
		const retryingAt = null;
		const failure = {
			id: '22222222-2222-4222-8222-222222222222',
			eventId: '11111111-1111-4111-8111-111111111111',
			integration: 'webhook',
			routingKey: 'lead.integration.webhook.v2',
			payload: {
				schemaVersion: 2,
				eventType: 'lead.integration.requested.v2',
				integration: 'webhook',
				source: 'widget',
				entity: { id: 'widget-1', name: 'Колесо' },
				lead: {
					id: 'lead-1',
					createdAt: '2026-07-24T00:00:00.000Z'
				},
				destination: {
					credentialRef: '33333333-3333-4333-8333-333333333333'
				}
			},
			attempts: 4,
			lastError: 'timeout',
			failedAt: new Date(),
			retryingAt,
			resolvedAt: null,
			createdAt: new Date(),
			updatedAt: new Date()
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
				findUnique: jest.fn().mockResolvedValue(failure)
			},
			$transaction: jest.fn(async callback => callback(transaction))
		} as unknown as PrismaService;
		const adminEventLog = {
			recordInTransaction: jest.fn().mockResolvedValue({})
		} as unknown as AdminEventLogService;
		const service = new MessagingAdminService(
			prisma,
			{} as RabbitMqManagementService,
			{} as LeadIntegrationDestinationService,
			adminEventLog
		);

		const result = await service.retryFailure(failure.id, 'admin-1');

		expect(transaction.outboxEvent.create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				messageId: failure.eventId,
				eventType: 'lead.integration.requested.v2',
				routingKey: 'manual.webhook',
				headers: expect.objectContaining({
					'x-retry-attempt': 0,
					'x-delivery-token': expect.any(String),
					'x-correlation-id': failure.eventId,
					'x-request-id': failure.eventId,
					'x-causation-id': failure.eventId
				}),
				payload: expect.objectContaining({
					schemaVersion: 2,
					eventType: 'lead.integration.requested.v2',
					destination: {
						credentialRef: '33333333-3333-4333-8333-333333333333'
					}
				})
			})
		});
		expect(result).toEqual(
			expect.objectContaining({
				id: failure.id,
				eventId: failure.eventId,
				integration: 'webhook',
				retryingAt: expect.any(String)
			})
		);
		expect(adminEventLog.recordInTransaction).toHaveBeenCalledWith(
			transaction,
			expect.objectContaining({
				action: 'MESSAGING_FAILURE_RETRY',
				entityId: failure.id,
				adminId: 'admin-1'
			})
		);
	});

	it('rejects a retired v1 lead retry before changing its state', async () => {
		const failure = {
			id: '22222222-2222-4222-8222-222222222222',
			eventId: '11111111-1111-4111-8111-111111111111',
			integration: 'webhook',
			payload: {
				schemaVersion: 1,
				integration: 'webhook',
				source: 'widget',
				entity: { id: 'widget-1', name: 'Колесо' },
				lead: {
					id: 'lead-1',
					createdAt: '2026-07-24T00:00:00.000Z'
				},
				destination: { webhookUrl: 'https://example.com' }
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
			$transaction: jest.fn(async callback => callback(transaction))
		} as unknown as PrismaService;
		const service = new MessagingAdminService(
			prisma,
			{} as RabbitMqManagementService,
			{} as LeadIntegrationDestinationService,
			{
				recordInTransaction: jest.fn()
			} as unknown as AdminEventLogService
		);

		await expect(
			service.retryFailure(failure.id, 'admin-1')
		).rejects.toThrow('Повтор устаревшего события интеграции недоступен');
		expect(updateMany).not.toHaveBeenCalled();
		expect(outboxCreate).not.toHaveBeenCalled();
	});

	it('rejects a malformed non-lead retry before changing its state', async () => {
		const failure = {
			id: '22222222-2222-4222-8222-222222222222',
			eventId: '11111111-1111-4111-8111-111111111111',
			integration: 'payment-email',
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
			$transaction: jest.fn(async callback => callback(transaction))
		} as unknown as PrismaService;
		const service = new MessagingAdminService(
			prisma,
			{} as RabbitMqManagementService,
			{} as LeadIntegrationDestinationService,
			{
				recordInTransaction: jest.fn()
			} as unknown as AdminEventLogService
		);

		await expect(
			service.retryFailure(failure.id, 'admin-1')
		).rejects.toThrow(
			'Повтор события с некорректным контрактом недоступен'
		);
		expect(updateMany).not.toHaveBeenCalled();
		expect(outboxCreate).not.toHaveBeenCalled();
	});

	it('reopens a failed backup job in the same transaction as manual retry Outbox', async () => {
		const eventId = '11111111-1111-4111-8111-111111111111';
		const failure = {
			id: '22222222-2222-4222-8222-222222222222',
			eventId,
			integration: 'database-backup',
			payload: {
				schemaVersion: 1,
				eventType: 'database.backup.requested.v1',
				jobId: eventId,
				jobType: 'DATABASE_BACKUP',
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
				findUnique: jest.fn().mockResolvedValue(failure)
			},
			$transaction: jest.fn(async callback => callback(transaction))
		} as unknown as PrismaService;
		const service = new MessagingAdminService(
			prisma,
			{} as RabbitMqManagementService,
			{} as LeadIntegrationDestinationService,
			{
				recordInTransaction: jest.fn().mockResolvedValue({})
			} as unknown as AdminEventLogService
		);

		await service.retryFailure(failure.id, 'admin-1');

		expect(transaction.scheduledJobRun.updateMany).toHaveBeenCalledWith({
			where: {
				id: eventId,
				jobType: 'DATABASE_BACKUP',
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
	});

	it('closes an unresolved failure without publishing and removes its credential snapshot', async () => {
		const failure = {
			id: '22222222-2222-4222-8222-222222222222',
			eventId: '11111111-1111-4111-8111-111111111111',
			integration: 'webhook',
			payload: {
				schemaVersion: 2,
				eventType: 'lead.integration.requested.v2',
				integration: 'webhook',
				source: 'widget',
				entity: { id: 'widget-1', name: 'Колесо' },
				lead: {
					id: 'lead-1',
					createdAt: '2026-07-24T00:00:00.000Z'
				},
				destination: {
					credentialRef: '33333333-3333-4333-8333-333333333333'
				}
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
			integrationCredentialSnapshot: {
				deleteMany: jest.fn().mockResolvedValue({ count: 1 })
			},
			integrationDeliveryReceipt: {
				findUnique: jest.fn()
			},
			outboxEvent: {
				create: jest.fn()
			}
		};
		const prisma = {
			$transaction: jest.fn(async callback => callback(transaction))
		} as unknown as PrismaService;
		const adminEventLog = {
			recordInTransaction: jest.fn().mockResolvedValue({})
		} as unknown as AdminEventLogService;
		const service = new MessagingAdminService(
			prisma,
			{} as RabbitMqManagementService,
			{} as LeadIntegrationDestinationService,
			adminEventLog
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
		expect(
			transaction.integrationCredentialSnapshot.deleteMany
		).toHaveBeenCalledWith({
			where: {
				eventId: failure.eventId,
				integration: 'webhook'
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
			$transaction: jest.fn(async callback => callback(transaction))
		} as unknown as PrismaService;
		const service = new MessagingAdminService(
			prisma,
			{} as RabbitMqManagementService,
			{} as LeadIntegrationDestinationService,
			{
				recordInTransaction: jest.fn().mockResolvedValue({})
			} as unknown as AdminEventLogService
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
			integration: 'webhook',
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
				$transaction: jest.fn(async callback => callback(transaction))
			} as unknown as PrismaService,
			{} as RabbitMqManagementService,
			{} as LeadIntegrationDestinationService,
			{
				recordInTransaction: jest.fn().mockResolvedValue({})
			} as unknown as AdminEventLogService
		);

		await expect(
			service.closeFailure(failure.id, 'admin-1', 'Закрыть нельзя')
		).rejects.toBeInstanceOf(ConflictException);
		expect(
			transaction.integrationDeliveryFailure.updateMany
		).not.toHaveBeenCalled();
	});
});
