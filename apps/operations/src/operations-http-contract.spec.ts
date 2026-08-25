import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { AdminEventLogController } from './admin-event-log/admin-event-log.controller';
import { OPERATIONS_REQUIRED_ROLES } from './auth/operations-auth.guard';
import { OperationsIdentityGuard } from './internal/operations-identity.guard';
import { NotesController } from './notes/notes.controller';
import { getOperationsRoleScopedProviders } from './operations.module';
import { OPERATIONS_GLOBAL_PREFIX_EXCLUDES } from './runtime/operations-http.config';

describe('Operations HTTP access contract', () => {
	it('keeps the Identity owner overview on its unprefixed internal route', () => {
		expect(OPERATIONS_GLOBAL_PREFIX_EXCLUDES).toContainEqual({
			path: 'internal/v1/identity/users/:userId/admin-events/overview',
			method: RequestMethod.GET
		});
	});

	it('registers the Identity inbound guard only in the API process role', () => {
		expect(getOperationsRoleScopedProviders('api')).toEqual([
			OperationsIdentityGuard
		]);
		expect(getOperationsRoleScopedProviders('worker')).toEqual([]);
		expect(getOperationsRoleScopedProviders('outbox-publisher')).toEqual(
			[]
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
