import 'reflect-metadata';
import {
	BadRequestException,
	HttpStatus,
	RequestMethod
} from '@nestjs/common';
import {
	GUARDS_METADATA,
	HTTP_CODE_METADATA,
	METHOD_METADATA,
	PATH_METADATA
} from '@nestjs/common/constants';
import { validateSync } from 'class-validator';
import { BillingCrmAccessGuard } from '../auth/billing-crm-access.guard';
import { ActivateCrmTrialCommandDto } from './billing.dto';
import { BillingCrmAccessController } from './billing-crm-access.controller';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const COMMAND_ID = '22222222-2222-4222-8222-222222222222';

describe('BillingCrmAccessController', () => {
	it('keeps the WinCRM entitlement API on a scoped guarded internal route', () => {
		const get = BillingCrmAccessController.prototype.get;
		const activate = BillingCrmAccessController.prototype.activateTrial;

		expect(
			Reflect.getMetadata(PATH_METADATA, BillingCrmAccessController)
		).toBe('internal/v1/crm-access/billing');
		expect(
			Reflect.getMetadata(GUARDS_METADATA, BillingCrmAccessController)
		).toEqual([BillingCrmAccessGuard]);
		expect(Reflect.getMetadata(PATH_METADATA, get)).toBe(
			'entitlements/:workspaceId'
		);
		expect(Reflect.getMetadata(METHOD_METADATA, get)).toBe(
			RequestMethod.GET
		);
		expect(Reflect.getMetadata(HTTP_CODE_METADATA, get)).toBe(
			HttpStatus.OK
		);
		expect(Reflect.getMetadata(PATH_METADATA, activate)).toBe(
			'entitlements/trial'
		);
		expect(Reflect.getMetadata(METHOD_METADATA, activate)).toBe(
			RequestMethod.POST
		);
		expect(Reflect.getMetadata(HTTP_CODE_METADATA, activate)).toBe(
			HttpStatus.OK
		);
	});

	it('requires the idempotency header to match the command', async () => {
		const entitlements = {
			activateTrial: jest.fn().mockResolvedValue({ activated: true })
		};
		const controller = new BillingCrmAccessController(
			entitlements as never
		);
		const command = {
			schemaVersion: 1,
			commandId: COMMAND_ID,
			workspaceId: WORKSPACE_ID,
			activatedByUserId: 'user-1'
		};

		expect(() =>
			controller.activateTrial(command, 'different-command')
		).toThrow(BadRequestException);
		expect(entitlements.activateTrial).not.toHaveBeenCalled();

		await expect(
			controller.activateTrial(command, COMMAND_ID)
		).resolves.toEqual({ activated: true });
		expect(entitlements.activateTrial).toHaveBeenCalledWith(command);
	});

	it('accepts only UUID v4 command and workspace identifiers', () => {
		const valid = Object.assign(new ActivateCrmTrialCommandDto(), {
			schemaVersion: 1,
			commandId: COMMAND_ID,
			workspaceId: WORKSPACE_ID,
			activatedByUserId: 'user-1'
		});
		expect(validateSync(valid)).toHaveLength(0);

		const invalid = Object.assign(new ActivateCrmTrialCommandDto(), {
			...valid,
			commandId: '22222222-2222-1222-8222-222222222222',
			workspaceId: '11111111-1111-5111-8111-111111111111'
		});
		expect(
			validateSync(invalid)
				.map(error => error.property)
				.sort()
		).toEqual(['commandId', 'workspaceId']);
	});
});
