import {
	ConflictException,
	ForbiddenException,
	NotFoundException,
	ServiceUnavailableException
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { CrmBillingOperation } from '@prisma/crm-access-client';
import {
	CrmBillingCapacityService,
	effectiveAdmissionCeiling
} from './billing-capacity.service';
import { commerceHash } from './billing.validation';
import type {
	WincrmCheckoutCommand,
	WincrmCommerceCommandProof
} from './billing.contract';

const workspaceId = randomUUID();
const actorSubject = 'billing-owner';
const checkout = (): Omit<WincrmCheckoutCommand, 'capacityFence'> => ({
	schemaVersion: 1,
	workspaceId,
	actorSubject,
	commandId: randomUUID(),
	expectedBillingVersion: '0',
	expectedPolicyVersion: 1,
	cycle: 'MONTHLY',
	totalSeats: 5,
	autoRenew: false,
	consentVersion: null
});
function fixture() {
	const operations = new Map<string, CrmBillingOperation>();
	const receipts = new Map<string, unknown>();
	const state = {
		capacity: null as null | {
			workspaceId: string;
			revision: number;
			admissionCeiling: number | null;
			pendingOperationId: string | null;
			pendingTargetSeats: number | null;
			latestCommittedOperationId: string | null;
		},
		members: 1
	};
	const tx = {
		$executeRaw: jest.fn().mockResolvedValue(1),
		$executeRawUnsafe: jest.fn().mockResolvedValue(1),
		crmWorkspaceMember: { count: jest.fn(async () => state.members) },
		crmBillingCapacity: {
			upsert: jest.fn(
				async () =>
					state.capacity ??
					(state.capacity = {
						workspaceId,
						revision: 0,
						admissionCeiling: null,
						pendingOperationId: null,
						pendingTargetSeats: null,
						latestCommittedOperationId: null
					})
			),
			findUnique: jest.fn(async () => state.capacity),
			findUniqueOrThrow: jest.fn(async () => state.capacity),
			update: jest.fn(async ({ data }) =>
				Object.assign(state.capacity!, data)
			)
		},
		crmTeamCommandReceipt: {
			findUnique: jest.fn(
				async ({ where }) => receipts.get(where.commandId) ?? null
			),
			create: jest.fn(async ({ data }) => {
				receipts.set(data.commandId, data);
				return data;
			})
		},
		crmTeamAudit: { create: jest.fn().mockResolvedValue({}) },
		crmTeamOutbox: { create: jest.fn().mockResolvedValue({}) },
		crmBillingOperation: {
			findUnique: jest.fn(
				async ({ where }) => operations.get(where.commandId) ?? null
			),
			findFirst: jest.fn(async ({ where }) => {
				const op = operations.get(where.commandId);
				return op?.workspaceId === where.workspaceId ? op : null;
			}),
			findUniqueOrThrow: jest.fn(async ({ where }) => {
				const op = operations.get(where.commandId);
				if (!op) throw Error('MISSING');
				return op;
			}),
			create: jest.fn(async ({ data }) => {
				const op = {
					request: null,
					requestHash: null,
					targetSeats: null,
					fenceRevision: null,
					state: 'PENDING',
					releaseFence: false,
					billingVersion: null,
					holdUntil: null,
					proof: null,
					nextCheckAt: new Date(),
					createdAt: new Date(),
					updatedAt: new Date(),
					...data
				};
				operations.set(op.commandId, op);
				return op;
			}),
			update: jest.fn(async ({ where, data }) => {
				const updated = { ...operations.get(where.commandId), ...data };
				operations.set(where.commandId, updated as CrmBillingOperation);
				return updated;
			})
		}
	};
	const prisma = {
		...tx,
		$transaction: jest.fn(async action => action(tx))
	};
	const billing = { enabled: true, request: jest.fn() };
	const identity = {
		authContext: jest.fn().mockResolvedValue({
			subject: actorSubject,
			memberships: [{ workspaceId, role: 'OWNER' }]
		}),
		widgetSourceContext: jest.fn().mockResolvedValue({
			ownerSubject: actorSubject,
			membership: { role: 'OWNER' }
		})
	};
	const service = new CrmBillingCapacityService(
		prisma as never,
		billing as never,
		identity as never
	);
	const proof = (
		op: CrmBillingOperation,
		patch: Partial<WincrmCommerceCommandProof> = {}
	): WincrmCommerceCommandProof => ({
		schemaVersion: 1,
		workspaceId,
		commandId: op.commandId,
		requestHash: op.requestHash!,
		status: 'PENDING',
		billingVersion: '1',
		releaseFence: false,
		holdUntil: null,
		order: null,
		period: null,
		...patch
	});
	return {
		service,
		prisma,
		tx,
		billing,
		identity,
		operations,
		receipts,
		state,
		proof
	};
}
describe('CRM Billing durable capacity fence', () => {
	it.each([
		[10, null, 10],
		[10, { admissionCeiling: 3, pendingTargetSeats: null }, 3],
		[10, { admissionCeiling: 8, pendingTargetSeats: 4 }, 4],
		[3, { admissionCeiling: 8, pendingTargetSeats: 10 }, 3]
	])(
		'never exceeds either fresh or durable ceiling',
		(remote, capacity, expected) => {
			expect(
				effectiveAdmissionCeiling(remote as number, capacity as never)
			).toBe(expected);
		}
	);
	it('reserves before HTTP, uses the admission lock namespace, and replays exact binding', async () => {
		const f = fixture(),
			command = checkout();
		const first = await f.service.prepare('WINCRM_CHECKOUT', command);
		const second = await f.service.prepare('WINCRM_CHECKOUT', command);
		expect(second).toEqual(first);
		expect(f.tx.crmBillingOperation.create).toHaveBeenCalledTimes(1);
		expect(f.billing.request).not.toHaveBeenCalled();
		expect(f.tx.$executeRaw.mock.calls.flat()).toContain(
			`wincrm-team:${workspaceId}`
		);
		expect(f.state.capacity).toMatchObject({
			pendingOperationId: command.commandId,
			pendingTargetSeats: 5,
			revision: 1
		});
	});
	it('rejects lower than owner plus active roster and serializes competing operations', async () => {
		const f = fixture();
		f.state.members = 5;
		await expect(
			f.service.prepare('WINCRM_CHECKOUT', checkout())
		).rejects.toBeInstanceOf(ConflictException);
		expect(f.tx.crmBillingOperation.create).not.toHaveBeenCalled();
		f.state.members = 1;
		await f.service.prepare('WINCRM_CHECKOUT', checkout());
		await expect(
			f.service.prepare('WINCRM_CHECKOUT', checkout())
		).rejects.toBeInstanceOf(ConflictException);
	});
	it('preserves the global Access command namespace across team and commerce', async () => {
		const f = fixture(),
			command = checkout();
		f.receipts.set(command.commandId, { team: true });
		await expect(
			f.service.prepare('WINCRM_CHECKOUT', command)
		).rejects.toBeInstanceOf(ConflictException);
		expect(f.billing.request).not.toHaveBeenCalled();
	});
	it.each(['actor', 'workspace', 'body'])(
		'rejects altered replay %s',
		async field => {
			const f = fixture(),
				command = checkout();
			await f.service.prepare('WINCRM_CHECKOUT', command);
			const changed = {
				...command,
				...(field === 'actor'
					? { actorSubject: 'other' }
					: field === 'workspace'
						? { workspaceId: randomUUID() }
						: { totalSeats: 6 })
			};
			await expect(
				f.service.prepare('WINCRM_CHECKOUT', changed)
			).rejects.toBeInstanceOf(ConflictException);
		}
	);
	it('retains the pending ceiling on dependency failure, 404, and owner revocation', async () => {
		const f = fixture(),
			op = await f.service.prepare('WINCRM_CHECKOUT', checkout());
		for (const error of [
			new ServiceUnavailableException(),
			new NotFoundException()
		]) {
			f.billing.request.mockRejectedValueOnce(error);
			await expect(f.service.synchronize(op)).rejects.toBe(error);
			expect(f.state.capacity?.pendingOperationId).toBe(op.commandId);
		}
		f.identity.widgetSourceContext.mockResolvedValue({
			ownerSubject: 'other',
			membership: { role: 'OWNER' }
		});
		await expect(f.service.execute(op)).rejects.toBeInstanceOf(
			ForbiddenException
		);
		expect(f.operations.get(op.commandId)?.state).toBe('PENDING');
	});
	it('unknown recovery creates a tombstone before any late original request', async () => {
		const f = fixture(),
			command = checkout();
		expect(
			await f.service.recover(workspaceId, command.commandId, actorSubject)
		).toEqual({
			schemaVersion: 1,
			workspaceId,
			commandId: command.commandId,
			state: 'NOT_STARTED',
			requestHash: null,
			billing: null
		});
		await expect(
			f.service.prepare('WINCRM_CHECKOUT', command)
		).rejects.toBeInstanceOf(ConflictException);
		expect(f.billing.request).not.toHaveBeenCalled();
	});
	it('404 known recovery obtains a CLOSED tombstone instead of treating absence as cancellation', async () => {
		const f = fixture(),
			op = await f.service.prepare('WINCRM_CHECKOUT', checkout());
		f.billing.request
			.mockRejectedValueOnce(new NotFoundException())
			.mockResolvedValueOnce(
				f.proof(op, { status: 'CANCELLED', releaseFence: true })
			);
		expect(
			(await f.service.recover(workspaceId, op.commandId, actorSubject))
				.state
		).toBe('CANCELLED');
		expect(f.billing.request.mock.calls.map(call => call[0])).toEqual([
			'operations/get',
			'operations/close'
		]);
		expect(f.state.capacity?.pendingOperationId).toBeNull();
	});
	it('scheduled success holds the fence; release keeps a permanent committed ceiling', async () => {
		const f = fixture(),
			op = await f.service.prepare('WINCRM_CHECKOUT', checkout());
		const period = { totalSeats: 5 } as NonNullable<
			WincrmCommerceCommandProof['period']
		>;
		const scheduled = await f.service.applyProof(
			op,
			f.proof(op, {
				status: 'COMMITTED',
				period,
				holdUntil: '2026-09-10T00:00:00.000Z'
			})
		);
		expect(f.state.capacity?.pendingOperationId).toBe(op.commandId);
		expect(f.state.capacity?.admissionCeiling).toBeNull();
		await f.service.applyProof(
			scheduled,
			f.proof(op, { status: 'COMMITTED', period, releaseFence: true })
		);
		expect(f.state.capacity).toMatchObject({
			admissionCeiling: 5,
			pendingOperationId: null,
			latestCommittedOperationId: op.commandId
		});
		expect(effectiveAdmissionCeiling(10, f.state.capacity)).toBe(5);
		expect(f.tx.crmTeamOutbox.create).toHaveBeenCalledTimes(1);
	});
	it('does not apply proof from another operation or without committed period evidence', async () => {
		const f = fixture(),
			op = await f.service.prepare('WINCRM_CHECKOUT', checkout());
		await expect(
			f.service.applyProof(op, f.proof(op, { commandId: randomUUID() }))
		).rejects.toBeInstanceOf(ServiceUnavailableException);
		await expect(
			f.service.applyProof(
				op,
				f.proof(op, { status: 'COMMITTED', releaseFence: true })
			)
		).rejects.toBeInstanceOf(ServiceUnavailableException);
		expect(f.tx.crmBillingOperation.update).not.toHaveBeenCalled();
	});
	it('authorizes a fresh original owner despite READ_ONLY and revokes superseded bindings', async () => {
		const f = fixture(),
			op = await f.service.prepare('WINCRM_CHECKOUT', checkout());
		const request = {
			workspaceId,
			actorSubject,
			commandId: op.commandId,
			requestHash: op.requestHash!,
			fenceRevision: op.fenceRevision!,
			targetSeats: 5
		};
		expect(await f.service.authorizeOperation(request)).toMatchObject({
			authorized: true,
			capacityFence: f.service.fence(op)
		});
		await expect(
			f.service.authorizeOperation({ ...request, targetSeats: 6 })
		).rejects.toMatchObject({
			response: { code: 'OPERATION_AUTHORIZATION_REVOKED' }
		});
		await f.service.applyProof(
			op,
			f.proof(op, {
				status: 'COMMITTED',
				releaseFence: true,
				period: { totalSeats: 5 } as never
			})
		);
		expect(await f.service.authorizeOperation(request)).toMatchObject({
			authorized: true
		});
		await f.service.prepare('WINCRM_CHECKOUT', checkout());
		await expect(
			f.service.authorizeOperation(request)
		).rejects.toBeInstanceOf(ServiceUnavailableException);
	});
	it('resolves financial ownership from current Identity, not CRM role or request owner', async () => {
		const f = fixture();
		expect(await f.service.owner(workspaceId, 'Bearer opaque')).toBe(
			actorSubject
		);
		f.identity.authContext.mockResolvedValue({
			subject: actorSubject,
			memberships: [{ workspaceId, role: 'MEMBER' }]
		});
		await expect(
			f.service.owner(workspaceId, 'Bearer opaque')
		).rejects.toBeInstanceOf(ForbiddenException);
	});
	it('uses canonical sorted-key command hash including original actor', () => {
		const command = checkout();
		const hash = commerceHash('WINCRM_CHECKOUT', command);
		expect(
			commerceHash(
				'WINCRM_CHECKOUT',
				Object.fromEntries(Object.entries(command).reverse()) as never
			)
		).toBe(hash);
		expect(
			commerceHash('WINCRM_CHECKOUT', {
				...command,
				actorSubject: 'other'
			})
		).not.toBe(hash);
	});
});
