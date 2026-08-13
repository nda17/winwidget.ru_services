import {
	AuthIdentityType,
	BillingCoreOwnership,
	Prisma,
	PrismaClient
} from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, open, rename, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import {
	AUTO_RENEWAL_CONSENT_TEXT,
	AUTO_RENEWAL_CONSENT_VERSION
} from './billing-boundary/billing-boundary.constants';

const REVISION_PATTERN = /^[0-9a-f]{40}$/;
const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTIONS = [
	'status',
	'prepare',
	'freeze-export',
	'abort',
	'projection-lag',
	'activate'
] as const;
const PROJECTION_EVENT_TYPES = [
	'billing.payment.details.changed.v1',
	'billing.subscription.details.changed.v1',
	'billing.affiliate.changed.v1',
	'billing.settings.changed.v1'
] as const;
const BILLING_SOURCE_AGGREGATE_TYPES = [
	'billing.identity',
	'billing.settings',
	'billing.referral-request',
	'billing.notification-routing',
	'billing.trial',
	'billing.lifecycle-repair',
	'billing.offer'
] as const;
const TRANSACTION_OPTIONS = {
	isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
	maxWait: 10_000,
	timeout: 15 * 60 * 1000
} as const;

type CutoverAction = (typeof ACTIONS)[number];

export interface BillingCoreCutoverOptions {
	action: CutoverAction;
	revision?: string;
	generation?: bigint;
	file: string;
}

type CoreDatabase = Prisma.TransactionClient | PrismaClient;

interface SequenceRow {
	value: bigint;
}

interface TransactionTimeRow {
	value: Date;
}

interface ProjectionLagRow {
	legacyPayments: bigint;
	projectedPayments: bigint;
	paymentIdLag: bigint;
	paymentVersionLag: bigint;
	legacySubscriptions: bigint;
	projectedSubscriptions: bigint;
	subscriptionIdLag: bigint;
	subscriptionVersionLag: bigint;
	legacyAffiliates: bigint;
	projectedAffiliates: bigint;
	affiliateIdLag: bigint;
	affiliateVersionLag: bigint;
	legacySettings: bigint;
	projectedSettings: bigint;
	settingsIdLag: bigint;
	settingsVersionLag: bigint;
}

type LegacySnapshotRow = Record<string, unknown> & { id: string };

interface LegacyBillingSettingsSnapshot {
	id: string;
	paymentEnabled: boolean;
	autoRenewalSignupEnabled: boolean;
	autoRenewalChargesEnabled: boolean;
	autoRenewalChargesEnabledAt: Date | null;
	affiliateProgramEnabled: boolean;
	affiliateCashbackPercent: number;
	updatedAt: Date;
}

class CutoverCliError extends Error {}

export function parseBillingCoreCutoverArgs(
	argv: readonly string[]
): BillingCoreCutoverOptions {
	const [rawAction, ...tokens] = argv;
	if (!ACTIONS.includes(rawAction as CutoverAction)) {
		throw new CutoverCliError('Unsupported Billing Core cutover action');
	}
	const values = new Map<string, string>();
	for (let index = 0; index < tokens.length; index += 2) {
		const name = tokens[index];
		const value = tokens[index + 1];
		if (!name?.startsWith('--') || value === undefined) {
			throw new CutoverCliError('Invalid Billing Core cutover arguments');
		}
		if (
			![
				'--revision',
				'--generation',
				'--file',
				'--evidence-file',
				'--snapshot-file'
			].includes(name) ||
			values.has(name)
		) {
			throw new CutoverCliError('Invalid Billing Core cutover arguments');
		}
		values.set(name, value);
	}

	const fileOptions = [
		'--file',
		'--evidence-file',
		'--snapshot-file'
	].filter(name => values.has(name));
	if (fileOptions.length !== 1) {
		throw new CutoverCliError('Exactly one output file is required');
	}
	const file = values.get(fileOptions[0])!;
	if (!file || !isAbsolute(file) || file.includes('\0')) {
		throw new CutoverCliError('Output file must be an absolute path');
	}

	const revisionValue = values.get('--revision');
	const generationValue = values.get('--generation');
	if (revisionValue && !REVISION_PATTERN.test(revisionValue)) {
		throw new CutoverCliError(
			'Revision must be a lowercase 40-character SHA'
		);
	}
	if (generationValue && !/^[1-9]\d*$/.test(generationValue)) {
		throw new CutoverCliError(
			'Generation must be a positive decimal integer'
		);
	}
	if (
		rawAction !== 'status' &&
		(!revisionValue || generationValue === undefined)
	) {
		throw new CutoverCliError('Revision and generation are required');
	}
	if (
		(rawAction === 'status' && revisionValue && !generationValue) ||
		(rawAction === 'status' && generationValue && !revisionValue)
	) {
		throw new CutoverCliError(
			'Status revision and generation must be provided together'
		);
	}

	return {
		action: rawAction as CutoverAction,
		revision: revisionValue,
		generation: generationValue ? BigInt(generationValue) : undefined,
		file
	};
}

export function calculateSourceFingerprint(
	documentWithoutFingerprint: Record<string, unknown>
): string {
	return createHash('sha256')
		.update(JSON.stringify(documentWithoutFingerprint), 'utf8')
		.digest('hex');
}

export async function executeBillingCoreCutover(
	prisma: PrismaClient,
	options: BillingCoreCutoverOptions
): Promise<Record<string, unknown>> {
	switch (options.action) {
		case 'status':
			return getStatus(prisma, options);
		case 'prepare':
			return prepare(prisma, requireIdentity(options));
		case 'freeze-export':
			return freezeExport(prisma, requireIdentity(options));
		case 'abort':
			return abort(prisma, requireIdentity(options));
		case 'projection-lag':
			return projectionLag(prisma, requireIdentity(options));
		case 'activate':
			return activate(prisma, requireIdentity(options));
	}
}

async function getStatus(
	prisma: PrismaClient,
	options: BillingCoreCutoverOptions
): Promise<Record<string, unknown>> {
	const state = await getState(prisma);
	if (
		options.generation !== undefined &&
		options.revision &&
		(state.generation !== options.generation ||
			(state.preparedRevision !== options.revision &&
				state.ownershipRevision !== options.revision))
	) {
		throw new CutoverCliError(
			'Billing Core state identity does not match'
		);
	}
	return evidence(options, state);
}

async function prepare(
	prisma: PrismaClient,
	options: RequiredIdentity
): Promise<Record<string, unknown>> {
	const state = await prisma.$transaction(async transaction => {
		const current = await lockState(transaction);
		assertCoreOwnership(current);
		if (
			current.generation === options.generation &&
			current.preparedRevision === options.revision
		) {
			return current;
		}
		if (
			options.generation <= current.generation ||
			current.preparedRevision ||
			!current.sourceProducersEnabled ||
			!current.legacyRoutesEnabled ||
			!current.schedulerEnabled ||
			!current.legacyConsumerEnabled ||
			!current.projectionConsumerEnabled
		) {
			throw new CutoverCliError(
				'Billing Core state is not eligible for prepare'
			);
		}
		const updated = await transaction.billingCoreState.updateMany({
			where: {
				id: 'singleton',
				ownership: BillingCoreOwnership.CORE,
				generation: current.generation,
				preparedRevision: null,
				sourceProducersEnabled: true,
				legacyRoutesEnabled: true,
				schedulerEnabled: true,
				legacyConsumerEnabled: true,
				projectionConsumerEnabled: true
			},
			data: {
				generation: options.generation,
				preparedRevision: options.revision,
				ownershipRevision: null,
				activatedAt: null
			}
		});
		if (updated.count !== 1) {
			throw new CutoverCliError('Billing Core prepare CAS failed');
		}
		return getState(transaction);
	}, TRANSACTION_OPTIONS);
	return evidence(options, state);
}

async function abort(
	prisma: PrismaClient,
	options: RequiredIdentity
): Promise<Record<string, unknown>> {
	const state = await prisma.$transaction(async transaction => {
		const current = await lockState(transaction);
		if (current.ownership === BillingCoreOwnership.BILLING) {
			throw new CutoverCliError(
				'Billing Core ownership is forward-only after activation'
			);
		}
		if (
			current.generation !== options.generation ||
			(current.preparedRevision !== options.revision &&
				current.preparedRevision !== null)
		) {
			throw new CutoverCliError(
				'Billing Core abort identity does not match'
			);
		}
		if (
			current.preparedRevision === null &&
			current.sourceProducersEnabled &&
			current.legacyRoutesEnabled &&
			current.schedulerEnabled &&
			current.legacyConsumerEnabled &&
			current.projectionConsumerEnabled
		) {
			return current;
		}
		const updated = await transaction.billingCoreState.updateMany({
			where: {
				id: 'singleton',
				ownership: BillingCoreOwnership.CORE,
				generation: options.generation,
				preparedRevision: options.revision
			},
			data: {
				sourceProducersEnabled: true,
				legacyRoutesEnabled: true,
				schedulerEnabled: true,
				legacyConsumerEnabled: true,
				projectionConsumerEnabled: true,
				preparedRevision: null,
				ownershipRevision: null,
				activatedAt: null
			}
		});
		if (updated.count !== 1) {
			throw new CutoverCliError('Billing Core abort CAS failed');
		}
		return getState(transaction);
	}, TRANSACTION_OPTIONS);
	return evidence(options, state);
}

async function freezeExport(
	prisma: PrismaClient,
	options: RequiredIdentity
): Promise<Record<string, unknown>> {
	return prisma.$transaction(async transaction => {
		let state = await lockState(transaction);
		assertPreparedIdentity(state, options);
		const alreadyFrozen = isFrozen(state);
		if (!alreadyFrozen) {
			if (
				!state.sourceProducersEnabled ||
				!state.legacyRoutesEnabled ||
				!state.schedulerEnabled ||
				!state.legacyConsumerEnabled ||
				!state.projectionConsumerEnabled
			) {
				throw new CutoverCliError(
					'Billing Core state is inconsistent before freeze'
				);
			}
			const frozen = await transaction.billingCoreState.updateMany({
				where: {
					id: 'singleton',
					ownership: BillingCoreOwnership.CORE,
					generation: options.generation,
					preparedRevision: options.revision,
					sourceProducersEnabled: true,
					legacyRoutesEnabled: true,
					schedulerEnabled: true,
					legacyConsumerEnabled: true,
					projectionConsumerEnabled: true
				},
				data: {
					sourceProducersEnabled: false,
					schedulerEnabled: false,
					legacyConsumerEnabled: false,
					projectionConsumerEnabled: true,
					legacyRoutesEnabled: true
				}
			});
			if (frozen.count !== 1) {
				throw new CutoverCliError('Billing Core freeze CAS failed');
			}
			state = await getState(transaction);
		}

		const sourceCutoff = await getTransactionTime(transaction);
		const snapshotBody = await buildFrozenSnapshot(
			transaction,
			options,
			state,
			sourceCutoff
		);
		const normalized = toJsonObject(snapshotBody);
		const sourceFingerprint = calculateSourceFingerprint(normalized);
		return {
			schemaVersion: 1,
			action: 'freeze-export',
			revision: options.revision,
			generation: options.generation.toString(),
			frozenAt: sourceCutoff.toISOString(),
			sourceCutoff: sourceCutoff.toISOString(),
			sourceFingerprint,
			...omitSnapshotIdentity(normalized)
		};
	}, TRANSACTION_OPTIONS);
}

async function projectionLag(
	prisma: PrismaClient,
	options: RequiredIdentity
): Promise<Record<string, unknown>> {
	const result = await prisma.$transaction(async transaction => {
		const state = await lockState(transaction);
		assertPreparedIdentity(state, options);
		if (!isFrozen(state)) {
			throw new CutoverCliError(
				'Billing Core source must remain frozen during projection check'
			);
		}
		return {
			state,
			lag: await calculateProjectionLag(transaction)
		};
	}, TRANSACTION_OPTIONS);
	return projectionEvidence(options, result.state, result.lag);
}

async function activate(
	prisma: PrismaClient,
	options: RequiredIdentity
): Promise<Record<string, unknown>> {
	const result = await prisma.$transaction(async transaction => {
		let state = await lockState(transaction);
		if (state.ownership === BillingCoreOwnership.BILLING) {
			if (
				state.generation !== options.generation ||
				state.ownershipRevision !== options.revision
			) {
				throw new CutoverCliError(
					'Active Billing Core identity does not match'
				);
			}
			const lag = await calculateProjectionLag(transaction);
			if (lag.total !== 0n) {
				throw new CutoverCliError(
					'Active Billing Core read projections are inconsistent'
				);
			}
			return { state, lag };
		}
		assertPreparedIdentity(state, options);
		if (!isFrozen(state)) {
			throw new CutoverCliError(
				'Billing Core source must be frozen before activation'
			);
		}
		const lag = await calculateProjectionLag(transaction);
		if (lag.total !== 0n) {
			throw new CutoverCliError(
				'Billing Core read projections are not synchronized'
			);
		}
		const activatedAt = await getTransactionTime(transaction);
		const activated = await transaction.billingCoreState.updateMany({
			where: {
				id: 'singleton',
				ownership: BillingCoreOwnership.CORE,
				generation: options.generation,
				preparedRevision: options.revision,
				sourceProducersEnabled: false,
				legacyRoutesEnabled: true,
				schedulerEnabled: false,
				legacyConsumerEnabled: false,
				projectionConsumerEnabled: true,
				ownershipRevision: null,
				activatedAt: null
			},
			data: {
				ownership: BillingCoreOwnership.BILLING,
				legacyRoutesEnabled: false,
				ownershipRevision: options.revision,
				activatedAt
			}
		});
		if (activated.count !== 1) {
			throw new CutoverCliError('Billing Core activation CAS failed');
		}
		state = await getState(transaction);
		assertActiveState(state);
		return { state, lag };
	}, TRANSACTION_OPTIONS);
	return {
		...evidence(options, result.state),
		lag: Number(result.lag.total),
		eventTypes: [...PROJECTION_EVENT_TYPES]
	};
}

type RequiredIdentity = BillingCoreCutoverOptions & {
	revision: string;
	generation: bigint;
};

function requireIdentity(
	options: BillingCoreCutoverOptions
): RequiredIdentity {
	if (!options.revision || options.generation === undefined) {
		throw new CutoverCliError('Revision and generation are required');
	}
	return options as RequiredIdentity;
}

async function lockState(transaction: Prisma.TransactionClient) {
	await transaction.$queryRaw(
		Prisma.sql`
			SELECT "id"
			FROM "billing_core_state"
			WHERE "id" = 'singleton'
			FOR UPDATE
		`
	);
	return getState(transaction);
}

async function getState(database: CoreDatabase) {
	const state = await database.billingCoreState.findUnique({
		where: { id: 'singleton' }
	});
	if (!state) {
		throw new CutoverCliError('Billing Core state is unavailable');
	}
	return state;
}

function assertCoreOwnership(state: { ownership: BillingCoreOwnership }) {
	if (state.ownership !== BillingCoreOwnership.CORE) {
		throw new CutoverCliError(
			'Billing Core ownership is forward-only after activation'
		);
	}
}

function assertPreparedIdentity(
	state: Awaited<ReturnType<typeof getState>>,
	options: RequiredIdentity
): void {
	assertCoreOwnership(state);
	if (
		state.generation !== options.generation ||
		state.preparedRevision !== options.revision ||
		state.ownershipRevision !== null ||
		state.activatedAt !== null
	) {
		throw new CutoverCliError(
			'Prepared Billing Core identity does not match'
		);
	}
}

function isFrozen(state: Awaited<ReturnType<typeof getState>>): boolean {
	return (
		state.ownership === BillingCoreOwnership.CORE &&
		!state.sourceProducersEnabled &&
		state.legacyRoutesEnabled &&
		!state.schedulerEnabled &&
		!state.legacyConsumerEnabled &&
		state.projectionConsumerEnabled
	);
}

function assertActiveState(
	state: Awaited<ReturnType<typeof getState>>
): void {
	if (
		state.ownership !== BillingCoreOwnership.BILLING ||
		state.sourceProducersEnabled ||
		state.legacyRoutesEnabled ||
		state.schedulerEnabled ||
		state.legacyConsumerEnabled ||
		!state.projectionConsumerEnabled ||
		state.generation <= 0n ||
		!state.preparedRevision ||
		state.ownershipRevision !== state.preparedRevision ||
		!state.activatedAt
	) {
		throw new CutoverCliError('Active Billing Core state is inconsistent');
	}
}

function evidence(
	options: BillingCoreCutoverOptions,
	state: Awaited<ReturnType<typeof getState>>
): Record<string, unknown> {
	return {
		schemaVersion: 1,
		action: options.action,
		revision:
			options.revision ??
			state.ownershipRevision ??
			state.preparedRevision ??
			null,
		generation: (options.generation ?? state.generation).toString(),
		observedAt: new Date().toISOString(),
		coreState: serializeCoreState(state)
	};
}

function serializeCoreState(state: Awaited<ReturnType<typeof getState>>) {
	return {
		id: state.id,
		ownership: state.ownership,
		sourceProducersEnabled: state.sourceProducersEnabled,
		legacyRoutesEnabled: state.legacyRoutesEnabled,
		schedulerEnabled: state.schedulerEnabled,
		legacyConsumerEnabled: state.legacyConsumerEnabled,
		projectionConsumerEnabled: state.projectionConsumerEnabled,
		generation: state.generation.toString(),
		preparedRevision: state.preparedRevision,
		ownershipRevision: state.ownershipRevision,
		activatedAt: state.activatedAt?.toISOString() ?? null,
		updatedAt: state.updatedAt.toISOString()
	};
}

async function getTransactionTime(
	database: Prisma.TransactionClient
): Promise<Date> {
	const rows = await database.$queryRaw<TransactionTimeRow[]>(
		Prisma.sql`SELECT transaction_timestamp() AS "value"`
	);
	if (!(rows[0]?.value instanceof Date)) {
		throw new CutoverCliError('Database transaction time is unavailable');
	}
	return rows[0].value;
}

async function getSequenceHighWater(
	database: Prisma.TransactionClient,
	sequence: 'reporting_source_sequence' | 'billing_source_sequence'
): Promise<bigint> {
	const rows =
		sequence === 'reporting_source_sequence'
			? await database.$queryRaw<SequenceRow[]>(
					Prisma.sql`
						SELECT CASE WHEN "is_called" THEN "last_value" ELSE 0 END AS "value"
						FROM "reporting_source_sequence"
					`
				)
			: await database.$queryRaw<SequenceRow[]>(
					Prisma.sql`
						SELECT CASE WHEN "is_called" THEN "last_value" ELSE 0 END AS "value"
						FROM "billing_source_sequence"
					`
				);
	if (typeof rows[0]?.value !== 'bigint' || rows[0].value < 0n) {
		throw new CutoverCliError('Billing source high-water is unavailable');
	}
	return rows[0].value;
}

function normalizeLegacySnapshotRows(
	rows: Array<Record<string, unknown>>
): LegacySnapshotRow[] {
	return rows.map(row => {
		const normalized = Object.fromEntries(
			Object.entries(row).map(([key, value]) => [
				key.replace(/_([a-z])/g, (_, letter: string) =>
					letter.toUpperCase()
				),
				value
			])
		);
		if (typeof normalized.id !== 'string' || !normalized.id) {
			throw new CutoverCliError(
				'Billing legacy snapshot row ID is invalid'
			);
		}
		return normalized as LegacySnapshotRow;
	});
}

async function legacySnapshotRows(
	transaction: Prisma.TransactionClient,
	table:
		| 'payments'
		| 'payment_receipts'
		| 'subscriptions'
		| 'subscription_history'
		| 'subscription_expiry_reminders'
		| 'auto_renewals'
		| 'auto_renewal_consent_events'
		| 'tariff_prices'
		| 'affiliate_referrals'
): Promise<LegacySnapshotRow[]> {
	let rows: Array<Record<string, unknown>>;
	switch (table) {
		case 'payments':
			rows = await transaction.$queryRaw(Prisma.sql`
				SELECT * FROM "payments" ORDER BY "id"
			`);
			break;
		case 'payment_receipts':
			rows = await transaction.$queryRaw(Prisma.sql`
				SELECT * FROM "payment_receipts" ORDER BY "id"
			`);
			break;
		case 'subscriptions':
			rows = await transaction.$queryRaw(Prisma.sql`
				SELECT * FROM "subscriptions" ORDER BY "id"
			`);
			break;
		case 'subscription_history':
			rows = await transaction.$queryRaw(Prisma.sql`
				SELECT * FROM "subscription_history" ORDER BY "id"
			`);
			break;
		case 'subscription_expiry_reminders':
			rows = await transaction.$queryRaw(Prisma.sql`
				SELECT * FROM "subscription_expiry_reminders" ORDER BY "id"
			`);
			break;
		case 'auto_renewals':
			rows = await transaction.$queryRaw(Prisma.sql`
				SELECT * FROM "auto_renewals" ORDER BY "id"
			`);
			break;
		case 'auto_renewal_consent_events':
			rows = await transaction.$queryRaw(Prisma.sql`
				SELECT * FROM "auto_renewal_consent_events" ORDER BY "id"
			`);
			break;
		case 'tariff_prices':
			rows = await transaction.$queryRaw(Prisma.sql`
				SELECT * FROM "tariff_prices" ORDER BY "id"
			`);
			break;
		case 'affiliate_referrals':
			rows = await transaction.$queryRaw(Prisma.sql`
				SELECT * FROM "affiliate_referrals" ORDER BY "id"
			`);
			break;
	}
	return normalizeLegacySnapshotRows(rows);
}

async function buildFrozenSnapshot(
	transaction: Prisma.TransactionClient,
	options: RequiredIdentity,
	state: Awaited<ReturnType<typeof getState>>,
	sourceCutoff: Date
): Promise<Record<string, unknown>> {
	const reportingHighWater = await getSequenceHighWater(
		transaction,
		'reporting_source_sequence'
	);
	const billingHighWater = await getSequenceHighWater(
		transaction,
		'billing_source_sequence'
	);
	const reportingVersions =
		await transaction.reportingProjectionVersion.findMany({
			where: {
				aggregateType: {
					in: ['billing.payment', 'billing.subscription']
				}
			},
			orderBy: [{ aggregateType: 'asc' }, { aggregateId: 'asc' }]
		});
	const billingVersions =
		await transaction.billingSourceAggregateVersion.findMany({
			where: {
				aggregateType: { in: [...BILLING_SOURCE_AGGREGATE_TYPES] }
			},
			orderBy: [{ aggregateType: 'asc' }, { aggregateId: 'asc' }]
		});
	const users = await transaction.user.findMany({
		orderBy: { id: 'asc' },
		select: {
			id: true,
			name: true,
			status: true,
			deletedAt: true,
			rights: true,
			createdAt: true,
			updatedAt: true,
			authIdentities: {
				where: {
					type: { in: [AuthIdentityType.EMAIL, AuthIdentityType.PHONE] }
				},
				orderBy: { createdAt: 'asc' },
				select: { type: true, value: true }
			},
			telegramNotificationChannel: {
				select: { chatId: true, isActive: true }
			}
		}
	});
	const telegramSettings = await transaction.telegramBotSettings.findMany({
		orderBy: { id: 'asc' },
		select: {
			id: true,
			dailySummaryChatId: true,
			paymentsThreadId: true,
			updatedAt: true
		}
	});
	const [siteSettingsRow] = await transaction.$queryRaw<
		LegacyBillingSettingsSnapshot[]
	>(Prisma.sql`
			SELECT "id",
			       "payment_enabled" AS "paymentEnabled",
			       "auto_renewal_signup_enabled" AS "autoRenewalSignupEnabled",
			       "auto_renewal_charges_enabled" AS "autoRenewalChargesEnabled",
			       "auto_renewal_charges_enabled_at" AS "autoRenewalChargesEnabledAt",
			       "affiliate_program_enabled" AS "affiliateProgramEnabled",
			       "affiliate_cashback_percent" AS "affiliateCashbackPercent",
			       "updated_at" AS "updatedAt"
			FROM "site_settings"
			WHERE "id" = 'singleton'
		`);
	const siteSettings = requireBillingSettingsSnapshot(
		siteSettingsRow ?? null
	);
	const offer = await transaction.legalPage.findUnique({
		where: { slug: 'oferta' }
	});
	const offerSnapshot = serializeBillingOfferSnapshot(offer);
	// These relations are deliberately absent from the post-cleanup Prisma
	// schema. The historical freeze exporter remains source-compatible through
	// exact raw reads while the relations exist, and fails closed at PostgreSQL
	// once the destructive cleanup migration removes them.
	const payments = await legacySnapshotRows(transaction, 'payments');
	const paymentReceipts = await legacySnapshotRows(
		transaction,
		'payment_receipts'
	);
	const subscriptions = await legacySnapshotRows(
		transaction,
		'subscriptions'
	);
	const subscriptionHistory = await legacySnapshotRows(
		transaction,
		'subscription_history'
	);
	const subscriptionExpiryReminders = await legacySnapshotRows(
		transaction,
		'subscription_expiry_reminders'
	);
	const autoRenewals = await legacySnapshotRows(
		transaction,
		'auto_renewals'
	);
	const autoRenewalConsentEvents = await legacySnapshotRows(
		transaction,
		'auto_renewal_consent_events'
	);
	const tariffPrices = await legacySnapshotRows(
		transaction,
		'tariff_prices'
	);
	const affiliateReferrals = await legacySnapshotRows(
		transaction,
		'affiliate_referrals'
	);
	const integrationDeliveryFailures =
		await transaction.integrationDeliveryFailure.findMany({
			where: { integration: 'auto-renewal' },
			orderBy: { id: 'asc' }
		});
	const integrationDeliveryReceipts =
		await transaction.integrationDeliveryReceipt.findMany({
			where: { integration: 'auto-renewal' },
			orderBy: { id: 'asc' }
		});
	assertUniqueSnapshotIds('identity', users);
	assertUniqueSnapshotIds('notificationRouting', telegramSettings);
	assertUniqueSnapshotIds('payments', payments);
	assertUniqueSnapshotIds('paymentReceipts', paymentReceipts);
	assertUniqueSnapshotIds('subscriptions', subscriptions);
	assertUniqueSnapshotIds('subscriptionHistory', subscriptionHistory);
	assertUniqueSnapshotIds(
		'subscriptionExpiryReminders',
		subscriptionExpiryReminders
	);
	assertUniqueSnapshotIds('autoRenewals', autoRenewals);
	assertUniqueSnapshotIds(
		'autoRenewalConsentEvents',
		autoRenewalConsentEvents
	);
	assertUniqueSnapshotIds('tariffPrices', tariffPrices);
	assertUniqueSnapshotIds('affiliateReferrals', affiliateReferrals);
	assertAutoRenewalDeliveryTransfer(
		integrationDeliveryFailures,
		integrationDeliveryReceipts
	);
	assertBillingSnapshotContinuity({
		versions: billingVersions,
		reportingVersions,
		identityIds: users.map(user => user.id),
		notificationRoutingIds: telegramSettings.map(item => item.id),
		settingsIds: [siteSettings.id],
		paymentIds: payments.map(payment => payment.id),
		subscriptionIds: subscriptions.map(subscription => subscription.id),
		offerRequired: true
	});
	const maxHighWater =
		reportingHighWater > billingHighWater
			? reportingHighWater
			: billingHighWater;

	return {
		schemaVersion: 1,
		action: 'freeze-export',
		revision: options.revision,
		generation: options.generation.toString(),
		frozenAt: sourceCutoff.toISOString(),
		sourceCutoff: sourceCutoff.toISOString(),
		coreState: serializeCoreState(state),
		continuity: {
			reportingHighWater: reportingHighWater.toString(),
			billingHighWater: billingHighWater.toString(),
			maxHighWater: maxHighWater.toString(),
			nextSourceSequence: (maxHighWater + 1n).toString(),
			entityCounts: {
				identity: users.length,
				notificationRouting: telegramSettings.length,
				settings: 1,
				offer: 1,
				payments: payments.length,
				paymentReceipts: paymentReceipts.length,
				subscriptions: subscriptions.length,
				subscriptionHistory: subscriptionHistory.length,
				subscriptionExpiryReminders: subscriptionExpiryReminders.length,
				autoRenewals: autoRenewals.length,
				autoRenewalConsentEvents: autoRenewalConsentEvents.length,
				tariffPrices: tariffPrices.length,
				affiliateReferrals: affiliateReferrals.length,
				integrationDeliveryFailures: integrationDeliveryFailures.length,
				integrationDeliveryReceipts: integrationDeliveryReceipts.length
			},
			reportingAggregateVersions: reportingVersions.map(item => ({
				aggregateType: item.aggregateType,
				aggregateId: item.aggregateId,
				aggregateVersion: item.version.toString(),
				lastSourceSequence: item.sourceSequence.toString()
			})),
			billingAggregateVersions: billingVersions.map(item => ({
				aggregateType: item.aggregateType,
				aggregateId: item.aggregateId,
				aggregateVersion: item.version.toString(),
				lastSourceSequence: item.sourceSequence.toString()
			}))
		},
		identity: users.map(user => {
			const email = user.authIdentities.find(
				identity => identity.type === AuthIdentityType.EMAIL
			)?.value;
			const phone = user.authIdentities.find(
				identity => identity.type === AuthIdentityType.PHONE
			)?.value;
			const channel = user.telegramNotificationChannel;
			return {
				id: user.id,
				name: user.name,
				email: email?.trim() || null,
				phone: phone?.trim() || null,
				status: user.status,
				deletedAt: user.deletedAt,
				roles: [...user.rights].sort(),
				telegramChatId:
					channel?.isActive && channel.chatId.trim()
						? channel.chatId.trim()
						: null,
				telegramChannelActive: channel?.isActive ?? false,
				createdAt: user.createdAt,
				updatedAt: user.updatedAt
			};
		}),
		notificationRouting: telegramSettings.map(item => ({
			id: item.id,
			telegramChatId: item.dailySummaryChatId.trim() || null,
			paymentsThreadId: item.paymentsThreadId,
			updatedAt: item.updatedAt
		})),
		settings: {
			id: siteSettings.id,
			paymentEnabled: siteSettings.paymentEnabled,
			autoRenewalSignupEnabled: siteSettings.autoRenewalSignupEnabled,
			autoRenewalChargesEnabled: siteSettings.autoRenewalChargesEnabled,
			autoRenewalChargesEnabledAt:
				siteSettings.autoRenewalChargesEnabledAt,
			affiliateProgramEnabled: siteSettings.affiliateProgramEnabled,
			affiliateCashbackPercent: siteSettings.affiliateCashbackPercent,
			updatedAt: siteSettings.updatedAt
		},
		offer: offerSnapshot,
		payments,
		paymentReceipts,
		subscriptions,
		subscriptionHistory,
		subscriptionExpiryReminders,
		autoRenewals,
		autoRenewalConsentEvents,
		tariffPrices,
		affiliateReferrals,
		integrationDeliveryFailures,
		integrationDeliveryReceipts
	};
}

export function serializeBillingOfferSnapshot(
	offer: { content: string; updatedAt: Date } | null
): {
	id: 'offer';
	content: string;
	sha256: string;
	updatedAt: Date;
	consentVersion: string;
	consentText: string;
} {
	if (!offer) {
		throw new CutoverCliError('Billing offer snapshot is missing');
	}
	return {
		id: 'offer',
		content: offer.content,
		sha256: createHash('sha256')
			.update(offer.content, 'utf8')
			.digest('hex'),
		updatedAt: offer.updatedAt,
		consentVersion: AUTO_RENEWAL_CONSENT_VERSION,
		consentText: AUTO_RENEWAL_CONSENT_TEXT
	};
}

export function requireBillingSettingsSnapshot<T>(settings: T | null): T {
	if (!settings) {
		throw new CutoverCliError('Billing settings snapshot is missing');
	}
	return settings;
}

export function assertBillingSnapshotContinuity(input: {
	versions: Array<{
		aggregateType: string;
		aggregateId: string;
		version: bigint;
		sourceSequence: bigint;
	}>;
	reportingVersions: Array<{
		aggregateType: string;
		aggregateId: string;
		version: bigint;
		sourceSequence: bigint;
	}>;
	identityIds: string[];
	notificationRoutingIds: string[];
	settingsIds: string[];
	paymentIds: string[];
	subscriptionIds: string[];
	offerRequired: boolean;
}): void {
	const versions = new Map(
		input.versions.map(item => [
			`${item.aggregateType}\0${item.aggregateId}`,
			item
		])
	);
	const required = [
		...input.identityIds.map(
			aggregateId => ['billing.identity', aggregateId] as const
		),
		...input.notificationRoutingIds.map(
			aggregateId => ['billing.notification-routing', aggregateId] as const
		),
		...input.settingsIds.map(
			aggregateId => ['billing.settings', aggregateId] as const
		),
		...(input.offerRequired ? ([['billing.offer', 'offer']] as const) : [])
	];
	for (const [aggregateType, aggregateId] of required) {
		const item = versions.get(`${aggregateType}\0${aggregateId}`);
		if (!item || item.version < 1n || item.sourceSequence < 1n) {
			throw new CutoverCliError(
				`Billing snapshot continuity is missing for ${aggregateType}/${aggregateId}`
			);
		}
	}
	const reportingVersions = new Map(
		input.reportingVersions.map(item => [
			`${item.aggregateType}\0${item.aggregateId}`,
			item
		])
	);
	for (const [aggregateType, aggregateId] of [
		...input.paymentIds.map(
			aggregateId => ['billing.payment', aggregateId] as const
		),
		...input.subscriptionIds.map(
			aggregateId => ['billing.subscription', aggregateId] as const
		)
	]) {
		const item = reportingVersions.get(`${aggregateType}\0${aggregateId}`);
		if (!item || item.version < 1n || item.sourceSequence < 1n) {
			throw new CutoverCliError(
				`Billing snapshot continuity is missing for ${aggregateType}/${aggregateId}`
			);
		}
	}
}

function assertUniqueSnapshotIds(
	name: string,
	items: Array<{ id: string }>
): void {
	const ids = new Set<string>();
	for (const item of items) {
		if (!item.id || ids.has(item.id)) {
			throw new CutoverCliError(
				`Billing snapshot ${name} primary IDs are not unique`
			);
		}
		ids.add(item.id);
	}
}

export function assertAutoRenewalDeliveryTransfer(
	failures: Array<{
		id: string;
		eventId: string;
		integration: string;
		retryingAt: Date | null;
		activeRetryToken: string | null;
	}>,
	receipts: Array<{
		id: string;
		eventId: string;
		integration: string;
		status: string;
	}>
): void {
	assertUniqueSnapshotIds('integrationDeliveryFailures', failures);
	assertUniqueSnapshotIds('integrationDeliveryReceipts', receipts);
	const failurePairs = new Set<string>();
	for (const failure of failures) {
		const pair = `${failure.eventId}\0${failure.integration}`;
		if (
			!UUID_PATTERN.test(failure.id) ||
			!UUID_PATTERN.test(failure.eventId) ||
			failure.integration !== 'auto-renewal' ||
			failurePairs.has(pair)
		) {
			throw new CutoverCliError(
				'Billing snapshot auto-renewal failures are inconsistent'
			);
		}
		if (failure.retryingAt || failure.activeRetryToken) {
			throw new CutoverCliError(
				'Billing snapshot has an active auto-renewal failure retry'
			);
		}
		failurePairs.add(pair);
	}
	const receiptPairs = new Set<string>();
	for (const receipt of receipts) {
		const pair = `${receipt.eventId}\0${receipt.integration}`;
		if (
			!UUID_PATTERN.test(receipt.id) ||
			!UUID_PATTERN.test(receipt.eventId) ||
			receipt.integration !== 'auto-renewal' ||
			receiptPairs.has(pair)
		) {
			throw new CutoverCliError(
				'Billing snapshot auto-renewal receipts are inconsistent'
			);
		}
		if (receipt.status === 'PROCESSING') {
			throw new CutoverCliError(
				'Billing snapshot has an active auto-renewal receipt lease'
			);
		}
		receiptPairs.add(pair);
	}
}

function omitSnapshotIdentity(
	document: Record<string, unknown>
): Record<string, unknown> {
	const payload = { ...document };
	delete payload.schemaVersion;
	delete payload.action;
	delete payload.revision;
	delete payload.generation;
	delete payload.frozenAt;
	delete payload.sourceCutoff;
	return payload;
}

export async function calculateProjectionLag(
	transaction: Prisma.TransactionClient
): Promise<{ total: bigint; row: ProjectionLagRow }> {
	const rows = await transaction.$queryRaw<ProjectionLagRow[]>(Prisma.sql`
		SELECT
			(SELECT COUNT(*) FROM "payments") AS "legacyPayments",
			(SELECT COUNT(*) FROM "billing_payment_read_projections") AS "projectedPayments",
			(
				SELECT COUNT(*)
				FROM "payments" AS legacy
				FULL OUTER JOIN "billing_payment_read_projections" AS projected
					ON projected."id" = legacy."id"
				WHERE legacy."id" IS NULL OR projected."id" IS NULL
			) AS "paymentIdLag",
			(
				SELECT COUNT(*)
				FROM "payments" AS legacy
				JOIN "billing_payment_read_projections" AS projected
					ON projected."id" = legacy."id"
				LEFT JOIN "reporting_projection_versions" AS version
					ON version."aggregate_type" = 'billing.payment'
					AND version."aggregate_id" = legacy."id"
				WHERE projected."source_version" < COALESCE(version."version", 1)
					OR projected."source_sequence" IS NULL
			) AS "paymentVersionLag",
			(SELECT COUNT(*) FROM "subscriptions") AS "legacySubscriptions",
			(SELECT COUNT(*) FROM "billing_subscription_read_projections") AS "projectedSubscriptions",
			(
				SELECT COUNT(*)
				FROM "subscriptions" AS legacy
				FULL OUTER JOIN "billing_subscription_read_projections" AS projected
					ON projected."id" = legacy."id"
				WHERE legacy."id" IS NULL OR projected."id" IS NULL
			) AS "subscriptionIdLag",
			(
				SELECT COUNT(*)
				FROM "subscriptions" AS legacy
				JOIN "billing_subscription_read_projections" AS projected
					ON projected."id" = legacy."id"
				LEFT JOIN "reporting_projection_versions" AS version
					ON version."aggregate_type" = 'billing.subscription'
					AND version."aggregate_id" = legacy."id"
				WHERE projected."source_version" < COALESCE(version."version", 1)
					OR projected."source_sequence" IS NULL
			) AS "subscriptionVersionLag",
			(SELECT COUNT(*) FROM "affiliate_referrals") AS "legacyAffiliates",
			(SELECT COUNT(*) FROM "billing_affiliate_read_projections") AS "projectedAffiliates",
			(
				SELECT COUNT(*)
				FROM "affiliate_referrals" AS legacy
				FULL OUTER JOIN "billing_affiliate_read_projections" AS projected
					ON projected."id" = legacy."id"
				WHERE legacy."id" IS NULL OR projected."id" IS NULL
			) AS "affiliateIdLag",
			(
				SELECT COUNT(*)
				FROM "billing_affiliate_read_projections"
				WHERE "source_version" < 1 OR "source_sequence" IS NULL
			) AS "affiliateVersionLag",
			(SELECT COUNT(*) FROM "site_settings" WHERE "id" = 'singleton') AS "legacySettings",
			(SELECT COUNT(*) FROM "billing_settings_read_projection" WHERE "id" = 'singleton') AS "projectedSettings",
			(
				SELECT
					CASE
						WHEN
							(SELECT COUNT(*) FROM "site_settings" WHERE "id" = 'singleton') = 1
							AND (SELECT COUNT(*) FROM "billing_settings_read_projection" WHERE "id" = 'singleton') = 1
						THEN 0::BIGINT
						ELSE 1::BIGINT
					END
			) AS "settingsIdLag",
			(
				SELECT COUNT(*)
				FROM "billing_settings_read_projection" AS projected
				LEFT JOIN "billing_source_aggregate_versions" AS version
					ON version."aggregate_type" = 'billing.settings'
					AND version."aggregate_id" = 'singleton'
				WHERE projected."id" = 'singleton'
					AND (
						projected."source_version" < COALESCE(version."version", 1)
						OR projected."source_sequence" IS NULL
					)
			) AS "settingsVersionLag"
	`);
	const row = rows[0];
	if (!row) {
		throw new CutoverCliError('Billing projection lag query failed');
	}
	const total =
		absDifference(row.legacyPayments, row.projectedPayments) +
		row.paymentIdLag +
		row.paymentVersionLag +
		absDifference(row.legacySubscriptions, row.projectedSubscriptions) +
		row.subscriptionIdLag +
		row.subscriptionVersionLag +
		absDifference(row.legacyAffiliates, row.projectedAffiliates) +
		row.affiliateIdLag +
		row.affiliateVersionLag +
		row.settingsIdLag +
		row.settingsVersionLag;
	return { total, row };
}

function projectionEvidence(
	options: RequiredIdentity,
	state: Awaited<ReturnType<typeof getState>>,
	lag: { total: bigint; row: ProjectionLagRow }
): Record<string, unknown> {
	return {
		...evidence(options, state),
		lag: Number(lag.total),
		eventTypes: [...PROJECTION_EVENT_TYPES],
		details: toJsonObject(lag.row as unknown as Record<string, unknown>)
	};
}

function absDifference(left: bigint, right: bigint): bigint {
	return left >= right ? left - right : right - left;
}

function toJsonObject(
	value: Record<string, unknown>
): Record<string, unknown> {
	return JSON.parse(
		JSON.stringify(value, (_key, item) =>
			typeof item === 'bigint' ? item.toString() : item
		)
	) as Record<string, unknown>;
}

async function writeAtomicJson(
	file: string,
	document: Record<string, unknown>
): Promise<void> {
	const directory = dirname(file);
	const directoryStat = await lstat(directory).catch(() => null);
	if (!directoryStat?.isDirectory() || directoryStat.isSymbolicLink()) {
		throw new CutoverCliError('Output directory is unavailable');
	}
	const existing = await lstat(file).catch(() => null);
	if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
		throw new CutoverCliError('Output file target is unsafe');
	}
	const temporary = join(
		directory,
		`.${basename(file)}.${randomUUID()}.tmp`
	);
	let handle: Awaited<ReturnType<typeof open>> | null = null;
	try {
		handle = await open(temporary, 'wx', 0o600);
		await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, {
			encoding: 'utf8'
		});
		await handle.sync();
		await handle.close();
		handle = null;
		await rename(temporary, file);
		await chmod(file, 0o600);
	} catch (error) {
		await handle?.close().catch(() => undefined);
		await unlink(temporary).catch(() => undefined);
		if (error instanceof CutoverCliError) throw error;
		throw new CutoverCliError('Atomic evidence write failed');
	}
}

async function main(): Promise<void> {
	let options: BillingCoreCutoverOptions;
	try {
		options = parseBillingCoreCutoverArgs(process.argv.slice(2));
	} catch (error) {
		process.stderr.write(
			`${error instanceof CutoverCliError ? error.message : 'Invalid Billing Core cutover arguments'}\n`
		);
		process.exitCode = 1;
		return;
	}
	const prisma = new PrismaClient();
	try {
		const document = await executeBillingCoreCutover(prisma, options);
		await writeAtomicJson(options.file, document);
	} catch (error) {
		process.stderr.write(
			`${error instanceof CutoverCliError ? error.message : 'Billing Core cutover action failed'}\n`
		);
		process.exitCode = 1;
	} finally {
		await prisma.$disconnect().catch(() => undefined);
	}
}

if (require.main === module) {
	void main();
}
