import * as continuity from '../domain/billing-offer-continuity';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePlatformCoreArgs } from './core-main';
import {
	billingOfferFingerprint,
	canonicalJson,
	loadPlatformSnapshot,
	parsePlatformCutoverArgs,
	parseSnapshot,
	PlatformCutoverError,
	type PlatformCutoverSnapshot,
	snapshotSemanticHash
} from './main';

function snapshot(): PlatformCutoverSnapshot {
	const timestamp = '2026-08-24T00:00:00.000Z';
	const content =
		'<section data-winwidget-section="auto-renewal-v1">offer</section>';
	const producer = {
		contractVersion: 2 as const,
		sequenceScope: 'billing.offer:offer' as const,
		aggregateVersion: '41',
		sourceSequence: '870'
	};
	const value: PlatformCutoverSnapshot = {
		schemaVersion: 1,
		snapshotId: '11111111-1111-4111-8111-111111111111',
		createdAt: timestamp,
		sourceRevision: 'a'.repeat(40),
		sourceFingerprint: '',
		platformHighWater: '6',
		counts: { siteSettings: 1, legalPages: 4, homePageContent: 1 },
		siteSettings: {
			id: 'singleton',
			bannerEnabled: true,
			bannerText: 'notice',
			snowflakeEnabled: false,
			updatedAt: timestamp,
			aggregateVersion: '1',
			sourceSequence: '1'
		},
		legalPages: [
			{
				slug: 'consent-processing',
				content: '<p>consent</p>',
				updatedAt: timestamp,
				aggregateVersion: '1',
				sourceSequence: '2'
			},
			{
				slug: 'cookie-notice',
				content: '<p>cookies</p>',
				updatedAt: timestamp,
				aggregateVersion: '1',
				sourceSequence: '3'
			},
			{
				slug: 'oferta',
				content,
				updatedAt: timestamp,
				aggregateVersion: '1',
				sourceSequence: '4'
			},
			{
				slug: 'personal-policy',
				content: '<p>policy</p>',
				updatedAt: timestamp,
				aggregateVersion: '1',
				sourceSequence: '5'
			}
		],
		homePageContent: {
			id: 'singleton',
			content: { title: 'WinWidget' },
			updatedAt: timestamp,
			aggregateVersion: '1',
			sourceSequence: '6'
		},
		billingOfferProducer: {
			...producer,
			fingerprint: billingOfferFingerprint(content, producer)
		}
	};
	value.sourceFingerprint = snapshotSemanticHash(value);
	return value;
}

describe('Platform cutover snapshot contract', () => {
	beforeEach(() => {
		jest
			.spyOn(continuity, 'isAutoRenewalOfferCompatible')
			.mockReturnValue(true);
	});

	afterEach(() => jest.restoreAllMocks());

	it('accepts the exact frozen source and producer-scoped cursor', () => {
		expect(parseSnapshot(snapshot())).toEqual(snapshot());
	});

	it('rejects content tampering even when the embedded producer cursor remains valid', () => {
		const value = snapshot();
		value.siteSettings.bannerText = 'tampered';
		expect(() => parseSnapshot(value)).toThrow('sourceFingerprint');
	});

	it('rejects a retired Billing producer contract', () => {
		const value = snapshot();
		(
			value.billingOfferProducer as { contractVersion: number }
		).contractVersion = 1;
		expect(() => parseSnapshot(value)).toThrow(
			'snapshot.billingOfferProducer'
		);
	});

	it('rejects missing or duplicate Platform source continuity', () => {
		const value = snapshot();
		value.legalPages[0]!.sourceSequence = '1';
		expect(() => parseSnapshot(value)).toThrow('source continuity');
	});

	it('rejects a tampered resume file against its durable SHA anchor', async () => {
		const directory = await mkdtemp(
			join(tmpdir(), 'platform-snapshot-test-')
		);
		const file = join(directory, 'snapshot.json');
		try {
			const value = snapshot();
			await writeFile(file, `${canonicalJson(value)}\n`, { mode: 0o600 });
			const anchored = await loadPlatformSnapshot(file);
			value.siteSettings.bannerText = 'tampered after durable anchor';
			value.sourceFingerprint = snapshotSemanticHash(value);
			await writeFile(file, `${canonicalJson(value)}\n`, { mode: 0o600 });

			await expect(
				loadPlatformSnapshot(file, anchored.sha256)
			).rejects.toThrow('SHA-256 differs from expected digest');
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it('rejects a partially written snapshot on resume', async () => {
		const directory = await mkdtemp(
			join(tmpdir(), 'platform-snapshot-test-')
		);
		const file = join(directory, 'snapshot.json');
		try {
			await writeFile(file, '{', { mode: 0o600 });
			await expect(loadPlatformSnapshot(file)).rejects.toThrow(
				'bounded regular file'
			);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});

describe('Platform lifecycle argument contracts', () => {
	it('keeps both source and target preflight actions argument-exact', () => {
		const revision = 'a'.repeat(40);
		expect(
			parsePlatformCoreArgs(['preflight', '--revision', revision])
		).toEqual({
			action: 'preflight',
			revision
		});
		expect(parsePlatformCutoverArgs(['validate-shadow'])).toEqual({
			action: 'validate-shadow'
		});
		expect(() =>
			parsePlatformCutoverArgs([
				'validate-shadow',
				'--sha256',
				'b'.repeat(64)
			])
		).toThrow(PlatformCutoverError);
	});

	it('requires immutable snapshot identity for target activation', () => {
		expect(
			parsePlatformCutoverArgs(['activate', '--sha256', 'b'.repeat(64)])
		).toEqual({
			action: 'activate',
			sha256: 'b'.repeat(64)
		});
		expect(() => parsePlatformCutoverArgs(['activate'])).toThrow(
			PlatformCutoverError
		);
	});

	it('requires every frozen Core activation anchor', () => {
		const revision = 'a'.repeat(40);
		expect(
			parsePlatformCoreArgs([
				'activate',
				'--revision',
				revision,
				'--file',
				'/evidence/platform-snapshot.json',
				'--sha256',
				'b'.repeat(64),
				'--fingerprint',
				'c'.repeat(64),
				'--high-watermark',
				'6'
			])
		).toMatchObject({
			action: 'activate',
			revision,
			file: '/evidence/platform-snapshot.json',
			sha256: 'b'.repeat(64),
			fingerprint: 'c'.repeat(64),
			highWatermark: '6'
		});
		expect(() =>
			parsePlatformCoreArgs([
				'activate',
				'--revision',
				revision,
				'--sha256',
				'b'.repeat(64)
			])
		).toThrow(PlatformCutoverError);
	});
});
