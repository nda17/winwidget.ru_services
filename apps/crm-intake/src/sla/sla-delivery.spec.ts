import {
	ForbiddenException,
	ServiceUnavailableException
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { SlaDeliveryService } from './sla-delivery.service';
import { SlaDeliveryGuard } from './sla-delivery.controller';
import { SlaService } from './sla.service';
import { SlaReadinessService } from './sla-readiness.service';

const workspaceId = randomUUID(),
	id = randomUUID(),
	entryId = randomUUID(),
	jobId = randomUUID();
const binding = { subject: 'owner', membershipId: null };
const config = {
	enabled: true,
	workingMinutes: 60,
	timeZone: 'Europe/Moscow',
	weekdays: [1, 2, 3, 4, 5],
	workStart: '09:00',
	workEnd: '18:00',
	responsibleBinding: null,
	notifyManagers: true,
	channels: ['EMAIL']
};
const request = {
	schemaVersion: 1,
	eventId: id,
	workspaceId,
	channel: 'EMAIL'
};
const context = {
	schemaVersion: 1,
	workspaceId,
	subject: 'owner',
	role: 'OWNER',
	state: 'ACTIVE',
	dataScope: 'ALL',
	teamIds: [],
	permissions: ['intake:read', 'intake:write']
};
function fixture() {
	const notification = {
		id,
		workspaceId,
		jobId,
		channel: 'EMAIL',
		recipientSubject: 'owner',
		recipientMembershipId: null
	};
	const job = {
		id: jobId,
		workspaceId,
		entryId,
		ruleVersion: 1,
		status: 'BREACHED',
		breachedAt: new Date(),
		dueAt: new Date('2026-09-08T09:00:00.000Z')
	};
	const entry = {
		id: entryId,
		workspaceId,
		status: 'NEW',
		title: 'Обращение',
		version: 1,
		createdBySubject: 'owner',
		teamId: null,
		receivedAt: new Date('2026-09-08T08:00:00Z')
	};
	const rule = {
		workspaceId,
		version: 1,
		enabled: true,
		config,
		ownerBinding: binding,
		effectiveAt: new Date('2026-09-08T07:00:00Z')
	};
	const db = {
		slaNotification: {
			findFirst: jest.fn().mockResolvedValue(notification)
		},
		slaJob: { findFirst: jest.fn().mockResolvedValue(job) },
		inboxEntry: { findFirst: jest.fn().mockResolvedValue(entry) },
		slaRule: { findUnique: jest.fn().mockResolvedValue(rule) },
		acceptance: { findFirst: jest.fn().mockResolvedValue(null) }
	};
	const prisma = { ...db, $transaction: jest.fn(fn => fn(db)) };
	const recipients = {
		read: jest.fn().mockResolvedValue({
			allowed: true,
			items: [
				{ binding, email: 'verified@example.test', telegramChatId: null }
			],
			nextCursor: null
		})
	};
	return {
		db,
		entry,
		job,
		rule,
		recipients,
		prisma,
		service: new SlaDeliveryService(prisma as never, recipients as never)
	};
}
describe('Intake SLA fresh delivery owner boundary', () => {
	const env = process.env;
	beforeEach(() => {
		process.env = { ...env, CRM_INTAKE_SLA_ENABLED: 'true' };
	});
	afterEach(() => {
		process.env = env;
	});
	it('returns a minimal current verified context only after both owner reads', async () => {
		const { service, recipients, db } = fixture();
		expect(await service.context(id, request)).toMatchObject({
			deliver: true,
			destination: {
				email: 'verified@example.test',
				telegramChatId: null
			},
			content: { entryId, title: 'Обращение', timeZone: 'Europe/Moscow' }
		});
		expect(recipients.read).toHaveBeenCalledWith(
			workspaceId,
			binding,
			config,
			{ id: entryId, createdBySubject: 'owner', teamId: null },
			binding
		);
		expect(db.acceptance.findFirst).toHaveBeenCalledTimes(2);
	});
	it.each([
		'disabled',
		'accepted',
		'acceptance',
		'rule',
		'recipient',
		'readonly',
		'channel'
	])('suppresses %s without exposing content', async reason => {
		const { service, db, entry, rule, recipients } = fixture();
		if (reason === 'disabled')
			process.env.CRM_INTAKE_SLA_ENABLED = 'false';
		if (reason === 'accepted')
			db.inboxEntry.findFirst.mockResolvedValue({
				...entry,
				status: 'ACCEPTED'
			});
		if (reason === 'acceptance')
			db.acceptance.findFirst.mockResolvedValue({ id: randomUUID() });
		if (reason === 'rule')
			db.slaRule.findUnique.mockResolvedValue({ ...rule, version: 2 });
		if (reason === 'recipient')
			recipients.read.mockResolvedValue({
				allowed: true,
				items: [],
				nextCursor: null
			});
		if (reason === 'readonly')
			recipients.read.mockResolvedValue({
				allowed: false,
				items: [],
				nextCursor: null
			});
		if (reason === 'channel')
			recipients.read.mockResolvedValue({
				allowed: true,
				items: [{ binding, email: null, telegramChatId: null }],
				nextCursor: null
			});
		expect(await service.context(id, request)).toMatchObject({
			deliver: false,
			destination: null,
			content: null
		});
	});
	it('suppresses acceptance committed during the Access call and retries changed scope', async () => {
		const f = fixture();
		f.recipients.read.mockImplementation(async () => {
			f.db.acceptance.findFirst.mockResolvedValue({ id: randomUUID() });
			return {
				allowed: true,
				items: [
					{ binding, email: 'v@example.test', telegramChatId: null }
				],
				nextCursor: null
			};
		});
		expect(await f.service.context(id, request)).toMatchObject({
			deliver: false
		});
		const g = fixture();
		g.db.inboxEntry.findFirst
			.mockResolvedValueOnce(g.entry)
			.mockResolvedValue({
				...g.entry,
				version: 2,
				createdBySubject: 'other'
			});
		await expect(g.service.context(id, request)).rejects.toThrow(
			ServiceUnavailableException
		);
	});
	it('rejects invented reference fields and cross-event requests', async () => {
		const { service } = fixture();
		await expect(
			service.context(id, { ...request, eventId: randomUUID() })
		).rejects.toThrow();
		await expect(
			service.context(id, { ...request, email: 'injected@example.test' })
		).rejects.toThrow();
	});
	it('private guard never trusts forwarded loopback or the wrong service', () => {
		process.env.CRM_INTAKE_NOTIFICATION_DELIVERY_TOKEN = 'a'.repeat(40);
		const request = {
			socket: { remoteAddress: '10.0.0.1' },
			headers: {
				'x-forwarded-for': '127.0.0.1',
				'x-winwidget-service': 'notification-delivery',
				'x-winwidget-internal-token': 'a'.repeat(40)
			}
		};
		const ctx = { switchToHttp: () => ({ getRequest: () => request }) };
		expect(() => new SlaDeliveryGuard().canActivate(ctx as never)).toThrow(
			ForbiddenException
		);
		request.socket.remoteAddress = '127.0.0.1';
		expect(new SlaDeliveryGuard().canActivate(ctx as never)).toBe(true);
		request.headers['x-winwidget-service'] = 'crm-sales';
		expect(() => new SlaDeliveryGuard().canActivate(ctx as never)).toThrow(
			ForbiddenException
		);
	});
	it('UI reports inactive delivery and cannot enable a rule before the reader', async () => {
		const f = fixture(),
			readiness = { ready: jest.fn().mockResolvedValue(false) };
		const service = new SlaService(
			f.prisma as never,
			{} as never,
			readiness as never
		);
		expect(await service.read(context as never)).toMatchObject({
			deliveryEnabled: false,
			rule: { version: 1 }
		});
		await expect(
			service.save(
				context as never,
				{
					schemaVersion: 1,
					workspaceId,
					commandId: randomUUID(),
					expectedVersion: 1,
					config
				} as never
			)
		).rejects.toThrow(ServiceUnavailableException);
		await expect(
			service.save(
				{ ...context, state: 'READ_ONLY' } as never,
				{} as never
			)
		).rejects.toThrow(ForbiddenException);
	});
	it('readiness stays false before explicit source activation', async () => {
		process.env.CRM_INTAKE_SLA_ENABLED = 'false';
		expect(await new SlaReadinessService().ready()).toBe(false);
	});
});
