import { ServiceUnavailableException } from '@nestjs/common';
import { PlatformOwnershipService } from './platform-ownership.service';

const activeIdentity = () => ({
	serviceName: 'platform-service',
	phase: 'ACTIVE',
	ownershipGeneration: 1n,
	sourceFingerprint: 'a'.repeat(64),
	sourceHighWatermark: 1n,
	importedAt: new Date('2026-08-23T10:00:00.000Z'),
	activatedAt: new Date('2026-08-23T10:01:00.000Z')
});

function service(identity: unknown) {
	return new PlatformOwnershipService({
		serviceIdentity: {
			findUnique: jest.fn().mockResolvedValue(identity)
		}
	} as never);
}

describe('PlatformOwnershipService', () => {
	it('accepts only the exact imported ACTIVE ownership fence', async () => {
		await expect(service(activeIdentity()).isActive()).resolves.toBe(true);
	});

	it.each([
		{
			...activeIdentity(),
			phase: 'SHADOW',
			activatedAt: null
		},
		{ ...activeIdentity(), sourceFingerprint: 'invalid' },
		{ ...activeIdentity(), sourceHighWatermark: null },
		{ ...activeIdentity(), sourceHighWatermark: 0n },
		{ ...activeIdentity(), ownershipGeneration: 0n }
	])(
		'rejects an inactive or incomplete ownership fence',
		async identity => {
			const current = service(identity);
			await expect(current.isActive()).resolves.toBe(false);
			await expect(current.assertActive()).rejects.toBeInstanceOf(
				ServiceUnavailableException
			);
		}
	);
});
