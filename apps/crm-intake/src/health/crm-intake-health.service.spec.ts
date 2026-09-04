import { ServiceUnavailableException } from '@nestjs/common';
import { CrmIntakePrismaService } from '../prisma/crm-intake-prisma.service';
import { CrmIntakeHealthService } from './crm-intake-health.service';

describe('CrmIntakeHealthService', () => {
	const createPrisma = (serviceName = 'crm-intake-service') =>
		({
			$queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
			serviceIdentity: {
				findUnique: jest.fn().mockResolvedValue({
					serviceName,
					databaseId: 'f8ee9502-a202-4d2c-8450-cd19a6b494d9'
				})
			}
		}) as unknown as CrmIntakePrismaService;

	it('reports liveness and revision without touching dependencies', () => {
		const prisma = createPrisma();
		const service = new CrmIntakeHealthService(prisma);

		expect(service.liveness()).toMatchObject({
			status: 'ok',
			service: 'crm-intake'
		});
		expect(service.revision()).toHaveProperty('revision');
		expect(prisma.$queryRaw).not.toHaveBeenCalled();
	});

	it('reports readiness only for the owned database identity', async () => {
		const service = new CrmIntakeHealthService(createPrisma());
		await expect(service.readiness()).resolves.toMatchObject({
			status: 'ready',
			service: 'crm-intake'
		});
	});

	it('fails readiness for another service database', async () => {
		const service = new CrmIntakeHealthService(
			createPrisma('crm-sales-service')
		);
		await expect(service.readiness()).rejects.toBeInstanceOf(
			ServiceUnavailableException
		);
	});

	it('fails readiness for the old skeleton schema', async () => {
		const prisma = createPrisma();
		(prisma.$queryRaw as jest.Mock)
			.mockResolvedValueOnce([])
			.mockRejectedValueOnce(new Error('table does not exist'));
		await expect(
			new CrmIntakeHealthService(prisma).readiness()
		).rejects.toBeInstanceOf(ServiceUnavailableException);
	});
});
