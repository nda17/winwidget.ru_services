import {
	ForbiddenException,
	HttpException,
	ServiceUnavailableException,
	ValidationPipe
} from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import { IntakeIngestionController } from './intake-ingestion.controller';
import {
	IntakeIngestionRateLimiter,
	IntakeIngestionService,
	sourceTokenHash
} from './intake-ingestion.service';
import { IngestInboxEntryDto } from './intake.dto';

const token = randomBytes(32).toString('base64url');
const commandId = randomUUID();
const dto = {
	schemaVersion: 1 as const,
	title: 'Запрос с сайта',
	name: 'Анна',
	email: 'ANNA@EXAMPLE.TEST',
	message: 'Позвоните'
};
function setup() {
	const source = {
		id: randomUUID(),
		workspaceId: randomUUID(),
		tokenHash: sourceTokenHash(`Bearer ${token}`),
		tokenVersion: 1,
		version: 1,
		revokedAt: null,
		kind: 'API',
		createdBySubject: 'persisted-owner',
		teamId: null
	};
	const access = {
		schemaVersion: 1,
		workspaceId: source.workspaceId,
		subject: source.createdBySubject,
		state: 'ACTIVE',
		role: 'OWNER',
		teamIds: [],
		permissions: ['intake:manage-sources']
	};
	const sourceLookup = jest.fn().mockResolvedValue(source);
	const tx = {
		$queryRaw: jest.fn().mockResolvedValue([{ id: source.id }]),
		intakeSource: { findUnique: sourceLookup },
		inboxEntry: {
			create: jest.fn().mockResolvedValue({
				id: randomUUID(),
				receivedAt: new Date('2026-09-06T12:00:00.000Z')
			})
		},
		intakeActivity: { create: jest.fn() },
		inboundReceipt: {
			findUnique: jest.fn().mockResolvedValue(null),
			create: jest.fn()
		}
	};
	const prisma = {
		intakeSource: { findUnique: jest.fn().mockResolvedValue(source) },
		$transaction: jest.fn(
			(callback: (value: typeof tx) => Promise<unknown>) => callback(tx)
		)
	};
	const authorization = {
		authorizeSource: jest.fn().mockResolvedValue(access)
	};
	const limits = { preauthenticate: jest.fn(), consume: jest.fn() };
	const service = new IntakeIngestionService(
		prisma as never,
		authorization as never,
		limits as never
	);
	const invoke = (
		body = dto,
		key = commandId,
		bearer = `Bearer ${token}`
	) => service.ingest(source.id, bearer, key, body, '127.0.0.1');
	return {
		source,
		access,
		tx,
		prisma,
		authorization,
		limits,
		service,
		invoke
	};
}

describe('source-authenticated Intake ingress', () => {
	it('derives tenant, actor and team only from the source and atomically stores NEW API entry, receipt and audit', async () => {
		const current = setup();
		const result = await current.invoke();
		expect(Object.keys(result)).toEqual([
			'schemaVersion',
			'entryId',
			'receivedAt'
		]);
		expect(current.authorization.authorizeSource).toHaveBeenCalledWith(
			current.source.workspaceId,
			'persisted-owner'
		);
		expect(current.tx.inboxEntry.create).toHaveBeenCalledWith({
			data: {
				workspaceId: current.source.workspaceId,
				title: dto.title,
				name: dto.name,
				phone: null,
				email: 'anna@example.test',
				message: dto.message,
				origin: 'API',
				sourceId: current.source.id,
				createdBySubject: 'persisted-owner',
				teamId: null
			}
		});
		expect(current.prisma.$transaction).toHaveBeenCalledWith(
			expect.any(Function),
			{ isolationLevel: 'Serializable' }
		);
		const receipt = current.tx.inboundReceipt.create.mock.calls[0][0].data;
		expect(receipt).toMatchObject({
			sourceId: current.source.id,
			externalCommandId: commandId,
			workspaceId: current.source.workspaceId,
			entryId: result.entryId
		});
		expect(current.tx.intakeActivity.create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				action: 'CREATED',
				commandId: receipt.auditCommandId,
				actorSubject: 'persisted-owner'
			})
		});
		for (const safe of [
			result,
			receipt,
			current.tx.intakeActivity.create.mock.calls
		]) {
			expect(JSON.stringify(safe)).not.toContain(token);
			expect(JSON.stringify(safe)).not.toContain(dto.message);
		}
	});
	it('reauthorizes and authenticates every replay and rejects reused keys with a changed payload', async () => {
		const current = setup();
		const result = await current.invoke();
		current.tx.inboundReceipt.findUnique.mockResolvedValue(
			current.tx.inboundReceipt.create.mock.calls[0][0].data
		);
		expect(await current.invoke()).toEqual(result);
		expect(current.authorization.authorizeSource).toHaveBeenCalledTimes(2);
		expect(current.tx.inboxEntry.create).toHaveBeenCalledTimes(1);
		await expect(
			current.invoke({ ...dto, name: 'Другой клиент' })
		).rejects.toMatchObject({ status: 409 });
		current.prisma.intakeSource.findUnique.mockResolvedValue({
			...current.source,
			revokedAt: new Date()
		});
		await expect(current.invoke()).rejects.toMatchObject({ status: 401 });
		expect(current.authorization.authorizeSource).toHaveBeenCalledTimes(3);
	});
	it.each([
		undefined,
		'',
		'Basic ignored',
		'Bearer wrong',
		`Bearer ${'A'.repeat(42)}B`
	])(
		'rejects invalid or noncanonical source credentials before authority lookup',
		async bearer => {
			const current = setup();
			await expect(
				current.service.ingest(
					current.source.id,
					bearer,
					commandId,
					dto,
					'127.0.0.1'
				)
			).rejects.toMatchObject({ status: 401 });
			expect(
				current.prisma.intakeSource.findUnique
			).not.toHaveBeenCalled();
		}
	);
	it('treats missing source, wrong secret and revoked source as the same authentication failure', async () => {
		for (const source of [
			null,
			{ revokedAt: new Date() },
			{ tokenHash: '1'.repeat(64) }
		]) {
			const current = setup();
			current.prisma.intakeSource.findUnique.mockResolvedValue(
				source ? { ...current.source, ...source } : null
			);
			await expect(current.invoke()).rejects.toMatchObject({
				status: 401,
				message: 'Source authentication is not valid'
			});
			expect(current.authorization.authorizeSource).not.toHaveBeenCalled();
		}
	});
	it.each([
		{ tokenVersion: 2 },
		{ version: 2 },
		{ createdBySubject: 'other' },
		{ teamId: randomUUID() },
		{ revokedAt: new Date() }
	])(
		'rejects a source change between fresh authorization and the transactional row lock',
		async change => {
			const current = setup();
			current.tx.intakeSource.findUnique.mockResolvedValue({
				...current.source,
				...change
			});
			await expect(current.invoke()).rejects.toMatchObject({
				status: 401
			});
			expect(current.tx.inboundReceipt.findUnique).not.toHaveBeenCalled();
			expect(current.tx.inboxEntry.create).not.toHaveBeenCalled();
		}
	);
	it.each([
		{ state: 'READ_ONLY' },
		{ role: 'MANAGER' },
		{ subject: 'other' },
		{ permissions: [] }
	])(
		'halts sources when the current delegate loses authority',
		async change => {
			const current = setup();
			current.authorization.authorizeSource.mockResolvedValue({
				...current.access,
				...change
			});
			await expect(current.invoke()).rejects.toBeInstanceOf(
				ForbiddenException
			);
			expect(current.prisma.$transaction).not.toHaveBeenCalled();
		}
	);
	it('fails closed on dependency or database errors without exposing request contents', async () => {
		const current = setup();
		current.authorization.authorizeSource.mockRejectedValue(
			new ServiceUnavailableException('Access unavailable')
		);
		await expect(current.invoke()).rejects.toMatchObject({ status: 503 });
		current.authorization.authorizeSource.mockResolvedValue(
			current.access
		);
		current.tx.inboundReceipt.create.mockRejectedValue(
			new Error(`database failure ${token} ${dto.message}`)
		);
		await expect(current.invoke()).rejects.toMatchObject({
			status: 503,
			message: 'Intake is temporarily unavailable; retry the same request'
		});
	});
	it('rejects actor/workspace/team overrides and oversized payloads through the strict runtime DTO', async () => {
		const pipe = new ValidationPipe({
			transform: true,
			whitelist: true,
			forbidNonWhitelisted: true,
			validationError: { target: false, value: false }
		});
		for (const change of [
			{ workspaceId: randomUUID() },
			{ subject: 'other' },
			{ teamId: randomUUID() },
			{ sourceId: randomUUID() },
			{ commandId },
			{ message: 'x'.repeat(5001) },
			{ title: ' ' },
			{ phone: 'not-a-phone' }
		]) {
			await expect(
				pipe.transform(
					{ ...dto, ...change },
					{ type: 'body', metatype: IngestInboxEntryDto }
				)
			).rejects.toMatchObject({ status: 400 });
		}
	});
	it('uses the transport peer and ignores public forwarded-IP and JWT hints', () => {
		const ingestion = { ingest: jest.fn() };
		new IntakeIngestionController(ingestion as never).ingest(
			'source',
			`Bearer ${token}`,
			commandId,
			dto,
			{
				socket: { remoteAddress: '127.0.0.1' },
				ip: 'spoof',
				headers: { 'x-forwarded-for': 'spoof' }
			} as never
		);
		expect(ingestion.ingest).toHaveBeenCalledWith(
			'source',
			`Bearer ${token}`,
			commandId,
			dto,
			'127.0.0.1'
		);
	});
});

describe('bounded ingress rate limits', () => {
	it('bounds pre-authentication attempts per peer and releases only expired windows', () => {
		const limiter = new IntakeIngestionRateLimiter({} as never);
		for (let i = 0; i < 1200; i++)
			limiter.preauthenticate('127.0.0.1', 60_000);
		expect(() => limiter.preauthenticate('127.0.0.1', 60_000)).toThrow(
			HttpException
		);
		expect(() =>
			limiter.preauthenticate('127.0.0.1', 120_000)
		).not.toThrow();
		expect(() => limiter.preauthenticate('spoof', 120_000)).toThrow();
	});
	it('fails closed when a durable counter saturates or its database is unavailable', async () => {
		const tx = {
			$queryRaw: jest.fn().mockResolvedValue([]),
			$executeRaw: jest.fn()
		};
		const prisma = { $transaction: jest.fn(callback => callback(tx)) };
		const limiter = new IntakeIngestionRateLimiter(prisma as never);
		await expect(
			limiter.consume(randomUUID(), '127.0.0.1')
		).rejects.toMatchObject({ status: 429 });
		expect(tx.$executeRaw).not.toHaveBeenCalled();
		prisma.$transaction.mockRejectedValue(new Error('db secret'));
		await expect(
			limiter.consume(randomUUID(), '127.0.0.1')
		).rejects.toMatchObject({
			status: 503,
			message: 'Intake limits could not be confirmed'
		});
	});
});
