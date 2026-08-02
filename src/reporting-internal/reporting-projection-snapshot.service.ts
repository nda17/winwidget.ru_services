import { assertReportingProjectionEvent } from '@/messaging/messaging-event-contract';
import {
	REPORTING_BILLING_PAYMENT_EVENT_TYPE,
	REPORTING_BILLING_SUBSCRIPTION_EVENT_TYPE,
	REPORTING_IDENTITY_USER_EVENT_TYPE,
	REPORTING_LEAD_EVENT_TYPE,
	REPORTING_SETTINGS_EVENT_TYPE,
	REPORTING_WIDGET_EVENT_TYPE
} from '@/messaging/messaging.constants';
import { PrismaService } from '@/prisma.service';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Request, Response } from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { ReportingProjectionStream } from './reporting-internal.constants';

interface ProjectionRow {
	cursorId: string;
	aggregateId: string;
	aggregateVersion: string;
	sourceSequence: string;
	state: Record<string, unknown>;
}

interface SnapshotWatermarks {
	identityUser: string;
	billingPayment: string;
	billingSubscription: string;
	widget: string;
	lead: string;
	reportingSettings: string;
}

interface ReportingProducerSnapshotState {
	enabled: boolean;
	activatedAt: Date | null;
}

interface SnapshotSource {
	stream: ReportingProjectionStream;
	eventType: string;
	fetchPage: (
		transaction: Prisma.TransactionClient,
		cursor: string,
		limit: number
	) => Promise<ProjectionRow[]>;
}

interface WidgetSource {
	table: string;
	type: string;
}

interface LeadSource extends WidgetSource {
	widgetIdColumn: string;
}

const DEFAULT_CHUNK_SIZE = 500;
const MAX_CHUNK_SIZE = 2000;
const DEFAULT_TRANSACTION_TIMEOUT_MS = 15 * 60 * 1000;

const WIDGET_SOURCES: readonly WidgetSource[] = [
	{ table: 'widgets', type: 'wheel' },
	{ table: 'quizzes', type: 'quiz' },
	{ table: 'callbacks', type: 'callback' },
	{ table: 'countdown_timers', type: 'countdownTimer' },
	{ table: 'stop_offers', type: 'stopOffer' },
	{ table: 'online_consultants', type: 'onlineConsultant' },
	{ table: 'calculators', type: 'calculator' }
];

const LEAD_SOURCES: readonly LeadSource[] = [
	{ table: 'leads', type: 'wheel', widgetIdColumn: 'widget_id' },
	{ table: 'quiz_leads', type: 'quiz', widgetIdColumn: 'quiz_id' },
	{
		table: 'callback_leads',
		type: 'callback',
		widgetIdColumn: 'callback_id'
	},
	{
		table: 'countdown_timer_leads',
		type: 'countdownTimer',
		widgetIdColumn: 'countdown_timer_id'
	},
	{
		table: 'stop_offer_leads',
		type: 'stopOffer',
		widgetIdColumn: 'stop_offer_id'
	},
	{
		table: 'online_consultant_leads',
		type: 'onlineConsultant',
		widgetIdColumn: 'online_consultant_id'
	},
	{
		table: 'calculator_leads',
		type: 'calculator',
		widgetIdColumn: 'calculator_id'
	}
];

@Injectable()
export class ReportingProjectionSnapshotService {
	constructor(private readonly prisma: PrismaService) {}

	async stream(request: Request, response: Response): Promise<void> {
		const snapshotId = randomUUID();
		const occurredAt = new Date().toISOString();
		const chunkSize = this.readBoundedInteger(
			'REPORTING_SNAPSHOT_CHUNK_SIZE',
			DEFAULT_CHUNK_SIZE,
			1,
			MAX_CHUNK_SIZE
		);
		const timeout = this.readBoundedInteger(
			'REPORTING_SNAPSHOT_TIMEOUT_MS',
			DEFAULT_TRANSACTION_TIMEOUT_MS,
			10_000,
			60 * 60 * 1000
		);

		await this.prisma.$transaction(
			async transaction => {
				this.assertConnected(request, response);
				await this.assertProducerEnabled(transaction);
				const watermarks = await this.getWatermarks(transaction);
				const hash = createHash('sha256');
				await this.writeLine(
					response,
					{
						schemaVersion: 1,
						kind: 'header',
						snapshotId,
						watermarks
					},
					hash
				);

				let recordCount = 0;
				for (const source of this.getSources()) {
					recordCount += await this.streamSource(
						transaction,
						source,
						occurredAt,
						chunkSize,
						request,
						response,
						hash
					);
				}

				await this.writeLine(response, {
					schemaVersion: 1,
					kind: 'footer',
					snapshotId,
					recordCount,
					sha256: hash.digest('hex')
				});
			},
			{
				isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
				maxWait: 5000,
				timeout
			}
		);
	}

	private async assertProducerEnabled(
		transaction: Prisma.TransactionClient
	): Promise<void> {
		const [state] = await transaction.$queryRaw<
			ReportingProducerSnapshotState[]
		>(Prisma.sql`
			SELECT
				"enabled",
				"activated_at" AS "activatedAt"
			FROM "reporting_producer_state"
			WHERE "id" = 'singleton'
			FOR SHARE
		`);
		if (!state?.enabled || !state.activatedAt) {
			throw new ServiceUnavailableException(
				'Reporting projection snapshot requires enabled producers'
			);
		}
	}

	private getSources(): SnapshotSource[] {
		return [
			{
				stream: 'identityUser',
				eventType: REPORTING_IDENTITY_USER_EVENT_TYPE,
				fetchPage: (transaction, cursor, limit) =>
					this.getUserRows(transaction, cursor, limit)
			},
			{
				stream: 'billingPayment',
				eventType: REPORTING_BILLING_PAYMENT_EVENT_TYPE,
				fetchPage: (transaction, cursor, limit) =>
					this.getPaymentRows(transaction, cursor, limit)
			},
			{
				stream: 'billingSubscription',
				eventType: REPORTING_BILLING_SUBSCRIPTION_EVENT_TYPE,
				fetchPage: (transaction, cursor, limit) =>
					this.getSubscriptionRows(transaction, cursor, limit)
			},
			...WIDGET_SOURCES.map(source => ({
				stream: 'widget' as const,
				eventType: REPORTING_WIDGET_EVENT_TYPE,
				fetchPage: (
					transaction: Prisma.TransactionClient,
					cursor: string,
					limit: number
				) => this.getWidgetRows(transaction, source, cursor, limit)
			})),
			...LEAD_SOURCES.map(source => ({
				stream: 'lead' as const,
				eventType: REPORTING_LEAD_EVENT_TYPE,
				fetchPage: (
					transaction: Prisma.TransactionClient,
					cursor: string,
					limit: number
				) => this.getLeadRows(transaction, source, cursor, limit)
			})),
			{
				stream: 'reportingSettings',
				eventType: REPORTING_SETTINGS_EVENT_TYPE,
				fetchPage: (transaction, cursor, limit) =>
					this.getSettingsRows(transaction, cursor, limit)
			}
		];
	}

	private async streamSource(
		transaction: Prisma.TransactionClient,
		source: SnapshotSource,
		occurredAt: string,
		chunkSize: number,
		request: Request,
		response: Response,
		hash: ReturnType<typeof createHash>
	): Promise<number> {
		let cursor = '';
		let count = 0;
		for (;;) {
			this.assertConnected(request, response);
			const rows = await source.fetchPage(transaction, cursor, chunkSize);
			if (!rows.length) return count;

			for (const row of rows) {
				this.assertConnected(request, response);
				if (row.cursorId <= cursor) {
					throw new Error('Reporting snapshot cursor did not advance');
				}
				const event = {
					schemaVersion: 1,
					eventType: source.eventType,
					eventId: randomUUID(),
					aggregateId: row.aggregateId,
					aggregateVersion: row.aggregateVersion,
					sourceSequence: row.sourceSequence,
					occurredAt,
					tombstone: false,
					state: row.state
				};
				assertReportingProjectionEvent(event, {
					allowZeroVersion: true
				});
				const line = `${JSON.stringify({
					schemaVersion: 1,
					kind: 'record',
					stream: source.stream,
					event
				})}\n`;
				hash.update(line, 'utf8');
				await this.writeRaw(response, line);
				cursor = row.cursorId;
				count += 1;
			}

			if (rows.length < chunkSize) return count;
		}
	}

	private getWatermarks(
		transaction: Prisma.TransactionClient
	): Promise<SnapshotWatermarks> {
		return transaction
			.$queryRaw<SnapshotWatermarks[]>(
				Prisma.sql`
				SELECT
					COALESCE(MAX("source_sequence") FILTER (
						WHERE "aggregate_type" = 'identity.user'
					), 0)::TEXT AS "identityUser",
					COALESCE(MAX("source_sequence") FILTER (
						WHERE "aggregate_type" = 'billing.payment'
					), 0)::TEXT AS "billingPayment",
					COALESCE(MAX("source_sequence") FILTER (
						WHERE "aggregate_type" = 'billing.subscription'
					), 0)::TEXT AS "billingSubscription",
					COALESCE(MAX("source_sequence") FILTER (
						WHERE "aggregate_type" LIKE 'widgets.widget.%'
					), 0)::TEXT AS "widget",
					COALESCE(MAX("source_sequence") FILTER (
						WHERE "aggregate_type" LIKE 'widgets.lead.%'
					), 0)::TEXT AS "lead",
					COALESCE(MAX("source_sequence") FILTER (
						WHERE "aggregate_type" = 'reporting.settings'
					), 0)::TEXT AS "reportingSettings"
				FROM "reporting_projection_versions"
			`
			)
			.then(rows => rows[0]);
	}

	private getUserRows(
		transaction: Prisma.TransactionClient,
		cursor: string,
		limit: number
	): Promise<ProjectionRow[]> {
		return transaction.$queryRaw<ProjectionRow[]>(Prisma.sql`
			SELECT
				"source"."id" AS "cursorId",
				"source"."id" AS "aggregateId",
				COALESCE("version"."version", 0)::TEXT AS "aggregateVersion",
				COALESCE("version"."source_sequence", 0)::TEXT AS "sourceSequence",
				jsonb_build_object(
					'id', "source"."id",
					'status', "source"."status"::TEXT,
					'deletedAt', CASE
						WHEN "source"."deleted_at" IS NULL THEN NULL
						ELSE "reporting_iso_timestamp"("source"."deleted_at")
					END,
					'roles', (
						SELECT COALESCE(jsonb_agg("role_value" ORDER BY "role_value"), '[]'::JSONB)
						FROM (
							SELECT DISTINCT "role"::TEXT AS "role_value"
							FROM unnest("source"."rights") AS "role"
						) AS "unique_roles"
					),
					'hasEmailIdentity', EXISTS (
						SELECT 1
						FROM "auth_identities" AS "email_identity"
						WHERE "email_identity"."user_id" = "source"."id"
							AND "email_identity"."type" = 'EMAIL'::"AuthIdentityType"
					),
					'hasPhoneIdentity', EXISTS (
						SELECT 1
						FROM "auth_identities" AS "phone_identity"
						WHERE "phone_identity"."user_id" = "source"."id"
							AND "phone_identity"."type" = 'PHONE'::"AuthIdentityType"
					),
					'hasTelegramIdentity', EXISTS (
						SELECT 1
						FROM "auth_identities" AS "telegram_identity"
						WHERE "telegram_identity"."user_id" = "source"."id"
							AND "telegram_identity"."type" = 'TELEGRAM'::"AuthIdentityType"
					),
					'loginMethodCount', (
						SELECT COUNT(*)::INTEGER
						FROM "auth_identities" AS "login_identity"
						WHERE "login_identity"."user_id" = "source"."id"
							AND (
								"login_identity"."type" IN (
									'EMAIL'::"AuthIdentityType",
									'GOOGLE'::"AuthIdentityType",
									'GITHUB'::"AuthIdentityType",
									'TELEGRAM'::"AuthIdentityType"
								)
								OR (
									"login_identity"."type" = 'PHONE'::"AuthIdentityType"
									AND "login_identity"."verified_at" IS NOT NULL
								)
							)
					),
					'createdAt', "reporting_iso_timestamp"("source"."created_at"),
					'updatedAt', "reporting_iso_timestamp"("source"."updated_at")
				) AS "state"
			FROM "User" AS "source"
			LEFT JOIN "reporting_projection_versions" AS "version"
				ON "version"."aggregate_type" = 'identity.user'
				AND "version"."aggregate_id" = "source"."id"
				WHERE "source"."id" > ${cursor}
			ORDER BY "source"."id" ASC
			LIMIT ${limit}
		`);
	}

	private getPaymentRows(
		transaction: Prisma.TransactionClient,
		cursor: string,
		limit: number
	): Promise<ProjectionRow[]> {
		return transaction.$queryRaw<ProjectionRow[]>(Prisma.sql`
			SELECT
				"source"."id" AS "cursorId",
				"source"."id" AS "aggregateId",
				COALESCE("version"."version", 0)::TEXT AS "aggregateVersion",
				COALESCE("version"."source_sequence", 0)::TEXT AS "sourceSequence",
				jsonb_build_object(
					'id', "source"."id",
					'userId', "source"."user_id",
					'status', "source"."status"::TEXT,
					'amount', "source"."amount"::TEXT,
					'createdAt', "reporting_iso_timestamp"("source"."created_at"),
					'updatedAt', "reporting_iso_timestamp"("source"."updated_at")
				) AS "state"
				FROM "payments" AS "source"
				LEFT JOIN "reporting_projection_versions" AS "version"
					ON "version"."aggregate_type" = 'billing.payment'
					AND "version"."aggregate_id" = "source"."id"
				WHERE "source"."id" > ${cursor}
				ORDER BY "source"."id" ASC
				LIMIT ${limit}
		`);
	}

	private getSubscriptionRows(
		transaction: Prisma.TransactionClient,
		cursor: string,
		limit: number
	): Promise<ProjectionRow[]> {
		return transaction.$queryRaw<ProjectionRow[]>(Prisma.sql`
			SELECT
				"source"."id" AS "cursorId",
				"source"."id" AS "aggregateId",
				COALESCE("version"."version", 0)::TEXT AS "aggregateVersion",
				COALESCE("version"."source_sequence", 0)::TEXT AS "sourceSequence",
				jsonb_build_object(
					'id', "source"."id",
					'userId', "source"."user_id",
					'plan', "source"."plan"::TEXT,
					'status', "source"."status"::TEXT,
					'expiresAt', CASE
						WHEN "source"."expires_at" IS NULL THEN NULL
						ELSE "reporting_iso_timestamp"("source"."expires_at")
					END,
					'createdAt', "reporting_iso_timestamp"("source"."created_at")
				) AS "state"
			FROM "subscriptions" AS "source"
			LEFT JOIN "reporting_projection_versions" AS "version"
				ON "version"."aggregate_type" = 'billing.subscription'
				AND "version"."aggregate_id" = "source"."id"
			WHERE "source"."id" > ${cursor}
			ORDER BY "source"."id" ASC
			LIMIT ${limit}
		`);
	}

	private getWidgetRows(
		transaction: Prisma.TransactionClient,
		source: WidgetSource,
		cursor: string,
		limit: number
	): Promise<ProjectionRow[]> {
		const table = Prisma.raw(`"${source.table}"`);
		const aggregateType = `widgets.widget.${source.type}`;
		return transaction.$queryRaw<ProjectionRow[]>(Prisma.sql`
			SELECT
				"source"."id" AS "cursorId",
				${source.type} || ':' || "source"."id" AS "aggregateId",
				COALESCE("version"."version", 0)::TEXT AS "aggregateVersion",
				COALESCE("version"."source_sequence", 0)::TEXT AS "sourceSequence",
				jsonb_build_object(
					'id', "source"."id",
					'userId', "source"."user_id",
					'widgetType', ${source.type},
					'isActive', "source"."is_active",
					'hasInstallDomain', "source"."install_domain" <> '',
					'createdAt', "reporting_iso_timestamp"("source"."created_at")
				) AS "state"
			FROM ${table} AS "source"
			LEFT JOIN "reporting_projection_versions" AS "version"
				ON "version"."aggregate_type" = ${aggregateType}
				AND "version"."aggregate_id" = ${source.type} || ':' || "source"."id"
			WHERE "source"."id" > ${cursor}
			ORDER BY "source"."id" ASC
			LIMIT ${limit}
		`);
	}

	private getLeadRows(
		transaction: Prisma.TransactionClient,
		source: LeadSource,
		cursor: string,
		limit: number
	): Promise<ProjectionRow[]> {
		const table = Prisma.raw(`"${source.table}"`);
		const widgetIdColumn = Prisma.raw(`"${source.widgetIdColumn}"`);
		const aggregateType = `widgets.lead.${source.type}`;
		return transaction.$queryRaw<ProjectionRow[]>(Prisma.sql`
			SELECT
				"source"."id" AS "cursorId",
				${source.type} || ':' || "source"."id" AS "aggregateId",
				COALESCE("version"."version", 0)::TEXT AS "aggregateVersion",
				COALESCE("version"."source_sequence", 0)::TEXT AS "sourceSequence",
				jsonb_build_object(
					'id', "source"."id",
					'widgetId', "source".${widgetIdColumn},
					'widgetType', ${source.type},
					'createdAt', "reporting_iso_timestamp"("source"."created_at")
				) AS "state"
			FROM ${table} AS "source"
			LEFT JOIN "reporting_projection_versions" AS "version"
				ON "version"."aggregate_type" = ${aggregateType}
				AND "version"."aggregate_id" = ${source.type} || ':' || "source"."id"
			WHERE "source"."id" > ${cursor}
			ORDER BY "source"."id" ASC
			LIMIT ${limit}
		`);
	}

	private getSettingsRows(
		transaction: Prisma.TransactionClient,
		cursor: string,
		limit: number
	): Promise<ProjectionRow[]> {
		return transaction.$queryRaw<ProjectionRow[]>(Prisma.sql`
			SELECT
				"source"."id" AS "cursorId",
				"source"."id" AS "aggregateId",
				COALESCE("version"."version", 0)::TEXT AS "aggregateVersion",
				COALESCE("version"."source_sequence", 0)::TEXT AS "sourceSequence",
				jsonb_build_object(
					'id', "source"."id",
					'enabled', "source"."daily_summary_enabled",
					'destinationChatId', "source"."daily_summary_chat_id",
					'messageThreadId', "source"."reports_thread_id",
					'coreOperationalAlertsThreadId', "source"."operational_alerts_thread_id",
					'scheduleTime', "source"."daily_summary_time",
					'timezone', 'Europe/Moscow',
					'lastSuccessfulPeriodStart', CASE
						WHEN "source"."daily_summary_last_sent_period_start" IS NULL THEN NULL
						ELSE "reporting_iso_timestamp"("source"."daily_summary_last_sent_period_start")
					END,
					'lastSuccessfulAt', CASE
						WHEN "source"."daily_summary_last_sent_at" IS NULL THEN NULL
						ELSE "reporting_iso_timestamp"("source"."daily_summary_last_sent_at")
					END
				) AS "state"
				FROM "telegram_bot_settings" AS "source"
				LEFT JOIN "reporting_projection_versions" AS "version"
					ON "version"."aggregate_type" = 'reporting.settings'
					AND "version"."aggregate_id" = "source"."id"
				WHERE "source"."id" = 'singleton'
					AND "source"."id" > ${cursor}
			ORDER BY "source"."id" ASC
			LIMIT ${limit}
		`);
	}

	private async writeLine(
		response: Response,
		value: Record<string, unknown>,
		hash?: ReturnType<typeof createHash>
	): Promise<void> {
		const line = `${JSON.stringify(value)}\n`;
		hash?.update(line, 'utf8');
		await this.writeRaw(response, line);
	}

	private async writeRaw(
		response: Response,
		value: string
	): Promise<void> {
		if (response.write(value)) return;
		await new Promise<void>((resolve, reject) => {
			const cleanup = () => {
				response.off('drain', onDrain);
				response.off('close', onClose);
				response.off('error', onError);
			};
			const onDrain = () => {
				cleanup();
				resolve();
			};
			const onClose = () => {
				cleanup();
				reject(new Error('Reporting snapshot client disconnected'));
			};
			const onError = (error: Error) => {
				cleanup();
				reject(error);
			};

			response.once('drain', onDrain);
			response.once('close', onClose);
			response.once('error', onError);
		});
	}

	private assertConnected(request: Request, response: Response): void {
		if (request.aborted || response.destroyed || response.writableEnded) {
			throw new Error('Reporting snapshot client disconnected');
		}
	}

	private readBoundedInteger(
		name: string,
		fallback: number,
		min: number,
		max: number
	): number {
		const value = Number(process.env[name] || fallback);
		return Number.isInteger(value) && value >= min && value <= max
			? value
			: fallback;
	}
}
