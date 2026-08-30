import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { AdminEventLogController } from './admin-event-log/admin-event-log.controller';
import { OPERATIONS_REQUIRED_ROLES } from './auth/operations-auth.guard';
import { OperationsIdentityGuard } from './internal/operations-identity.guard';
import { OperationsHealthController } from './health/operations-health.controller';
import { NotesController } from './notes/notes.controller';
import { getOperationsRoleScopedProviders } from './operations.module';
import { ReportingPolicyGuard } from './reporting-policy/reporting-policy.guard';
import { ReportingPolicyController } from './reporting-policy/reporting-policy.controller';
import { DatabaseRestoreController } from './restore/database-restore.controller';
import { OPERATIONS_GLOBAL_PREFIX_EXCLUDES } from './runtime/operations-http.config';
import { TelegramSettingsController } from './telegram/telegram-settings.controller';

describe('Operations HTTP access contract', () => {
	it('keeps the Identity owner overview on its unprefixed internal route', () => {
		expect(OPERATIONS_GLOBAL_PREFIX_EXCLUDES).toContainEqual({
			path: 'internal/v1/identity/users/:userId/admin-events/overview',
			method: RequestMethod.GET
		});
	});

	it('registers the Identity inbound guard only in the API process role', () => {
		expect(getOperationsRoleScopedProviders('api')).toEqual([
			OperationsIdentityGuard,
			ReportingPolicyGuard
		]);
		expect(getOperationsRoleScopedProviders('worker')).toEqual([]);
		expect(getOperationsRoleScopedProviders('outbox-publisher')).toEqual(
			[]
		);
	});

	it('keeps deployment public and admin health protected on exact routes', () => {
		expect(
			Reflect.getMetadata(PATH_METADATA, OperationsHealthController)
		).toBe('health');
		expect(
			Reflect.getMetadata(
				PATH_METADATA,
				OperationsHealthController.prototype.deployment
			)
		).toBe('deployment');
		expect(
			Reflect.getMetadata(
				METHOD_METADATA,
				OperationsHealthController.prototype.deployment
			)
		).toBe(RequestMethod.GET);
		expect(
			Reflect.getMetadata(
				PATH_METADATA,
				OperationsHealthController.prototype.admin
			)
		).toBe('admin');
		expect(
			Reflect.getMetadata(
				OPERATIONS_REQUIRED_ROLES,
				OperationsHealthController.prototype.admin
			)
		).toEqual(['ADMIN']);
	});

	it('keeps Reporting reserve and confirm on clean unprefixed routes', () => {
		expect(
			Reflect.getMetadata(PATH_METADATA, ReportingPolicyController)
		).toBe('internal/v1/operations/reporting/schedule-policy');
		expect(
			Reflect.getMetadata(
				METHOD_METADATA,
				ReportingPolicyController.prototype.reserve
			)
		).toBe(RequestMethod.PUT);
		expect(
			Reflect.getMetadata(
				PATH_METADATA,
				ReportingPolicyController.prototype.confirm
			)
		).toBe('confirm');
		expect(OPERATIONS_GLOBAL_PREFIX_EXCLUDES).toContainEqual({
			path: 'internal/v1/operations/reporting/schedule-policy',
			method: RequestMethod.PUT
		});
		expect(OPERATIONS_GLOBAL_PREFIX_EXCLUDES).toContainEqual({
			path: 'internal/v1/operations/reporting/schedule-policy/confirm',
			method: RequestMethod.POST
		});
	});

	it('keeps restore reads ADMIN-visible and every mutation DEV-only', () => {
		expect(
			Reflect.getMetadata(PATH_METADATA, DatabaseRestoreController)
		).toBe('dev-tools');
		expect(
			Reflect.getMetadata(
				OPERATIONS_REQUIRED_ROLES,
				DatabaseRestoreController
			)
		).toEqual(['ADMIN', 'DEV']);
		expect(
			Reflect.getMetadata(
				OPERATIONS_REQUIRED_ROLES,
				DatabaseRestoreController.prototype.settings
			)
		).toBeUndefined();
		expect(
			Reflect.getMetadata(
				OPERATIONS_REQUIRED_ROLES,
				DatabaseRestoreController.prototype.getJob
			)
		).toBeUndefined();
		expect(
			Reflect.getMetadata(
				PATH_METADATA,
				DatabaseRestoreController.prototype.enqueue
			)
		).toBe('database-restores/:target');
		expect(
			Reflect.getMetadata(
				METHOD_METADATA,
				DatabaseRestoreController.prototype.enqueue
			)
		).toBe(RequestMethod.POST);
		for (const method of [
			'createPermit',
			'approvePermit',
			'cancel',
			'createRecoveryAction',
			'approveRecoveryAction',
			'enqueue'
		] as const) {
			expect(
				Reflect.getMetadata(
					OPERATIONS_REQUIRED_ROLES,
					DatabaseRestoreController.prototype[method]
				)
			).toEqual(['DEV']);
		}
	});

	it('preserves the current-admin active database-backup polling route', () => {
		expect(
			Reflect.getMetadata(PATH_METADATA, TelegramSettingsController)
		).toBe('telegram-bot');
		expect(
			Reflect.getMetadata(
				PATH_METADATA,
				TelegramSettingsController.prototype.getLatestActiveManualBackup
			)
		).toBe('admin/database-backups/:target/jobs/active');
		expect(
			Reflect.getMetadata(
				METHOD_METADATA,
				TelegramSettingsController.prototype.getLatestActiveManualBackup
			)
		).toBe(RequestMethod.GET);
		expect(
			Reflect.getMetadata(
				OPERATIONS_REQUIRED_ROLES,
				TelegramSettingsController
			)
		).toEqual(['ADMIN']);
	});

	it('scopes active manual backup polling to the authenticated admin', async () => {
		const jobs = {
			getLatestActiveManual: jest.fn().mockResolvedValue(null)
		};
		const controller = new TelegramSettingsController(
			{} as never,
			jobs as never,
			{} as never
		);

		await expect(
			controller.getLatestActiveManualBackup('operations', {
				subject: 'admin-42',
				roles: ['ADMIN'],
				active: true,
				sessionId: 'session-42'
			})
		).resolves.toBeNull();
		expect(jobs.getLatestActiveManual).toHaveBeenCalledWith(
			'OPERATIONS_DATABASE_BACKUP',
			'admin-42'
		);
	});

	it('keeps every Notes endpoint ADMIN-only', () => {
		expect(
			Reflect.getMetadata(OPERATIONS_REQUIRED_ROLES, NotesController)
		).toEqual(['ADMIN']);
		expect(Reflect.getMetadata(PATH_METADATA, NotesController)).toBe(
			'notes'
		);
		expect(
			Reflect.getMetadata(
				METHOD_METADATA,
				NotesController.prototype.getAll
			)
		).toBe(RequestMethod.GET);
		expect(
			Reflect.getMetadata(
				METHOD_METADATA,
				NotesController.prototype.create
			)
		).toBe(RequestMethod.POST);
		expect(
			Reflect.getMetadata(
				METHOD_METADATA,
				NotesController.prototype.update
			)
		).toBe(RequestMethod.PATCH);
		expect(
			Reflect.getMetadata(
				METHOD_METADATA,
				NotesController.prototype.delete
			)
		).toBe(RequestMethod.DELETE);
	});

	it('keeps AdminEventLog GET ADMIN-only', () => {
		expect(
			Reflect.getMetadata(
				OPERATIONS_REQUIRED_ROLES,
				AdminEventLogController
			)
		).toEqual(['ADMIN']);
		expect(
			Reflect.getMetadata(PATH_METADATA, AdminEventLogController)
		).toBe('admin-event-log');
		expect(
			Reflect.getMetadata(
				METHOD_METADATA,
				AdminEventLogController.prototype.getAll
			)
		).toBe(RequestMethod.GET);
		expect(
			Reflect.getMetadata(
				OPERATIONS_REQUIRED_ROLES,
				AdminEventLogController.prototype.retryFailure
			)
		).toEqual(['DEV']);
		expect(
			Reflect.getMetadata(
				METHOD_METADATA,
				AdminEventLogController.prototype.retryFailure
			)
		).toBe(RequestMethod.POST);
	});
});
