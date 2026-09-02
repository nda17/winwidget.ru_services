import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { CrmSalesPrismaService } from '../prisma/crm-sales-prisma.service';

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
		try {
			await this.prisma.$queryRaw`SELECT 1`;
			const identity = await this.prisma.serviceIdentity.findUnique({
				where: { id: 'singleton' },
				select: { serviceName: true, databaseId: true }
			});
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
