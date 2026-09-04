import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { CrmIntakePrismaService } from '../prisma/crm-intake-prisma.service';

const SERVICE_NAME = 'crm-intake';
const DATABASE_SERVICE_NAME = 'crm-intake-service';

@Injectable()
export class CrmIntakeHealthService {
	constructor(private readonly prisma: CrmIntakePrismaService) {}

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
				.$queryRaw`SELECT id, workspace_id, title, name, phone, email, message, origin, source_id, status, created_by_subject, team_id, version, contact_id, deal_id, rejection_reason, received_at, updated_at, accepted_at, rejected_at FROM crm_intake.inbox_entries LIMIT 0`;
			await this.prisma
				.$queryRaw`SELECT id, workspace_id, name, kind, token_hash, token_version, created_by_subject, team_id, version, revoked_at, created_at, updated_at FROM crm_intake.intake_sources LIMIT 0`;
			await this.prisma
				.$queryRaw`SELECT command_id, workspace_id, entity_id, entity_kind, actor_subject, request_hash, response, created_at FROM crm_intake.intake_commands LIMIT 0`;
			await this.prisma
				.$queryRaw`SELECT id, workspace_id, entity_id, entity_kind, command_id, actor_subject, action, entity_version, created_at FROM crm_intake.intake_activities LIMIT 0`;
			await this.prisma
				.$queryRaw`SELECT source_id, external_command_id, workspace_id, entry_id, audit_command_id, request_hash, received_at FROM crm_intake.inbound_receipts LIMIT 0`;
			await this.prisma
				.$queryRaw`SELECT bucket_key, window_start, count FROM crm_intake.ingestion_rate_buckets LIMIT 0`;
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
				'CRM Intake database is not ready'
			);
		}

		return {
			status: 'ready',
			service: SERVICE_NAME,
			revision: process.env.APP_REVISION || 'unknown'
		};
	}
}
