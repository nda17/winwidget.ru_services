import {
	ForbiddenException,
	Injectable,
	ServiceUnavailableException
} from '@nestjs/common';
import { CrmAccessPrismaService } from '../prisma/crm-access-prisma.service';
import { isRecord } from '../internal/internal-http.config';
import { BillingCommerceClient } from './billing-commerce.client';
import {
	CrmBillingCapacityService,
	operationView,
	effectiveAdmissionCeiling
} from './billing-capacity.service';
import {
	parseCommand,
	parseQuote,
	workspace,
	invalid,
	requireBilling
} from './billing.validation';
import type {
	CommerceCommandType,
	CrmBillingContext,
	WincrmCommerceSummary,
	WincrmCommerceQuote,
	WincrmOrderResponse,
	WincrmHistoryResponse
} from './billing.contract';

@Injectable()
export class CrmBillingService {
	constructor(
		private readonly prisma: CrmAccessPrismaService,
		private readonly billing: BillingCommerceClient,
		private readonly capacity: CrmBillingCapacityService
	) {}
	async context(
		authorization: string | undefined,
		workspaceId: string
	): Promise<CrmBillingContext> {
		const actorSubject = await this.capacity.owner(
			workspaceId,
			authorization
		);
		await this.capacity.syncPending(workspaceId);
		const billing = await this.billing.request<WincrmCommerceSummary>(
			'summary',
			{ schemaVersion: 1, workspaceId, actorSubject } as Parameters<
				BillingCommerceClient['request']
			>[1],
			'summary'
		);
		const [state, members] = await Promise.all([
			this.prisma.crmBillingCapacity.findUnique({
				where: { workspaceId }
			}),
			this.prisma.crmWorkspaceMember.count({
				where: { workspaceId, disabledAt: null }
			})
		]);
		await this.revalidate(workspaceId, authorization, actorSubject);
		const period = billing.period;
		const periodBlocks =
			period && ['ACTIVE', 'SCHEDULED'].includes(period.state);
		const seatLimit =
			period && period.state !== 'SCHEDULED'
				? period.totalSeats
				: (billing.trial?.seatLimit ?? null);
		return {
			schemaVersion: 1,
			workspaceId,
			actorSubject,
			billing,
			capacity: {
				usedSeats: members + 1,
				admissionCeiling:
					seatLimit === null
						? (state?.admissionCeiling ??
							state?.pendingTargetSeats ??
							null)
						: effectiveAdmissionCeiling(seatLimit, state),
				pendingOperationId: state?.pendingOperationId ?? null
			},
			capabilities: {
				quote: true,
				checkout:
					!periodBlocks &&
					!billing.pendingOrder &&
					!state?.pendingOperationId,
				changeSeats:
					period?.state === 'ACTIVE' &&
					!state?.pendingOperationId &&
					!billing.pendingOrder,
				disableAutoRenew: billing.renewal.canDisable,
				confirmRenewalPrice:
					billing.renewal.state === 'PRICE_CONFIRMATION_REQUIRED'
			}
		};
	}
	async quote(authorization: string | undefined, value: unknown) {
		requireBilling(this.billing.enabled);
		const body = parseQuote(value);
		const actorSubject = await this.capacity.owner(
			body.workspaceId,
			authorization
		);
		const result = await this.billing.request<WincrmCommerceQuote>(
			'quote',
			{ ...body, actorSubject },
			'quote'
		);
		if (
			result.intent !== body.intent ||
			result.cycle !== body.cycle ||
			result.totalSeats !== body.totalSeats
		)
			throw new ServiceUnavailableException(
				'CRM billing quote binding is invalid'
			);
		await this.revalidate(body.workspaceId, authorization, actorSubject);
		return result;
	}
	async command(
		type: CommerceCommandType,
		authorization: string | undefined,
		value: unknown,
		key: string | undefined
	) {
		requireBilling(this.billing.enabled);
		if (!isRecord(value)) invalid();
		const workspaceId = workspace(value.workspaceId);
		const actorSubject = await this.capacity.owner(
			workspaceId,
			authorization
		);
		const command = parseCommand(type, value, key, actorSubject);
		let currentSeatLimit: number | null = null;
		if (
			(type === 'WINCRM_CHECKOUT' || type === 'WINCRM_SEAT_CHANGE') &&
			!(await this.prisma.crmBillingOperation.findUnique({
				where: { commandId: command.commandId }
			}))
		) {
			const summary = await this.billing.request<WincrmCommerceSummary>(
				'summary',
				{ schemaVersion: 1, workspaceId, actorSubject },
				'summary'
			);
			currentSeatLimit =
				summary.period && summary.period.state !== 'SCHEDULED'
					? summary.period.totalSeats
					: (summary.trial?.seatLimit ?? null);
		}
		const operation = await this.capacity.prepare(
			type,
			command,
			currentSeatLimit
		);
		const result = await this.capacity.execute(operation);
		await this.revalidate(workspaceId, authorization, actorSubject);
		return result;
	}
	async operation(
		authorization: string | undefined,
		workspaceId: string,
		commandId: string,
		recover = false
	) {
		const actorSubject = await this.capacity.owner(
			workspaceId,
			authorization
		);
		const result = recover
			? await this.capacity.recover(workspaceId, commandId, actorSubject)
			: operationView(
					await this.capacity.synchronize(
						await this.capacity.known(workspaceId, commandId)
					)
				);
		await this.revalidate(workspaceId, authorization, actorSubject);
		return result;
	}
	async order(
		authorization: string | undefined,
		workspaceId: string,
		orderId: string
	) {
		const actorSubject = await this.capacity.owner(
			workspaceId,
			authorization
		);
		const result = await this.billing.request<WincrmOrderResponse>(
			'orders/get',
			{
				schemaVersion: 1,
				workspaceId,
				actorSubject,
				orderId
			} as Parameters<BillingCommerceClient['request']>[1],
			'order'
		);
		if (result.order.id !== orderId)
			throw new ServiceUnavailableException(
				'CRM billing order binding is invalid'
			);
		await this.revalidate(workspaceId, authorization, actorSubject);
		return result;
	}
	async history(
		authorization: string | undefined,
		workspaceId: string,
		page: number,
		pageSize: number
	) {
		const actorSubject = await this.capacity.owner(
			workspaceId,
			authorization
		);
		const result = await this.billing.request<WincrmHistoryResponse>(
			'history',
			{
				schemaVersion: 1,
				workspaceId,
				actorSubject,
				page,
				pageSize
			} as Parameters<BillingCommerceClient['request']>[1],
			'history'
		);
		if (result.page !== page || result.pageSize !== pageSize)
			throw new ServiceUnavailableException(
				'CRM billing history binding is invalid'
			);
		await this.revalidate(workspaceId, authorization, actorSubject);
		return result;
	}
	private async revalidate(
		workspaceId: string,
		authorization: string | undefined,
		subject: string
	) {
		if (
			(await this.capacity.owner(workspaceId, authorization)) !== subject
		)
			throw new ForbiddenException('CRM billing session changed');
	}
}
