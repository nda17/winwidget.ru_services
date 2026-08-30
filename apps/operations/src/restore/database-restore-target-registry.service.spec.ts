import { ConfigService } from '@nestjs/config';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DATABASE_RESTORE_ACL_CONTRACTS } from './database-restore-acl.contract';
import { DATABASE_RESTORE_TARGETS } from './database-restore.contract';
import { DatabaseRestoreTargetRegistryService } from './database-restore-target-registry.service';

const config = (values: Record<string, string>) =>
	new ConfigService(values);

describe('DatabaseRestoreTargetRegistryService', () => {
	it('contains the exact configuration for every active service-owned target', () => {
		const registry = new DatabaseRestoreTargetRegistryService(config({}));

		expect(
			DATABASE_RESTORE_TARGETS.map(item => registry.get(item))
		).toEqual([
			{
				environmentPrefix: 'NOTIFICATION_DELIVERY',
				database: 'winwidget_notification_delivery',
				schema: 'notification_delivery',
				adminRole: 'winwidget_notification_delivery_admin',
				migrationRole: 'winwidget_notification_delivery_migration',
				runtimeRole: 'winwidget_notification_delivery_runtime',
				backupRole: 'winwidget_notification_delivery_backup',
				acl: DATABASE_RESTORE_ACL_CONTRACTS['notification-delivery']
			},
			...[
				'campaigns',
				'reporting',
				'widgets',
				'identity',
				'platform',
				'support'
			].map(name => ({
				environmentPrefix: name.toUpperCase(),
				database: `winwidget_${name}`,
				schema: name,
				adminRole: `winwidget_${name}_admin`,
				migrationRole: `winwidget_${name}_migration`,
				runtimeRole: `winwidget_${name}_runtime`,
				backupRole: `winwidget_${name}_backup`,
				acl: DATABASE_RESTORE_ACL_CONTRACTS[
					name as keyof typeof DATABASE_RESTORE_ACL_CONTRACTS
				]
			}))
		]);
		expect(registry.all()).toHaveLength(DATABASE_RESTORE_TARGETS.length);
		expect(registry.get('widgets').acl).toEqual({
			profile: 'standard',
			routines: ['enforce_ai_consent_receipt_immutability()'],
			runtimeRoutines: []
		});
	});

	it('builds the exact loopback target from admin user, port, and a secret file', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'operations-secret-'));
		const secretPath = join(directory, 'admin-password');
		await writeFile(secretPath, 'test-restore-password', { mode: 0o600 });
		const registry = new DatabaseRestoreTargetRegistryService(
			config({
				REPORTING_POSTGRES_ADMIN_USER: 'winwidget_reporting_admin',
				REPORTING_POSTGRES_PORT: '55441',
				DATABASE_RESTORE_REPORTING_ADMIN_PASSWORD_FILE: secretPath
			})
		);

		try {
			await expect(
				registry.connection(registry.get('reporting'))
			).resolves.toEqual({
				host: '127.0.0.1',
				port: 55441,
				user: 'winwidget_reporting_admin',
				database: 'winwidget_reporting',
				password: 'test-restore-password'
			});
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it.each([
		[
			'wrong user',
			{
				REPORTING_POSTGRES_ADMIN_USER: 'postgres',
				REPORTING_POSTGRES_PORT: '5432'
			},
			'must be winwidget_reporting_admin'
		],
		[
			'missing port',
			{ REPORTING_POSTGRES_ADMIN_USER: 'winwidget_reporting_admin' },
			'must be an integer between 1 and 65535'
		],
		[
			'invalid port',
			{
				REPORTING_POSTGRES_ADMIN_USER: 'winwidget_reporting_admin',
				REPORTING_POSTGRES_PORT: '65536'
			},
			'must be an integer between 1 and 65535'
		],
		[
			'missing secret path',
			{
				REPORTING_POSTGRES_ADMIN_USER: 'winwidget_reporting_admin',
				REPORTING_POSTGRES_PORT: '5432'
			},
			'must be an absolute file path'
		],
		[
			'relative secret path',
			{
				REPORTING_POSTGRES_ADMIN_USER: 'winwidget_reporting_admin',
				REPORTING_POSTGRES_PORT: '5432',
				DATABASE_RESTORE_REPORTING_ADMIN_PASSWORD_FILE: 'secret'
			},
			'must be an absolute file path'
		],
		[
			'root secret path',
			{
				REPORTING_POSTGRES_ADMIN_USER: 'winwidget_reporting_admin',
				REPORTING_POSTGRES_PORT: '5432',
				DATABASE_RESTORE_REPORTING_ADMIN_PASSWORD_FILE: '/'
			},
			'must be an absolute file path'
		]
	])('rejects %s', async (_label, values, message) => {
		const registry = new DatabaseRestoreTargetRegistryService(
			config(values)
		);

		await expect(
			registry.connection(registry.get('reporting'))
		).rejects.toThrow(message);
	});

	it('rejects a symlinked secret file', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'operations-secret-'));
		const targetPath = join(directory, 'target');
		const linkPath = join(directory, 'link');
		await writeFile(targetPath, 'test-restore-password', { mode: 0o600 });
		await symlink(targetPath, linkPath);
		const registry = configuredRegistry(linkPath);

		try {
			await expect(
				registry.connection(registry.get('reporting'))
			).rejects.toThrow('could not be read safely');
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it.each([
		['', 'does not reference a valid secret file'],
		[' change', 'contains an invalid secret'],
		['change ', 'contains an invalid secret'],
		['one\ntwo', 'contains an invalid secret'],
		['change_me', 'contains an invalid secret'],
		['XYZXYZXYZ', 'contains an invalid secret']
	])('rejects an invalid secret value', async (value, message) => {
		const directory = await mkdtemp(join(tmpdir(), 'operations-secret-'));
		const secretPath = join(directory, 'admin-password');
		await writeFile(secretPath, value, { mode: 0o600 });
		const registry = configuredRegistry(secretPath);

		try {
			await expect(
				registry.connection(registry.get('reporting'))
			).rejects.toThrow(message);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it('rejects directories and secret files larger than 4096 bytes', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'operations-secret-'));
		const nested = join(directory, 'nested');
		const oversized = join(directory, 'oversized');
		await mkdir(nested);
		await writeFile(oversized, 'x'.repeat(4_097), { mode: 0o600 });

		try {
			for (const path of [nested, oversized]) {
				const registry = configuredRegistry(path);
				await expect(
					registry.connection(registry.get('reporting'))
				).rejects.toThrow('does not reference a valid secret file');
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});

const configuredRegistry = (secretPath: string) =>
	new DatabaseRestoreTargetRegistryService(
		config({
			REPORTING_POSTGRES_ADMIN_USER: 'winwidget_reporting_admin',
			REPORTING_POSTGRES_PORT: '55441',
			DATABASE_RESTORE_REPORTING_ADMIN_PASSWORD_FILE: secretPath
		})
	);
