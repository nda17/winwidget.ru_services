import {
	BadRequestException,
	ConflictException,
	ForbiddenException,
	Injectable,
	ServiceUnavailableException
} from '@nestjs/common';
import {
	Prisma,
	type IntakeOperationSlot
} from '@prisma/crm-sales-client';
import { randomUUID } from 'node:crypto';
import { CrmSalesPrismaService } from '../prisma/crm-sales-prisma.service';
import { IntakeOperationClient } from './intake-operation.client';
import {
	operationBinding,
	operationHash,
	type CloseIntakeOperation,
	type ExecuteIntakeOperation,
	type IntakeOperationBinding,
	type IntakeOperationProof
} from './intake-operation.dto';

type SlotReader = Pick<Prisma.TransactionClient, 'intakeOperationSlot'>;
class OperationBusy extends Error {}

@Injectable()
export class IntakeOperationService {
	constructor(
		private readonly prisma: CrmSalesPrismaService,
		private readonly client: IntakeOperationClient
	) {}

	async read(
		binding: IntakeOperationBinding
	): Promise<IntakeOperationProof> {
		return this.proof(binding, await this.slot(this.prisma, binding));
	}

	async execute(
		dto: ExecuteIntakeOperation
	): Promise<IntakeOperationProof> {
		const binding = operationBinding(dto);
		if (
			operationHash(dto.payload) !== binding.payloadHash ||
			!Number.isFinite(Date.parse(dto.payload.nextTask.dueAt)) ||
			new Date(dto.payload.nextTask.dueAt).toISOString() !==
				dto.payload.nextTask.dueAt
		)
			throw new BadRequestException('Invalid workflow payload');
		const access = await this.client.authorize(binding);
		if (dto.payload.teamId && !access.teamIds.includes(dto.payload.teamId))
			throw new ForbiddenException('Unavailable team');
		// Reads are allowed to recover old committed effects. Executing a command,
		// even a replay, always authorizes the original actor before reaching here.
		const prior = await this.slot(this.prisma, binding);
		const contact = prior
			? null
			: await this.client.verifyContact({
					...binding,
					operationId: dto.payload.contactOperation.operationId,
					payloadHash: dto.payload.contactOperation.payloadHash
				});
		// No HTTP occurs inside a PostgreSQL transaction. A cancelled slot is
		// rechecked under the same business-operation lock as close().
		return this.command(
			dto,
			dto.actorSubject,
			'EXECUTE',
			async transaction => {
				const existing = await this.slot(transaction, binding);
				if (existing) return this.proof(binding, existing);
				if (!contact)
					throw new ServiceUnavailableException(
						'CRM contact proof is unavailable'
					);
				const payload = dto.payload;
				const stage = await transaction.pipelineStage.findFirst({
					where: {
						id: payload.stageId,
						pipelineId: payload.pipelineId,
						workspaceId: binding.workspaceId
					}
				});
				if (!stage || stage.state !== 'OPEN')
					throw new ConflictException('Initial stage is unavailable');
				const dealId = randomUUID();
				const firstTaskId = randomUUID();
				await transaction.deal.create({
					data: {
						id: dealId,
						workspaceId: binding.workspaceId,
						title: payload.title.trim(),
						currency: 'RUB',
						amountMinor: payload.amountMinor,
						pipelineId: payload.pipelineId,
						stageId: payload.stageId,
						contactId: contact.contactId,
						contactName: contact.contactName,
						assignedToSubject: binding.actorSubject,
						teamId: payload.teamId,
						nextTaskId: firstTaskId
					}
				});
				await transaction.salesTask.create({
					data: {
						id: firstTaskId,
						workspaceId: binding.workspaceId,
						dealId,
						title: payload.nextTask.title.trim(),
						dueAt: new Date(payload.nextTask.dueAt),
						assignedToSubject: binding.actorSubject
					}
				});
				await transaction.dealTimeline.create({
					data: {
						workspaceId: binding.workspaceId,
						dealId,
						kind: 'CREATED',
						actorSubject: binding.actorSubject,
						outcome: 'Создана сделка из входящего обращения',
						fromStageId: null,
						toStageId: payload.stageId
					}
				});
				const committed = await transaction.intakeOperationSlot.create({
					data: {
						operationId: binding.operationId,
						workspaceId: binding.workspaceId,
						workflowId: binding.workflowId,
						actorSubject: binding.actorSubject,
						payloadHash: binding.payloadHash,
						state: 'COMMITTED',
						contactId: contact.contactId,
						dealId,
						firstTaskId,
						committedAt: new Date()
					}
				});
				await transaction.$executeRaw(Prisma.sql`SET CONSTRAINTS
				crm_sales.deals_next_task_fkey,
				crm_sales.deals_next_action_integrity,
				crm_sales.tasks_next_action_integrity IMMEDIATE`);
				return this.proof(binding, committed);
			}
		);
	}

	async close(dto: CloseIntakeOperation): Promise<IntakeOperationProof> {
		const binding = operationBinding(dto);
		const recoveryAccess = await this.client.authorize(
			binding,
			dto.recoverySubject
		);
		if (!['OWNER', 'CRM_ADMIN'].includes(recoveryAccess.role))
			throw new ForbiddenException();
		return this.command(
			dto,
			dto.recoverySubject,
			'CLOSE',
			async transaction => {
				const existing = await this.slot(transaction, binding);
				if (existing) return this.proof(binding, existing);
				const cancelled = await transaction.intakeOperationSlot.create({
					data: {
						operationId: binding.operationId,
						workspaceId: binding.workspaceId,
						workflowId: binding.workflowId,
						actorSubject: binding.actorSubject,
						payloadHash: binding.payloadHash,
						state: 'CANCELLED'
					}
				});
				return this.proof(binding, cancelled);
			}
		);
	}

	private async slot(
		reader: SlotReader,
		binding: IntakeOperationBinding
	): Promise<IntakeOperationSlot | null> {
		const rows = await reader.intakeOperationSlot.findMany({
			where: {
				OR: [
					{ operationId: binding.operationId },
					{
						workspaceId: binding.workspaceId,
						workflowId: binding.workflowId
					}
				]
			},
			take: 2
		});
		if (rows.length > 1) this.conflict();
		const row = rows[0] || null;
		if (
			row &&
			(row.operationId !== binding.operationId ||
				row.workspaceId !== binding.workspaceId ||
				row.workflowId !== binding.workflowId ||
				row.actorSubject !== binding.actorSubject ||
				row.payloadHash !== binding.payloadHash)
		)
			this.conflict();
		return row;
	}
	private proof(
		binding: IntakeOperationBinding,
		slot: IntakeOperationSlot | null
	): IntakeOperationProof {
		if (!slot)
			return {
				...operationBinding(binding),
				state: 'ABSENT',
				result: null,
				committedAt: null
			};
		if (slot.state === 'CANCELLED')
			return {
				...operationBinding(binding),
				state: 'CANCELLED',
				result: null,
				committedAt: null
			};
		if (
			slot.state !== 'COMMITTED' ||
			!slot.contactId ||
			!slot.dealId ||
			!slot.firstTaskId ||
			!slot.committedAt
		)
			throw new ServiceUnavailableException(
				'CRM operation proof is unavailable'
			);
		return {
			...operationBinding(binding),
			state: 'COMMITTED',
			result: {
				contactId: slot.contactId,
				dealId: slot.dealId,
				firstTaskId: slot.firstTaskId
			},
			committedAt: slot.committedAt.toISOString()
		};
	}
	private async command(
		dto: ExecuteIntakeOperation | CloseIntakeOperation,
		actorSubject: string,
		kind: 'EXECUTE' | 'CLOSE',
		action: (
			transaction: Prisma.TransactionClient
		) => Promise<IntakeOperationProof>
	): Promise<IntakeOperationProof> {
		const requestHash = operationHash({ kind, dto });
		for (let attempt = 0; attempt < 16; attempt += 1) {
			try {
				return await this.prisma.$transaction(
					async transaction => {
						await transaction.$executeRaw(
							Prisma.sql`SET LOCAL lock_timeout = '2000ms'`
						);
						await transaction.$executeRaw(
							Prisma.sql`SET LOCAL statement_timeout = '5000ms'`
						);
						// Do not occupy all interactive-transaction connections waiting
						// for one owner: losers release immediately and retry in a new tx.
						for (const key of [
							`crm-sales-intake-command:${dto.commandId}`,
							`crm-sales-intake-operation:${dto.workspaceId}:${dto.workflowId}`
						]) {
							const [claim] = await transaction.$queryRaw<
								Array<{ locked: boolean }>
							>(
								Prisma.sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${key}, 0)) AS locked`
							);
							if (!claim?.locked) throw new OperationBusy();
						}
						const prior =
							await transaction.intakeOperationCommand.findUnique({
								where: { commandId: dto.commandId }
							});
						if (
							prior &&
							(prior.workspaceId !== dto.workspaceId ||
								prior.actorSubject !== actorSubject ||
								prior.requestHash !== requestHash)
						)
							this.conflict();
						if (prior) {
							// Reconstruct from typed immutable proof; do not blindly return JSON.
							const slot = await this.slot(transaction, dto);
							if (!slot)
								throw new ServiceUnavailableException(
									'CRM operation proof is unavailable'
								);
							return this.proof(dto, slot);
						}
						const result = await action(transaction);
						await transaction.intakeOperationCommand.create({
							data: {
								commandId: dto.commandId,
								workspaceId: dto.workspaceId,
								actorSubject,
								requestHash,
								result: result as unknown as Prisma.InputJsonValue
							}
						});
						return result;
					},
					{
						isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
						maxWait: 5000,
						timeout: 10000
					}
				);
			} catch (error) {
				const code =
					error && typeof error === 'object' && 'code' in error
						? error.code
						: null;
				if (
					!(error instanceof OperationBusy) &&
					code !== 'P2034' &&
					code !== 'P2002'
				)
					throw error;
				if (attempt === 15) {
					if (code === 'P2002') this.conflict();
					throw new ServiceUnavailableException(
						'CRM workflow is temporarily busy'
					);
				}
				await new Promise(resolve =>
					setTimeout(resolve, 10 + Math.min(attempt * 10, 90))
				);
			}
		}
		throw new ServiceUnavailableException(
			'CRM workflow is temporarily unavailable'
		);
	}
	private conflict(): never {
		throw new ConflictException({
			code: 'crm_sales_intake_operation_conflict',
			message: 'Workflow operation binding conflicts'
		});
	}
}
