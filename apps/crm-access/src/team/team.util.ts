import { ConflictException, ForbiddenException } from '@nestjs/common';
import { Prisma, type CrmTeamDelivery } from '@prisma/crm-access-client';
import { createHash, randomUUID } from 'node:crypto';
import { CrmAccessPrismaService } from '../prisma/crm-access-prisma.service';

export const TEAM_EVENTS = {
	provision: 'crm.access.invitation-provision.v1',
	acceptance: 'identity.wincrm.invitation-accepted.v1',
	admission: 'crm.access.admission-wake.v1'
} as const;
export type TeamConsumer = keyof typeof TEAM_EVENTS;
export type TeamAuthority = {
	workspaceId: string;
	subject: string;
	role: string;
	state: string;
	permissions: string[];
};
export const canonical = (value: unknown): unknown => {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === 'object')
		return Object.fromEntries(
			Object.entries(value)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([key, item]) => [key, canonical(item)])
		);
	return value;
};
export const semanticHash = (value: unknown) =>
	createHash('sha256')
		.update(JSON.stringify(canonical(value)))
		.digest('hex');
export const json = (value: unknown): Prisma.InputJsonValue =>
	JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
export async function queueTeamDelivery(
	tx: Prisma.TransactionClient,
	receipt: CrmTeamDelivery,
	options: {
		deduplicationKey: string;
		exchange: string;
		routingKey: string;
		token?: string;
		availableAt?: Date;
	}
) {
	await tx.crmTeamOutbox.createMany({
		data: [
			{
				messageId: randomUUID(),
				deduplicationKey: options.deduplicationKey,
				exchange: options.exchange,
				eventType: String(
					(receipt.payload as Prisma.JsonObject).eventType
				),
				routingKey: options.routingKey,
				payload: json(receipt.payload),
				headers: {
					'x-original-event-id': receipt.eventId,
					'x-retry-attempt': receipt.retryAttempt,
					'x-manual-retry-cycle': receipt.manualRetryCycle,
					...(options.token ? { 'x-delivery-token': options.token } : {})
				},
				...(options.availableAt
					? { availableAt: options.availableAt }
					: {})
			}
		],
		skipDuplicates: true
	});
}
export async function serializable<T>(
	prisma: CrmAccessPrismaService,
	action: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
	for (let attempt = 0; ; attempt++)
		try {
			return await prisma.$transaction(action, {
				isolationLevel: Prisma.TransactionIsolationLevel.Serializable
			});
		} catch (error) {
			if (error instanceof Prisma.PrismaClientKnownRequestError) {
				// PostgreSQL can report a unique conflict instead of serialization failure
				// after waiting for a concurrent insert whose commit was outside this snapshot.
				if (attempt < 2 && ['P2034', 'P2002'].includes(error.code))
					continue;
				if (error.code === 'P2002')
					throw new ConflictException(
						'CRM team state conflicts with another command'
					);
			}
			throw error;
		}
}
export async function workspaceLock(
	tx: Prisma.TransactionClient,
	workspaceId: string
) {
	await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`wincrm-team:${workspaceId}`}, 0))`;
}
export async function emitTeamEvent(
	tx: Prisma.TransactionClient,
	consumer: 'provision' | 'admission',
	workspaceId: string,
	key: string,
	invitationId?: string
) {
	const eventId = randomUUID();
	const payload = {
		schemaVersion: 1,
		eventId,
		eventType: TEAM_EVENTS[consumer],
		workspaceId,
		...(invitationId ? { invitationId } : {}),
		occurredAt: new Date().toISOString()
	};
	return tx.crmTeamOutbox.create({
		data: {
			messageId: eventId,
			deduplicationKey: `${consumer}:${key}`,
			eventType: TEAM_EVENTS[consumer],
			routingKey: TEAM_EVENTS[consumer],
			payload
		}
	});
}
export async function command<T>(
	prisma: CrmAccessPrismaService,
	actor: TeamAuthority,
	commandId: string,
	commandType: string,
	body: unknown,
	action: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
	const requestHash = semanticHash({
		actor: actor.subject,
		workspaceId: actor.workspaceId,
		commandType,
		body
	});
	return serializable(prisma, async tx => {
		await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`wincrm-team-command:${commandId}`}, 0))`;
		await workspaceLock(tx, actor.workspaceId);
		if (actor.role !== 'OWNER') {
			const currentActor = await tx.crmWorkspaceMember.findUnique({
				where: {
					workspaceId_subject: {
						workspaceId: actor.workspaceId,
						subject: actor.subject
					}
				}
			});
			if (
				!currentActor ||
				currentActor.disabledAt ||
				currentActor.role !== actor.role
			)
				throw new ForbiddenException('CRM team authority has changed');
		}
		const prior = await tx.crmTeamCommandReceipt.findUnique({
			where: { commandId }
		});
		if (prior) {
			if (
				prior.workspaceId !== actor.workspaceId ||
				prior.actorSubject !== actor.subject ||
				prior.commandType !== commandType ||
				prior.requestHash !== requestHash
			)
				throw new ConflictException('Team command conflict');
			return prior.result as unknown as T;
		}
		const result = await action(tx);
		await tx.crmTeamCommandReceipt.create({
			data: {
				commandId,
				workspaceId: actor.workspaceId,
				actorSubject: actor.subject,
				commandType,
				requestHash,
				result: json(result)
			}
		});
		return result;
	});
}
export async function auditTeam(
	tx: Prisma.TransactionClient,
	actor: TeamAuthority,
	commandId: string,
	action: string,
	targetId: string,
	before: unknown,
	after: unknown
) {
	await tx.crmTeamAudit.create({
		data: {
			workspaceId: actor.workspaceId,
			actorSubject: actor.subject,
			commandId,
			action,
			targetId,
			before: before === null ? Prisma.JsonNull : json(before),
			after: after === null ? Prisma.JsonNull : json(after)
		}
	});
}
