import {
	WorkspaceMemberRole,
	WorkspaceMemberStatus,
	WorkspaceStatus,
	WorkspaceType
} from '@prisma/identity-client';
import { WorkspaceProvisioningService } from './workspace-provisioning.service';

describe('WorkspaceProvisioningService', () => {
	it('creates a personal workspace and its owner membership in the caller transaction', async () => {
		const transaction = {
			workspace: {
				create: jest.fn().mockResolvedValue({ id: 'workspace-id' })
			}
		};
		const service = new WorkspaceProvisioningService();

		await expect(
			service.provisionPersonalWorkspace(transaction as never, 'user-id')
		).resolves.toEqual({ id: 'workspace-id' });

		expect(transaction.workspace.create).toHaveBeenCalledWith({
			data: {
				id: expect.any(String),
				type: WorkspaceType.PERSONAL,
				status: WorkspaceStatus.ACTIVE,
				personalOwnerUserId: 'user-id',
				members: {
					create: {
						id: expect.any(String),
						userId: 'user-id',
						role: WorkspaceMemberRole.OWNER,
						status: WorkspaceMemberStatus.ACTIVE
					}
				}
			},
			select: { id: true }
		});
		const data = transaction.workspace.create.mock.calls[0]?.[0]?.data;
		expect(data.id).not.toBe(data.members.create.id);
		expect(data.id).toMatch(/^[0-9a-f-]{36}$/);
		expect(data.members.create.id).toMatch(/^[0-9a-f-]{36}$/);
	});

	it('does not hide a database invariant failure from the outer transaction', async () => {
		const failure = new Error('personal workspace already exists');
		const transaction = {
			workspace: { create: jest.fn().mockRejectedValue(failure) }
		};
		const service = new WorkspaceProvisioningService();

		await expect(
			service.provisionPersonalWorkspace(transaction as never, 'user-id')
		).rejects.toBe(failure);
	});
});
