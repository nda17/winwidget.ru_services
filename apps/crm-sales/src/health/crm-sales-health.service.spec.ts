import { ServiceUnavailableException } from '@nestjs/common';
import { CrmSalesPrismaService } from '../prisma/crm-sales-prisma.service';
import { CrmSalesHealthService } from './crm-sales-health.service';

describe('CrmSalesHealthService', () => {
	const createPrisma = (serviceName = 'crm-sales-service') =>
		({
			$queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
			pipeline: { findFirst: jest.fn().mockResolvedValue(null) },
			pipelineStage: { findFirst: jest.fn().mockResolvedValue(null) },
			pipelineTemplateInstallation: {
				findFirst: jest.fn().mockResolvedValue(null)
			},
			pipelineTemplateInstallationCommand: {
				findFirst: jest.fn().mockResolvedValue(null)
			},
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
		const prisma = createPrisma();
		const service = new CrmSalesHealthService(prisma);
		await expect(service.readiness()).resolves.toMatchObject({
			status: 'ready',
			service: 'crm-sales'
		});
		expect(prisma.pipeline.findFirst).toHaveBeenCalledWith({
			select: { id: true }
		});
		expect(prisma.pipelineStage.findFirst).toHaveBeenCalledWith({
			select: { id: true }
		});
		expect(
			prisma.pipelineTemplateInstallation.findFirst
		).toHaveBeenCalledWith({ select: { id: true } });
		expect(
			prisma.pipelineTemplateInstallationCommand.findFirst
		).toHaveBeenCalledWith({ select: { commandId: true } });
	});

	it('fails readiness for another service database', async () => {
		const service = new CrmSalesHealthService(
			createPrisma('crm-customers-service')
		);
		await expect(service.readiness()).rejects.toBeInstanceOf(
			ServiceUnavailableException
		);
	});

	it('fails readiness when the latest CRM Sales schema is unavailable', async () => {
		const prisma = createPrisma();
		(
			prisma.pipelineTemplateInstallationCommand.findFirst as jest.Mock
		).mockRejectedValue(new Error('relation does not exist'));
		const service = new CrmSalesHealthService(prisma);
		await expect(service.readiness()).rejects.toBeInstanceOf(
			ServiceUnavailableException
		);
	});
});
