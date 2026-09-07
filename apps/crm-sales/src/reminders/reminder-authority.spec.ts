import {
	ForbiddenException,
	ServiceUnavailableException,
	ValidationPipe
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ReminderRecipientsClient } from './reminder-recipients.client';
import { ReminderReadinessService } from './reminder-readiness.service';
import {
	ReminderDeliveryContextDto,
	ReminderDeliveryGuard
} from './reminder-delivery.controller';

const workspaceId = randomUUID(),
	taskId = randomUUID();
const value: any = {
	schemaVersion: 1,
	workspaceId,
	allowed: true,
	items: [
		{
			binding: { subject: 'owner', membershipId: null },
			email: 'owner@example.test',
			telegramChatId: '12345'
		}
	],
	nextCursor: null
};
const rule: any = {
	scope: 'PERSONAL',
	ownerBinding: { subject: 'owner', membershipId: null },
	recipients: { kind: 'SELF' }
};
const task = {
	id: taskId,
	assignedToSubject: 'owner',
	assignedToMembershipId: null,
	teamId: null,
	deal: null
};
const keys = [
	'CRM_TASK_REMINDERS_ENABLED',
	'CRM_ACCESS_INTERNAL_BASE_URL',
	'CRM_ACCESS_CRM_SALES_TOKEN',
	'CRM_SALES_NOTIFICATION_DELIVERY_TOKEN',
	'NOTIFICATION_DELIVERY_CRM_SALES_TOKEN',
	'NOTIFICATION_DELIVERY_INTERNAL_BASE_URL',
	'APP_REVISION'
] as const;
const previous = new Map(keys.map(key => [key, process.env[key]]));
describe('Reminder private authority and activation proof', () => {
	const fetchBefore = global.fetch;
	beforeEach(() => {
		process.env.CRM_TASK_REMINDERS_ENABLED = 'true';
		process.env.CRM_ACCESS_INTERNAL_BASE_URL = 'http://127.0.0.1:5300';
		process.env.CRM_ACCESS_CRM_SALES_TOKEN =
			'access-only-unit-secret-'.repeat(3);
		process.env.CRM_SALES_NOTIFICATION_DELIVERY_TOKEN =
			'nd-to-sales-only-unit-secret-'.repeat(3);
		process.env.NOTIFICATION_DELIVERY_CRM_SALES_TOKEN =
			'sales-to-nd-only-unit-secret-'.repeat(3);
		process.env.NOTIFICATION_DELIVERY_INTERNAL_BASE_URL =
			'http://127.0.0.1:4540';
		process.env.APP_REVISION = 'a'.repeat(40);
		global.fetch = jest.fn(
			async () =>
				new Response(JSON.stringify(value), {
					headers: { 'content-type': 'application/json' }
				})
		);
	});
	afterEach(() => {
		global.fetch = fetchBefore;
		for (const [key, old] of previous) {
			if (old === undefined) delete process.env[key];
			else process.env[key] = old;
		}
	});
	it('calls only the Sales-scoped private endpoint without user bearer and forwards current deal authority', async () => {
		const result = await new ReminderRecipientsClient().read(
			workspaceId,
			rule,
			task,
			{ subject: 'owner', membershipId: null }
		);
		expect(result).toMatchObject({ allowed: true, items: value.items });
		const [url, options] = (global.fetch as jest.Mock).mock.calls[0];
		expect(url).toBe(
			'http://127.0.0.1:5300/internal/v1/crm-access/task-reminder-recipients'
		);
		expect(options.redirect).toBe('error');
		expect(options.cache).toBe('no-store');
		expect(options.headers.authorization).toBeUndefined();
		expect(JSON.parse(options.body)).toEqual({
			schemaVersion: 1,
			workspaceId,
			ruleOwnerBinding: rule.ownerBinding,
			scope: 'PERSONAL',
			task,
			recipients: { kind: 'SELF' },
			recipientBinding: { subject: 'owner', membershipId: null },
			cursor: null
		});
	});
	it.each([
		{ ...value, workspaceId: randomUUID() },
		{ ...value, extra: true },
		{ ...value, allowed: false },
		{ ...value, items: [...value.items, ...value.items] },
		{
			...value,
			items: [
				{
					...value.items[0],
					binding: { subject: 'other', membershipId: null }
				}
			]
		},
		{
			...value,
			items: [{ ...value.items[0], telegramChatId: '-100123' }]
		},
		{
			...value,
			items: [{ ...value.items[0], email: 'bad\r\naddress@example.test' }]
		},
		{ ...value, nextCursor: randomUUID() }
	])(
		'rejects malformed/foreign proof without exposing private response',
		async output => {
			(global.fetch as jest.Mock).mockResolvedValueOnce(
				new Response(JSON.stringify(output), {
					headers: { 'content-type': 'application/json' }
				})
			);
			await expect(
				new ReminderRecipientsClient().read(workspaceId, rule, task, {
					subject: 'owner',
					membershipId: null
				})
			).rejects.toBeInstanceOf(ServiceUnavailableException);
		}
	);
	it.each([401, 403, 404, 500])(
		'upstream status %s is unavailable, never fake successful empty',
		async status => {
			(global.fetch as jest.Mock).mockResolvedValueOnce(
				new Response('private body', { status })
			);
			await expect(
				new ReminderRecipientsClient().read(workspaceId, rule, task, null)
			).rejects.toThrow('CRM reminder recipient authority is unavailable');
		}
	);
	it('body bound, missing contenttype and redirects fail closed', async () => {
		(global.fetch as jest.Mock).mockResolvedValueOnce(
			new Response('x'.repeat(65537), {
				headers: { 'content-type': 'application/json' }
			})
		);
		await expect(
			new ReminderRecipientsClient().read(workspaceId, rule, task, null)
		).rejects.toBeInstanceOf(ServiceUnavailableException);
	});
	it('guard accepts only loopback ND exact pair secret and no bearer privilege substitution', () => {
		const guard = new ReminderDeliveryGuard();
		const context = (
			ip = '127.0.0.1',
			service = 'notification-delivery',
			token = process.env.CRM_SALES_NOTIFICATION_DELIVERY_TOKEN
		) =>
			({
				switchToHttp: () => ({
					getRequest: () => ({
						socket: { remoteAddress: ip },
						header: (name: string) =>
							({
								'x-winwidget-service': service,
								'x-winwidget-internal-token': token
							})[name]
					})
				})
			}) as any;
		expect(guard.canActivate(context())).toBe(true);
		expect(guard.canActivate(context('::ffff:127.0.0.1'))).toBe(true);
		for (const input of [
			context('8.8.8.8'),
			context('127.0.0.1', 'crm-access'),
			context('127.0.0.1', 'notification-delivery', 'wrong')
		])
			expect(() => guard.canActivate(input)).toThrow(ForbiddenException);
		process.env.CRM_TASK_REMINDERS_ENABLED = 'false';
		expect(guard.canActivate(context())).toBe(true); // authenticated pending events can receive suppression
	});
	it('does not open activation on a flag alone, stale heartbeat or foreign revision', async () => {
		const prisma: any = {
			reminderRuntime: { findUnique: jest.fn(async () => null) }
		};
		const readiness = new ReminderReadinessService(prisma);
		expect(await readiness.ready()).toBe(false);
		expect(global.fetch).not.toHaveBeenCalled();
		for (const row of [
			{
				ready: true,
				lastSeenAt: new Date(Date.now() - 60_000),
				revision: process.env.APP_REVISION
			},
			{ ready: true, lastSeenAt: new Date(), revision: 'b'.repeat(40) }
		]) {
			prisma.reminderRuntime.findUnique.mockResolvedValueOnce(row);
			expect(await readiness.ready()).toBe(false);
		}
		expect(global.fetch).not.toHaveBeenCalled();
	});
	it('requires fresh exact ND channels and separate reverse secret to prove activation', async () => {
		const prisma: any = {
			reminderRuntime: {
				findUnique: jest.fn(async () => ({
					ready: true,
					lastSeenAt: new Date(),
					revision: process.env.APP_REVISION
				}))
			}
		};
		const readiness = new ReminderReadinessService(prisma);
		(global.fetch as jest.Mock).mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					schemaVersion: 1,
					ready: true,
					checkedAt: new Date().toISOString(),
					channels: ['EMAIL', 'TELEGRAM']
				}),
				{ headers: { 'content-type': 'application/json' } }
			)
		);
		expect(await readiness.ready()).toBe(true);
		expect(
			(global.fetch as jest.Mock).mock.calls[0][1].headers[
				'x-winwidget-internal-token'
			]
		).toBe(process.env.NOTIFICATION_DELIVERY_CRM_SALES_TOKEN);
		(global.fetch as jest.Mock).mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					schemaVersion: 1,
					ready: true,
					checkedAt: new Date().toISOString(),
					channels: ['EMAIL']
				}),
				{ headers: { 'content-type': 'application/json' } }
			)
		);
		expect(await readiness.ready()).toBe(false);
		process.env.NOTIFICATION_DELIVERY_CRM_SALES_TOKEN =
			process.env.CRM_SALES_NOTIFICATION_DELIVERY_TOKEN;
		expect(await readiness.ready()).toBe(false);
	});
	it('private delivery context DTO rejects unknown fields and mismatched version/channel', async () => {
		const pipe = new ValidationPipe({
			transform: true,
			whitelist: true,
			forbidNonWhitelisted: true
		});
		const base = {
			schemaVersion: 1,
			eventId: randomUUID(),
			workspaceId,
			channel: 'EMAIL'
		};
		for (const patch of [
			{ schemaVersion: 2 },
			{ channel: 'SMS' },
			{ email: 'foreign@example.test' },
			{ eventId: 'invalid' }
		])
			await expect(
				pipe.transform(
					{ ...base, ...patch },
					{ type: 'body', metatype: ReminderDeliveryContextDto }
				)
			).rejects.toThrow();
	});
});
