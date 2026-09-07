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

	it('checks every company requisite before declaring the runtime ready', async () => {
		const prisma = createPrisma();
		await new CrmCustomersHealthService(prisma).readiness();
		const queries = (prisma.$queryRaw as jest.Mock).mock.calls.map(
			([parts]) => parts.join('') as string
		);
		const company = queries.find(query =>
			query.includes('FROM crm_customers.companies')
		);
		for (const column of [
			'legal_name',
			'kpp',
			'ogrn',
			'legal_address',
			'entity_type'
		]) {
			expect(company).toContain(`c.${column}`);
		}
	});

	it('fails readiness when the owned customer migration is missing', async () => {
		const prisma = createPrisma();
		(prisma.$queryRaw as jest.Mock)
			.mockResolvedValueOnce([])
			.mockRejectedValueOnce(new Error('column does not exist'));
		await expect(
			new CrmCustomersHealthService(prisma).readiness()
		).rejects.toBeInstanceOf(ServiceUnavailableException);
	});
});
