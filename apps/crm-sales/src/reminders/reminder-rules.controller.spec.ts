import 'reflect-metadata';
import {
	BadRequestException,
	ValidationPipe,
	type Type
} from '@nestjs/common';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { randomUUID } from 'node:crypto';
import { SalesAccessGuard, SALES_PERMISSION } from '../sales/sales-access';
import { ReminderRulesController } from './reminder-rules.controller';
import {
	ArchiveReminderRuleDto,
	CreateReminderRuleDto,
	EditReminderRuleDto,
	ReminderActorQuery,
	ReminderPageQuery,
	ReminderRulesQuery
} from './reminder-rules.dto';

describe('ReminderRules HTTP contracts', () => {
	const pipe = new ValidationPipe({
		whitelist: true,
		forbidNonWhitelisted: true,
		forbidUnknownValues: true,
		transform: true
	});
	const base = {
		schemaVersion: 1,
		workspaceId: randomUUID(),
		commandId: randomUUID(),
		actorMembershipId: null
	};
	const transform = (value: unknown, type: Type<unknown>) =>
		pipe.transform(value, { type: 'body', metatype: type as never });
	it('keeps exact Sales prefix/guard and separates read permission from writes', () => {
		expect(
			Reflect.getMetadata(PATH_METADATA, ReminderRulesController)
		).toBe('crm/sales/reminder-rules');
		expect(
			Reflect.getMetadata(GUARDS_METADATA, ReminderRulesController)
		).toEqual([SalesAccessGuard]);
		for (const action of ['list', 'detail', 'history'] as const)
			expect(
				Reflect.getMetadata(
					SALES_PERMISSION,
					ReminderRulesController.prototype[action]
				)
			).toBe('sales:read');
		for (const action of ['create', 'edit', 'archive'] as const)
			expect(
				Reflect.getMetadata(
					SALES_PERMISSION,
					ReminderRulesController.prototype[action]
				)
			).toBe('sales:write');
	});
	it('accepts disabled draft and UUID member/explicit owner-null without trusting binding in DTO', async () => {
		await expect(
			transform({ ...base, rule: {} }, CreateReminderRuleDto)
		).resolves.toBeInstanceOf(CreateReminderRuleDto);
		await expect(
			transform(
				{
					...base,
					actorMembershipId: randomUUID(),
					rule: {},
					expectedVersion: 1
				},
				EditReminderRuleDto
			)
		).resolves.toBeInstanceOf(EditReminderRuleDto);
		await expect(
			transform({ ...base, expectedVersion: 1 }, ArchiveReminderRuleDto)
		).resolves.toBeInstanceOf(ArchiveReminderRuleDto);
	});
	it.each([
		{ ...base, schemaVersion: 2, rule: {} },
		{ ...base, extra: true, rule: {} },
		{ ...base, actorMembershipId: undefined, rule: {} },
		{ ...base, actorMembershipId: '*', rule: {} },
		{ ...base, commandId: 'bad', rule: {} },
		{ ...base, workspaceId: 'bad', rule: {} },
		{ ...base, rule: null },
		{ ...base, rule: [] }
	])('rejects wrong/missing/extraneous command data', async value => {
		await expect(
			transform(value, CreateReminderRuleDto)
		).rejects.toBeInstanceOf(BadRequestException);
	});
	it.each([0, -1, 2147483647, '1', null, undefined])(
		'rejects invalid CAS %s',
		async expectedVersion => {
			await expect(
				transform({ ...base, expectedVersion }, ArchiveReminderRuleDto)
			).rejects.toBeInstanceOf(BadRequestException);
		}
	);
	it('server pagination is bounded and explicit, owner omission is the only absent read membership', async () => {
		await expect(
			transform(
				{
					workspaceId: base.workspaceId,
					page: '2',
					pageSize: '20',
					scope: 'WORKSPACE',
					archived: 'false'
				},
				ReminderRulesQuery
			)
		).resolves.toMatchObject({
			page: 2,
			pageSize: 20,
			scope: 'WORKSPACE',
			archived: 'false'
		});
		for (const patch of [
			{ page: 0 },
			{ pageSize: 101 },
			{ archived: true },
			{ scope: 'ALL' },
			{ actorMembershipId: null },
			{ actorMembershipId: 'owner' },
			{ extra: true }
		])
			await expect(
				transform(
					{ workspaceId: base.workspaceId, ...patch },
					ReminderRulesQuery
				)
			).rejects.toBeInstanceOf(BadRequestException);
		await expect(
			transform({ workspaceId: base.workspaceId }, ReminderActorQuery)
		).resolves.toBeDefined();
		await expect(
			transform(
				{ workspaceId: base.workspaceId, actorMembershipId: randomUUID() },
				ReminderPageQuery
			)
		).resolves.toBeDefined();
	});
	it('rejects mismatched idempotency key before calling mutation service', () => {
		const service = {
				create: jest.fn(),
				edit: jest.fn(),
				archive: jest.fn()
			},
			controller = new ReminderRulesController(service as never),
			request = {
				salesAccess: {},
				headers: { authorization: 'Bearer test' }
			} as never;
		expect(() =>
			controller.create({ ...base, rule: {} } as never, request, 'wrong')
		).toThrow(BadRequestException);
		expect(() =>
			controller.edit(
				randomUUID(),
				{ ...base, expectedVersion: 1, rule: {} } as never,
				request
			)
		).toThrow(BadRequestException);
		expect(() =>
			controller.archive(
				randomUUID(),
				{ ...base, expectedVersion: 1 } as never,
				request,
				'wrong'
			)
		).toThrow(BadRequestException);
		expect(service.create).not.toHaveBeenCalled();
		expect(service.edit).not.toHaveBeenCalled();
		expect(service.archive).not.toHaveBeenCalled();
	});
});
