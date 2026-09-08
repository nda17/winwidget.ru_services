import {
	BadRequestException,
	ForbiddenException,
	ServiceUnavailableException,
	RequestMethod,
	type INestApplication
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { randomUUID, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { CrmAuthorizationService } from '../authorization/crm-authorization.service';
import {
	CRM_CALLERS,
	CrmInternalGuard
} from '../authorization/crm-internal.guard';
import { TaskSeriesAuthorityController } from './task-series-authority.controller';
import {
	parseTaskSeriesAuthority,
	TaskSeriesAuthorityService,
	type TaskSeriesAuthorityRequest
} from './task-series-authority.service';

type Authority = Awaited<
	ReturnType<CrmAuthorizationService['assignmentSubject']>
>;
const workspaceId = randomUUID(),
	teamId = randomUUID(),
	foreignTeam = randomUUID();
const request = (): TaskSeriesAuthorityRequest => ({
	schemaVersion: 1,
	workspaceId,
	seriesId: randomUUID(),
	creatorBinding: { subject: 'owner', membershipId: null },
	assigneeBinding: {
		subject: 'member',
		membershipId: '22222222-2222-4222-8222-222222222222'
	},
	template: { teamId: null, deal: null }
});
function setup() {
	const creator: Authority = {
		schemaVersion: 1,
		workspaceId,
		subject: 'owner',
		membershipId: randomUUID(),
		role: 'OWNER',
		state: 'ACTIVE',
		dataScope: 'ALL',
		teamIds: [teamId],
		permissions: ['sales:read', 'sales:write']
	};
	const assignee: Authority = {
		...creator,
		subject: 'member',
		membershipId: request().assigneeBinding.membershipId!,
		role: 'MANAGER',
		dataScope: 'OWN'
	};
	const authorization = {
		assignmentSubject: jest.fn(
			async (_workspace: string, subject: string) =>
				structuredClone(subject === creator.subject ? creator : assignee)
		)
	};
	const prisma = {
		crmWorkspaceMember: {
			findFirst: jest.fn().mockResolvedValue({ id: randomUUID() })
		}
	};
	return {
		creator,
		assignee,
		authorization,
		prisma,
		service: new TaskSeriesAuthorityService(
			authorization as never,
			prisma as never
		)
	};
}

describe('fresh recurring task creation authority', () => {
	it.each(['ACTIVE', 'GRACE'] as const)(
		'allows %s with exact response and two fresh reads of both bindings',
		async state => {
			const f = setup(),
				input = request();
			f.creator.state = state;
			f.assignee.state = state;
			expect(await f.service.authorize(input)).toEqual({
				schemaVersion: 1,
				workspaceId,
				seriesId: input.seriesId,
				allowed: true,
				reason: null
			});
			expect(f.authorization.assignmentSubject).toHaveBeenCalledTimes(4);
			expect(f.authorization.assignmentSubject).toHaveBeenCalledWith(
				workspaceId,
				'owner'
			);
			expect(f.authorization.assignmentSubject).toHaveBeenCalledWith(
				workspaceId,
				'member'
			);
		}
	);
	it('accepts current OWNER with null or exact Identity membership and no CRM member row', async () => {
		const f = setup(),
			input = request();
		input.assigneeBinding = { ...input.creatorBinding };
		expect((await f.service.authorize(input)).allowed).toBe(true);
		input.creatorBinding.membershipId = f.creator.membershipId;
		input.assigneeBinding.membershipId = f.creator.membershipId;
		expect((await f.service.authorize(input)).allowed).toBe(true);
		input.creatorBinding.membershipId = randomUUID();
		expect((await f.service.authorize(input)).reason).toBe(
			'CREATOR_REVOKED'
		);
		expect(f.prisma.crmWorkspaceMember.findFirst).not.toHaveBeenCalled();
	});
	it.each(['creator', 'assignee'] as const)(
		'rejects stale or legacy-null %s binding',
		async key => {
			for (const membershipId of [null, randomUUID()]) {
				const f = setup(),
					input = request();
				f.creator.role = 'CRM_ADMIN';
				input.creatorBinding.membershipId = f.creator.membershipId;
				input[`${key}Binding`].membershipId = membershipId;
				expect((await f.service.authorize(input)).reason).toBe(
					key === 'creator' ? 'CREATOR_REVOKED' : 'ASSIGNEE_REVOKED'
				);
			}
		}
	);
	it.each(['creator', 'assignee'] as const)(
		'reports READ_ONLY for %s without creating any task',
		async key => {
			const f = setup();
			f[key].state = 'READ_ONLY';
			f[key].permissions = ['sales:read'];
			expect((await f.service.authorize(request())).reason).toBe(
				'READ_ONLY'
			);
		}
	);
	it.each(['creator', 'assignee'] as const)(
		'rejects %s ANALYST or loss of sales:write',
		async key => {
			const f = setup(),
				input = request();
			input.creatorBinding.membershipId = f.creator.membershipId;
			f[key].role = 'ANALYST';
			f[key].permissions = ['sales:analytics'];
			expect((await f.service.authorize(input)).reason).toBe(
				'SCOPE_CHANGED'
			);
		}
	);
	it('does not allow an OWN creator to assign another employee but permits self', async () => {
		const f = setup(),
			input = request();
		f.creator.role = 'MANAGER';
		f.creator.dataScope = 'OWN';
		input.creatorBinding.membershipId = f.creator.membershipId;
		expect((await f.service.authorize(input)).reason).toBe(
			'SCOPE_CHANGED'
		);
		input.assigneeBinding = { ...input.creatorBinding };
		expect((await f.service.authorize(input)).allowed).toBe(true);
	});
	it('limits TEAM standalone assignments to an active shared department, including actual CRM_ADMIN membership', async () => {
		const f = setup(),
			input = request();
		f.creator.role = 'TEAM_LEAD';
		f.creator.dataScope = 'TEAM';
		input.creatorBinding.membershipId = f.creator.membershipId;
		expect((await f.service.authorize(input)).reason).toBe(
			'SCOPE_CHANGED'
		);
		input.template.teamId = teamId;
		expect((await f.service.authorize(input)).allowed).toBe(true);
		expect(f.prisma.crmWorkspaceMember.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					workspaceId,
					disabledAt: null,
					teams: {
						some: { teamId: { in: [teamId] }, team: { archivedAt: null } }
					}
				})
			})
		);
		f.assignee.role = 'CRM_ADMIN';
		f.assignee.dataScope = 'ALL';
		f.assignee.teamIds = [teamId, foreignTeam];
		f.prisma.crmWorkspaceMember.findFirst.mockResolvedValue(null);
		expect((await f.service.authorize(input)).reason).toBe(
			'SCOPE_CHANGED'
		);
	});
	it('rejects removed/foreign teams and an assignee outside the chosen team', async () => {
		const f = setup(),
			input = request();
		input.template.teamId = foreignTeam;
		expect((await f.service.authorize(input)).reason).toBe(
			'SCOPE_CHANGED'
		);
		input.template.teamId = teamId;
		f.assignee.teamIds = [];
		expect((await f.service.authorize(input)).reason).toBe(
			'SCOPE_CHANGED'
		);
	});
	it('requires both creator and assignee to see a linked deal, not merely the task assignment', async () => {
		const f = setup(),
			input = request();
		input.template = {
			teamId,
			deal: { id: randomUUID(), assignedToSubject: 'unrelated', teamId }
		};
		expect((await f.service.authorize(input)).reason).toBe(
			'SCOPE_CHANGED'
		);
		input.template.deal!.assignedToSubject = f.assignee.subject;
		expect((await f.service.authorize(input)).allowed).toBe(true);
		f.creator.role = 'MANAGER';
		f.creator.dataScope = 'OWN';
		input.creatorBinding.membershipId = f.creator.membershipId;
		input.assigneeBinding = { ...input.creatorBinding };
		expect((await f.service.authorize(input)).reason).toBe(
			'SCOPE_CHANGED'
		);
		input.template.deal!.assignedToSubject = f.creator.subject;
		expect((await f.service.authorize(input)).allowed).toBe(true);
		input.template.deal!.teamId = foreignTeam;
		expect((await f.service.authorize(input)).reason).toBe(
			'SCOPE_CHANGED'
		);
	});
	it('allows a TEAM_LEAD assignee only when the linked deal belongs to their current scope', async () => {
		const f = setup(),
			input = request();
		f.assignee.role = 'TEAM_LEAD';
		f.assignee.dataScope = 'TEAM';
		input.template = {
			teamId,
			deal: { id: randomUUID(), assignedToSubject: 'unrelated', teamId }
		};
		expect((await f.service.authorize(input)).allowed).toBe(true);
		f.assignee.teamIds = [foreignTeam];
		expect((await f.service.authorize(input)).reason).toBe(
			'SCOPE_CHANGED'
		);
	});
	it('rejects binding replacement or revocation during the second authority read', async () => {
		const f = setup();
		f.authorization.assignmentSubject.mockImplementation(
			async (_workspace, subject) => {
				if (
					f.authorization.assignmentSubject.mock.calls.length > 2 &&
					subject === 'member'
				)
					throw new ForbiddenException();
				return structuredClone(
					subject === 'owner' ? f.creator : f.assignee
				);
			}
		);
		expect((await f.service.authorize(request())).reason).toBe(
			'ASSIGNEE_REVOKED'
		);
	});
	it('fails closed on a changed scope even if both snapshots separately permit creation', async () => {
		const f = setup();
		f.authorization.assignmentSubject.mockImplementation(
			async (_workspace, subject) => {
				const value = structuredClone(
					subject === 'owner' ? f.creator : f.assignee
				);
				if (f.authorization.assignmentSubject.mock.calls.length > 2)
					value.teamIds = [...value.teamIds, foreignTeam];
				return value;
			}
		);
		expect((await f.service.authorize(request())).reason).toBe(
			'SCOPE_CHANGED'
		);
	});
	it.each([
		new Error('private database credential marker'),
		new ServiceUnavailableException('private upstream marker')
	])(
		'returns a sanitized retryable failure on owner outage',
		async error => {
			const f = setup();
			f.authorization.assignmentSubject.mockRejectedValueOnce(error);
			await expect(f.service.authorize(request())).rejects.toEqual(
				new ServiceUnavailableException(
					'Task series authority is temporarily unavailable'
				)
			);
		}
	);
	it('rejects malformed/extra fields at every level without accepting a reusable scope claim', () => {
		const input = request();
		expect(parseTaskSeriesAuthority(input)).toBe(input);
		for (const malformed of [
			null,
			{ ...input, scope: 'ALL' },
			{ ...input, schemaVersion: 2 },
			{ ...input, workspaceId: 'bad' },
			{ ...input, seriesId: 'bad' },
			{ ...input, creatorBinding: { subject: 'owner' } },
			{
				...input,
				assigneeBinding: { ...input.assigneeBinding, membershipId: 'bad' }
			},
			{
				...input,
				creatorBinding: {
					...input.creatorBinding,
					subject: 'contains space'
				}
			},
			{ ...input, template: { ...input.template, extra: true } },
			{
				...input,
				template: {
					teamId: null,
					deal: {
						id: randomUUID(),
						assignedToSubject: 'x',
						teamId: null,
						archivedAt: null
					}
				}
			}
		])
			expect(() => parseTaskSeriesAuthority(malformed)).toThrow(
				BadRequestException
			);
	});
});

describe('task series authority internal HTTP contract', () => {
	let app: INestApplication, url: string;
	const service = { authorize: jest.fn() };
	const credentials = Object.fromEntries(
		Object.keys(CRM_CALLERS).map(caller => [
			caller,
			randomBytes(48).toString('base64url')
		])
	);
	const values = Object.fromEntries(
		Object.entries(CRM_CALLERS).map(([caller, name]) => [
			name,
			credentials[caller]
		])
	);
	beforeAll(async () => {
		const module = await Test.createTestingModule({
			controllers: [TaskSeriesAuthorityController],
			providers: [
				CrmInternalGuard,
				{
					provide: ConfigService,
					useValue: { get: (name: string) => values[name] }
				},
				{ provide: TaskSeriesAuthorityService, useValue: service }
			]
		}).compile();
		app = module.createNestApplication({ logger: false });
		app.setGlobalPrefix('api/v1', {
			exclude: [
				{
					path: 'internal/v1/crm-access/task-series-authority',
					method: RequestMethod.POST
				}
			]
		});
		await app.listen(0, '127.0.0.1');
		url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/internal/v1/crm-access/task-series-authority`;
	});
	afterAll(async () => {
		if (app) await app.close();
	});
	beforeEach(() => jest.clearAllMocks());
	const send = (
		body: unknown,
		caller = 'crm-sales',
		token = credentials[caller]
	) =>
		fetch(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'x-winwidget-service': caller,
				'x-winwidget-internal-token': token
			},
			body: JSON.stringify(body)
		});
	it('uses existing Sales credentials, no bearer and 200 no-store for allowed or denied results', async () => {
		for (const reason of [null, 'READ_ONLY']) {
			const input = request(),
				result = {
					schemaVersion: 1,
					workspaceId,
					seriesId: input.seriesId,
					allowed: reason === null,
					reason
				};
			service.authorize.mockResolvedValueOnce(result);
			const response = await send(input);
			expect(response.status).toBe(200);
			expect(response.headers.get('cache-control')).toBe('no-store');
			expect(await response.json()).toEqual(result);
		}
	});
	it('rejects other authenticated CRM services, absent/wrong token and malformed body before business authority', async () => {
		for (const caller of ['crm-intake', 'crm-customers'])
			expect((await send(request(), caller)).status).toBe(403);
		expect((await send(request(), 'crm-sales', '')).status).toBe(403);
		expect(
			(await send(request(), 'crm-sales', credentials['crm-customers']))
				.status
		).toBe(403);
		expect((await send({ ...request(), extra: true })).status).toBe(400);
		expect(service.authorize).not.toHaveBeenCalled();
	});
	it('returns 503 on owner outage and has no public api/v1 alias', async () => {
		service.authorize.mockRejectedValueOnce(
			new ServiceUnavailableException(
				'Task series authority is temporarily unavailable'
			)
		);
		expect((await send(request())).status).toBe(503);
		const response = await fetch(
			url.replace('/internal/v1/', '/api/v1/internal/v1/'),
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(request())
			}
		);
		expect(response.status).toBe(404);
	});
});
