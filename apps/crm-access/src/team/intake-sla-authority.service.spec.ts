import {
	BadRequestException,
	ForbiddenException,
	ServiceUnavailableException
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { IntakeSlaAuthorityController } from './intake-sla-authority.controller';
import {
	IntakeSlaAuthorityService,
	parseIntakeSlaAuthority
} from './intake-sla-authority.service';

const workspaceId = randomUUID();
const request = {
	schemaVersion: 1 as const,
	purpose: 'INTAKE_SLA' as const,
	workspaceId,
	actorSubject: 'owner',
	expectedBinding: null
};
const owner = {
	subject: 'owner',
	membershipId: null,
	role: 'OWNER',
	state: 'ACTIVE',
	permissions: ['intake:read', 'intake:write']
};
describe('Intake SLA dedicated rule-owner authority', () => {
	it('accepts only the exact purpose and request', () => {
		expect(parseIntakeSlaAuthority(request)).toEqual(request);
		expect(() =>
			parseIntakeSlaAuthority({ ...request, purpose: 'INTAKE_ACCEPT' })
		).toThrow(BadRequestException);
		expect(() =>
			parseIntakeSlaAuthority({ ...request, recipient: 'foreign' })
		).toThrow(BadRequestException);
		expect(() =>
			parseIntakeSlaAuthority({
				...request,
				expectedBinding: { subject: 'other', membershipId: null }
			})
		).toThrow(BadRequestException);
	});
	it('rejects another pairwise service even if its own token is valid', () => {
		const service = { authorize: jest.fn() };
		expect(() =>
			new IntakeSlaAuthorityController(
				service as never,
				{} as never
			).authorize('crm-sales', request)
		).toThrow(ForbiddenException);
		expect(service.authorize).not.toHaveBeenCalled();
	});
	it.each(['OWNER', 'CRM_ADMIN'])(
		'resolves current %s binding without exposing channels',
		async role => {
			const membershipId = role === 'OWNER' ? null : randomUUID();
			const service = new IntakeSlaAuthorityService({
				assignmentSubject: jest
					.fn()
					.mockResolvedValue({ ...owner, role, membershipId })
			} as never);
			expect(await service.authorize(request)).toEqual({
				schemaVersion: 1,
				workspaceId,
				allowed: true,
				binding: { subject: 'owner', membershipId }
			});
		}
	);
	it.each([
		{ role: 'MANAGER' },
		{ role: 'TEAM_LEAD' },
		{ role: 'ANALYST' },
		{ state: 'READ_ONLY' },
		{ permissions: ['intake:read'] }
	])('denies inactive/non-manager authority %j', async patch => {
		const service = new IntakeSlaAuthorityService({
			assignmentSubject: jest
				.fn()
				.mockResolvedValue({ ...owner, ...patch })
		} as never);
		expect(await service.authorize(request)).toMatchObject({
			allowed: false,
			binding: null
		});
	});
	it('does not reuse a disabled/reinvited membership binding', async () => {
		const service = new IntakeSlaAuthorityService({
			assignmentSubject: jest.fn().mockResolvedValue({
				...owner,
				role: 'CRM_ADMIN',
				membershipId: randomUUID()
			})
		} as never);
		expect(
			await service.authorize({
				...request,
				expectedBinding: { subject: 'owner', membershipId: randomUUID() }
			})
		).toMatchObject({ allowed: false });
	});
	it('fails closed for revocation but preserves dependency errors for retry', async () => {
		const authorization = {
				assignmentSubject: jest
					.fn()
					.mockRejectedValue(new ForbiddenException())
			},
			service = new IntakeSlaAuthorityService(authorization as never);
		expect(await service.authorize(request)).toMatchObject({
			allowed: false
		});
		authorization.assignmentSubject.mockRejectedValue(
			new ServiceUnavailableException()
		);
		await expect(service.authorize(request)).rejects.toThrow(
			ServiceUnavailableException
		);
	});
});
