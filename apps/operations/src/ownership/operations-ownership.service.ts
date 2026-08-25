import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { OperationsDatabasePhase } from '@prisma/operations-client';
import { OperationsPrismaService } from '../prisma/operations-prisma.service';

@Injectable()
export class OperationsOwnershipService {
	constructor(private readonly prisma: OperationsPrismaService) {}

	async isActive(): Promise<boolean> {
		const state = await this.prisma.operationsOwnershipState.findUnique({
			where: { id: 'singleton' },
			select: { phase: true }
		});
		return state?.phase === OperationsDatabasePhase.ACTIVE;
	}

	async assertActive(): Promise<void> {
		if (!(await this.isActive())) {
			throw new ServiceUnavailableException(
				'Operations ownership is not active'
			);
		}
	}
}
