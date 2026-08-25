import type { IdentityInternalClient } from '@/identity-boundary/identity-internal.client';
import type { PrismaService } from '@/prisma.service';
import type { Prisma } from '@prisma/client';
import { AdminEventLogService } from './admin-event-log.service';

describe('AdminEventLogService identity snapshots', () => {
	const createFixture = () => {
		const create = jest.fn().mockImplementation(({ data }) => data);
		const identity = {
			getAuditSnapshots: jest.fn().mockResolvedValue(new Map())
		};
		const service = new AdminEventLogService(
			{} as PrismaService,
			identity as unknown as IdentityInternalClient
		);
		return {
			service,
			identity,
			transaction: {
				outboxEvent: { create }
			} as unknown as Prisma.TransactionClient,
			create
		};
	};

	it('resolves missing actor and target snapshots through Identity once', async () => {
		const { service, identity, transaction, create } = createFixture();
		identity.getAuditSnapshots.mockResolvedValue(
			new Map([
				[
					'admin-id',
					{ id: 'admin-id', name: 'Admin', email: 'a@example.com' }
				],
				['target-id', { id: 'target-id', name: 'User', email: null }]
			])
		);

		await service.recordInTransaction(transaction, {
			adminId: 'admin-id',
			targetUserId: 'target-id',
			section: 'USERS',
			action: 'USER_UPDATE',
			description: 'Updated user'
		});

		expect(identity.getAuditSnapshots).toHaveBeenCalledWith([
			'admin-id',
			'target-id'
		]);
		expect(create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				eventType: 'admin.audit.event.v1',
				routingKey: 'admin.audit.core.v1',
				messageId: expect.any(String),
				payload: expect.objectContaining({
					actorSnapshot: {
						name: 'Admin',
						email: 'a@example.com'
					},
					entity: expect.objectContaining({
						targetSnapshot: { name: 'User', email: null }
					})
				})
			})
		});
		const data = create.mock.calls[0][0].data;
		expect(data.messageId).toBe(data.payload.eventId);
		expect(data.headers['x-correlation-id']).toBe(
			data.payload.correlationId
		);
	});

	it('records null snapshots when Identity is temporarily unavailable', async () => {
		const { service, identity, transaction, create } = createFixture();
		identity.getAuditSnapshots.mockRejectedValue(new Error('offline'));

		await service.recordInTransaction(transaction, {
			adminId: 'admin-id',
			section: 'SITE_SETTINGS',
			action: 'SITE_SETTINGS_UPDATE',
			description: 'Updated settings'
		});

		expect(create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				payload: expect.objectContaining({
					actorId: 'admin-id',
					actorSnapshot: { name: null, email: null }
				})
			})
		});
	});

	it('uses event-provided snapshots without another Identity call', async () => {
		const { service, identity, transaction, create } = createFixture();

		await service.recordInTransaction(transaction, {
			adminId: 'admin-id',
			adminName: 'Immutable actor',
			adminEmail: null,
			targetUserId: 'target-id',
			targetUserName: null,
			targetUserEmail: 'target@example.com',
			section: 'USERS',
			action: 'USER_DELETE',
			description: 'Deleted user'
		});

		expect(identity.getAuditSnapshots).not.toHaveBeenCalled();
		expect(create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				payload: expect.objectContaining({
					actorSnapshot: {
						name: 'Immutable actor',
						email: null
					},
					entity: expect.objectContaining({
						targetSnapshot: {
							name: null,
							email: 'target@example.com'
						}
					})
				})
			})
		});
	});

	it('records the dedicated Platform section and action', async () => {
		const { service, identity, transaction, create } = createFixture();

		await service.recordInTransaction(transaction, {
			adminId: 'admin-id',
			adminName: 'Platform admin',
			adminEmail: null,
			section: 'PLATFORM_CONTENT',
			action: 'PLATFORM_HOME_PAGE_CONTENT_UPDATE',
			description: 'Updated Platform content'
		});

		expect(identity.getAuditSnapshots).not.toHaveBeenCalled();
		expect(create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				payload: expect.objectContaining({
					section: 'PLATFORM_CONTENT',
					action: 'PLATFORM_HOME_PAGE_CONTENT_UPDATE'
				})
			})
		});
	});

	it('fails closed before Outbox insertion for forbidden metadata', async () => {
		const { service, transaction, create } = createFixture();

		await expect(
			service.recordInTransaction(transaction, {
				adminId: 'admin-id',
				section: 'TELEGRAM_BOT',
				action: 'TELEGRAM_BOT_WEBHOOK_REINSTALL',
				description: 'Webhook reinstalled',
				metadata: { webhookUrl: 'forbidden' }
			})
		).rejects.toThrow('is forbidden');
		expect(create).not.toHaveBeenCalled();
	});

	it('propagates Outbox failures to fail closed', async () => {
		const outboxError = new Error('outbox unavailable');
		const prisma = {
			outboxEvent: {
				create: jest.fn().mockRejectedValue(outboxError)
			}
		} as unknown as PrismaService;
		const service = new AdminEventLogService(prisma, {
			getAuditSnapshots: jest.fn().mockResolvedValue(new Map())
		} as unknown as IdentityInternalClient);

		await expect(
			service.record({
				adminId: 'admin-id',
				section: 'DEV_TOOLS',
				action: 'DEV_DATABASE_RESTORE',
				description: 'Restore requested'
			})
		).rejects.toBe(outboxError);
	});
});
