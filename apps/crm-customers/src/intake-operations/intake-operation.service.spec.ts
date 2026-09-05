import { ForbiddenException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ContactIntakeOperationGuard } from './intake-operation.controller';
import { operationHash } from './intake-operation.dto';
import { ContactIntakeOperationService } from './intake-operation.service';

function setup() {
	const payload = {
		mode: 'CREATE' as const,
		name: 'Анна',
		phone: '+79000000001',
		email: 'ANNA@EXAMPLE.TEST',
		teamId: null
	};
	const dto = {
		schemaVersion: 1 as const,
		workspaceId: randomUUID(),
		workflowId: randomUUID(),
		operationId: randomUUID(),
		actorSubject: 'actor',
		payloadHash: operationHash(payload),
		commandId: randomUUID(),
		payload
	};
	const contact = { id: randomUUID(), name: 'Анна', version: 1 };
	const access = {
		workspaceId: dto.workspaceId,
		subject: 'actor',
		role: 'OWNER',
		state: 'ACTIVE',
		dataScope: 'ALL',
		teamIds: []
	};
	const authorization = {
		authorizeWorkflow: jest.fn().mockResolvedValue(access)
	};
	const tx = {
		$executeRaw: jest.fn(),
		contact: {
			create: jest.fn().mockResolvedValue(contact),
			findFirst: jest.fn().mockResolvedValue(contact)
		},
		customerActivity: { create: jest.fn() },
		intakeOperationSlot: {
			findUnique: jest.fn().mockResolvedValue(null),
			create: jest.fn().mockImplementation(({ data }) =>
				Promise.resolve({
					...data,
					result: data.state === 'CANCELLED' ? null : data.result,
					committedAt: data.committedAt ?? null
				})
			)
		},
		intakeOperationCommand: {
			findUnique: jest.fn().mockResolvedValue(null),
			create: jest.fn()
		}
	};
	const prisma = {
		...tx,
		$transaction: jest.fn(callback => callback(tx))
	};
	const service = new ContactIntakeOperationService(
		prisma as never,
		authorization as never
	);
	return { dto, contact, access, tx, prisma, authorization, service };
}
describe('Customers Intake operation slots', () => {
	it('atomically stores contact, bounded name proof, activity and actor-bound command', async () => {
		const c = setup();
		const proof = await c.service.execute(c.dto);
		expect(proof).toMatchObject({
			state: 'COMMITTED',
			result: {
				contactId: c.contact.id,
				contactName: c.contact.name,
				contactVersion: 1
			}
		});
		expect(c.tx.customerActivity.create).toHaveBeenCalledTimes(1);
		expect(c.tx.intakeOperationCommand.create).toHaveBeenCalledTimes(1);
		expect(c.prisma.$transaction).toHaveBeenCalledWith(
			expect.any(Function),
			{ isolationLevel: 'Serializable' }
		);
		expect(JSON.stringify(proof)).not.toContain(c.dto.payload.email);
		expect(JSON.stringify(proof)).not.toContain(c.dto.payload.phone);
	});
	it('never writes after an operation tombstone, including a delayed execute', async () => {
		const c = setup();
		const binding = {
			schemaVersion: c.dto.schemaVersion,
			workspaceId: c.dto.workspaceId,
			workflowId: c.dto.workflowId,
			operationId: c.dto.operationId,
			actorSubject: c.dto.actorSubject,
			payloadHash: c.dto.payloadHash
		};
		const closed = await c.service.close({
			...binding,
			commandId: randomUUID(),
			recoverySubject: 'owner'
		});
		c.tx.intakeOperationSlot.findUnique.mockResolvedValue({
			...binding,
			state: 'CANCELLED',
			result: null,
			committedAt: null
		});
		expect(await c.service.execute(c.dto)).toEqual(closed);
		expect(c.tx.contact.create).not.toHaveBeenCalled();
	});
	it('returns only exact proof after expiry and does not use proof read to create or freshly verify a contact', async () => {
		const c = setup();
		const proof = await c.service.execute(c.dto);
		const stored = c.tx.intakeOperationSlot.create.mock.calls[0][0].data;
		c.tx.intakeOperationSlot.findUnique.mockResolvedValue(stored);
		c.authorization.authorizeWorkflow.mockRejectedValue(
			new ForbiddenException()
		);
		expect(await c.service.read(c.dto)).toEqual(proof);
		await expect(c.service.verify(c.dto)).rejects.toMatchObject({
			status: 403
		});
		for (const change of [
			{ workspaceId: randomUUID() },
			{ workflowId: randomUUID() },
			{ actorSubject: 'another' },
			{ payloadHash: 'a'.repeat(64) }
		])
			await expect(
				c.service.read({ ...c.dto, ...change })
			).rejects.toMatchObject({ status: 409 });
		expect(c.tx.contact.create).toHaveBeenCalledTimes(1);
	});
	it('verifies the current contact scope and archive state for a new Sales write', async () => {
		const c = setup();
		await c.service.execute(c.dto);
		c.tx.intakeOperationSlot.findUnique.mockResolvedValue(
			c.tx.intakeOperationSlot.create.mock.calls[0][0].data
		);
		c.tx.contact.findFirst.mockResolvedValue(null);
		await expect(c.service.verify(c.dto)).rejects.toMatchObject({
			status: 404
		});
		expect(c.tx.contact.findFirst).toHaveBeenCalledWith({
			where: {
				AND: [
					{ workspaceId: c.dto.workspaceId, archivedAt: null },
					{ id: c.contact.id }
				]
			}
		});
	});
	it('rejects payload tampering before authorization and prevents a manager from closing slots', async () => {
		const c = setup();
		await expect(
			c.service.execute({
				...c.dto,
				payload: { ...c.dto.payload, name: 'changed' }
			})
		).rejects.toMatchObject({ status: 400 });
		expect(c.authorization.authorizeWorkflow).not.toHaveBeenCalled();
		c.authorization.authorizeWorkflow.mockResolvedValue({
			...c.access,
			role: 'MANAGER'
		});
		await expect(
			c.service.close({ ...c.dto, recoverySubject: 'actor' })
		).rejects.toMatchObject({ status: 403 });
	});
	it('binds command receipts to actor, workspace and operation payload', async () => {
		const c = setup();
		c.tx.intakeOperationCommand.findUnique.mockResolvedValue({
			actorSubject: 'other',
			workspaceId: c.dto.workspaceId,
			requestHash: 'bad'
		});
		await expect(c.service.execute(c.dto)).rejects.toMatchObject({
			status: 409
		});
		expect(c.tx.contact.create).not.toHaveBeenCalled();
	});
	it('limits proof verification to Sales and mutation to Intake even with valid scoped secrets', () => {
		const prior = { ...process.env };
		process.env.CRM_CUSTOMERS_CRM_INTAKE_TOKEN =
			'test-intake-pairwise-credential-minimum-32';
		process.env.CRM_CUSTOMERS_CRM_SALES_TOKEN =
			'test-sales-pairwise-credential-minimum-32';
		const guard = new ContactIntakeOperationGuard();
		const ctx = (caller: string, action: string, peer = '127.0.0.1') => ({
			getHandler: () => ({ name: action }),
			switchToHttp: () => ({
				getRequest: () => ({
					socket: { remoteAddress: peer },
					header: (name: string) =>
						name === 'x-winwidget-service'
							? caller
							: process.env[
									caller === 'crm-intake'
										? 'CRM_CUSTOMERS_CRM_INTAKE_TOKEN'
										: 'CRM_CUSTOMERS_CRM_SALES_TOKEN'
								]
				})
			})
		});
		try {
			expect(guard.canActivate(ctx('crm-sales', 'read') as never)).toBe(
				true
			);
			expect(guard.canActivate(ctx('crm-sales', 'verify') as never)).toBe(
				true
			);
			for (const [caller, action, peer] of [
				['crm-sales', 'execute', '127.0.0.1'],
				['crm-intake', 'verify', '127.0.0.1'],
				['crm-intake', 'read', '10.0.0.1']
			])
				expect(() =>
					guard.canActivate(ctx(caller, action, peer) as never)
				).toThrow();
		} finally {
			process.env = prior;
		}
	});
});
