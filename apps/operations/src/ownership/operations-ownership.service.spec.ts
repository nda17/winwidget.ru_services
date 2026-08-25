import { ServiceUnavailableException } from '@nestjs/common';
import { OperationsDatabasePhase } from '@prisma/operations-client';
import { OperationsPrismaService } from '../prisma/operations-prisma.service';
import { OperationsOwnershipService } from './operations-ownership.service';

describe('OperationsOwnershipService', () => {
	function serviceFor(phase: OperationsDatabasePhase | null) {
		const prisma = {
			operationsOwnershipState: {
				findUnique: jest
					.fn()
					.mockResolvedValue(phase === null ? null : { phase })
			}
		} as unknown as OperationsPrismaService;
		return new OperationsOwnershipService(prisma);
	}

	it('reports ACTIVE ownership', async () => {
		await expect(
			serviceFor(OperationsDatabasePhase.ACTIVE).isActive()
		).resolves.toBe(true);
	});

	it('fails closed when ownership is staged or absent', async () => {
		await expect(
			serviceFor(OperationsDatabasePhase.EMPTY).assertActive()
		).rejects.toBeInstanceOf(ServiceUnavailableException);
		await expect(serviceFor(null).isActive()).resolves.toBe(false);
	});
});
