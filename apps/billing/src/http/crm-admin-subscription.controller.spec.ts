import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import {
	GUARDS_METADATA,
	PATH_METADATA,
	PIPES_METADATA
} from '@nestjs/common/constants';
import {
	BILLING_REQUIRED_ROLES,
	BillingAuthGuard
} from '../auth/billing-auth.guard';
import { CrmAdminSubscriptionController } from './crm-admin-subscription.controller';
import {
	CrmAdminSubscriptionListDto,
	CrmAdminSubscriptionPageDto,
	CancelCrmSubscriptionGrantDto,
	ExtendCrmSubscriptionDaysDto
} from './crm-admin-subscription.dto';

const command = {
	schemaVersion: 1,
	commandId: '22222222-2222-4222-8222-222222222222',
	expectedActorSubject: 'operator',
	expectedEntitlementVersion: '1',
	expectedBillingVersion: '0',
	expectedPeriodId: null,
	expectedPeriodVersion: null,
	days: 7,
	reason: '  Компенсация клиенту  '
};
const pipe = new ValidationPipe({
	whitelist: true,
	forbidNonWhitelisted: true,
	transform: true
});

describe('CRM administrative subscription HTTP contract', () => {
	it('guards every endpoint by actual service ADMIN or DEV, not CRM workspace roles', () => {
		expect(
			Reflect.getMetadata(PATH_METADATA, CrmAdminSubscriptionController)
		).toBe('subscriptions/admin/crm');
		expect(
			Reflect.getMetadata(
				BILLING_REQUIRED_ROLES,
				CrmAdminSubscriptionController
			)
		).toEqual(['ADMIN', 'DEV']);
		expect(
			Reflect.getMetadata(GUARDS_METADATA, CrmAdminSubscriptionController)
		).toEqual([BillingAuthGuard]);
		expect(
			Reflect.getMetadata(PIPES_METADATA, CrmAdminSubscriptionController)
		).toHaveLength(1);
	});

	it('accepts and normalizes the reason while retaining explicit nullable period CAS', async () => {
		const value = await pipe.transform(command, {
			type: 'body',
			metatype: ExtendCrmSubscriptionDaysDto
		});
		expect(value).toMatchObject({
			reason: 'Компенсация клиенту',
			expectedPeriodId: null,
			expectedPeriodVersion: null,
			days: 7
		});
	});

	it.each([
		['missing actor', { ...command, expectedActorSubject: undefined }],
		['empty actor', { ...command, expectedActorSubject: '' }],
		[
			'invalid actor',
			{ ...command, expectedActorSubject: 'admin operator' }
		],
		['unknown field', { ...command, paymentStatus: 'SUCCEEDED' }],
		['actor injection', { ...command, actorSubject: 'victim' }],
		['zero days', { ...command, days: 0 }],
		['negative days', { ...command, days: -1 }],
		['fractional days', { ...command, days: 1.5 }],
		['too many days', { ...command, days: 3651 }],
		['blank reason', { ...command, reason: '   ' }],
		['oversize reason', { ...command, reason: 'x'.repeat(1001) }],
		['number version', { ...command, expectedBillingVersion: 1 }],
		['negative version', { ...command, expectedEntitlementVersion: '-1' }],
		['missing period id', { ...command, expectedPeriodId: undefined }],
		[
			'missing period version',
			{ ...command, expectedPeriodVersion: undefined }
		],
		['invalid command', { ...command, commandId: 'not-a-uuid' }]
	])('rejects %s', async (_label, value) => {
		await expect(
			pipe.transform(value, {
				type: 'body',
				metatype: ExtendCrmSubscriptionDaysDto
			})
		).rejects.toMatchObject({ status: 400 });
	});

	it('parses bounded server pagination and rejects unknown history filters', async () => {
		expect(
			await pipe.transform(
				{ page: '2', pageSize: '10', ownerSubject: 'owner' },
				{ type: 'query', metatype: CrmAdminSubscriptionListDto }
			)
		).toMatchObject({ page: 2, pageSize: 10 });
		for (const value of [
			{ page: 0 },
			{ pageSize: 101 },
			{ ownerSubject: 'owner' }
		])
			await expect(
				pipe.transform(value, {
					type: 'query',
					metatype: CrmAdminSubscriptionPageDto
				})
			).rejects.toMatchObject({ status: 400 });
	});

	it('rejects a missing or mismatched key before invoking the domain', () => {
		const service = { extend: jest.fn() };
		const controller = new CrmAdminSubscriptionController(
			service as never
		);
		expect(() =>
			controller.extend(
				'workspace',
				command as never,
				{} as never,
				{} as never,
				'different'
			)
		).toThrow('Idempotency-Key must match commandId');
		expect(service.extend).not.toHaveBeenCalled();
	});

	it('accepts only captured actor cancellation input without new grant fields or a replacement command ID', async () => {
		const valid = { schemaVersion: 1, expectedActorSubject: 'operator' };
		expect(
			await pipe.transform(valid, {
				type: 'body',
				metatype: CancelCrmSubscriptionGrantDto
			})
		).toMatchObject(valid);
		for (const invalid of [
			{ schemaVersion: 1 },
			{ ...valid, commandId: command.commandId },
			{ ...valid, days: 7 }
		])
			await expect(
				pipe.transform(invalid, {
					type: 'body',
					metatype: CancelCrmSubscriptionGrantDto
				})
			).rejects.toMatchObject({ status: 400 });
		const service = { cancel: jest.fn() };
		const controller = new CrmAdminSubscriptionController(
			service as never
		);
		expect(() =>
			controller.cancel(
				'workspace',
				command.commandId,
				valid as never,
				{} as never,
				{} as never,
				'new-id'
			)
		).toThrow('Idempotency-Key must match original commandId');
		expect(service.cancel).not.toHaveBeenCalled();
	});
});
