import {
	OfferProducerPhase,
	Prisma,
	PrismaClient,
	ServiceDatabasePhase
} from '@prisma/platform-client';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { isAutoRenewalOfferCompatible } from '../domain/billing-offer-continuity';
import {
	readPlatformSemanticFingerprint,
	refreshPlatformSemanticFingerprint
} from '../domain/platform-sequence';

const ACTIONS = [
	'preflight',
	'validate-shadow',
	'status',
	'import',
	'activate',
	'verify',
	'abort'
] as const;
type Action = (typeof ACTIONS)[number];

const LEGAL_SLUGS = [
	'consent-processing',
	'cookie-notice',
	'oferta',
	'personal-policy'
] as const;
const SNAPSHOT_MAX_BYTES = 8 * 1024 * 1024;

type CutoverArgs = {
	action: Action;
	file?: string;
	sha256?: string;
};

type SnapshotVersion = {
	aggregateVersion: string;
	sourceSequence: string;
};

type SnapshotSiteSettings = SnapshotVersion & {
	id: 'singleton';
	bannerEnabled: boolean;
	bannerText: string;
	snowflakeEnabled: boolean;
	updatedAt: string;
};

type SnapshotLegalPage = SnapshotVersion & {
	slug: (typeof LEGAL_SLUGS)[number];
	content: string;
	updatedAt: string;
};

type SnapshotHomePageContent = SnapshotVersion & {
	id: 'singleton';
	content: Record<string, unknown>;
	updatedAt: string;
};

type BillingOfferProducerSnapshot = {
	contractVersion: 2;
	sequenceScope: 'billing.offer:offer';
	aggregateVersion: string;
	sourceSequence: string;
	fingerprint: string;
};

export type PlatformCutoverSnapshot = {
	schemaVersion: 1;
	snapshotId: string;
	createdAt: string;
	sourceRevision: string;
	sourceFingerprint: string;
	platformHighWater: string;
	counts: {
		siteSettings: 1;
		legalPages: 4;
		homePageContent: 1;
	};
	siteSettings: SnapshotSiteSettings;
	legalPages: SnapshotLegalPage[];
	homePageContent: SnapshotHomePageContent;
	billingOfferProducer: BillingOfferProducerSnapshot;
};

type LoadedSnapshot = {
	value: PlatformCutoverSnapshot;
	sha256: string;
};

export class PlatformCutoverError extends Error {}

export function parsePlatformCutoverArgs(
	argv: readonly string[]
): CutoverArgs {
	const [rawAction, ...rest] = argv;
	if (!ACTIONS.includes(rawAction as Action)) {
		throw new PlatformCutoverError('Unsupported Platform cutover action');
	}
	const action = rawAction as Action;
	if (
		action === 'status' ||
		action === 'verify' ||
		action === 'validate-shadow'
	) {
		if (rest.length) {
			throw new PlatformCutoverError(
				`${action} does not accept arguments`
			);
		}
		return { action };
	}
	if (action === 'activate' || action === 'abort') {
		if (
			rest.length !== 2 ||
			rest[0] !== '--sha256' ||
			!/^[a-f0-9]{64}$/i.test(rest[1] || '')
		) {
			throw new PlatformCutoverError(
				`${action} requires --sha256 <64-character-hex>`
			);
		}
		return { action, sha256: rest[1]!.toLowerCase() };
	}
	if (rest.length !== 2 && rest.length !== 4) {
		throw new PlatformCutoverError(
			`${action} requires --file <absolute-path> and optional --sha256 <hex>`
		);
	}
	if (rest[0] !== '--file') {
		throw new PlatformCutoverError(`${action} requires --file first`);
	}
	const file = rest[1];
	if (!file || !isAbsolute(file) || file.includes('\0')) {
		throw new PlatformCutoverError(
			'Platform snapshot path must be absolute'
		);
	}
	let sha256: string | undefined;
	if (rest.length === 4) {
		if (rest[2] !== '--sha256' || !/^[a-f0-9]{64}$/i.test(rest[3] || '')) {
			throw new PlatformCutoverError(
				'--sha256 must be a 64-character hex digest'
			);
		}
		sha256 = rest[3]!.toLowerCase();
	}
	return { action, file, sha256 };
}

export async function loadPlatformSnapshot(
	file: string,
	expectedSha256?: string
): Promise<LoadedSnapshot> {
	let handle;
	try {
		handle = await open(
			file,
			constants.O_RDONLY | (constants.O_NOFOLLOW || 0)
		);
		const metadata = await handle.stat();
		if (
			!metadata.isFile() ||
			metadata.size < 2 ||
			metadata.size > SNAPSHOT_MAX_BYTES
		) {
			throw new PlatformCutoverError(
				'Platform snapshot must be a bounded regular file'
			);
		}
		if ((metadata.mode & 0o777) !== 0o600) {
			throw new PlatformCutoverError(
				'Platform snapshot must have mode 0600'
			);
		}
		const content = await handle.readFile();
		const sha256 = createHash('sha256').update(content).digest('hex');
		if (expectedSha256 && sha256 !== expectedSha256) {
			throw new PlatformCutoverError(
				'Platform snapshot SHA-256 differs from expected digest'
			);
		}
		let value: unknown;
		try {
			value = JSON.parse(content.toString('utf8'));
		} catch {
			throw new PlatformCutoverError(
				'Platform snapshot is not valid JSON'
			);
		}
		return { value: parseSnapshot(value), sha256 };
	} catch (error) {
		if (error instanceof PlatformCutoverError) throw error;
		throw new PlatformCutoverError(
			'Platform snapshot cannot be read safely'
		);
	} finally {
		await handle?.close();
	}
}

export function parseSnapshot(value: unknown): PlatformCutoverSnapshot {
	const snapshot = record(value, 'snapshot');
	exact(snapshot, [
		'billingOfferProducer',
		'counts',
		'createdAt',
		'homePageContent',
		'legalPages',
		'platformHighWater',
		'schemaVersion',
		'siteSettings',
		'snapshotId',
		'sourceFingerprint',
		'sourceRevision'
	]);
	if (snapshot.schemaVersion !== 1) invalid('snapshot.schemaVersion');
	if (!uuid(snapshot.snapshotId)) invalid('snapshot.snapshotId');
	if (!date(snapshot.createdAt)) invalid('snapshot.createdAt');
	if (!/^[0-9a-f]{40}$/.test(String(snapshot.sourceRevision))) {
		invalid('snapshot.sourceRevision');
	}
	if (!digest(snapshot.sourceFingerprint))
		invalid('snapshot.sourceFingerprint');
	const platformHighWater = positive(
		snapshot.platformHighWater,
		'platformHighWater'
	);
	const counts = record(snapshot.counts, 'snapshot.counts');
	exact(counts, ['homePageContent', 'legalPages', 'siteSettings']);
	if (
		counts.siteSettings !== 1 ||
		counts.legalPages !== 4 ||
		counts.homePageContent !== 1
	) {
		invalid('snapshot.counts');
	}

	const site = parseSiteSettings(snapshot.siteSettings);
	const legalInput = snapshot.legalPages;
	if (
		!Array.isArray(legalInput) ||
		legalInput.length !== LEGAL_SLUGS.length
	) {
		invalid('snapshot.legalPages');
	}
	const legalPages = legalInput.map((item, index) =>
		parseLegalPage(item, index)
	);
	if (legalPages.some((page, index) => page.slug !== LEGAL_SLUGS[index])) {
		invalid('snapshot.legalPages order');
	}
	const home = parseHomePageContent(snapshot.homePageContent);
	const versions = [site, ...legalPages, home];
	const sequences = versions.map(item =>
		positive(item.sourceSequence, 'sourceSequence')
	);
	if (
		new Set(sequences.map(String)).size !== sequences.length ||
		sequences.some((sequence, index) => sequence !== BigInt(index + 1)) ||
		platformHighWater !== BigInt(sequences.length)
	) {
		invalid('snapshot Platform source continuity');
	}
	if (
		versions.some(
			item => positive(item.aggregateVersion, 'aggregateVersion') !== 1n
		)
	) {
		invalid('snapshot aggregate baseline');
	}

	const producer = parseBillingOfferProducer(
		snapshot.billingOfferProducer
	);
	const oferta = legalPages.find(page => page.slug === 'oferta');
	if (!oferta || !isAutoRenewalOfferCompatible(oferta.content)) {
		throw new PlatformCutoverError(
			'Platform oferta is incompatible with the Billing consent contract'
		);
	}
	if (
		billingOfferFingerprint(oferta.content, producer) !==
		producer.fingerprint
	) {
		invalid('snapshot.billingOfferProducer.fingerprint');
	}

	const parsed: PlatformCutoverSnapshot = {
		schemaVersion: 1,
		snapshotId: snapshot.snapshotId as string,
		createdAt: snapshot.createdAt as string,
		sourceRevision: snapshot.sourceRevision as string,
		sourceFingerprint: snapshot.sourceFingerprint as string,
		platformHighWater: platformHighWater.toString(),
		counts: {
			siteSettings: 1,
			legalPages: 4,
			homePageContent: 1
		},
		siteSettings: site,
		legalPages,
		homePageContent: home,
		billingOfferProducer: producer
	};
	if (snapshotSemanticHash(parsed) !== parsed.sourceFingerprint) {
		invalid('snapshot.sourceFingerprint');
	}
	return parsed;
}

function parseSiteSettings(value: unknown): SnapshotSiteSettings {
	const item = record(value, 'snapshot.siteSettings');
	exact(item, [
		'aggregateVersion',
		'bannerEnabled',
		'bannerText',
		'id',
		'snowflakeEnabled',
		'sourceSequence',
		'updatedAt'
	]);
	if (
		item.id !== 'singleton' ||
		typeof item.bannerEnabled !== 'boolean' ||
		typeof item.snowflakeEnabled !== 'boolean' ||
		typeof item.bannerText !== 'string' ||
		item.bannerText.length > 300 ||
		!date(item.updatedAt)
	) {
		invalid('snapshot.siteSettings');
	}
	return {
		id: 'singleton',
		bannerEnabled: item.bannerEnabled,
		bannerText: item.bannerText,
		snowflakeEnabled: item.snowflakeEnabled,
		updatedAt: item.updatedAt,
		aggregateVersion: positive(
			item.aggregateVersion,
			'aggregateVersion'
		).toString(),
		sourceSequence: positive(
			item.sourceSequence,
			'sourceSequence'
		).toString()
	};
}

function parseLegalPage(value: unknown, index: number): SnapshotLegalPage {
	const item = record(value, `snapshot.legalPages[${index}]`);
	exact(item, [
		'aggregateVersion',
		'content',
		'slug',
		'sourceSequence',
		'updatedAt'
	]);
	if (
		!LEGAL_SLUGS.includes(item.slug as (typeof LEGAL_SLUGS)[number]) ||
		typeof item.content !== 'string' ||
		Buffer.byteLength(item.content, 'utf8') > 1024 * 1024 ||
		!date(item.updatedAt)
	) {
		invalid(`snapshot.legalPages[${index}]`);
	}
	return {
		slug: item.slug as SnapshotLegalPage['slug'],
		content: item.content,
		updatedAt: item.updatedAt,
		aggregateVersion: positive(
			item.aggregateVersion,
			'aggregateVersion'
		).toString(),
		sourceSequence: positive(
			item.sourceSequence,
			'sourceSequence'
		).toString()
	};
}

function parseHomePageContent(value: unknown): SnapshotHomePageContent {
	const item = record(value, 'snapshot.homePageContent');
	exact(item, [
		'aggregateVersion',
		'content',
		'id',
		'sourceSequence',
		'updatedAt'
	]);
	const content = record(item.content, 'snapshot.homePageContent.content');
	if (
		item.id !== 'singleton' ||
		Buffer.byteLength(JSON.stringify(content), 'utf8') > 1024 * 1024 ||
		!date(item.updatedAt)
	) {
		invalid('snapshot.homePageContent');
	}
	return {
		id: 'singleton',
		content,
		updatedAt: item.updatedAt,
		aggregateVersion: positive(
			item.aggregateVersion,
			'aggregateVersion'
		).toString(),
		sourceSequence: positive(
			item.sourceSequence,
			'sourceSequence'
		).toString()
	};
}

function parseBillingOfferProducer(
	value: unknown
): BillingOfferProducerSnapshot {
	const item = record(value, 'snapshot.billingOfferProducer');
	exact(item, [
		'aggregateVersion',
		'contractVersion',
		'fingerprint',
		'sequenceScope',
		'sourceSequence'
	]);
	const aggregateVersion = positive(
		item.aggregateVersion,
		'aggregateVersion'
	);
	if (
		item.contractVersion !== 2 ||
		item.sequenceScope !== 'billing.offer:offer' ||
		!digest(item.fingerprint)
	) {
		invalid('snapshot.billingOfferProducer');
	}
	return {
		contractVersion: 2,
		sequenceScope: 'billing.offer:offer',
		aggregateVersion: aggregateVersion.toString(),
		sourceSequence: positive(
			item.sourceSequence,
			'sourceSequence'
		).toString(),
		fingerprint: item.fingerprint as string
	};
}

type PlatformDatabaseClient = PrismaClient | Prisma.TransactionClient;

async function targetStatus(client: PlatformDatabaseClient) {
	const [identity, site, legal, home, offer, sequence, outbox] =
		await Promise.all([
			client.serviceIdentity.findUnique({ where: { id: 'singleton' } }),
			client.siteSettings.findUnique({ where: { id: 'singleton' } }),
			client.legalPage.findMany({ orderBy: { slug: 'asc' } }),
			client.homePageContent.findUnique({ where: { id: 'singleton' } }),
			client.billingOfferProducerState.findUnique({
				where: { id: 'offer' }
			}),
			client.platformSourceSequence.findUnique({
				where: { id: 'platform' }
			}),
			client.outboxEvent.count()
		]);
	if (
		!identity ||
		identity.serviceName !== 'platform-service' ||
		!site ||
		!home ||
		!offer ||
		!sequence ||
		legal.length !== LEGAL_SLUGS.length ||
		legal.some((page, index) => page.slug !== LEGAL_SLUGS[index])
	) {
		throw new PlatformCutoverError(
			'Platform database anchors are invalid'
		);
	}
	return { identity, site, legal, home, offer, sequence, outbox };
}

async function preflight(client: PrismaClient, loaded: LoadedSnapshot) {
	const state = await targetStatus(client);
	if (state.identity.phase === ServiceDatabasePhase.ACTIVE) {
		if (state.identity.sourceSnapshotSha256 !== loaded.sha256) {
			throw new PlatformCutoverError(
				'Active Platform database belongs to another snapshot'
			);
		}
		await verifyActiveState(client, state);
	} else if (state.identity.importedAt) {
		assertImportedSnapshot(state, loaded);
		await verifyImportedState(client, state);
	} else {
		assertFreshShadow(state);
	}
	return {
		ok: true,
		action: 'preflight',
		phase: state.identity.phase,
		imported: Boolean(state.identity.importedAt),
		snapshotId: loaded.value.snapshotId,
		sha256: loaded.sha256,
		sourceFingerprint: loaded.value.sourceFingerprint,
		platformHighWater: loaded.value.platformHighWater,
		billingOfferProducer: loaded.value.billingOfferProducer
	};
}

async function validateShadow(client: PrismaClient) {
	const state = await targetStatus(client);
	assertFreshShadow(state);
	return {
		ok: true,
		action: 'validate-shadow',
		phase: state.identity.phase,
		databaseId: state.identity.databaseId
	};
}

async function importSnapshot(
	client: PrismaClient,
	loaded: LoadedSnapshot
) {
	return client
		.$transaction(
			async transaction => {
				await lockCutoverRows(transaction);
				const state = await targetStatus(transaction);
				if (state.identity.phase === ServiceDatabasePhase.ACTIVE) {
					throw new PlatformCutoverError(
						'Platform import is forbidden after activation'
					);
				}
				if (state.identity.importedAt) {
					assertImportedSnapshot(state, loaded);
					await verifyImportedState(transaction, state);
					return { duplicate: true };
				}
				assertFreshShadow(state);
				const snapshot = loaded.value;
				await transaction.siteSettings.update({
					where: { id: 'singleton' },
					data: {
						bannerEnabled: snapshot.siteSettings.bannerEnabled,
						bannerText: snapshot.siteSettings.bannerText,
						snowflakeEnabled: snapshot.siteSettings.snowflakeEnabled,
						aggregateVersion: BigInt(
							snapshot.siteSettings.aggregateVersion
						),
						sourceSequence: BigInt(snapshot.siteSettings.sourceSequence),
						updatedAt: new Date(snapshot.siteSettings.updatedAt)
					}
				});
				for (const page of snapshot.legalPages) {
					await transaction.legalPage.update({
						where: { slug: page.slug },
						data: {
							content: page.content,
							aggregateVersion: BigInt(page.aggregateVersion),
							sourceSequence: BigInt(page.sourceSequence),
							updatedAt: new Date(page.updatedAt)
						}
					});
				}
				await transaction.homePageContent.update({
					where: { id: 'singleton' },
					data: {
						content: snapshot.homePageContent
							.content as Prisma.InputJsonObject,
						aggregateVersion: BigInt(
							snapshot.homePageContent.aggregateVersion
						),
						sourceSequence: BigInt(
							snapshot.homePageContent.sourceSequence
						),
						updatedAt: new Date(snapshot.homePageContent.updatedAt)
					}
				});
				await transaction.platformSourceSequence.update({
					where: { id: 'platform' },
					data: { nextValue: BigInt(snapshot.platformHighWater) + 1n }
				});
				const importedAt = new Date();
				await transaction.billingOfferProducerState.update({
					where: { id: 'offer' },
					data: {
						phase: OfferProducerPhase.IMPORTED,
						producerContractVersion:
							snapshot.billingOfferProducer.contractVersion,
						sourceSequenceScope:
							snapshot.billingOfferProducer.sequenceScope,
						importedAggregateVersion: BigInt(
							snapshot.billingOfferProducer.aggregateVersion
						),
						importedSourceSequence: BigInt(
							snapshot.billingOfferProducer.sourceSequence
						),
						sourceFenceFingerprint:
							snapshot.billingOfferProducer.fingerprint,
						currentAggregateVersion: null,
						currentSourceSequence: null,
						importedAt,
						activatedAt: null
					}
				});
				await transaction.serviceIdentity.update({
					where: { id: 'singleton' },
					data: {
						sourceFingerprint: snapshot.sourceFingerprint,
						sourceSnapshotSha256: loaded.sha256,
						sourceSnapshotCounts: snapshot.counts,
						sourceHighWatermark: BigInt(snapshot.platformHighWater),
						importedAt,
						activatedAt: null
					}
				});
				await refreshPlatformSemanticFingerprint(transaction);
				return { duplicate: false };
			},
			{
				isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
				maxWait: 10_000,
				timeout: 60_000
			}
		)
		.then(result => ({
			ok: true,
			action: 'import',
			sha256: loaded.sha256,
			sourceFingerprint: loaded.value.sourceFingerprint,
			...result
		}));
}

async function activate(client: PrismaClient, expectedSha256: string) {
	return client
		.$transaction(
			async transaction => {
				await lockCutoverRows(transaction);
				const state = await targetStatus(transaction);
				if (state.identity.sourceSnapshotSha256 !== expectedSha256) {
					throw new PlatformCutoverError(
						'Platform activation snapshot SHA-256 mismatch'
					);
				}
				if (state.identity.phase === ServiceDatabasePhase.ACTIVE) {
					await verifyActiveState(transaction, state);
					return {
						duplicate: true,
						ownershipGeneration:
							state.identity.ownershipGeneration.toString()
					};
				}
				await verifyImportedState(transaction, state);
				const activatedAt = new Date();
				const offer =
					await transaction.billingOfferProducerState.updateMany({
						where: {
							id: 'offer',
							phase: OfferProducerPhase.IMPORTED,
							activatedAt: null,
							producerContractVersion: state.offer.producerContractVersion,
							sourceSequenceScope: state.offer.sourceSequenceScope,
							importedAggregateVersion:
								state.offer.importedAggregateVersion,
							importedSourceSequence: state.offer.importedSourceSequence,
							sourceFenceFingerprint: state.offer.sourceFenceFingerprint
						},
						data: {
							phase: OfferProducerPhase.ACTIVE,
							currentAggregateVersion:
								state.offer.importedAggregateVersion,
							currentSourceSequence: state.offer.importedSourceSequence,
							activatedAt
						}
					});
				if (offer.count !== 1) {
					throw new PlatformCutoverError(
						'Billing offer producer activation lost its CAS boundary'
					);
				}
				const identity = await transaction.serviceIdentity.updateMany({
					where: {
						id: 'singleton',
						phase: ServiceDatabasePhase.SHADOW,
						ownershipGeneration: state.identity.ownershipGeneration,
						sourceSnapshotSha256: expectedSha256,
						sourceFingerprint: state.identity.sourceFingerprint,
						sourceHighWatermark: state.identity.sourceHighWatermark,
						importedAt: state.identity.importedAt,
						activatedAt: null
					},
					data: {
						phase: ServiceDatabasePhase.ACTIVE,
						ownershipGeneration: { increment: 1n },
						activatedAt
					}
				});
				if (identity.count !== 1) {
					throw new PlatformCutoverError(
						'Platform ownership activation lost its CAS boundary'
					);
				}
				await refreshPlatformSemanticFingerprint(transaction);
				return {
					duplicate: false,
					ownershipGeneration: (
						state.identity.ownershipGeneration + 1n
					).toString()
				};
			},
			{ isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
		)
		.then(result => ({ ok: true, action: 'activate', ...result }));
}

async function abortImport(client: PrismaClient, expectedSha256: string) {
	return client
		.$transaction(
			async transaction => {
				await lockCutoverRows(transaction);
				const state = await targetStatus(transaction);
				if (state.identity.phase === ServiceDatabasePhase.ACTIVE) {
					throw new PlatformCutoverError(
						'Platform ownership is forward-only after activation'
					);
				}
				if (!state.identity.importedAt) {
					assertFreshShadow(state);
					return { duplicate: true };
				}
				if (state.identity.sourceSnapshotSha256 !== expectedSha256) {
					throw new PlatformCutoverError(
						'Platform abort snapshot mismatch'
					);
				}
				if (state.outbox !== 0) {
					throw new PlatformCutoverError(
						'Platform abort requires an empty Outbox'
					);
				}
				await transaction.siteSettings.update({
					where: { id: 'singleton' },
					data: {
						bannerEnabled: false,
						bannerText: '',
						snowflakeEnabled: false,
						aggregateVersion: 0n,
						sourceSequence: 0n
					}
				});
				await transaction.legalPage.updateMany({
					data: { content: '', aggregateVersion: 0n, sourceSequence: 0n }
				});
				await transaction.homePageContent.update({
					where: { id: 'singleton' },
					data: {
						content: {},
						aggregateVersion: 0n,
						sourceSequence: 0n
					}
				});
				await transaction.platformSourceSequence.update({
					where: { id: 'platform' },
					data: { nextValue: 1n }
				});
				await transaction.billingOfferProducerState.update({
					where: { id: 'offer' },
					data: {
						phase: OfferProducerPhase.BLOCKED,
						producerContractVersion: null,
						sourceSequenceScope: null,
						importedAggregateVersion: null,
						importedSourceSequence: null,
						currentAggregateVersion: null,
						currentSourceSequence: null,
						sourceFenceFingerprint: null,
						importedAt: null,
						activatedAt: null
					}
				});
				await transaction.serviceIdentity.update({
					where: { id: 'singleton' },
					data: {
						sourceFingerprint: null,
						sourceSnapshotSha256: null,
						sourceSnapshotCounts: Prisma.DbNull,
						sourceHighWatermark: null,
						importedAt: null,
						activatedAt: null
					}
				});
				await refreshPlatformSemanticFingerprint(transaction);
				return { duplicate: false };
			},
			{ isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
		)
		.then(result => ({ ok: true, action: 'abort', ...result }));
}

async function verify(client: PrismaClient) {
	const state = await targetStatus(client);
	await verifyActiveState(client, state);
	return {
		ok: true,
		action: 'verify',
		phase: state.identity.phase,
		sha256: state.identity.sourceSnapshotSha256,
		sourceFingerprint: state.identity.sourceFingerprint,
		currentSemanticFingerprint: state.identity.currentSemanticFingerprint,
		ownershipGeneration: state.identity.ownershipGeneration.toString()
	};
}

async function status(client: PrismaClient) {
	const state = await targetStatus(client);
	return {
		ok: true,
		action: 'status',
		phase: state.identity.phase,
		databaseId: state.identity.databaseId,
		ownershipGeneration: state.identity.ownershipGeneration.toString(),
		imported: Boolean(state.identity.importedAt),
		sourceSnapshotSha256: state.identity.sourceSnapshotSha256,
		sourceFingerprint: state.identity.sourceFingerprint,
		currentSemanticFingerprint: state.identity.currentSemanticFingerprint,
		sourceHighWatermark:
			state.identity.sourceHighWatermark?.toString() || null,
		billingOfferProducer: {
			phase: state.offer.phase,
			contractVersion: state.offer.producerContractVersion,
			sequenceScope: state.offer.sourceSequenceScope,
			importedAggregateVersion:
				state.offer.importedAggregateVersion?.toString() || null,
			importedSourceSequence:
				state.offer.importedSourceSequence?.toString() || null,
			currentAggregateVersion:
				state.offer.currentAggregateVersion?.toString() || null,
			currentSourceSequence:
				state.offer.currentSourceSequence?.toString() || null
		},
		outbox: state.outbox
	};
}

async function lockCutoverRows(transaction: Prisma.TransactionClient) {
	await transaction.$queryRaw`
		SELECT "id" FROM "platform"."service_identity"
		WHERE "id" = 'singleton' FOR UPDATE
	`;
	await transaction.$queryRaw`
		SELECT "id" FROM "platform"."billing_offer_producer_state"
		WHERE "id" = 'offer' FOR UPDATE
	`;
}

function assertFreshShadow(
	state: Awaited<ReturnType<typeof targetStatus>>
) {
	if (
		state.identity.phase !== ServiceDatabasePhase.SHADOW ||
		state.identity.ownershipGeneration !== 0n ||
		state.identity.sourceFingerprint !== null ||
		state.identity.sourceSnapshotSha256 !== null ||
		state.identity.sourceSnapshotCounts !== null ||
		state.identity.sourceHighWatermark !== null ||
		!/^[0-9a-f]{64}$/.test(state.identity.currentSemanticFingerprint) ||
		state.identity.importedAt !== null ||
		state.identity.activatedAt !== null ||
		state.site.aggregateVersion !== 0n ||
		state.site.sourceSequence !== 0n ||
		state.site.bannerEnabled ||
		state.site.bannerText !== '' ||
		state.site.snowflakeEnabled ||
		state.legal.some(
			page =>
				page.content !== '' ||
				page.aggregateVersion !== 0n ||
				page.sourceSequence !== 0n
		) ||
		JSON.stringify(state.home.content) !== '{}' ||
		state.home.aggregateVersion !== 0n ||
		state.home.sourceSequence !== 0n ||
		state.sequence.nextValue !== 1n ||
		state.offer.phase !== OfferProducerPhase.BLOCKED ||
		state.offer.producerContractVersion !== null ||
		state.offer.sourceSequenceScope !== null ||
		state.offer.importedAggregateVersion !== null ||
		state.offer.importedSourceSequence !== null ||
		state.offer.currentAggregateVersion !== null ||
		state.offer.currentSourceSequence !== null ||
		state.offer.sourceFenceFingerprint !== null ||
		state.offer.importedAt !== null ||
		state.offer.activatedAt !== null ||
		state.outbox !== 0
	) {
		throw new PlatformCutoverError(
			'Platform SHADOW database is not a clean migration target'
		);
	}
}

function assertImportedSnapshot(
	state: Awaited<ReturnType<typeof targetStatus>>,
	loaded: LoadedSnapshot
) {
	const snapshot = loaded.value;
	if (
		state.identity.phase !== ServiceDatabasePhase.SHADOW ||
		state.identity.sourceSnapshotSha256 !== loaded.sha256 ||
		state.identity.sourceFingerprint !== snapshot.sourceFingerprint ||
		state.identity.sourceHighWatermark !==
			BigInt(snapshot.platformHighWater) ||
		!exactSourceCounts(state.identity.sourceSnapshotCounts) ||
		state.offer.phase !== OfferProducerPhase.IMPORTED ||
		state.offer.producerContractVersion !==
			snapshot.billingOfferProducer.contractVersion ||
		state.offer.sourceSequenceScope !==
			snapshot.billingOfferProducer.sequenceScope ||
		state.offer.importedAggregateVersion !==
			BigInt(snapshot.billingOfferProducer.aggregateVersion) ||
		state.offer.importedSourceSequence !==
			BigInt(snapshot.billingOfferProducer.sourceSequence) ||
		state.offer.sourceFenceFingerprint !==
			snapshot.billingOfferProducer.fingerprint ||
		state.outbox !== 0
	) {
		throw new PlatformCutoverError(
			'Platform database was imported from another snapshot'
		);
	}
}

async function verifyImportedState(
	client: PlatformDatabaseClient,
	state: Awaited<ReturnType<typeof targetStatus>>
) {
	if (
		state.identity.phase !== ServiceDatabasePhase.SHADOW ||
		!state.identity.importedAt ||
		!state.identity.sourceFingerprint ||
		!state.identity.sourceSnapshotSha256 ||
		!exactSourceCounts(state.identity.sourceSnapshotCounts) ||
		state.identity.sourceHighWatermark === null ||
		!/^[0-9a-f]{64}$/.test(state.identity.currentSemanticFingerprint) ||
		state.offer.phase !== OfferProducerPhase.IMPORTED ||
		state.offer.producerContractVersion !== 2 ||
		state.offer.sourceSequenceScope !== 'billing.offer:offer' ||
		state.offer.importedAggregateVersion === null ||
		state.offer.importedSourceSequence === null ||
		state.offer.currentAggregateVersion !== null ||
		state.offer.currentSourceSequence !== null ||
		!state.offer.sourceFenceFingerprint ||
		state.offer.importedAt?.getTime() !==
			state.identity.importedAt.getTime() ||
		state.outbox !== 0 ||
		state.sequence.nextValue !== state.identity.sourceHighWatermark + 1n
	) {
		throw new PlatformCutoverError(
			'Platform activation requires an exact imported snapshot'
		);
	}
	if (
		(await databaseSemanticHash(client, state)) !==
		state.identity.sourceFingerprint
	) {
		throw new PlatformCutoverError(
			'Platform imported row fingerprint mismatch'
		);
	}
	if (
		(await readPlatformSemanticFingerprint(client)) !==
		state.identity.currentSemanticFingerprint
	) {
		throw new PlatformCutoverError(
			'Platform imported current semantic fingerprint mismatch'
		);
	}
}

async function verifyActiveState(
	client: PlatformDatabaseClient,
	state: Awaited<ReturnType<typeof targetStatus>>
) {
	const counts = state.identity.sourceSnapshotCounts;
	const versions = [state.site, ...state.legal, state.home];
	const sourceSequences = versions.map(item => item.sourceSequence);
	const maximumSourceSequence = sourceSequences.reduce(
		(maximum, value) => (value > maximum ? value : maximum),
		0n
	);
	const importedAggregateVersion = state.offer.importedAggregateVersion;
	const importedSourceSequence = state.offer.importedSourceSequence;
	const currentAggregateVersion = state.offer.currentAggregateVersion;
	const currentSourceSequence = state.offer.currentSourceSequence;
	if (
		state.identity.phase !== ServiceDatabasePhase.ACTIVE ||
		state.identity.ownershipGeneration < 1n ||
		!state.identity.sourceFingerprint ||
		!/^[0-9a-f]{64}$/.test(state.identity.sourceFingerprint) ||
		!state.identity.sourceSnapshotSha256 ||
		!/^[0-9a-f]{64}$/.test(state.identity.sourceSnapshotSha256) ||
		!/^[0-9a-f]{64}$/.test(state.identity.currentSemanticFingerprint) ||
		state.identity.sourceHighWatermark === null ||
		state.identity.sourceHighWatermark < 1n ||
		!exactSourceCounts(counts) ||
		!state.identity.importedAt ||
		!state.identity.activatedAt ||
		state.identity.activatedAt < state.identity.importedAt ||
		state.offer.phase !== OfferProducerPhase.ACTIVE ||
		state.offer.producerContractVersion !== 2 ||
		state.offer.sourceSequenceScope !== 'billing.offer:offer' ||
		importedAggregateVersion === null ||
		importedSourceSequence === null ||
		currentAggregateVersion === null ||
		currentSourceSequence === null ||
		!state.offer.sourceFenceFingerprint ||
		!/^[0-9a-f]{64}$/.test(state.offer.sourceFenceFingerprint) ||
		!state.offer.importedAt ||
		!state.offer.activatedAt ||
		state.offer.importedAt.getTime() !==
			state.identity.importedAt.getTime() ||
		state.offer.activatedAt.getTime() !==
			state.identity.activatedAt.getTime() ||
		currentAggregateVersion < importedAggregateVersion ||
		currentSourceSequence < importedSourceSequence ||
		currentAggregateVersion - importedAggregateVersion !==
			currentSourceSequence - importedSourceSequence ||
		versions.some(
			item => item.aggregateVersion < 1n || item.sourceSequence < 1n
		) ||
		new Set(sourceSequences.map(String)).size !== sourceSequences.length ||
		state.sequence.nextValue <= maximumSourceSequence ||
		state.sequence.nextValue <= state.identity.sourceHighWatermark
	) {
		throw new PlatformCutoverError(
			'Platform active ownership anchors are inconsistent'
		);
	}
	const oferta = state.legal.find(page => page.slug === 'oferta');
	if (!oferta || !isAutoRenewalOfferCompatible(oferta.content)) {
		throw new PlatformCutoverError(
			'Platform active Billing offer is incompatible'
		);
	}
	if (
		currentAggregateVersion === importedAggregateVersion &&
		billingOfferFingerprint(oferta.content, {
			contractVersion: 2,
			sequenceScope: 'billing.offer:offer',
			aggregateVersion: importedAggregateVersion.toString(),
			sourceSequence: importedSourceSequence.toString()
		}) !== state.offer.sourceFenceFingerprint
	) {
		throw new PlatformCutoverError(
			'Platform unchanged Billing offer fingerprint mismatch'
		);
	}
	const unchangedFromImportedSnapshot =
		versions.every(
			(item, index) =>
				item.aggregateVersion === 1n &&
				item.sourceSequence === BigInt(index + 1)
		) &&
		state.sequence.nextValue === state.identity.sourceHighWatermark + 1n &&
		currentAggregateVersion === importedAggregateVersion &&
		currentSourceSequence === importedSourceSequence;
	if (
		unchangedFromImportedSnapshot &&
		(await databaseSemanticHash(client, state)) !==
			state.identity.sourceFingerprint
	) {
		throw new PlatformCutoverError(
			'Platform unchanged active row fingerprint mismatch'
		);
	}
	if (
		(await readPlatformSemanticFingerprint(client)) !==
		state.identity.currentSemanticFingerprint
	) {
		throw new PlatformCutoverError(
			'Platform active current semantic fingerprint mismatch'
		);
	}
}

function exactSourceCounts(value: Prisma.JsonValue | null): boolean {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		return false;
	const counts = value as Record<string, unknown>;
	return (
		Object.keys(counts).sort().join('|') ===
			'homePageContent|legalPages|siteSettings' &&
		counts.siteSettings === 1 &&
		counts.legalPages === 4 &&
		counts.homePageContent === 1
	);
}

async function databaseSemanticHash(
	_client: PlatformDatabaseClient,
	state: Awaited<ReturnType<typeof targetStatus>>
): Promise<string> {
	if (
		state.identity.sourceHighWatermark === null ||
		state.offer.producerContractVersion !== 2 ||
		state.offer.sourceSequenceScope !== 'billing.offer:offer' ||
		state.offer.importedAggregateVersion === null ||
		state.offer.importedSourceSequence === null ||
		!state.offer.sourceFenceFingerprint
	) {
		throw new PlatformCutoverError('Platform source anchors are missing');
	}
	const oferta = state.legal.find(page => page.slug === 'oferta');
	if (!oferta)
		throw new PlatformCutoverError('Platform oferta is missing');
	const producer: BillingOfferProducerSnapshot = {
		contractVersion: 2,
		sequenceScope: 'billing.offer:offer',
		aggregateVersion: state.offer.importedAggregateVersion.toString(),
		sourceSequence: state.offer.importedSourceSequence.toString(),
		fingerprint: state.offer.sourceFenceFingerprint
	};
	if (
		billingOfferFingerprint(oferta.content, producer) !==
		producer.fingerprint
	) {
		throw new PlatformCutoverError(
			'Platform Billing offer producer fingerprint mismatch'
		);
	}
	return semanticHash({
		platformHighWater: state.identity.sourceHighWatermark.toString(),
		counts: { siteSettings: 1, legalPages: 4, homePageContent: 1 },
		siteSettings: {
			id: 'singleton',
			bannerEnabled: state.site.bannerEnabled,
			bannerText: state.site.bannerText,
			snowflakeEnabled: state.site.snowflakeEnabled,
			updatedAt: state.site.updatedAt.toISOString(),
			aggregateVersion: state.site.aggregateVersion.toString(),
			sourceSequence: state.site.sourceSequence.toString()
		},
		legalPages: state.legal.map(page => ({
			slug: page.slug,
			content: page.content,
			updatedAt: page.updatedAt.toISOString(),
			aggregateVersion: page.aggregateVersion.toString(),
			sourceSequence: page.sourceSequence.toString()
		})),
		homePageContent: {
			id: 'singleton',
			content: state.home.content,
			updatedAt: state.home.updatedAt.toISOString(),
			aggregateVersion: state.home.aggregateVersion.toString(),
			sourceSequence: state.home.sourceSequence.toString()
		},
		billingOfferProducer: producer
	});
}

export function snapshotSemanticHash(
	snapshot: PlatformCutoverSnapshot
): string {
	return semanticHash({
		platformHighWater: snapshot.platformHighWater,
		counts: snapshot.counts,
		siteSettings: snapshot.siteSettings,
		legalPages: snapshot.legalPages,
		homePageContent: snapshot.homePageContent,
		billingOfferProducer: snapshot.billingOfferProducer
	});
}

export function billingOfferFingerprint(
	content: string,
	producer:
		| Omit<BillingOfferProducerSnapshot, 'fingerprint'>
		| BillingOfferProducerSnapshot
): string {
	return semanticHash({
		aggregateType: 'billing.offer',
		aggregateId: 'offer',
		contractVersion: producer.contractVersion,
		sequenceScope: producer.sequenceScope,
		aggregateVersion: producer.aggregateVersion,
		sourceSequence: producer.sourceSequence,
		contentSha256: createHash('sha256')
			.update(content, 'utf8')
			.digest('hex')
	});
}

function semanticHash(value: unknown): string {
	return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function canonicalJson(value: unknown): string {
	if (value instanceof Date) return JSON.stringify(value.toISOString());
	if (
		value === null ||
		typeof value === 'string' ||
		typeof value === 'boolean'
	) {
		return JSON.stringify(value);
	}
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) invalid('non-finite number');
		return JSON.stringify(value);
	}
	if (typeof value === 'bigint') return JSON.stringify(value.toString());
	if (Array.isArray(value)) {
		return `[${value.map(item => canonicalJson(item)).join(',')}]`;
	}
	if (value && typeof value === 'object') {
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) =>
				left < right ? -1 : left > right ? 1 : 0
			)
			.map(
				([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`
			)
			.join(',')}}`;
	}
	invalid('unsupported canonical value');
}

function databaseUrl(): string {
	const value = process.env.PLATFORM_DATABASE_URL?.trim() || '';
	if (!value || ['change_me', 'change-me', 'XYZXYZXYZ'].includes(value)) {
		throw new PlatformCutoverError('PLATFORM_DATABASE_URL is missing');
	}
	return value;
}

export async function runPlatformCutover(
	args: CutoverArgs
): Promise<Record<string, unknown>> {
	const client = new PrismaClient({
		datasources: { db: { url: databaseUrl() } }
	});
	try {
		await client.$connect();
		if (args.action === 'status') return await status(client);
		if (args.action === 'validate-shadow')
			return await validateShadow(client);
		if (args.action === 'verify') return await verify(client);
		if (args.action === 'activate')
			return await activate(client, args.sha256!);
		if (args.action === 'abort')
			return await abortImport(client, args.sha256!);
		const loaded = await loadPlatformSnapshot(args.file!, args.sha256);
		if (args.action === 'preflight')
			return await preflight(client, loaded);
		if (args.action === 'import')
			return await importSnapshot(client, loaded);
		throw new PlatformCutoverError('Unsupported Platform cutover action');
	} finally {
		await client.$disconnect();
	}
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		invalid(label);
	return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, expected: string[]) {
	const keys = Object.keys(value).sort();
	const wanted = [...expected].sort();
	if (
		keys.length !== wanted.length ||
		keys.some((key, index) => key !== wanted[index])
	) {
		invalid('unexpected snapshot keys');
	}
}

function date(value: unknown): value is string {
	if (typeof value !== 'string') return false;
	const parsed = new Date(value);
	return (
		Number.isFinite(parsed.getTime()) && parsed.toISOString() === value
	);
}

function uuid(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
			value
		)
	);
}

function digest(value: unknown): value is string {
	return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function positive(value: unknown, label: string): bigint {
	if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value))
		invalid(label);
	return BigInt(value);
}

function invalid(label: string): never {
	throw new PlatformCutoverError(`Invalid Platform cutover ${label}`);
}

if (require.main === module) {
	runPlatformCutover(parsePlatformCutoverArgs(process.argv.slice(2)))
		.then(result => process.stdout.write(`${JSON.stringify(result)}\n`))
		.catch(error => {
			process.stderr.write(
				`${JSON.stringify({
					ok: false,
					error:
						error instanceof PlatformCutoverError
							? error.message
							: 'Platform cutover failed'
				})}\n`
			);
			process.exitCode = 1;
		});
}
