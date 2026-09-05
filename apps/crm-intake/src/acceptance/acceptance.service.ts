import {
	BadRequestException,
	ConflictException,
	ForbiddenException,
	HttpException,
	Injectable,
	NotFoundException,
	ServiceUnavailableException
} from '@nestjs/common';
import { Prisma, type Acceptance } from '@prisma/crm-intake-client';
import { randomUUID } from 'node:crypto';
import {
	assertIntakePermission,
	type IntakeAuthorization
} from '../access/intake-authorization.client';
import {
	IntakeCommandDto,
	VersionedIntakeCommandDto
} from '../intake/intake.dto';
import { intakeEntryScope } from '../intake/intake.service';
import { CrmIntakePrismaService } from '../prisma/crm-intake-prisma.service';
import {
	acceptanceHash,
	AcceptInboxDto,
	type AcceptanceEvent,
	type OperationBinding
} from './acceptance.contract';

export function acceptanceBinding(
	row: Acceptance,
	step: 'customers' | 'sales'
): OperationBinding {
	return {
		schemaVersion: 1,
		workspaceId: row.workspaceId,
		workflowId: row.id,
		operationId:
			step === 'customers' ? row.contactOperationId : row.salesOperationId,
		actorSubject: row.actorSubject,
		payloadHash:
			step === 'customers' ? row.contactPayloadHash : row.salesPayloadHash
	};
}
export function acceptanceView(row: Acceptance) {
	return {
		id: row.id,
		workspaceId: row.workspaceId,
		entryId: row.entryId,
		actorSubject: row.actorSubject,
		status: row.status,
		version: row.version,
		mode: row.mode,
		contactId: row.contactId,
		dealId: row.dealId,
		firstTaskId: row.firstTaskId,
		lastErrorCode: row.lastErrorCode,
		retryAt: row.retryAt?.toISOString() ?? null,
		completedAt: row.completedAt?.toISOString() ?? null,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString()
	};
}
export async function enqueueAcceptance(
	tx: Prisma.TransactionClient,
	event: AcceptanceEvent,
	route: 'MAIN' | 'DLQ' = 'MAIN',
	deduplicationKey = `${event.workflowId}:${event.generation}:initial`,
	availableAt: Date | undefined = undefined,
	retryAttempt = 0
) {
	await tx.acceptanceOutbox.createMany({
		data: [
			{
				id: randomUUID(),
				eventId: event.eventId,
				deduplicationKey,
				route,
				payload: event as unknown as Prisma.InputJsonObject,
				availableAt,
				retryAttempt
			}
		],
		skipDuplicates: true
	});
}
export function acceptanceEvent(
	row: Pick<Acceptance, 'id' | 'workspaceId' | 'generation' | 'mode'>
): AcceptanceEvent {
	return {
		schemaVersion: 1,
		eventId: randomUUID(),
		workflowId: row.id,
		workspaceId: row.workspaceId,
		generation: row.generation,
		mode: row.mode as 'EXECUTE' | 'RECOVER'
	};
}

@Injectable()
export class AcceptanceService {
	constructor(private readonly prisma: CrmIntakePrismaService) {}
	async get(
		context: IntakeAuthorization,
		entryId: string,
		workspaceId: string
	) {
		this.assert(context, workspaceId, false);
		await this.entry(this.prisma, context, entryId);
		const row = await this.prisma.acceptance.findFirst({
			where: { workspaceId, entryId },
			orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]
		});
		return {
			schemaVersion: 1 as const,
			acceptance: row ? acceptanceView(row) : null
		};
	}
	async accept(
		context: IntakeAuthorization,
		entryId: string,
		dto: AcceptInboxDto
	) {
		this.assert(context, dto.workspaceId, true);
		if (
			(dto.contact.mode === 'CREATE_FROM_ENTRY' &&
				dto.contact.contactId !== undefined) ||
			(dto.contact.mode === 'EXISTING' && !dto.contact.contactId)
		)
			throw new BadRequestException('Explicit contact choice is required');
		if (
			!Number.isFinite(Date.parse(dto.deal.nextTask.dueAt)) ||
			new Date(dto.deal.nextTask.dueAt).toISOString() !==
				dto.deal.nextTask.dueAt
		)
			throw new BadRequestException('First task date is invalid');
		return this.command(
			context,
			entryId,
			dto,
			'ACCEPTANCE_REQUESTED',
			async tx => {
				const entry = await this.entry(tx, context, entryId);
				if (
					entry.status !== 'NEW' ||
					entry.version !== dto.expectedVersion
				)
					throw new ConflictException('Inbox entry changed');
				if (entry.teamId && !context.teamIds.includes(entry.teamId))
					throw new ForbiddenException('Entry team is not available');
				if (
					await tx.acceptance.findFirst({
						where: {
							workspaceId: context.workspaceId,
							entryId,
							status: { not: 'CANCELLED' }
						}
					})
				)
					throw new ConflictException('Acceptance already exists');
				const workflowId = randomUUID();
				const missingWidgetName =
					dto.contact.mode === 'CREATE_FROM_ENTRY' &&
					entry.origin === 'WIDGET' &&
					entry.name === null;
				if (
					missingWidgetName
						? typeof dto.contact.name !== 'string' ||
							!dto.contact.name.trim() ||
							dto.contact.name !== dto.contact.name.trim() ||
							dto.contact.name.length > 200 ||
							/[\x00-\x1f\x7f\ufffd\ud800-\udfff]/u.test(dto.contact.name)
						: dto.contact.name !== undefined
				)
					throw new BadRequestException(
						'Explicit valid contact name is required only for unnamed widget entries'
					);
				const contactOperationId = randomUUID();
				const contactPayload =
					dto.contact.mode === 'EXISTING'
						? { mode: 'EXISTING', contactId: dto.contact.contactId }
						: {
								mode: 'CREATE',
								name: missingWidgetName ? dto.contact.name! : entry.name!,
								phone: entry.phone,
								email: entry.email,
								teamId: entry.teamId
							};
				const contactPayloadHash = acceptanceHash(contactPayload);
				const salesPayload = {
					...dto.deal,
					title: dto.deal.title.trim(),
					nextTask: {
						title: dto.deal.nextTask.title.trim(),
						dueAt: dto.deal.nextTask.dueAt
					},
					teamId: entry.teamId,
					contactOperation: {
						operationId: contactOperationId,
						payloadHash: contactPayloadHash
					}
				};
				const row = await tx.acceptance.create({
					data: {
						id: workflowId,
						workspaceId: context.workspaceId,
						entryId,
						actorSubject: context.subject,
						contactOperationId,
						salesOperationId: randomUUID(),
						contactCommandId: randomUUID(),
						salesCommandId: randomUUID(),
						contactPayload: contactPayload as Prisma.InputJsonObject,
						salesPayload: salesPayload as Prisma.InputJsonObject,
						contactPayloadHash,
						salesPayloadHash: acceptanceHash(salesPayload)
					}
				});
				const changed = await tx.inboxEntry.updateMany({
					where: {
						id: entryId,
						workspaceId: context.workspaceId,
						status: 'NEW',
						version: dto.expectedVersion
					},
					data: { version: { increment: 1 } }
				});
				if (changed.count !== 1)
					throw new ConflictException('Inbox entry changed');
				await enqueueAcceptance(tx, acceptanceEvent(row));
				return row;
			}
		);
	}
	async retry(
		context: IntakeAuthorization,
		entryId: string,
		dto: VersionedIntakeCommandDto,
		recover = false
	) {
		this.assert(context, dto.workspaceId, true);
		if (recover && !['OWNER', 'CRM_ADMIN'].includes(context.role))
			throw new ForbiddenException(
				'Recovery requires a CRM administrator'
			);
		return this.command(
			context,
			entryId,
			dto,
			recover ? 'ACCEPTANCE_RECOVERY_REQUESTED' : 'ACCEPTANCE_RETRIED',
			async tx => {
				const entry = await this.entry(tx, context, entryId);
				const row = await tx.acceptance.findFirst({
					where: {
						workspaceId: context.workspaceId,
						entryId,
						status: { not: 'CANCELLED' }
					},
					orderBy: { createdAt: 'desc' }
				});
				if (
					!row ||
					entry.status !== 'NEW' ||
					row.version !== dto.expectedVersion ||
					row.status === 'COMPLETED'
				)
					throw new ConflictException('Acceptance changed');
				if (
					!recover &&
					!['BLOCKED', 'FAILED', 'RETRY_WAIT'].includes(row.status)
				)
					throw new ConflictException('Acceptance is already running');
				if (
					!recover &&
					row.actorSubject !== context.subject &&
					!['OWNER', 'CRM_ADMIN'].includes(context.role)
				)
					throw new ForbiddenException('Retry is not available');
				const changed = await tx.acceptance.updateMany({
					where: {
						id: row.id,
						version: row.version,
						generation: row.generation,
						status: row.status
					},
					data: {
						generation: { increment: 1 },
						version: { increment: 1 },
						status:
							recover || row.mode === 'RECOVER' ? 'RECOVERING' : 'QUEUED',
						mode: recover ? 'RECOVER' : row.mode,
						...(recover
							? {
									recoverySubject: context.subject,
									recoveryContactCommandId: randomUUID(),
									recoverySalesCommandId: randomUUID()
								}
							: {}),
						lastErrorCode: null,
						retryAt: null
					}
				});
				if (changed.count !== 1)
					throw new ConflictException('Acceptance changed');
				const updated = await tx.acceptance.findUniqueOrThrow({
					where: { id: row.id }
				});
				await enqueueAcceptance(tx, acceptanceEvent(updated));
				return updated;
			}
		);
	}
	private async command(
		context: IntakeAuthorization,
		entryId: string,
		dto: IntakeCommandDto,
		action: string,
		apply: (tx: Prisma.TransactionClient) => Promise<Acceptance>
	) {
		const hash = acceptanceHash({
			actor: context.subject,
			entryId,
			action,
			dto
		});
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				return await this.prisma.$transaction(
					async tx => {
						await tx.$executeRaw`SET LOCAL lock_timeout = '1000ms'`;
						await tx.$executeRaw`SET LOCAL statement_timeout = '3000ms'`;
						await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`crm-intake:command:${dto.commandId}`},0))`;
						await tx.$queryRaw`SELECT id FROM crm_intake.inbox_entries WHERE id=${entryId}::uuid AND workspace_id=${context.workspaceId}::uuid FOR UPDATE`;
						await this.entry(tx, context, entryId);
						const receipt = await tx.intakeCommand.findUnique({
							where: { commandId: dto.commandId }
						});
						if (receipt) {
							if (
								receipt.actorSubject !== context.subject ||
								receipt.workspaceId !== context.workspaceId ||
								receipt.entityId !== entryId ||
								receipt.requestHash !== hash
							)
								throw new ConflictException(
									'Command binding does not match'
								);
							return receipt.response;
						}
						const row = await apply(tx);
						const response = {
							schemaVersion: 1 as const,
							acceptance: acceptanceView(row)
						};
						await tx.intakeActivity.create({
							data: {
								workspaceId: context.workspaceId,
								entityId: entryId,
								entityKind: 'entry',
								commandId: dto.commandId,
								actorSubject: context.subject,
								action,
								entityVersion: row.version
							}
						});
						await tx.intakeCommand.create({
							data: {
								commandId: dto.commandId,
								workspaceId: context.workspaceId,
								entityId: entryId,
								entityKind: 'entry',
								actorSubject: context.subject,
								requestHash: hash,
								response
							}
						});
						return response;
					},
					{ isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
				);
			} catch (error) {
				if (
					error instanceof Prisma.PrismaClientKnownRequestError &&
					(['P2034', 'P2002'].includes(error.code) ||
						['55P03', '57014'].includes(String(error.meta?.code))) &&
					attempt < 2
				)
					continue;
				if (error instanceof HttpException) throw error;
				throw new ServiceUnavailableException(
					'Acceptance is temporarily unavailable; retry the same command'
				);
			}
		}
		throw new ServiceUnavailableException('Retry the same command');
	}
	private assert(
		context: IntakeAuthorization,
		workspaceId: string,
		write: boolean
	) {
		if (context.workspaceId !== workspaceId)
			throw new ForbiddenException();
		assertIntakePermission(
			context,
			write ? 'intake:write' : 'intake:read',
			write
		);
	}
	private async entry(
		tx: Pick<Prisma.TransactionClient, 'inboxEntry'>,
		context: IntakeAuthorization,
		id: string
	) {
		const entry = await tx.inboxEntry.findFirst({
			where: { AND: [intakeEntryScope(context), { id }] }
		});
		if (!entry)
			throw new NotFoundException('Inbox entry is not available');
		return entry;
	}
}
