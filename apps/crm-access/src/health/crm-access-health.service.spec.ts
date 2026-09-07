import { ServiceUnavailableException } from '@nestjs/common';
import { CrmAccessHealthService } from './crm-access-health.service';

const identity = {
	serviceName: 'crm-access-service',
	databaseId: '11111111-1111-4111-8111-111111111111',
	createdAt: new Date('2026-09-02T10:00:00.000Z'),
	updatedAt: new Date('2026-09-02T10:00:00.000Z')
};

describe('CrmAccessHealthService', () => {
	const runtimeReady = { isReady: jest.fn().mockReturnValue(true) };
	const createHealth = (prisma: unknown) =>
		new CrmAccessHealthService(
			prisma as never,
			runtimeReady as never,
			runtimeReady as never
		);
	it('reports liveness without testing dependencies', () => {
		const health = createHealth({});
		expect(health.liveness()).toMatchObject({
			status: 'ok',
			service: 'crm-access'
		});
	});

	it('requires its own database and exact service identity for readiness', async () => {
		const health = createHealth({
			crmWorkspaceMember: { findFirst: jest.fn().mockResolvedValue(null) },
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
		const health = createHealth({
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
		const health = createHealth({
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
	it('fails readiness closed when workspace branding schema or SELECT privilege is missing', async () => {
		const query = jest
			.fn()
			.mockImplementation(async (parts: TemplateStringsArray) => {
				if (parts.join('').includes('crm_workspace_branding'))
					throw new Error('missing schema or privilege');
				return [];
			});
		const health = createHealth({
			$queryRaw: query,
			serviceIdentity: {
				findUnique: jest.fn().mockResolvedValue(identity)
			},
			crmWorkspaceAccess: { findFirst: jest.fn() },
			crmWorkspaceMember: { findFirst: jest.fn() }
		});
		await expect(health.readiness()).rejects.toBeInstanceOf(
			ServiceUnavailableException
		);
		expect(
			query.mock.calls.some(([parts]) =>
				parts.join('').includes('crm_workspace_branding')
			)
		).toBe(true);
	});
});
