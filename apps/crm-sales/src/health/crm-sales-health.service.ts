import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { CrmSalesPrismaService } from '../prisma/crm-sales-prisma.service';
import { salesAccessToken, serviceOrigin } from '../sales/sales-access';
import { intakeOperationToken } from '../intake-operations/intake-operation.client';

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
		intakeOperationToken('CRM_SALES_CRM_INTAKE_TOKEN');
		intakeOperationToken('CRM_CUSTOMERS_CRM_SALES_TOKEN');
		try {
			await this.prisma.$queryRaw`SELECT 1`;
			await this.prisma
				.$queryRaw`SELECT id, workspace_id, actor_subject, entity, format, row_count, byte_count, snapshot_at, prepared_at FROM crm_sales.export_audit LIMIT 0`;
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
					select: {
						id: true,
						version: true,
						assignedToMembershipId: true,
						teamId: true
					}
				}),
				this.prisma.taskCommandReceipt.findFirst({
					select: { commandId: true }
				}),
				this.prisma.taskTimeline.findFirst({ select: { id: true } }),
				this.prisma.reminderRule.findFirst({
					select: {
						id: true,
						version: true,
						configuration: true,
						ownerMembershipId: true,
						archivedAt: true
					}
				}),
				this.prisma.reminderRuleCommand.findFirst({
					select: {
						commandId: true,
						actorMembershipId: true,
						before: true,
						result: true
					}
				}),
				this.prisma.reminderJob.findFirst({
					select: {
						id: true,
						leaseToken: true,
						leaseExpiresAt: true,
						cursor: true
					}
				}),
				this.prisma.reminderDelivery.findFirst({
					select: {
						id: true,
						taskVersion: true,
						ruleVersion: true,
						recipientMembershipId: true
					}
				}),
				this.prisma.reminderOutbox.findFirst({
					select: {
						id: true,
						status: true,
						availableAt: true,
						leaseToken: true
					}
				}),
				this.prisma.reminderRuntime.findFirst({
					select: { id: true, ready: true, lastSeenAt: true }
				}),
				this.prisma.dealTimeline.findFirst({ select: { id: true } }),
				this.prisma.salesCommandReceipt.findFirst({
					select: { commandId: true }
				}),
				this.prisma.intakeOperationSlot.findFirst({
					select: { operationId: true, state: true }
				}),
				this.prisma.intakeOperationCommand.findFirst({
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
