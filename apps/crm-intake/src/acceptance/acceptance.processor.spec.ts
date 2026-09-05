import {
	ForbiddenException,
	ServiceUnavailableException
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
	AcceptanceLeaseLost,
	AcceptanceProcessor
} from './acceptance.processor';
import { acceptanceBinding, acceptanceEvent } from './acceptance.service';
import { acceptanceHash } from './acceptance.contract';

function setup() {
	const row = {
		id: randomUUID(),
		workspaceId: randomUUID(),
		entryId: randomUUID(),
		actorSubject: 'owner',
		status: 'RUNNING',
		version: 2,
		generation: 1,
		mode: 'EXECUTE',
		contactOperationId: randomUUID(),
		salesOperationId: randomUUID(),
		contactCommandId: randomUUID(),
		salesCommandId: randomUUID(),
		contactPayloadHash: 'a'.repeat(64),
		salesPayloadHash: 'b'.repeat(64),
		contactPayload: { mode: 'CREATE', name: 'Анна' },
		salesPayload: { title: 'Обращение' },
		recoverySubject: 'admin',
		recoveryContactCommandId: randomUUID(),
		recoverySalesCommandId: randomUUID()
	};
	const event = acceptanceEvent(row as never);
	const token = randomUUID();
	const contactId = randomUUID();
	const contact = {
		...acceptanceBinding(row as never, 'customers'),
		state: 'COMMITTED',
		result: { contactId, contactName: 'Анна', contactVersion: 1 },
		committedAt: new Date().toISOString()
	};
	const sales = {
		...acceptanceBinding(row as never, 'sales'),
		state: 'COMMITTED',
		result: { contactId, dealId: randomUUID(), firstTaskId: randomUUID() },
		committedAt: new Date().toISOString()
	};
	const absent = (target: string) => ({
		...(target === 'customers' ? contact : sales),
		state: 'ABSENT',
		result: null,
		committedAt: null
	});
	const tx = {
		$executeRaw: jest.fn(),
		$queryRaw: jest
			.fn()
			.mockResolvedValue([{ now: new Date('2030-01-01T00:00:00.000Z') }]),
		acceptance: {
			findFirst: jest.fn().mockResolvedValue(row),
			findUnique: jest.fn().mockResolvedValue(row),
			updateMany: jest.fn().mockResolvedValue({ count: 1 }),
			update: jest.fn()
		},
		acceptanceReceipt: {
			findFirst: jest.fn().mockResolvedValue({ leaseToken: token }),
			findUnique: jest.fn().mockResolvedValue(null),
			upsert: jest.fn(),
			updateMany: jest.fn().mockResolvedValue({ count: 1 })
		},
		acceptanceOutbox: { createMany: jest.fn() },
		inboxEntry: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
		intakeActivity: { create: jest.fn() }
	};
	const prisma = { ...tx, $transaction: jest.fn(fn => fn(tx)) };
	const authorization = {
		authorizeWorkflow: jest.fn().mockResolvedValue({ role: 'OWNER' })
	};
	const operations = {
		request: jest.fn(async (target: string, action: string) =>
			action === 'read'
				? absent(target)
				: target === 'customers'
					? contact
					: sales
		)
	};
	const processor = new AcceptanceProcessor(
		prisma as never,
		authorization as never,
		operations as never
	);
	return {
		row,
		event,
		token,
		contact,
		sales,
		absent,
		tx,
		prisma,
		authorization,
		operations,
		processor
	};
}

describe('Acceptance push consumer state machine', () => {
	it('claims PROCESSING before external work and prevents a duplicate call under an active lease', async () => {
		const c = setup();
		const claim = await c.processor.claim(c.event, 0);
		expect(claim.state).toBe('CLAIMED');
		expect(c.tx.acceptanceReceipt.upsert).toHaveBeenCalledWith(
			expect.objectContaining({
				create: expect.objectContaining({
					status: 'PROCESSING',
					leaseToken: expect.any(String)
				})
			})
		);
		expect(c.operations.request).not.toHaveBeenCalled();
		c.tx.acceptanceReceipt.findUnique.mockResolvedValue({
			payloadHash: acceptanceHash(c.event),
			workspaceId: c.row.workspaceId,
			workflowId: c.row.id,
			status: 'PROCESSING',
			leaseUntil: new Date(Date.now() + 60000),
			retryAttempt: 0
		});
		expect(await c.processor.claim(c.event, 0)).toEqual({ state: 'DONE' });
		expect(c.tx.acceptanceOutbox.createMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: [
					expect.objectContaining({
						route: 'MAIN',
						availableAt: expect.any(Date)
					})
				]
			})
		);
	});
	it('creates contact then deal and marks Inbox ACCEPTED only after both proofs', async () => {
		const c = setup();
		await c.processor.run(c.event, c.token);
		expect(
			c.operations.request.mock.calls.map(call => `${call[0]}:${call[1]}`)
		).toEqual([
			'sales:read',
			'customers:read',
			'customers:execute',
			'sales:execute'
		]);
		expect(c.authorization.authorizeWorkflow).toHaveBeenCalledTimes(2);
		expect(c.tx.inboxEntry.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: 'ACCEPTED',
					contactId: c.contact.result.contactId,
					dealId: c.sales.result.dealId
				})
			})
		);
		expect(c.tx.acceptanceReceipt.updateMany).toHaveBeenLastCalledWith(
			expect.objectContaining({
				data: { status: 'DELIVERED', leaseToken: null, leaseUntil: null }
			})
		);
	});
	it('finishes a previously committed Sales result after expiry without new writes or authority bypass for public reads', async () => {
		const c = setup();
		c.authorization.authorizeWorkflow.mockRejectedValue(
			new ForbiddenException()
		);
		c.operations.request.mockImplementation(async target =>
			target === 'customers' ? c.contact : c.sales
		);
		await c.processor.run(c.event, c.token);
		expect(c.authorization.authorizeWorkflow).not.toHaveBeenCalled();
		expect(
			c.operations.request.mock.calls.every(call => call[1] === 'read')
		).toBe(true);
		expect(c.tx.inboxEntry.updateMany).toHaveBeenCalled();
	});
	it('blocks new Sales writes when authority expires after the contact commit and preserves the contact proof', async () => {
		const c = setup();
		c.authorization.authorizeWorkflow
			.mockResolvedValueOnce({ role: 'OWNER' })
			.mockRejectedValueOnce(new ForbiddenException());
		await expect(c.processor.run(c.event, c.token)).rejects.toMatchObject({
			status: 403
		});
		expect(
			c.operations.request.mock.calls.some(
				call => call[0] === 'sales' && call[1] === 'execute'
			)
		).toBe(false);
		expect(c.tx.inboxEntry.updateMany).not.toHaveBeenCalled();
		expect(c.tx.acceptance.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ contactProof: c.contact })
			})
		);
		await c.processor.fail(c.event, c.token, 0, new ForbiddenException());
		expect(c.tx.acceptance.updateMany).toHaveBeenLastCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: 'BLOCKED',
					lastErrorCode: 'WORKFLOW_ACCESS_BLOCKED'
				})
			})
		);
	});
	it('recovers by closing Sales first, retains a partial contact and never deletes business entities', async () => {
		const c = setup();
		c.row.mode = 'RECOVER';
		c.row.status = 'RECOVERING';
		c.event.mode = 'RECOVER';
		c.operations.request.mockImplementation(async (target, action) =>
			action === 'read'
				? c.absent(target)
				: target === 'sales'
					? { ...c.absent(target), state: 'CANCELLED' }
					: c.contact
		);
		await c.processor.run(c.event, c.token);
		expect(
			c.operations.request.mock.calls.map(call => `${call[0]}:${call[1]}`)
		).toEqual(['sales:read', 'sales:close', 'customers:close']);
		expect(c.tx.acceptance.update).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: 'CANCELLED',
					contactId: c.contact.result.contactId
				})
			})
		);
		expect(c.tx.inboxEntry.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({ data: { version: { increment: 1 } } })
		);
	});
	it('will not complete mismatching contact/deal proofs', async () => {
		const c = setup();
		c.sales.result.contactId = randomUUID();
		await expect(c.processor.run(c.event, c.token)).rejects.toMatchObject({
			status: 409
		});
		expect(c.tx.inboxEntry.updateMany).not.toHaveBeenCalled();
	});
	it('refuses stale lease work and stores bounded retries atomically before a successful ack is possible', async () => {
		const c = setup();
		c.tx.acceptanceReceipt.findFirst.mockResolvedValue(null);
		await expect(c.processor.run(c.event, c.token)).rejects.toBeInstanceOf(
			AcceptanceLeaseLost
		);
		expect(c.operations.request).not.toHaveBeenCalled();
		expect(
			await c.processor.fail(
				c.event,
				c.token,
				0,
				new ServiceUnavailableException()
			)
		).toBe(true);
		expect(c.tx.acceptanceOutbox.createMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: [
					expect.objectContaining({
						route: 'MAIN',
						retryAttempt: 1,
						availableAt: new Date('2030-01-01T00:00:30.000Z')
					})
				]
			})
		);
		c.tx.acceptanceReceipt.updateMany.mockResolvedValue({ count: 0 });
		expect(await c.processor.fail(c.event, c.token, 0, new Error())).toBe(
			false
		);
	});
	it('rejects binding reuse without exposing payload and discards superseded generations without HTTP', async () => {
		const c = setup();
		c.tx.acceptanceReceipt.findUnique.mockResolvedValue({
			payloadHash: 'f'.repeat(64)
		});
		await expect(c.processor.claim(c.event, 0)).rejects.toMatchObject({
			status: 409
		});
		c.tx.acceptanceReceipt.findUnique.mockResolvedValue(null);
		c.row.generation++;
		expect(await c.processor.claim(c.event, 0)).toEqual({ state: 'DONE' });
		expect(c.operations.request).not.toHaveBeenCalled();
	});
});
