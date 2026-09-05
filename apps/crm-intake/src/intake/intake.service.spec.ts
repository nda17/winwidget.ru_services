import {
	BadRequestException,
	ConflictException,
	ForbiddenException,
	NotFoundException
} from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import { IntakeAuthorization } from '../access/intake-authorization.client';
import { CrmIntakePrismaService } from '../prisma/crm-intake-prisma.service';
import {
	hashIntakeSourceToken,
	intakeEntryScope,
	IntakeService
} from './intake.service';

const workspaceId = randomUUID();
const context: IntakeAuthorization = {
	schemaVersion: 1,
	workspaceId,
	subject: 'owner',
	role: 'OWNER',
	state: 'ACTIVE',
	dataScope: 'ALL',
	teamIds: [],
	permissions: ['intake:read', 'intake:write', 'intake:manage-sources']
};
const now = new Date('2026-09-06T00:00:00.000Z');
const entry = {
	id: randomUUID(),
	workspaceId,
	title: 'Запрос',
	name: 'Анна',
	phone: '+79000000001',
	email: 'anna@example.test',
	message: null,
	origin: 'MANUAL',
	sourceId: null,
	status: 'NEW',
	createdBySubject: 'owner',
	teamId: null,
	version: 1,
	contactId: null,
	dealId: null,
	rejectionReason: null,
	receivedAt: now,
	updatedAt: now,
	acceptedAt: null,
	rejectedAt: null
};
const token = randomBytes(32).toString('base64url');
const source = {
	id: randomUUID(),
	workspaceId,
	name: 'Сайт',
	kind: 'API',
	tokenHash: hashIntakeSourceToken(token),
	tokenVersion: 1,
	createdBySubject: 'owner',
	teamId: null,
	version: 1,
	revokedAt: null,
	createdAt: now,
	updatedAt: now
};
const command = {
	schemaVersion: 1 as const,
	workspaceId,
	commandId: randomUUID(),
	title: entry.title,
	name: entry.name,
	phone: entry.phone,
	email: entry.email
};

describe('IntakeService', () => {
	const setup = () => {
		const tx = {
			acceptance: { findFirst: jest.fn().mockResolvedValue(null) },
			$executeRaw: jest.fn(),
			inboxEntry: {
				create: jest.fn().mockResolvedValue(entry),
				findFirst: jest.fn().mockResolvedValue(entry),
				findMany: jest.fn().mockResolvedValue([entry]),
				count: jest.fn().mockResolvedValue(1),
				updateMany: jest.fn().mockResolvedValue({ count: 1 })
			},
			intakeSource: {
				create: jest.fn().mockResolvedValue(source),
				findFirst: jest.fn().mockResolvedValue(source),
				findMany: jest.fn().mockResolvedValue([source]),
				count: jest.fn().mockResolvedValue(1),
				updateMany: jest.fn().mockResolvedValue({ count: 1 })
			},
			intakeCommand: {
				findUnique: jest.fn().mockResolvedValue(null),
				create: jest.fn()
			},
			intakeActivity: { create: jest.fn() }
		};
		const prisma = {
			...tx,
			$transaction: jest
				.fn()
				.mockImplementation(input =>
					typeof input === 'function' ? input(tx) : Promise.all(input)
				)
		};
		return {
			tx,
			prisma,
			service: new IntakeService(
				prisma as unknown as CrmIntakePrismaService
			)
		};
	};

	it.each(['ACTIVE', 'GRACE'] as const)(
		'creates a manual NEW entry and audit/receipt in one %s transaction',
		async state => {
			const { service, tx, prisma } = setup();
			const response = await service.createManual(
				{ ...context, state },
				command
			);
			expect(tx.inboxEntry.create).toHaveBeenCalledWith({
				data: expect.objectContaining({
					workspaceId,
					createdBySubject: context.subject,
					origin: 'MANUAL',
					title: command.title
				})
			});
			expect(tx.intakeActivity.create).toHaveBeenCalledWith({
				data: expect.objectContaining({
					action: 'CREATED',
					commandId: command.commandId
				})
			});
			expect(tx.intakeCommand.create).toHaveBeenCalledWith({
				data: expect.objectContaining({ response })
			});
			expect(prisma.$transaction).toHaveBeenCalledWith(
				expect.any(Function),
				{ isolationLevel: 'Serializable' }
			);
		}
	);

	it('rejects read-only and foreign-workspace writes before touching DB', async () => {
		const { service, prisma } = setup();
		for (const denied of [
			{ ...context, state: 'READ_ONLY' as const },
			{ ...context, workspaceId: randomUUID() },
			{ ...context, permissions: ['intake:read'] }
		]) {
			await expect(
				service.createManual(denied, command)
			).rejects.toBeInstanceOf(ForbiddenException);
		}
		expect(prisma.$transaction).not.toHaveBeenCalled();
	});

	it('applies record ownership and team scope even when reading by ID', async () => {
		const { service, tx } = setup();
		const scoped = {
			...context,
			dataScope: 'OWN' as const,
			state: 'READ_ONLY' as const
		};
		await service.get(scoped, workspaceId, entry.id);
		expect(tx.inboxEntry.findFirst).toHaveBeenCalledWith({
			where: {
				AND: [{ workspaceId, createdBySubject: 'owner' }, { id: entry.id }]
			}
		});
		const teamId = randomUUID();
		expect(
			intakeEntryScope({
				...context,
				dataScope: 'TEAM',
				teamIds: [teamId]
			})
		).toEqual({
			workspaceId,
			OR: [{ createdBySubject: 'owner' }, { teamId: { in: [teamId] } }]
		});
		tx.inboxEntry.findFirst.mockResolvedValue(null);
		await expect(
			service.get(scoped, workspaceId, entry.id)
		).rejects.toBeInstanceOf(NotFoundException);
	});

	it('replays exact actor-bound commands without duplicate writes and denies changed payloads', async () => {
		const { service, tx } = setup();
		const first = await service.createManual(context, command);
		tx.intakeCommand.findUnique.mockResolvedValue(
			tx.intakeCommand.create.mock.calls[0][0].data
		);
		expect(await service.createManual(context, command)).toEqual(first);
		expect(tx.inboxEntry.create).toHaveBeenCalledTimes(1);
		await expect(
			service.createManual(context, { ...command, title: 'Другой запрос' })
		).rejects.toBeInstanceOf(ConflictException);
		await expect(
			service.createManual({ ...context, subject: 'another' }, command)
		).rejects.toBeInstanceOf(ConflictException);
		tx.inboxEntry.findFirst.mockResolvedValue(null);
		await expect(
			service.createManual(context, command)
		).rejects.toBeInstanceOf(NotFoundException);
	});

	it('rejects only NEW entries with the exact current version', async () => {
		const { service, tx } = setup();
		const reject = {
			schemaVersion: 1 as const,
			workspaceId,
			commandId: randomUUID(),
			expectedVersion: 1,
			reason: 'Дубль'
		};
		await expect(
			service.reject(context, entry.id, { ...reject, expectedVersion: 2 })
		).rejects.toBeInstanceOf(ConflictException);
		tx.inboxEntry.findFirst.mockResolvedValue({
			...entry,
			status: 'ACCEPTED'
		});
		await expect(
			service.reject(context, entry.id, reject)
		).rejects.toBeInstanceOf(ConflictException);
		expect(tx.inboxEntry.updateMany).not.toHaveBeenCalled();
		tx.inboxEntry.findFirst.mockResolvedValue(entry);
		await service.reject(context, entry.id, reject);
		expect(tx.inboxEntry.updateMany).toHaveBeenCalledWith({
			where: {
				AND: [
					intakeEntryScope(context),
					{ id: entry.id, version: 1, status: 'NEW' }
				]
			},
			data: expect.objectContaining({
				status: 'REJECTED',
				rejectionReason: 'Дубль',
				version: { increment: 1 }
			})
		});
	});

	it('never exposes source plaintext or its hash in response, receipt or activity', async () => {
		const { service, tx } = setup();
		const response = await service.createSource(context, {
			schemaVersion: 1,
			workspaceId,
			commandId: randomUUID(),
			name: 'Сайт',
			token
		});
		expect(tx.intakeSource.create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				tokenHash: hashIntakeSourceToken(token)
			})
		});
		for (const value of [
			response,
			tx.intakeCommand.create.mock.calls,
			tx.intakeActivity.create.mock.calls
		]) {
			expect(JSON.stringify(value)).not.toContain(token);
			expect(JSON.stringify(value)).not.toContain(
				hashIntakeSourceToken(token)
			);
		}
		expect(
			JSON.stringify(tx.intakeSource.create.mock.calls)
		).not.toContain(token);
	});

	it('requires both manager role and source permission for source mutations', async () => {
		const { service, prisma } = setup();
		const dto = {
			schemaVersion: 1 as const,
			workspaceId,
			commandId: randomUUID(),
			name: 'Сайт',
			token
		};
		for (const denied of [
			{ ...context, role: 'MANAGER' as const },
			{ ...context, permissions: ['intake:read', 'intake:write'] },
			{ ...context, state: 'READ_ONLY' as const }
		]) {
			await expect(
				service.createSource(denied, dto)
			).rejects.toBeInstanceOf(ForbiddenException);
		}
		expect(prisma.$transaction).not.toHaveBeenCalled();
	});

	it('allows safe source metadata read for READ_ONLY owner without write permissions', async () => {
		const { service } = setup();
		await expect(
			service.listSources(
				{ ...context, state: 'READ_ONLY', permissions: ['intake:read'] },
				{ workspaceId, page: 1, pageSize: 25 }
			)
		).resolves.toHaveProperty('total', 1);
	});

	it('requires a fresh token and active source for rotation', async () => {
		const { service, tx } = setup();
		const dto = {
			schemaVersion: 1 as const,
			workspaceId,
			commandId: randomUUID(),
			expectedVersion: 1,
			token
		};
		await expect(
			service.rotateSource(context, source.id, dto)
		).rejects.toBeInstanceOf(ConflictException);
		tx.intakeSource.findFirst.mockResolvedValue({
			...source,
			revokedAt: now
		});
		await expect(
			service.rotateSource(context, source.id, {
				...dto,
				token: randomBytes(32).toString('base64url')
			})
		).rejects.toBeInstanceOf(ConflictException);
		expect(tx.intakeSource.updateMany).not.toHaveBeenCalled();
	});

	it('requires a canonical base64url encoding of exactly 32 bytes', () => {
		expect(hashIntakeSourceToken(token)).toMatch(/^[a-f0-9]{64}$/);
		for (const invalid of [
			'',
			randomBytes(31).toString('base64url'),
			`${token}=`,
			token.slice(0, 42) + '_'
		])
			expect(() => hashIntakeSourceToken(invalid)).toThrow(
				BadRequestException
			);
	});
});
