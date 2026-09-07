import {
	BadRequestException,
	ConflictException,
	ForbiddenException,
	Injectable,
	NotFoundException
} from '@nestjs/common';
import {
	Prisma,
	type CrmAdminDayGrant,
	type CrmEntitlement,
	type CrmCommerceAccount,
	type CrmPaidPeriod,
	type CrmAutoRenewal
} from '@prisma/billing-client';
import type { BillingActor } from '../auth/billing-request';
import { BillingPrismaService } from '../prisma/billing-prisma.service';
import type {
	CrmAdminSubscriptionListDto,
	CrmAdminSubscriptionPageDto,
	CancelCrmSubscriptionGrantDto,
	ExtendCrmSubscriptionDaysDto
} from '../http/crm-admin-subscription.dto';
import { enqueueBillingAdminAudit } from './billing-admin-audit';
import {
	assertBillingCommandReceipt,
	billingCommandRequestHash,
	lockBillingCommand
} from './billing-command-idempotency';
import { enqueueCrmEntitlementChanged } from './crm-entitlement-outbox';
import { readWincrmPriceSnapshot } from './wincrm-commerce.helpers';

const COMMAND_TYPE = 'ADMIN_EXTEND_WINCRM_DAYS';
const CANCEL_COMMAND_TYPE = 'CANCEL_ADMIN_EXTEND_WINCRM_DAYS';
const DAY_MS = 86_400_000;
type Tx = Prisma.TransactionClient;
type Context = {
	actor: BillingActor;
	ip?: string | null;
	userAgent?: string | null;
};
type SubscriptionProjection = {
	workspaceId: string;
	now: Date;
	entitlement: CrmEntitlement;
	account: CrmCommerceAccount | null;
	period: CrmPaidPeriod | null;
	currentPeriod: CrmPaidPeriod | null;
	renewal: CrmAutoRenewal | null;
	pendingOrders: number;
	pendingCommands: number;
};

@Injectable()
export class CrmAdminSubscriptionService {
	constructor(private readonly prisma: BillingPrismaService) {}

	private role(actor: BillingActor): 'ADMIN' | 'DEV' {
		if (actor.roles.includes('DEV')) return 'DEV';
		if (actor.roles.includes('ADMIN')) return 'ADMIN';
		throw new ForbiddenException(
			'Подписками WinCRM управляют ADMIN и DEV сервиса'
		);
	}

	async list(query: CrmAdminSubscriptionListDto, actor: BillingActor) {
		this.role(actor);
		return this.prisma.$transaction(
			async tx => {
				const now = new Date();
				const where = Prisma.sql`WHERE (${query.workspaceId ?? null}::uuid IS NULL OR e.workspace_id = ${query.workspaceId ?? null}::uuid)
				AND (${query.ownerSubject ?? null}::text IS NULL OR COALESCE(a.owner_subject, e.activated_by_user_id) = ${query.ownerSubject ?? null})`;
				const [count] = await tx.$queryRaw<{ total: bigint }[]>(
					Prisma.sql`SELECT count(*) AS total FROM billing.crm_entitlements e LEFT JOIN billing.crm_commerce_accounts a USING (workspace_id) ${where}`
				);
				const rows = await tx.$queryRaw<{ workspace_id: string }[]>(
					Prisma.sql`SELECT e.workspace_id FROM billing.crm_entitlements e LEFT JOIN billing.crm_commerce_accounts a USING (workspace_id) ${where} ORDER BY e.updated_at DESC, e.workspace_id LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}`
				);
				const items = await this.readPage(
					tx,
					rows.map(row => row.workspace_id),
					now
				);
				return {
					schemaVersion: 1,
					page: query.page,
					pageSize: query.pageSize,
					total: Number(count.total),
					items
				};
			},
			{
				isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
				maxWait: 5000,
				timeout: 25000
			}
		);
	}

	private async readPage(tx: Tx, workspaceIds: string[], now: Date) {
		if (workspaceIds.length === 0) return [];
		const where = { workspaceId: { in: workspaceIds } };
		const [
			entitlements,
			accounts,
			renewals,
			orders,
			commands,
			references
		] = await Promise.all([
			tx.crmEntitlement.findMany({ where }),
			tx.crmCommerceAccount.findMany({ where }),
			tx.crmAutoRenewal.findMany({ where }),
			tx.crmOrder.groupBy({
				by: ['workspaceId'],
				where: { ...where, status: { in: ['PENDING', 'UNKNOWN'] } },
				_count: { _all: true }
			}),
			tx.crmCommerceCommand.groupBy({
				by: ['workspaceId'],
				where: { ...where, status: 'PENDING' },
				_count: { _all: true }
			}),
			// Two index-backed top-one lookups per page item; never fetch paid history.
			tx.$queryRaw<
				{
					workspace_id: string;
					period_id: string | null;
					current_period_id: string | null;
				}[]
			>(Prisma.sql`
				SELECT e.workspace_id, latest.id AS period_id, started.id AS current_period_id
				FROM billing.crm_entitlements e
				LEFT JOIN LATERAL (
					SELECT p.id FROM billing.crm_paid_periods p WHERE p.workspace_id = e.workspace_id
					ORDER BY p.starts_at DESC, p.id DESC LIMIT 1
				) latest ON true
				LEFT JOIN LATERAL (
					SELECT p.id FROM billing.crm_paid_periods p WHERE p.workspace_id = e.workspace_id AND p.starts_at <= ${now}
					ORDER BY p.starts_at DESC, p.id DESC LIMIT 1
				) started ON true
				WHERE e.workspace_id IN (${Prisma.join(workspaceIds.map(id => Prisma.sql`${id}::uuid`))})
			`)
		]);
		const periodIds = [
			...new Set(
				references
					.flatMap(row => [row.period_id, row.current_period_id])
					.filter((id): id is string => id !== null)
			)
		];
		const periods = periodIds.length
			? await tx.crmPaidPeriod.findMany({
					where: { ...where, id: { in: periodIds } }
				})
			: [];
		const entitlementByWorkspace = new Map(
			entitlements.map(item => [item.workspaceId, item])
		);
		const accountByWorkspace = new Map(
			accounts.map(item => [item.workspaceId, item])
		);
		const renewalByWorkspace = new Map(
			renewals.map(item => [item.workspaceId, item])
		);
		const orderCounts = new Map(
			orders.map(item => [item.workspaceId, item._count._all])
		);
		const commandCounts = new Map(
			commands.map(item => [item.workspaceId, item._count._all])
		);
		const referencesByWorkspace = new Map(
			references.map(item => [item.workspace_id, item])
		);
		const periodById = new Map(periods.map(item => [item.id, item]));
		return workspaceIds.map(workspaceId => {
			const entitlement = entitlementByWorkspace.get(workspaceId);
			const reference = referencesByWorkspace.get(workspaceId);
			if (!entitlement || !reference)
				throw new Error('WinCRM subscription snapshot is incomplete');
			const resolvePeriod = (id: string | null) => {
				if (id === null) return null;
				const period = periodById.get(id);
				if (!period || period.workspaceId !== workspaceId)
					throw new Error('WinCRM period snapshot binding is invalid');
				return period;
			};
			return this.project({
				workspaceId,
				now,
				entitlement,
				account: accountByWorkspace.get(workspaceId) ?? null,
				renewal: renewalByWorkspace.get(workspaceId) ?? null,
				period: resolvePeriod(reference.period_id),
				currentPeriod: resolvePeriod(reference.current_period_id),
				pendingOrders: orderCounts.get(workspaceId) ?? 0,
				pendingCommands: commandCounts.get(workspaceId) ?? 0
			});
		});
	}

	async detail(workspaceId: string, actor: BillingActor) {
		this.role(actor);
		return this.prisma.$transaction(
			async tx => ({
				schemaVersion: 1,
				subscription: await this.read(tx, workspaceId)
			}),
			{ isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }
		);
	}

	async history(
		workspaceId: string,
		query: CrmAdminSubscriptionPageDto,
		actor: BillingActor
	) {
		this.role(actor);
		return this.prisma.$transaction(
			async tx => {
				await this.requireEntitlement(tx, workspaceId);
				const where = { workspaceId };
				const total = await tx.crmAdminDayGrant.count({ where });
				const grants = await tx.crmAdminDayGrant.findMany({
					where,
					orderBy: [{ createdAt: 'desc' }, { commandId: 'desc' }],
					skip: (query.page - 1) * query.pageSize,
					take: query.pageSize
				});
				return {
					schemaVersion: 1,
					workspaceId,
					page: query.page,
					pageSize: query.pageSize,
					total,
					items: grants.map(grant => this.grantView(grant))
				};
			},
			{ isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }
		);
	}

	async command(
		workspaceId: string,
		commandId: string,
		actor: BillingActor
	) {
		this.role(actor);
		const receipt = await this.prisma.billingCommandReceipt.findUnique({
			where: { commandId }
		});
		const result = receipt?.result as Record<string, unknown> | undefined;
		if (
			!receipt ||
			![COMMAND_TYPE, CANCEL_COMMAND_TYPE].includes(receipt.commandType) ||
			result?.workspaceId !== workspaceId
		) {
			throw new NotFoundException({
				code: 'crm_admin_grant_not_found',
				message:
					'Подтверждённое начисление пока не найдено. Операция может ещё выполняться.'
			});
		}
		return this.commandProof(receipt, workspaceId, commandId);
	}

	async cancel(
		workspaceId: string,
		commandId: string,
		dto: CancelCrmSubscriptionGrantDto,
		context: Context
	) {
		const actorRole = this.role(context.actor);
		this.assertActor(dto.expectedActorSubject, context.actor);
		const requestHash = billingCommandRequestHash(CANCEL_COMMAND_TYPE, {
			...dto,
			workspaceId,
			commandId,
			actorSubject: context.actor.subject
		});
		for (let attempt = 0; ; attempt += 1) {
			try {
				return await this.prisma.$transaction(
					async tx => {
						await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;
						await lockBillingCommand(tx, commandId);
						await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`billing-wincrm-entitlement:${workspaceId}`}, 0))`;
						const prior = await tx.billingCommandReceipt.findUnique({
							where: { commandId }
						});
						if (prior) {
							const proof = this.commandProof(
								prior,
								workspaceId,
								commandId
							);
							if (proof.actorSubject !== context.actor.subject)
								throw this.commandConflict();
							if (prior.commandType === CANCEL_COMMAND_TYPE)
								assertBillingCommandReceipt(
									prior,
									CANCEL_COMMAND_TYPE,
									requestHash
								);
							return proof;
						}
						await this.requireEntitlement(tx, workspaceId);
						const result = {
							schemaVersion: 1 as const,
							workspaceId,
							commandId,
							actorSubject: context.actor.subject,
							actorRole,
							outcome: 'CANCELLED' as const,
							cancelledAt: new Date().toISOString()
						};
						await tx.billingCommandReceipt.create({
							data: {
								commandId,
								commandType: CANCEL_COMMAND_TYPE,
								requestHash,
								requestHashVersion: 1,
								result
							}
						});
						await enqueueBillingAdminAudit(tx, {
							actor: {
								id: context.actor.subject,
								role: actorRole,
								ip: context.ip,
								userAgent: context.userAgent
							},
							section: 'SUBSCRIPTIONS',
							action: 'SUBSCRIPTION_EXTEND_DAYS',
							description: `WinCRM: отменена неподтверждённая команда начисления дней ${commandId}; подписка не изменена`,
							entity: {
								type: 'crm_subscription_command',
								id: commandId,
								label: 'WinCRM',
								targetUserId: null
							},
							metadata: {
								productCode: 'WINCRM',
								operation: 'CANCEL_UNCONFIRMED_COMMAND',
								...result
							}
						});
						await tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`;
						return result;
					},
					{
						isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
						maxWait: 5000,
						timeout: 25000
					}
				);
			} catch (error) {
				if (attempt >= 2 || !this.retryableCommandConflict(error))
					throw error;
			}
		}
	}

	private commandProof(
		receipt: { commandType: string; result: Prisma.JsonValue },
		workspaceId: string,
		commandId: string
	) {
		const result = receipt.result;
		if (
			!result ||
			typeof result !== 'object' ||
			Array.isArray(result) ||
			result.schemaVersion !== 1 ||
			result.workspaceId !== workspaceId ||
			result.commandId !== commandId
		)
			throw this.commandConflict();
		if (receipt.commandType === COMMAND_TYPE) {
			const grant = result.grant;
			if (
				!grant ||
				typeof grant !== 'object' ||
				Array.isArray(grant) ||
				typeof grant.actorSubject !== 'string'
			)
				throw this.commandConflict();
			return {
				schemaVersion: 1 as const,
				workspaceId,
				commandId,
				actorSubject: grant.actorSubject,
				outcome: 'COMMITTED' as const,
				result
			};
		}
		if (
			receipt.commandType !== CANCEL_COMMAND_TYPE ||
			result.outcome !== 'CANCELLED' ||
			typeof result.actorSubject !== 'string' ||
			!['ADMIN', 'DEV'].includes(String(result.actorRole)) ||
			typeof result.cancelledAt !== 'string' ||
			!Number.isFinite(Date.parse(result.cancelledAt))
		)
			throw this.commandConflict();
		return {
			schemaVersion: 1 as const,
			workspaceId,
			commandId,
			actorSubject: result.actorSubject,
			actorRole: result.actorRole as 'ADMIN' | 'DEV',
			outcome: 'CANCELLED' as const,
			cancelledAt: result.cancelledAt
		};
	}

	private commandConflict() {
		return new ConflictException({
			code: 'crm_admin_subscription_command_conflict',
			message:
				'Идентификатор команды связан с другой операцией, аккаунтом или пространством'
		});
	}

	private retryableCommandConflict(error: unknown) {
		const failure = error as {
			code?: string;
			meta?: { modelName?: string };
		} | null;
		// A Serializable snapshot may predate the advisory-lock winner's commit.
		// Its receipt insert can then fail as a unique violation, not P2034.
		// This model's only unique key is commandId; never retry other ledgers.
		return (
			failure?.code === 'P2034' ||
			(failure?.code === 'P2002' &&
				failure.meta?.modelName === 'BillingCommandReceipt')
		);
	}

	private assertActor(expectedActorSubject: string, actor: BillingActor) {
		if (expectedActorSubject !== actor.subject)
			throw new ConflictException({
				code: 'crm_admin_subscription_actor_changed',
				message:
					'Сессия администратора изменилась. Вернитесь в исходный аккаунт для проверки операции.'
			});
	}

	async extend(
		workspaceId: string,
		dto: ExtendCrmSubscriptionDaysDto,
		context: Context
	) {
		const actorRole = this.role(context.actor);
		this.assertActor(dto.expectedActorSubject, context.actor);
		if (
			(dto.expectedPeriodId === null) !==
			(dto.expectedPeriodVersion === null)
		) {
			throw new BadRequestException(
				'Ожидаемая версия периода должна соответствовать его ID'
			);
		}
		const requestHash = billingCommandRequestHash(COMMAND_TYPE, {
			...dto,
			workspaceId,
			actorSubject: context.actor.subject
		});
		for (let attempt = 0; ; attempt += 1) {
			try {
				return await this.prisma.$transaction(
					async tx => {
						await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;
						await lockBillingCommand(tx, dto.commandId);
						const prior = await tx.billingCommandReceipt.findUnique({
							where: { commandId: dto.commandId }
						});
						if (prior?.commandType === CANCEL_COMMAND_TYPE) {
							const proof = this.commandProof(
								prior,
								workspaceId,
								dto.commandId
							);
							if (proof.actorSubject !== context.actor.subject)
								throw this.commandConflict();
							throw new ConflictException({
								code: 'crm_admin_grant_cancelled',
								message:
									'Команда начисления отменена. Дополнительные дни не начислялись.'
							});
						}
						if (prior)
							return assertBillingCommandReceipt(
								prior,
								COMMAND_TYPE,
								requestHash
							);
						await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`billing-wincrm-entitlement:${workspaceId}`}, 0))`;
						const before = await this.read(tx, workspaceId);
						if (
							before.entitlementVersion !==
								dto.expectedEntitlementVersion ||
							before.billingVersion !== dto.expectedBillingVersion ||
							(before.period?.id ?? null) !== dto.expectedPeriodId ||
							(before.period?.version ?? null) !==
								dto.expectedPeriodVersion
						) {
							throw new ConflictException({
								code: 'crm_admin_subscription_version_conflict',
								message:
									'Подписка изменилась. Обновите данные перед начислением дней.'
							});
						}
						if (before.blockedReason)
							throw new ConflictException({
								code: before.blockedReason,
								message:
									'Начисление сейчас недоступно. Проверьте состояние подписки и незавершённых операций.'
							});
						if (
							BigInt(before.entitlementVersion) >=
								9_223_372_036_854_775_806n ||
							BigInt(before.billingVersion) >=
								9_223_372_036_854_775_806n ||
							(before.period && before.period.version >= 2_147_483_646)
						)
							throw new ConflictException(
								'Достигнут предел версии подписки'
							);
						const now = new Date();
						const oldExpiresAt = new Date(
							before.period?.expiresAt ?? before.entitlement.effectiveUntil
						);
						const newExpiresAt = this.timestamp(
							Math.max(now.getTime(), oldExpiresAt.getTime()) +
								dto.days * DAY_MS
						);
						if (before.period) {
							const period = await tx.crmPaidPeriod.findUniqueOrThrow({
								where: { id: before.period.id }
							});
							const graceDays = readWincrmPriceSnapshot(
								period.priceSnapshot
							).graceDays;
							await tx.crmPaidPeriod.update({
								where: { id: period.id, version: period.version },
								data: {
									expiresAt: newExpiresAt,
									graceUntil: this.timestamp(
										newExpiresAt.getTime() + graceDays * DAY_MS
									),
									version: { increment: 1 }
								}
							});
							await tx.crmEntitlement.update({
								where: { workspaceId },
								data: { status: 'ACTIVE' }
							});
						} else {
							const base = await this.requireEntitlement(tx, workspaceId);
							const graceDuration = base.graceUntil
								? base.graceUntil.getTime() - base.effectiveUntil.getTime()
								: null;
							if (graceDuration !== null && graceDuration <= 0)
								throw new ConflictException({
									code: 'crm_admin_subscription_policy_invalid',
									message: 'Период льготного доступа некорректен'
								});
							await tx.crmEntitlement.update({
								where: {
									workspaceId,
									aggregateVersion: BigInt(before.entitlementVersion)
								},
								data: {
									status: 'ACTIVE',
									effectiveUntil: newExpiresAt,
									graceUntil:
										graceDuration === null
											? null
											: this.timestamp(
													newExpiresAt.getTime() + graceDuration
												)
								}
							});
						}
						if (before.billingVersion !== '0')
							await tx.crmCommerceAccount.update({
								where: {
									workspaceId,
									version: BigInt(before.billingVersion)
								},
								data: { version: { increment: 1 } }
							});
						if (before.renewal) {
							await tx.crmAutoRenewal.update({
								where: { workspaceId },
								data: {
									nextChargeAt: newExpiresAt,
									nextRetryAt: null,
									retryStartedAt: null,
									retryAttempt: 0,
									version: { increment: 1 }
								}
							});
						}
						await enqueueCrmEntitlementChanged(tx, workspaceId);
						const grant = await tx.crmAdminDayGrant.create({
							data: {
								commandId: dto.commandId,
								workspaceId,
								actorSubject: context.actor.subject,
								actorRole,
								days: dto.days,
								reason: dto.reason,
								target: before.period ? 'PAID_PERIOD' : 'ENTITLEMENT',
								periodId: before.period?.id ?? null,
								oldExpiresAt,
								newExpiresAt,
								createdAt: now
							}
						});
						const result = {
							schemaVersion: 1,
							workspaceId,
							commandId: dto.commandId,
							grant: this.grantView(grant),
							subscription: await this.read(tx, workspaceId)
						};
						await enqueueBillingAdminAudit(tx, {
							actor: {
								id: context.actor.subject,
								role: actorRole,
								ip: context.ip,
								userAgent: context.userAgent
							},
							section: 'SUBSCRIPTIONS',
							action: 'SUBSCRIPTION_EXTEND_DAYS',
							description: `WinCRM: бесплатно начислено ${dto.days} дней пространству ${workspaceId}`,
							entity: {
								type: 'crm_subscription',
								id: workspaceId,
								label: 'WinCRM',
								targetUserId: before.ownerSubject
							},
							metadata: {
								productCode: 'WINCRM',
								...this.grantView(grant),
								before,
								after: result.subscription
							}
						});
						await tx.billingCommandReceipt.create({
							data: {
								commandId: dto.commandId,
								commandType: COMMAND_TYPE,
								requestHash,
								requestHashVersion: 1,
								result: result as unknown as Prisma.InputJsonValue
							}
						});
						await tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`;
						return result;
					},
					{
						isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
						maxWait: 5000,
						timeout: 25000
					}
				);
			} catch (error) {
				if (attempt >= 2 || !this.retryableCommandConflict(error))
					throw error;
			}
		}
	}

	private async requireEntitlement(tx: Tx, workspaceId: string) {
		const entitlement = await tx.crmEntitlement.findUnique({
			where: { workspaceId }
		});
		if (!entitlement)
			throw new NotFoundException({
				code: 'crm_admin_subscription_not_provisioned',
				message:
					'CRM ещё не активирована в этом пространстве. Начисление дней не создаёт новое рабочее пространство.'
			});
		return entitlement;
	}

	private async read(tx: Tx, workspaceId: string) {
		const entitlement = await this.requireEntitlement(tx, workspaceId);
		const now = new Date();
		const [
			account,
			period,
			renewal,
			pendingOrders,
			pendingCommands,
			currentPeriod
		] = await Promise.all([
			tx.crmCommerceAccount.findUnique({ where: { workspaceId } }),
			tx.crmPaidPeriod.findFirst({
				where: { workspaceId },
				orderBy: [{ startsAt: 'desc' }, { id: 'desc' }]
			}),
			tx.crmAutoRenewal.findUnique({ where: { workspaceId } }),
			tx.crmOrder.count({
				where: { workspaceId, status: { in: ['PENDING', 'UNKNOWN'] } }
			}),
			tx.crmCommerceCommand.count({
				where: { workspaceId, status: 'PENDING' }
			}),
			tx.crmPaidPeriod.findFirst({
				where: { workspaceId, startsAt: { lte: now } },
				orderBy: [{ startsAt: 'desc' }, { id: 'desc' }]
			})
		]);
		return this.project({
			workspaceId,
			now,
			entitlement,
			account,
			period,
			currentPeriod,
			renewal,
			pendingOrders,
			pendingCommands
		});
	}

	private project({
		workspaceId,
		now,
		entitlement,
		account,
		period,
		currentPeriod,
		renewal,
		pendingOrders,
		pendingCommands
	}: SubscriptionProjection) {
		const activePeriod = ['SUSPENDED', 'CANCELLED'].includes(
			entitlement.status
		)
			? null
			: currentPeriod;
		const effectiveUntil =
			activePeriod?.expiresAt ?? entitlement.effectiveUntil;
		const graceUntil = activePeriod?.graceUntil ?? entitlement.graceUntil;
		const baseStatus =
			activePeriod &&
			!['SUSPENDED', 'CANCELLED'].includes(entitlement.status)
				? 'ACTIVE'
				: entitlement.status;
		const status =
			baseStatus !== 'ACTIVE'
				? baseStatus
				: effectiveUntil > now
					? 'ACTIVE'
					: graceUntil
						? graceUntil > now
							? 'GRACE'
							: 'READ_ONLY'
						: 'EXPIRED';
		return {
			workspaceId,
			ownerSubject: account?.ownerSubject ?? entitlement.activatedByUserId,
			entitlementVersion: entitlement.aggregateVersion.toString(),
			billingVersion: account?.version.toString() ?? '0',
			entitlement: {
				planCode: activePeriod ? 'PAID' : entitlement.planCode,
				status,
				seatLimit: activePeriod?.totalSeats ?? entitlement.seatLimit,
				effectiveFrom: (
					activePeriod?.startsAt ?? entitlement.effectiveFrom
				).toISOString(),
				effectiveUntil: effectiveUntil.toISOString(),
				graceUntil: graceUntil?.toISOString() ?? null
			},
			period: period
				? {
						id: period.id,
						version: period.version,
						startsAt: period.startsAt.toISOString(),
						expiresAt: period.expiresAt.toISOString(),
						graceUntil: period.graceUntil.toISOString(),
						totalSeats: period.totalSeats
					}
				: null,
			renewal: renewal
				? {
						status: renewal.status,
						nextChargeAt: renewal.nextChargeAt.toISOString()
					}
				: null,
			extensionTarget: period ? 'PAID_PERIOD' : 'ENTITLEMENT',
			blockedReason: ['SUSPENDED', 'CANCELLED'].includes(
				entitlement.status
			)
				? 'crm_admin_subscription_suspended'
				: pendingOrders || pendingCommands || renewal?.dispatchPending
					? 'crm_admin_subscription_operation_pending'
					: renewal && renewal.version >= 2_147_483_646
						? 'crm_admin_subscription_version_limit'
						: account?.capacityCommandId && !account.capacityFence
							? 'crm_admin_subscription_capacity_pending'
							: null
		};
	}

	private grantView(grant: CrmAdminDayGrant) {
		return {
			...grant,
			oldExpiresAt: grant.oldExpiresAt.toISOString(),
			newExpiresAt: grant.newExpiresAt.toISOString(),
			createdAt: grant.createdAt.toISOString()
		};
	}

	private timestamp(value: number) {
		const date = new Date(value);
		if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() > 9999)
			throw new BadRequestException({
				code: 'crm_admin_subscription_date_out_of_range',
				message: 'Срок подписки вне допустимого диапазона'
			});
		return date;
	}
}
