import {
	BadRequestException,
	ForbiddenException,
	NotFoundException,
	ValidationPipe
} from '@nestjs/common';
import type { SalesAccess } from './sales-access';
import { CreateDealDto } from './sales.dto';
import { salesScope, SalesService } from './sales.service';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const dealId = '22222222-2222-4222-8222-222222222222';
const stageId = '33333333-3333-4333-8333-333333333333';
const pipelineId = '44444444-4444-4444-8444-444444444444';
const contactId = '55555555-5555-4555-8555-555555555555';
const taskId = '66666666-6666-4666-8666-666666666666';
const commandId = '77777777-7777-4777-8777-777777777777';
const access: SalesAccess = {
	schemaVersion: 1,
	workspaceId,
	subject: 'owner-1',
	role: 'OWNER',
	state: 'ACTIVE',
	dataScope: 'ALL',
	teamIds: [],
	permissions: ['sales:read', 'sales:write', 'sales:analytics']
};
const nextTask = { title: 'Позвонить', dueAt: '2026-10-01T09:00:00.000Z' };
const create = {
	schemaVersion: 1 as const,
	commandId,
	workspaceId,
	title: 'Сделка',
	currency: 'RUB' as const,
	amountMinor: 10000,
	pipelineId,
	stageId,
	contactId,
	nextTask
};
const now = new Date('2026-09-05T10:00:00.000Z');
const deal = {
	id: dealId,
	workspaceId,
	version: 1,
	title: 'Сделка',
	currency: 'RUB',
	amountMinor: 10000,
	pipelineId,
	stageId,
	status: 'OPEN',
	contactId,
	contactName: 'Клиент',
	assignedToSubject: 'owner-1',
	teamId: null,
	nextTaskId: taskId,
	archivedAt: null,
	createdAt: now,
	updatedAt: now,
	tasks: []
};

function harness() {
	const transaction = {
		$executeRaw: jest.fn().mockResolvedValue(1),
		salesCommandReceipt: {
			findUnique: jest.fn().mockResolvedValue(null),
			create: jest.fn().mockResolvedValue({})
		},
		pipelineStage: {
			findFirst: jest.fn().mockResolvedValue({
				id: stageId,
				workspaceId,
				pipelineId,
				state: 'OPEN'
			})
		},
		deal: {
			findFirst: jest.fn().mockResolvedValue(deal),
			create: jest.fn().mockResolvedValue(deal),
			updateMany: jest.fn().mockResolvedValue({ count: 1 })
		},
		salesTask: {
			create: jest.fn().mockResolvedValue({}),
			updateMany: jest.fn().mockResolvedValue({ count: 1 }),
			findFirst: jest.fn().mockResolvedValue({
				id: taskId,
				workspaceId,
				dealId,
				version: 1,
				status: 'OPEN'
			})
		},
		dealTimeline: { create: jest.fn().mockResolvedValue({}) }
	};
	const prisma = {
		...transaction,
		$transaction: jest.fn(async callback => callback(transaction))
	};
	const contacts = {
		requireContact: jest
			.fn()
			.mockResolvedValue({ id: contactId, name: 'Клиент' })
	};
	return {
		transaction,
		prisma,
		contacts,
		service: new SalesService(prisma as never, contacts as never)
	};
}

describe('SalesService security and workflow', () => {
	it('applies tenant isolation to ALL, OWN and TEAM queries', () => {
		expect(salesScope(access)).toEqual({ workspaceId });
		expect(salesScope({ ...access, dataScope: 'OWN' })).toEqual({
			workspaceId,
			assignedToSubject: 'owner-1'
		});
		expect(
			salesScope({ ...access, dataScope: 'TEAM', teamIds: [stageId] })
		).toEqual({
			workspaceId,
			OR: [{ assignedToSubject: 'owner-1' }, { teamId: { in: [stageId] } }]
		});
	});

	it.each([
		{ ...access, role: 'ANALYST' as const },
		{ ...access, state: 'READ_ONLY' as const },
		{ ...access, permissions: [] }
	])(
		'denies writes before any transaction or contact lookup',
		async denied => {
			const { service, prisma, contacts } = harness();
			await expect(
				service.create(denied, create, 'Bearer token')
			).rejects.toBeInstanceOf(ForbiddenException);
			expect(prisma.$transaction).not.toHaveBeenCalled();
			expect(contacts.requireContact).not.toHaveBeenCalled();
		}
	);

	it('does not let ANALYST retrieve contact-name-bearing deal details', async () => {
		const { service, transaction } = harness();
		await expect(
			service.detail({ ...access, role: 'ANALYST' }, dealId)
		).rejects.toBeInstanceOf(ForbiddenException);
		expect(transaction.deal.findFirst).not.toHaveBeenCalled();
	});

	it('rejects a cross-workspace command and unverifiable team before writes', async () => {
		const { service, transaction } = harness();
		await expect(
			service.create(
				access,
				{ ...create, workspaceId: stageId },
				'Bearer token'
			)
		).rejects.toBeInstanceOf(ForbiddenException);
		await expect(
			service.create(
				access,
				{ ...create, teamId: stageId },
				'Bearer token'
			)
		).rejects.toBeInstanceOf(ForbiddenException);
		expect(transaction.deal.create).not.toHaveBeenCalled();
	});

	it('validates contact visibility through Customers and never creates a deal when it fails', async () => {
		const { service, transaction, contacts } = harness();
		contacts.requireContact.mockRejectedValueOnce(new NotFoundException());
		await expect(
			service.create(access, create, 'Bearer token')
		).rejects.toBeInstanceOf(NotFoundException);
		expect(contacts.requireContact).toHaveBeenCalledWith(
			'Bearer token',
			workspaceId,
			contactId
		);
		expect(transaction.deal.create).not.toHaveBeenCalled();
		expect(transaction.salesCommandReceipt.create).not.toHaveBeenCalled();
	});

	it('creates the deal, next action, timeline and command receipt transactionally', async () => {
		const { service, transaction, prisma } = harness();
		await service.create(access, create, 'Bearer token');
		expect(prisma.$transaction).toHaveBeenCalledTimes(1);
		expect(transaction.deal.create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				workspaceId,
				contactId,
				contactName: 'Клиент',
				assignedToSubject: 'owner-1',
				nextTaskId: expect.any(String)
			})
		});
		expect(transaction.salesTask.create).toHaveBeenCalledTimes(1);
		expect(transaction.dealTimeline.create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				kind: 'CREATED',
				actorSubject: 'owner-1'
			})
		});
		expect(transaction.salesCommandReceipt.create).toHaveBeenCalledTimes(
			1
		);
	});

	it('rejects foreign pipeline/stage lookup before contact call', async () => {
		const { service, transaction, contacts } = harness();
		transaction.pipelineStage.findFirst.mockResolvedValueOnce(null);
		await expect(
			service.create(access, create, 'Bearer token')
		).rejects.toBeInstanceOf(NotFoundException);
		expect(transaction.pipelineStage.findFirst).toHaveBeenCalledWith({
			where: { id: stageId, workspaceId, pipelineId }
		});
		expect(contacts.requireContact).not.toHaveBeenCalled();
	});

	it('requires the next action for an OPEN transition and rejects one for a closed stage', async () => {
		const { service, transaction } = harness();
		await expect(
			service.transition(access, dealId, {
				schemaVersion: 1,
				commandId,
				workspaceId,
				expectedVersion: 1,
				targetStageId: stageId,
				outcome: 'Выполнено'
			})
		).rejects.toBeInstanceOf(BadRequestException);
		transaction.pipelineStage.findFirst.mockResolvedValueOnce({
			id: stageId,
			workspaceId,
			pipelineId,
			state: 'WON'
		});
		await expect(
			service.transition(access, dealId, {
				schemaVersion: 1,
				commandId,
				workspaceId,
				expectedVersion: 1,
				targetStageId: stageId,
				outcome: 'Выполнено',
				nextTask
			})
		).rejects.toBeInstanceOf(BadRequestException);
		expect(transaction.deal.updateMany).not.toHaveBeenCalled();
	});

	it('does not replace an action after a stale deal version', async () => {
		const { service, transaction } = harness();
		transaction.deal.updateMany.mockResolvedValueOnce({ count: 0 });
		await expect(
			service.transition(access, dealId, {
				schemaVersion: 1,
				commandId,
				workspaceId,
				expectedVersion: 2,
				targetStageId: stageId,
				outcome: 'Выполнено',
				nextTask
			})
		).rejects.toMatchObject({ status: 409 });
		expect(transaction.salesTask.updateMany).not.toHaveBeenCalled();
		expect(transaction.dealTimeline.create).not.toHaveBeenCalled();
	});

	it('rechecks row visibility on a matching command replay, without repeating contact lookup', async () => {
		const { service, transaction, contacts } = harness();
		await service.create(access, create, 'Bearer token');
		const receipt =
			transaction.salesCommandReceipt.create.mock.calls[0][0].data;
		transaction.salesCommandReceipt.findUnique.mockResolvedValueOnce(
			receipt
		);
		transaction.deal.findFirst.mockResolvedValueOnce(null);
		await expect(
			service.create(access, create, 'Bearer token')
		).rejects.toBeInstanceOf(NotFoundException);
		expect(contacts.requireContact).toHaveBeenCalledTimes(1);
		expect(transaction.salesCommandReceipt.create).toHaveBeenCalledTimes(
			1
		);
	});

	it('binds replay to actor and payload even with the same command ID', async () => {
		const { service, transaction } = harness();
		await service.create(access, create, 'Bearer token');
		const receipt =
			transaction.salesCommandReceipt.create.mock.calls[0][0].data;
		transaction.salesCommandReceipt.findUnique.mockResolvedValue(receipt);
		await expect(
			service.create(
				{ ...access, subject: 'another-owner' },
				create,
				'Bearer token'
			)
		).rejects.toMatchObject({ status: 409 });
		await expect(
			service.create(
				access,
				{ ...create, title: 'Другой запрос' },
				'Bearer token'
			)
		).rejects.toMatchObject({ status: 409 });
	});

	it('checks the task version and active pointer before completing an action', async () => {
		const { service, transaction } = harness();
		await expect(
			service.complete(access, taskId, {
				schemaVersion: 1,
				commandId,
				workspaceId,
				expectedVersion: 2,
				outcome: 'Связались',
				nextTask
			})
		).rejects.toMatchObject({ status: 409 });
		expect(transaction.deal.updateMany).not.toHaveBeenCalled();
	});

	it.each([undefined, { ...nextTask, dueAt: '2026-02-31T09:00:00.000Z' }])(
		'rejects missing or noncanonical next actions',
		async next => {
			const { service } = harness();
			await expect(
				service.create(
					access,
					{ ...create, nextTask: next } as never,
					'Bearer token'
				)
			).rejects.toBeInstanceOf(BadRequestException);
		}
	);

	it('DTO rejects missing next action, extra assignee and fractional money', async () => {
		const pipe = new ValidationPipe({
			whitelist: true,
			forbidNonWhitelisted: true,
			transform: true
		});
		for (const payload of [
			{ ...create, nextTask: undefined },
			{ ...create, assignedToSubject: 'other' },
			{ ...create, amountMinor: 1.5 }
		])
			await expect(
				pipe.transform(payload, { type: 'body', metatype: CreateDealDto })
			).rejects.toBeDefined();
	});
});
