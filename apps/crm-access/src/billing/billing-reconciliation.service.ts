import {
	BeforeApplicationShutdown,
	Injectable,
	OnModuleInit
} from '@nestjs/common';
import { CrmAccessPrismaService } from '../prisma/crm-access-prisma.service';
import { CrmAccessRuntimeService } from '../runtime/crm-access-runtime.service';
import { BillingCommerceClient } from './billing-commerce.client';
import { CrmBillingCapacityService } from './billing-capacity.service';

@Injectable()
export class CrmBillingReconciliationService
	implements OnModuleInit, BeforeApplicationShutdown
{
	private timer: NodeJS.Timeout | undefined;
	private active: Promise<void> | undefined;
	private stopping = false;
	constructor(
		private readonly prisma: CrmAccessPrismaService,
		private readonly billing: BillingCommerceClient,
		private readonly capacity: CrmBillingCapacityService,
		private readonly runtime: CrmAccessRuntimeService
	) {}
	onModuleInit() {
		if (this.billing.enabled && this.runtime.workerEnabled)
			this.schedule();
	}
	private schedule() {
		if (this.stopping) return;
		this.timer = setTimeout(() => {
			this.active = this.tick()
				.catch(() => undefined)
				.finally(() => {
					this.active = undefined;
					this.schedule();
				});
		}, 5000);
	}
	async tick() {
		// Durable operations are the work queue; only bounded technical proof reads.
		const due = await this.prisma.$queryRaw<
			Array<{ commandId: string; workspaceId: string }>
		>`SELECT command_id AS "commandId", workspace_id AS "workspaceId" FROM crm_access.crm_billing_operations WHERE release_fence = false AND next_check_at <= clock_timestamp() ORDER BY next_check_at, command_id LIMIT 25`;
		for (let i = 0; i < due.length && !this.stopping; i += 5)
			await Promise.allSettled(
				due.slice(i, i + 5).map(async row => {
					const operation = await this.capacity.known(
						row.workspaceId,
						row.commandId
					);
					await this.capacity.synchronize(operation);
				})
			);
	}
	async beforeApplicationShutdown() {
		this.stopping = true;
		if (this.timer) clearTimeout(this.timer);
		await this.active;
	}
}
