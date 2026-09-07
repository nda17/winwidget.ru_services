import { ConfigService } from '@nestjs/config';
import { stat, writeFile } from 'node:fs/promises';
import { DATABASE_BACKUP_TARGETS } from '../scheduled-jobs/scheduled-jobs.types';
import { TelegramTransportService } from '../telegram/telegram-transport.service';
import { DatabaseBackupService } from './database-backup.service';
import { DatabaseBackupMigrationManifestService } from './database-backup-migration-manifest.service';
import {
	DatabaseBackupProvenanceService,
	type DatabaseBackupProvenanceEvidence
} from './database-backup-provenance.service';
import { isDatabaseBackupProvenanceTarget } from './database-backup.contract';

const JOB_ID = '123e4567-e89b-42d3-a456-426614174000';
const input = {
	chatId: '-1000000000',
	messageThreadId: 10,
	trigger: 'MANUAL' as const,
	backupJobCreatedAt: '2026-08-31T10:00:00.000Z'
};
const urlKey = (target: string) =>
	`${target.replace(/-/g, '_').toUpperCase()}_BACKUP_URL`;
const testUrl = (target: string) => {
	const schema = target.replace(/-/g, '_');
	return `postgresql://winwidget_${schema}_backup:fixture-only@127.0.0.1:55442/winwidget_${schema}?schema=${schema}&sslmode=disable&connection_limit=1`;
};
type InternalMethods = {
	pgDump: (
		url: string,
		password: string | null,
		schema: string,
		path: string,
		signal: AbortSignal
	) => Promise<void>;
	run: () => Promise<void>;
	version: (command: string) => Promise<string>;
	pgEnvironment: (password: string | null) => NodeJS.ProcessEnv;
};

const harness = (values: Record<string, string> = {}) => {
	const configured: Record<string, string> = {
		...Object.fromEntries(
			DATABASE_BACKUP_TARGETS.map(target => [
				urlKey(target),
				testUrl(target)
			])
		),
		APP_REVISION: 'b'.repeat(40),
		DATABASE_BACKUP_PROVENANCE_KEY_ID: 'test-key',
		DATABASE_BACKUP_PROVENANCE_PRIVATE_KEY_FILE:
			'/not-read-by-this-unit-test.pem',
		...values
	};
	const telegram = {
		sendDocument: jest.fn().mockResolvedValue({ messageId: 1 })
	};
	const provenance = {
		sign: jest.fn(async (evidence: DatabaseBackupProvenanceEvidence) => ({
			envelope: {
				domain: 'winwidget.operations.database-backup-provenance.v1',
				schemaVersion: 1,
				signatureAlgorithm: 'Ed25519',
				keyId: 'test-key',
				evidence
			},
			envelopeSha256: 'a'.repeat(64),
			signatureEd25519Base64: 'test-only'
		}))
	};
	const manifests = new DatabaseBackupMigrationManifestService();
	const service = new DatabaseBackupService(
		new ConfigService(configured),
		telegram as unknown as TelegramTransportService,
		provenance as unknown as DatabaseBackupProvenanceService,
		manifests
	);
	const internal = service as unknown as InternalMethods;
	const dump = jest
		.spyOn(internal, 'pgDump')
		.mockImplementation(async (_url, _password, _schema, path) => {
			await writeFile(path, 'PGDMP-unit-fixture', {
				flag: 'wx',
				mode: 0o600
			});
		});
	jest.spyOn(internal, 'run').mockResolvedValue();
	jest
		.spyOn(internal, 'version')
		.mockImplementation(async command => `${command} (PostgreSQL) 18.1`);
	return { service, internal, dump, telegram, provenance, manifests };
};

describe('DatabaseBackupService target wiring', () => {
	afterEach(() => jest.restoreAllMocks());

	it.each(DATABASE_BACKUP_TARGETS)(
		'backs up %s using its independent URL/schema and existing transport',
		async target => {
			const { service, dump, telegram, provenance, manifests } = harness();
			const controller = new AbortController();
			const result = await service.createAndSend(
				JOB_ID,
				target,
				input,
				controller.signal
			);
			const schema = target.replace(/-/g, '_');
			expect(dump).toHaveBeenCalledWith(
				`postgresql://winwidget_${schema}_backup@127.0.0.1:55442/winwidget_${schema}?sslmode=disable`,
				'fixture-only',
				schema,
				expect.any(String),
				controller.signal
			);
			expect(result.target).toBe(target);
			expect(result.databaseName).toBe(`winwidget_${schema}`);
			expect(result.schema).toBe(schema);
			expect(result.fileName).toMatch(
				new RegExp(`^winwidget-${target}-db-.*\\.dump$`)
			);
			const signed = isDatabaseBackupProvenanceTarget(target);
			expect(telegram.sendDocument).toHaveBeenCalledTimes(signed ? 2 : 1);
			if (signed) {
				expect(provenance.sign).toHaveBeenCalledWith(
					expect.objectContaining({
						target,
						backupJobId: JOB_ID,
						databaseName: `winwidget_${schema}`,
						schema,
						migrationManifestSha: manifests.sha256(target),
						artifactSha256: result.fileSha256
					}),
					'test-key',
					'/not-read-by-this-unit-test.pem'
				);
			} else {
				expect(provenance.sign).not.toHaveBeenCalled();
				expect(result.backupProvenance).toBeNull();
				expect(result.provenanceTelegramReceipt).toBeNull();
			}
			await expect(stat(dump.mock.calls[0][3])).rejects.toMatchObject({
				code: 'ENOENT'
			});
		}
	);

	it.each([
		'crm-access',
		'crm-intake',
		'crm-customers',
		'crm-sales'
	] as const)(
		'rejects a runtime principal and database/schema drift for %s before external work',
		async target => {
			const base = testUrl(target);
			for (const invalid of [
				base.replace('_backup:', '_runtime:'),
				base.replace('_backup:', '_migration:'),
				base.replace('/winwidget_', '/other_'),
				base.replace('schema=crm_', 'schema=other_')
			]) {
				const { service, dump, telegram } = harness({
					[urlKey(target)]: invalid
				});
				await expect(
					service.createAndSend(
						JOB_ID,
						target,
						input,
						new AbortController().signal
					)
				).rejects.toThrow();
				expect(dump).not.toHaveBeenCalled();
				expect(telegram.sendDocument).not.toHaveBeenCalled();
			}
		}
	);

	it.each([
		'user=runtime',
		'dbname=other',
		'password=other',
		'host=other',
		'port=5432',
		'options=-csearch_path=public',
		'schema=crm_access',
		'sslmode=require'
	])(
		'rejects CRM connection override or duplicate query %s',
		async parameter => {
			const { service, dump, telegram } = harness({
				CRM_ACCESS_BACKUP_URL: `${testUrl('crm-access')}&${parameter}`
			});
			await expect(
				service.createAndSend(
					JOB_ID,
					'crm-access',
					input,
					new AbortController().signal
				)
			).rejects.toThrow('unexpected backup principal or parameter');
			expect(dump).not.toHaveBeenCalled();
			expect(telegram.sendDocument).not.toHaveBeenCalled();
		}
	);

	it('removes all thirteen backup URLs from the PostgreSQL child environment', () => {
		const keys = Object.fromEntries(
			DATABASE_BACKUP_TARGETS.map(target => [
				urlKey(target),
				'fixture-only'
			])
		);
		jest.replaceProperty(process, 'env', {
			...process.env,
			...keys,
			PGPASSWORD: 'old-fixture-password'
		});
		const { internal } = harness();
		const environment = internal.pgEnvironment(
			'selected-fixture-password'
		);
		for (const key of Object.keys(keys))
			expect(environment).not.toHaveProperty(key);
		expect(environment.PGPASSWORD).toBe('selected-fixture-password');
		expect(internal.pgEnvironment(null)).not.toHaveProperty('PGPASSWORD');
	});
});
