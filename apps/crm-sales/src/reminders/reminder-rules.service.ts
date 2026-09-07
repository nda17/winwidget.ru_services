import {
	BadRequestException,
	ConflictException,
	ForbiddenException,
	Injectable,
	NotFoundException,
	Optional,
	ServiceUnavailableException
} from '@nestjs/common';
import {
	Prisma,
	type ReminderRule as StoredRule
} from '@prisma/crm-sales-client';
import { createHash } from 'node:crypto';
import { CrmSalesPrismaService } from '../prisma/crm-sales-prisma.service';
import {
	SalesAccessClient,
	type SalesAccess
} from '../sales/sales-access';
import { ReminderActorClient } from './reminder-actor.client';
import { ReminderReadinessService } from './reminder-readiness.service';
import {
	parseReminderRule,
	type ReminderBinding,
	type ReminderRuleV1
} from './reminder-rule';
import type {
	ArchiveReminderRuleDto,
	CreateReminderRuleDto,
	EditReminderRuleDto,
	ReminderActorQuery,
	ReminderPageQuery,
	ReminderRulesQuery
} from './reminder-rules.dto';

// Bound configuration fan-out before the future scheduler is installed. These
// are non-archived rules, not task quotas; archived evidence remains readable.
export const REMINDER_RULE_LIMITS = Object.freeze({
	WORKSPACE: 20,
	PERSONAL: 10
});
type Command =
	| CreateReminderRuleDto
	| EditReminderRuleDto
	| ArchiveReminderRuleDto;
type Action = 'CREATED' | 'EDITED' | 'ARCHIVED';
const canonical = (value: unknown): string =>
	JSON.stringify(value, (_key, entry) =>
		entry && typeof entry === 'object' && !Array.isArray(entry)
			? Object.fromEntries(
					Object.entries(entry).sort(([a], [b]) =>
						a < b ? -1 : a > b ? 1 : 0
					)
				)
			: entry
	);
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const fingerprint = (access: SalesAccess) =>
	canonical({
		...access,
		teamIds: [...access.teamIds].sort(),
		permissions: [...access.permissions].sort()
	});
function permission(access: SalesAccess, write: boolean) {
	if (
		access.role === 'ANALYST' ||
		!access.permissions.includes('sales:read') ||
		(write &&
			(!access.permissions.includes('sales:write') ||
				!['ACTIVE', 'GRACE'].includes(access.state)))
	)
		throw new ForbiddenException('CRM task reminders are not permitted');
}
function conflict(code = 'crm_reminder_rule_version_conflict'): never {
	throw new ConflictException({
		code,
		message: 'Правило изменилось. Обновите данные'
	});
}
function missing(): never {
	throw new NotFoundException({
		code: 'crm_reminder_rule_not_found',
		message: 'Правило недоступно'
	});
}
function parsed(value: unknown, create = false) {
	try {
		return parseReminderRule(value, { create });
	} catch {
		throw new BadRequestException({
			code: 'crm_reminder_rule_invalid',
			message: 'Проверьте настройки напоминания'
		});
	}
}
function item(row: StoredRule) {
	let rule: ReminderRuleV1;
	try {
		rule = parseReminderRule(row.configuration);
		if (
			rule.id.toLowerCase() !== row.id.toLowerCase() ||
			rule.scope !== row.scope ||
			rule.ownerBinding.subject !== row.ownerSubject ||
			rule.ownerBinding.membershipId !== row.ownerMembershipId
		)
			throw new Error();
	} catch {
		throw new ServiceUnavailableException(
			'CRM reminder rule storage is unavailable'
		);
	}
	return {
		workspaceId: row.workspaceId,
		rule,
		version: row.version,
		archivedAt: row.archivedAt?.toISOString() ?? null,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString()
	};
}
function visibility(
	access: SalesAccess,
	binding: ReminderBinding
): Prisma.ReminderRuleWhereInput {
	return {
		workspaceId: access.workspaceId,
		OR: [
			{ scope: 'WORKSPACE' },
			{
				scope: 'PERSONAL',
				ownerSubject: binding.subject,
				ownerMembershipId: binding.membershipId
			}
		]
	};
}
function scopePermission(
	access: SalesAccess,
	rule: Pick<ReminderRuleV1, 'scope' | 'ownerBinding'>,
	binding: ReminderBinding
) {
	if (
		rule.scope === 'WORKSPACE'
			? !['OWNER', 'CRM_ADMIN'].includes(access.role)
			: !same(rule.ownerBinding, binding)
	)
		throw new ForbiddenException(
			'CRM reminder rule changes are not permitted'
		);
}

@Injectable()
export class ReminderRulesService {
	constructor(
		private readonly prisma: CrmSalesPrismaService,
		private readonly accessClient: SalesAccessClient,
		private readonly actors: ReminderActorClient,
		@Optional() private readonly readiness?: ReminderReadinessService
	) {}
	private async ready() {
		return (await this.readiness?.ready()) ?? false;
	}

	private async authority(
		initial: SalesAccess,
		workspaceId: string,
		membershipId: string | null,
		token: string,
		write: boolean
	) {
		permission(initial, write);
		if (initial.workspaceId !== workspaceId)
			throw new ForbiddenException();
		const current = await this.accessClient.authorize(token, workspaceId);
		permission(current, write);
		if (fingerprint(current) !== fingerprint(initial))
			throw new ForbiddenException('CRM reminder authority changed');
		const binding = await this.actors.verify(token, current, membershipId);
		if (
			binding.subject !== initial.subject ||
			binding.membershipId !== membershipId
		)
			throw new ForbiddenException();
		const fresh = await this.accessClient.authorize(token, workspaceId);
		permission(fresh, write);
		if (fingerprint(fresh) !== fingerprint(current))
			throw new ForbiddenException('CRM reminder authority changed');
		return { access: fresh, binding };
	}
	private async visible(
		tx: Pick<Prisma.TransactionClient, 'reminderRule'>,
		access: SalesAccess,
		binding: ReminderBinding,
		id: string
	) {
		const row = await tx.reminderRule.findFirst({
			where: { AND: [visibility(access, binding), { id }] }
		});
		if (!row) missing();
		return row;
	}

	async list(
		initial: SalesAccess,
		query: ReminderRulesQuery,
		token: string
	) {
		const { access, binding } = await this.authority(
			initial,
			query.workspaceId,
			query.actorMembershipId ?? null,
			token,
			false
		);
		const where: Prisma.ReminderRuleWhereInput = {
			AND: [
				visibility(access, binding),
				{
					scope: query.scope,
					archivedAt: query.archived === 'true' ? { not: null } : null
				}
			]
		};
		const deliveryReady = await this.ready();
		const result = await this.prisma.$transaction(
			async tx => {
				const total = await tx.reminderRule.count({ where });
				const rows = await tx.reminderRule.findMany({
					where,
					orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
					skip: (query.page - 1) * query.pageSize,
					take: query.pageSize
				});
				return {
					schemaVersion: 1 as const,
					workspaceId: access.workspaceId,
					page: query.page,
					pageSize: query.pageSize,
					total,
					items: rows.map(item),
					limits: REMINDER_RULE_LIMITS,
					deliveryReady
				};
			},
			{ isolationLevel: 'RepeatableRead' }
		);
		await this.authority(
			access,
			query.workspaceId,
			binding.membershipId,
			token,
			false
		);
		return result;
	}
	async detail(
		initial: SalesAccess,
		id: string,
		query: ReminderActorQuery,
		token: string
	) {
		const { access, binding } = await this.authority(
			initial,
			query.workspaceId,
			query.actorMembershipId ?? null,
			token,
			false
		);
		const row = await this.visible(this.prisma, access, binding, id);
		const deliveryReady = await this.ready();
		await this.authority(
			access,
			query.workspaceId,
			binding.membershipId,
			token,
			false
		);
		return {
			schemaVersion: 1 as const,
			item: item(row),
			deliveryReady
		};
	}
	async history(
		initial: SalesAccess,
		id: string,
		query: ReminderPageQuery,
		token: string
	) {
		const { access, binding } = await this.authority(
			initial,
			query.workspaceId,
			query.actorMembershipId ?? null,
			token,
			false
		);
		const result = await this.prisma.$transaction(
			async tx => {
				await this.visible(tx, access, binding, id);
				const where = { workspaceId: access.workspaceId, ruleId: id };
				const total = await tx.reminderRuleCommand.count({ where });
				const rows = await tx.reminderRuleCommand.findMany({
					where,
					orderBy: [{ createdAt: 'desc' }, { commandId: 'desc' }],
					skip: (query.page - 1) * query.pageSize,
					take: query.pageSize
				});
				return {
					schemaVersion: 1 as const,
					workspaceId: access.workspaceId,
					ruleId: id,
					page: query.page,
					pageSize: query.pageSize,
					total,
					items: rows.map(row => ({
						commandId: row.commandId,
						actorSubject: row.actorSubject,
						actorMembershipId: row.actorMembershipId,
						action: row.commandType,
						before: row.before,
						result: row.result,
						createdAt: row.createdAt.toISOString()
					}))
				};
			},
			{ isolationLevel: 'RepeatableRead' }
		);
		await this.authority(
			access,
			query.workspaceId,
			binding.membershipId,
			token,
			false
		);
		return result;
	}
	create(initial: SalesAccess, dto: CreateReminderRuleDto, token: string) {
		return this.command(initial, dto, 'CREATED', null, token);
	}
	edit(
		initial: SalesAccess,
		id: string,
		dto: EditReminderRuleDto,
		token: string
	) {
		return this.command(initial, dto, 'EDITED', id, token);
	}
	archive(
		initial: SalesAccess,
		id: string,
		dto: ArchiveReminderRuleDto,
		token: string
	) {
		return this.command(initial, dto, 'ARCHIVED', id, token);
	}

	private async command(
		initial: SalesAccess,
		dto: Command,
		action: Action,
		id: string | null,
		token: string
	) {
		permission(initial, true);
		const rule =
			'rule' in dto ? parsed(dto.rule, action === 'CREATED') : null;
		const deliveryReady = await this.ready();
		if (id && rule && id.toLowerCase() !== rule.id.toLowerCase())
			throw new BadRequestException(
				'Rule identifier must match the route'
			);
		const commandHash = createHash('sha256')
			.update(
				canonical({
					action,
					id,
					dto: { ...dto, ...('rule' in dto ? { rule } : {}) },
					subject: initial.subject
				})
			)
			.digest('hex');
		for (let attempt = 0; attempt < 3; attempt++) {
			const { access, binding } = await this.authority(
				initial,
				dto.workspaceId,
				dto.actorMembershipId,
				token,
				true
			);
			if (action === 'CREATED') {
				if (!rule || !same(rule.ownerBinding, binding))
					throw new ForbiddenException(
						'Rule owner must be the current employee'
					);
				scopePermission(access, rule, binding);
			}
			try {
				return await this.prisma.$transaction(
					async tx => {
						await tx.$executeRaw(
							Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`crm-reminder-command:${dto.commandId}`},0))`
						);
						await tx.$executeRaw(
							Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`crm-reminder-rules:${access.workspaceId}`},0))`
						);
						const receipt = await tx.reminderRuleCommand.findUnique({
							where: { commandId: dto.commandId }
						});
						if (receipt) {
							if (
								receipt.workspaceId !== access.workspaceId ||
								receipt.actorSubject !== binding.subject ||
								receipt.actorMembershipId !== binding.membershipId ||
								receipt.requestHash !== commandHash ||
								receipt.commandType !== action
							)
								conflict('crm_reminder_command_conflict');
							const current = await this.visible(
								tx,
								access,
								binding,
								receipt.ruleId
							);
							scopePermission(access, item(current).rule, binding);
							await this.authority(
								access,
								access.workspaceId,
								binding.membershipId,
								token,
								true
							);
							return receipt.result;
						}
						if (rule?.enabled && !deliveryReady)
							throw new ServiceUnavailableException({
								code: 'crm_reminders_not_ready',
								message:
									'Отправка напоминаний сейчас недоступна. Сохраните правило выключенным'
							});
						const before = id
							? await this.visible(tx, access, binding, id)
							: null;
						if (before) {
							const current = item(before);
							scopePermission(access, current.rule, binding);
							if (
								before.archivedAt ||
								!('expectedVersion' in dto) ||
								before.version !== dto.expectedVersion ||
								before.version >= 2147483647
							)
								conflict();
							if (
								rule &&
								(rule.scope !== before.scope ||
									!same(rule.ownerBinding, current.rule.ownerBinding))
							)
								throw new BadRequestException(
									'Rule ownership and scope cannot change'
								);
						}
						let stored: StoredRule;
						if (action === 'CREATED' && rule) {
							const quota: Prisma.ReminderRuleWhereInput = {
								workspaceId: access.workspaceId,
								scope: rule.scope,
								archivedAt: null,
								...(rule.scope === 'PERSONAL'
									? {
											ownerSubject: binding.subject,
											ownerMembershipId: binding.membershipId
										}
									: {})
							};
							if (
								(await tx.reminderRule.count({ where: quota })) >=
								REMINDER_RULE_LIMITS[rule.scope]
							)
								throw new ConflictException({
									code: 'crm_reminder_rule_limit',
									message:
										'Достигнут лимит правил. Архивируйте ненужное правило'
								});
							if (
								await tx.reminderRule.findUnique({
									where: { id: rule.id }
								})
							)
								conflict('crm_reminder_rule_identifier_conflict');
							stored = await tx.reminderRule.create({
								data: {
									id: rule.id,
									workspaceId: access.workspaceId,
									scope: rule.scope,
									ownerSubject: binding.subject,
									ownerMembershipId: binding.membershipId,
									configuration: rule as unknown as Prisma.InputJsonValue
								}
							});
						} else {
							if (!before) missing();
							const updated = await tx.reminderRule.updateMany({
								where: {
									AND: [
										visibility(access, binding),
										{
											id: before.id,
											version: before.version,
											archivedAt: null
										}
									]
								},
								data: {
									version: { increment: 1 },
									...(action === 'ARCHIVED'
										? { archivedAt: new Date() }
										: {
												configuration:
													rule as unknown as Prisma.InputJsonValue
											})
								}
							});
							if (updated.count !== 1) conflict();
							stored = await this.visible(tx, access, binding, before.id);
						}
						const result = {
							schemaVersion: 1 as const,
							item: item(stored),
							deliveryReady
						};
						await tx.reminderRuleCommand.create({
							data: {
								commandId: dto.commandId,
								workspaceId: access.workspaceId,
								actorSubject: binding.subject,
								actorMembershipId: binding.membershipId,
								commandType: action,
								requestHash: commandHash,
								ruleId: stored.id,
								before: before
									? (item(before) as unknown as Prisma.InputJsonValue)
									: Prisma.DbNull,
								result: result as unknown as Prisma.InputJsonValue
							}
						});
						// Recheck exact current membership and full authority immediately
						// before commit, including replay. Failure rolls back rows+receipt.
						await this.authority(
							access,
							access.workspaceId,
							binding.membershipId,
							token,
							true
						);
						return result;
					},
					{ isolationLevel: 'Serializable', timeout: 20000 }
				);
			} catch (error) {
				if (
					error instanceof Prisma.PrismaClientKnownRequestError &&
					['P2034', 'P2002'].includes(error.code)
				) {
					if (attempt < 2) continue;
					conflict('crm_reminder_command_conflict');
				}
				throw error;
			}
		}
		conflict();
	}
}
