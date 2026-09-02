import { CrmEntitlementStatus } from '@prisma/billing-client';
import { billingCommandRequestHash } from './billing-command-idempotency';
import { CrmEntitlementService } from './crm-entitlement.service';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const COMMAND_ID = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-09-02T10:00:00.000Z');

const entitlement = (overrides: Record<string, unknown> = {}) => ({
	id: '33333333-3333-4333-8333-333333333333',
	workspaceId: WORKSPACE_ID,
	productCode: 'WINCRM',
	planCode: 'TRIAL',
	status: CrmEntitlementStatus.ACTIVE,
	seatLimit: null,
	trialStartedAt: NOW,
	effectiveFrom: NOW,
	effectiveUntil: new Date('2026-09-07T10:00:00.000Z'),
	activatedByUserId: 'user-1',
	aggregateVersion: 1n,
	sourceSequence: 1n,
	createdAt: NOW,
	updatedAt: NOW,
	...overrides
});

const command = () => ({
	schemaVersion: 1,
	commandId: COMMAND_ID,
	workspaceId: WORKSPACE_ID,
	activatedByUserId: 'user-1'
});

describe('CrmEntitlementService', () => {
	afterEach(() => {
		jest.useRealTimers();
	});

	it('returns NOT_ACTIVATED without inventing a trial', async () => {
		const prisma = {
			crmEntitlement: { findUnique: jest.fn().mockResolvedValue(null) }
		};
		const service = new CrmEntitlementService(prisma as never);

		await expect(service.get(WORKSPACE_ID)).resolves.toEqual({
			schemaVersion: 1,
			productCode: 'WINCRM',
			status: 'NOT_ACTIVATED',
			entitlement: null
		});
	});

	it('derives expiry from the effective window even before a scheduler runs', async () => {
		jest
			.useFakeTimers()
			.setSystemTime(new Date('2026-09-08T10:00:00.000Z'));
		const prisma = {
			crmEntitlement: {
				findUnique: jest.fn().mockResolvedValue(entitlement())
			}
		};
		const service = new CrmEntitlementService(prisma as never);

		await expect(service.get(WORKSPACE_ID)).resolves.toMatchObject({
			status: CrmEntitlementStatus.EXPIRED,
			entitlement: {
				workspaceId: WORKSPACE_ID,
				effectiveUntil: '2026-09-07T10:00:00.000Z'
			}
		});
	});

	it('keeps trial metadata nullable for a future paid entitlement', async () => {
		jest.useFakeTimers().setSystemTime(NOW);
		const prisma = {
			crmEntitlement: {
				findUnique: jest.fn().mockResolvedValue(
					entitlement({
						planCode: 'FUTURE_PAID_PLAN',
						trialStartedAt: null
					})
				)
			}
		};
		const service = new CrmEntitlementService(prisma as never);

		await expect(service.get(WORKSPACE_ID)).resolves.toMatchObject({
			entitlement: {
				planCode: 'FUTURE_PAID_PLAN',
				trialStartedAt: null
			}
		});
	});

	it('activates exactly one five-day trial and emits a PII-minimal outbox event', async () => {
		jest.useFakeTimers().setSystemTime(NOW);
		const created = entitlement();
		const transaction = {
			$executeRaw: jest.fn().mockResolvedValue(1),
			billingCommandReceipt: {
				findUnique: jest.fn().mockResolvedValue(null),
				create: jest.fn().mockResolvedValue({})
			},
			crmEntitlement: {
				findUnique: jest.fn().mockResolvedValue(null),
				create: jest.fn().mockResolvedValue(created)
			},
			billingSourceSequence: {
				upsert: jest.fn().mockResolvedValue({ nextValue: 2n })
			},
			outboxEvent: { create: jest.fn().mockResolvedValue({}) }
		};
		const prisma = {
			$transaction: jest.fn(async callback => callback(transaction))
		};
		const service = new CrmEntitlementService(prisma as never);

		const result = await service.activateTrial(command());

		expect(result).toMatchObject({
			activated: true,
			status: CrmEntitlementStatus.ACTIVE,
			entitlement: {
				workspaceId: WORKSPACE_ID,
				trialStartedAt: NOW.toISOString(),
				effectiveUntil: '2026-09-07T10:00:00.000Z'
			}
		});
		expect(transaction.crmEntitlement.create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				workspaceId: WORKSPACE_ID,
				productCode: 'WINCRM',
				planCode: 'TRIAL',
				trialStartedAt: NOW,
				effectiveUntil: new Date('2026-09-07T10:00:00.000Z')
			})
		});
		const event =
			transaction.outboxEvent.create.mock.calls[0][0].data.payload;
		expect(event.state).not.toHaveProperty('activatedByUserId');
		expect(JSON.stringify(event)).not.toContain('user-1');
	});

	it('does not restart a previously created trial under a new command', async () => {
		jest
			.useFakeTimers()
			.setSystemTime(new Date('2026-09-09T10:00:00.000Z'));
		const prior = entitlement();
		const transaction = {
			$executeRaw: jest.fn().mockResolvedValue(1),
			billingCommandReceipt: {
				findUnique: jest.fn().mockResolvedValue(null),
				create: jest.fn().mockResolvedValue({})
			},
			crmEntitlement: {
				findUnique: jest.fn().mockResolvedValue(prior),
				create: jest.fn()
			},
			billingSourceSequence: { upsert: jest.fn() },
			outboxEvent: { create: jest.fn() }
		};
		const prisma = {
			$transaction: jest.fn(async callback => callback(transaction))
		};
		const service = new CrmEntitlementService(prisma as never);

		await expect(service.activateTrial(command())).resolves.toMatchObject({
			activated: false,
			status: CrmEntitlementStatus.EXPIRED,
			entitlement: {
				trialStartedAt: NOW.toISOString(),
				effectiveUntil: '2026-09-07T10:00:00.000Z'
			}
		});
		expect(transaction.crmEntitlement.create).not.toHaveBeenCalled();
		expect(transaction.outboxEvent.create).not.toHaveBeenCalled();
	});

	it('recomputes expiry when the original command is retried later', async () => {
		jest
			.useFakeTimers()
			.setSystemTime(new Date('2026-09-09T10:00:00.000Z'));
		const payload = command();
		const transaction = {
			$executeRaw: jest.fn().mockResolvedValue(1),
			billingCommandReceipt: {
				findUnique: jest.fn().mockResolvedValue({
					commandType: 'ACTIVATE_WINCRM_TRIAL',
					requestHash: billingCommandRequestHash(
						'ACTIVATE_WINCRM_TRIAL',
						payload
					),
					requestHashVersion: 1,
					result: {
						schemaVersion: 1,
						productCode: 'WINCRM',
						status: 'ACTIVE',
						activated: true
					}
				})
			},
			crmEntitlement: {
				findUnique: jest.fn().mockResolvedValue(entitlement())
			}
		};
		const prisma = {
			$transaction: jest.fn(async callback => callback(transaction))
		};
		const service = new CrmEntitlementService(prisma as never);

		await expect(service.activateTrial(payload)).resolves.toMatchObject({
			activated: false,
			status: CrmEntitlementStatus.EXPIRED,
			entitlement: {
				trialStartedAt: NOW.toISOString(),
				effectiveUntil: '2026-09-07T10:00:00.000Z'
			}
		});
	});
});
