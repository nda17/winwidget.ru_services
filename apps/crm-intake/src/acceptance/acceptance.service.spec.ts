import { randomUUID } from 'node:crypto';
import { AcceptanceService } from './acceptance.service';
import {
	acceptanceHash,
	parseAcceptanceEvent
} from './acceptance.contract';

function setup() {
	const workspaceId = randomUUID();
	const entry = {
		id: randomUUID(),
		workspaceId,
		status: 'NEW',
		version: 1,
		createdBySubject: 'owner',
		name: 'Анна',
		phone: null,
		email: null,
		teamId: null
	};
	const context = {
		schemaVersion: 1 as const,
		workspaceId,
		subject: 'owner',
		role: 'OWNER' as const,
		state: 'ACTIVE' as const,
		dataScope: 'ALL' as const,
		teamIds: [],
		permissions: ['intake:read', 'intake:write']
	};
	const dto = {
		schemaVersion: 1 as const,
		workspaceId,
		commandId: randomUUID(),
		expectedVersion: 1,
		contact: { mode: 'CREATE_FROM_ENTRY' as const },
		deal: {
			title: 'Сделка',
			currency: 'RUB' as const,
			amountMinor: 0,
			pipelineId: randomUUID(),
			stageId: randomUUID(),
			nextTask: { title: 'Позвонить', dueAt: '2026-09-01T00:00:00.000Z' }
		}
	};
	const tx = {
		$executeRaw: jest.fn(),
		$queryRaw: jest.fn(),
		inboxEntry: {
			findFirst: jest.fn().mockResolvedValue(entry),
			updateMany: jest.fn().mockResolvedValue({ count: 1 })
		},
		acceptance: {
			findFirst: jest.fn().mockResolvedValue(null),
			create: jest.fn(({ data }) =>
				Promise.resolve({
					...data,
					status: 'QUEUED',
					version: 1,
					generation: 1,
					mode: 'EXECUTE',
					contactId: null,
					dealId: null,
					firstTaskId: null,
					lastErrorCode: null,
					retryAt: null,
					completedAt: null,
					createdAt: new Date(),
					updatedAt: new Date()
				})
			),
			update: jest.fn()
		},
		intakeCommand: {
			findUnique: jest.fn().mockResolvedValue(null),
			create: jest.fn()
		},
		intakeActivity: { create: jest.fn() },
		acceptanceOutbox: { createMany: jest.fn() }
	};
	const prisma = {
		...tx,
		$transaction: jest.fn(callback => callback(tx))
	};
	return {
		entry,
		context,
		dto,
		tx,
		prisma,
		service: new AcceptanceService(prisma as never)
	};
}
describe('durable Acceptance intent', () => {
	it('requires explicit name for unnamed WIDGET without rewriting the source snapshot', async () => {
		const c = setup();
		Object.assign(c.entry, { origin: 'WIDGET', name: null });
		await expect(
			c.service.accept(c.context, c.entry.id, c.dto)
		).rejects.toMatchObject({ status: 400 });
		const named = {
			...c.dto,
			contact: { ...c.dto.contact, name: 'Подтверждённое имя' }
		};
		await c.service.accept(c.context, c.entry.id, named);
		expect(
			c.tx.acceptance.create.mock.calls[0][0].data.contactPayload
		).toMatchObject({ mode: 'CREATE', name: 'Подтверждённое имя' });
		expect(c.entry.name).toBeNull();
		expect(c.tx.inboxEntry.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({ data: { version: { increment: 1 } } })
		);
	});
	it.each(['', '  ', ' leading', 'bad\u0000', null])(
		'rejects invalid explicit widget name without downstream writes',
		async name => {
			const c = setup();
			Object.assign(c.entry, { origin: 'WIDGET', name: null });
			await expect(
				c.service.accept(c.context, c.entry.id, {
					...c.dto,
					contact: { ...c.dto.contact, name }
				} as never)
			).rejects.toMatchObject({ status: 400 });
			expect(c.tx.acceptance.create).not.toHaveBeenCalled();
		}
	);
	it('forbids extra name in legacy and existing-contact choices', async () => {
		const c = setup();
		await expect(
			c.service.accept(c.context, c.entry.id, {
				...c.dto,
				contact: { ...c.dto.contact, name: 'Different' }
			})
		).rejects.toMatchObject({ status: 400 });
		Object.assign(c.entry, { origin: 'WIDGET', name: null });
		await expect(
			c.service.accept(c.context, c.entry.id, {
				...c.dto,
				contact: {
					mode: 'EXISTING',
					contactId: randomUUID(),
					name: 'Different'
				}
			})
		).rejects.toMatchObject({ status: 400 });
		await c.service.accept(c.context, c.entry.id, {
			...c.dto,
			contact: { mode: 'EXISTING', contactId: randomUUID() }
		});
		expect(
			c.tx.acceptance.create.mock.calls[0][0].data.contactPayload
		).toEqual({ mode: 'EXISTING', contactId: expect.any(String) });
	});
	it('atomically reserves Inbox and stores immutable payload bindings, audit, receipt and metadata-only Outbox', async () => {
		const c = setup();
		const result = await c.service.accept(c.context, c.entry.id, c.dto);
		expect(result).toMatchObject({
			schemaVersion: 1,
			acceptance: { status: 'QUEUED', contactId: null, dealId: null }
		});
		const row = c.tx.acceptance.create.mock.calls[0][0].data;
		expect(row.contactPayloadHash).toBe(
			acceptanceHash(row.contactPayload)
		);
		expect(row.salesPayloadHash).toBe(acceptanceHash(row.salesPayload));
		const event =
			c.tx.acceptanceOutbox.createMany.mock.calls[0][0].data[0].payload;
		expect(parseAcceptanceEvent(event).workflowId).toBe(row.id);
		expect(JSON.stringify(event)).not.toContain(c.entry.name);
		expect(JSON.stringify(event)).not.toContain('Bearer');
		expect(c.tx.inboxEntry.updateMany).toHaveBeenCalledWith({
			where: {
				id: c.entry.id,
				workspaceId: c.context.workspaceId,
				status: 'NEW',
				version: 1
			},
			data: { version: { increment: 1 } }
		});
	});
	it('does not accept READ_ONLY or missing scope and never silently creates a contact after an existing-contact choice', async () => {
		const c = setup();
		await expect(
			c.service.accept(
				{ ...c.context, state: 'READ_ONLY' },
				c.entry.id,
				c.dto
			)
		).rejects.toMatchObject({ status: 403 });
		await expect(
			c.service.accept(c.context, c.entry.id, {
				...c.dto,
				contact: { mode: 'EXISTING' }
			})
		).rejects.toMatchObject({ status: 400 });
		expect(c.prisma.$transaction).not.toHaveBeenCalled();
	});
	it('refuses competing acceptance or stale versions', async () => {
		const c = setup();
		c.tx.acceptance.findFirst.mockResolvedValue({ id: randomUUID() });
		await expect(
			c.service.accept(c.context, c.entry.id, c.dto)
		).rejects.toMatchObject({ status: 409 });
		expect(c.tx.acceptanceOutbox.createMany).not.toHaveBeenCalled();
	});
	it('keeps proof, name snapshot and payloads out of the public status response', async () => {
		const c = setup();
		await c.service.accept(c.context, c.entry.id, c.dto);
		const row = await c.tx.acceptance.create.mock.results[0].value;
		c.tx.acceptance.findFirst.mockResolvedValue({
			...row,
			contactProof: { contactName: 'secret snapshot' },
			salesPayload: { private: 'data' }
		});
		const result = await c.service.get(
			c.context,
			c.entry.id,
			c.context.workspaceId
		);
		expect(JSON.stringify(result)).not.toContain('secret snapshot');
		expect(JSON.stringify(result)).not.toContain('salesPayload');
	});
});
