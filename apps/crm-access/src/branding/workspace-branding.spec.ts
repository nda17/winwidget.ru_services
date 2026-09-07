import {
	BadRequestException,
	ConflictException,
	ForbiddenException,
	ServiceUnavailableException,
	UnauthorizedException,
	ValidationPipe,
	type INestApplication
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/crm-access-client';
import { randomUUID } from 'node:crypto';
import { CrmAccessHttpExceptionFilter } from '../common/crm-access-http-exception.filter';
import { CrmWorkspaceBrandingController } from './workspace-branding.controller';
import {
	normalizeWorkspaceDisplayName,
	type UpdateWorkspaceBrandingDto
} from './workspace-branding.dto';
import { CrmWorkspaceBrandingService } from './workspace-branding.service';

const workspaceId = randomUUID();
const token = 'Bearer synthetic-branding-test';
const setup = (role = 'OWNER', state = 'ACTIVE') => {
	const actor = {
		workspaceId,
		subject: 'branding-test-actor',
		role,
		state,
		permissions: ['access:manage-team']
	};
	const rows = new Map<string, Record<string, unknown>>();
	const receipts = new Map<string, Record<string, unknown>>();
	const prisma = {
		$executeRaw: jest.fn(),
		$transaction: jest.fn(),
		crmWorkspaceAccess: {
			findUnique: jest.fn().mockResolvedValue({
				workspaceId,
				lifecycle: 'ACTIVE',
				onboardingCompletedAt: new Date()
			})
		},
		crmWorkspaceMember: {
			findUnique: jest.fn().mockImplementation(async () => ({
				role: actor.role,
				disabledAt: null
			}))
		},
		crmWorkspaceBranding: {
			findUnique: jest
				.fn()
				.mockImplementation(
					async ({ where }) => rows.get(where.workspaceId) ?? null
				),
			create: jest.fn().mockImplementation(async ({ data }) => {
				const row = { ...data, version: 1, updatedAt: new Date() };
				rows.set(data.workspaceId, row);
				return row;
			}),
			update: jest.fn().mockImplementation(async ({ where, data }) => {
				const current = rows.get(where.workspaceId)!;
				expect(where.version).toBe(current.version);
				const row = {
					...current,
					displayName: data.displayName,
					version: Number(current.version) + 1,
					updatedAt: new Date()
				};
				rows.set(where.workspaceId, row);
				return row;
			})
		},
		crmTeamCommandReceipt: {
			findUnique: jest
				.fn()
				.mockImplementation(
					async ({ where }) => receipts.get(where.commandId) ?? null
				),
			create: jest.fn().mockImplementation(async ({ data }) => {
				receipts.set(data.commandId, data);
				return data;
			})
		},
		crmTeamAudit: { create: jest.fn() }
	};
	prisma.$transaction.mockImplementation(callback => callback(prisma));
	const auth = {
		authorize: jest.fn().mockImplementation(async incoming => {
			if (incoming !== token)
				throw new UnauthorizedException('A CRM session is required');
			return { ...actor };
		})
	};
	const service = new CrmWorkspaceBrandingService(
		prisma as never,
		auth as never
	);
	const command = (overrides = {}): UpdateWorkspaceBrandingDto => ({
		schemaVersion: 1,
		workspaceId,
		commandId: randomUUID(),
		expectedActorSubject: actor.subject,
		expectedVersion: 0,
		displayName: 'Бренд',
		...overrides
	});
	return { actor, prisma, auth, service, command, receipts, rows };
};

describe('CRM workspace branding', () => {
	it.each(['OWNER', 'CRM_ADMIN', 'TEAM_LEAD', 'MANAGER', 'ANALYST'])(
		'%s reads the optional setting in every supported access state',
		async role => {
			for (const state of ['ACTIVE', 'GRACE', 'READ_ONLY']) {
				const current = setup(role, state);
				current.actor.permissions = [];
				expect(await current.service.get(token, { workspaceId })).toEqual({
					schemaVersion: 1,
					workspaceId,
					subject: current.actor.subject,
					branding: { displayName: null, version: 0, updatedAt: null }
				});
				expect(
					current.prisma.crmWorkspaceBranding.create
				).not.toHaveBeenCalled();
			}
		}
	);
	it.each(['OWNER', 'CRM_ADMIN'])(
		'%s can set, clear and replace the name with monotonic versions',
		async role => {
			const current = setup(role, 'GRACE');
			const dto = current.command({ displayName: '  Cafe\u0301  ' });
			const first = await current.service.update(token, dto);
			expect(first).toEqual({
				schemaVersion: 1,
				workspaceId,
				subject: current.actor.subject,
				commandId: dto.commandId,
				branding: {
					displayName: 'Café',
					version: 1,
					updatedAt: expect.any(String)
				}
			});
			expect(current.auth.authorize).toHaveBeenLastCalledWith(
				token,
				workspaceId,
				undefined,
				current.prisma
			);
			expect(current.prisma.$transaction).toHaveBeenCalledWith(
				expect.any(Function),
				{
					isolationLevel: 'ReadCommitted',
					maxWait: 1000,
					timeout: 15000
				}
			);
			expect(
				current.prisma.crmTeamAudit.create.mock.calls[0][0].data
			).toMatchObject({
				actorSubject: current.actor.subject,
				commandId: dto.commandId,
				action: 'WORKSPACE_BRANDING_UPDATED',
				targetId: workspaceId,
				before: { version: 0 },
				after: { version: 1, changed: true }
			});
			expect(
				JSON.stringify(current.prisma.crmTeamAudit.create.mock.calls)
			).not.toContain('Café');
			expect(
				await current.service.update(
					token,
					current.command({ expectedVersion: 1, displayName: '  ' })
				)
			).toMatchObject({ branding: { displayName: null, version: 2 } });
			await expect(
				current.service.update(token, current.command())
			).rejects.toBeInstanceOf(ConflictException);
			expect(
				await current.service.update(
					token,
					current.command({ expectedVersion: 2 })
				)
			).toMatchObject({ branding: { displayName: 'Бренд', version: 3 } });
		}
	);
	it.each(['TEAM_LEAD', 'MANAGER', 'ANALYST', 'ADMIN', 'DEV'])(
		'%s has no branding write privilege',
		async role => {
			const current = setup(role);
			await expect(
				current.service.update(token, current.command())
			).rejects.toBeInstanceOf(ForbiddenException);
			expect(current.prisma.$transaction).not.toHaveBeenCalled();
		}
	);
	it('requires write permission and forbids READ_ONLY, including completed receipt replay', async () => {
		const current = setup();
		const dto = current.command();
		await current.service.update(token, dto);
		current.actor.state = 'READ_ONLY';
		await expect(
			current.service.update(token, dto)
		).rejects.toBeInstanceOf(ForbiddenException);
		current.actor.state = 'ACTIVE';
		current.actor.permissions = [];
		await expect(
			current.service.update(token, dto)
		).rejects.toBeInstanceOf(ForbiddenException);
		expect(
			current.prisma.crmWorkspaceBranding.create
		).toHaveBeenCalledTimes(1);
	});
	it('replays the exact normalized command and rejects payload/actor/workspace/type collisions', async () => {
		const current = setup();
		const dto = current.command({ displayName: ' Cafe\u0301 ' });
		const first = await current.service.update(token, dto);
		expect(
			await current.service.update(token, { ...dto, displayName: 'Café' })
		).toEqual(first);
		await expect(
			current.service.update(token, { ...dto, displayName: 'Changed' })
		).rejects.toMatchObject({
			response: { code: 'crm_branding_command_conflict' }
		});
		const receipt = current.receipts.get(dto.commandId)!;
		for (const field of ['actorSubject', 'workspaceId', 'commandType']) {
			current.receipts.set(dto.commandId, {
				...receipt,
				[field]: 'foreign'
			});
			await expect(
				current.service.update(token, dto)
			).rejects.toMatchObject({
				response: { code: 'crm_branding_command_conflict' }
			});
		}
		expect(
			current.prisma.crmWorkspaceBranding.create
		).toHaveBeenCalledTimes(1);
		expect(
			current.prisma.crmTeamCommandReceipt.create
		).toHaveBeenCalledTimes(1);
		expect(current.prisma.crmTeamAudit.create).toHaveBeenCalledTimes(1);
	});
	it.each([
		{ subject: 'different-actor' },
		{ workspaceId: randomUUID() },
		{ role: 'MANAGER' },
		{ state: 'READ_ONLY' },
		{ state: 'SUSPENDED' },
		{ permissions: [] }
	])(
		'fails closed on authority change after waiting for the lock: %j',
		async change => {
			const current = setup();
			current.auth.authorize
				.mockResolvedValueOnce(current.actor)
				.mockResolvedValueOnce({ ...current.actor, ...change });
			await expect(
				current.service.update(token, current.command())
			).rejects.toBeInstanceOf(ForbiddenException);
			expect(
				current.prisma.crmWorkspaceBranding.create
			).not.toHaveBeenCalled();
			expect(
				current.prisma.crmTeamCommandReceipt.create
			).not.toHaveBeenCalled();
		}
	);
	it('fails closed when fresh authority is unavailable or the expected actor is wrong', async () => {
		const current = setup();
		await expect(
			current.service.update(
				token,
				current.command({ expectedActorSubject: 'other' })
			)
		).rejects.toBeInstanceOf(ForbiddenException);
		current.auth.authorize
			.mockResolvedValueOnce(current.actor)
			.mockRejectedValueOnce(new ServiceUnavailableException());
		await expect(
			current.service.update(token, current.command())
		).rejects.toBeInstanceOf(ServiceUnavailableException);
		expect(
			current.prisma.crmWorkspaceBranding.create
		).not.toHaveBeenCalled();
	});
	it('revalidates local workspace lifecycle and current CRM role inside the transaction', async () => {
		for (const role of ['OWNER', 'CRM_ADMIN']) {
			const current = setup(role);
			current.prisma.crmWorkspaceAccess.findUnique.mockResolvedValueOnce({
				lifecycle: 'READ_ONLY',
				onboardingCompletedAt: new Date()
			} as never);
			await expect(
				current.service.update(token, current.command())
			).rejects.toBeInstanceOf(ForbiddenException);
			if (role === 'CRM_ADMIN') {
				current.prisma.crmWorkspaceMember.findUnique.mockResolvedValueOnce(
					{ role, disabledAt: new Date() } as never
				);
				await expect(
					current.service.update(token, current.command())
				).rejects.toBeInstanceOf(ForbiddenException);
			}
			expect(
				current.prisma.crmWorkspaceBranding.create
			).not.toHaveBeenCalled();
		}
	});
	it('renews authority on a bounded retry and reports stale SQL CAS without overwriting', async () => {
		const current = setup();
		current.prisma.crmWorkspaceBranding.findUnique.mockRejectedValueOnce(
			new Prisma.PrismaClientKnownRequestError('serialization', {
				code: 'P2034',
				clientVersion: 'test'
			})
		);
		await current.service.update(token, current.command());
		expect(current.auth.authorize).toHaveBeenCalledTimes(3);
		current.prisma.crmWorkspaceBranding.update.mockRejectedValueOnce(
			new Prisma.PrismaClientKnownRequestError('CAS', {
				code: 'P2025',
				clientVersion: 'test'
			})
		);
		await expect(
			current.service.update(
				token,
				current.command({ expectedVersion: 1 })
			)
		).rejects.toMatchObject({
			response: { code: 'crm_branding_version_conflict' }
		});
	});
	it('reads only the authorized workspace and blocks unknown roles/lifecycle', async () => {
		const current = setup();
		current.auth.authorize.mockResolvedValueOnce({
			...current.actor,
			workspaceId: randomUUID()
		});
		await expect(
			current.service.get(token, { workspaceId })
		).rejects.toBeInstanceOf(ForbiddenException);
		expect(
			current.prisma.crmWorkspaceBranding.findUnique
		).not.toHaveBeenCalled();
		current.prisma.crmWorkspaceAccess.findUnique.mockResolvedValueOnce(
			null as never
		);
		await expect(
			current.service.get(token, { workspaceId })
		).rejects.toBeInstanceOf(ForbiddenException);
	});
});

describe('workspace display name normalization', () => {
	it.each([null, '', ' ', '\u00a0'])('clears %j', input => {
		expect(normalizeWorkspaceDisplayName(input)).toBeNull();
	});
	it('counts Unicode codepoints after normalization, not UTF-16 units', () => {
		expect(normalizeWorkspaceDisplayName('😀'.repeat(40))).toBe(
			'😀'.repeat(40)
		);
		expect(normalizeWorkspaceDisplayName('e\u0301'.repeat(40))).toBe(
			'é'.repeat(40)
		);
		expect(() => normalizeWorkspaceDisplayName('😀'.repeat(41))).toThrow(
			BadRequestException
		);
	});
	it.each([
		undefined,
		12,
		{},
		[],
		'<brand>',
		'a>b',
		'\nBrand',
		'a\tb',
		'a\u0000b',
		'a\u007fb',
		'a\u0085b',
		'\u202eBrand',
		'a\u200db',
		'\ufeffBrand',
		'\u2028Brand',
		'\u2029Brand',
		'\ud800',
		'x'.repeat(41)
	])(
		'rejects invalid/multiline/HTML/control input %j without echoing it',
		input => {
			expect(() => normalizeWorkspaceDisplayName(input)).toThrow(
				BadRequestException
			);
		}
	);
});

describe('workspace branding public HTTP boundary', () => {
	let app: INestApplication;
	let origin: string;
	let current: ReturnType<typeof setup>;
	beforeAll(async () => {
		current = setup();
		const module = await Test.createTestingModule({
			controllers: [CrmWorkspaceBrandingController],
			providers: [
				{ provide: CrmWorkspaceBrandingService, useValue: current.service }
			]
		}).compile();
		app = module.createNestApplication({ logger: false });
		app.setGlobalPrefix('api/v1');
		app.useGlobalPipes(
			new ValidationPipe({
				whitelist: true,
				forbidNonWhitelisted: true,
				forbidUnknownValues: true,
				transform: true
			})
		);
		app.useGlobalFilters(new CrmAccessHttpExceptionFilter());
		await app.listen(0, '127.0.0.1');
		origin = await app.getUrl();
	});
	afterAll(async () => {
		await app?.close();
	});
	const post = (body: unknown, key?: string) =>
		fetch(`${origin}/api/v1/crm/access/workspace/branding`, {
			method: 'POST',
			headers: {
				authorization: token,
				'content-type': 'application/json',
				...(key ? { 'idempotency-key': key } : {})
			},
			body: JSON.stringify(body)
		});
	it('requires authentication and emits no-store actor-bound GET/POST responses', async () => {
		const path = `${origin}/api/v1/crm/access/workspace/branding?workspaceId=${workspaceId}`;
		expect((await fetch(path)).status).toBe(401);
		const initial = await fetch(path, {
			headers: { authorization: token }
		});
		expect(initial.status).toBe(200);
		expect(initial.headers.get('cache-control')).toBe('no-store');
		expect(await initial.json()).toMatchObject({
			workspaceId,
			subject: current.actor.subject,
			branding: { version: 0 }
		});
		const dto = current.command({ displayName: '😀'.repeat(40) });
		const saved = await post(dto, dto.commandId);
		expect(saved.status).toBe(200);
		expect(saved.headers.get('cache-control')).toBe('no-store');
		const result = await saved.json();
		expect(result).toMatchObject({
			commandId: dto.commandId,
			subject: current.actor.subject,
			branding: { version: 1, displayName: dto.displayName }
		});
		expect(await (await post(dto, dto.commandId)).json()).toEqual(result);
		expect(
			(await post({ ...dto, displayName: 'changed' }, dto.commandId))
				.status
		).toBe(409);
		const other = current.command({
			expectedActorSubject: 'different-actor',
			expectedVersion: 1
		});
		expect((await post(other, other.commandId)).status).toBe(403);
	});
	it('rejects unknown query fields, malformed UUIDs, header mismatch and invalid DTO values', async () => {
		for (const query of [
			`workspaceId=${workspaceId}&subject=foreign`,
			'workspaceId=bad'
		])
			expect(
				(
					await fetch(
						`${origin}/api/v1/crm/access/workspace/branding?${query}`,
						{ headers: { authorization: token } }
					)
				).status
			).toBe(400);
		const dto = current.command({ expectedVersion: 1 });
		for (const body of [
			{ ...dto, subject: 'foreign' },
			{ ...dto, displayName: 42 },
			{ ...dto, displayName: undefined },
			{ ...dto, displayName: 'x'.repeat(41) },
			{ ...dto, displayName: '\nBrand' },
			{ ...dto, expectedVersion: '1' },
			{ ...dto, expectedVersion: -1 },
			{ ...dto, expectedVersion: 2147483647 },
			{ ...dto, expectedVersion: 1.5 },
			{ ...dto, schemaVersion: 2 },
			{ ...dto, commandId: 'bad' },
			{ ...dto, expectedActorSubject: undefined }
		])
			expect((await post(body, body.commandId)).status).toBe(400);
		expect((await post(dto)).status).toBe(400);
		expect((await post(dto, randomUUID())).status).toBe(400);
		expect(
			current.prisma.crmTeamCommandReceipt.create
		).toHaveBeenCalledTimes(1);
	});
});
