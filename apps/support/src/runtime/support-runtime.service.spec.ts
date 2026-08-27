import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	getSupportCorsAllowedOrigins,
	getSupportListenHost,
	getSupportTrustProxyConfig
} from './support-http.config';
import {
	parseSupportPort,
	parseSupportProcessRole
} from './support-runtime.service';

describe('Support runtime boundaries', () => {
	it('keeps the steady-state runtime free of cutover ownership gates', () => {
		const schema = readFileSync(
			join(__dirname, '../../prisma/schema.prisma'),
			'utf8'
		);
		const migration = readFileSync(
			join(
				__dirname,
				'../../prisma/migrations/20260827020100_remove_legacy_cutover_state/migration.sql'
			),
			'utf8'
		);
		const moduleSource = readFileSync(
			join(__dirname, '../support.module.ts'),
			'utf8'
		);
		const workerSource = readFileSync(
			join(__dirname, '../messaging/support-webhook-worker.service.ts'),
			'utf8'
		);
		const publisherSource = readFileSync(
			join(__dirname, '../messaging/support-outbox-publisher.service.ts'),
			'utf8'
		);

		expect(schema).not.toContain('ServiceDatabasePhase');
		expect(schema).not.toContain('ownershipGeneration');
		expect(schema).not.toContain('sourceSnapshotSha256');
		expect(migration).toContain(
			'DROP TYPE "support"."ServiceDatabasePhase";'
		);
		expect(migration).toContain(
			'CREATE TRIGGER "service_identity_integrity_guard"'
		);
		expect(moduleSource).not.toContain('SupportOwnership');
		expect(workerSource).not.toContain('ownership');
		expect(publisherSource).not.toContain('ownership');
	});

	it('uses distinct canonical ports for every process role', () => {
		expect(parseSupportPort('api', {})).toBe(5100);
		expect(parseSupportPort('worker', {})).toBe(5101);
		expect(parseSupportPort('outbox-publisher', {})).toBe(5102);
	});

	it('rejects unknown roles and a non-canonical API port', () => {
		expect(() => parseSupportProcessRole('scheduler')).toThrow();
		expect(() =>
			parseSupportPort('api', { SUPPORT_PORT: '5199' })
		).toThrow();
	});

	it('fails closed for wildcard production HTTP boundaries', () => {
		expect(() => getSupportListenHost('production', '0.0.0.0')).toThrow();
		expect(() => getSupportTrustProxyConfig('*')).toThrow();
		expect(() =>
			getSupportCorsAllowedOrigins('production', '*')
		).toThrow();
	});

	it('normalizes explicit production origins and proxy hops', () => {
		expect(
			getSupportCorsAllowedOrigins(
				'production',
				'https://winwidget.ru,https://admin.winwidget.ru'
			)
		).toEqual(['https://winwidget.ru', 'https://admin.winwidget.ru']);
		expect(getSupportTrustProxyConfig('loopback,127.0.0.1')).toEqual([
			'loopback',
			'127.0.0.1'
		]);
	});
});
