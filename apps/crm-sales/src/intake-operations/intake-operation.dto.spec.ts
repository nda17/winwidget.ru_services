import { ValidationPipe } from '@nestjs/common';
import {
	CloseIntakeOperation,
	ExecuteIntakeOperation,
	IntakeOperationBinding,
	operationBinding,
	operationHash
} from './intake-operation.dto';

const id = '11111111-1111-4111-8111-111111111111';
const command = {
	schemaVersion: 1 as const,
	workspaceId: id,
	workflowId: id,
	operationId: id,
	actorSubject: 'actor',
	payloadHash: 'a'.repeat(64),
	commandId: id,
	payload: {
		title: 'Запрос',
		currency: 'RUB' as const,
		amountMinor: 100,
		pipelineId: id,
		stageId: id,
		teamId: null,
		nextTask: { title: 'Позвонить', dueAt: '2026-09-06T10:00:00.000Z' },
		contactOperation: { operationId: id, payloadHash: 'b'.repeat(64) }
	}
};
const pipe = new ValidationPipe({
	transform: true,
	whitelist: true,
	forbidNonWhitelisted: true,
	forbidUnknownValues: true
});
const execute = (value: unknown) =>
	pipe.transform(value, {
		type: 'body',
		metatype: ExecuteIntakeOperation
	});
describe('Intake operation exact command DTO', () => {
	it('accepts a complete immutable payload and exact proof binding', async () => {
		await expect(execute(command)).resolves.toEqual(command);
		await expect(
			pipe.transform(operationBinding(command), {
				type: 'body',
				metatype: IntakeOperationBinding
			})
		).resolves.toEqual(operationBinding(command));
		await expect(
			pipe.transform(
				{
					...operationBinding(command),
					commandId: id,
					recoverySubject: 'owner'
				},
				{ type: 'body', metatype: CloseIntakeOperation }
			)
		).resolves.toBeDefined();
	});
	it.each([
		{ ...command, schemaVersion: 2 },
		{ ...command, actorSubject: 'not canonical' },
		{ ...command, commandId: 'invalid' },
		{ ...command, jwt: 'must-not-be-stored' },
		{ ...command, payloadHash: 'A'.repeat(64) },
		{ ...command, operationId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' },
		{ ...command, payload: { ...command.payload, teamId: undefined } },
		{ ...command, payload: { ...command.payload, contactId: id } },
		{ ...command, payload: { ...command.payload, title: ' ' } },
		{ ...command, payload: { ...command.payload, amountMinor: 0.5 } },
		{ ...command, payload: { ...command.payload, currency: 'USD' } },
		{
			...command,
			payload: {
				...command.payload,
				contactOperation: {
					...command.payload.contactOperation,
					name: 'untrusted'
				}
			}
		}
	])(
		'rejects missing, unknown, uncanonical or caller-supplied proof fields',
		async value => {
			await expect(execute(value)).rejects.toHaveProperty('status', 400);
		}
	);
	it('uses sorted object keys without ignoring array order or null fields', () => {
		expect(operationHash({ b: { d: 2, c: 1 }, a: null })).toBe(
			operationHash({ a: null, b: { c: 1, d: 2 } })
		);
		expect(operationHash([1, 2])).not.toBe(operationHash([2, 1]));
		expect(() => operationHash({ a: undefined })).toThrow();
	});
});
