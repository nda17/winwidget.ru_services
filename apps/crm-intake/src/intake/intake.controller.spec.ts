import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { IntakeAuthorizationClient } from '../access/intake-authorization.client';
import { IntakeController } from './intake.controller';
import { IntakeService } from './intake.service';

describe('IntakeController authorization boundary', () => {
	const workspaceId = randomUUID();
	const command = {
		schemaVersion: 1 as const,
		workspaceId,
		commandId: randomUUID(),
		title: 'Запрос',
		name: 'Анна'
	};
	const setup = () => {
		const authorization = {
			authorize: jest
				.fn()
				.mockResolvedValue({ workspaceId, subject: 'actor' })
		};
		const intake = { createManual: jest.fn(), list: jest.fn() };
		return {
			authorization,
			intake,
			controller: new IntakeController(
				authorization as unknown as IntakeAuthorizationClient,
				intake as unknown as IntakeService
			)
		};
	};
	it.each([undefined, '', 'another-key'])(
		'rejects mismatched idempotency %s before mutation',
		async key => {
			const { controller, authorization, intake } = setup();
			await expect(
				controller.create('Bearer token', key, command)
			).rejects.toBeInstanceOf(BadRequestException);
			expect(authorization.authorize).not.toHaveBeenCalled();
			expect(intake.createManual).not.toHaveBeenCalled();
		}
	);
	it('reauthorizes every manual request with its current bearer', async () => {
		const { controller, authorization, intake } = setup();
		await controller.create('Bearer first', command.commandId, command);
		await controller.create('Bearer second', command.commandId, command);
		expect(authorization.authorize.mock.calls).toEqual([
			['Bearer first', workspaceId],
			['Bearer second', workspaceId]
		]);
		expect(intake.createManual).toHaveBeenLastCalledWith(
			{ workspaceId, subject: 'actor' },
			command
		);
	});
	it('never reads Inbox data after access denial', async () => {
		const { controller, authorization, intake } = setup();
		authorization.authorize.mockRejectedValue(new ForbiddenException());
		await expect(
			controller.list('Bearer token', {
				workspaceId,
				page: 1,
				pageSize: 25
			})
		).rejects.toBeInstanceOf(ForbiddenException);
		expect(intake.list).not.toHaveBeenCalled();
	});
});
