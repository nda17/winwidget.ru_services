import { CrmEntitlementStatus } from '@prisma/billing-client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { billingCommandRequestHash } from './billing-command-idempotency';
import { CrmEntitlementService } from './crm-entitlement.service';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const COMMAND_ID = '22222222-2222-4222-8222-222222222222';
const REPLACEMENT_COMMAND_ID = '44444444-4444-4444-8444-444444444444';
const PROVISIONING_COMMAND_TYPE = 'ACTIVATE_WINCRM_TRIAL';
const NOW = new Date('2026-09-02T10:00:00.000Z');

const entitlement = (overrides: Record<string, unknown> = {}) => ({
	id: '33333333-3333-4333-8333-333333333333',
	workspaceId: WORKSPACE_ID,
	productCode: 'WINCRM',
	planCode: 'TRIAL',
	status: CrmEntitlementStatus.ACTIVE,
	seatLimit: null,
	policyVersion: null,
	graceUntil: null,
	trialStartedAt: NOW,
	effectiveFrom: NOW,
	effectiveUntil: new Date('2026-09-07T10:00:00.000Z'),
	provisioningCommandId: COMMAND_ID,
	provisioningCommandType: PROVISIONING_COMMAND_TYPE,
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

	it('returns Billing-owned provisioning provenance in the internal entitlement contract', async () => {
		jest.useFakeTimers().setSystemTime(NOW);
		const prisma = {
			crmEntitlement: {
				findUnique: jest.fn().mockResolvedValue(entitlement())
			}
		};
		const service = new CrmEntitlementService(prisma as never);

		await expect(service.get(WORKSPACE_ID)).resolves.toEqual({
			schemaVersion: 1,
			productCode: 'WINCRM',
			status: CrmEntitlementStatus.ACTIVE,
			entitlement: {
				id: '33333333-3333-4333-8333-333333333333',
				workspaceId: WORKSPACE_ID,
				planCode: 'TRIAL',
				seatLimit: null,
				policyVersion: null,
				graceUntil: null,
				trialStartedAt: NOW.toISOString(),
				effectiveFrom: NOW.toISOString(),
				effectiveUntil: '2026-09-07T10:00:00.000Z',
				provisioningCommandId: COMMAND_ID,
				provisioningCommandType: PROVISIONING_COMMAND_TYPE,
				activatedByUserId: 'user-1',
				aggregateVersion: '1',
				sourceSequence: '1'
			}
		});
	});

	it.each([
		['2026-09-07T09:59:59.999Z', 'ACTIVE'],
		['2026-09-07T10:00:00.000Z', 'GRACE'],
		['2026-09-10T09:59:59.999Z', 'GRACE'],
		['2026-09-10T10:00:00.000Z', 'READ_ONLY'],
		['2027-01-01T00:00:00.000Z', 'READ_ONLY']
	])(
		'derives the snapshotted lifecycle at %s as %s without reading the latest policy',
		async (date, status) => {
			jest.useFakeTimers().setSystemTime(new Date(date));
			const prisma = {
				crmEntitlement: {
					findUnique: jest.fn().mockResolvedValue(
						entitlement({
							policyVersion: 1,
							seatLimit: 5,
							graceUntil: new Date('2026-09-10T10:00:00.000Z')
						})
					)
				},
				crmCommercialPolicy: { findFirst: jest.fn() }
			};
			const service = new CrmEntitlementService(prisma as never);
			await expect(service.get(WORKSPACE_ID)).resolves.toMatchObject({
				status,
				entitlement: {
					policyVersion: 1,
					seatLimit: 5,
					graceUntil: '2026-09-10T10:00:00.000Z'
				}
			});
			expect(prisma.crmCommercialPolicy.findFirst).not.toHaveBeenCalled();
		}
	);

	it.each(['SUSPENDED', 'CANCELLED'])(
		'never overrides an explicit %s entitlement during grace',
		async status => {
			jest
				.useFakeTimers()
				.setSystemTime(new Date('2026-09-08T10:00:00.000Z'));
			const service = new CrmEntitlementService({
				crmEntitlement: {
					findUnique: jest.fn().mockResolvedValue(
						entitlement({
							status,
							policyVersion: 1,
							seatLimit: 5,
							graceUntil: new Date('2026-09-10T10:00:00.000Z')
						})
					)
				}
			} as never);
			await expect(service.get(WORKSPACE_ID)).resolves.toMatchObject({
				status
			});
		}
	);

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

	it.each([2, 5])(
		'activates exactly one five-day trial with the configured %i seats and emits a PII-minimal outbox event',
		async trialSeatLimit => {
			jest.useFakeTimers().setSystemTime(NOW);
			const created = entitlement({
				policyVersion: 2,
				seatLimit: trialSeatLimit,
				graceUntil: new Date('2026-09-10T10:00:00.000Z')
			});
			const transaction = {
				$executeRaw: jest.fn().mockResolvedValue(1),
				crmCommercialPolicy: {
					findFirst: jest.fn().mockResolvedValue({
						version: 2,
						trialSeatLimit,
						trialDays: 5,
						graceDays: 3
					})
				},
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
					policyVersion: 2,
					seatLimit: trialSeatLimit,
					trialStartedAt: NOW.toISOString(),
					effectiveUntil: '2026-09-07T10:00:00.000Z',
					provisioningCommandId: COMMAND_ID,
					provisioningCommandType: PROVISIONING_COMMAND_TYPE,
					activatedByUserId: 'user-1'
				}
			});
			expect(transaction.crmEntitlement.create).toHaveBeenCalledWith({
				data: expect.objectContaining({
					workspaceId: WORKSPACE_ID,
					productCode: 'WINCRM',
					planCode: 'TRIAL',
					seatLimit: trialSeatLimit,
					policyVersion: 2,
					graceUntil: new Date('2026-09-10T10:00:00.000Z'),
					trialStartedAt: NOW,
					effectiveUntil: new Date('2026-09-07T10:00:00.000Z'),
					provisioningCommandId: COMMAND_ID,
					provisioningCommandType: PROVISIONING_COMMAND_TYPE,
					activatedByUserId: 'user-1'
				})
			});
			expect(
				transaction.billingCommandReceipt.create
			).toHaveBeenCalledWith({
				data: expect.objectContaining({
					commandId: COMMAND_ID,
					commandType: PROVISIONING_COMMAND_TYPE,
					requestHashVersion: 1,
					result: expect.objectContaining({
						activated: true,
						entitlement: expect.objectContaining({
							provisioningCommandId: COMMAND_ID,
							provisioningCommandType: PROVISIONING_COMMAND_TYPE,
							activatedByUserId: 'user-1'
						})
					})
				})
			});
			const event =
				transaction.outboxEvent.create.mock.calls[0][0].data.payload;
			expect(event.state).not.toHaveProperty('activatedByUserId');
			expect(event.state).not.toHaveProperty('provisioningCommandId');
			expect(event.state).not.toHaveProperty('provisioningCommandType');
			expect(JSON.stringify(event)).not.toContain('user-1');
		}
	);

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

		await expect(
			service.activateTrial({
				...command(),
				commandId: REPLACEMENT_COMMAND_ID
			})
		).resolves.toMatchObject({
			activated: false,
			status: CrmEntitlementStatus.EXPIRED,
			entitlement: {
				trialStartedAt: NOW.toISOString(),
				effectiveUntil: '2026-09-07T10:00:00.000Z',
				provisioningCommandId: COMMAND_ID,
				provisioningCommandType: PROVISIONING_COMMAND_TYPE,
				activatedByUserId: 'user-1'
			}
		});
		expect(transaction.crmEntitlement.create).not.toHaveBeenCalled();
		expect(transaction.outboxEvent.create).not.toHaveBeenCalled();
		expect(transaction.billingCommandReceipt.create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				commandId: REPLACEMENT_COMMAND_ID,
				commandType: PROVISIONING_COMMAND_TYPE,
				result: expect.objectContaining({
					activated: false,
					entitlement: expect.objectContaining({
						provisioningCommandId: COMMAND_ID,
						provisioningCommandType: PROVISIONING_COMMAND_TYPE,
						activatedByUserId: 'user-1'
					})
				})
			})
		});
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
				effectiveUntil: '2026-09-07T10:00:00.000Z',
				provisioningCommandId: COMMAND_ID,
				provisioningCommandType: PROVISIONING_COMMAND_TYPE,
				activatedByUserId: 'user-1'
			}
		});
	});

	it('keeps original provenance when retrying a command that did not provision the entitlement', async () => {
		jest.useFakeTimers().setSystemTime(NOW);
		const payload = {
			...command(),
			commandId: REPLACEMENT_COMMAND_ID
		};
		const transaction = {
			$executeRaw: jest.fn().mockResolvedValue(1),
			billingCommandReceipt: {
				findUnique: jest.fn().mockResolvedValue({
					commandType: PROVISIONING_COMMAND_TYPE,
					requestHash: billingCommandRequestHash(
						PROVISIONING_COMMAND_TYPE,
						payload
					),
					requestHashVersion: 1,
					result: { activated: false }
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
			entitlement: {
				provisioningCommandId: COMMAND_ID,
				provisioningCommandType: PROVISIONING_COMMAND_TYPE,
				activatedByUserId: 'user-1'
			}
		});
	});

	it('fails closed when an activation receipt has no boolean result', async () => {
		const payload = command();
		const transaction = {
			$executeRaw: jest.fn().mockResolvedValue(1),
			billingCommandReceipt: {
				findUnique: jest.fn().mockResolvedValue({
					commandType: PROVISIONING_COMMAND_TYPE,
					requestHash: billingCommandRequestHash(
						PROVISIONING_COMMAND_TYPE,
						payload
					),
					requestHashVersion: 1,
					result: {}
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

		await expect(service.activateTrial(payload)).rejects.toThrow(
			'WinCRM activation receipt has an invalid result'
		);
	});

	it.each([
		['command ID', { provisioningCommandId: REPLACEMENT_COMMAND_ID }],
		[
			'command type',
			{ provisioningCommandType: 'ACTIVATE_ANOTHER_PRODUCT' }
		],
		['activating user', { activatedByUserId: 'another-user' }]
	])(
		'fails closed when an accepted receipt disagrees with the saved provisioning %s',
		async (_case, entitlementOverrides) => {
			const payload = command();
			const transaction = {
				$executeRaw: jest.fn().mockResolvedValue(1),
				billingCommandReceipt: {
					findUnique: jest.fn().mockResolvedValue({
						commandType: PROVISIONING_COMMAND_TYPE,
						requestHash: billingCommandRequestHash(
							PROVISIONING_COMMAND_TYPE,
							payload
						),
						requestHashVersion: 1,
						result: { activated: true }
					})
				},
				crmEntitlement: {
					findUnique: jest
						.fn()
						.mockResolvedValue(entitlement(entitlementOverrides))
				}
			};
			const prisma = {
				$transaction: jest.fn(async callback => callback(transaction))
			};
			const service = new CrmEntitlementService(prisma as never);

			await expect(service.activateTrial(payload)).rejects.toThrow(
				'WinCRM entitlement provenance does not match its accepted activation receipt'
			);
		}
	);
});

describe('WinCRM entitlement provisioning provenance migration', () => {
	const migration = readFileSync(
		join(
			__dirname,
			'../../prisma/migrations/20260904092000_add_crm_entitlement_provisioning_provenance/migration.sql'
		),
		'utf8'
	);

	it('backfills only from accepted Trial command receipts and fails closed', () => {
		expect(migration).toContain(
			`receipt."command_type" = 'ACTIVATE_WINCRM_TRIAL'`
		);
		expect(migration).toContain(
			`receipt."result"->'activated' = 'true'::jsonb`
		);
		expect(migration).toContain(') IS NOT TRUE');
		expect(migration).toContain(
			`receipt."result"->'entitlement'->>'planCode' = 'TRIAL'`
		);
		expect(migration).toContain(
			'Every WinCRM entitlement must have exactly one accepted provisioning command receipt'
		);
		expect(migration).toContain(
			'Cannot backfill WinCRM provisioning provenance from an invalid accepted command receipt'
		);
		expect(migration).not.toMatch(/gen_random_uuid|uuid_generate/i);
		expect(migration).toContain(
			'FULL JOIN "accepted_provisioning_receipts" AS receipt'
		);
		expect(migration).not.toContain('CREATE TEMPORARY TABLE');
	});

	it('requires well-formed provenance that is unique by source command', () => {
		expect(migration).toContain(
			'ALTER COLUMN "provisioning_command_id" SET NOT NULL'
		);
		expect(migration).toContain(
			'ALTER COLUMN "provisioning_command_type" SET NOT NULL'
		);
		expect(migration).toContain(
			`"provisioning_command_type" ~ '^[A-Z][A-Z0-9_]{0,63}$'`
		);
		expect(migration).toContain(
			'CREATE UNIQUE INDEX "crm_entitlements_provisioning_command_id_key"'
		);
	});
});

describe('WinCRM two-seat default migration safety', () => {
	const migration = readFileSync(
		join(
			__dirname,
			'../../prisma/migrations/20260908090000_set_default_crm_trial_seats_two/migration.sql'
		),
		'utf8'
	);

	it('appends only over the exact original seed under the policy publication fence', () => {
		expect(migration).toContain(
			"hashtextextended('billing-wincrm-commercial-policy', 0)"
		);
		expect(migration).toContain(
			'INSERT INTO "billing"."crm_commercial_policies"'
		);
		expect(migration).toContain(
			'"seed"."included_seats", 2, "seed"."trial_days", "seed"."grace_days"'
		);
		expect(migration).toContain('"seed"."version" = 1');
		expect(migration).toContain('"seed"."created_by_user_id" IS NULL');
		for (const [field, value] of Object.entries({
			monthly_price_minor: 99000,
			yearly_price_minor: 990000,
			additional_seat_monthly_price_minor: 29000,
			additional_seat_yearly_price_minor: 290000,
			included_seats: 2,
			trial_seat_limit: 5,
			trial_days: 5,
			grace_days: 3
		}))
			expect(migration).toContain(`"seed"."${field}" = ${value}`);
		expect(migration).toMatch(/NOT EXISTS \([\s\S]*WHERE "version" <> 1/);
	});

	it('does not rewrite published policies, command receipts, or existing entitlement snapshots', () => {
		const statements = migration.replace(/--[^\n]*/g, '');
		expect(statements).not.toMatch(
			/\b(?:UPDATE|DELETE|TRUNCATE|ALTER|DROP)\b/i
		);
		expect(statements).not.toMatch(/crm_entitlements|command_receipts/i);
		expect(statements.trim()).toMatch(/^BEGIN;[\s\S]*COMMIT;$/);
		const historicalMigration = readFileSync(
			join(
				__dirname,
				'../../prisma/migrations/20260905120000_add_crm_commercial_policy/migration.sql'
			),
			'utf8'
		);
		expect(historicalMigration).toContain(
			'VALUES (1, 99000, 990000, 29000, 290000, 2, 5, 5, 3)'
		);
	});
});
