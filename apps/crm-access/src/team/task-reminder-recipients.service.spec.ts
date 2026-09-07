import {
	ForbiddenException,
	ServiceUnavailableException
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { TaskReminderRecipientsController } from './task-reminder-recipients.controller';
import {
	parseTaskReminderRecipients,
	TaskReminderRecipientsService,
	type TaskReminderRecipientsRequest
} from './task-reminder-recipients.service';

describe('private current task reminder recipients', () => {
	const workspaceId = randomUUID(),
		memberId = randomUUID(),
		teamId = randomUUID();
	const request = (): TaskReminderRecipientsRequest => ({
		schemaVersion: 1,
		workspaceId,
		ruleOwnerBinding: { subject: 'owner', membershipId: null },
		scope: 'WORKSPACE',
		task: {
			id: randomUUID(),
			assignedToSubject: 'member',
			assignedToMembershipId: memberId,
			teamId: null,
			deal: null
		},
		recipients: { kind: 'ASSIGNEE' },
		recipientBinding: null,
		cursor: null
	});
	const setup = () => {
		const row = {
			id: randomUUID(),
			subject: 'member',
			membershipId: memberId,
			role: 'MANAGER',
			teams: [] as { teamId: string }[]
		};
		const access = {
			workspaceId,
			subject: 'owner',
			membershipId: randomUUID(),
			role: 'OWNER',
			state: 'ACTIVE',
			permissions: ['sales:read'],
			teamIds: []
		};
		const authorization = {
			assignmentSubject: jest.fn().mockImplementation(async () => access)
		};
		const prisma = {
			crmWorkspaceMember: {
				findMany: jest.fn().mockImplementation(async () => [row])
			}
		};
		const identity = {
			reminderDirectory: jest.fn().mockResolvedValue([
				{
					membershipId: memberId,
					subject: 'member',
					workspaceRole: 'MEMBER',
					email: 'member@example.test',
					telegramChatId: '12345'
				}
			])
		};
		return {
			row,
			access,
			authorization,
			prisma,
			identity,
			service: new TaskReminderRecipientsService(
				authorization as never,
				prisma as never,
				identity as never
			)
		};
	};
	it('returns only current matching assignee and rechecks both service owners', async () => {
		const fixture = setup();
		const result = await fixture.service.recipients(request());
		expect(result).toMatchObject({
			allowed: true,
			nextCursor: null,
			items: [{ binding: { subject: 'member', membershipId: memberId } }]
		});
		expect(fixture.authorization.assignmentSubject).toHaveBeenCalledTimes(
			2
		);
		expect(fixture.identity.reminderDirectory).toHaveBeenCalledTimes(2);
		expect(
			fixture.prisma.crmWorkspaceMember.findMany
		).toHaveBeenCalledTimes(2);
	});
	it.each(['READ_ONLY', 'DISABLED'])(
		'never delivers when workspace is %s',
		async state => {
			const fixture = setup();
			fixture.access.state = state;
			expect(await fixture.service.recipients(request())).toMatchObject({
				allowed: false,
				items: [],
				nextCursor: null
			});
			expect(fixture.identity.reminderDirectory).not.toHaveBeenCalled();
		}
	);
	it('does not confuse a task assignee with visibility of its linked deal', async () => {
		const fixture = setup(),
			input = request();
		input.task.deal = { assignedToSubject: 'another-manager', teamId };
		expect((await fixture.service.recipients(input)).items).toEqual([]);
		fixture.row.role = 'TEAM_LEAD';
		fixture.row.teams = [{ teamId }];
		expect((await fixture.service.recipients(input)).items).toHaveLength(
			1
		);
	});
	it('rejects revoked or replaced task-assignee membership and ANALYST recipients', async () => {
		const fixture = setup(),
			input = request();
		input.task.assignedToMembershipId = randomUUID();
		expect((await fixture.service.recipients(input)).items).toEqual([]);
		fixture.row.role = 'ANALYST';
		expect((await fixture.service.recipients(request())).items).toEqual(
			[]
		);
	});
	it('does not turn an outage into a successful empty recipient list', async () => {
		const fixture = setup();
		fixture.identity.reminderDirectory.mockRejectedValueOnce(
			new ServiceUnavailableException()
		);
		await expect(
			fixture.service.recipients(request())
		).rejects.toBeInstanceOf(ServiceUnavailableException);
	});
	it('rejects authority/channel drift and forbids an old workspace-rule author', async () => {
		const fixture = setup();
		fixture.identity.reminderDirectory.mockResolvedValueOnce([]);
		await expect(
			fixture.service.recipients(request())
		).rejects.toBeInstanceOf(ServiceUnavailableException);
		fixture.authorization.assignmentSubject.mockRejectedValueOnce(
			new ForbiddenException()
		);
		expect((await fixture.service.recipients(request())).allowed).toBe(
			false
		);
	});
	it('preserves exact recipient verification within its original selector', async () => {
		const fixture = setup(),
			input = request();
		input.recipients = {
			kind: 'SELECTED',
			bindings: [{ subject: 'another', membershipId: randomUUID() }]
		};
		input.recipientBinding = { subject: 'member', membershipId: memberId };
		expect((await fixture.service.recipients(input)).items).toEqual([]);
	});
	it('validates the private contract and rejects foreign callers', () => {
		const input = request();
		expect(parseTaskReminderRecipients(input)).toBe(input);
		for (const value of [
			{ ...input, unknown: true },
			{ ...input, cursor: 'not-uuid' },
			{ ...input, scope: 'PERSONAL' },
			{
				...input,
				recipientBinding: input.ruleOwnerBinding,
				cursor: randomUUID()
			},
			{ ...input, task: { ...input.task, deal: {} } }
		])
			expect(() => parseTaskReminderRecipients(value)).toThrow();
		const service = { recipients: jest.fn() },
			controller = new TaskReminderRecipientsController(service as never);
		expect(() => controller.recipients('crm-intake', input)).toThrow(
			ForbiddenException
		);
		expect(service.recipients).not.toHaveBeenCalled();
	});
});
