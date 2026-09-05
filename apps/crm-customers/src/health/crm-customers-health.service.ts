import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { CrmCustomersPrismaService } from '../prisma/crm-customers-prisma.service';

const SERVICE_NAME = 'crm-customers';
const DATABASE_SERVICE_NAME = 'crm-customers-service';

@Injectable()
export class CrmCustomersHealthService {
	constructor(private readonly prisma: CrmCustomersPrismaService) {}

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
			await this.prisma
				.$queryRaw`SELECT id, workspace_id, actor_subject, entity, format, row_count, byte_count, snapshot_at, prepared_at FROM crm_customers.export_audit LIMIT 0`;
			await this.prisma
				.$queryRaw`SELECT operation_id, workspace_id, workflow_id, actor_subject, payload_hash, state, contact_id, result, committed_at FROM crm_customers.intake_operation_slots LIMIT 0`;
			await this.prisma
				.$queryRaw`SELECT command_id, workspace_id, actor_subject, request_hash, result FROM crm_customers.intake_operation_commands LIMIT 0`;
			await this.prisma
				.$queryRaw`SELECT c.id, c.workspace_id, c.name, c.phone, c.email, c.company_id, c.notes, c.created_by_subject, c.team_id, c.version, c.archived_at, c.created_at, c.updated_at FROM crm_customers.contacts c LIMIT 0`;
			await this.prisma
				.$queryRaw`SELECT c.id, c.workspace_id, c.name, c.inn, c.website, c.notes, c.created_by_subject, c.team_id, c.version, c.archived_at, c.created_at, c.updated_at FROM crm_customers.companies c LIMIT 0`;
			await this.prisma
				.$queryRaw`SELECT command_id, workspace_id, entity_id, entity_kind, actor_subject, request_hash, response, created_at FROM crm_customers.customer_commands LIMIT 0`;
			await this.prisma
				.$queryRaw`SELECT id, workspace_id, entity_id, entity_kind, command_id, actor_subject, action, entity_version, changed_fields, created_at FROM crm_customers.customer_activities LIMIT 0`;
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
				'CRM Customers database is not ready'
			);
		}

		return {
			status: 'ready',
			service: SERVICE_NAME,
			revision: process.env.APP_REVISION || 'unknown'
		};
	}
}
