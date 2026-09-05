import {
	ConflictException,
	ForbiddenException,
	Injectable,
	NotFoundException,
	ServiceUnavailableException
} from '@nestjs/common';
import {
	Prisma,
	WidgetEntitlementProjection,
	WincrmConnector,
	WincrmTransferIntent,
	WidgetsOutboxExchange
} from '@prisma/widgets-client';
import { createHash, randomUUID } from 'node:crypto';
import {
	WidgetsDomainRepository,
	WidgetLeadRecord
} from '../domain/widgets-domain.repository';
import { WidgetEntity, WidgetType } from '../domain/widgets-domain.types';
import { WidgetsPrismaService } from '../prisma/widgets-prisma.service';
import {
	WidgetsWincrmBillingClient,
	WidgetsWincrmConfig
} from './widgets-wincrm.config';
import {
	assertTransferEvent,
	ConfigureConnector,
	identifier,
	iso,
	LeadWidgetType,
	SNAPSHOT_SKIP_REASONS,
	SnapshotSkipReason,
	TransferEvent,
	TransferReason,
	version,
	WidgetsEligibility,
	WINCRM_TRANSFER_EVENT,
	widgetType
} from './widgets-wincrm.contract';
import {
	assertLeadSnapshot,
	captureLeadSnapshot,
	LeadSnapshot
} from './widgets-wincrm-snapshot';

const TABLES: Record<
	LeadWidgetType,
	{ widget: string; lead: string; parent: string }
> = {
	WHEEL: { widget: 'widgets', lead: 'leads', parent: 'widget_id' },
	QUIZ: { widget: 'quizzes', lead: 'quiz_leads', parent: 'quiz_id' },
	CALLBACK: {
		widget: 'callbacks',
		lead: 'callback_leads',
		parent: 'callback_id'
	},
	TIMER: {
		widget: 'countdown_timers',
		lead: 'countdown_timer_leads',
		parent: 'countdown_timer_id'
	},
	STOP_OFFER: {
		widget: 'stop_offers',
		lead: 'stop_offer_leads',
		parent: 'stop_offer_id'
	},
	CALCULATOR: {
		widget: 'calculators',
		lead: 'calculator_leads',
		parent: 'calculator_id'
	}
};
type TransferBinding = {
	eventId: string;
	connectorId: string;
	generation: number;
	workspaceId: string;
	sourceId: string;
};
const json = (value: unknown) =>
	JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject;
const conflict = (code: string): never => {
	throw new ConflictException({ code });
};

export function connectorView(item: WincrmConnector) {
	return {
		id: item.id,
		workspaceId: item.workspaceId,
		sourceId: item.sourceId,
		ownerSubject: item.ownerSubject,
		widgetType: item.widgetType,
		widgetId: item.widgetId,
		controlVersion: item.controlVersion,
		generation: item.generation,
		enabled: item.enabled,
		enabledAt: item.enabledAt?.toISOString() ?? null,
		createdAt: item.createdAt.toISOString(),
		updatedAt: item.updatedAt.toISOString()
	};
}

@Injectable()
export class WidgetsWincrmService {
	constructor(
		private readonly prisma: WidgetsPrismaService,
		private readonly repository: WidgetsDomainRepository,
		private readonly config: WidgetsWincrmConfig,
		private readonly billing: WidgetsWincrmBillingClient
	) {}

	async readiness(): Promise<void> {
		if (!this.config.enabled) return;
		await this.prisma
			.$queryRaw`SELECT id, control_version, generation, enabled FROM widgets.wincrm_connectors LIMIT 0`;
		await this.prisma
			.$queryRaw`SELECT command_id, request_hash, response FROM widgets.wincrm_connector_commands LIMIT 0`;
		await this.prisma
			.$queryRaw`SELECT id, event_id, original_subscription_id, original_deadline, payload FROM widgets.wincrm_transfer_intents LIMIT 0`;
	}

	async candidates(ownerSubject: string, page: number, pageSize: number) {
		this.assertApi();
		const eligibility = await this.billing.eligibility(ownerSubject);
		// Identifiers below are closed service-owned constants, never request interpolation.
		const union = Prisma.join(
			Object.entries(TABLES).map(
				([type, tables]) =>
					Prisma.sql`SELECT ${type}::text AS "widgetType", id, name, is_active AS "isActive", published_version AS "publishedVersion", created_at AS "createdAt" FROM ${Prisma.raw(`widgets.${tables.widget}`)} WHERE user_id = ${ownerSubject}`
			),
			' UNION ALL '
		);
		const result = await this.prisma.$transaction(
			async tx => {
				const totals = await tx.$queryRaw<Array<{ total: bigint }>>(
					Prisma.sql`SELECT count(*) AS total FROM (${union}) AS candidates`
				);
				const rows = await tx.$queryRaw<
					Array<{
						widgetType: LeadWidgetType;
						id: string;
						name: string;
						isActive: boolean;
						publishedVersion: number;
						createdAt: Date;
					}>
				>(
					Prisma.sql`SELECT * FROM (${union}) AS candidates ORDER BY "createdAt" DESC, "widgetType", id LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`
				);
				const connections = rows.length
					? await tx.wincrmConnector.findMany({
							where: {
								ownerSubject,
								enabled: true,
								OR: rows.map(row => ({
									widgetType: row.widgetType,
									widgetId: row.id
								}))
							}
						})
					: [];
				return {
					total: Number(totals[0].total),
					items: rows.map(row => {
						const connector = connections.find(
							item =>
								item.widgetType === row.widgetType &&
								item.widgetId === row.id
						);
						return {
							widgetType: row.widgetType,
							widgetId: row.id,
							name: row.name,
							isActive: row.isActive,
							publishedVersion: row.publishedVersion,
							createdAt: row.createdAt.toISOString(),
							connector: connector
								? {
										id: connector.id,
										workspaceId: connector.workspaceId,
										sourceId: connector.sourceId,
										controlVersion: connector.controlVersion,
										generation: connector.generation,
										enabled: connector.enabled
									}
								: null
						};
					})
				};
			},
			{ isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }
		);
		return {
			schemaVersion: 1 as const,
			ownerSubject,
			page,
			pageSize,
			total: result.total,
			eligibility,
			items: result.items
		};
	}

	async configure(connectorId: string, input: ConfigureConnector) {
		this.assertApi();
		// This call must never be made inside the Widgets business transaction.
		const eligibility = input.enabled
			? await this.billing.eligibility(input.ownerSubject)
			: null;
		if (eligibility && !eligibility.eligible)
			throw new ForbiddenException({
				code: 'widgets_wincrm_subscription_required'
			});
		const requestHash = createHash('sha256')
			.update(
				JSON.stringify({ connectorId, caller: 'crm-intake', ...input })
			)
			.digest('hex');
		return this.commandTransaction(async tx => {
			await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`widgets:wincrm-command:${input.commandId}`}, 0))::text`;
			await this.lockWidget(tx, input.widgetType, input.widgetId);
			const receipt = await tx.wincrmConnectorCommand.findUnique({
				where: { commandId: input.commandId }
			});
			if (
				receipt &&
				(receipt.requestHash !== requestHash ||
					receipt.caller !== 'crm-intake' ||
					receipt.connectorId !== connectorId ||
					receipt.ownerSubject !== input.ownerSubject ||
					receipt.workspaceId !== input.workspaceId ||
					receipt.sourceId !== input.sourceId)
			)
				conflict('widgets_wincrm_command_conflict');
			if (input.enabled) {
				await this.assertOwnedAvailable(
					tx,
					input.widgetType,
					input.widgetId,
					input.ownerSubject
				);
				this.assertFresh(eligibility!);
			}
			if (receipt) return receipt.response;
			const current = await tx.wincrmConnector.findUnique({
				where: { id: connectorId }
			});
			if (
				current &&
				(current.ownerSubject !== input.ownerSubject ||
					current.workspaceId !== input.workspaceId ||
					current.sourceId !== input.sourceId ||
					current.widgetType !== input.widgetType ||
					current.widgetId !== input.widgetId)
			)
				conflict('widgets_wincrm_binding_conflict');
			if (current && input.controlVersion < current.controlVersion)
				conflict('widgets_wincrm_control_stale');
			if (
				current &&
				input.controlVersion === current.controlVersion &&
				(input.generation !== current.generation ||
					input.enabled !== current.enabled)
			)
				conflict('widgets_wincrm_control_conflict');
			if (
				current &&
				(input.generation < current.generation ||
					(!current.enabled &&
						input.enabled &&
						input.generation <= current.generation))
			)
				conflict('widgets_wincrm_generation_conflict');
			if (input.enabled) {
				const other = await tx.wincrmConnector.findFirst({
					where: {
						widgetType: input.widgetType,
						widgetId: input.widgetId,
						enabled: true,
						NOT: { id: connectorId }
					},
					select: { id: true }
				});
				if (other) conflict('widgets_wincrm_widget_already_connected');
			}
			const enabledAt = input.enabled
				? !current?.enabled || current.generation !== input.generation
					? new Date()
					: current.enabledAt
				: null;
			const saved = current
				? current.controlVersion === input.controlVersion
					? current
					: await tx.wincrmConnector.update({
							where: { id: connectorId },
							data: {
								controlVersion: input.controlVersion,
								generation: input.generation,
								enabled: input.enabled,
								enabledAt
							}
						})
				: await tx.wincrmConnector.create({
						data: {
							id: connectorId,
							workspaceId: input.workspaceId,
							sourceId: input.sourceId,
							ownerSubject: input.ownerSubject,
							widgetType: input.widgetType,
							widgetId: input.widgetId,
							controlVersion: input.controlVersion,
							generation: input.generation,
							enabled: input.enabled,
							enabledAt
						}
					});
			const response = {
				schemaVersion: 1 as const,
				connector: connectorView(saved)
			};
			await tx.wincrmConnectorCommand.create({
				data: {
					commandId: input.commandId,
					connectorId,
					workspaceId: input.workspaceId,
					sourceId: input.sourceId,
					ownerSubject: input.ownerSubject,
					caller: 'crm-intake',
					requestHash,
					response: json(response)
				}
			});
			if (eligibility) this.assertFresh(eligibility);
			return json(response);
		});
	}

	/** Runs only within withLeadCreation: owner quota lock precedes this widget lock. */
	async capture(
		tx: Prisma.TransactionClient,
		input: {
			type: WidgetType;
			widget: WidgetEntity;
			lead: WidgetLeadRecord;
			contactName: unknown;
			config: Record<string, unknown>;
			entitlement: WidgetEntitlementProjection;
		}
	): Promise<void> {
		if (!this.config.enabled || input.type === WidgetType.AI_CONSULTANT)
			return;
		await this.lockWidget(tx, input.type, input.widget.id);
		const connector = await tx.wincrmConnector.findFirst({
			where: {
				widgetType: input.type,
				widgetId: input.widget.id,
				ownerSubject: input.widget.userId,
				enabled: true
			}
		});
		if (!connector) return;
		const period = this.sourcePeriod(
			input.entitlement,
			input.widget.userId,
			input.lead.createdAt
		);
		const mapped = captureLeadSnapshot({ ...input, type: input.type });
		const reason: SnapshotSkipReason | null =
			period.reason ??
			(!connector.enabledAt || input.lead.createdAt < connector.enabledAt
				? 'BEFORE_ACTIVATION'
				: mapped.state === 'SKIPPED'
					? mapped.reason
					: null);
		const payload =
			!reason && mapped.state === 'READY' ? mapped.payload : null;
		const id = randomUUID();
		const eventId = randomUUID();
		const saved = await tx.wincrmTransferIntent.create({
			data: {
				id,
				eventId,
				connectorId: connector.id,
				workspaceId: connector.workspaceId,
				sourceId: connector.sourceId,
				generation: connector.generation,
				widgetType: input.type,
				widgetId: input.widget.id,
				leadId: input.lead.id,
				ownerSubject: input.widget.userId,
				...period.snapshot,
				leadCreatedAt: input.lead.createdAt,
				state: payload ? 'READY' : 'SKIPPED',
				reason,
				payload: payload ? json(payload) : Prisma.DbNull
			}
		});
		const event: TransferEvent = {
			schemaVersion: 1,
			eventType: WINCRM_TRANSFER_EVENT,
			eventId,
			occurredAt: input.lead.createdAt.toISOString(),
			transferId: id,
			connectorId: connector.id,
			generation: connector.generation,
			workspaceId: connector.workspaceId,
			sourceId: connector.sourceId,
			originalSubscriptionId: saved.originalSubscriptionId,
			originalSubscriptionVersion: saved.originalSubscriptionVersion,
			originalPeriodStartsAt:
				saved.originalPeriodStartsAt?.toISOString() ?? null,
			originalDeadline: saved.originalDeadline?.toISOString() ?? null
		};
		assertTransferEvent(event, eventId);
		await tx.widgetsOutboxEvent.create({
			data: {
				messageId: eventId,
				deduplicationKey: `wincrm-transfer:${id}`,
				exchange: WidgetsOutboxExchange.EVENTS,
				eventType: WINCRM_TRANSFER_EVENT,
				routingKey: WINCRM_TRANSFER_EVENT,
				payload: json(event),
				headers: {},
				aggregateType: 'wincrm-transfer',
				aggregateId: id,
				aggregateVersion: 1n
			}
		});
	}

	async context(transferId: string, binding: TransferBinding) {
		this.assertApi();
		const transfer = await this.prisma.wincrmTransferIntent.findUnique({
			where: { id: transferId }
		});
		if (
			!transfer ||
			Object.entries(binding).some(
				([key, value]) =>
					transfer[key as keyof WincrmTransferIntent] !== value
			)
		)
			throw new NotFoundException({
				code: 'widgets_wincrm_transfer_not_found'
			});
		const response = (
			reason: TransferReason,
			payload: LeadSnapshot | null = null,
			until?: string
		) => {
			const checkedAt = new Date().toISOString();
			return {
				schemaVersion: 1 as const,
				transferId,
				...binding,
				deliver: reason === 'READY',
				reason,
				checkedAt,
				validUntil: until ?? checkedAt,
				payload
			};
		};
		const initialConnector = await this.prisma.wincrmConnector.findUnique({
			where: { id: transfer.connectorId }
		});
		this.assertTransferBinding(transfer, initialConnector);
		if (!initialConnector!.enabled) return response('CONNECTOR_DISABLED');
		if (initialConnector!.generation !== transfer.generation)
			return response('GENERATION_CHANGED');
		if (transfer.state === 'SKIPPED') {
			if (
				!SNAPSHOT_SKIP_REASONS.includes(
					transfer.reason as SnapshotSkipReason
				) ||
				transfer.payload !== null
			)
				throw new ServiceUnavailableException({
					code: 'widgets_wincrm_context_invalid'
				});
			return response(transfer.reason as SnapshotSkipReason);
		}
		if (
			transfer.state !== 'READY' ||
			!transfer.originalDeadline ||
			!transfer.originalPeriodStartsAt ||
			!transfer.originalSubscriptionId ||
			transfer.originalSubscriptionVersion === null
		)
			throw new ServiceUnavailableException({
				code: 'widgets_wincrm_context_invalid'
			});
		if (transfer.originalDeadline.getTime() <= Date.now())
			return response('PERIOD_EXPIRED');
		const eligibility = await this.billing.eligibility(
			transfer.ownerSubject
		);
		if (!eligibility.eligible) return response('BILLING_INELIGIBLE');
		if (
			eligibility.subscriptionId !== transfer.originalSubscriptionId ||
			!eligibility.startsAt ||
			Date.parse(eligibility.startsAt) > transfer.leadCreatedAt.getTime()
		)
			return response('BILLING_PERIOD_CHANGED');
		if (
			BigInt(eligibility.version!) <
			BigInt(transfer.originalSubscriptionVersion)
		)
			throw new ServiceUnavailableException({
				code: 'widgets_wincrm_context_stale'
			});
		// Re-read local desired state after HTTP. This is a bounded proof, not distributed revocation atomicity.
		const localReason = await this.prisma.$transaction(async tx => {
			await this.lockWidget(
				tx,
				widgetType(transfer.widgetType),
				transfer.widgetId
			);
			const connector = await tx.wincrmConnector.findUnique({
				where: { id: transfer.connectorId }
			});
			this.assertTransferBinding(transfer, connector);
			if (!connector || !connector.enabled)
				return 'CONNECTOR_DISABLED' as const;
			if (connector.generation !== transfer.generation)
				return 'GENERATION_CHANGED' as const;
			const type = widgetType(transfer.widgetType);
			const widget = await this.repository.findById(
				type,
				transfer.widgetId,
				tx
			);
			const owner = await tx.widgetOwnerProjection.findUnique({
				where: { userId: transfer.ownerSubject }
			});
			if (
				!widget ||
				widget.userId !== transfer.ownerSubject ||
				!widget.isActive ||
				!widget.publishedAt ||
				!owner ||
				owner.status !== 'ACTIVE' ||
				owner.tombstoned ||
				owner.deletedAt
			)
				return 'WIDGET_UNAVAILABLE' as const;
			const tables = TABLES[type];
			const lead = await tx.$queryRaw<Array<{ id: string }>>(
				Prisma.sql`SELECT id FROM ${Prisma.raw(`widgets.${tables.lead}`)} WHERE id = ${transfer.leadId} AND ${Prisma.raw(tables.parent)} = ${transfer.widgetId} LIMIT 1`
			);
			return lead.length ? null : ('LEAD_UNAVAILABLE' as const);
		});
		if (localReason) return response(localReason);
		try {
			assertLeadSnapshot(transfer.payload);
			if (
				transfer.payload.widget.id !== transfer.widgetId ||
				transfer.payload.widget.type !== transfer.widgetType ||
				transfer.payload.lead.id !== transfer.leadId ||
				transfer.payload.lead.createdAt !==
					transfer.leadCreatedAt.toISOString()
			)
				throw new Error();
		} catch {
			throw new ServiceUnavailableException({
				code: 'widgets_wincrm_context_invalid'
			});
		}
		const until = Math.min(
			Date.parse(eligibility.validUntil),
			transfer.originalDeadline.getTime()
		);
		if (until <= Date.now())
			throw new ServiceUnavailableException({
				code: 'widgets_wincrm_context_stale'
			});
		return response(
			'READY',
			transfer.payload,
			new Date(until).toISOString()
		);
	}

	private assertApi() {
		if (!this.config.apiEnabled) throw new NotFoundException();
	}
	private assertFresh(value: WidgetsEligibility) {
		if (
			!value.eligible ||
			Date.parse(value.validUntil) <= Date.now() ||
			!value.expiresAt ||
			Date.parse(value.expiresAt) <= Date.now()
		)
			throw new ServiceUnavailableException({
				code: 'widgets_wincrm_eligibility_stale'
			});
	}
	private async lockWidget(
		tx: Prisma.TransactionClient,
		type: LeadWidgetType,
		id: string
	) {
		await this.boundLocks(tx);
		await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`widgets:wincrm-widget:${type}:${id}`}, 0))::text`;
	}
	private async boundLocks(tx: Prisma.TransactionClient) {
		await tx.$executeRaw`SET LOCAL lock_timeout = '1500ms'`;
		await tx.$executeRaw`SET LOCAL statement_timeout = '5000ms'`;
	}
	private assertTransferBinding(
		transfer: WincrmTransferIntent,
		connector: WincrmConnector | null
	): void {
		if (
			!connector ||
			connector.id !== transfer.connectorId ||
			connector.workspaceId !== transfer.workspaceId ||
			connector.sourceId !== transfer.sourceId ||
			connector.ownerSubject !== transfer.ownerSubject ||
			connector.widgetType !== transfer.widgetType ||
			connector.widgetId !== transfer.widgetId
		)
			throw new ServiceUnavailableException({
				code: 'widgets_wincrm_context_invalid'
			});
	}
	private async assertOwnedAvailable(
		tx: Prisma.TransactionClient,
		type: LeadWidgetType,
		id: string,
		ownerSubject: string
	) {
		const rows = await tx.$queryRaw<Array<{ id: string }>>(
			Prisma.sql`SELECT id FROM ${Prisma.raw(`widgets.${TABLES[type].widget}`)} WHERE id = ${id} AND user_id = ${ownerSubject} AND is_active = true AND published_version > 0 AND published_at IS NOT NULL FOR SHARE`
		);
		const owner = await tx.widgetOwnerProjection.findUnique({
			where: { userId: ownerSubject }
		});
		if (
			!rows.length ||
			!owner ||
			owner.status !== 'ACTIVE' ||
			owner.tombstoned ||
			owner.deletedAt
		)
			throw new ForbiddenException({
				code: 'widgets_wincrm_widget_unavailable'
			});
	}
	private sourcePeriod(
		entitlement: WidgetEntitlementProjection,
		owner: string,
		createdAt: Date
	) {
		const snapshot = {
			originalSubscriptionId: null as string | null,
			originalSubscriptionVersion: null as string | null,
			originalPeriodStartsAt: null as Date | null,
			originalDeadline: null as Date | null
		};
		try {
			// Projection id is Billing's Subscription.id (CUID); there is no local wrapper id.
			snapshot.originalSubscriptionId = identifier(entitlement.id);
			snapshot.originalSubscriptionVersion = version(
				entitlement.aggregateVersion.toString()
			);
			if (entitlement.startsAt) {
				iso(entitlement.startsAt.toISOString());
				snapshot.originalPeriodStartsAt = entitlement.startsAt;
			}
			if (entitlement.expiresAt) {
				iso(entitlement.expiresAt.toISOString());
				snapshot.originalDeadline = entitlement.expiresAt;
			}
			if (
				entitlement.userId !== owner ||
				entitlement.tombstoned ||
				entitlement.status !== 'ACTIVE' ||
				!['EASY', 'HARD'].includes(entitlement.plan || '')
			)
				return { snapshot, reason: 'SOURCE_PERIOD_INELIGIBLE' as const };
			if (
				!snapshot.originalPeriodStartsAt ||
				!snapshot.originalDeadline ||
				snapshot.originalPeriodStartsAt > createdAt ||
				snapshot.originalDeadline <= createdAt
			)
				return { snapshot, reason: 'SOURCE_PERIOD_INVALID' as const };
			return { snapshot, reason: null };
		} catch {
			return {
				snapshot: {
					originalSubscriptionId: null,
					originalSubscriptionVersion: null,
					originalPeriodStartsAt: null,
					originalDeadline: null
				},
				reason: 'SOURCE_PERIOD_INVALID' as const
			};
		}
	}
	private async commandTransaction<T>(
		operation: (tx: Prisma.TransactionClient) => Promise<T>
	): Promise<T> {
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				return await this.prisma.$transaction(
					async tx => {
						await this.boundLocks(tx);
						return operation(tx);
					},
					{
						isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
						maxWait: 5000,
						timeout: 10000
					}
				);
			} catch (error) {
				if (
					error instanceof Prisma.PrismaClientKnownRequestError &&
					['P2034', 'P2002'].includes(error.code)
				) {
					if (attempt < 2) continue;
					conflict('widgets_wincrm_concurrent_command');
				}
				throw error;
			}
		}
		throw new ServiceUnavailableException({
			code: 'widgets_wincrm_command_unavailable'
		});
	}
}
