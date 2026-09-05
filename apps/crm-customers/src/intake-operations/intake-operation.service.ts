import {
	BadRequestException,
	ConflictException,
	ForbiddenException,
	HttpException,
	Injectable,
	NotFoundException,
	ServiceUnavailableException
} from '@nestjs/common';
import {
	Prisma,
	type IntakeOperationSlot
} from '@prisma/crm-customers-client';
import { CrmCustomersPrismaService } from '../prisma/crm-customers-prisma.service';
import { CustomersAuthorizationClient } from '../access/customers-authorization.client';
import { customerScope } from '../customers/customers.service';
import {
	CloseContactOperationDto,
	ExecuteContactOperationDto,
	IntakeOperationBinding,
	operationHash
} from './intake-operation.dto';

export function contactOperationProof(
	binding: IntakeOperationBinding,
	slot: IntakeOperationSlot | null
) {
	if (
		slot &&
		['workspaceId', 'workflowId', 'actorSubject', 'payloadHash'].some(
			key =>
				slot[key as keyof IntakeOperationSlot] !==
				binding[key as keyof IntakeOperationBinding]
		)
	)
		throw new ConflictException('Operation binding does not match');
	return {
		schemaVersion: 1 as const,
		workspaceId: binding.workspaceId,
		workflowId: binding.workflowId,
		operationId: binding.operationId,
		actorSubject: binding.actorSubject,
		payloadHash: binding.payloadHash,
		state: slot?.state ?? 'ABSENT',
		result: slot?.result ?? null,
		committedAt: slot?.committedAt?.toISOString() ?? null
	};
}

@Injectable()
export class ContactIntakeOperationService {
	constructor(
		private readonly prisma: CrmCustomersPrismaService,
		private readonly authorization: CustomersAuthorizationClient
	) {}

	async read(binding: IntakeOperationBinding) {
		try {
			return contactOperationProof(
				binding,
				await this.prisma.intakeOperationSlot.findUnique({
					where: { operationId: binding.operationId }
				})
			);
		} catch (error) {
			this.safe(error);
		}
	}

	async verify(binding: IntakeOperationBinding) {
		const access = await this.authorization.authorizeWorkflow(
			binding.workspaceId,
			binding.actorSubject
		);
		try {
			const slot = await this.prisma.intakeOperationSlot.findUnique({
				where: { operationId: binding.operationId }
			});
			const proof = contactOperationProof(binding, slot);
			if (
				!slot ||
				slot.state !== 'COMMITTED' ||
				!slot.contactId ||
				!(await this.prisma.contact.findFirst({
					where: { AND: [customerScope(access), { id: slot.contactId }] }
				}))
			)
				throw new NotFoundException('Contact operation is not available');
			return proof;
		} catch (error) {
			this.safe(error);
		}
	}

	async execute(dto: ExecuteContactOperationDto) {
		if (operationHash(dto.payload) !== dto.payloadHash)
			throw new BadRequestException(
				'Operation payload hash does not match'
			);
		const payload = dto.payload;
		if (
			payload.mode === 'CREATE'
				? !payload.name?.trim() || payload.contactId !== undefined
				: !payload.contactId ||
					Object.keys(payload).some(
						key => !['mode', 'contactId'].includes(key)
					)
		)
			throw new BadRequestException('Invalid contact operation payload');
		const access = await this.authorization.authorizeWorkflow(
			dto.workspaceId,
			dto.actorSubject
		);
		if (payload.teamId && !access.teamIds.includes(payload.teamId))
			throw new ForbiddenException('Team is not available');
		return this.command(dto, dto.actorSubject, 'EXECUTE', async tx => {
			const slot = await tx.intakeOperationSlot.findUnique({
				where: { operationId: dto.operationId }
			});
			if (slot) return contactOperationProof(dto, slot);
			const contact =
				payload.mode === 'EXISTING'
					? await tx.contact.findFirst({
							where: {
								AND: [customerScope(access), { id: payload.contactId }]
							}
						})
					: await tx.contact.create({
							data: {
								workspaceId: dto.workspaceId,
								createdBySubject: dto.actorSubject,
								name: payload.name!.trim(),
								phone: payload.phone ?? null,
								email: payload.email?.toLowerCase() ?? null,
								teamId: payload.teamId ?? null
							}
						});
			if (!contact)
				throw new NotFoundException('Contact is not available');
			if (payload.mode === 'CREATE')
				await tx.customerActivity.create({
					data: {
						workspaceId: dto.workspaceId,
						entityId: contact.id,
						entityKind: 'contact',
						commandId: dto.commandId,
						actorSubject: dto.actorSubject,
						action: 'CREATED',
						entityVersion: contact.version,
						changedFields: ['name', 'phone', 'email', 'teamId']
					}
				});
			const committed = await tx.intakeOperationSlot.create({
				data: {
					operationId: dto.operationId,
					workspaceId: dto.workspaceId,
					workflowId: dto.workflowId,
					actorSubject: dto.actorSubject,
					payloadHash: dto.payloadHash,
					state: 'COMMITTED',
					contactId: contact.id,
					result: {
						contactId: contact.id,
						contactName: contact.name,
						contactVersion: contact.version
					},
					committedAt: new Date()
				}
			});
			return contactOperationProof(dto, committed);
		});
	}

	async close(dto: CloseContactOperationDto) {
		const access = await this.authorization.authorizeWorkflow(
			dto.workspaceId,
			dto.recoverySubject
		);
		if (!['OWNER', 'CRM_ADMIN'].includes(access.role))
			throw new ForbiddenException(
				'Recovery requires a CRM administrator'
			);
		return this.command(dto, dto.recoverySubject, 'CLOSE', async tx => {
			const current = await tx.intakeOperationSlot.findUnique({
				where: { operationId: dto.operationId }
			});
			return contactOperationProof(
				dto,
				current ??
					(await tx.intakeOperationSlot.create({
						data: {
							operationId: dto.operationId,
							workspaceId: dto.workspaceId,
							workflowId: dto.workflowId,
							actorSubject: dto.actorSubject,
							payloadHash: dto.payloadHash,
							state: 'CANCELLED',
							result: Prisma.DbNull
						}
					}))
			);
		});
	}

	private async command(
		dto: IntakeOperationBinding & { commandId: string },
		actor: string,
		action: string,
		apply: (
			tx: Prisma.TransactionClient
		) => Promise<ReturnType<typeof contactOperationProof>>
	) {
		const requestHash = operationHash({ action, actor, dto });
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				return await this.prisma.$transaction(
					async tx => {
						await tx.$executeRaw`SET LOCAL lock_timeout = '1000ms'`;
						await tx.$executeRaw`SET LOCAL statement_timeout = '3000ms'`;
						await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`crm-customers:intake-command:${dto.commandId}`}, 0))`;
						await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`crm-customers:intake-operation:${dto.operationId}`}, 0))`;
						const prior = await tx.intakeOperationCommand.findUnique({
							where: { commandId: dto.commandId }
						});
						if (prior) {
							if (
								prior.actorSubject !== actor ||
								prior.workspaceId !== dto.workspaceId ||
								prior.requestHash !== requestHash
							)
								throw new ConflictException(
									'Command binding does not match'
								);
							return prior.result;
						}
						const result = await apply(tx);
						await tx.intakeOperationCommand.create({
							data: {
								commandId: dto.commandId,
								workspaceId: dto.workspaceId,
								actorSubject: actor,
								requestHash,
								result: result as Prisma.InputJsonObject
							}
						});
						return result;
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
				this.safe(error);
			}
		}
		throw new ServiceUnavailableException('Retry the same operation');
	}
	private safe(error: unknown): never {
		if (error instanceof HttpException) throw error;
		throw new ServiceUnavailableException(
			'Contact operation is temporarily unavailable'
		);
	}
}
