import {
	BadRequestException,
	ConflictException,
	ForbiddenException,
	NotFoundException
} from '@nestjs/common';
import { Prisma, type WorkspaceInvitation } from '@prisma/identity-client';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { WorkspaceInvitationService } from './workspace-invitation.service';
import { IdentityPrismaService } from '../prisma/identity-prisma.service';

const workspaceId = randomUUID();
const invitationId = randomUUID();
const memberId = randomUUID();
const subject = 'invited-user';
const now = new Date();
const invitation = (): WorkspaceInvitation => ({
	id: invitationId,
	workspaceId,
	productCode: 'WINCRM',
	inviterSubject: 'owner',
	email: 'invitee@example.test',
	status: 'PENDING',
	version: 1,
	expiresAt: new Date(Date.now() + 86400000),
	acceptedAt: null,
	acceptedSubject: null,
	acceptanceId: null,
	acceptedMembershipId: null,
	emailVerifiedAt: null,
	notificationEventId: null,
	revokedAt: null,
	createdAt: now,
	updatedAt: now
});
const setup = (emailEnabled = false) => {
	let row = invitation();
	const receipts = new Map<
		string,
		{ requestHash: string; response: unknown }
	>();
	const prisma = {
		$executeRaw: jest.fn().mockResolvedValue(1),
		$transaction: jest.fn(),
		workspaceInvitation: {
			findUnique: jest.fn().mockImplementation(() => Promise.resolve(row)),
			findFirst: jest.fn().mockImplementation(() => Promise.resolve(row)),
			findUniqueOrThrow: jest
				.fn()
				.mockImplementation(() => Promise.resolve(row)),
			create: jest
				.fn()
				.mockImplementation(({ data }) =>
					Promise.resolve({ ...row, ...data })
				),
			updateMany: jest.fn().mockImplementation(({ data }) => {
				row = { ...row, ...data, version: row.version + 1 };
				return Promise.resolve({ count: 1 });
			})
		},
		authIdentity: {
			findFirst: jest
				.fn()
				.mockResolvedValue({ value: row.email, verifiedAt: now })
		},
		workspace: {
			findFirst: jest
				.fn()
				.mockResolvedValue({ id: workspaceId, status: 'ACTIVE' })
		},
		workspaceMember: {
			findUnique: jest.fn().mockResolvedValue(null),
			findFirst: jest.fn().mockResolvedValue({
				id: memberId,
				role: 'MEMBER',
				status: 'ACTIVE'
			}),
			create: jest.fn().mockResolvedValue({
				id: memberId,
				role: 'MEMBER',
				status: 'ACTIVE'
			})
		},
		internalCommandReceipt: {
			findUnique: jest
				.fn()
				.mockImplementation(({ where }) =>
					Promise.resolve(
						receipts.get(
							where.client_command_idempotencyKey.idempotencyKey
						) ?? null
					)
				),
			create: jest.fn().mockImplementation(({ data }) => {
				receipts.set(data.idempotencyKey, data);
				return Promise.resolve(data);
			})
		},
		outboxEvent: {
			create: jest.fn().mockResolvedValue({ id: randomUUID() })
		}
	};
	prisma.$transaction.mockImplementation(
		(callback: (tx: typeof prisma) => unknown) => callback(prisma)
	);
	const service = new WorkspaceInvitationService(
		prisma as unknown as IdentityPrismaService,
		new ConfigService({
			WINCRM_INVITATION_EMAIL_ENABLED: String(emailEnabled)
		})
	);
	return {
		service,
		prisma,
		row: () => row,
		change: (data: Partial<WorkspaceInvitation>) => {
			row = { ...row, ...data };
		}
	};
};

describe('WinCRM Identity workspace invitations', () => {
	it('creates the optional notification intent atomically without JWT, HTML or supplied URL', async () => {
		const { service, prisma } = setup(true);
		prisma.workspaceInvitation.findUnique.mockResolvedValueOnce(
			null as never
		);
		await service.create({
			schemaVersion: 1,
			commandId: randomUUID(),
			invitationId,
			workspaceId,
			inviterSubject: 'owner',
			email: 'Invitee@Example.test',
			expiresAt: new Date(Date.now() + 86400000).toISOString()
		});
		const event = prisma.outboxEvent.create.mock.calls[0][0].data;
		expect(event.eventType).toBe(
			'notification.wincrm.invitation.email.requested.v1'
		);
		expect(event.payload.destination).toEqual({
			email: 'invitee@example.test'
		});
		expect(event.payload.reference).toEqual({
			type: 'wincrm-invitation',
			id: invitationId,
			workspaceId
		});
		expect(Object.keys(event.payload.content).sort()).toEqual([
			'expiresAt',
			'invitationId'
		]);
		expect(prisma.internalCommandReceipt.create).toHaveBeenCalledTimes(1);
	});
	it.each(['ACCEPTED', 'REVOKED', 'expired', 'disabled'] as const)(
		'returns explicit non-delivery for known %s without disclosing recipient',
		async state => {
			const { service, change } = setup(state !== 'disabled');
			change(
				state === 'expired'
					? { expiresAt: new Date(0) }
					: state === 'disabled'
						? {}
						: { status: state }
			);
			await expect(
				service.deliveryContext(invitationId, workspaceId, randomUUID())
			).resolves.toMatchObject({ deliver: false, email: null });
		}
	);
	it('binds fresh notification validity to exact event and workspace IDs', async () => {
		const { service, prisma } = setup(true);
		const eventId = randomUUID();
		await expect(
			service.deliveryContext(invitationId, workspaceId, eventId)
		).resolves.toMatchObject({
			deliver: true,
			email: 'invitee@example.test'
		});
		expect(prisma.workspaceInvitation.findFirst).toHaveBeenCalledWith({
			where: {
				id: invitationId,
				workspaceId,
				notificationEventId: eventId,
				productCode: 'WINCRM'
			}
		});
		prisma.workspaceInvitation.findFirst.mockResolvedValueOnce(
			null as never
		);
		await expect(
			service.deliveryContext(invitationId, workspaceId, randomUUID())
		).rejects.toBeInstanceOf(NotFoundException);
	});
	it('binds preview to the exact active verified EMAIL identity without disclosing address', async () => {
		const { service, prisma } = setup();
		const result = await service.preview(invitationId, subject);
		expect(prisma.authIdentity.findFirst).toHaveBeenCalledWith({
			where: {
				userId: subject,
				type: 'EMAIL',
				value: 'invitee@example.test',
				verifiedAt: { not: null },
				user: { status: 'ACTIVE', deletedAt: null }
			}
		});
		expect(result.invitation).not.toHaveProperty('email');
		expect(result.invitation.productCode).toBe('WINCRM');
	});
	it('denies wrong/unverified email even when the invitation UUID is known', async () => {
		const { service, prisma } = setup();
		prisma.authIdentity.findFirst.mockResolvedValue(null);
		await expect(
			service.preview(invitationId, subject)
		).rejects.toBeInstanceOf(NotFoundException);
		await expect(
			service.accept(invitationId, subject, {
				schemaVersion: 1,
				commandId: randomUUID(),
				expectedVersion: 1
			})
		).rejects.toBeInstanceOf(NotFoundException);
		expect(prisma.workspaceMember.create).not.toHaveBeenCalled();
	});
	it('atomically accepts a purpose-bound MEMBER and emits only identifiers through Outbox', async () => {
		const { service, prisma } = setup();
		const result = await service.accept(invitationId, subject, {
			schemaVersion: 1,
			commandId: randomUUID(),
			expectedVersion: 1
		});
		expect(result.acceptance).toMatchObject({
			workspaceId,
			invitationId,
			invitationVersion: 2,
			subject,
			membershipId: memberId
		});
		expect(prisma.workspaceMember.create).toHaveBeenCalledWith({
			data: {
				workspaceId,
				userId: subject,
				role: 'MEMBER',
				status: 'ACTIVE',
				createdByProduct: 'WINCRM',
				createdByInvitationId: invitationId
			}
		});
		expect(prisma.outboxEvent.create).toHaveBeenCalledTimes(1);
		const event = prisma.outboxEvent.create.mock.calls[0][0].data;
		expect(event.eventType).toBe('identity.wincrm.invitation-accepted.v1');
		expect(event.payload).not.toHaveProperty('email');
		expect(event.payload).not.toHaveProperty('accessToken');
		expect(event.payload).not.toHaveProperty('authorization');
		expect(prisma.$transaction).toHaveBeenCalledWith(
			expect.any(Function),
			{ isolationLevel: 'Serializable' }
		);
	});
	it('replays one acceptance without recreating MEMBER or Outbox, with fresh email check', async () => {
		const { service, prisma } = setup();
		const command = {
			schemaVersion: 1 as const,
			commandId: randomUUID(),
			expectedVersion: 1
		};
		const first = await service.accept(invitationId, subject, command);
		expect(await service.accept(invitationId, subject, command)).toEqual(
			first
		);
		expect(prisma.workspaceMember.create).toHaveBeenCalledTimes(1);
		expect(prisma.outboxEvent.create).toHaveBeenCalledTimes(1);
		prisma.authIdentity.findFirst.mockResolvedValue(null);
		await expect(
			service.accept(invitationId, subject, command)
		).rejects.toBeInstanceOf(NotFoundException);
	});
	it('rejects reuse of a command with changed expectedVersion', async () => {
		const { service } = setup();
		const command = {
			schemaVersion: 1 as const,
			commandId: randomUUID(),
			expectedVersion: 1
		};
		await service.accept(invitationId, subject, command);
		await expect(
			service.accept(invitationId, subject, {
				...command,
				expectedVersion: 2
			})
		).rejects.toBeInstanceOf(ConflictException);
	});
	it.each([
		{ status: 'INACTIVE', role: 'MEMBER' },
		{ status: 'ACTIVE', role: 'OWNER' }
	])(
		'never reactivates/promotes a protected existing membership %j',
		async membership => {
			const { service, prisma } = setup();
			prisma.workspaceMember.findUnique.mockResolvedValue({
				id: memberId,
				...membership
			});
			await expect(
				service.accept(invitationId, subject, {
					schemaVersion: 1,
					commandId: randomUUID(),
					expectedVersion: 1
				})
			).rejects.toBeInstanceOf(ConflictException);
			expect(prisma.workspaceMember.create).not.toHaveBeenCalled();
		}
	);
	it('reuses an existing ACTIVE membership without changing its product origin', async () => {
		const { service, prisma } = setup();
		prisma.workspaceMember.findUnique.mockResolvedValue({
			id: memberId,
			status: 'ACTIVE',
			role: 'MEMBER'
		});
		await service.accept(invitationId, subject, {
			schemaVersion: 1,
			commandId: randomUUID(),
			expectedVersion: 1
		});
		expect(prisma.workspaceMember.create).not.toHaveBeenCalled();
	});
	it.each([
		{ status: 'REVOKED', revokedAt: now },
		{ expiresAt: new Date(0) },
		{ version: 2 }
	])(
		'rejects closed / expired / stale invitation before membership write',
		async update => {
			const { service, prisma, change } = setup();
			change(update);
			await expect(
				service.accept(invitationId, subject, {
					schemaVersion: 1,
					commandId: randomUUID(),
					expectedVersion: 1
				})
			).rejects.toBeInstanceOf(ConflictException);
			expect(prisma.workspaceMember.create).not.toHaveBeenCalled();
		}
	);
	it('fails closed if workspace or final acceptance membership is inactive', async () => {
		const { service, prisma } = setup();
		prisma.workspace.findFirst.mockResolvedValue(null);
		await expect(
			service.accept(invitationId, subject, {
				schemaVersion: 1,
				commandId: randomUUID(),
				expectedVersion: 1
			})
		).rejects.toBeInstanceOf(ForbiddenException);
	});
	it('propagates Outbox failure before storing a successful command receipt', async () => {
		const { service, prisma } = setup();
		prisma.outboxEvent.create.mockRejectedValue(
			new Error('Outbox unavailable')
		);
		await expect(
			service.accept(invitationId, subject, {
				schemaVersion: 1,
				commandId: randomUUID(),
				expectedVersion: 1
			})
		).rejects.toThrow('Outbox unavailable');
		expect(prisma.internalCommandReceipt.create).not.toHaveBeenCalled();
	});
	it('requires an active inviter and rejects expired / overlong creation TTL', async () => {
		const { service, prisma } = setup();
		const dto = {
			schemaVersion: 1 as const,
			commandId: randomUUID(),
			invitationId,
			workspaceId,
			inviterSubject: 'owner',
			email: 'Invitee@example.test',
			expiresAt: new Date(0).toISOString()
		};
		prisma.workspaceMember.findFirst.mockResolvedValue(null);
		await expect(service.create(dto)).rejects.toBeInstanceOf(
			ForbiddenException
		);
		prisma.workspaceMember.findFirst.mockResolvedValue({ id: memberId });
		await expect(service.create(dto)).rejects.toBeInstanceOf(
			BadRequestException
		);
		await expect(
			service.create({
				...dto,
				expiresAt: new Date(Date.now() + 8 * 86400000).toISOString()
			})
		).rejects.toBeInstanceOf(BadRequestException);
	});
	it('retries only serialization failures, without broad exception swallowing', async () => {
		const { service, prisma } = setup();
		prisma.$transaction.mockRejectedValueOnce(
			new Prisma.PrismaClientKnownRequestError('retry', {
				code: 'P2034',
				clientVersion: 'test'
			})
		);
		await service.accept(invitationId, subject, {
			schemaVersion: 1,
			commandId: randomUUID(),
			expectedVersion: 1
		});
		expect(prisma.$transaction).toHaveBeenCalledTimes(2);
	});
});
