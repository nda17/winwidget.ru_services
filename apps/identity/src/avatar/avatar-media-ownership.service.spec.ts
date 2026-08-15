import { ServiceUnavailableException } from '@nestjs/common';
import { AvatarMediaOwnershipPhase } from '@prisma/identity-client';
import { AvatarMediaOwnershipService } from './avatar-media-ownership.service';

describe('AvatarMediaOwnershipService', () => {
	it('permits avatar mutations only after the durable singleton is ACTIVE', async () => {
		const prisma = {
			avatarMediaOwnership: {
				findUnique: jest
					.fn()
					.mockResolvedValueOnce({
						phase: AvatarMediaOwnershipPhase.PREPARED
					})
					.mockResolvedValueOnce({
						phase: AvatarMediaOwnershipPhase.ACTIVE
					})
			}
		};
		const service = new AvatarMediaOwnershipService(prisma as any);

		await expect(service.assertActive()).rejects.toBeInstanceOf(
			ServiceUnavailableException
		);
		await expect(service.assertActive()).resolves.toBeUndefined();
		expect(prisma.avatarMediaOwnership.findUnique).toHaveBeenCalledWith({
			where: { id: 'singleton' },
			select: { phase: true }
		});
	});

	it('fails closed when the singleton is missing', async () => {
		const prisma = {
			avatarMediaOwnership: {
				findUnique: jest.fn().mockResolvedValue(null)
			}
		};
		const service = new AvatarMediaOwnershipService(prisma as any);

		await expect(service.assertActive()).rejects.toBeInstanceOf(
			ServiceUnavailableException
		);
	});

	it('maps a database failure to a fail-closed 503', async () => {
		const prisma = {
			avatarMediaOwnership: {
				findUnique: jest
					.fn()
					.mockRejectedValue(new Error('db unavailable'))
			}
		};
		const service = new AvatarMediaOwnershipService(prisma as any);

		await expect(service.assertActive()).rejects.toThrow(
			'Avatar media ownership is unavailable'
		);
	});
});
