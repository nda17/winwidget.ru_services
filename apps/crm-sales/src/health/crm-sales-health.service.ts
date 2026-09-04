import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { CrmSalesPrismaService } from '../prisma/crm-sales-prisma.service';
import { salesAccessToken, serviceOrigin } from '../sales/sales-access';

const SERVICE_NAME = 'crm-sales';
const DATABASE_SERVICE_NAME = 'crm-sales-service';

@Injectable()
export class CrmSalesHealthService {
	constructor(private readonly prisma: CrmSalesPrismaService) {}

	liveness() {
		return {
			status: 'ok',
			service: SERVICE_NAME,
			revision: process.env.APP_REVISION || 'unknown'
		};
	}

	revision() {
		return {
			service: SERVICE_NAME,
			revision: process.env.APP_REVISION || 'unknown'
		};
	}

	async readiness() {
		serviceOrigin(process.env.CRM_ACCESS_INTERNAL_BASE_URL);
		serviceOrigin(process.env.CRM_CUSTOMERS_INTERNAL_BASE_URL);
		salesAccessToken();
		try {
			await this.prisma.$queryRaw`SELECT 1`;
			const [identity] = await Promise.all([
				this.prisma.serviceIdentity.findUnique({
					where: { id: 'singleton' },
					select: { serviceName: true, databaseId: true }
				}),
				this.prisma.pipeline.findFirst({ select: { id: true } }),
				this.prisma.pipelineStage.findFirst({ select: { id: true } }),
				this.prisma.pipelineTemplateInstallation.findFirst({
					select: { id: true }
				}),
				this.prisma.pipelineTemplateInstallationCommand.findFirst({
					select: { commandId: true }
				}),
				this.prisma.deal.findFirst({
					select: { id: true, nextTaskId: true, version: true }
				}),
				this.prisma.salesTask.findFirst({
					select: { id: true, version: true }
				}),
				this.prisma.dealTimeline.findFirst({ select: { id: true } }),
				this.prisma.salesCommandReceipt.findFirst({
					select: { commandId: true }
				})
			]);
			if (
				identity?.serviceName !== DATABASE_SERVICE_NAME ||
				!identity.databaseId
			) {
				throw new Error('Invalid service identity');
			}
		} catch {
			throw new ServiceUnavailableException(
				'CRM Sales database is not ready'
			);
		}

		return {
			status: 'ready',
			service: SERVICE_NAME,
			revision: process.env.APP_REVISION || 'unknown'
		};
	}
}
