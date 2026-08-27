import { ServiceUnavailableException } from '@nestjs/common';
import { PlatformHealthService } from './platform-health.service';

const databaseId = '11111111-1111-4111-8111-111111111111';
const fingerprint = 'a'.repeat(64);
const createdAt = new Date('2026-08-27T10:00:00.000Z');
const updatedAt = new Date('2026-08-27T10:01:00.000Z');

function build(
	options: {
		storedFingerprint?: string;
		computedFingerprint?: string;
		rabbitReady?: boolean;
		publisherReady?: boolean;
		publisherEnabled?: boolean;
	} = {}
) {
	const prisma = {
		$queryRaw: jest
			.fn()
			.mockResolvedValueOnce([{ '?column?': 1 }])
			.mockResolvedValueOnce([
				{ fingerprint: options.computedFingerprint ?? fingerprint }
			]),
		serviceIdentity: {
			findUnique: jest.fn().mockResolvedValue({
				serviceName: 'platform-service',
				databaseId,
				currentSemanticFingerprint:
					options.storedFingerprint ?? fingerprint,
				createdAt,
				updatedAt
			})
		}
	};
	const rabbitReady = options.rabbitReady ?? true;
	const rabbit = {
		isConnected: jest.fn().mockReturnValue(rabbitReady),
		isTopologyReady: jest.fn().mockReturnValue(rabbitReady)
	};
	const publisher = {
		isReady: jest.fn().mockReturnValue(options.publisherReady ?? true)
	};
	const service = new PlatformHealthService(
		prisma as never,
		{
			role: options.publisherEnabled ? 'outbox-publisher' : 'api',
			outboxPublisherEnabled: options.publisherEnabled ?? false
		} as never,
		rabbit as never,
		publisher as never
	);
	return { service };
}

describe('PlatformHealthService', () => {
	it('reports the current database identity and semantic fingerprint', async () => {
		await expect(build().service.readiness()).resolves.toEqual({
			status: 'ready',
			service: 'platform',
			role: 'api',
			revision: expect.any(String),
			database: {
				serviceName: 'platform-service',
				databaseId,
				currentSemanticFingerprint: fingerprint,
				createdAt: createdAt.toISOString(),
				updatedAt: updatedAt.toISOString()
			}
		});
	});

	it('fails closed when the stored fingerprint differs from current data', async () => {
		await expect(
			build({ computedFingerprint: 'b'.repeat(64) }).service.readiness()
		).rejects.toBeInstanceOf(ServiceUnavailableException);
	});

	it('requires RabbitMQ and the Outbox loop for publisher readiness', async () => {
		await expect(
			build({
				publisherEnabled: true,
				rabbitReady: true,
				publisherReady: false
			}).service.readiness()
		).rejects.toThrow('Platform Outbox publisher is not ready');
	});
});
