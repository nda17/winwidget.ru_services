import { ServiceUnavailableException } from '@nestjs/common';
import { CrmCustomersPrismaService } from '../prisma/crm-customers-prisma.service';
import { CrmCustomersHealthService } from './crm-customers-health.service';

describe('CrmCustomersHealthService', () => {
	const createPrisma = (serviceName = 'crm-customers-service') =>
		({
			$queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
			serviceIdentity: {
				findUnique: jest.fn().mockResolvedValue({
					serviceName,
					databaseId: '6cda344c-eaf5-40d9-97d4-45eaa56985a9'
				})
			}
		}) as unknown as CrmCustomersPrismaService;

	it('reports liveness and revision without touching dependencies', () => {
		const prisma = createPrisma();
		const service = new CrmCustomersHealthService(prisma);

		expect(service.liveness()).toMatchObject({
			status: 'ok',
			service: 'crm-customers'
		});
		expect(service.revision()).toHaveProperty('revision');
		expect(prisma.$queryRaw).not.toHaveBeenCalled();
	});

	it('reports readiness only for the owned database identity', async () => {
		const service = new CrmCustomersHealthService(createPrisma());
		await expect(service.readiness()).resolves.toMatchObject({
			status: 'ready',
			service: 'crm-customers'
		});
	});

	it('fails readiness for another service database', async () => {
		const service = new CrmCustomersHealthService(
			createPrisma('crm-intake-service')
		);
		await expect(service.readiness()).rejects.toBeInstanceOf(
			ServiceUnavailableException
		);
	});
});
