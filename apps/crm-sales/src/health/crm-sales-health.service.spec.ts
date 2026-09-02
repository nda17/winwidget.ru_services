import { ServiceUnavailableException } from '@nestjs/common';
import { CrmSalesPrismaService } from '../prisma/crm-sales-prisma.service';
import { CrmSalesHealthService } from './crm-sales-health.service';

describe('CrmSalesHealthService', () => {
	const createPrisma = (serviceName = 'crm-sales-service') =>
		({
			$queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
			serviceIdentity: {
				findUnique: jest.fn().mockResolvedValue({
					serviceName,
					databaseId: '96c6938d-355a-46d0-bec4-c64f29bba0b2'
				})
			}
		}) as unknown as CrmSalesPrismaService;

	it('reports liveness and revision without touching dependencies', () => {
		const prisma = createPrisma();
		const service = new CrmSalesHealthService(prisma);

		expect(service.liveness()).toMatchObject({
			status: 'ok',
			service: 'crm-sales'
		});
		expect(service.revision()).toHaveProperty('revision');
		expect(prisma.$queryRaw).not.toHaveBeenCalled();
	});

	it('reports readiness only for the owned database identity', async () => {
		const service = new CrmSalesHealthService(createPrisma());
		await expect(service.readiness()).resolves.toMatchObject({
			status: 'ready',
			service: 'crm-sales'
		});
	});

	it('fails readiness for another service database', async () => {
		const service = new CrmSalesHealthService(
			createPrisma('crm-customers-service')
		);
		await expect(service.readiness()).rejects.toBeInstanceOf(
			ServiceUnavailableException
		);
	});
});
