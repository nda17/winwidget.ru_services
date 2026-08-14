import type { IdentityInternalClient } from '@/identity-boundary/identity-internal.client';
import type { PrismaService } from '@/prisma.service';
import type { Prisma } from '@prisma/client';
import { AdminEventLogService } from './admin-event-log.service';

describe('AdminEventLogService identity snapshots', () => {
	const createFixture = () => {
		const create = jest.fn().mockImplementation(({ data }) => data);
		const identity = {
			getAuditSnapshots: jest.fn()
		};
		const service = new AdminEventLogService(
			{} as PrismaService,
			identity as unknown as IdentityInternalClient
		);
		return {
			service,
			identity,
			transaction: {
				adminEventLog: { create }
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
				adminName: 'Admin',
				adminEmail: 'a@example.com',
				targetUserName: 'User',
				targetUserEmail: null
			})
		});
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
				adminId: 'admin-id',
				adminName: null,
				adminEmail: null
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
				adminName: 'Immutable actor',
				adminEmail: null,
				targetUserName: null,
				targetUserEmail: 'target@example.com'
			})
		});
	});
});
