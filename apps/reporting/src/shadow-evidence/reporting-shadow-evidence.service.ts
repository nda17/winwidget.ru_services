import { CoreInternalClient } from '../internal/core-internal.client';
import { ReportingPrismaService } from '../prisma/reporting-prisma.service';
import {
	REPORTING_PROJECTION_STREAMS,
	REPORTING_WIDGET_TYPES,
	BillingPaymentState,
	BillingSubscriptionState,
	IdentityUserState,
	LeadState,
	ReportingProjectionStream,
	ReportingSourceEvent,
	ReportingSourceEventType,
	ReportingWidgetType,
	WidgetState,
	parseReportingSourceEvent,
	sourceEventTypeToStream
} from '../projections/reporting-event.contract';
import {
	normalizeLegacyPaymentAmount,
	reportingProjectionStateHash
} from '../projections/projection.service';
import {
	REPORTING_SHADOW_CHECK_NAMES,
	ReportingShadowCheck,
	ReportingShadowEvidence,
	ReportingShadowJson,
	canonicalReportingShadowJson,
	parseReportingShadowEvidence,
	reportingShadowSha256
} from './reporting-shadow-evidence.contract';
import { Injectable } from '@nestjs/common';
import { Prisma, ReportingBackfillStatus } from '@prisma/reporting-client';
import { createHash } from 'node:crypto';

const MAX_LINE_BYTES = 512 * 1024;
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024 * 1024;
const PAGE_SIZE = 500;
const DECIMAL_PATTERN = /^(0|[1-9][0-9]{0,64})$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REVISION_PATTERN = /^[0-9a-f]{40}$/;
const IMAGE_ID_PATTERN = /^sha256:[0-9a-f]{64}$/;
const VALID_EVENT_ID = '00000000-0000-4000-8000-000000000000';
const UINT256_MODULUS = 1n << 256n;

interface SnapshotHeader {
	snapshotId: string;
	watermarks: Record<ReportingProjectionStream, string>;
}

interface CoreSnapshotResult {
	snapshotId: string;
	sha256: string;
	recordCount: number;
	watermarks: Record<ReportingProjectionStream, string>;
	values: ComparisonValues;
}

interface TargetSnapshotResult {
	database: string;
	role: string;
	transactionSnapshotSha256: string;
	watermarks: Record<ReportingProjectionStream, string>;
	values: ComparisonValues;
}

interface ComparisonValues {
	counts: ReportingShadowJson;
	totals: ReportingShadowJson;
	periods: ReportingShadowJson;
	checksums: ReportingShadowJson;
}

interface ShadowConfig {
	revision: string;
	imageId: string;
	coreSystemIdentifier: string;
	reportingSystemIdentifier: string;
	backfillSnapshotId: string;
	backfillSha256: string;
}

type ProjectionState = Exclude<ReportingSourceEvent['state'], null>;

export class ProjectionComparisonAccumulator {
	private readonly manifestXor = Buffer.alloc(32);
	private manifestSum = 0n;
	private manifestCount = 0;
	private readonly streamCounts = this.zeroStreams();
	private readonly widgetCounts = this.zeroWidgets();
	private readonly leadCounts = this.zeroWidgets();
	private readonly paymentStatus = {
		PENDING: 0,
		SUCCEEDED: 0,
		CANCELLED: 0,
		EXPIRED: 0
	};
	private readonly subscriptionStatus = {
		ACTIVE: 0,
		EXPIRED: 0,
		CANCELLED: 0
	};
	private activeUsers = 0;
	private usersWithoutContacts = 0;
	private succeededPayments = 0;
	private succeededRevenue = 0;
	private activeSubscriptions = 0;
	private activeWidgets = 0;
	private totalLeads = 0;
	private usersCreated30d = 0;
	private succeededPayments30d = 0;
	private cancelledPayments30d = 0;
	private revenue30d = 0;
	private revenueCurrentMonth = 0;
	private leads30d = 0;
	private leadsPrevious30d = 0;
	private leadsToday = 0;
	private readonly leadDays: Record<string, number>;
	private readonly revenueMonths: Record<
		string,
		{ payments: number; revenue: number }
	>;
	private readonly asOfMs: number;
	private readonly todayStartMs: number;
	private readonly tomorrowStartMs: number;
	private readonly last30DaysStartMs: number;
	private readonly previous30DaysStartMs: number;
	private readonly currentMonthStartMs: number;
	private readonly firstRevenueMonthStartMs: number;

	constructor(private readonly asOf: Date) {
		this.asOfMs = asOf.getTime();
		this.todayStartMs = Date.UTC(
			asOf.getUTCFullYear(),
			asOf.getUTCMonth(),
			asOf.getUTCDate()
		);
		this.tomorrowStartMs = this.todayStartMs + 24 * 60 * 60 * 1000;
		this.last30DaysStartMs = this.asOfMs - 30 * 24 * 60 * 60 * 1000;
		this.previous30DaysStartMs = this.asOfMs - 60 * 24 * 60 * 60 * 1000;
		this.currentMonthStartMs = Date.UTC(
			asOf.getUTCFullYear(),
			asOf.getUTCMonth(),
			1
		);
		this.firstRevenueMonthStartMs = Date.UTC(
			asOf.getUTCFullYear(),
			asOf.getUTCMonth() - 11,
			1
		);
		this.leadDays = Object.fromEntries(
			Array.from({ length: 30 }, (_, index) => {
				const date = new Date(
					this.todayStartMs + (index - 29) * 24 * 60 * 60 * 1000
				);
				return [this.dateKey(date), 0];
			})
		);
		this.revenueMonths = Object.fromEntries(
			Array.from({ length: 12 }, (_, index) => {
				const date = new Date(
					Date.UTC(
						asOf.getUTCFullYear(),
						asOf.getUTCMonth() + index - 11,
						1
					)
				);
				return [this.monthKey(date), { payments: 0, revenue: 0 }];
			})
		);
	}

	add(event: ReportingSourceEvent, persistedStateHash?: string): void {
		if (event.tombstone || !event.state) {
			throw new Error(
				'Shadow input must contain only active projection rows'
			);
		}
		const stream = sourceEventTypeToStream(event.eventType);
		const stateHash = reportingProjectionStateHash(event);
		if (persistedStateHash && persistedStateHash !== stateHash) {
			throw new Error(
				`Reporting stored state hash differs from live row stream=${stream}`
			);
		}
		this.addManifest({
			stream,
			aggregateId: event.aggregateId,
			aggregateVersion: event.aggregateVersion,
			sourceSequence: event.sourceSequence,
			stateHash
		});
		this.streamCounts[stream] += 1;
		this.addMetrics(event);
	}

	finish(): ComparisonValues {
		const xor = this.manifestXor.toString('hex');
		const sum = this.manifestSum.toString(16).padStart(64, '0');
		const manifestSha256 = reportingShadowSha256({
			count: this.manifestCount,
			sum,
			xor
		});
		return {
			counts: {
				streams: this.streamCounts,
				widgetsByType: this.widgetCounts,
				leadsByType: this.leadCounts,
				paymentsByStatus: this.paymentStatus,
				subscriptionsByStatus: this.subscriptionStatus
			},
			totals: {
				activeUsers: this.activeUsers,
				usersWithoutContacts: this.usersWithoutContacts,
				succeededPayments: this.succeededPayments,
				succeededRevenue: this.cleanNumber(this.succeededRevenue),
				activeSubscriptions: this.activeSubscriptions,
				activeWidgets: this.activeWidgets,
				totalLeads: this.totalLeads
			},
			periods: {
				asOf: this.asOf.toISOString(),
				usersCreated30d: this.usersCreated30d,
				succeededPayments30d: this.succeededPayments30d,
				cancelledPayments30d: this.cancelledPayments30d,
				revenue30d: this.cleanNumber(this.revenue30d),
				revenueCurrentMonth: this.cleanNumber(this.revenueCurrentMonth),
				leads30d: this.leads30d,
				leadsPrevious30d: this.leadsPrevious30d,
				leadsToday: this.leadsToday,
				leadDays: this.leadDays,
				revenueMonths: Object.fromEntries(
					Object.entries(this.revenueMonths).map(([key, value]) => [
						key,
						{
							payments: value.payments,
							revenue: this.cleanNumber(value.revenue)
						}
					])
				)
			},
			checksums: {
				activeRecordCount: this.manifestCount,
				manifestSha256
			}
		};
	}

	private addMetrics(event: ReportingSourceEvent): void {
		const state = event.state as ProjectionState;
		if (event.eventType === 'identity.user.changed.v1') {
			const user = state as IdentityUserState;
			if (!user.deletedAt) {
				this.activeUsers += 1;
				if (!user.hasEmailIdentity && !user.hasPhoneIdentity) {
					this.usersWithoutContacts += 1;
				}
			}
			if (
				!user.deletedAt &&
				new Date(user.createdAt).getTime() >= this.last30DaysStartMs
			) {
				this.usersCreated30d += 1;
			}
			return;
		}
		if (event.eventType === 'billing.payment.changed.v1') {
			const payment = state as BillingPaymentState;
			this.paymentStatus[payment.status] += 1;
			const updatedAt = new Date(payment.updatedAt).getTime();
			const amount = normalizeLegacyPaymentAmount(payment.amount);
			if (payment.status === 'SUCCEEDED') {
				this.succeededPayments += 1;
				if (amount !== null) this.succeededRevenue += amount;
				if (updatedAt >= this.last30DaysStartMs) {
					this.succeededPayments30d += 1;
					if (amount !== null) this.revenue30d += amount;
				}
				if (updatedAt >= this.currentMonthStartMs && amount !== null) {
					this.revenueCurrentMonth += amount;
				}
				if (updatedAt >= this.firstRevenueMonthStartMs) {
					const month =
						this.revenueMonths[this.monthKey(new Date(updatedAt))];
					if (month) {
						month.payments += 1;
						if (amount !== null) month.revenue += amount;
					}
				}
			} else if (
				payment.status === 'CANCELLED' &&
				updatedAt >= this.last30DaysStartMs
			) {
				this.cancelledPayments30d += 1;
			}
			return;
		}
		if (event.eventType === 'billing.subscription.changed.v1') {
			const subscription = state as BillingSubscriptionState;
			this.subscriptionStatus[subscription.status] += 1;
			if (subscription.status === 'ACTIVE') this.activeSubscriptions += 1;
			return;
		}
		if (event.eventType === 'widgets.widget.changed.v1') {
			const widget = state as WidgetState;
			this.widgetCounts[widget.widgetType] += 1;
			if (widget.isActive) this.activeWidgets += 1;
			return;
		}
		if (event.eventType === 'widgets.lead.changed.v1') {
			const lead = state as LeadState;
			this.leadCounts[lead.widgetType] += 1;
			this.totalLeads += 1;
			const createdAt = new Date(lead.createdAt).getTime();
			if (createdAt >= this.last30DaysStartMs) this.leads30d += 1;
			if (
				createdAt >= this.previous30DaysStartMs &&
				createdAt < this.last30DaysStartMs
			) {
				this.leadsPrevious30d += 1;
			}
			if (
				createdAt >= this.todayStartMs &&
				createdAt < this.tomorrowStartMs
			) {
				this.leadsToday += 1;
			}
			const day = this.leadDays[this.dateKey(new Date(createdAt))];
			if (day !== undefined) {
				this.leadDays[this.dateKey(new Date(createdAt))] = day + 1;
			}
		}
	}

	private addManifest(value: Record<string, string>): void {
		const rowHash = createHash('sha256')
			.update(canonicalReportingShadowJson(value), 'utf8')
			.digest();
		for (let index = 0; index < rowHash.length; index += 1) {
			this.manifestXor[index] ^= rowHash[index];
		}
		this.manifestSum =
			(this.manifestSum + BigInt(`0x${rowHash.toString('hex')}`)) %
			UINT256_MODULUS;
		this.manifestCount += 1;
	}

	private zeroStreams(): Record<ReportingProjectionStream, number> {
		return Object.fromEntries(
			REPORTING_PROJECTION_STREAMS.map(stream => [stream, 0])
		) as Record<ReportingProjectionStream, number>;
	}

	private zeroWidgets(): Record<ReportingWidgetType, number> {
		return Object.fromEntries(
			REPORTING_WIDGET_TYPES.map(type => [type, 0])
		) as Record<ReportingWidgetType, number>;
	}

	private dateKey(value: Date): string {
		return value.toISOString().slice(0, 10);
	}

	private monthKey(value: Date): string {
		return value.toISOString().slice(0, 7);
	}

	private cleanNumber(value: number): number {
		return Object.is(value, -0) ? 0 : value;
	}
}

@Injectable()
export class ReportingShadowEvidenceService {
	constructor(
		private readonly core: CoreInternalClient,
		private readonly prisma: ReportingPrismaService
	) {}

	async generate(asOf = new Date()): Promise<ReportingShadowEvidence> {
		const config = this.config();
		const comparedAt = this.canonicalAsOf(asOf);
		const core = await this.collectCore(comparedAt);
		const target = await this.collectTarget(comparedAt, config);
		this.assertWatermarksEqual(core.watermarks, target.watermarks);
		const checks = this.buildChecks(core.values, target.values);
		return {
			schema: 'winwidget.reporting.shadow-evidence',
			version: 2,
			algorithm: 'projection-and-metrics-v1',
			revision: config.revision,
			imageId: config.imageId,
			comparedAt: comparedAt.toISOString(),
			periodPolicy: {
				asOf: comparedAt.toISOString(),
				dashboardTimezone: 'UTC',
				dailySummaryTimezone: 'Europe/Moscow'
			},
			source: {
				kind: 'core-postgresql',
				database: 'default_db',
				systemIdentifier: config.coreSystemIdentifier,
				snapshotId: core.snapshotId,
				snapshotSha256: core.sha256,
				recordCount: core.recordCount,
				watermarks: core.watermarks
			},
			target: {
				kind: 'reporting-postgresql',
				database: 'winwidget_reporting',
				role: 'winwidget_reporting_backup',
				systemIdentifier: config.reportingSystemIdentifier,
				backfillSnapshotId: config.backfillSnapshotId,
				backfillSha256: config.backfillSha256,
				transactionSnapshotSha256: target.transactionSnapshotSha256,
				watermarks: target.watermarks
			},
			checks
		};
	}

	async verify(input: string): Promise<ReportingShadowEvidence> {
		const evidence = parseReportingShadowEvidence(input);
		const config = this.config();
		this.assertEvidenceConfig(evidence, config);
		const asOf = this.canonicalAsOf(new Date(evidence.periodPolicy.asOf));
		const core = await this.collectCore(asOf);
		const target = await this.collectTarget(asOf, config);
		this.assertWatermarksEqual(core.watermarks, target.watermarks);
		if (
			canonicalReportingShadowJson(core.watermarks) !==
				canonicalReportingShadowJson(evidence.source.watermarks) ||
			canonicalReportingShadowJson(target.watermarks) !==
				canonicalReportingShadowJson(evidence.target.watermarks)
		) {
			throw new Error('Shadow evidence is stale: live watermarks changed');
		}
		const freshChecks = this.buildChecks(core.values, target.values);
		if (
			canonicalReportingShadowJson(freshChecks) !==
			canonicalReportingShadowJson(evidence.checks)
		) {
			throw new Error(
				'Shadow evidence is stale or differs from live data'
			);
		}
		return evidence;
	}

	private async collectCore(asOf: Date): Promise<CoreSnapshotResult> {
		const response = await this.core.openProjectionSnapshot();
		if (!response.body)
			throw new Error('Core snapshot response has no body');
		const accumulator = new ProjectionComparisonAccumulator(asOf);
		const reader = response.body.getReader();
		let pending = Buffer.alloc(0);
		let totalBytes = 0;
		let header: SnapshotHeader | null = null;
		let footer: {
			snapshotId: string;
			recordCount: number;
			sha256: string;
		} | null = null;
		let recordCount = 0;
		const hash = createHash('sha256');
		const processLine = (line: Buffer): void => {
			if (line.length > MAX_LINE_BYTES) {
				throw new Error('Core snapshot NDJSON line is too large');
			}
			const content = line.subarray(0, line.length - 1);
			if (!content.length || content.includes(0x0d)) {
				throw new Error(
					'Core snapshot must use non-empty LF-delimited NDJSON'
				);
			}
			let value: unknown;
			try {
				value = JSON.parse(
					new TextDecoder('utf-8', { fatal: true }).decode(content)
				);
			} catch {
				throw new Error('Core snapshot contains invalid UTF-8 JSON');
			}
			if (!header) {
				header = this.parseHeader(value);
				hash.update(line);
				return;
			}
			if (footer)
				throw new Error('Core snapshot contains data after footer');
			const envelope = value as Record<string, unknown>;
			if (
				value &&
				typeof value === 'object' &&
				!Array.isArray(value) &&
				envelope.kind === 'footer'
			) {
				footer = this.parseFooter(value);
				return;
			}
			const record = exactRecord(value, [
				'schemaVersion',
				'kind',
				'stream',
				'event'
			]);
			if (
				record.schemaVersion !== 1 ||
				record.kind !== 'record' ||
				typeof record.stream !== 'string' ||
				!REPORTING_PROJECTION_STREAMS.includes(
					record.stream as ReportingProjectionStream
				)
			) {
				throw new Error('Core snapshot record metadata is invalid');
			}
			const event = parseReportingSourceEvent(record.event, undefined, {
				allowZeroVersion: true
			});
			if (sourceEventTypeToStream(event.eventType) !== record.stream) {
				throw new Error(
					'Core snapshot record stream differs from eventType'
				);
			}
			accumulator.add(event);
			recordCount += 1;
			hash.update(line);
		};
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (value?.length) {
					totalBytes += value.length;
					if (totalBytes > MAX_SNAPSHOT_BYTES) {
						throw new Error('Core snapshot exceeds the 2 GiB limit');
					}
					pending = Buffer.concat([pending, Buffer.from(value)]);
					if (pending.length > MAX_LINE_BYTES && !pending.includes(0x0a)) {
						throw new Error('Core snapshot NDJSON line is too large');
					}
					let newline = pending.indexOf(0x0a);
					while (newline >= 0) {
						const line = pending.subarray(0, newline + 1);
						pending = pending.subarray(newline + 1);
						processLine(line);
						newline = pending.indexOf(0x0a);
					}
				}
				if (done) break;
			}
		} catch (error) {
			await reader.cancel().catch(() => undefined);
			throw error;
		}
		if (pending.length) {
			throw new Error('Core snapshot footer must end with LF');
		}
		const verifiedHeader = header as SnapshotHeader | null;
		const verifiedFooter = footer as {
			snapshotId: string;
			recordCount: number;
			sha256: string;
		} | null;
		if (!verifiedHeader || !verifiedFooter) {
			throw new Error('Core snapshot header or footer is missing');
		}
		const digest = hash.digest('hex');
		if (
			verifiedHeader.snapshotId !== verifiedFooter.snapshotId ||
			verifiedFooter.recordCount !== recordCount ||
			verifiedFooter.sha256 !== digest
		) {
			throw new Error('Core snapshot footer verification failed');
		}
		return {
			snapshotId: verifiedHeader.snapshotId,
			sha256: digest,
			recordCount,
			watermarks: verifiedHeader.watermarks,
			values: accumulator.finish()
		};
	}

	private collectTarget(
		asOf: Date,
		config: ShadowConfig
	): Promise<TargetSnapshotResult> {
		return this.prisma.$transaction(
			async transaction => {
				await transaction.$executeRawUnsafe('SET TRANSACTION READ ONLY');
				const [identity] = await transaction.$queryRaw<
					Array<{ database: string; role: string; snapshot: string }>
				>`SELECT current_database() AS "database", current_user AS "role", pg_current_snapshot()::TEXT AS "snapshot"`;
				if (
					identity?.database !== 'winwidget_reporting' ||
					identity.role !== 'winwidget_reporting_backup'
				) {
					throw new Error(
						'Shadow target must use the Reporting backup role'
					);
				}
				const backfill = await transaction.reportingBackfillRun.findUnique(
					{
						where: { snapshotId: config.backfillSnapshotId }
					}
				);
				if (
					!backfill ||
					backfill.status !== ReportingBackfillStatus.VERIFIED ||
					backfill.sha256?.trim() !== config.backfillSha256 ||
					backfill.expectedSha256?.trim() !== config.backfillSha256
				) {
					throw new Error(
						'Marker backfill is not checksum-verified in Reporting'
					);
				}
				const watermarks = this.emptyWatermarks();
				for (const row of await transaction.projectionWatermark.findMany({
					select: { stream: true, sourceSequence: true }
				})) {
					if (
						!REPORTING_PROJECTION_STREAMS.includes(
							row.stream as ReportingProjectionStream
						)
					) {
						throw new Error(
							'Reporting contains an unknown projection watermark'
						);
					}
					watermarks[row.stream as ReportingProjectionStream] =
						row.sourceSequence.toFixed(0);
				}
				const accumulator = new ProjectionComparisonAccumulator(asOf);
				await this.collectTargetUsers(transaction, accumulator);
				await this.collectTargetPayments(transaction, accumulator);
				await this.collectTargetSubscriptions(transaction, accumulator);
				await this.collectTargetWidgets(transaction, accumulator);
				await this.collectTargetLeads(transaction, accumulator);
				await this.collectTargetSettings(transaction, accumulator);
				return {
					database: identity.database,
					role: identity.role,
					transactionSnapshotSha256: reportingShadowSha256({
						database: identity.database,
						role: identity.role,
						snapshot: identity.snapshot
					}),
					watermarks,
					values: accumulator.finish()
				};
			},
			{
				isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
				maxWait: 5_000,
				timeout: 60 * 60 * 1000
			}
		);
	}

	private async collectTargetUsers(
		transaction: Prisma.TransactionClient,
		accumulator: ProjectionComparisonAccumulator
	): Promise<void> {
		let cursor = '';
		for (;;) {
			const rows = await transaction.identityUserProjection.findMany({
				where: { tombstoned: false, id: { gt: cursor } },
				orderBy: { id: 'asc' },
				take: PAGE_SIZE
			});
			for (const row of rows) {
				const state = {
					id: row.id,
					createdAt: this.iso(row.createdAt, 'user.createdAt'),
					updatedAt: this.iso(row.sourceUpdatedAt, 'user.sourceUpdatedAt'),
					deletedAt: row.deletedAt?.toISOString() || null,
					status: this.required(row.status, 'user.status'),
					roles: row.roles,
					hasEmailIdentity: this.requiredBoolean(
						row.hasEmailIdentity,
						'user.hasEmailIdentity'
					),
					hasPhoneIdentity: this.requiredBoolean(
						row.hasPhoneIdentity,
						'user.hasPhoneIdentity'
					),
					hasTelegramIdentity: this.requiredBoolean(
						row.hasTelegramIdentity,
						'user.hasTelegramIdentity'
					),
					loginMethodCount: this.requiredNumber(
						row.loginMethodCount,
						'user.loginMethodCount'
					)
				};
				accumulator.add(
					this.targetEvent(
						'identity.user.changed.v1',
						row.id,
						row.aggregateVersion.toFixed(0),
						row.sourceSequence.toFixed(0),
						row.sourceOccurredAt,
						state
					),
					row.stateHash.trim()
				);
				cursor = row.id;
			}
			if (rows.length < PAGE_SIZE) return;
		}
	}

	private async collectTargetPayments(
		transaction: Prisma.TransactionClient,
		accumulator: ProjectionComparisonAccumulator
	): Promise<void> {
		let cursor = '';
		for (;;) {
			const rows = await transaction.billingPaymentFact.findMany({
				where: { tombstoned: false, id: { gt: cursor } },
				orderBy: { id: 'asc' },
				take: PAGE_SIZE
			});
			for (const row of rows) {
				const state = {
					id: row.id,
					userId: this.required(row.userId, 'payment.userId'),
					amount: this.required(row.amount, 'payment.amount'),
					status: this.required(row.status, 'payment.status'),
					createdAt: this.iso(
						row.sourceCreatedAt,
						'payment.sourceCreatedAt'
					),
					updatedAt: this.iso(
						row.sourceUpdatedAt,
						'payment.sourceUpdatedAt'
					)
				};
				const normalized = normalizeLegacyPaymentAmount(state.amount);
				if (
					(row.normalizedAmount === null) !== (normalized === null) ||
					(row.normalizedAmount !== null &&
						normalized !== null &&
						!Object.is(row.normalizedAmount, normalized))
				) {
					throw new Error('Reporting normalized payment amount differs');
				}
				accumulator.add(
					this.targetEvent(
						'billing.payment.changed.v1',
						row.id,
						row.aggregateVersion.toFixed(0),
						row.sourceSequence.toFixed(0),
						row.sourceOccurredAt,
						state
					),
					row.stateHash.trim()
				);
				cursor = row.id;
			}
			if (rows.length < PAGE_SIZE) return;
		}
	}

	private async collectTargetSubscriptions(
		transaction: Prisma.TransactionClient,
		accumulator: ProjectionComparisonAccumulator
	): Promise<void> {
		let cursor = '';
		for (;;) {
			const rows =
				await transaction.billingSubscriptionProjection.findMany({
					where: { tombstoned: false, id: { gt: cursor } },
					orderBy: { id: 'asc' },
					take: PAGE_SIZE
				});
			for (const row of rows) {
				const state = {
					id: row.id,
					userId: this.required(row.userId, 'subscription.userId'),
					plan: this.required(row.plan, 'subscription.plan'),
					status: this.required(row.status, 'subscription.status'),
					expiresAt: row.expiresAt?.toISOString() || null,
					createdAt: this.iso(
						row.sourceCreatedAt,
						'subscription.sourceCreatedAt'
					)
				};
				accumulator.add(
					this.targetEvent(
						'billing.subscription.changed.v1',
						row.id,
						row.aggregateVersion.toFixed(0),
						row.sourceSequence.toFixed(0),
						row.sourceOccurredAt,
						state
					),
					row.stateHash.trim()
				);
				cursor = row.id;
			}
			if (rows.length < PAGE_SIZE) return;
		}
	}

	private async collectTargetWidgets(
		transaction: Prisma.TransactionClient,
		accumulator: ProjectionComparisonAccumulator
	): Promise<void> {
		for (const widgetType of REPORTING_WIDGET_TYPES) {
			let cursor = '';
			for (;;) {
				const rows = await transaction.widgetProjection.findMany({
					where: {
						tombstoned: false,
						widgetType,
						id: { gt: cursor }
					},
					orderBy: { id: 'asc' },
					take: PAGE_SIZE
				});
				for (const row of rows) {
					const state = {
						id: row.id,
						userId: this.required(row.userId, 'widget.userId'),
						widgetType,
						isActive: this.requiredBoolean(
							row.isActive,
							'widget.isActive'
						),
						hasInstallDomain: this.requiredBoolean(
							row.hasInstallDomain,
							'widget.hasInstallDomain'
						),
						createdAt: this.iso(
							row.sourceCreatedAt,
							'widget.sourceCreatedAt'
						)
					};
					accumulator.add(
						this.targetEvent(
							'widgets.widget.changed.v1',
							row.sourceAggregateId,
							row.aggregateVersion.toFixed(0),
							row.sourceSequence.toFixed(0),
							row.sourceOccurredAt,
							state
						),
						row.stateHash.trim()
					);
					cursor = row.id;
				}
				if (rows.length < PAGE_SIZE) break;
			}
		}
	}

	private async collectTargetLeads(
		transaction: Prisma.TransactionClient,
		accumulator: ProjectionComparisonAccumulator
	): Promise<void> {
		for (const widgetType of REPORTING_WIDGET_TYPES) {
			let cursor = '';
			for (;;) {
				const rows = await transaction.leadFact.findMany({
					where: {
						tombstoned: false,
						widgetType,
						id: { gt: cursor }
					},
					orderBy: { id: 'asc' },
					take: PAGE_SIZE
				});
				for (const row of rows) {
					const state = {
						id: row.id,
						widgetId: this.required(row.widgetId, 'lead.widgetId'),
						widgetType,
						createdAt: this.iso(
							row.sourceCreatedAt,
							'lead.sourceCreatedAt'
						)
					};
					accumulator.add(
						this.targetEvent(
							'widgets.lead.changed.v1',
							row.sourceAggregateId,
							row.aggregateVersion.toFixed(0),
							row.sourceSequence.toFixed(0),
							row.sourceOccurredAt,
							state
						),
						row.stateHash.trim()
					);
					cursor = row.id;
				}
				if (rows.length < PAGE_SIZE) break;
			}
		}
	}

	private async collectTargetSettings(
		transaction: Prisma.TransactionClient,
		accumulator: ProjectionComparisonAccumulator
	): Promise<void> {
		const row = await transaction.reportingSettings.findUnique({
			where: { id: 'daily-summary' }
		});
		if (
			!row?.coreOperationalRoutingSourceAggregateVersion ||
			!row.coreOperationalRoutingSourceSequence ||
			!row.coreOperationalRoutingStateHash
		) {
			return;
		}
		const state = {
			id: 'singleton',
			coreOperationalAlertsDestinationChatId:
				row.coreOperationalAlertsDestinationChatId || '',
			coreOperationalAlertsThreadId: row.coreOperationalAlertsThreadId
		};
		accumulator.add(
			this.targetEvent(
				'reporting.core-operational-routing.changed.v1',
				'singleton',
				row.coreOperationalRoutingSourceAggregateVersion.toFixed(0),
				row.coreOperationalRoutingSourceSequence.toFixed(0),
				new Date(0),
				state
			),
			row.coreOperationalRoutingStateHash.trim()
		);
	}

	private targetEvent(
		eventType: ReportingSourceEventType,
		aggregateId: string,
		aggregateVersion: string,
		sourceSequence: string,
		occurredAt: Date,
		state: unknown
	): ReportingSourceEvent {
		return parseReportingSourceEvent(
			{
				schemaVersion: 1,
				eventType,
				eventId: VALID_EVENT_ID,
				aggregateId,
				aggregateVersion,
				sourceSequence,
				occurredAt: occurredAt.toISOString(),
				tombstone: false,
				state
			},
			eventType,
			{ allowZeroVersion: true }
		);
	}

	private parseHeader(value: unknown): SnapshotHeader {
		const record = exactRecord(value, [
			'schemaVersion',
			'kind',
			'snapshotId',
			'watermarks'
		]);
		if (record.schemaVersion !== 1 || record.kind !== 'header') {
			throw new Error('Core snapshot must start with a v1 header');
		}
		assertPattern(record.snapshotId, UUID_PATTERN, 'snapshotId');
		const watermarks = this.parseWatermarks(record.watermarks);
		return { snapshotId: record.snapshotId, watermarks };
	}

	private parseFooter(value: unknown): {
		snapshotId: string;
		recordCount: number;
		sha256: string;
	} {
		const record = exactRecord(value, [
			'schemaVersion',
			'kind',
			'snapshotId',
			'recordCount',
			'sha256'
		]);
		if (record.schemaVersion !== 1 || record.kind !== 'footer') {
			throw new Error('Core snapshot footer is invalid');
		}
		assertPattern(record.snapshotId, UUID_PATTERN, 'footer.snapshotId');
		assertPattern(record.sha256, SHA256_PATTERN, 'footer.sha256');
		if (
			typeof record.recordCount !== 'number' ||
			!Number.isSafeInteger(record.recordCount) ||
			record.recordCount < 0
		) {
			throw new Error('Core snapshot footer count is invalid');
		}
		return {
			snapshotId: record.snapshotId,
			recordCount: record.recordCount as number,
			sha256: record.sha256
		};
	}

	private buildChecks(
		core: ComparisonValues,
		target: ComparisonValues
	): ReportingShadowCheck[] {
		return REPORTING_SHADOW_CHECK_NAMES.map(name => {
			const coreValue = core[name];
			const reportingValue = target[name];
			const coreSha256 = reportingShadowSha256(coreValue);
			const reportingSha256 = reportingShadowSha256(reportingValue);
			if (
				coreSha256 !== reportingSha256 ||
				canonicalReportingShadowJson(coreValue) !==
					canonicalReportingShadowJson(reportingValue)
			) {
				throw new Error(`Shadow comparison failed for ${name}`);
			}
			return {
				name,
				coreValue,
				reportingValue,
				coreSha256,
				reportingSha256,
				match: true
			};
		});
	}

	private config(): ShadowConfig {
		const revision = requiredEnv(
			'REPORTING_SHADOW_EXPECTED_REVISION',
			REVISION_PATTERN
		);
		if (requiredEnv('APP_REVISION', REVISION_PATTERN) !== revision) {
			throw new Error(
				'Reporting image revision differs from expected revision'
			);
		}
		return {
			revision,
			imageId: requiredEnv(
				'REPORTING_SHADOW_EXPECTED_IMAGE_ID',
				IMAGE_ID_PATTERN
			),
			coreSystemIdentifier: requiredEnv(
				'REPORTING_SHADOW_EXPECTED_CORE_SYSTEM_IDENTIFIER',
				DECIMAL_PATTERN
			),
			reportingSystemIdentifier: requiredEnv(
				'REPORTING_SHADOW_EXPECTED_REPORTING_SYSTEM_IDENTIFIER',
				DECIMAL_PATTERN
			),
			backfillSnapshotId: requiredEnv(
				'REPORTING_SHADOW_EXPECTED_BACKFILL_SNAPSHOT_ID',
				UUID_PATTERN
			),
			backfillSha256: requiredEnv(
				'REPORTING_SHADOW_EXPECTED_BACKFILL_SHA256',
				SHA256_PATTERN
			)
		};
	}

	private assertEvidenceConfig(
		evidence: ReportingShadowEvidence,
		config: ShadowConfig
	): void {
		if (
			evidence.revision !== config.revision ||
			evidence.imageId !== config.imageId ||
			evidence.source.systemIdentifier !== config.coreSystemIdentifier ||
			evidence.target.systemIdentifier !==
				config.reportingSystemIdentifier ||
			evidence.target.backfillSnapshotId !== config.backfillSnapshotId ||
			evidence.target.backfillSha256 !== config.backfillSha256
		) {
			throw new Error(
				'Shadow evidence provenance differs from live cutover'
			);
		}
	}

	private parseWatermarks(
		value: unknown
	): Record<ReportingProjectionStream, string> {
		const record = exactRecord(value, REPORTING_PROJECTION_STREAMS);
		for (const stream of REPORTING_PROJECTION_STREAMS) {
			assertPattern(
				record[stream],
				DECIMAL_PATTERN,
				`watermarks.${stream}`
			);
		}
		return record as unknown as Record<ReportingProjectionStream, string>;
	}

	private emptyWatermarks(): Record<ReportingProjectionStream, string> {
		return Object.fromEntries(
			REPORTING_PROJECTION_STREAMS.map(stream => [stream, '0'])
		) as Record<ReportingProjectionStream, string>;
	}

	private assertWatermarksEqual(
		core: Record<ReportingProjectionStream, string>,
		target: Record<ReportingProjectionStream, string>
	): void {
		if (
			canonicalReportingShadowJson(core) !==
			canonicalReportingShadowJson(target)
		) {
			throw new Error('Core snapshot and Reporting watermarks differ');
		}
	}

	private canonicalAsOf(value: Date): Date {
		if (!Number.isFinite(value.getTime()))
			throw new Error('asOf is invalid');
		return new Date(value.toISOString());
	}

	private iso(value: Date | null, path: string): string {
		if (!value) throw new Error(`${path} is missing`);
		return value.toISOString();
	}

	private required(value: string | null, path: string): string {
		if (value === null) throw new Error(`${path} is missing`);
		return value;
	}

	private requiredBoolean(value: boolean | null, path: string): boolean {
		if (value === null) throw new Error(`${path} is missing`);
		return value;
	}

	private requiredNumber(value: number | null, path: string): number {
		if (value === null) throw new Error(`${path} is missing`);
		return value;
	}
}

function requiredEnv(name: string, pattern: RegExp): string {
	const value = process.env[name]?.trim() || '';
	if (!pattern.test(value))
		throw new Error(`${name} is missing or invalid`);
	return value;
}

function exactRecord(
	value: unknown,
	keys: readonly string[]
): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error('Snapshot object is invalid');
	}
	const record = value as Record<string, unknown>;
	const actual = Object.keys(record).sort();
	const expected = [...keys].sort();
	if (
		actual.length !== expected.length ||
		actual.some((key, index) => key !== expected[index])
	) {
		throw new Error('Snapshot object keys are invalid');
	}
	return record;
}

function assertPattern(
	value: unknown,
	pattern: RegExp,
	path: string
): asserts value is string {
	if (typeof value !== 'string' || !pattern.test(value)) {
		throw new Error(`${path} is invalid`);
	}
}
