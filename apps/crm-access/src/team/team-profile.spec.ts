import {
	BadRequestException,
	ConflictException,
	ForbiddenException,
	NotFoundException,
	ServiceUnavailableException,
	ValidationPipe
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { CrmEmployeeProfileService } from './team-profile.service';
import { CrmEmployeeProfileController } from './team-profile.controller';
import {
	CreateInvitationDto,
	EmployeeProfileQueryDto,
	UpdateEmployeeProfileDto
} from './team.dto';
import {
	employeeDisplayName,
	normalizeEmployeeName
} from './team-profile.dto';

const workspaceId = randomUUID();
const names = { firstName: 'Иван', lastName: 'Петров', middleName: null };
const setup = (role = 'OWNER', state = 'ACTIVE') => {
	const actor = {
		workspaceId,
		subject: 'current-actor',
		role,
		state,
		permissions: ['access:read-team', 'access:manage-team']
	};
	const rows = new Map<string, Record<string, unknown>>();
	const receipts = new Map<string, Record<string, unknown>>();
	const prisma = {
		$executeRaw: jest.fn(),
		$transaction: jest.fn(),
		crmWorkspaceMember: {
			findUnique: jest.fn().mockImplementation(async ({ where }) => ({
				role:
					where.workspaceId_subject.subject === actor.subject
						? actor.role
						: 'MANAGER',
				disabledAt: null
			}))
		},
		crmEmployeeProfile: {
			findUnique: jest
				.fn()
				.mockImplementation(
					async ({ where }) =>
						rows.get(where.workspaceId_subject.subject) ?? null
				),
			create: jest.fn().mockImplementation(async ({ data }) => {
				const row = {
					...data,
					id: randomUUID(),
					version: 1,
					updatedAt: new Date()
				};
				rows.set(data.subject, row);
				return row;
			}),
			update: jest.fn().mockImplementation(async ({ where, data }) => {
				const subject = where.workspaceId_subject.subject;
				const current = rows.get(subject)!;
				const row = {
					...current,
					...data,
					version: Number(current.version) + 1,
					updatedAt: new Date()
				};
				rows.set(subject, row);
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
		authorize: jest.fn().mockResolvedValue(actor),
		authorizeSubject: jest
			.fn()
			.mockImplementation(async (_workspaceId, subject) => ({
				...actor,
				subject,
				role: 'MANAGER'
			}))
	};
	const service = new CrmEmployeeProfileService(
		prisma as never,
		auth as never
	);
	const command = (overrides = {}): UpdateEmployeeProfileDto => ({
		schemaVersion: 1,
		commandId: randomUUID(),
		workspaceId,
		subject: actor.subject,
		expectedVersion: 0,
		profile: names,
		...overrides
	});
	return { actor, service, prisma, auth, command };
};

describe('workspace-local CRM employee profiles', () => {
	it.each(['OWNER', 'CRM_ADMIN', 'TEAM_LEAD', 'MANAGER', 'ANALYST'])(
		'%s can edit their own name without changing Identity or membership',
		async role => {
			const { service, prisma, actor, auth, command } = setup(role);
			expect(
				await service.get('Bearer test', { workspaceId })
			).toMatchObject({
				workspaceId,
				subject: actor.subject,
				targetSubject: actor.subject,
				profile: null
			});
			const result = await service.update('Bearer test', command());
			expect(result.profile).toMatchObject({ ...names, version: 1 });
			expect(prisma.crmEmployeeProfile.create).toHaveBeenCalledWith({
				data: { workspaceId, subject: actor.subject, ...names }
			});
			expect(auth.authorizeSubject).not.toHaveBeenCalled();
			expect(
				prisma.crmTeamAudit.create.mock.calls[0][0].data
			).toMatchObject({
				action: 'EMPLOYEE_PROFILE_UPDATED',
				before: { version: 0 },
				after: { version: 1 }
			});
		}
	);
	it.each(['OWNER', 'CRM_ADMIN', 'TEAM_LEAD', 'MANAGER', 'ANALYST'])(
		'%s can read but cannot edit in READ_ONLY',
		async role => {
			const { service, prisma, command } = setup(role, 'READ_ONLY');
			await expect(
				service.get('Bearer test', { workspaceId })
			).resolves.toMatchObject({ profile: null });
			await expect(
				service.update('Bearer test', command())
			).rejects.toBeInstanceOf(ForbiddenException);
			expect(prisma.crmEmployeeProfile.create).not.toHaveBeenCalled();
		}
	);
	it.each(['TEAM_LEAD', 'MANAGER', 'ANALYST'])(
		'%s cannot use profile lookup or edit to access another employee',
		async role => {
			const { service, prisma, auth, command } = setup(role);
			await expect(
				service.get('Bearer test', { workspaceId, subject: 'another' })
			).rejects.toBeInstanceOf(ForbiddenException);
			await expect(
				service.update('Bearer test', command({ subject: 'another' }))
			).rejects.toBeInstanceOf(ForbiddenException);
			expect(auth.authorizeSubject).not.toHaveBeenCalled();
			expect(prisma.$transaction).not.toHaveBeenCalled();
		}
	);
	it.each(['OWNER', 'CRM_ADMIN'])(
		'CRM_ADMIN cannot edit %s names',
		async targetRole => {
			const { service, auth, actor, command } = setup('CRM_ADMIN');
			auth.authorizeSubject.mockResolvedValue({
				...actor,
				subject: 'another',
				role: targetRole
			});
			await expect(
				service.update('Bearer test', command({ subject: 'another' }))
			).rejects.toBeInstanceOf(ForbiddenException);
		}
	);
	it.each(['OWNER', 'CRM_ADMIN'])(
		'%s verifies target access server-side before editing a member',
		async role => {
			const { service, auth, command } = setup(role);
			await expect(
				service.update('Bearer test', command({ subject: 'employee' }))
			).resolves.toMatchObject({
				targetSubject: 'employee',
				profile: names
			});
			expect(auth.authorizeSubject).toHaveBeenCalledWith(
				workspaceId,
				'employee'
			);
		}
	);
	it('owner can edit another administrator, without a synthetic owner member row', async () => {
		const { service, prisma, auth, actor, command } = setup();
		auth.authorizeSubject.mockResolvedValue({
			...actor,
			subject: 'administrator',
			role: 'CRM_ADMIN'
		});
		prisma.crmWorkspaceMember.findUnique.mockResolvedValue({
			role: 'CRM_ADMIN',
			disabledAt: null
		});
		await expect(
			service.update('Bearer test', command({ subject: 'administrator' }))
		).resolves.toMatchObject({ profile: names });
	});
	it('rejects writes if the newer target authorization observes READ_ONLY', async () => {
		const { service, prisma, auth, actor, command } = setup();
		auth.authorizeSubject.mockResolvedValue({
			...actor,
			subject: 'employee',
			role: 'MANAGER',
			state: 'READ_ONLY'
		});
		await expect(
			service.update('Bearer test', command({ subject: 'employee' }))
		).rejects.toBeInstanceOf(ForbiddenException);
		expect(prisma.$transaction).not.toHaveBeenCalled();
		await expect(
			service.get('Bearer test', { workspaceId, subject: 'employee' })
		).resolves.toMatchObject({ profile: null });
	});
	it('does not confuse revoked/pending targets with Identity outages', async () => {
		const { service, auth, prisma, command } = setup();
		auth.authorizeSubject.mockRejectedValueOnce(new ForbiddenException());
		await expect(
			service.update('Bearer test', command({ subject: 'revoked' }))
		).rejects.toBeInstanceOf(NotFoundException);
		auth.authorizeSubject.mockRejectedValueOnce(
			new ServiceUnavailableException()
		);
		await expect(
			service.update('Bearer test', command({ subject: 'unknown' }))
		).rejects.toBeInstanceOf(ServiceUnavailableException);
		expect(prisma.$transaction).not.toHaveBeenCalled();
	});
	it('rechecks local target disable after HTTP authorization and before the write', async () => {
		const { service, prisma, command } = setup();
		prisma.crmWorkspaceMember.findUnique.mockResolvedValue({
			role: 'MANAGER',
			disabledAt: new Date()
		});
		await expect(
			service.update('Bearer test', command({ subject: 'employee' }))
		).rejects.toBeInstanceOf(ForbiddenException);
		expect(prisma.crmEmployeeProfile.create).not.toHaveBeenCalled();
	});
	it('retains command replay, rejects a changed payload, and uses independent profile versions', async () => {
		const { service, prisma, command } = setup();
		const dto = command();
		const first = await service.update('Bearer test', dto);
		expect(await service.update('Bearer test', dto)).toEqual(first);
		await expect(
			service.update('Bearer test', {
				...dto,
				profile: { ...names, firstName: 'Пётр' }
			})
		).rejects.toBeInstanceOf(ConflictException);
		await expect(
			service.update('Bearer test', command())
		).rejects.toBeInstanceOf(ConflictException);
		expect(
			await service.update('Bearer test', command({ expectedVersion: 1 }))
		).toMatchObject({ profile: { version: 2 } });
		expect(prisma.crmTeamAudit.create).toHaveBeenCalledTimes(2);
	});
	it('binds reads to authenticated workspace and subject', async () => {
		const { service, prisma, actor } = setup();
		await service.get('Bearer test', { workspaceId });
		expect(prisma.crmEmployeeProfile.findUnique).toHaveBeenCalledWith({
			where: {
				workspaceId_subject: { workspaceId, subject: actor.subject }
			}
		});
		expect(prisma.$transaction).toHaveBeenCalledWith(
			expect.any(Function),
			{ isolationLevel: 'RepeatableRead' }
		);
	});
});

describe('employee name and profile request contracts', () => {
	const pipe = new ValidationPipe({
		transform: true,
		whitelist: true,
		forbidNonWhitelisted: true
	});
	it('normalizes names without guessing a first/last name split', () => {
		const normalized = normalizeEmployeeName({
			firstName: ' Анна  Мария ',
			lastName: 'О’Коннор-Соколова',
			middleName: ''
		});
		expect(normalized).toEqual({
			firstName: 'Анна Мария',
			lastName: 'О’Коннор-Соколова',
			middleName: null
		});
		expect(employeeDisplayName(normalized)).toBe(
			'О’Коннор-Соколова Анна Мария'
		);
	});
	it.each([
		'',
		'   ',
		'x'.repeat(101),
		'Иван\nПётр',
		'<script>',
		'Имя\u202e',
		'Имя\u0000',
		'123'
	])('rejects invalid name %j', firstName => {
		expect(() => normalizeEmployeeName({ ...names, firstName })).toThrow(
			BadRequestException
		);
	});
	it('accepts legacy invitations without changing their command payload', async () => {
		const dto = {
			schemaVersion: 1,
			commandId: randomUUID(),
			workspaceId,
			email: 'legacy@example.test',
			role: 'MANAGER',
			teamIds: []
		};
		const result = await pipe.transform(dto, {
			type: 'body',
			metatype: CreateInvitationDto
		});
		expect(result).toMatchObject(dto);
		expect(result.profile).toBeUndefined();
	});
	it('accepts structured invitation names but rejects null/partial/unrecognized profiles', async () => {
		const dto = {
			schemaVersion: 1,
			commandId: randomUUID(),
			workspaceId,
			email: 'named@example.test',
			role: 'MANAGER',
			teamIds: [],
			profile: names
		};
		await expect(
			pipe.transform(dto, { type: 'body', metatype: CreateInvitationDto })
		).resolves.toMatchObject(dto);
		for (const profile of [
			null,
			{ firstName: 'Иван' },
			{ ...names, role: 'OWNER' }
		])
			await expect(
				pipe.transform(
					{ ...dto, profile },
					{ type: 'body', metatype: CreateInvitationDto }
				)
			).rejects.toBeInstanceOf(BadRequestException);
	});
	it('rejects client-supplied authority and invalid query identity', async () => {
		for (const query of [
			{ workspaceId, role: 'OWNER' },
			{ workspaceId, subject: ' bad' },
			{ workspaceId: 'bad' }
		])
			await expect(
				pipe.transform(query, {
					type: 'query',
					metatype: EmployeeProfileQueryDto
				})
			).rejects.toBeInstanceOf(BadRequestException);
	});
	it('validates profile CAS and rejects all unknown nested fields', async () => {
		const { command } = setup();
		for (const dto of [
			command({ expectedVersion: -1 }),
			command({ expectedVersion: 2147483647 }),
			command({ profile: null }),
			command({ profile: { ...names, subject: 'other' } })
		])
			await expect(
				pipe.transform(dto, {
					type: 'body',
					metatype: UpdateEmployeeProfileDto
				})
			).rejects.toBeInstanceOf(BadRequestException);
		await expect(
			pipe.transform(command(), {
				type: 'body',
				metatype: UpdateEmployeeProfileDto
			})
		).resolves.toHaveProperty('expectedVersion', 0);
	});
	it('requires an exact idempotency header at the public controller', () => {
		const { service, command } = setup();
		const controller = new CrmEmployeeProfileController(service);
		const dto = command();
		expect(() => controller.update('Bearer test', undefined, dto)).toThrow(
			BadRequestException
		);
		expect(() =>
			controller.update('Bearer test', randomUUID(), dto)
		).toThrow(BadRequestException);
	});
});
