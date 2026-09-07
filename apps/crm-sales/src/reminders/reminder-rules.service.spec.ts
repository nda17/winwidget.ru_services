import {
	BadRequestException,
	ConflictException,
	ForbiddenException,
	NotFoundException,
	ServiceUnavailableException
} from '@nestjs/common';
import { Prisma } from '@prisma/crm-sales-client';
import { randomUUID } from 'node:crypto';
import type { SalesAccess } from '../sales/sales-access';
import type { ReminderRuleV1 } from './reminder-rule';
import { ReminderRulesService } from './reminder-rules.service';
import {
	ReminderRulesQuery,
	ReminderPageQuery
} from './reminder-rules.dto';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const membershipId = '22222222-2222-4222-8222-222222222222';
const actor: SalesAccess = {
	schemaVersion: 1,
	workspaceId,
	subject: 'owner',
	role: 'OWNER',
	state: 'ACTIVE',
	dataScope: 'ALL',
	teamIds: [],
	permissions: ['sales:read', 'sales:write']
};
const rule = (access = actor): ReminderRuleV1 => ({
	schemaVersion: 1,
	id: randomUUID(),
	scope: 'PERSONAL',
	ownerBinding: {
		subject: access.subject,
		membershipId: access.role === 'OWNER' ? null : membershipId
	},
	title: 'До срока',
	enabled: false,
	channels: [],
	trigger: { kind: 'BEFORE_DUE', offsetMinutes: 60 },
	repeats: null,
	timeZone: 'Europe/Moscow',
	quietHours: null,
	recipients: { kind: 'SELF' }
});
const command = (value = rule(), id = randomUUID()) => ({
	schemaVersion: 1 as const,
	commandId: id,
	workspaceId,
	actorMembershipId: value.ownerBinding.membershipId,
	rule: value
});
type Row = Record<string, any>;
// Build fixture values in the Jest realm, like Prisma JSON decoding. Native
// structuredClone uses a different realm and is rejected by the strict parser.
function clone<T>(value: T): T {
	if (value instanceof Date) return new Date(value.getTime()) as T;
	if (Array.isArray(value)) return value.map(clone) as T;
	if (value && typeof value === 'object')
		return Object.fromEntries(
			Object.entries(value).map(([key, entry]) => [key, clone(entry)])
		) as T;
	return value;
}
function matches(row: Row, where: Row): boolean {
	return Object.entries(where).every(([key, value]) =>
		key === 'AND'
			? value.every((part: Row) => matches(row, part))
			: key === 'OR'
				? value.some((part: Row) => matches(row, part))
				: value && typeof value === 'object'
					? 'not' in value
						? row[key] !== value.not
						: false
					: row[key] === value
	);
}
function harness(
	initial = actor,
	readiness?: { ready: () => Promise<boolean> }
) {
	let rows: Row[] = [],
		receipts: Row[] = [];
	const tx = {
		$executeRaw: jest.fn().mockResolvedValue(1),
		reminderRule: {
			findFirst: jest.fn(async ({ where }) =>
				clone(rows.find(row => matches(row, where)) ?? null)
			),
			findUnique: jest.fn(async ({ where }) =>
				clone(rows.find(row => matches(row, where)) ?? null)
			),
			count: jest.fn(
				async ({ where }) => rows.filter(row => matches(row, where)).length
			),
			findMany: jest.fn(async ({ where, skip, take }) =>
				clone(
					rows.filter(row => matches(row, where)).slice(skip, skip + take)
				)
			),
			create: jest.fn(async ({ data }) => {
				const row = {
					...clone(data),
					version: 1,
					archivedAt: null,
					createdAt: new Date(),
					updatedAt: new Date()
				};
				rows.push(row);
				return clone(row);
			}),
			updateMany: jest.fn(async ({ where, data }) => {
				const row = rows.find(row => matches(row, where));
				if (!row) return { count: 0 };
				Object.assign(row, clone(data), {
					version: row.version + 1,
					updatedAt: new Date()
				});
				return { count: 1 };
			})
		},
		reminderRuleCommand: {
			findUnique: jest.fn(
				async ({ where }) =>
					receipts.find(row => matches(row, where)) ?? null
			),
			create: jest.fn(async ({ data }) => {
				const row = { ...data, createdAt: new Date() };
				receipts.push(row);
				return row;
			}),
			count: jest.fn(
				async ({ where }) =>
					receipts.filter(row => matches(row, where)).length
			),
			findMany: jest.fn(async ({ where, skip, take }) =>
				receipts
					.filter(row => matches(row, where))
					.slice(skip, skip + take)
			)
		}
	};
	const prisma = {
		...tx,
		$transaction: jest.fn(async (action, _options?: unknown) => {
			void _options;
			const beforeRows = clone(rows),
				beforeReceipts = [...receipts];
			try {
				return await action(tx);
			} catch (error) {
				rows = beforeRows;
				receipts = beforeReceipts;
				throw error;
			}
		})
	};
	const auth = {
		authorize: jest.fn().mockImplementation(async () => clone(initial))
	};
	const directory = {
		verify: jest
			.fn()
			.mockImplementation(async (_token, access, membership) => ({
				subject: access.subject,
				membershipId: membership
			}))
	};
	return {
		tx,
		prisma,
		auth,
		directory,
		service: new ReminderRulesService(
			prisma as never,
			auth as never,
			directory as never,
			readiness as never
		),
		get rows() {
			return rows;
		},
		get receipts() {
			return receipts;
		}
	};
}
const query = (patch: Partial<ReminderRulesQuery> = {}) =>
	Object.assign(new ReminderRulesQuery(), { workspaceId }, patch);

describe('ReminderRulesService: configuration only', () => {
	it('defaults disabled, stores server-bound owner and receipt atomically without touching tasks', async () => {
		const h = harness(),
			dto = command();
		delete (dto.rule as { enabled?: boolean }).enabled;
		const result = await h.service.create(actor, dto, 'Bearer test');
		expect(result).toMatchObject({
			schemaVersion: 1,
			deliveryReady: false,
			item: {
				workspaceId,
				version: 1,
				rule: {
					enabled: false,
					ownerBinding: { subject: actor.subject, membershipId: null }
				}
			}
		});
		expect(h.receipts).toHaveLength(1);
		expect(h.rows).toHaveLength(1);
		expect(h.directory.verify).toHaveBeenCalledTimes(2);
		expect(h.prisma.$transaction).toHaveBeenCalledWith(
			expect.any(Function),
			{ isolationLevel: 'Serializable', timeout: 20000 }
		);
		expect(h.tx.$executeRaw).toHaveBeenCalledTimes(2);
	});
	it('replays original result even after later changes without another mutation/audit', async () => {
		const h = harness(),
			dto = command(),
			first = await h.service.create(actor, dto, 'Bearer test');
		await h.service.edit(
			actor,
			dto.rule.id,
			{ ...command({ ...dto.rule, title: 'Другое' }), expectedVersion: 1 },
			'Bearer test'
		);
		expect(await h.service.create(actor, dto, 'Bearer test')).toEqual(
			first
		);
		expect(h.tx.reminderRule.create).toHaveBeenCalledTimes(1);
		expect(h.receipts).toHaveLength(2);
	});
	it('canonical channel ordering replays but changed payload/actor/workspace/membership never does', async () => {
		const h = harness(),
			dto = command({ ...rule(), channels: ['EMAIL', 'TELEGRAM'] });
		await h.service.create(actor, dto, 'Bearer test');
		await expect(
			h.service.create(
				actor,
				{ ...dto, rule: { ...dto.rule, channels: ['TELEGRAM', 'EMAIL'] } },
				'Bearer test'
			)
		).resolves.toBeDefined();
		await expect(
			h.service.create(
				actor,
				{ ...dto, rule: { ...dto.rule, title: 'Changed' } },
				'Bearer test'
			)
		).rejects.toBeInstanceOf(ConflictException);
		for (const field of [
			'workspaceId',
			'actorSubject',
			'actorMembershipId',
			'commandType'
		]) {
			const prior = h.receipts[0][field];
			h.receipts[0][field] = 'foreign';
			await expect(
				h.service.create(actor, dto, 'Bearer test')
			).rejects.toBeInstanceOf(ConflictException);
			h.receipts[0][field] = prior;
		}
	});
	it.each(['OWNER', 'CRM_ADMIN'] as const)(
		'%s manages shared rules, preserving their original creator binding',
		async role => {
			const h = harness(),
				value = {
					...rule(),
					scope: 'WORKSPACE' as const,
					recipients: { kind: 'ASSIGNEE' as const }
				},
				dto = command(value);
			await h.service.create(actor, dto, 'Bearer test');
			const editor = {
				...actor,
				role,
				subject: role === 'OWNER' ? 'owner' : 'admin'
			};
			h.auth.authorize.mockResolvedValue(editor);
			await expect(
				h.service.edit(
					editor,
					value.id,
					{
						...command({ ...value, title: 'Изменено' }),
						actorMembershipId: role === 'OWNER' ? null : membershipId,
						expectedVersion: 1
					},
					'Bearer test'
				)
			).resolves.toMatchObject({
				item: { version: 2, rule: { ownerBinding: value.ownerBinding } }
			});
		}
	);
	it.each(['TEAM_LEAD', 'MANAGER'] as const)(
		'%s may manage only exact personal rules',
		async role => {
			const user = {
					...actor,
					role,
					subject: role,
					dataScope: 'OWN' as const
				},
				h = harness(user),
				dto = command(rule(user));
			await expect(
				h.service.create(user, dto, 'Bearer test')
			).resolves.toBeDefined();
			await expect(
				h.service.create(
					user,
					command({
						...dto.rule,
						id: randomUUID(),
						scope: 'WORKSPACE',
						recipients: { kind: 'ASSIGNEE' }
					}),
					'Bearer test'
				)
			).rejects.toBeInstanceOf(ForbiddenException);
		}
	);
	it.each(['ACTIVE', 'GRACE'] as const)(
		'permits configuration writes in %s, never enabling delivery',
		async state => {
			const user = { ...actor, state },
				h = harness(user);
			await expect(
				h.service.create(user, command(), 'Bearer test')
			).resolves.toMatchObject({ deliveryReady: false });
			await expect(
				h.service.create(
					user,
					command({ ...rule(), enabled: true, channels: ['EMAIL'] }),
					'Bearer test'
				)
			).rejects.toBeInstanceOf(ServiceUnavailableException);
			expect(h.rows).toHaveLength(1);
		}
	);
	it('enables only with proven delivery readiness; an original receipt remains recoverable after transports stop', async () => {
		const readiness = { ready: jest.fn().mockResolvedValue(true) },
			h = harness(actor, readiness);
		const dto = command({ ...rule(), enabled: true, channels: ['EMAIL'] });
		const result = await h.service.create(actor, dto, 'Bearer test');
		expect(result).toMatchObject({
			deliveryReady: true,
			item: { rule: { enabled: true } }
		});
		readiness.ready.mockResolvedValue(false);
		expect(await h.service.create(actor, dto, 'Bearer test')).toEqual(
			result
		);
		await expect(
			h.service.create(
				actor,
				command({ ...dto.rule, id: randomUUID() }),
				'Bearer test'
			)
		).rejects.toBeInstanceOf(ServiceUnavailableException);
		expect(h.rows).toHaveLength(1);
	});
	it('READ_ONLY retains reads/history and refuses every mutation including replay', async () => {
		const h = harness(),
			dto = command();
		await h.service.create(actor, dto, 'Bearer test');
		const readonly = { ...actor, state: 'READ_ONLY' as const };
		h.auth.authorize.mockResolvedValue(readonly);
		await expect(
			h.service.list(readonly, query(), 'Bearer test')
		).resolves.toMatchObject({ total: 1 });
		await expect(
			h.service.detail(readonly, dto.rule.id, query(), 'Bearer test')
		).resolves.toBeDefined();
		await expect(
			h.service.history(
				readonly,
				dto.rule.id,
				Object.assign(new ReminderPageQuery(), { workspaceId }),
				'Bearer test'
			)
		).resolves.toMatchObject({ total: 1 });
		await expect(
			h.service.create(readonly, dto, 'Bearer test')
		).rejects.toBeInstanceOf(ForbiddenException);
		await expect(
			h.service.edit(
				readonly,
				dto.rule.id,
				{ ...dto, expectedVersion: 1 },
				'Bearer test'
			)
		).rejects.toBeInstanceOf(ForbiddenException);
		await expect(
			h.service.archive(
				readonly,
				dto.rule.id,
				{
					schemaVersion: 1,
					workspaceId,
					commandId: randomUUID(),
					actorMembershipId: null,
					expectedVersion: 1
				},
				'Bearer test'
			)
		).rejects.toBeInstanceOf(ForbiddenException);
	});
	it('ANALYST and missing sales permission cannot read/change reminders', async () => {
		for (const user of [
			{ ...actor, role: 'ANALYST' as const },
			{ ...actor, permissions: [] }
		]) {
			const h = harness(user);
			await expect(
				h.service.list(user, query(), 'Bearer test')
			).rejects.toBeInstanceOf(ForbiddenException);
			await expect(
				h.service.create(user, command(), 'Bearer test')
			).rejects.toBeInstanceOf(ForbiddenException);
			expect(h.prisma.$transaction).not.toHaveBeenCalled();
		}
	});
	it('tenant/owner/scope changes fail closed and do not disclose others personal rules', async () => {
		const h = harness(),
			dto = command();
		await h.service.create(actor, dto, 'Bearer test');
		await expect(
			h.service.create(
				actor,
				{ ...command(), workspaceId: randomUUID() },
				'Bearer test'
			)
		).rejects.toBeInstanceOf(ForbiddenException);
		await expect(
			h.service.create(
				actor,
				command({
					...rule(),
					ownerBinding: { subject: 'foreign', membershipId: null }
				}),
				'Bearer test'
			)
		).rejects.toBeInstanceOf(ForbiddenException);
		await expect(
			h.service.edit(
				actor,
				dto.rule.id,
				{
					...dto,
					commandId: randomUUID(),
					expectedVersion: 1,
					rule: {
						...dto.rule,
						scope: 'WORKSPACE',
						recipients: { kind: 'ASSIGNEE' }
					}
				},
				'Bearer test'
			)
		).rejects.toBeInstanceOf(BadRequestException);
		const other = {
			...actor,
			subject: 'other-admin',
			role: 'CRM_ADMIN' as const
		};
		h.auth.authorize.mockResolvedValue(other);
		await expect(
			h.service.detail(
				other,
				dto.rule.id,
				query({ actorMembershipId: membershipId }),
				'Bearer test'
			)
		).rejects.toBeInstanceOf(NotFoundException);
		await expect(
			h.service.list(
				other,
				query({ actorMembershipId: membershipId }),
				'Bearer test'
			)
		).resolves.toMatchObject({ total: 0 });
	});
	it('exact membership prevents a rejoined employee from reading their prior personal rule', async () => {
		const manager = {
				...actor,
				subject: 'manager',
				role: 'MANAGER' as const
			},
			h = harness(manager),
			dto = command(rule(manager));
		await h.service.create(manager, dto, 'Bearer test');
		await expect(
			h.service.detail(
				manager,
				dto.rule.id,
				query({ actorMembershipId: randomUUID() }),
				'Bearer test'
			)
		).rejects.toBeInstanceOf(NotFoundException);
	});
	it('CAS catches stale edits, zero-row races and archived rules; archive retains immutable history', async () => {
		const h = harness(),
			dto = command();
		await h.service.create(actor, dto, 'Bearer test');
		await expect(
			h.service.edit(
				actor,
				dto.rule.id,
				{ ...dto, commandId: randomUUID(), expectedVersion: 2 },
				'Bearer test'
			)
		).rejects.toBeInstanceOf(ConflictException);
		h.tx.reminderRule.updateMany.mockResolvedValueOnce({ count: 0 });
		await expect(
			h.service.edit(
				actor,
				dto.rule.id,
				{ ...dto, commandId: randomUUID(), expectedVersion: 1 },
				'Bearer test'
			)
		).rejects.toBeInstanceOf(ConflictException);
		const archive = {
			schemaVersion: 1 as const,
			workspaceId,
			actorMembershipId: null,
			commandId: randomUUID(),
			expectedVersion: 1
		};
		const result = await h.service.archive(
			actor,
			dto.rule.id,
			archive,
			'Bearer test'
		);
		expect(result).toMatchObject({
			item: { version: 2, archivedAt: expect.any(String) }
		});
		expect(
			await h.service.archive(actor, dto.rule.id, archive, 'Bearer test')
		).toEqual(result);
		await expect(
			h.service.list(actor, query(), 'Bearer test')
		).resolves.toMatchObject({ total: 0 });
		await expect(
			h.service.list(actor, query({ archived: 'true' }), 'Bearer test')
		).resolves.toMatchObject({ total: 1 });
		await expect(
			h.service.edit(
				actor,
				dto.rule.id,
				{ ...dto, commandId: randomUUID(), expectedVersion: 2 },
				'Bearer test'
			)
		).rejects.toBeInstanceOf(ConflictException);
		expect(h.receipts).toHaveLength(2);
	});
	it.each([
		['PERSONAL', 10],
		['WORKSPACE', 20]
	] as const)(
		'bounds %s to %i non-archived rules and frees quota on archive',
		async (scope, limit) => {
			const h = harness();
			let first = '';
			for (let index = 0; index < limit; index++) {
				const value = {
					...rule(),
					scope,
					recipients: {
						kind:
							scope === 'PERSONAL'
								? ('SELF' as const)
								: ('ASSIGNEE' as const)
					}
				};
				first ||= value.id;
				await h.service.create(actor, command(value), 'Bearer test');
			}
			const next = command({
				...rule(),
				scope,
				recipients: { kind: scope === 'PERSONAL' ? 'SELF' : 'ASSIGNEE' }
			});
			await expect(
				h.service.create(actor, next, 'Bearer test')
			).rejects.toMatchObject({
				response: { code: 'crm_reminder_rule_limit' }
			});
			await h.service.archive(
				actor,
				first,
				{
					schemaVersion: 1,
					workspaceId,
					actorMembershipId: null,
					commandId: randomUUID(),
					expectedVersion: 1
				},
				'Bearer test'
			);
			await expect(
				h.service.create(actor, next, 'Bearer test')
			).resolves.toBeDefined();
		}
	);
	it('rechecks binding and complete authority before commit; revocation rolls back rule and receipt', async () => {
		const h = harness();
		h.directory.verify.mockRejectedValueOnce(new ForbiddenException());
		await expect(
			h.service.create(actor, command(), 'Bearer test')
		).rejects.toBeInstanceOf(ForbiddenException);
		expect(h.rows).toHaveLength(0);
		h.directory.verify
			.mockResolvedValueOnce({
				subject: actor.subject,
				membershipId: null
			})
			.mockRejectedValueOnce(new ForbiddenException());
		await expect(
			h.service.create(actor, command(), 'Bearer test')
		).rejects.toBeInstanceOf(ForbiddenException);
		expect(h.rows).toHaveLength(0);
		expect(h.receipts).toHaveLength(0);
		for (const patch of [
			{ role: 'MANAGER' as const },
			{ subject: 'other' },
			{ dataScope: 'OWN' as const },
			{ teamIds: [randomUUID()] },
			{ permissions: ['sales:read'] },
			{ state: 'READ_ONLY' as const }
		]) {
			const changed = harness();
			changed.auth.authorize
				.mockResolvedValueOnce(actor)
				.mockResolvedValueOnce({ ...actor, ...patch });
			await expect(
				changed.service.create(actor, command(), 'Bearer test')
			).rejects.toBeInstanceOf(ForbiddenException);
		}
	});
	it('does not return private read results when authority changes during the read', async () => {
		const h = harness(),
			dto = command();
		await h.service.create(actor, dto, 'Bearer test');
		h.auth.authorize
			.mockReset()
			.mockResolvedValueOnce(actor)
			.mockResolvedValueOnce(actor)
			.mockRejectedValueOnce(new ForbiddenException());
		await expect(
			h.service.detail(actor, dto.rule.id, query(), 'Bearer test')
		).rejects.toBeInstanceOf(ForbiddenException);
	});
	it('retries serialization conflicts with fresh authorization and a stable command', async () => {
		const h = harness();
		h.prisma.$transaction.mockRejectedValueOnce(
			new Prisma.PrismaClientKnownRequestError('conflict', {
				code: 'P2034',
				clientVersion: 'test'
			})
		);
		await expect(
			h.service.create(actor, command(), 'Bearer test')
		).resolves.toBeDefined();
		expect(h.receipts).toHaveLength(1);
		expect(h.prisma.$transaction).toHaveBeenCalledTimes(2);
	});
	it('paginates scoped rules and history in repeatable-read snapshots', async () => {
		const h = harness();
		for (let i = 0; i < 3; i++)
			await h.service.create(actor, command(), 'Bearer test');
		await expect(
			h.service.list(actor, query({ page: 2, pageSize: 1 }), 'Bearer test')
		).resolves.toMatchObject({ total: 3, items: [expect.any(Object)] });
		expect(h.tx.reminderRule.findMany).toHaveBeenLastCalledWith(
			expect.objectContaining({
				skip: 1,
				take: 1,
				where: expect.objectContaining({ AND: expect.any(Array) })
			})
		);
	});
});
