import { ServiceUnavailableException } from '@nestjs/common';
import { CrmAccessHealthService } from './crm-access-health.service';

const identity = {
	serviceName: 'crm-access-service',
	databaseId: '11111111-1111-4111-8111-111111111111',
	createdAt: new Date('2026-09-02T10:00:00.000Z'),
	updatedAt: new Date('2026-09-02T10:00:00.000Z')
};

describe('CrmAccessHealthService', () => {
	it('reports liveness without testing dependencies', () => {
		const health = new CrmAccessHealthService({} as never);
		expect(health.liveness()).toMatchObject({
			status: 'ok',
			service: 'crm-access'
		});
	});

	it('requires its own database and exact service identity for readiness', async () => {
		const health = new CrmAccessHealthService({
			$queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
			serviceIdentity: {
				findUnique: jest.fn().mockResolvedValue(identity)
			},
			crmWorkspaceAccess: {
				findFirst: jest.fn().mockResolvedValue(null)
			}
		} as never);
		await expect(health.readiness()).resolves.toMatchObject({
			status: 'ready',
			service: 'crm-access',
			database: {
				serviceName: 'crm-access-service',
				databaseId: identity.databaseId
			}
		});
	});

	it('fails readiness closed for a missing or foreign database identity', async () => {
		const health = new CrmAccessHealthService({
			$queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
			serviceIdentity: {
				findUnique: jest.fn().mockResolvedValue({
					...identity,
					serviceName: 'other-service'
				})
			},
			crmWorkspaceAccess: {
				findFirst: jest.fn().mockResolvedValue(null)
			}
		} as never);
		await expect(health.readiness()).rejects.toBeInstanceOf(
			ServiceUnavailableException
		);
	});

	it('fails readiness closed when the onboarding schema is missing', async () => {
		const health = new CrmAccessHealthService({
			$queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
			serviceIdentity: {
				findUnique: jest.fn().mockResolvedValue(identity)
			},
			crmWorkspaceAccess: {
				findFirst: jest.fn().mockRejectedValue(new Error('missing column'))
			}
		} as never);
		await expect(health.readiness()).rejects.toBeInstanceOf(
			ServiceUnavailableException
		);
	});
});
