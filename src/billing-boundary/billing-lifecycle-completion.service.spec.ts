import type { AdminEventLogService } from '@/admin-event-log/admin-event-log.service';
import type { PrismaService } from '@/prisma.service';
import { Role, UserStatus } from '@prisma/client';
import { BillingLifecycleCompletionService } from './billing-lifecycle-completion.service';

describe('BillingLifecycleCompletionService', () => {
	const commandId = '11111111-1111-4111-8111-111111111111';
	const requestedAt = '2026-08-11T10:00:00.000Z';

	const createService = () => {
		const transaction = {
			integrationDeliveryReceipt: {
				createMany: jest.fn().mockResolvedValue({ count: 1 }),
				update: jest.fn().mockResolvedValue({})
			},
			user: {
				findUnique: jest.fn(),
				count: jest.fn(),
				updateMany: jest.fn().mockResolvedValue({ count: 1 })
			},
			userSession: {
				updateMany: jest.fn().mockResolvedValue({ count: 2 })
			}
		};
		const prisma = {
			$transaction: jest.fn(async callback => callback(transaction))
		} as unknown as PrismaService;
		const adminEventLog = {
			recordInTransaction: jest.fn().mockResolvedValue(undefined)
		} as unknown as AdminEventLogService;

		return {
			service: new BillingLifecycleCompletionService(
				prisma,
				adminEventLog
			),
			transaction,
			adminEventLog
		};
	};

	it('atomically completes a confirmed revoke with current authorization', async () => {
		const { service, transaction, adminEventLog } = createService();
		transaction.user.findUnique
			.mockResolvedValueOnce({
				status: UserStatus.ACTIVE,
				deletedAt: null,
				rights: [Role.DEV]
			})
			.mockResolvedValueOnce({
				id: 'target-user',
				name: 'Target',
				status: UserStatus.ACTIVE,
				deletedAt: null,
				personalDataConsentRevokedAt: null,
				rights: [Role.USER]
			});

		await expect(
			service.complete({
				schemaVersion: 1,
				commandId,
				userId: 'target-user',
				operation: 'DELETE',
				actorId: 'actor-user',
				actorRole: Role.DEV,
				requestedAt
			})
		).resolves.toEqual({
			schemaVersion: 1,
			commandId,
			completed: true,
			duplicate: false,
			changed: true
		});

		expect(transaction.user.updateMany).toHaveBeenCalledWith({
			where: {
				id: 'target-user',
				status: UserStatus.ACTIVE,
				deletedAt: null
			},
			data: {
				status: UserStatus.DEACTIVATED,
				personalDataConsentRevokedAt: new Date(requestedAt),
				deletedAt: new Date(requestedAt)
			}
		});
		expect(transaction.userSession.updateMany).toHaveBeenCalledWith({
			where: { userId: 'target-user', revokedAt: null },
			data: { revokedAt: new Date(requestedAt) }
		});
		expect(adminEventLog.recordInTransaction).toHaveBeenCalledWith(
			transaction,
			expect.objectContaining({
				adminId: 'actor-user',
				action: 'USER_SOFT_DELETE',
				metadata: {
					billingLifecycleRepair: true,
					commandId,
					operation: 'DELETE'
				}
			})
		);
		expect(
			transaction.integrationDeliveryReceipt.update
		).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					eventId_integration: {
						eventId: commandId,
						integration: 'billing-lifecycle-complete'
					}
				}
			})
		);
	});

	it('returns a duplicate without repeating lifecycle mutations', async () => {
		const { service, transaction, adminEventLog } = createService();
		transaction.integrationDeliveryReceipt.createMany.mockResolvedValue({
			count: 0
		});

		await expect(
			service.complete({
				schemaVersion: 1,
				commandId,
				userId: 'target-user',
				operation: 'DEACTIVATE',
				actorId: 'actor-user',
				actorRole: Role.ADMIN,
				requestedAt
			})
		).resolves.toEqual({
			schemaVersion: 1,
			commandId,
			completed: true,
			duplicate: true,
			changed: false
		});

		expect(transaction.user.findUnique).not.toHaveBeenCalled();
		expect(transaction.user.updateMany).not.toHaveBeenCalled();
		expect(adminEventLog.recordInTransaction).not.toHaveBeenCalled();
	});

	it('revalidates the actor role instead of trusting the repair payload', async () => {
		const { service, transaction } = createService();
		transaction.user.findUnique
			.mockResolvedValueOnce({
				status: UserStatus.ACTIVE,
				deletedAt: null,
				rights: [Role.ADMIN]
			})
			.mockResolvedValueOnce({
				id: 'target-user',
				name: 'Target',
				status: UserStatus.ACTIVE,
				deletedAt: null,
				personalDataConsentRevokedAt: null,
				rights: [Role.USER]
			});

		await expect(
			service.complete({
				schemaVersion: 1,
				commandId,
				userId: 'target-user',
				operation: 'DEACTIVATE',
				actorId: 'actor-user',
				actorRole: Role.DEV,
				requestedAt
			})
		).rejects.toThrow('Lifecycle repair actor is no longer authorized');
		expect(transaction.user.updateMany).not.toHaveBeenCalled();
	});
});
