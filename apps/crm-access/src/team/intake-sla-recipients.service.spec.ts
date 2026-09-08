import {
	BadRequestException,
	ForbiddenException,
	ServiceUnavailableException
} from '@nestjs/common';
import {
	IntakeSlaRecipientsService,
	parseIntakeSlaRecipients,
	type IntakeSlaRecipientsRequest
} from './intake-sla-recipients.service';
import { IntakeSlaAuthorityService } from './intake-sla-authority.service';

const uuid = (index: number) =>
	`00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const workspaceId = uuid(1),
	membershipId = uuid(2),
	teamId = uuid(3);
const request = (): IntakeSlaRecipientsRequest => ({
	schemaVersion: 1,
	purpose: 'INTAKE_SLA',
	workspaceId,
	ruleOwnerBinding: { subject: 'owner', membershipId: null },
	entry: { id: uuid(4), createdBySubject: 'member', teamId },
	responsibleBinding: { subject: 'member', membershipId },
	notifyManagers: false,
	recipientBinding: null,
	cursor: null
});
const member = (index = 10, role = 'MANAGER') => ({
	id: uuid(index),
	workspaceId,
	subject: index === 10 ? 'member' : `member-${index}`,
	membershipId: index === 10 ? membershipId : uuid(index + 1000),
	role,
	disabledAt: null as Date | null,
	teams: [{ teamId }]
});
const directoryMember = (row: ReturnType<typeof member>) => ({
	subject: row.subject,
	membershipId: row.membershipId,
	workspaceRole: 'MEMBER',
	email: 'verified@example.test' as string | null,
	telegramChatId: '12345' as string | null
});
const setup = () => {
	const access = {
		subject: 'owner',
		membershipId: uuid(5),
		role: 'OWNER',
		state: 'ACTIVE',
		permissions: ['intake:read', 'intake:write']
	};
	const authorization = {
		assignmentSubject: jest
			.fn()
			.mockImplementation(async () => structuredClone(access))
	};
	const state = {
		rows: [member()],
		directory: [
			directoryMember(member()),
			{
				subject: 'owner',
				membershipId: uuid(5),
				workspaceRole: 'OWNER',
				email: 'owner@example.test',
				telegramChatId: null
			}
		]
	};
	type Filter = {
		where: {
			id?: { gt?: string; in?: string[] };
			OR?: { subject: string; membershipId: string }[];
		};
		take?: number;
	};
	const prisma = {
		crmWorkspaceMember: {
			findMany: jest
				.fn()
				.mockImplementation(async ({ where, take }: Filter) =>
					structuredClone(
						state.rows
							.filter(
								row =>
									row.disabledAt === null &&
									(!where.id?.gt || row.id > where.id.gt) &&
									(!where.id?.in || where.id.in.includes(row.id)) &&
									(!where.OR ||
										where.OR.some(
											binding =>
												binding.subject === row.subject &&
												binding.membershipId === row.membershipId
										))
							)
							.slice(0, take)
					)
				)
		}
	};
	const identity = {
		reminderDirectory: jest
			.fn()
			.mockImplementation(
				async (
					_workspace: string,
					expected: { subject: string; membershipId: string }[],
					includeOwner: boolean
				) =>
					structuredClone(
						state.directory.filter(
							item =>
								(includeOwner && item.workspaceRole === 'OWNER') ||
								expected.some(
									binding =>
										binding.subject === item.subject &&
										binding.membershipId === item.membershipId
								)
						)
					)
			)
	};
	return {
		access,
		authorization,
		state,
		prisma,
		identity,
		service: new IntakeSlaRecipientsService(
			new IntakeSlaAuthorityService(authorization as never),
			prisma as never,
			identity as never
		)
	};
};

describe('Intake SLA current recipient authority', () => {
	it('accepts only exact INTAKE_SLA purpose, scoped bindings and exclusive page/recipient mode', () => {
		const input = request();
		expect(parseIntakeSlaRecipients(input)).toBe(input);
		for (const patch of [
			{ purpose: 'TASK_REMINDER' },
			{ schemaVersion: 2 },
			{ unknown: true },
			{ workspaceId: 'invalid' },
			{ cursor: 'invalid' },
			{ entry: { ...input.entry, assignedToSubject: 'member' } },
			{ entry: { ...input.entry, teamId: 'invalid' } },
			{ ruleOwnerBinding: { subject: 'with space', membershipId: null } },
			{
				responsibleBinding: { subject: 'member', membershipId: 'invalid' }
			},
			{ recipientBinding: input.responsibleBinding, cursor: uuid(9) }
		])
			expect(() =>
				parseIntakeSlaRecipients({ ...input, ...patch })
			).toThrow(BadRequestException);
	});
	it('allows OWNER and CRM_ADMIN managers across entry teams and normalizes only the verified owner binding', async () => {
		const fixture = setup(),
			input = request();
		fixture.state.rows[0].role = 'CRM_ADMIN';
		input.entry = {
			...input.entry,
			createdBySubject: 'another',
			teamId: uuid(9)
		};
		input.responsibleBinding = null;
		input.notifyManagers = true;
		const result = await fixture.service.recipients(input);
		expect(result).toEqual({
			schemaVersion: 1,
			workspaceId,
			allowed: true,
			items: [
				{
					binding: { subject: 'member', membershipId },
					email: 'verified@example.test',
					telegramChatId: '12345'
				},
				{
					binding: { subject: 'owner', membershipId: null },
					email: 'owner@example.test',
					telegramChatId: null
				}
			],
			nextCursor: null
		});
		expect(fixture.authorization.assignmentSubject).toHaveBeenCalledTimes(
			2
		);
	});
	it('automatically notifies TEAM_LEAD only for a currently matching active team', async () => {
		const fixture = setup(),
			input = request();
		fixture.state.rows[0].role = 'TEAM_LEAD';
		input.entry.createdBySubject = 'another';
		input.responsibleBinding = null;
		input.notifyManagers = true;
		expect(
			(await fixture.service.recipients(input)).items.map(
				item => item.binding.subject
			)
		).toContain('member');
		for (const team of [uuid(9), null]) {
			input.entry.teamId = team;
			expect(
				(await fixture.service.recipients(input)).items.map(
					item => item.binding.subject
				)
			).not.toContain('member');
		}
	});
	it('does not let responsible metadata expand OWN/TEAM or override ANALYST exclusion or the original selector', async () => {
		const fixture = setup(),
			input = request();
		input.entry = {
			...input.entry,
			createdBySubject: 'another',
			teamId: uuid(9)
		};
		for (const role of ['MANAGER', 'TEAM_LEAD', 'ANALYST']) {
			fixture.state.rows[0].role = role;
			expect((await fixture.service.recipients(input)).items).toEqual([]);
		}
		// Existing Inbox TEAM scope includes creator-owned entries as well as team entries.
		input.entry.createdBySubject = 'member';
		for (const role of ['MANAGER', 'TEAM_LEAD']) {
			fixture.state.rows[0].role = role;
			expect((await fixture.service.recipients(input)).items).toHaveLength(
				1
			);
		}
		input.recipientBinding = input.responsibleBinding;
		input.responsibleBinding = {
			subject: 'someone-else',
			membershipId: uuid(9)
		};
		expect((await fixture.service.recipients(input)).items).toEqual([]);
	});
	it('denies disabled and READ_ONLY rule owners before any directory or member lookup', async () => {
		for (const state of ['READ_ONLY', 'DISABLED', 'REVOKED']) {
			const fixture = setup();
			if (state === 'REVOKED')
				fixture.authorization.assignmentSubject.mockRejectedValue(
					new ForbiddenException()
				);
			else fixture.access.state = state;
			expect(await fixture.service.recipients(request())).toEqual({
				schemaVersion: 1,
				workspaceId,
				allowed: false,
				items: [],
				nextCursor: null
			});
			expect(fixture.identity.reminderDirectory).not.toHaveBeenCalled();
			expect(
				fixture.prisma.crmWorkspaceMember.findMany
			).not.toHaveBeenCalled();
		}
	});
	it('does not reuse a reinvited rule owner or recipient membership and excludes disabled recipients', async () => {
		const fixture = setup(),
			input = request();
		fixture.access.role = 'CRM_ADMIN';
		input.ruleOwnerBinding.membershipId = uuid(9);
		expect((await fixture.service.recipients(input)).allowed).toBe(false);
		fixture.access.role = 'OWNER';
		fixture.state.rows[0].membershipId = uuid(9);
		fixture.state.directory[0].membershipId = uuid(9);
		expect((await fixture.service.recipients(request())).items).toEqual(
			[]
		);
		fixture.state.rows[0].membershipId = membershipId;
		fixture.state.directory[0].membershipId = membershipId;
		fixture.state.rows[0].disabledAt = new Date();
		expect((await fixture.service.recipients(request())).items).toEqual(
			[]
		);
	});
	it('returns only verified directory channels and invents none when missing or unverified', async () => {
		const fixture = setup();
		fixture.state.directory[0].email = null;
		fixture.state.directory[0].telegramChatId = null;
		expect((await fixture.service.recipients(request())).items).toEqual([
			{
				binding: { subject: 'member', membershipId },
				email: null,
				telegramChatId: null
			}
		]);
		expect(fixture.identity.reminderDirectory).toHaveBeenCalledWith(
			workspaceId,
			[{ subject: 'member', membershipId }],
			false
		);
		expect(fixture.identity.reminderDirectory).toHaveBeenCalledTimes(2);
		fixture.state.directory = [];
		expect((await fixture.service.recipients(request())).items).toEqual(
			[]
		);
	});
	it('uses bounded stable pages, returns a cursor and never re-includes owner on later pages', async () => {
		const fixture = setup(),
			input = request();
		fixture.state.rows = Array.from({ length: 101 }, (_, index) =>
			member(100 + index, 'CRM_ADMIN')
		);
		fixture.state.directory = [
			...fixture.state.rows.map(directoryMember),
			fixture.state.directory[1]
		];
		input.notifyManagers = true;
		input.responsibleBinding = null;
		const first = await fixture.service.recipients(input);
		expect(first.items).toHaveLength(100);
		expect(first.nextCursor).toBe(fixture.state.rows[98].id);
		expect(
			fixture.prisma.crmWorkspaceMember.findMany
		).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				where: { workspaceId, disabledAt: null },
				orderBy: { id: 'asc' },
				take: 100
			})
		);
		const last = await fixture.service.recipients({
			...input,
			cursor: first.nextCursor
		});
		expect(last.items).toHaveLength(2);
		expect(last.nextCursor).toBeNull();
		expect(
			last.items.some(item => item.binding.membershipId === null)
		).toBe(false);
		expect(
			fixture.prisma.crmWorkspaceMember.findMany
		).toHaveBeenNthCalledWith(
			3,
			expect.objectContaining({
				where: {
					workspaceId,
					disabledAt: null,
					id: { gt: first.nextCursor }
				},
				take: 101
			})
		);
		expect(fixture.identity.reminderDirectory.mock.calls[2][2]).toBe(
			false
		);
	});
	it('requires retry after fresh local membership, teams or verified directory channels drift', async () => {
		for (const drift of ['membership', 'teams', 'directory']) {
			const fixture = setup();
			if (drift === 'directory')
				fixture.identity.reminderDirectory.mockResolvedValueOnce([
					{ ...fixture.state.directory[0], email: 'previous@example.test' }
				]);
			else
				fixture.prisma.crmWorkspaceMember.findMany.mockResolvedValueOnce([
					{
						...fixture.state.rows[0],
						...(drift === 'membership'
							? { membershipId: uuid(9) }
							: { teams: [{ teamId: uuid(9) }] })
					}
				]);
			await expect(fixture.service.recipients(request())).rejects.toThrow(
				ServiceUnavailableException
			);
		}
	});
	it('fails closed on final owner revocation and preserves dependency outages for retry', async () => {
		const fixture = setup();
		fixture.authorization.assignmentSubject
			.mockResolvedValueOnce(fixture.access)
			.mockRejectedValueOnce(new ForbiddenException());
		expect(await fixture.service.recipients(request())).toMatchObject({
			allowed: false,
			items: []
		});
		const unavailable = setup();
		unavailable.identity.reminderDirectory.mockRejectedValueOnce(
			new ServiceUnavailableException()
		);
		await expect(
			unavailable.service.recipients(request())
		).rejects.toThrow(ServiceUnavailableException);
	});
});
