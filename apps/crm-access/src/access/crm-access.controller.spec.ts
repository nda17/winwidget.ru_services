import { BadRequestException } from '@nestjs/common';
import { CrmAccessController } from './crm-access.controller';

const COMMAND_ID = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_ID = '22222222-2222-4222-8222-222222222222';

describe('CrmAccessController', () => {
	it('requires the public Idempotency-Key to match commandId', async () => {
		const access = { activateTrial: jest.fn() };
		const controller = new CrmAccessController(access as never);
		expect(() =>
			controller.activateTrial('Bearer token', undefined, {
				schemaVersion: 1,
				commandId: COMMAND_ID,
				workspaceId: WORKSPACE_ID
			})
		).toThrow(BadRequestException);
		expect(access.activateTrial).not.toHaveBeenCalled();
	});

	it('passes an exact idempotent command to the service', () => {
		const access = {
			activateTrial: jest.fn().mockReturnValue({ ok: true })
		};
		const controller = new CrmAccessController(access as never);
		expect(
			controller.activateTrial('Bearer token', COMMAND_ID, {
				schemaVersion: 1,
				commandId: COMMAND_ID,
				workspaceId: WORKSPACE_ID
			})
		).toEqual({ ok: true });
		expect(access.activateTrial).toHaveBeenCalledWith('Bearer token', {
			schemaVersion: 1,
			commandId: COMMAND_ID,
			workspaceId: WORKSPACE_ID
		});
	});
});
