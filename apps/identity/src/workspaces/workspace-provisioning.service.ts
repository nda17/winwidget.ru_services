import { Injectable } from '@nestjs/common';
import {
	Prisma,
	WorkspaceMemberRole,
	WorkspaceMemberStatus,
	WorkspaceStatus,
	WorkspaceType
} from '@prisma/identity-client';
import { randomUUID } from 'node:crypto';

@Injectable()
export class WorkspaceProvisioningService {
	async provisionPersonalWorkspace(
		transaction: Prisma.TransactionClient,
		userId: string
	) {
		const workspaceId = randomUUID();
		let membershipId = randomUUID();
		while (membershipId === workspaceId) membershipId = randomUUID();

		return transaction.workspace.create({
			data: {
				id: workspaceId,
				type: WorkspaceType.PERSONAL,
				status: WorkspaceStatus.ACTIVE,
				personalOwnerUserId: userId,
				members: {
					create: {
						id: membershipId,
						userId,
						role: WorkspaceMemberRole.OWNER,
						status: WorkspaceMemberStatus.ACTIVE
					}
				}
			},
			select: { id: true }
		});
	}
}
