import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	currentOccurrence,
	deliveryKey,
	reminderDeliveryEnabled,
	remindersRole
} from './reminder-delivery.contract';
import { ReminderDeliveryService } from './reminder-delivery.service';
import type { ReminderRuleV1 } from './reminder-rule';

const now = new Date('2026-09-07T12:00:00.000Z');
const workspaceId = randomUUID(),
	taskId = randomUUID(),
	ruleId = randomUUID(),
	deliveryId = randomUUID();
const rule = (): ReminderRuleV1 => ({
	schemaVersion: 1,
	id: ruleId,
	scope: 'PERSONAL',
	ownerBinding: { subject: 'owner', membershipId: null },
	title: 'Напомнить',
	enabled: true,
	channels: ['EMAIL', 'TELEGRAM'],
	trigger: { kind: 'AT_DUE', offsetMinutes: 0 },
	repeats: null,
	timeZone: 'Europe/Moscow',
	quietHours: null,
	recipients: { kind: 'SELF' }
});
function fixture() {
	let task: any = {
		id: taskId,
		workspaceId,
		dealId: null,
		deal: null,
		version: 2,
		status: 'OPEN',
		dueAt: new Date(now),
		title: 'Связаться с клиентом',
		assignedToSubject: 'owner',
		assignedToMembershipId: null,
		teamId: null
	};
	let row: any = {
		id: ruleId,
		workspaceId,
		version: 3,
		scope: 'PERSONAL',
		ownerSubject: 'owner',
		ownerMembershipId: null,
		configuration: rule(),
		archivedAt: null
	};
	let delivery: any = {
		id: deliveryId,
		workspaceId,
		taskId,
		ruleId,
		taskVersion: 2,
		ruleVersion: 3,
		occurrenceIndex: 0,
		recipientSubject: 'owner',
		recipientMembershipId: null,
		channel: 'EMAIL',
		nominalAt: new Date(now),
		status: 'PENDING'
	};
	const recipients = {
		read: jest.fn<Promise<any>, any[]>(async () => ({
			allowed: true,
			items: [
				{
					binding: { subject: 'owner', membershipId: null },
					email: 'owner@example.test',
					telegramChatId: '12345'
				}
			],
			nextCursor: null
		}))
	};
	const created: any[] = [],
		outbox: any[] = [];
	const prisma: any = {
		salesTask: {
			findUnique: jest.fn(async () => task),
			findMany: jest.fn(async () => [task])
		},
		reminderRule: {
			findUnique: jest.fn(async () => row),
			findMany: jest.fn(async () => [row])
		},
		reminderDelivery: {
			findUnique: jest.fn(async () => delivery),
			createMany: jest.fn(async ({ data }) => {
				for (const item of data)
					if (
						!created.some(
							old => old.deduplicationKey === item.deduplicationKey
						)
					)
						created.push({ ...item, createdAt: now });
			}),
			findMany: jest.fn(async ({ where }) =>
				created.filter(item => where.id.in.includes(item.id))
			)
		},
		reminderOutbox: {
			createMany: jest.fn(async ({ data }) => {
				outbox.push(...data);
				return { count: data.length };
			}),
			create: jest.fn(async ({ data }) => {
				outbox.push(data);
				return data;
			})
		},
		reminderJob: {
			createMany: jest.fn(async () => ({ count: 1 })),
			updateMany: jest.fn(async () => ({ count: 1 }))
		},
		$queryRaw: jest.fn(async () => []),
		$transaction: jest.fn(async fn => fn(prisma))
	};
	const service = new ReminderDeliveryService(prisma, recipients as never);
	return {
		service,
		prisma,
		recipients,
		created,
		outbox,
		task: () => task,
		row: () => row,
		delivery: () => delivery,
		setTask: (value: any) => {
			task = value;
		},
		setRule: (value: any) => {
			row = value;
		},
		setDelivery: (value: any) => {
			delivery = value;
		}
	};
}
describe('Sales durable reminder generation and send-time authority', () => {
	const previous = process.env.CRM_TASK_REMINDERS_ENABLED;
	beforeEach(() => {
		jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
		jest.setSystemTime(now);
		process.env.CRM_TASK_REMINDERS_ENABLED = 'true';
	});
	afterEach(() => {
		jest.useRealTimers();
		if (previous === undefined)
			delete process.env.CRM_TASK_REMINDERS_ENABLED;
		else process.env.CRM_TASK_REMINDERS_ENABLED = previous;
	});
	it('defaults delivery off and rejects malformed switches/unknown roles', () => {
		delete process.env.CRM_TASK_REMINDERS_ENABLED;
		expect(reminderDeliveryEnabled()).toBe(false);
		process.env.CRM_TASK_REMINDERS_ENABLED = '1';
		expect(() => reminderDeliveryEnabled()).toThrow();
		const prior = process.env.CRM_SALES_PROCESS_ROLE;
		process.env.CRM_SALES_PROCESS_ROLE = 'worker';
		expect(() => remindersRole()).toThrow();
		if (prior === undefined) delete process.env.CRM_SALES_PROCESS_ROLE;
		else process.env.CRM_SALES_PROCESS_ROLE = prior;
	});
	it('coalesces missed repeats to only the latest immutable index and never invents extra repeats', () => {
		const value = {
			...rule(),
			repeats: { intervalMinutes: 15, count: 10 }
		};
		const due = new Date(now.getTime() - 65 * 60_000);
		expect(currentOccurrence(value, due, now.getTime())).toMatchObject({
			index: 4,
			nominalAt: new Date(now.getTime() - 5 * 60_000)
		});
		expect(
			currentOccurrence(value, due, now.getTime() + 86400000)?.index
		).toBe(9);
		expect(
			currentOccurrence(value, new Date(now.getTime() + 1), now.getTime())
		).toBeNull();
	});
	it('before/after anchors and quiet hours use explicit timezone, not server local time', () => {
		const value = {
			...rule(),
			trigger: { kind: 'BEFORE_DUE' as const, offsetMinutes: 60 }
		};
		expect(
			currentOccurrence(
				value,
				new Date(now.getTime() + 30 * 60_000),
				now.getTime()
			)?.index
		).toBe(0);
		expect(currentOccurrence(value, now, now.getTime())).toBeNull();
		expect(
			currentOccurrence(
				{ ...rule(), trigger: { kind: 'AFTER_DUE', offsetMinutes: 10 } },
				now,
				now.getTime()
			)
		).toBeNull();
		expect(
			currentOccurrence(
				{ ...rule(), quietHours: { start: '14:00', end: '16:00' } },
				now,
				now.getTime()
			)?.notBefore
		).toBe(Date.parse('2026-09-07T13:00:00.000Z'));
	});
	it('binds deduplication to every version/index/recipient/channel dimension', () => {
		const base = {
			taskId,
			taskVersion: 1,
			ruleId,
			ruleVersion: 1,
			occurrenceIndex: 0,
			recipient: { subject: 'owner', membershipId: null },
			channel: 'EMAIL'
		};
		const key = deliveryKey(base);
		expect(key).toMatch(/^[a-f0-9]{64}$/);
		for (const patch of [
			{ taskVersion: 2 },
			{ ruleVersion: 2 },
			{ occurrenceIndex: 1 },
			{ recipient: { subject: 'owner', membershipId: randomUUID() } },
			{ channel: 'TELEGRAM' }
		])
			expect(deliveryKey({ ...base, ...patch })).not.toBe(key);
	});
	it('commits one period wake Outbox with the unique minute job; duplicate period emits nothing', async () => {
		const h = fixture();
		await h.service.schedulePeriod(now);
		expect(h.prisma.reminderJob.createMany.mock.calls[0][0]).toMatchObject(
			{
				skipDuplicates: true,
				data: [{ periodKey: 'minute:2026-09-07T12:00:00.000Z' }]
			}
		);
		expect(h.outbox).toHaveLength(1);
		h.prisma.reminderJob.createMany.mockResolvedValueOnce({ count: 0 });
		await h.service.schedulePeriod(now);
		expect(h.outbox).toHaveLength(1);
	});
	it('generates reference-only events once per channel and replay never emits again', async () => {
		const h = fixture();
		await (h.service as any).generate(h.task(), h.row(), () => true);
		await (h.service as any).generate(h.task(), h.row(), () => true);
		expect(h.created).toHaveLength(2);
		expect(h.outbox).toHaveLength(2);
		for (const message of h.outbox) {
			expect(Object.keys(message.payload).sort()).toEqual([
				'eventId',
				'eventType',
				'occurredAt',
				'reference',
				'schemaVersion'
			]);
			expect(JSON.stringify(message.payload)).not.toMatch(
				/owner|example|12345|Связаться/
			);
		}
		expect(h.recipients.read.mock.calls[0]).toEqual([
			workspaceId,
			h.row().configuration,
			{
				id: taskId,
				assignedToSubject: 'owner',
				assignedToMembershipId: null,
				teamId: null,
				deal: null
			},
			null,
			null
		]);
	});
	it('does not generate an unavailable channel or during quiet hours', async () => {
		const h = fixture();
		h.recipients.read.mockResolvedValueOnce({
			allowed: true,
			items: [
				{
					binding: { subject: 'owner', membershipId: null },
					email: null,
					telegramChatId: '12345'
				}
			],
			nextCursor: null
		} as never);
		await (h.service as any).generate(h.task(), h.row(), () => true);
		expect(h.created.map(row => row.channel)).toEqual(['TELEGRAM']);
		h.row().configuration.quietHours = { start: '14:00', end: '16:00' };
		h.recipients.read.mockClear();
		await (h.service as any).generate(h.task(), h.row(), () => true);
		expect(h.recipients.read).not.toHaveBeenCalled();
	});
	it('changed task while resolving recipients produces neither delivery nor Outbox', async () => {
		const h = fixture(),
			old = { ...h.task() };
		h.recipients.read.mockImplementationOnce(async () => {
			h.task().version++;
			return {
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
		});
		await (h.service as any).generate(old, h.row(), () => true);
		expect(h.outbox).toHaveLength(0);
		expect(h.created).toHaveLength(0);
	});
	it('returns a private current channel only after exact Access proof and repeated Sales snapshot', async () => {
		const h = fixture();
		const result = await h.service.context(deliveryId, {
			eventId: deliveryId,
			workspaceId,
			channel: 'EMAIL'
		});
		expect(result).toMatchObject({
			deliver: true,
			retryAt: null,
			destination: { email: 'owner@example.test', telegramChatId: null },
			content: { taskId, title: 'Связаться с клиентом' }
		});
		expect(h.recipients.read).toHaveBeenCalledWith(
			workspaceId,
			h.row().configuration,
			expect.objectContaining({ deal: null }),
			{ subject: 'owner', membershipId: null }
		);
	});
	it.each([
		'status',
		'taskVersion',
		'ruleVersion',
		'workspace',
		'channel',
		'eventId',
		'archived',
		'disabled',
		'cancelled'
	])(
		'suppresses obsolete or forged binding %s without contacting Access',
		async kind => {
			const h = fixture(),
				input = {
					eventId: deliveryId,
					workspaceId,
					channel: 'EMAIL' as const
				};
			if (kind === 'status') h.task().status = 'COMPLETED';
			if (kind === 'taskVersion') h.task().version++;
			if (kind === 'ruleVersion') h.row().version++;
			if (kind === 'workspace') input.workspaceId = randomUUID();
			if (kind === 'channel') h.delivery().channel = 'TELEGRAM';
			if (kind === 'eventId') input.eventId = randomUUID();
			if (kind === 'archived') h.row().archivedAt = now;
			if (kind === 'disabled') h.row().configuration.enabled = false;
			if (kind === 'cancelled') h.delivery().status = 'CANCELLED';
			expect(await h.service.context(deliveryId, input)).toMatchObject({
				deliver: false,
				destination: null,
				content: null
			});
			expect(h.recipients.read).not.toHaveBeenCalled();
		}
	);
	it('includes current deal assignment and suppresses its concurrent reassignment/archive', async () => {
		const h = fixture();
		h.task().dealId = randomUUID();
		h.task().deal = {
			id: h.task().dealId,
			version: 1,
			assignedToSubject: 'manager',
			teamId: randomUUID(),
			archivedAt: null
		};
		h.recipients.read.mockImplementationOnce(async () => {
			h.setTask({
				...h.task(),
				deal: { ...h.task().deal, assignedToSubject: 'other', version: 2 }
			});
			return {
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
		});
		expect(
			await h.service.context(deliveryId, {
				eventId: deliveryId,
				workspaceId,
				channel: 'EMAIL'
			})
		).toMatchObject({ deliver: false });
		expect(h.recipients.read.mock.calls[0][2]).toMatchObject({
			deal: { assignedToSubject: 'manager' }
		});
	});
	it('READ_ONLY/revoked authority suppresses, while an authority outage fails closed rather than pretending no recipients', async () => {
		const h = fixture();
		h.recipients.read.mockResolvedValueOnce({
			allowed: false,
			items: [],
			nextCursor: null
		});
		expect(
			await h.service.context(deliveryId, {
				eventId: deliveryId,
				workspaceId,
				channel: 'EMAIL'
			})
		).toMatchObject({ deliver: false });
		h.recipients.read.mockRejectedValueOnce(new Error('unavailable'));
		await expect(
			h.service.context(deliveryId, {
				eventId: deliveryId,
				workspaceId,
				channel: 'EMAIL'
			})
		).rejects.toThrow('unavailable');
	});
	it('quiet-hours boundary at send time returns durable defer and never contact data', async () => {
		const h = fixture();
		h.row().configuration.quietHours = { start: '14:00', end: '16:00' };
		expect(
			await h.service.context(deliveryId, {
				eventId: deliveryId,
				workspaceId,
				channel: 'EMAIL'
			})
		).toMatchObject({
			deliver: false,
			retryAt: '2026-09-07T13:00:00.000Z',
			destination: null,
			content: null
		});
	});
	it('old queued occurrences lose eligibility after downtime and newer current index', async () => {
		const h = fixture();
		h.row().configuration.repeats = { intervalMinutes: 15, count: 10 };
		h.task().dueAt = new Date(now.getTime() - 60 * 60_000);
		h.delivery().nominalAt = h.task().dueAt;
		expect(
			await h.service.context(deliveryId, {
				eventId: deliveryId,
				workspaceId,
				channel: 'EMAIL'
			})
		).toMatchObject({ deliver: false });
		expect(h.recipients.read).not.toHaveBeenCalled();
	});
	it('migration invalidates versions and inserts wake Outbox inside task/rule transaction, never using SECURITY DEFINER', () => {
		const sql = readFileSync(
			join(
				__dirname,
				'../../prisma/migrations/20260907230000_add_reminder_delivery/migration.sql'
			),
			'utf8'
		);
		expect(sql).toContain(
			'CREATE TRIGGER tasks_reminder_wake AFTER INSERT OR UPDATE'
		);
		expect(sql).toContain(
			'CREATE TRIGGER rules_reminder_wake AFTER INSERT OR UPDATE'
		);
		expect(sql).toContain("SET status='CANCELLED'");
		expect(sql).toContain('INSERT INTO crm_sales.reminder_outbox');
		expect(sql).not.toMatch(/SECURITY DEFINER|DROP TABLE|DELETE FROM/i);
		expect(sql).toMatch(/FOREIGN KEY\(task_id,workspace_id\)/);
		expect(sql).toMatch(/FOREIGN KEY\(rule_id,workspace_id\)/);
	});
});
