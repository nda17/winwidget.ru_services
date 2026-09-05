import {
	ConflictException,
	ForbiddenException,
	Injectable,
	NotFoundException,
	ServiceUnavailableException
} from '@nestjs/common';
import {
	Prisma,
	type CrmBillingOperation
} from '@prisma/crm-access-client';
import { randomUUID } from 'node:crypto';
import { CrmAccessPrismaService } from '../prisma/crm-access-prisma.service';
import { IdentityAuthContextClient } from '../internal/identity-auth-context.client';
import { getCrmAccessCorrelationId } from '../common/crm-access-request-context';
import {
	auditTeam,
	emitTeamEvent,
	json,
	serializable,
	workspaceLock
} from '../team/team.util';
import { BillingCommerceClient } from './billing-commerce.client';
import { commerceHash, requireBilling } from './billing.validation';
import type {
	CommerceCommandType,
	CommerceUserCommand,
	CrmBillingOperationView,
	WincrmCapacityFence,
	WincrmCommerceCommandProof
} from './billing.contract';

export function effectiveAdmissionCeiling(
	remote: number,
	capacity: {
		admissionCeiling: number | null;
		pendingTargetSeats: number | null;
	} | null
): number {
	return Math.min(
		remote,
		capacity?.admissionCeiling ?? remote,
		capacity?.pendingTargetSeats ?? remote
	);
}
const route = {
	WINCRM_CHECKOUT: 'checkout',
	WINCRM_SEAT_CHANGE: 'seats',
	WINCRM_DISABLE_RENEWAL: 'renewal/disable',
	WINCRM_CONFIRM_RENEWAL: 'renewal/confirm-price',
	WINCRM_VERIFY_ORDER: 'orders/verify'
} as const;
export const operationView = (
	op: CrmBillingOperation
): CrmBillingOperationView => ({
	schemaVersion: 1,
	workspaceId: op.workspaceId,
	commandId: op.commandId,
	state: op.state as CrmBillingOperationView['state'],
	requestHash: op.requestHash,
	billing: op.proof as unknown as WincrmCommerceCommandProof | null
});

@Injectable()
export class CrmBillingCapacityService {
	constructor(
		private readonly prisma: CrmAccessPrismaService,
		private readonly billing: BillingCommerceClient,
		private readonly identity: IdentityAuthContextClient
	) {}
	async owner(
		workspaceId: string,
		authorization: string | undefined
	): Promise<string> {
		requireBilling(this.billing.enabled);
		const auth = await this.identity.authContext(
			authorization,
			getCrmAccessCorrelationId()
		);
		if (
			!auth.memberships.some(
				m => m.workspaceId === workspaceId && m.role === 'OWNER'
			)
		)
			throw new ForbiddenException(
				'CRM billing requires the workspace owner'
			);
		await this.canonicalOwner(workspaceId, auth.subject);
		return auth.subject;
	}
	async canonicalOwner(workspaceId: string, subject: string) {
		const context = await this.identity.widgetSourceContext(
			workspaceId,
			subject,
			getCrmAccessCorrelationId()
		);
		if (
			context.ownerSubject !== subject ||
			context.membership?.role !== 'OWNER'
		)
			throw new ForbiddenException({
				message: 'CRM billing owner authority was revoked',
				code: 'OPERATION_AUTHORIZATION_REVOKED'
			});
	}
	private async lock(
		tx: Prisma.TransactionClient,
		workspaceId: string,
		commandId?: string
	) {
		await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '2000ms'");
		await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '4000ms'");
		if (commandId)
			await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`wincrm-team-command:${commandId}`},0))`;
		await workspaceLock(tx, workspaceId);
	}
	async prepare(
		commandType: CommerceCommandType,
		request: CommerceUserCommand,
		currentSeatLimit: number | null = null
	): Promise<CrmBillingOperation> {
		const requestHash = commerceHash(commandType, request);
		const targetSeats =
			'totalSeats' in request
				? request.totalSeats
				: 'newTotalSeats' in request
					? request.newTotalSeats
					: null;
		return serializable(this.prisma, async tx => {
			await this.lock(tx, request.workspaceId, request.commandId);
			const prior = await tx.crmBillingOperation.findUnique({
				where: { commandId: request.commandId }
			});
			if (prior) {
				if (
					prior.workspaceId !== request.workspaceId ||
					prior.actorSubject !== request.actorSubject ||
					prior.commandType !== commandType ||
					prior.requestHash !== requestHash
				)
					throw new ConflictException(
						'CRM billing command conflicts with a prior operation'
					);
				return prior;
			}
			if (
				await tx.crmTeamCommandReceipt.findUnique({
					where: { commandId: request.commandId }
				})
			)
				throw new ConflictException(
					'CRM command identifier is already used'
				);
			let fenceRevision: number | null = null;
			if (targetSeats !== null) {
				const capacity = await tx.crmBillingCapacity.upsert({
					where: { workspaceId: request.workspaceId },
					create: {
						workspaceId: request.workspaceId,
						admissionCeiling: currentSeatLimit
					},
					update: {}
				});
				if (capacity.pendingOperationId)
					throw new ConflictException(
						'Resolve the pending CRM billing operation first'
					);
				const usedSeats =
					1 +
					(await tx.crmWorkspaceMember.count({
						where: { workspaceId: request.workspaceId, disabledAt: null }
					}));
				if (targetSeats < usedSeats)
					throw new ConflictException(
						'CRM seats cannot be lower than the active roster'
					);
				if (capacity.revision >= 2147483646)
					throw new ConflictException(
						'CRM capacity revision is exhausted'
					);
				fenceRevision = capacity.revision + 1;
			}
			await tx.crmTeamCommandReceipt.create({
				data: {
					commandId: request.commandId,
					workspaceId: request.workspaceId,
					actorSubject: request.actorSubject,
					commandType,
					requestHash,
					result: { schemaVersion: 1, operationId: request.commandId }
				}
			});
			const operation = await tx.crmBillingOperation.create({
				data: {
					commandId: request.commandId,
					workspaceId: request.workspaceId,
					actorSubject: request.actorSubject,
					commandType,
					requestHash,
					request: json(request),
					targetSeats,
					fenceRevision
				}
			});
			if (targetSeats !== null)
				await tx.crmBillingCapacity.update({
					where: { workspaceId: request.workspaceId },
					data: {
						revision: fenceRevision!,
						pendingOperationId: request.commandId,
						pendingTargetSeats: targetSeats
					}
				});
			await this.audit(tx, operation, 'BILLING_OPERATION_PREPARED');
			return operation;
		});
	}
	fence(op: CrmBillingOperation): WincrmCapacityFence {
		if (
			!op.requestHash ||
			op.fenceRevision === null ||
			op.targetSeats === null
		)
			throw new Error('CAPACITY_BINDING_UNAVAILABLE');
		return {
			operationId: op.commandId,
			requestHash: op.requestHash,
			fenceRevision: op.fenceRevision,
			targetSeats: op.targetSeats
		};
	}
	async execute(
		op: CrmBillingOperation
	): Promise<CrmBillingOperationView> {
		if (op.state !== 'PENDING') return operationView(op);
		const request = op.request as unknown as CommerceUserCommand;
		// Fresh owner check after reservation and immediately before a new write.
		await this.canonicalOwner(op.workspaceId, op.actorSubject);
		const body = {
			...request,
			...(op.targetSeats !== null ? { capacityFence: this.fence(op) } : {})
		};
		const proof = await this.billing.request<WincrmCommerceCommandProof>(
			route[op.commandType as CommerceCommandType],
			body,
			'proof',
			true,
			{ commandId: op.commandId, requestHash: op.requestHash! }
		);
		return operationView(await this.applyProof(op, proof));
	}
	async known(
		workspaceId: string,
		commandId: string
	): Promise<CrmBillingOperation> {
		const op = await this.prisma.crmBillingOperation.findFirst({
			where: { workspaceId, commandId }
		});
		if (!op)
			throw new NotFoundException('CRM billing operation not found');
		return op;
	}
	async synchronize(
		op: CrmBillingOperation
	): Promise<CrmBillingOperation> {
		if (op.state === 'NOT_STARTED' || op.releaseFence) return op;
		try {
			const proof = await this.billing.request<WincrmCommerceCommandProof>(
				'operations/get',
				{
					schemaVersion: 1,
					workspaceId: op.workspaceId,
					actorSubject: op.actorSubject,
					commandId: op.commandId,
					requestHash: op.requestHash!
				} as Parameters<BillingCommerceClient['request']>[1],
				'proof'
			);
			return await this.applyProof(op, proof);
		} finally {
			// DB time, per-operation CAS and rotation prevent starvation on outages.
			await this.prisma
				.$executeRaw`UPDATE crm_access.crm_billing_operations SET next_check_at = clock_timestamp() + interval '5 seconds', updated_at = clock_timestamp() WHERE command_id = ${op.commandId}::uuid AND next_check_at = ${op.nextCheckAt} AND release_fence = false`;
		}
	}
	async syncPending(workspaceId: string) {
		if (!this.billing.enabled) return;
		const capacity = await this.prisma.crmBillingCapacity.findUnique({
			where: { workspaceId }
		});
		if (!capacity?.pendingOperationId) return;
		try {
			await this.synchronize(
				await this.known(workspaceId, capacity.pendingOperationId)
			);
		} catch (error) {
			if (!(error instanceof NotFoundException)) throw error;
		}
	}
	async recover(
		workspaceId: string,
		commandId: string,
		actorSubject: string
	): Promise<CrmBillingOperationView> {
		const op = await serializable(this.prisma, async tx => {
			await this.lock(tx, workspaceId, commandId);
			const prior = await tx.crmBillingOperation.findUnique({
				where: { commandId }
			});
			if (prior) {
				if (prior.workspaceId !== workspaceId)
					throw new ConflictException(
						'CRM command identifier is already used'
					);
				return prior;
			}
			if (
				await tx.crmTeamCommandReceipt.findUnique({ where: { commandId } })
			)
				throw new ConflictException(
					'CRM command identifier is already used'
				);
			const commandType = 'WINCRM_NOT_STARTED';
			await tx.crmTeamCommandReceipt.create({
				data: {
					commandId,
					workspaceId,
					actorSubject,
					commandType,
					requestHash: '0'.repeat(64),
					result: {
						schemaVersion: 1,
						operationId: commandId,
						state: 'NOT_STARTED'
					}
				}
			});
			const tombstone = await tx.crmBillingOperation.create({
				data: {
					commandId,
					workspaceId,
					actorSubject,
					commandType,
					state: 'NOT_STARTED',
					releaseFence: true
				}
			});
			await this.audit(tx, tombstone, 'BILLING_OPERATION_NOT_STARTED');
			return tombstone;
		});
		if (op.state === 'NOT_STARTED' || op.releaseFence)
			return operationView(op);
		try {
			return operationView(await this.synchronize(op));
		} catch (error) {
			if (!(error instanceof NotFoundException)) throw error;
			if (op.targetSeats === null) {
				// Replaying an already frozen idempotent preference command is safe only
				// for its original current owner; never manufacture a new actor.
				if (actorSubject !== op.actorSubject)
					throw new ConflictException(
						'CRM billing command belongs to a different owner'
					);
				return this.execute(op);
			}
			const proof = await this.billing.request<WincrmCommerceCommandProof>(
				'operations/close',
				{
					schemaVersion: 1,
					workspaceId,
					actorSubject: op.actorSubject,
					commandId,
					requestHash: op.requestHash!,
					commandType: op.commandType,
					capacityFence: this.fence(op)
				} as Parameters<BillingCommerceClient['request']>[1],
				'proof',
				true
			);
			return operationView(await this.applyProof(op, proof));
		}
	}
	async applyProof(
		binding: CrmBillingOperation,
		proof: WincrmCommerceCommandProof
	): Promise<CrmBillingOperation> {
		if (
			proof.workspaceId !== binding.workspaceId ||
			proof.commandId !== binding.commandId ||
			proof.requestHash !== binding.requestHash
		)
			throw new ServiceUnavailableException(
				'CRM billing proof binding is invalid'
			);
		if (
			proof.period &&
			binding.targetSeats !== null &&
			proof.period.totalSeats !== binding.targetSeats
		)
			throw new ServiceUnavailableException(
				'CRM billing capacity proof is invalid'
			);
		if (
			binding.targetSeats !== null &&
			proof.status === 'COMMITTED' &&
			!proof.period
		)
			throw new ServiceUnavailableException(
				'CRM committed capacity proof is incomplete'
			);
		return serializable(this.prisma, async tx => {
			await this.lock(tx, binding.workspaceId, binding.commandId);
			const op = await tx.crmBillingOperation.findUniqueOrThrow({
				where: { commandId: binding.commandId }
			});
			if (op.releaseFence) return op;
			if (
				op.billingVersion !== null &&
				BigInt(proof.billingVersion) < BigInt(op.billingVersion)
			)
				return op;
			if (op.state !== 'PENDING' && proof.status !== op.state)
				throw new ServiceUnavailableException(
					'CRM billing operation status is inconsistent'
				);
			const updated = await tx.crmBillingOperation.update({
				where: { commandId: op.commandId },
				data: {
					state: proof.status,
					releaseFence: proof.releaseFence,
					billingVersion: proof.billingVersion,
					holdUntil: proof.holdUntil ? new Date(proof.holdUntil) : null,
					proof: json(proof)
				}
			});
			if (op.targetSeats !== null) {
				const capacity = await tx.crmBillingCapacity.findUniqueOrThrow({
					where: { workspaceId: op.workspaceId }
				});
				if (
					capacity.pendingOperationId !== op.commandId ||
					capacity.revision !== op.fenceRevision
				)
					throw new ServiceUnavailableException(
						'CRM capacity fence changed'
					);
				if (proof.status === 'COMMITTED' || proof.releaseFence)
					await tx.crmBillingCapacity.update({
						where: { workspaceId: op.workspaceId },
						data: {
							...(proof.status === 'COMMITTED'
								? { latestCommittedOperationId: op.commandId }
								: {}),
							...(proof.releaseFence
								? {
										pendingOperationId: null,
										pendingTargetSeats: null,
										...(proof.status === 'COMMITTED'
											? { admissionCeiling: op.targetSeats }
											: {})
									}
								: {})
						}
					});
				if (proof.releaseFence)
					await emitTeamEvent(
						tx,
						'admission',
						op.workspaceId,
						`billing:${op.commandId}`
					);
			}
			if (
				op.state !== updated.state ||
				op.releaseFence !== updated.releaseFence
			)
				await this.audit(tx, updated, 'BILLING_OPERATION_SYNCHRONIZED');
			return updated;
		});
	}
	async authorizeOperation(body: {
		workspaceId: string;
		actorSubject: string;
		commandId: string;
		requestHash: string;
		fenceRevision: number;
		targetSeats: number;
	}) {
		requireBilling(this.billing.enabled);
		await this.canonicalOwner(body.workspaceId, body.actorSubject);
		return serializable(this.prisma, async tx => {
			await this.lock(tx, body.workspaceId);
			const [op, capacity] = await Promise.all([
				tx.crmBillingOperation.findUnique({
					where: { commandId: body.commandId }
				}),
				tx.crmBillingCapacity.findUnique({
					where: { workspaceId: body.workspaceId }
				})
			]);
			const pending = capacity?.pendingOperationId === body.commandId;
			const latest =
				capacity?.latestCommittedOperationId === body.commandId;
			if (
				!op ||
				!capacity ||
				op.workspaceId !== body.workspaceId ||
				op.actorSubject !== body.actorSubject ||
				op.requestHash !== body.requestHash ||
				op.fenceRevision !== body.fenceRevision ||
				op.targetSeats !== body.targetSeats ||
				!['PENDING', 'COMMITTED'].includes(op.state) ||
				(!pending && !latest) ||
				(latest && op.state !== 'COMMITTED')
			)
				throw new ForbiddenException({
					message: 'CRM billing operation authority was revoked',
					code: 'OPERATION_AUTHORIZATION_REVOKED'
				});
			if (latest && capacity.pendingOperationId && !pending)
				throw new ServiceUnavailableException(
					'CRM billing capacity is being reconciled'
				);
			return {
				schemaVersion: 1 as const,
				workspaceId: body.workspaceId,
				actorSubject: body.actorSubject,
				commandId: body.commandId,
				requestHash: body.requestHash,
				capacityFence: this.fence(op),
				authorized: true as const
			};
		});
	}
	private audit(
		tx: Prisma.TransactionClient,
		op: CrmBillingOperation,
		action: string
	) {
		return auditTeam(
			tx,
			{
				workspaceId: op.workspaceId,
				subject: op.actorSubject,
				role: 'OWNER',
				state: 'BILLING',
				permissions: []
			},
			randomUUID(),
			action,
			op.commandId,
			null,
			{
				state: op.state,
				releaseFence: op.releaseFence,
				targetSeats: op.targetSeats,
				fenceRevision: op.fenceRevision
			}
		);
	}
}
