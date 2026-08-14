import {
	BadRequestException,
	Injectable,
	NotFoundException,
	ServiceUnavailableException
} from '@nestjs/common';
import { Prisma } from '@prisma/widgets-client';
import {
	CoreInternalClient,
	WidgetsOwnerDirectoryItem
} from '../internal/core-internal.client';
import { WidgetsDomainRepository } from '../domain/widgets-domain.repository';
import { WidgetsDomainService } from '../domain/widgets-domain.service';
import {
	getWidgetDefinition,
	WidgetType
} from '../domain/widgets-domain.types';

const MAX_PAGE_WINDOW = 10_000;
const OWNER_BATCH_SIZE = 100;
const MAX_OWNER_DIRECTORY_PAGES = 100;
const MAX_SEARCH_LENGTH = 200;

interface MonitoringRow {
	type: WidgetType;
	id: string;
	name: string;
	publicKey: string;
	isActive: boolean;
	installDomain: string;
	ownerId: string;
	leadCount: number;
	lastLeadAt: Date | null;
	createdAt: Date;
	updatedAt: Date;
}

interface MonitoringFilters {
	type?: WidgetType;
	isActive?: boolean;
	plan?: 'TRIAL' | 'EASY' | 'HARD' | 'NONE';
	search?: string;
}

interface WidgetOverviewRow {
	type: WidgetType;
	count: number;
	active: number;
}

interface LatestWidgetRow {
	id: string;
	type: WidgetType;
	name: string;
	isActive: boolean;
	installDomain: string;
	leadsCount: number;
	updatedAt: Date;
}

interface LeadOverviewRow {
	type: WidgetType;
	count: number;
}

interface LatestLeadRow {
	id: string;
	type: WidgetType;
	sourceName: string;
	contact: string | null;
	phone: string | null;
	email: string | null;
	url: string | null;
	detail: string | null;
	createdAt: Date;
}

type WidgetAdminAlertType =
	| 'ACTIVE_WIDGET_WITHOUT_ACCESS'
	| 'WIDGET_DOMAIN_CONFLICT'
	| 'WIDGET_INVALID_DOMAIN';

interface WidgetAdminAlertRow {
	alertType: WidgetAdminAlertType;
	widgetType: WidgetType;
	id: string;
	ownerId: string;
	name: string;
	installDomain: string;
	updatedAt: Date;
}

interface WidgetUsageRow {
	userId: string;
	widgetCount: number;
	leadCount: number;
	leadPeriodKey: string | null;
	leadPeriodStartsAt: Date | null;
	leadPeriodEndsAt: Date | null;
}

@Injectable()
export class WidgetsAdminMonitoringService {
	constructor(
		private readonly repository: WidgetsDomainRepository,
		private readonly core: CoreInternalClient,
		private readonly domain: WidgetsDomainService
	) {}

	async list(
		page: number,
		limit: number,
		input: {
			type?: string;
			isActive?: string;
			plan?: string;
			search?: string;
		}
	) {
		const normalizedPage = Number.isInteger(page) && page > 0 ? page : 1;
		const normalizedLimit =
			Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 20;
		const offset = (normalizedPage - 1) * normalizedLimit;
		const window = offset + normalizedLimit;
		if (!Number.isSafeInteger(window) || window > MAX_PAGE_WINDOW) {
			throw new BadRequestException(
				'Окно пагинации мониторинга не должно превышать 10000 записей'
			);
		}
		const filters = this.parseFilters(input);
		const result = filters.search
			? await this.listForSearch(filters, window)
			: await this.queryRows(filters, normalizedLimit, offset);
		const selected = filters.search
			? result.rows.slice(offset, window)
			: result.rows;
		const owners = await this.resolveOwnersForRows(selected);
		const ownerById = new Map(owners.map(owner => [owner.id, owner]));
		const items = selected.map(row => {
			const owner = ownerById.get(row.ownerId);
			if (!owner) {
				throw new ServiceUnavailableException(
					'Owner directory returned an incomplete response'
				);
			}
			return this.serialize(row, owner);
		});
		return {
			items,
			total: result.total,
			page: normalizedPage,
			limit: normalizedLimit,
			totalPages: Math.max(1, Math.ceil(result.total / normalizedLimit))
		};
	}

	async get(type: WidgetType, id: string) {
		const lifecycle = await this.domain.adminGet(type, id);
		const ownerId = await this.domain.ownerId(type, id);
		const resolvedOwner = (await this.core.resolveOwners([ownerId]))[0];
		if (!resolvedOwner) {
			throw new NotFoundException('Владелец виджета не найден');
		}
		if (resolvedOwner.status === 'DELETED' || resolvedOwner.deletedAt) {
			throw new BadRequestException(
				'Сначала восстановите удалённого владельца виджета'
			);
		}
		const owner = (
			await this.enrichOwnersWithEntitlements([resolvedOwner])
		)[0];
		return {
			type,
			entity: {
				id: lifecycle.id,
				userId: ownerId,
				publicKey: lifecycle.publicKey,
				name: lifecycle.name,
				isActive: lifecycle.isActive,
				installDomain: lifecycle.installDomain,
				config: lifecycle.config,
				createdAt: lifecycle.createdAt,
				updatedAt: lifecycle.updatedAt,
				draftRevision: lifecycle.draftRevision,
				publishedVersion: lifecycle.publishedVersion,
				publishedFromDraftRevision: lifecycle.publishedFromDraftRevision,
				publishedAt: lifecycle.publishedAt,
				status: lifecycle.status,
				hasUnpublishedChanges: lifecycle.hasUnpublishedChanges
			},
			owner: {
				id: owner.id,
				name: owner.name,
				email: owner.email,
				phone: owner.phone
			},
			ownerStatus: owner.status,
			lifecycle,
			ownerPlan: owner.subscription?.plan || null,
			subscriptionStatus: owner.subscription?.status || null
		};
	}

	async ownerOverview(userId: string) {
		const [widgetRows, latestWidgets, leadRows, latestLeads, usage] =
			await this.repository.client().$transaction([
				this.repository.client().$queryRaw<WidgetOverviewRow[]>(Prisma.sql`
					SELECT type, COUNT(*)::int AS count,
						COUNT(*) FILTER (WHERE is_active)::int AS active
					FROM (${this.widgetUnion(false)}) widgets
					WHERE user_id = ${userId}
					GROUP BY type
				`),
				this.repository.client().$queryRaw<LatestWidgetRow[]>(Prisma.sql`
					SELECT id, type, name, is_active AS "isActive",
						install_domain AS "installDomain",
						lead_count AS "leadsCount", updated_at AS "updatedAt"
					FROM (${this.widgetUnion(false)}) widgets
					WHERE user_id = ${userId}
					ORDER BY updated_at DESC, type ASC, id ASC
					LIMIT 20
				`),
				this.repository.client().$queryRaw<LeadOverviewRow[]>(Prisma.sql`
					SELECT type, COUNT(*)::int AS count
					FROM (${this.leadUnion()}) leads
					WHERE user_id = ${userId}
					GROUP BY type
				`),
				this.repository.client().$queryRaw<LatestLeadRow[]>(Prisma.sql`
					SELECT id, type, source_name AS "sourceName", contact,
						phone, email, url, detail, created_at AS "createdAt"
					FROM (${this.leadUnion()}) leads
					WHERE user_id = ${userId}
					ORDER BY created_at DESC, type ASC, id ASC
					LIMIT 20
				`),
				this.repository.client().widgetUsageCounter.findUnique({
					where: { userId },
					select: {
						userId: true,
						widgetCount: true,
						leadCount: true,
						leadPeriodKey: true,
						leadPeriodStartsAt: true,
						leadPeriodEndsAt: true
					}
				})
			]);
		const widgetByType = this.completeWidgetOverview(widgetRows);
		const leadByType = this.completeLeadOverview(leadRows);
		const total = widgetByType.reduce((sum, item) => sum + item.count, 0);
		const active = widgetByType.reduce(
			(sum, item) => sum + item.active,
			0
		);
		return {
			widgets: {
				total,
				active,
				inactive: total - active,
				byType: widgetByType,
				latest: latestWidgets.map(row => ({
					id: row.id,
					type: this.overviewType(row.type),
					label: getWidgetDefinition(row.type).label,
					name: row.name,
					isActive: row.isActive,
					installDomain: row.installDomain,
					leadsCount: row.leadsCount,
					updatedAt: row.updatedAt.toISOString()
				}))
			},
			leads: {
				total: leadByType.reduce((sum, item) => sum + item.count, 0),
				byType: leadByType,
				latest: latestLeads.map(row => ({
					id: row.id,
					type: this.overviewType(row.type),
					label: getWidgetDefinition(row.type).label,
					sourceName: row.sourceName,
					contact: row.contact,
					phone: row.phone,
					email: row.email,
					url: row.url,
					detail: row.detail,
					createdAt: row.createdAt.toISOString()
				}))
			},
			usage: this.serializeUsage(usage)
		};
	}

	async ownerUsage(userIds: string[]) {
		const rows = await this.repository
			.client()
			.widgetUsageCounter.findMany({
				where: { userId: { in: userIds } },
				select: {
					userId: true,
					widgetCount: true,
					leadCount: true,
					leadPeriodKey: true,
					leadPeriodStartsAt: true,
					leadPeriodEndsAt: true
				}
			});
		const byUserId = new Map(rows.map(row => [row.userId, row]));

		return {
			items: userIds.map(userId => ({
				userId,
				...this.serializeUsage(byUserId.get(userId))
			}))
		};
	}

	async adminAlerts() {
		const rows = await this.repository.client().$queryRaw<
			WidgetAdminAlertRow[]
		>(Prisma.sql`
			WITH widget_rows AS (
				${this.widgetAlertUnion()}
			), domain_conflicts AS (
				SELECT lower(btrim(install_domain)) AS install_domain
				FROM widget_rows
				WHERE is_active = true
					AND btrim(install_domain) <> ''
				GROUP BY lower(btrim(install_domain))
				HAVING COUNT(DISTINCT user_id) > 1
			)
			SELECT
				'ACTIVE_WIDGET_WITHOUT_ACCESS'::text AS "alertType",
				w.type AS "widgetType",
				w.id,
				w.user_id AS "ownerId",
				w.name,
				w.install_domain AS "installDomain",
				w.updated_at AS "updatedAt"
			FROM widget_rows w
			WHERE w.is_active = true
				AND NOT EXISTS (
					SELECT 1
					FROM widgets.entitlement_projections entitlement
					WHERE entitlement.user_id = w.user_id
						AND entitlement.tombstoned = false
						AND entitlement.status::text = 'ACTIVE'
						AND (
							entitlement.expires_at IS NULL
							OR entitlement.expires_at >= NOW()
						)
				)

			UNION ALL

			SELECT
				'WIDGET_DOMAIN_CONFLICT'::text AS "alertType",
				w.type AS "widgetType",
				w.id,
				w.user_id AS "ownerId",
				w.name,
				w.install_domain AS "installDomain",
				w.updated_at AS "updatedAt"
			FROM widget_rows w
			JOIN domain_conflicts conflict
				ON lower(btrim(w.install_domain)) = conflict.install_domain
			WHERE w.is_active = true

			UNION ALL

			SELECT
				'WIDGET_INVALID_DOMAIN'::text AS "alertType",
				w.type AS "widgetType",
				w.id,
				w.user_id AS "ownerId",
				w.name,
				w.install_domain AS "installDomain",
				w.updated_at AS "updatedAt"
			FROM widget_rows w
			WHERE w.is_active = true
				AND btrim(w.install_domain) <> ''
				AND (
					w.install_domain <> lower(w.install_domain)
					OR w.install_domain LIKE '% %'
					OR w.install_domain LIKE '%/%'
					OR w.install_domain LIKE '%@%'
				)
			ORDER BY "updatedAt" ASC, "alertType" ASC, "widgetType" ASC, id ASC
		`);

		return {
			items: rows.map(row => this.serializeAdminAlert(row))
		};
	}

	private async listForSearch(
		filters: MonitoringFilters,
		window: number
	): Promise<{ rows: MonitoringRow[]; total: number }> {
		const local = await this.queryRows(filters, window, 0, undefined, []);
		let total = local.total;
		const topRows = new Map(
			local.rows.map(row => [this.rowKey(row), row] as const)
		);
		await this.eachOwnerBatch(filters.search as string, async owners => {
			const ownerIds = owners.map(owner => owner.id);
			const [matching, intersection] = await Promise.all([
				this.queryRows(filters, window, 0, ownerIds),
				this.countRows(filters, ownerIds, [])
			]);
			total += matching.total - intersection;
			this.mergeTop(topRows, matching.rows, window);
		});
		return {
			rows: this.sorted([...topRows.values()]).slice(0, window),
			total
		};
	}

	private async eachOwnerBatch(
		search: string,
		consume: (owners: WidgetsOwnerDirectoryItem[]) => Promise<void>
	): Promise<void> {
		let afterId: string | undefined;
		for (
			let pageNumber = 1;
			pageNumber <= MAX_OWNER_DIRECTORY_PAGES;
			pageNumber += 1
		) {
			const page = await this.core.searchOwners({
				search,
				...(afterId && { afterId }),
				limit: OWNER_BATCH_SIZE
			});
			if (page.items.length) await consume(page.items);
			if (!page.nextAfterId) return;
			if (!page.items.length || page.nextAfterId === afterId) {
				throw new ServiceUnavailableException(
					'Owner directory cursor did not advance'
				);
			}
			afterId = page.nextAfterId;
		}
		throw new BadRequestException(
			'Поисковый запрос слишком широкий, уточните его'
		);
	}

	private async queryRows(
		filters: MonitoringFilters,
		take: number,
		skip: number,
		ownerIds?: string[],
		ownerMatchedIds?: string[]
	): Promise<{ rows: MonitoringRow[]; total: number }> {
		if (ownerIds && !ownerIds.length) return { rows: [], total: 0 };
		const where = this.monitoringWhere(filters, ownerIds, ownerMatchedIds);
		const [rows, counts] = await this.repository.client().$transaction([
			this.repository.client().$queryRaw<MonitoringRow[]>(Prisma.sql`
				SELECT type, id, name, public_key AS "publicKey",
					is_active AS "isActive", install_domain AS "installDomain",
					user_id AS "ownerId", lead_count AS "leadCount",
					last_lead_at AS "lastLeadAt", created_at AS "createdAt",
					updated_at AS "updatedAt"
				FROM (${this.widgetUnion(true)}) rows
				${where}
				ORDER BY last_lead_at DESC NULLS LAST, created_at DESC,
					type ASC, id ASC
				LIMIT ${take} OFFSET ${skip}
			`),
			this.repository.client().$queryRaw<
				Array<{ count: bigint }>
			>(Prisma.sql`
				SELECT COUNT(*)::bigint AS count
				FROM (${this.widgetUnion(true)}) rows
				${where}
			`)
		]);
		return { rows, total: this.safeCount(counts[0]?.count) };
	}

	private async countRows(
		filters: MonitoringFilters,
		ownerIds?: string[],
		ownerMatchedIds?: string[]
	): Promise<number> {
		if (ownerIds && !ownerIds.length) return 0;
		const rows = await this.repository.client().$queryRaw<
			Array<{ count: bigint }>
		>(Prisma.sql`
			SELECT COUNT(*)::bigint AS count
			FROM (${this.widgetUnion(true)}) rows
			${this.monitoringWhere(filters, ownerIds, ownerMatchedIds)}
		`);
		return this.safeCount(rows[0]?.count);
	}

	private monitoringWhere(
		filters: MonitoringFilters,
		ownerIds?: string[],
		ownerMatchedIds?: string[]
	): Prisma.Sql {
		const clauses: Prisma.Sql[] = [
			Prisma.sql`
			EXISTS (
				SELECT 1
				FROM widgets.owner_projections owner_projection
				WHERE owner_projection.user_id = rows.user_id
					AND owner_projection.tombstoned = false
					AND owner_projection.deleted_at IS NULL
					AND owner_projection.status IN (
						'ACTIVE'::widgets."OwnerStatus",
						'DEACTIVATED'::widgets."OwnerStatus"
					)
			)
		`
		];
		if (filters.type) clauses.push(Prisma.sql`type = ${filters.type}`);
		if (filters.isActive !== undefined) {
			clauses.push(Prisma.sql`is_active = ${filters.isActive}`);
		}
		if (ownerIds) {
			clauses.push(Prisma.sql`user_id IN (${Prisma.join(ownerIds)})`);
		}
		if (filters.plan === 'NONE') {
			clauses.push(Prisma.sql`
				NOT EXISTS (
					SELECT 1
					FROM widgets.entitlement_projections entitlement
					WHERE entitlement.user_id = rows.user_id
						AND entitlement.tombstoned = false
				)
			`);
		} else if (filters.plan) {
			clauses.push(Prisma.sql`
				EXISTS (
					SELECT 1
					FROM widgets.entitlement_projections entitlement
					WHERE entitlement.user_id = rows.user_id
						AND entitlement.tombstoned = false
						AND entitlement.plan::text = ${filters.plan}
				)
			`);
		}
		if (filters.search) {
			const local = this.localSearch(filters.search);
			if (ownerMatchedIds === undefined) {
				// Owner search already selected the batch, so every row in it matches.
			} else if (ownerMatchedIds.length) {
				clauses.push(
					Prisma.sql`(${local} OR user_id IN (${Prisma.join(ownerMatchedIds)}))`
				);
			} else {
				clauses.push(local);
			}
		}
		return clauses.length
			? Prisma.sql`WHERE ${Prisma.join(clauses, ' AND ')}`
			: Prisma.empty;
	}

	private localSearch(search: string): Prisma.Sql {
		const pattern = `%${search.replace(/[\\%_]/g, value => `\\${value}`)}%`;
		return Prisma.sql`(
			id ILIKE ${pattern} ESCAPE '\\' OR
			name ILIKE ${pattern} ESCAPE '\\' OR
			public_key ILIKE ${pattern} ESCAPE '\\' OR
			install_domain ILIKE ${pattern} ESCAPE '\\' OR
			user_id ILIKE ${pattern} ESCAPE '\\'
		)`;
	}

	private parseFilters(input: {
		type?: string;
		isActive?: string;
		plan?: string;
		search?: string;
	}): MonitoringFilters {
		let type: WidgetType | undefined;
		if (input.type?.trim()) {
			const value = input.type.trim().toUpperCase();
			if (!Object.values(WidgetType).includes(value as WidgetType)) {
				throw new BadRequestException('Некорректный тип виджета');
			}
			type = value as WidgetType;
		}
		let isActive: boolean | undefined;
		if (input.isActive?.trim()) {
			const value = input.isActive.trim().toLowerCase();
			if (!['true', 'false'].includes(value)) {
				throw new BadRequestException('Некорректный статус виджета');
			}
			isActive = value === 'true';
		}
		const rawPlan = input.plan?.trim().toUpperCase();
		if (rawPlan && !['TRIAL', 'EASY', 'HARD', 'NONE'].includes(rawPlan)) {
			throw new BadRequestException('Некорректный тариф владельца');
		}
		const search = input.search?.trim();
		if (search && search.length > MAX_SEARCH_LENGTH) {
			throw new BadRequestException('Поисковый запрос слишком длинный');
		}
		return {
			type,
			isActive,
			plan: rawPlan as MonitoringFilters['plan'],
			search: search || undefined
		};
	}

	private async resolveOwnersForRows(
		rows: MonitoringRow[]
	): Promise<WidgetsOwnerDirectoryItem[]> {
		const ids = [...new Set(rows.map(row => row.ownerId))];
		if (!ids.length) return [];
		return this.enrichOwnersWithEntitlements(
			await this.core.resolveOwners(ids)
		);
	}

	private async enrichOwnersWithEntitlements(
		owners: WidgetsOwnerDirectoryItem[]
	): Promise<WidgetsOwnerDirectoryItem[]> {
		if (!owners.length) return owners;
		const entitlements = await this.repository
			.client()
			.widgetEntitlementProjection.findMany({
				where: {
					userId: { in: owners.map(owner => owner.id) },
					tombstoned: false
				}
			});
		const entitlementByUserId = new Map(
			entitlements.map(entitlement => [entitlement.userId, entitlement])
		);
		return owners.map(owner => {
			const entitlement = entitlementByUserId.get(owner.id);
			return {
				...owner,
				subscription:
					entitlement &&
					entitlement.plan &&
					entitlement.status &&
					entitlement.startsAt
						? {
								id: entitlement.id,
								plan: entitlement.plan,
								billingPeriod: entitlement.billingPeriod,
								status: entitlement.status,
								startsAt: entitlement.startsAt.toISOString(),
								expiresAt: entitlement.expiresAt?.toISOString() || null,
								periodResetsAt:
									entitlement.periodResetsAt?.toISOString() || null,
								createdAt: (
									entitlement.sourceCreatedAt || entitlement.appliedAt
								).toISOString(),
								updatedAt: entitlement.updatedAt.toISOString()
							}
						: null
			};
		});
	}

	private serialize(row: MonitoringRow, owner: WidgetsOwnerDirectoryItem) {
		return {
			type: row.type,
			id: row.id,
			name: row.name,
			publicKey: row.publicKey,
			isActive: row.isActive,
			installDomain: row.installDomain,
			owner: {
				id: owner.id,
				name: owner.name,
				email: owner.email,
				phone: owner.phone
			},
			ownerPlan: owner.subscription?.plan || null,
			subscriptionStatus: owner.subscription?.status || null,
			leadCount: row.leadCount,
			lastLeadAt: row.lastLeadAt?.toISOString() || null,
			createdAt: row.createdAt.toISOString(),
			updatedAt: row.updatedAt.toISOString()
		};
	}

	private mergeTop(
		target: Map<string, MonitoringRow>,
		rows: MonitoringRow[],
		window: number
	): void {
		for (const row of rows) target.set(this.rowKey(row), row);
		if (target.size <= window * 2) return;
		const retained = this.sorted([...target.values()]).slice(0, window);
		target.clear();
		for (const row of retained) target.set(this.rowKey(row), row);
	}

	private sorted(rows: MonitoringRow[]): MonitoringRow[] {
		return rows.sort((left, right) => {
			if (left.lastLeadAt && right.lastLeadAt) {
				const compared =
					right.lastLeadAt.getTime() - left.lastLeadAt.getTime();
				if (compared) return compared;
			} else if (left.lastLeadAt) return -1;
			else if (right.lastLeadAt) return 1;
			const created = right.createdAt.getTime() - left.createdAt.getTime();
			if (created) return created;
			const type = left.type.localeCompare(right.type);
			return type || left.id.localeCompare(right.id);
		});
	}

	private rowKey(row: MonitoringRow): string {
		return `${row.type}:${row.id}`;
	}

	private safeCount(value: bigint | undefined): number {
		const count = value ?? 0n;
		if (count > BigInt(Number.MAX_SAFE_INTEGER)) {
			throw new ServiceUnavailableException(
				'Monitoring count exceeds a safe integer'
			);
		}
		return Number(count);
	}

	private completeWidgetOverview(rows: WidgetOverviewRow[]) {
		const byType = new Map(rows.map(row => [row.type, row]));
		return Object.values(WidgetType).map(type => {
			const row = byType.get(type);
			return {
				type: this.overviewType(type),
				label: getWidgetDefinition(type).label,
				count: row?.count || 0,
				active: row?.active || 0,
				inactive: (row?.count || 0) - (row?.active || 0)
			};
		});
	}

	private completeLeadOverview(rows: LeadOverviewRow[]) {
		const byType = new Map(rows.map(row => [row.type, row.count]));
		return Object.values(WidgetType).map(type => ({
			type: this.overviewType(type),
			label: getWidgetDefinition(type).label,
			count: byType.get(type) || 0
		}));
	}

	private overviewType(
		type: WidgetType
	):
		| 'WHEEL'
		| 'QUIZ'
		| 'CALLBACK'
		| 'COUNTDOWN_TIMER'
		| 'STOP_OFFER'
		| 'ONLINE_CONSULTANT'
		| 'CALCULATOR' {
		return type === WidgetType.TIMER ? 'COUNTDOWN_TIMER' : type;
	}

	private serializeAdminAlert(row: WidgetAdminAlertRow) {
		const label = this.adminAlertLabel(row.widgetType);
		const common = {
			type: row.alertType,
			referenceId: row.id,
			ownerId: row.ownerId,
			alertAt: row.updatedAt.toISOString()
		};

		switch (row.alertType) {
			case 'ACTIVE_WIDGET_WITHOUT_ACCESS':
				return {
					...common,
					severity: 'HIGH' as const,
					title: 'Активный виджет без права доступа',
					message: `${label} "${row.name}" активен, но у владельца нет активной подписки`
				};
			case 'WIDGET_DOMAIN_CONFLICT':
				return {
					...common,
					severity: 'HIGH' as const,
					title: 'Домен виджета занят у разных пользователей',
					message: `Домен ${row.installDomain} используется активными виджетами разных пользователей`
				};
			case 'WIDGET_INVALID_DOMAIN':
				return {
					...common,
					severity: 'MEDIUM' as const,
					title: 'Некорректный домен виджета',
					message: `У ${label} "${row.name}" сохранён домен, который не похож на нормализованное значение: ${row.installDomain}`
				};
		}
	}

	private serializeUsage(row?: WidgetUsageRow | null) {
		return {
			widgetCount: row?.widgetCount ?? 0,
			leadCount: row?.leadCount ?? 0,
			periodKey: row?.leadPeriodKey ?? null,
			periodStartsAt: row?.leadPeriodStartsAt?.toISOString() ?? null,
			periodEndsAt: row?.leadPeriodEndsAt?.toISOString() ?? null
		};
	}

	private adminAlertLabel(type: WidgetType): string {
		switch (type) {
			case WidgetType.WHEEL:
				return 'Колесо';
			case WidgetType.QUIZ:
				return 'Квиз';
			case WidgetType.CALLBACK:
				return 'Обратный звонок';
			case WidgetType.TIMER:
				return 'Таймер';
			case WidgetType.STOP_OFFER:
				return 'Стоп-оффер';
			case WidgetType.ONLINE_CONSULTANT:
				return 'Онлайн-консультант';
			case WidgetType.CALCULATOR:
				return 'Калькулятор стоимости';
		}
	}

	private widgetAlertUnion(): Prisma.Sql {
		return Prisma.sql`
			SELECT 'WHEEL'::text AS type, id, user_id, name, is_active,
				install_domain, updated_at
			FROM widgets.widgets
			UNION ALL
			SELECT 'QUIZ', id, user_id, name, is_active, install_domain, updated_at
			FROM widgets.quizzes
			UNION ALL
			SELECT 'CALLBACK', id, user_id, name, is_active, install_domain, updated_at
			FROM widgets.callbacks
			UNION ALL
			SELECT 'TIMER', id, user_id, name, is_active, install_domain, updated_at
			FROM widgets.countdown_timers
			UNION ALL
			SELECT 'STOP_OFFER', id, user_id, name, is_active, install_domain, updated_at
			FROM widgets.stop_offers
			UNION ALL
			SELECT 'ONLINE_CONSULTANT', id, user_id, name, is_active,
				install_domain, updated_at
			FROM widgets.online_consultants
			UNION ALL
			SELECT 'CALCULATOR', id, user_id, name, is_active,
				install_domain, updated_at
			FROM widgets.calculators
		`;
	}

	private widgetUnion(withLeadDates: boolean): Prisma.Sql {
		const date = withLeadDates
			? Prisma.sql`MAX(l.created_at) AS last_lead_at`
			: Prisma.sql`NULL::timestamptz AS last_lead_at`;
		return Prisma.sql`
			SELECT 'WHEEL'::text AS type, w.id, w.name, w.public_key,
				w.is_active, w.install_domain, w.user_id,
				COUNT(l.id)::int AS lead_count, ${date}, w.created_at, w.updated_at
			FROM widgets.widgets w LEFT JOIN widgets.leads l ON l.widget_id = w.id
			GROUP BY w.id
			UNION ALL
			SELECT 'QUIZ', w.id, w.name, w.public_key, w.is_active,
				w.install_domain, w.user_id, COUNT(l.id)::int, ${date},
				w.created_at, w.updated_at
			FROM widgets.quizzes w LEFT JOIN widgets.quiz_leads l ON l.quiz_id = w.id
			GROUP BY w.id
			UNION ALL
			SELECT 'CALLBACK', w.id, w.name, w.public_key, w.is_active,
				w.install_domain, w.user_id, COUNT(l.id)::int, ${date},
				w.created_at, w.updated_at
			FROM widgets.callbacks w LEFT JOIN widgets.callback_leads l ON l.callback_id = w.id
			GROUP BY w.id
			UNION ALL
			SELECT 'TIMER', w.id, w.name, w.public_key, w.is_active,
				w.install_domain, w.user_id, COUNT(l.id)::int, ${date},
				w.created_at, w.updated_at
			FROM widgets.countdown_timers w LEFT JOIN widgets.countdown_timer_leads l ON l.countdown_timer_id = w.id
			GROUP BY w.id
			UNION ALL
			SELECT 'STOP_OFFER', w.id, w.name, w.public_key, w.is_active,
				w.install_domain, w.user_id, COUNT(l.id)::int, ${date},
				w.created_at, w.updated_at
			FROM widgets.stop_offers w LEFT JOIN widgets.stop_offer_leads l ON l.stop_offer_id = w.id
			GROUP BY w.id
			UNION ALL
			SELECT 'ONLINE_CONSULTANT', w.id, w.name, w.public_key, w.is_active,
				w.install_domain, w.user_id, COUNT(l.id)::int, ${date},
				w.created_at, w.updated_at
			FROM widgets.online_consultants w LEFT JOIN widgets.online_consultant_leads l ON l.online_consultant_id = w.id
			GROUP BY w.id
			UNION ALL
			SELECT 'CALCULATOR', w.id, w.name, w.public_key, w.is_active,
				w.install_domain, w.user_id, COUNT(l.id)::int, ${date},
				w.created_at, w.updated_at
			FROM widgets.calculators w LEFT JOIN widgets.calculator_leads l ON l.calculator_id = w.id
			GROUP BY w.id
		`;
	}

	private leadUnion(): Prisma.Sql {
		return Prisma.sql`
			SELECT 'WHEEL'::text AS type, l.id, w.user_id, w.name AS source_name,
				l.contact, l.phone, l.email, l.url, l.bonus AS detail, l.created_at
			FROM widgets.leads l JOIN widgets.widgets w ON w.id = l.widget_id
			UNION ALL
			SELECT 'QUIZ', l.id, w.user_id, w.name, l.contact, l.phone, l.email,
				l.url, l.result, l.created_at
			FROM widgets.quiz_leads l JOIN widgets.quizzes w ON w.id = l.quiz_id
			UNION ALL
			SELECT 'CALLBACK', l.id, w.user_id, w.name, NULL::text, l.phone,
				NULL::text, l.url, l.time_slot, l.created_at
			FROM widgets.callback_leads l JOIN widgets.callbacks w ON w.id = l.callback_id
			UNION ALL
			SELECT 'TIMER', l.id, w.user_id, w.name, NULL::text, l.phone,
				l.email, l.url, NULL::text, l.created_at
			FROM widgets.countdown_timer_leads l JOIN widgets.countdown_timers w ON w.id = l.countdown_timer_id
			UNION ALL
			SELECT 'STOP_OFFER', l.id, w.user_id, w.name, NULL::text, l.phone,
				l.email, l.url, NULL::text, l.created_at
			FROM widgets.stop_offer_leads l JOIN widgets.stop_offers w ON w.id = l.stop_offer_id
			UNION ALL
			SELECT 'ONLINE_CONSULTANT', l.id, w.user_id, w.name, NULL::text,
				l.phone, l.email, l.url, l.action_label, l.created_at
			FROM widgets.online_consultant_leads l JOIN widgets.online_consultants w ON w.id = l.online_consultant_id
			UNION ALL
			SELECT 'CALCULATOR', l.id, w.user_id, w.name, l.contact, l.phone,
				l.email, l.url, l.calculated_price::text, l.created_at
			FROM widgets.calculator_leads l JOIN widgets.calculators w ON w.id = l.calculator_id
		`;
	}
}
