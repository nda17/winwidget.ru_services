import { PATH_METADATA, MODULE_METADATA } from '@nestjs/common/constants';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { OperationsModule } from '../operations.module';
import {
	ADMIN_EVENT_LOG_ACTIONS,
	ADMIN_EVENT_LOG_SECTIONS
} from './admin-event-log.contract';

describe('removed administration Backlog', () => {
	it('does not register a Notes HTTP controller or feature provider', () => {
		const controllers = Reflect.getMetadata(
			MODULE_METADATA.CONTROLLERS,
			OperationsModule
		) as Array<{ name: string }>;
		const providers = Reflect.getMetadata(
			MODULE_METADATA.PROVIDERS,
			OperationsModule
		) as Array<{ name: string }>;
		expect(
			controllers.some(
				controller =>
					Reflect.getMetadata(PATH_METADATA, controller) === 'notes'
			)
		).toBe(false);
		expect(
			providers.some(provider => provider.name === 'NotesService')
		).toBe(false);
	});

	it('does not accept removed Backlog audit actions or filters', () => {
		expect(ADMIN_EVENT_LOG_SECTIONS).not.toContain('BACKLOG');
		expect(
			ADMIN_EVENT_LOG_ACTIONS.some(action => action.startsWith('BACKLOG_'))
		).toBe(false);
	});

	it('removes only the scoped task table and audit copies in one bounded transaction', () => {
		const sql = readFileSync(
			resolve(
				__dirname,
				'../../prisma/migrations/20260910110000_remove_admin_backlog/migration.sql'
			),
			'utf8'
		);
		expect(sql).toContain('BEGIN;');
		expect(sql).toContain("SET LOCAL lock_timeout = '10s';");
		expect(sql).toContain("SET LOCAL statement_timeout = '60s';");
		expect(sql).toContain(
			'LOCK TABLE "operations"."notes" IN ACCESS EXCLUSIVE MODE;'
		);
		expect(sql).toContain('DROP TABLE "operations"."notes" RESTRICT;');
		expect(sql).toContain('WHERE "section" = \'BACKLOG\'');
		expect(sql).toContain('OR "entity_type" = \'backlog_task\'');
		expect(sql).toContain("'BACKLOG_TASK_CREATE'");
		expect(sql).toContain("'BACKLOG_TASK_UPDATE'");
		expect(sql).toContain("'BACKLOG_TASK_DELETE'");
		expect(sql.trim().endsWith('COMMIT;')).toBe(true);
		const statements = sql.replace(/--[^\n]*/g, '');
		expect(statements).not.toMatch(
			/CASCADE|TRUNCATE|GRANT|FUNCTION|TRIGGER/i
		);
		expect(statements.match(/DELETE FROM/g)).toHaveLength(1);
		expect(statements).not.toMatch(
			/outbox_events|audit_event_receipts|crm_customers|database_restore/
		);
	});
});
