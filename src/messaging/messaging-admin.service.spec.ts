import { MessagingAdminService } from '@/messaging/messaging-admin.service';
import type { RabbitMqManagementService } from '@/messaging/rabbitmq-management.service';
import type { PrismaService } from '@/prisma.service';

describe('MessagingAdminService', () => {
	it('queues a manual retry through the transactional Outbox', async () => {
		const retryingAt = null;
		const failure = {
			id: '22222222-2222-4222-8222-222222222222',
			eventId: '11111111-1111-4111-8111-111111111111',
			integration: 'webhook',
			routingKey: 'lead.integration.webhook.v1',
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
			attempts: 4,
			lastError: 'timeout',
			failedAt: new Date(),
			retryingAt,
			resolvedAt: null,
			createdAt: new Date(),
			updatedAt: new Date()
		};
		const transaction = {
			integrationDeliveryFailure: {
				findUnique: jest.fn().mockResolvedValue(failure),
				updateMany: jest.fn().mockResolvedValue({ count: 1 })
			},
			outboxEvent: {
				create: jest.fn().mockResolvedValue({ id: 'outbox-1' })
			}
		};
		const prisma = {
			$transaction: jest.fn(async callback => callback(transaction))
		} as unknown as PrismaService;
		const service = new MessagingAdminService(
			prisma,
			{} as RabbitMqManagementService
		);

		const result = await service.retryFailure(failure.id);

		expect(transaction.outboxEvent.create).toHaveBeenCalledWith({
			data: {
				messageId: failure.eventId,
				eventType: 'lead.integration.requested.v1',
				routingKey: 'manual.webhook',
				payload: failure.payload
			}
		});
		expect(result).toEqual(
			expect.objectContaining({
				id: failure.id,
				eventId: failure.eventId,
				integration: 'webhook',
				retryingAt: expect.any(String)
			})
		);
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
				jobType: 'DATABASE_BACKUP'
			},
			resolvedAt: null,
			retryingAt: null
		};
		const transaction = {
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
			$transaction: jest.fn(async callback => callback(transaction))
		} as unknown as PrismaService;
		const service = new MessagingAdminService(
			prisma,
			{} as RabbitMqManagementService
		);

		await service.retryFailure(failure.id);

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
				payload: failure.payload
			}
		});
	});
});
