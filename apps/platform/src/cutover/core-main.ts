import { Prisma, PrismaClient } from '@prisma/platform-client';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import {
	billingOfferFingerprint,
	canonicalJson,
	loadPlatformSnapshot,
	PlatformCutoverError,
	type PlatformCutoverSnapshot,
	snapshotSemanticHash
} from './main';
import { isAutoRenewalOfferCompatible } from '../domain/billing-offer-continuity';

const BILLING_OFFER_CONTRACT_VERSION = 2 as const;
const BILLING_OFFER_SEQUENCE_SCOPE = 'billing.offer:offer' as const;

const ACTIONS = [
	'status',
	'preflight',
	'prepare',
	'fence',
	'export',
	'activate',
	'abort'
] as const;
type Action = (typeof ACTIONS)[number];

type Args = {
	action: Action;
	revision?: string;
	file?: string;
	sha256?: string;
	fingerprint?: string;
	highWatermark?: string;
};

type CoreState = {
	id: string;
	ownership: 'CORE' | 'PLATFORM';
	sourceWritesEnabled: boolean;
	legacyRoutesEnabled: boolean;
	generation: bigint;
	preparedRevision: string | null;
	sourceRevision: string | null;
	ownershipRevision: string | null;
	sourceFingerprint: string | null;
	sourceSnapshotSha256: string | null;
	sourceHighWatermark: bigint | null;
	billingOfferContractVersion: number | null;
	billingOfferSequenceScope: string | null;
	billingOfferAggregateVersion: bigint | null;
	billingOfferSourceSequence: bigint | null;
	billingOfferFenceFingerprint: string | null;
	fencedAt: Date | null;
	exportedAt: Date | null;
	activatedAt: Date | null;
};

type CoreSiteSettings = {
	id: string;
	bannerEnabled: boolean;
	bannerText: string;
	snowflakeEnabled: boolean;
	updatedAt: Date;
};

type CoreLegalPage = {
	slug: string;
	content: string;
	updatedAt: Date;
};

type CoreHomePageContent = {
	id: string;
	content: Prisma.JsonValue;
	updatedAt: Date;
};

type BillingOfferCursor = {
	aggregateVersion: bigint;
	sourceSequence: bigint;
};

const LEGAL_SLUGS = [
	'consent-processing',
	'cookie-notice',
	'oferta',
	'personal-policy'
] as const;

export function parsePlatformCoreArgs(argv: readonly string[]): Args {
	const [rawAction, ...rest] = argv;
	if (!ACTIONS.includes(rawAction as Action)) {
		throw new PlatformCutoverError('Unsupported Platform Core action');
	}
	const action = rawAction as Action;
	if (action === 'status') {
		if (rest.length)
			throw new PlatformCutoverError('status accepts no arguments');
		return { action };
	}
	const options = new Map<string, string>();
	for (let index = 0; index < rest.length; index += 2) {
		const key = rest[index];
		const value = rest[index + 1];
		if (!key?.startsWith('--') || !value || options.has(key)) {
			throw new PlatformCutoverError('Invalid Platform Core arguments');
		}
		options.set(key, value);
	}
	const revision = options.get('--revision');
	if (!revision || !/^[0-9a-f]{40}$/.test(revision)) {
		throw new PlatformCutoverError(
			'Platform Core action requires --revision <40-character-sha>'
		);
	}
	if (
		action === 'preflight' ||
		action === 'prepare' ||
		action === 'fence' ||
		action === 'abort'
	) {
		if (options.size !== 1) {
			throw new PlatformCutoverError(`${action} accepts only --revision`);
		}
		return { action, revision };
	}
	if (action === 'export') {
		const file = options.get('--file');
		if (
			options.size !== 2 ||
			!file ||
			!isAbsolute(file) ||
			file.includes('\0')
		) {
			throw new PlatformCutoverError(
				'export requires --revision and --file <absolute-path>'
			);
		}
		return { action, revision, file };
	}
	const sha256 = options.get('--sha256');
	const fingerprint = options.get('--fingerprint');
	const highWatermark = options.get('--high-watermark');
	const file = options.get('--file');
	if (
		options.size !== 5 ||
		!file ||
		!isAbsolute(file) ||
		file.includes('\0') ||
		!sha256 ||
		!/^[0-9a-f]{64}$/.test(sha256) ||
		!fingerprint ||
		!/^[0-9a-f]{64}$/.test(fingerprint) ||
		!highWatermark ||
		!/^[1-9][0-9]*$/.test(highWatermark)
	) {
		throw new PlatformCutoverError(
			'activate requires --revision, --file, --sha256, --fingerprint and --high-watermark'
		);
	}
	return {
		action,
		revision,
		file,
		sha256,
		fingerprint,
		highWatermark
	};
}

async function state(
	client: PrismaClient | Prisma.TransactionClient
): Promise<CoreState> {
	const rows = await client.$queryRaw<CoreState[]>(Prisma.sql`
		SELECT
			"id",
			"ownership",
			"source_writes_enabled" AS "sourceWritesEnabled",
			"legacy_routes_enabled" AS "legacyRoutesEnabled",
			"generation",
			"prepared_revision" AS "preparedRevision",
			"source_revision" AS "sourceRevision",
			"ownership_revision" AS "ownershipRevision",
			"source_fingerprint" AS "sourceFingerprint",
			"source_snapshot_sha256" AS "sourceSnapshotSha256",
			"source_high_watermark" AS "sourceHighWatermark",
			"billing_offer_contract_version" AS "billingOfferContractVersion",
			"billing_offer_sequence_scope" AS "billingOfferSequenceScope",
			"billing_offer_aggregate_version" AS "billingOfferAggregateVersion",
			"billing_offer_source_sequence" AS "billingOfferSourceSequence",
			"billing_offer_fence_fingerprint" AS "billingOfferFenceFingerprint",
			"fenced_at" AS "fencedAt",
			"exported_at" AS "exportedAt",
			"activated_at" AS "activatedAt"
		FROM "public"."platform_core_state"
		WHERE "id" = 'singleton'
	`);
	if (rows.length !== 1 || rows[0]!.id !== 'singleton') {
		throw new PlatformCutoverError('Platform Core state is missing');
	}
	return rows[0]!;
}

async function lockState(transaction: Prisma.TransactionClient) {
	await transaction.$queryRaw`
		SELECT "id" FROM "public"."platform_core_state"
		WHERE "id" = 'singleton' FOR UPDATE
	`;
}

type CoreSourceAnchors = {
	site: CoreSiteSettings;
	legal: CoreLegalPage[];
	home: CoreHomePageContent;
	offer: BillingOfferCursor;
};

async function loadCoreSourceAnchors(
	client: PrismaClient | Prisma.TransactionClient
): Promise<CoreSourceAnchors> {
	const [site, legal, home, offer] = await Promise.all([
		client.$queryRaw<CoreSiteSettings[]>(Prisma.sql`
			SELECT "id", "banner_enabled" AS "bannerEnabled",
				"banner_text" AS "bannerText",
				"snowflake_enabled" AS "snowflakeEnabled",
				"updated_at" AS "updatedAt"
			FROM "public"."site_settings" ORDER BY "id" ASC
		`),
		client.$queryRaw<CoreLegalPage[]>(Prisma.sql`
			SELECT "slug", "content", "updated_at" AS "updatedAt"
			FROM "public"."legal_pages" ORDER BY "slug" ASC
		`),
		client.$queryRaw<CoreHomePageContent[]>(Prisma.sql`
			SELECT "id", "content", "updated_at" AS "updatedAt"
			FROM "public"."home_page_content" ORDER BY "id" ASC
		`),
		client.$queryRaw<BillingOfferCursor[]>(Prisma.sql`
			SELECT "version" AS "aggregateVersion",
				"source_sequence" AS "sourceSequence"
			FROM "public"."billing_source_aggregate_versions"
			WHERE "aggregate_type" = 'billing.offer'
				AND "aggregate_id" = 'offer'
		`)
	]);
	if (
		site.length !== 1 ||
		site[0]!.id !== 'singleton' ||
		legal.length !== LEGAL_SLUGS.length ||
		legal.some((page, index) => page.slug !== LEGAL_SLUGS[index]) ||
		home.length !== 1 ||
		home[0]!.id !== 'singleton' ||
		offer.length !== 1 ||
		offer[0]!.aggregateVersion < 1n ||
		offer[0]!.sourceSequence < 1n
	) {
		throw new PlatformCutoverError(
			'Platform Core source anchors are incomplete'
		);
	}
	const oferta = legal.find(page => page.slug === 'oferta')!;
	if (!isAutoRenewalOfferCompatible(oferta.content)) {
		throw new PlatformCutoverError(
			'Platform Core oferta is incompatible with the Billing consent contract'
		);
	}
	return {
		site: site[0]!,
		legal,
		home: home[0]!,
		offer: offer[0]!
	};
}

function billingOfferProducer(anchors: CoreSourceAnchors) {
	const oferta = anchors.legal.find(page => page.slug === 'oferta')!;
	const contract = {
		contractVersion: BILLING_OFFER_CONTRACT_VERSION,
		sequenceScope: BILLING_OFFER_SEQUENCE_SCOPE,
		aggregateVersion: anchors.offer.aggregateVersion.toString(),
		sourceSequence: anchors.offer.sourceSequence.toString()
	};
	return {
		...contract,
		fingerprint: billingOfferFingerprint(oferta.content, contract)
	};
}

function assertBillingOfferFence(
	current: CoreState,
	producer: ReturnType<typeof billingOfferProducer>
) {
	if (
		current.billingOfferContractVersion !== producer.contractVersion ||
		current.billingOfferSequenceScope !== producer.sequenceScope ||
		current.billingOfferAggregateVersion !==
			BigInt(producer.aggregateVersion) ||
		current.billingOfferSourceSequence !==
			BigInt(producer.sourceSequence) ||
		current.billingOfferFenceFingerprint !== producer.fingerprint
	) {
		throw new PlatformCutoverError(
			'Platform Core Billing offer fence differs from the exact frozen cursor'
		);
	}
}

function exportAnchorState(current: CoreState): 'absent' | 'complete' {
	const anchors = [
		current.sourceRevision,
		current.sourceFingerprint,
		current.sourceSnapshotSha256,
		current.sourceHighWatermark,
		current.exportedAt
	];
	if (anchors.every(value => value === null)) return 'absent';
	if (anchors.every(value => value !== null)) return 'complete';
	throw new PlatformCutoverError(
		'Platform Core durable export anchors are partially written'
	);
}

function billingOfferFenceState(
	current: CoreState
): 'absent' | 'complete' {
	const anchors = [
		current.billingOfferContractVersion,
		current.billingOfferSequenceScope,
		current.billingOfferAggregateVersion,
		current.billingOfferSourceSequence,
		current.billingOfferFenceFingerprint
	];
	if (anchors.every(value => value === null)) return 'absent';
	if (anchors.every(value => value !== null)) return 'complete';
	throw new PlatformCutoverError(
		'Platform Core Billing offer fence is partially written'
	);
}

async function preflight(client: PrismaClient, revision: string) {
	const current = await state(client);
	if (
		current.ownership !== 'CORE' ||
		!current.sourceWritesEnabled ||
		!current.legacyRoutesEnabled ||
		billingOfferFenceState(current) !== 'absent' ||
		exportAnchorState(current) !== 'absent' ||
		(current.preparedRevision !== null &&
			current.preparedRevision !== revision)
	) {
		throw new PlatformCutoverError(
			'Platform Core preflight requires an open compatible CORE source'
		);
	}
	const anchors = await loadCoreSourceAnchors(client);
	return {
		ok: true,
		action: 'preflight',
		revision,
		counts: { siteSettings: 1, legalPages: 4, homePageContent: 1 },
		billingOfferProducer: {
			...billingOfferProducer(anchors)
		}
	};
}

async function prepare(client: PrismaClient, revision: string) {
	return client
		.$transaction(
			async transaction => {
				await lockState(transaction);
				const current = await state(transaction);
				if (
					current.ownership !== 'CORE' ||
					!current.sourceWritesEnabled ||
					billingOfferFenceState(current) !== 'absent' ||
					exportAnchorState(current) !== 'absent'
				) {
					throw new PlatformCutoverError(
						'Platform Core prepare requires an open CORE source'
					);
				}
				if (current.preparedRevision) {
					if (current.preparedRevision !== revision) {
						throw new PlatformCutoverError(
							'Platform Core was prepared for another revision'
						);
					}
					return { duplicate: true };
				}
				const changed = await transaction.$executeRaw`
				UPDATE "public"."platform_core_state"
				SET "prepared_revision" = ${revision}
				WHERE "id" = 'singleton'
					AND "ownership" = 'CORE'::"public"."PlatformCoreOwnership"
					AND "source_writes_enabled" = TRUE
					AND "prepared_revision" IS NULL
					AND "billing_offer_contract_version" IS NULL
					AND "source_revision" IS NULL
			`;
				if (changed !== 1) {
					throw new PlatformCutoverError(
						'Platform Core prepare lost its CAS boundary'
					);
				}
				return { duplicate: false };
			},
			{ isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
		)
		.then(result => ({
			ok: true,
			action: 'prepare',
			revision,
			...result
		}));
}

async function fence(client: PrismaClient, revision: string) {
	return client
		.$transaction(
			async transaction => {
				await lockState(transaction);
				const current = await state(transaction);
				if (
					current.ownership !== 'CORE' ||
					current.preparedRevision !== revision
				) {
					throw new PlatformCutoverError(
						'Platform Core fence requires the exact prepared revision'
					);
				}
				const anchors = await loadCoreSourceAnchors(transaction);
				const producer = billingOfferProducer(anchors);
				if (!current.sourceWritesEnabled) {
					if (
						!current.fencedAt ||
						billingOfferFenceState(current) !== 'complete'
					) {
						throw new PlatformCutoverError(
							'Platform Core fence marker is invalid'
						);
					}
					assertBillingOfferFence(current, producer);
					return {
						duplicate: true,
						fencedAt: current.fencedAt.toISOString(),
						billingOfferProducer: producer
					};
				}
				if (
					billingOfferFenceState(current) !== 'absent' ||
					exportAnchorState(current) !== 'absent'
				) {
					throw new PlatformCutoverError(
						'Platform Core fence requires empty producer and export anchors'
					);
				}
				const fencedAt = new Date();
				const changed = await transaction.$executeRaw`
					UPDATE "public"."platform_core_state"
					SET "source_writes_enabled" = FALSE,
						"billing_offer_contract_version" = ${producer.contractVersion},
						"billing_offer_sequence_scope" = ${producer.sequenceScope},
						"billing_offer_aggregate_version" = ${BigInt(producer.aggregateVersion)},
						"billing_offer_source_sequence" = ${BigInt(producer.sourceSequence)},
						"billing_offer_fence_fingerprint" = ${producer.fingerprint},
						"fenced_at" = ${fencedAt}
					WHERE "id" = 'singleton'
						AND "ownership" = 'CORE'::"public"."PlatformCoreOwnership"
						AND "source_writes_enabled" = TRUE
						AND "prepared_revision" = ${revision}
						AND "billing_offer_contract_version" IS NULL
						AND "billing_offer_sequence_scope" IS NULL
						AND "billing_offer_aggregate_version" IS NULL
						AND "billing_offer_source_sequence" IS NULL
						AND "billing_offer_fence_fingerprint" IS NULL
						AND "source_revision" IS NULL
						AND "source_fingerprint" IS NULL
						AND "source_snapshot_sha256" IS NULL
						AND "source_high_watermark" IS NULL
						AND "exported_at" IS NULL
				`;
				if (changed !== 1) {
					throw new PlatformCutoverError(
						'Platform Core fence lost its CAS boundary'
					);
				}
				return {
					duplicate: false,
					fencedAt: fencedAt.toISOString(),
					billingOfferProducer: producer
				};
			},
			{ isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
		)
		.then(result => ({ ok: true, action: 'fence', revision, ...result }));
}

function buildSnapshot(
	revision: string,
	anchors: CoreSourceAnchors
): PlatformCutoverSnapshot {
	const value = {
		schemaVersion: 1 as const,
		snapshotId: randomUUID(),
		createdAt: new Date().toISOString(),
		sourceRevision: revision,
		sourceFingerprint: '',
		platformHighWater: '6',
		counts: {
			siteSettings: 1 as const,
			legalPages: 4 as const,
			homePageContent: 1 as const
		},
		siteSettings: {
			...anchors.site,
			id: 'singleton' as const,
			updatedAt: anchors.site.updatedAt.toISOString(),
			aggregateVersion: '1',
			sourceSequence: '1'
		},
		legalPages: anchors.legal.map((page, index) => ({
			...page,
			slug: page.slug as (typeof LEGAL_SLUGS)[number],
			updatedAt: page.updatedAt.toISOString(),
			aggregateVersion: '1',
			sourceSequence: String(index + 2)
		})),
		homePageContent: {
			...anchors.home,
			id: 'singleton' as const,
			content: jsonObject(anchors.home.content),
			updatedAt: anchors.home.updatedAt.toISOString(),
			aggregateVersion: '1',
			sourceSequence: '6'
		},
		billingOfferProducer: billingOfferProducer(anchors)
	} satisfies PlatformCutoverSnapshot;
	value.sourceFingerprint = snapshotSemanticHash(value);
	return value;
}

async function exportSnapshot(
	client: PrismaClient,
	revision: string,
	file: string
) {
	const frozen = await client.$transaction(
		async transaction => {
			await lockState(transaction);
			const current = await state(transaction);
			if (
				current.ownership !== 'CORE' ||
				current.sourceWritesEnabled ||
				current.preparedRevision !== revision ||
				!current.fencedAt ||
				billingOfferFenceState(current) !== 'complete'
			) {
				throw new PlatformCutoverError(
					'Platform Core export requires the exact frozen source'
				);
			}
			const anchors = await loadCoreSourceAnchors(transaction);
			const snapshot = buildSnapshot(revision, anchors);
			assertBillingOfferFence(current, snapshot.billingOfferProducer);
			return {
				snapshot,
				databaseAnchor:
					exportAnchorState(current) === 'complete'
						? {
								revision: current.sourceRevision!,
								sha256: current.sourceSnapshotSha256!,
								fingerprint: current.sourceFingerprint!,
								highWatermark: current.sourceHighWatermark!
							}
						: null
			};
		},
		{ isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
	);
	let fileDuplicate = false;
	let loaded: Awaited<ReturnType<typeof loadPlatformSnapshot>>;
	if (frozen.databaseAnchor) {
		if (
			frozen.databaseAnchor.revision !== revision ||
			frozen.databaseAnchor.fingerprint !==
				frozen.snapshot.sourceFingerprint ||
			frozen.databaseAnchor.highWatermark !==
				BigInt(frozen.snapshot.platformHighWater)
		) {
			throw new PlatformCutoverError(
				'Platform Core durable export anchors differ from the frozen source'
			);
		}
		loaded = await loadPlatformSnapshot(
			file,
			frozen.databaseAnchor.sha256
		);
		fileDuplicate = true;
	} else {
		const bytes = Buffer.from(
			`${canonicalJson(frozen.snapshot)}\n`,
			'utf8'
		);
		try {
			const handle = await open(
				file,
				constants.O_WRONLY |
					constants.O_CREAT |
					constants.O_EXCL |
					(constants.O_NOFOLLOW || 0),
				0o600
			);
			try {
				await handle.writeFile(bytes);
				await handle.sync();
			} finally {
				await handle.close();
			}
			const directoryHandle = await open(
				dirname(file),
				constants.O_RDONLY | (constants.O_DIRECTORY || 0)
			);
			try {
				await directoryHandle.sync();
			} finally {
				await directoryHandle.close();
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
			fileDuplicate = true;
		}
		loaded = await loadPlatformSnapshot(file);
	}
	if (
		loaded.value.sourceRevision !== revision ||
		loaded.value.sourceFingerprint !== frozen.snapshot.sourceFingerprint ||
		canonicalJson(loaded.value.billingOfferProducer) !==
			canonicalJson(frozen.snapshot.billingOfferProducer)
	) {
		throw new PlatformCutoverError(
			'Existing Platform snapshot belongs to another frozen source'
		);
	}
	const databaseAnchorDuplicate = await client.$transaction(
		async transaction => {
			await lockState(transaction);
			const current = await state(transaction);
			if (
				current.ownership !== 'CORE' ||
				current.sourceWritesEnabled ||
				current.preparedRevision !== revision ||
				!current.fencedAt ||
				billingOfferFenceState(current) !== 'complete'
			) {
				throw new PlatformCutoverError(
					'Platform Core export anchor requires the exact frozen source'
				);
			}
			const anchors = await loadCoreSourceAnchors(transaction);
			const expected = buildSnapshot(revision, anchors);
			assertBillingOfferFence(current, expected.billingOfferProducer);
			if (
				loaded.value.sourceFingerprint !== expected.sourceFingerprint ||
				canonicalJson(loaded.value.billingOfferProducer) !==
					canonicalJson(expected.billingOfferProducer)
			) {
				throw new PlatformCutoverError(
					'Platform snapshot no longer matches the exact frozen source'
				);
			}
			const highWatermark = BigInt(loaded.value.platformHighWater);
			if (exportAnchorState(current) === 'complete') {
				if (
					current.sourceRevision !== revision ||
					current.sourceSnapshotSha256 !== loaded.sha256 ||
					current.sourceFingerprint !== loaded.value.sourceFingerprint ||
					current.sourceHighWatermark !== highWatermark
				) {
					throw new PlatformCutoverError(
						'Platform Core durable export anchors reject snapshot tampering'
					);
				}
				return true;
			}
			const exportedAt = new Date();
			const changed = await transaction.$executeRaw`
				UPDATE "public"."platform_core_state"
				SET "source_revision" = ${revision},
					"source_snapshot_sha256" = ${loaded.sha256},
					"source_fingerprint" = ${loaded.value.sourceFingerprint},
					"source_high_watermark" = ${highWatermark},
					"exported_at" = ${exportedAt}
				WHERE "id" = 'singleton'
					AND "ownership" = 'CORE'::"public"."PlatformCoreOwnership"
					AND "source_writes_enabled" = FALSE
					AND "legacy_routes_enabled" = TRUE
					AND "prepared_revision" = ${revision}
					AND "billing_offer_contract_version" = ${BILLING_OFFER_CONTRACT_VERSION}
					AND "billing_offer_sequence_scope" = ${BILLING_OFFER_SEQUENCE_SCOPE}
					AND "billing_offer_aggregate_version" = ${BigInt(expected.billingOfferProducer.aggregateVersion)}
					AND "billing_offer_source_sequence" = ${BigInt(expected.billingOfferProducer.sourceSequence)}
					AND "billing_offer_fence_fingerprint" = ${expected.billingOfferProducer.fingerprint}
					AND "source_revision" IS NULL
					AND "source_snapshot_sha256" IS NULL
					AND "source_fingerprint" IS NULL
					AND "source_high_watermark" IS NULL
					AND "exported_at" IS NULL
			`;
			if (changed !== 1) {
				throw new PlatformCutoverError(
					'Platform Core export anchor lost its serializable CAS boundary'
				);
			}
			return false;
		},
		{ isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
	);
	return {
		ok: true,
		action: 'export',
		revision,
		fileDirectory: dirname(file),
		sha256: loaded.sha256,
		sourceFingerprint: loaded.value.sourceFingerprint,
		platformHighWater: loaded.value.platformHighWater,
		billingOfferProducer: loaded.value.billingOfferProducer,
		duplicate: fileDuplicate && databaseAnchorDuplicate,
		fileDuplicate,
		databaseAnchorDuplicate
	};
}

async function activate(client: PrismaClient, args: Required<Args>) {
	const loaded = await loadPlatformSnapshot(args.file, args.sha256);
	if (
		loaded.value.sourceRevision !== args.revision ||
		loaded.value.sourceFingerprint !== args.fingerprint ||
		loaded.value.platformHighWater !== args.highWatermark
	) {
		throw new PlatformCutoverError(
			'Platform Core activation file differs from CLI anchors'
		);
	}
	return client
		.$transaction(
			async transaction => {
				await lockState(transaction);
				const current = await state(transaction);
				const highWatermark = BigInt(args.highWatermark);
				if (
					billingOfferFenceState(current) !== 'complete' ||
					exportAnchorState(current) !== 'complete' ||
					current.sourceRevision !== args.revision ||
					current.sourceSnapshotSha256 !== args.sha256 ||
					current.sourceFingerprint !== args.fingerprint ||
					current.sourceHighWatermark !== highWatermark ||
					current.billingOfferContractVersion !==
						loaded.value.billingOfferProducer.contractVersion ||
					current.billingOfferSequenceScope !==
						loaded.value.billingOfferProducer.sequenceScope ||
					current.billingOfferAggregateVersion !==
						BigInt(loaded.value.billingOfferProducer.aggregateVersion) ||
					current.billingOfferSourceSequence !==
						BigInt(loaded.value.billingOfferProducer.sourceSequence) ||
					current.billingOfferFenceFingerprint !==
						loaded.value.billingOfferProducer.fingerprint ||
					!current.exportedAt
				) {
					throw new PlatformCutoverError(
						'Platform Core activation arguments differ from durable database anchors'
					);
				}
				if (current.ownership === 'PLATFORM') {
					if (
						current.ownershipRevision !== args.revision ||
						!current.activatedAt ||
						current.activatedAt < current.exportedAt
					) {
						throw new PlatformCutoverError(
							'Active Platform Core boundary differs from requested snapshot'
						);
					}
					return {
						duplicate: true,
						generation: current.generation.toString()
					};
				}
				if (
					current.ownership !== 'CORE' ||
					current.sourceWritesEnabled ||
					current.legacyRoutesEnabled !== true ||
					current.preparedRevision !== args.revision ||
					!current.fencedAt ||
					current.exportedAt < current.fencedAt
				) {
					throw new PlatformCutoverError(
						'Platform Core activation requires the exact frozen boundary'
					);
				}
				const activatedAt = new Date();
				const changed = await transaction.$executeRaw`
				UPDATE "public"."platform_core_state"
					SET "ownership" = 'PLATFORM'::"public"."PlatformCoreOwnership",
						"legacy_routes_enabled" = FALSE,
						"generation" = "generation" + 1,
						"ownership_revision" = ${args.revision},
						"activated_at" = ${activatedAt}
					WHERE "id" = 'singleton'
					AND "ownership" = 'CORE'::"public"."PlatformCoreOwnership"
					AND "source_writes_enabled" = FALSE
						AND "legacy_routes_enabled" = TRUE
						AND "prepared_revision" = ${args.revision}
						AND "source_revision" = ${args.revision}
						AND "source_snapshot_sha256" = ${args.sha256}
						AND "source_fingerprint" = ${args.fingerprint}
						AND "source_high_watermark" = ${highWatermark}
						AND "exported_at" = ${current.exportedAt}
						AND "billing_offer_contract_version" = ${BILLING_OFFER_CONTRACT_VERSION}
						AND "billing_offer_sequence_scope" = ${BILLING_OFFER_SEQUENCE_SCOPE}
						AND "billing_offer_aggregate_version" = ${current.billingOfferAggregateVersion}
						AND "billing_offer_source_sequence" = ${current.billingOfferSourceSequence}
						AND "billing_offer_fence_fingerprint" = ${current.billingOfferFenceFingerprint}
				`;
				if (changed !== 1) {
					throw new PlatformCutoverError(
						'Platform Core activation lost its CAS boundary'
					);
				}
				return {
					duplicate: false,
					generation: (current.generation + 1n).toString()
				};
			},
			{ isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
		)
		.then(result => ({ ok: true, action: 'activate', ...result }));
}

async function abort(client: PrismaClient, revision: string) {
	return client
		.$transaction(
			async transaction => {
				await lockState(transaction);
				const current = await state(transaction);
				if (current.ownership === 'PLATFORM') {
					throw new PlatformCutoverError(
						'Platform ownership is forward-only after activation'
					);
				}
				if (
					current.preparedRevision === null &&
					current.sourceWritesEnabled
				) {
					return { duplicate: true };
				}
				if (current.preparedRevision !== revision) {
					throw new PlatformCutoverError(
						'Platform Core abort revision mismatch'
					);
				}
				const changed = await transaction.$executeRaw`
				UPDATE "public"."platform_core_state"
				SET "source_writes_enabled" = TRUE,
					"prepared_revision" = NULL,
					"source_revision" = NULL,
					"source_snapshot_sha256" = NULL,
					"source_fingerprint" = NULL,
					"source_high_watermark" = NULL,
					"billing_offer_contract_version" = NULL,
					"billing_offer_sequence_scope" = NULL,
					"billing_offer_aggregate_version" = NULL,
					"billing_offer_source_sequence" = NULL,
					"billing_offer_fence_fingerprint" = NULL,
					"fenced_at" = NULL,
					"exported_at" = NULL
				WHERE "id" = 'singleton'
					AND "ownership" = 'CORE'::"public"."PlatformCoreOwnership"
					AND "prepared_revision" = ${revision}
			`;
				if (changed !== 1) {
					throw new PlatformCutoverError(
						'Platform Core abort lost its CAS boundary'
					);
				}
				return { duplicate: false };
			},
			{ isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
		)
		.then(result => ({ ok: true, action: 'abort', revision, ...result }));
}

async function status(client: PrismaClient) {
	const current = await state(client);
	return {
		ok: true,
		action: 'status',
		ownership: current.ownership,
		sourceWritesEnabled: current.sourceWritesEnabled,
		legacyRoutesEnabled: current.legacyRoutesEnabled,
		generation: current.generation.toString(),
		preparedRevision: current.preparedRevision,
		sourceRevision: current.sourceRevision,
		ownershipRevision: current.ownershipRevision,
		sourceSnapshotSha256: current.sourceSnapshotSha256,
		sourceFingerprint: current.sourceFingerprint,
		sourceHighWatermark: current.sourceHighWatermark?.toString() || null,
		billingOfferProducer:
			billingOfferFenceState(current) === 'complete'
				? {
						contractVersion: current.billingOfferContractVersion,
						sequenceScope: current.billingOfferSequenceScope,
						aggregateVersion:
							current.billingOfferAggregateVersion!.toString(),
						sourceSequence: current.billingOfferSourceSequence!.toString(),
						fingerprint: current.billingOfferFenceFingerprint
					}
				: null,
		fencedAt: current.fencedAt?.toISOString() || null,
		exportedAt: current.exportedAt?.toISOString() || null,
		activatedAt: current.activatedAt?.toISOString() || null
	};
}

function jsonObject(value: Prisma.JsonValue): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new PlatformCutoverError(
			'Core home-page content must be a JSON object'
		);
	}
	return value as Record<string, unknown>;
}

function databaseUrl() {
	const value = process.env.PLATFORM_CORE_DATABASE_URL?.trim() || '';
	if (!value || ['change_me', 'change-me', 'XYZXYZXYZ'].includes(value)) {
		throw new PlatformCutoverError(
			'PLATFORM_CORE_DATABASE_URL is missing'
		);
	}
	return value;
}

export async function runPlatformCoreAction(args: Args) {
	const client = new PrismaClient({
		datasources: { db: { url: databaseUrl() } }
	});
	try {
		await client.$connect();
		if (args.action === 'status') return status(client);
		if (args.action === 'preflight')
			return preflight(client, args.revision!);
		if (args.action === 'prepare') return prepare(client, args.revision!);
		if (args.action === 'fence') return fence(client, args.revision!);
		if (args.action === 'export') {
			return exportSnapshot(client, args.revision!, args.file!);
		}
		if (args.action === 'activate') {
			return activate(client, args as Required<Args>);
		}
		if (args.action === 'abort') return abort(client, args.revision!);
		throw new PlatformCutoverError('Unsupported Platform Core action');
	} finally {
		await client.$disconnect();
	}
}

if (require.main === module) {
	runPlatformCoreAction(parsePlatformCoreArgs(process.argv.slice(2)))
		.then(result => process.stdout.write(`${JSON.stringify(result)}\n`))
		.catch(error => {
			process.stderr.write(
				`${JSON.stringify({
					ok: false,
					error:
						error instanceof PlatformCutoverError
							? error.message
							: 'Platform Core action failed'
				})}\n`
			);
			process.exitCode = 1;
		});
}
