import {
	ForbiddenException,
	Injectable,
	ServiceUnavailableException
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
	EntitlementStatus,
	OwnerStatus,
	Prisma,
	UsageKind,
	UsageOperation,
	WidgetEntitlementProjection,
	WidgetUsageCounter
} from '@prisma/widgets-client';
import { WidgetsPrismaService } from '../prisma/widgets-prisma.service';

const TRANSACTION_OPTIONS = { maxWait: 5000, timeout: 10_000 } as const;

export interface QuotaOperationResult<T> {
	value: T;
	aggregateType: string;
	aggregateId: string;
}

export interface QuotaOperationInput {
	idempotencyKey: string;
	correlationId?: string;
}

export interface LeadQuotaResult<T> {
	value: T;
	newCount: number;
	limitReached: boolean;
}

export interface WidgetsQuotaSnapshot {
	entitlement: WidgetEntitlementProjection;
	counter: WidgetUsageCounter;
}

export interface WidgetsQuotaReadSnapshot {
	entitlement: WidgetEntitlementProjection | null;
	counter: WidgetUsageCounter | null;
}

interface LockedQuotaContext {
	entitlement: WidgetEntitlementProjection;
	counter: WidgetUsageCounter;
}

@Injectable()
export class WidgetsQuotaService {
	private readonly maxStalenessMs: number;

	constructor(
		private readonly prisma: WidgetsPrismaService,
		config: ConfigService
	) {
		const rawMaxStaleness = config
			.get<string>('WIDGETS_ENTITLEMENT_MAX_STALENESS_MS')
			?.trim();
		if (!rawMaxStaleness) {
			throw new Error('WIDGETS_ENTITLEMENT_MAX_STALENESS_MS is required');
		}
		const configured = Number(rawMaxStaleness);
		if (
			!Number.isInteger(configured) ||
			configured < 60_000 ||
			configured > 370 * 24 * 60 * 60 * 1000
		) {
			throw new Error(
				'WIDGETS_ENTITLEMENT_MAX_STALENESS_MS must be between 60000 and 31968000000 when configured'
			);
		}
		this.maxStalenessMs = configured;
	}

	async withWidgetCreation<T>(
		userId: string,
		input: QuotaOperationInput,
		operation: (
			transaction: Prisma.TransactionClient
		) => Promise<QuotaOperationResult<T>>
	): Promise<T> {
		return this.prisma.$transaction(async transaction => {
			const context = await this.lockContext(transaction, userId);
			if (
				context.entitlement.maxWidgets === null ||
				context.counter.widgetCount >= context.entitlement.maxWidgets
			) {
				throw new ForbiddenException(
					'Достигнут лимит виджетов для вашего тарифа'
				);
			}
			await this.assertUnusedIdempotencyKey(
				transaction,
				input.idempotencyKey
			);
			const result = await operation(transaction);
			const updated = await transaction.widgetUsageCounter.update({
				where: { userId },
				data: { widgetCount: { increment: 1 } }
			});
			await transaction.widgetUsageLedgerEntry.create({
				data: {
					userId,
					kind: UsageKind.WIDGET,
					operation: UsageOperation.CREATE,
					delta: 1,
					counterAfter: updated.widgetCount,
					aggregateType: result.aggregateType,
					aggregateId: result.aggregateId,
					idempotencyKey: input.idempotencyKey,
					entitlementVersion: context.entitlement.aggregateVersion,
					correlationId: input.correlationId
				}
			});
			return result.value;
		}, TRANSACTION_OPTIONS);
	}

	async withLeadCreation<T>(
		userId: string,
		input: QuotaOperationInput,
		operation: (
			transaction: Prisma.TransactionClient
		) => Promise<QuotaOperationResult<T>>,
		onLimitReached?: (
			transaction: Prisma.TransactionClient,
			limit: number,
			periodKey: string | null
		) => Promise<unknown>,
		findExisting?: (
			transaction: Prisma.TransactionClient
		) => Promise<T | null>
	): Promise<LeadQuotaResult<T>> {
		return this.prisma.$transaction(async transaction => {
			const context = await this.lockContext(transaction, userId);
			const existing = findExisting
				? await findExisting(transaction)
				: null;
			if (existing !== null) {
				return {
					value: existing,
					newCount: context.counter.leadCount,
					limitReached: false
				};
			}
			const limit = context.entitlement.maxLeadsPerPeriod;
			if (
				context.entitlement.unlimited !== true &&
				(limit === null || context.counter.leadCount >= limit)
			) {
				throw new ForbiddenException(
					'Лимит заявок исчерпан или подписка неактивна'
				);
			}
			await this.assertUnusedIdempotencyKey(
				transaction,
				input.idempotencyKey
			);
			const result = await operation(transaction);
			const updated = await transaction.widgetUsageCounter.update({
				where: { userId },
				data: { leadCount: { increment: 1 } }
			});
			await transaction.widgetUsageLedgerEntry.create({
				data: {
					userId,
					kind: UsageKind.LEAD,
					operation: UsageOperation.CREATE,
					delta: 1,
					counterAfter: updated.leadCount,
					periodKey: updated.leadPeriodKey,
					aggregateType: result.aggregateType,
					aggregateId: result.aggregateId,
					idempotencyKey: input.idempotencyKey,
					entitlementVersion: context.entitlement.aggregateVersion,
					correlationId: input.correlationId
				}
			});
			const limitReached =
				context.entitlement.unlimited !== true &&
				limit !== null &&
				updated.leadCount === limit;
			if (limitReached && onLimitReached) {
				await onLimitReached(
					transaction,
					limit as number,
					updated.leadPeriodKey
				);
			}
			return {
				value: result.value,
				newCount: updated.leadCount,
				limitReached
			};
		}, TRANSACTION_OPTIONS);
	}

	async withWidgetDeletion<T>(
		userId: string,
		input: QuotaOperationInput,
		operation: (
			transaction: Prisma.TransactionClient
		) => Promise<QuotaOperationResult<T>>
	): Promise<T> {
		return this.prisma.$transaction(async transaction => {
			const rows = await transaction.$queryRaw<Array<{ userId: string }>>`
				SELECT "user_id" AS "userId"
				FROM "widgets"."usage_counters"
				WHERE "user_id" = ${userId}
				FOR UPDATE
			`;
			if (!rows.length)
				this.unavailable('Widget usage counter is missing');
			const counter = await transaction.widgetUsageCounter.findUnique({
				where: { userId }
			});
			if (!counter) this.unavailable('Widget usage counter is missing');
			await this.assertUnusedIdempotencyKey(
				transaction,
				input.idempotencyKey
			);
			const result = await operation(transaction);
			if (counter.widgetCount < 1) {
				this.unavailable('Widget usage counter would become negative');
			}
			const updated = await transaction.widgetUsageCounter.update({
				where: { userId },
				data: { widgetCount: { decrement: 1 } }
			});
			await transaction.widgetUsageLedgerEntry.create({
				data: {
					userId,
					kind: UsageKind.WIDGET,
					operation: UsageOperation.DELETE,
					delta: -1,
					counterAfter: updated.widgetCount,
					aggregateType: result.aggregateType,
					aggregateId: result.aggregateId,
					idempotencyKey: input.idempotencyKey,
					entitlementVersion: counter.entitlementVersion,
					correlationId: input.correlationId
				}
			});
			return result.value;
		}, TRANSACTION_OPTIONS);
	}

	async snapshot(userId: string): Promise<WidgetsQuotaSnapshot> {
		return this.prisma.$transaction(async transaction => {
			const context = await this.lockContext(transaction, userId);
			return {
				entitlement: context.entitlement,
				counter: context.counter
			};
		}, TRANSACTION_OPTIONS);
	}

	async aiSnapshot(userId: string): Promise<WidgetsQuotaSnapshot> {
		const [owner, entitlement, counter] = await this.prisma.$transaction([
			this.prisma.widgetOwnerProjection.findUnique({ where: { userId } }),
			this.prisma.widgetEntitlementProjection.findUnique({
				where: { userId }
			}),
			this.prisma.widgetUsageCounter.findUnique({ where: { userId } })
		]);
		if (
			!owner ||
			owner.status !== OwnerStatus.ACTIVE ||
			owner.tombstoned ||
			owner.deletedAt
		) {
			throw new ForbiddenException('Операция недоступна для пользователя');
		}
		if (!entitlement || !counter) {
			this.unavailable('Entitlement projection is missing');
		}
		if (
			entitlement.tombstoned ||
			entitlement.status !== EntitlementStatus.ACTIVE ||
			entitlement.plan === null ||
			entitlement.startsAt === null ||
			entitlement.maxWidgets === null ||
			entitlement.unlimited === null
		) {
			throw new ForbiddenException('Ваша подписка неактивна');
		}
		const now = Date.now();
		if (
			(entitlement.expiresAt && entitlement.expiresAt.getTime() <= now) ||
			now - entitlement.sourceOccurredAt.getTime() > this.maxStalenessMs ||
			counter.entitlementVersion !== entitlement.aggregateVersion
		) {
			this.unavailable('Entitlement projection is stale');
		}
		return { entitlement, counter };
	}

	async readSnapshot(userId: string): Promise<WidgetsQuotaReadSnapshot> {
		const [entitlement, counter] = await this.prisma.$transaction([
			this.prisma.widgetEntitlementProjection.findUnique({
				where: { userId }
			}),
			this.prisma.widgetUsageCounter.findUnique({ where: { userId } })
		]);
		return { entitlement, counter };
	}

	private async lockContext(
		transaction: Prisma.TransactionClient,
		userId: string
	): Promise<LockedQuotaContext> {
		const rows = await transaction.$queryRaw<Array<{ userId: string }>>`
			SELECT "user_id" AS "userId"
			FROM "widgets"."usage_counters"
			WHERE "user_id" = ${userId}
			FOR UPDATE
		`;
		if (!rows.length) this.unavailable('Widget usage counter is missing');

		const [owner, entitlement, initialCounter] = await Promise.all([
			transaction.widgetOwnerProjection.findUnique({ where: { userId } }),
			transaction.widgetEntitlementProjection.findUnique({
				where: { userId }
			}),
			transaction.widgetUsageCounter.findUnique({ where: { userId } })
		]);
		if (
			!owner ||
			owner.status !== OwnerStatus.ACTIVE ||
			owner.tombstoned ||
			owner.deletedAt
		) {
			throw new ForbiddenException('Операция недоступна для пользователя');
		}
		if (!entitlement || !initialCounter) {
			this.unavailable('Entitlement projection is missing');
		}
		if (
			entitlement.tombstoned ||
			entitlement.status !== EntitlementStatus.ACTIVE ||
			entitlement.plan === null ||
			entitlement.startsAt === null ||
			entitlement.maxWidgets === null ||
			entitlement.unlimited === null ||
			(entitlement.unlimited === false &&
				entitlement.maxLeadsPerPeriod === null)
		) {
			throw new ForbiddenException('Ваша подписка неактивна');
		}
		const now = Date.now();
		if (
			(entitlement.expiresAt && entitlement.expiresAt.getTime() <= now) ||
			now - entitlement.sourceOccurredAt.getTime() > this.maxStalenessMs ||
			initialCounter.entitlementVersion !== entitlement.aggregateVersion
		) {
			this.unavailable('Entitlement projection is stale');
		}
		const counter = await this.rollLeadPeriodIfNeeded(
			transaction,
			entitlement,
			initialCounter,
			now
		);
		return { entitlement, counter };
	}

	private async rollLeadPeriodIfNeeded(
		transaction: Prisma.TransactionClient,
		entitlement: WidgetEntitlementProjection,
		counter: WidgetUsageCounter,
		now: number
	): Promise<WidgetUsageCounter> {
		if (
			!counter.leadPeriodEndsAt ||
			counter.leadPeriodEndsAt.getTime() > now
		) {
			return counter;
		}
		if (entitlement.billingPeriod === null) {
			this.unavailable(
				'Lead usage period ended without an authoritative billing period'
			);
		}
		const previousEnd = counter.leadPeriodEndsAt;
		let nextEnd = previousEnd;
		do {
			nextEnd = this.addBillingPeriod(nextEnd);
		} while (nextEnd.getTime() <= now);
		if (
			entitlement.expiresAt &&
			nextEnd.getTime() > entitlement.expiresAt.getTime()
		) {
			nextEnd = entitlement.expiresAt;
		}
		const periodKey = nextEnd.toISOString();
		const updated = await transaction.widgetUsageCounter.update({
			where: { userId: counter.userId },
			data: {
				leadCount: 0,
				leadPeriodKey: periodKey,
				leadPeriodStartsAt: previousEnd,
				leadPeriodEndsAt: nextEnd
			}
		});
		await transaction.widgetUsageLedgerEntry.createMany({
			data: [
				{
					userId: counter.userId,
					kind: UsageKind.LEAD,
					operation: UsageOperation.PERIOD_RESET,
					delta: -counter.leadCount,
					counterAfter: 0,
					periodKey,
					idempotencyKey: `usage-period:${counter.userId}:${previousEnd.toISOString()}:${periodKey}`,
					entitlementVersion: entitlement.aggregateVersion
				}
			],
			skipDuplicates: true
		});
		return updated;
	}

	private addBillingPeriod(value: Date): Date {
		// Lead quota always resets monthly. billingPeriod describes the paid
		// subscription term, not the lead-accounting period.
		const months = 1;
		const sourceYear = value.getUTCFullYear();
		const sourceMonth = value.getUTCMonth();
		const targetMonthIndex = sourceMonth + months;
		const targetYear = sourceYear + Math.floor(targetMonthIndex / 12);
		const targetMonth = targetMonthIndex % 12;
		const lastTargetDay = new Date(
			Date.UTC(targetYear, targetMonth + 1, 0)
		).getUTCDate();
		return new Date(
			Date.UTC(
				targetYear,
				targetMonth,
				Math.min(value.getUTCDate(), lastTargetDay),
				value.getUTCHours(),
				value.getUTCMinutes(),
				value.getUTCSeconds(),
				value.getUTCMilliseconds()
			)
		);
	}

	private async assertUnusedIdempotencyKey(
		transaction: Prisma.TransactionClient,
		idempotencyKey: string
	): Promise<void> {
		if (!idempotencyKey || idempotencyKey.length > 255) {
			throw new Error('Widget quota idempotency key is invalid');
		}
		const existing = await transaction.widgetUsageLedgerEntry.findUnique({
			where: { idempotencyKey },
			select: { id: true }
		});
		if (existing) {
			throw new ForbiddenException('Операция уже была учтена');
		}
	}

	private unavailable(reason: string): never {
		throw new ServiceUnavailableException(
			`Widget quota is temporarily unavailable: ${reason}`
		);
	}
}
