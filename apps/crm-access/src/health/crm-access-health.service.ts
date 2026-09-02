import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { CrmAccessPrismaService } from '../prisma/crm-access-prisma.service';

@Injectable()
export class CrmAccessHealthService {
	constructor(private readonly prisma: CrmAccessPrismaService) {}

	liveness() {
		return this.status('ok');
	}

	async readiness() {
		try {
			await this.prisma.$queryRaw`SELECT 1`;
			const identity = await this.prisma.serviceIdentity.findUnique({
				where: { id: 'singleton' },
				select: {
					serviceName: true,
					databaseId: true,
					createdAt: true,
					updatedAt: true
				}
			});
			if (
				identity?.serviceName !== 'crm-access-service' ||
				!identity.databaseId
			) {
				throw new Error('Invalid database identity');
			}
			return {
				...this.status('ready'),
				database: {
					serviceName: identity.serviceName,
					databaseId: identity.databaseId,
					createdAt: identity.createdAt.toISOString(),
					updatedAt: identity.updatedAt.toISOString()
				}
			};
		} catch {
			throw new ServiceUnavailableException(
				'CRM Access database is not ready'
			);
		}
	}

	private status(status: 'ok' | 'ready') {
		return {
			status,
			service: 'crm-access',
			revision: process.env.APP_REVISION || 'unknown'
		};
	}
}
