import {
	BadRequestException,
	ConflictException,
	ForbiddenException,
	NotFoundException,
	ServiceUnavailableException,
	ValidationPipe
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
	IntakeAuthorization,
	IntakeAuthorizationClient
} from '../access/intake-authorization.client';
import { CrmIntakePrismaService } from '../prisma/crm-intake-prisma.service';
import { ImportIntakeCsvDto } from './intake-csv-import.dto';
import { IntakeCsvImportService } from './intake-csv-import.service';
import { IntakeCsvImportController } from './intake-csv-import.controller';

const workspaceId = randomUUID();
const teamId = randomUUID();
const context: IntakeAuthorization = {
	schemaVersion: 1,
	workspaceId,
	subject: 'actor',
	role: 'OWNER',
	state: 'ACTIVE',
	dataScope: 'ALL',
	teamIds: [teamId],
	permissions: ['intake:read', 'intake:write']
};
const command = (): ImportIntakeCsvDto => ({
	schemaVersion: 1,
	workspaceId,
	commandId: randomUUID(),
	label: 'Клиенты.csv',
	teamId: null,
	rows: [
		{
			title: ' Запрос ',
			name: ' Анна ',
			phone: '+79000000001',
			email: 'ANNA@EXAMPLE.TEST',
			message: ' Текст '
		}
	]
});
const pipe = new ValidationPipe({
	transform: true,
	whitelist: true,
	forbidNonWhitelisted: true,
	validationError: { target: false, value: false }
});
const validate = (value: unknown) =>
	pipe.transform(value, { type: 'body', metatype: ImportIntakeCsvDto });
const malformedText = [
	'\0',
	'\x01',
	'\x08',
	'\x0b',
	'\x0c',
	'\x0e',
	'\x1f',
	'\x7f',
	'\ufffd',
	'\ud800',
	'\udfff'
];

function setup() {
	let receipt: unknown = null;
	let batch: unknown = null;
	const tx = {
		$executeRaw: jest.fn().mockResolvedValue(0),
		$queryRaw: jest.fn().mockResolvedValue([{ locked: true }]),
		intakeCommand: {
			findUnique: jest.fn().mockImplementation(async () => receipt),
			create: jest.fn().mockImplementation(async ({ data }) => {
				receipt = data;
				return data;
			})
		},
		csvImport: {
			create: jest.fn().mockImplementation(async ({ data }) => {
				batch = {
					...data,
					createdAt: new Date('2026-09-05T00:00:00.000Z')
				};
				return batch;
			}),
			findFirst: jest.fn().mockImplementation(async () => batch)
		},
		inboxEntry: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
		intakeActivity: {
			createMany: jest.fn().mockResolvedValue({ count: 1 })
		},
		csvImportRow: { createMany: jest.fn().mockResolvedValue({ count: 1 }) }
	};
	const db = {
		...tx,
		$transaction: jest
			.fn()
			.mockImplementation(async callback => callback(tx))
	};
	return {
		tx,
		db,
		service: new IntakeCsvImportService(
			db as unknown as CrmIntakePrismaService
		)
	};
}

describe('CSV validation and strict DTO', () => {
	it.each(malformedText)(
		'rejects malformed/control characters without reflecting values',
		async character => {
			for (const field of ['title', 'name', 'message'] as const) {
				const dto = command();
				dto.rows[0][field] = `private-review-content${character}`;
				try {
					await validate(dto);
					throw new Error(
						'Validation unexpectedly accepted malformed text'
					);
				} catch (error) {
					expect(error).toBeInstanceOf(BadRequestException);
					expect(
						JSON.stringify((error as BadRequestException).getResponse())
					).not.toContain('private-review-content');
				}
			}
		}
	);
	it('preserves valid Unicode, tabs and multiline values', async () => {
		const dto = command();
		dto.rows[0].title = 'Тема\t😊';
		dto.rows[0].name = 'Имя\nФамилия';
		dto.rows[0].message = 'Строка\r\nСледующая\t😊';
		await expect(validate(dto)).resolves.toMatchObject(dto);
	});
	it('accepts 1 and 250 rows, including explicit null optional values', async () => {
		await expect(validate(command())).resolves.toBeInstanceOf(
			ImportIntakeCsvDto
		);
		const dto = command();
		dto.rows = Array.from({ length: 250 }, () => ({
			title: 'a',
			name: 'b',
			phone: null,
			email: null,
			message: null
		}));
		await expect(validate(dto)).resolves.toHaveProperty(
			'rows.length',
			250
		);
	});
	it.each([0, 251])('rejects %i rows', async length => {
		const dto = command();
		dto.rows = Array.from({ length }, () => dto.rows[0]);
		await expect(validate(dto)).rejects.toBeInstanceOf(
			BadRequestException
		);
	});
	it.each([
		'../file.csv',
		'C:\\secret.csv',
		'a\n.csv',
		'a\0.csv',
		' ',
		'x'.repeat(201)
	])('rejects path/control/oversized labels', async label => {
		await expect(validate({ ...command(), label })).rejects.toBeInstanceOf(
			BadRequestException
		);
	});
	it.each(['phone', 'email', 'message'])(
		'requires nullable row key %s explicitly',
		async key => {
			const dto = command();
			delete (dto.rows[0] as unknown as Record<string, unknown>)[key];
			await expect(validate(dto)).rejects.toBeInstanceOf(
				BadRequestException
			);
		}
	);
	it.each([
		{ phone: '89001234567' },
		{ email: 'bad' },
		{ name: ' ' },
		{ title: 'x'.repeat(201) },
		{ message: 'x'.repeat(5001) },
		{ workspaceId: randomUUID() },
		{ createdBySubject: 'other' },
		{ teamId }
	])('rejects bad fields and per-row scope override', async row => {
		const dto = command();
		dto.rows[0] = { ...dto.rows[0], ...row };
		await expect(validate(dto)).rejects.toBeInstanceOf(
			BadRequestException
		);
	});
	it('rejects top-level raw CSV and missing team key without echoing values', async () => {
		const dto = { ...command(), rawCsv: 'private-csv-content' };
		try {
			await validate(dto);
			throw new Error('validation should reject');
		} catch (error) {
			expect(error).toBeInstanceOf(BadRequestException);
			expect(
				JSON.stringify((error as BadRequestException).getResponse())
			).not.toContain('private-csv-content');
		}
		delete (dto as Partial<typeof dto>).teamId;
		await expect(validate(dto)).rejects.toBeInstanceOf(
			BadRequestException
		);
	});
});

describe('CSV service authority, atomic command and scope', () => {
	it.each(malformedText)(
		'rejects malformed text before hashing or starting a transaction',
		async character => {
			for (const field of [
				'title',
				'name',
				'phone',
				'email',
				'message'
			] as const) {
				const { service, db } = setup();
				const dto = command();
				dto.rows[0][field] = `private-review-content${character}`;
				await expect(service.create(context, dto)).rejects.toMatchObject({
					response: {
						statusCode: 400,
						message: 'CSV text contains unsupported characters'
					}
				});
				expect(db.$transaction).not.toHaveBeenCalled();
			}
		}
	);
	it('bulk creates NEW CSV entries, independent audits and metadata-only receipt', async () => {
		const { service, tx, db } = setup();
		const dto = command();
		dto.rows.push({ ...dto.rows[0] });
		const result = await service.create(context, dto);
		expect(result).toEqual({
			schemaVersion: 1,
			import: {
				id: dto.commandId,
				workspaceId,
				createdBySubject: 'actor',
				teamId: null,
				label: dto.label,
				rowCount: 2,
				createdAt: '2026-09-05T00:00:00.000Z'
			}
		});
		expect(tx.inboxEntry.createMany.mock.calls[0][0].data).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					title: 'Запрос',
					name: 'Анна',
					email: 'anna@example.test',
					origin: 'CSV',
					status: 'NEW',
					sourceId: null
				})
			])
		);
		const ids = tx.intakeActivity.createMany.mock.calls[0][0].data.map(
			(row: { commandId: string }) => row.commandId
		);
		expect(new Set(ids).size).toBe(2);
		expect(ids).not.toContain(dto.commandId);
		expect(tx.intakeCommand.create.mock.calls[0][0].data.response).toEqual(
			result
		);
		expect(JSON.stringify(result)).not.toContain('anna');
		expect(db.$transaction.mock.calls[0][1]).toMatchObject({
			isolationLevel: 'Serializable',
			timeout: 5000
		});
		expect(String(tx.$executeRaw.mock.calls.at(-1)?.[0])).toContain(
			'IMMEDIATE'
		);
		await expect(service.create(context, dto)).resolves.toEqual(result);
		expect(tx.inboxEntry.createMany).toHaveBeenCalledTimes(1);
	});
	it.each([
		'READ_ONLY',
		'ANALYST',
		'missing-permission',
		'workspace',
		'team'
	])(
		'denies %s before entering transaction, including replay',
		async variant => {
			const { service, db } = setup();
			const dto = command();
			const denied = {
				...context,
				...(variant === 'READ_ONLY'
					? { state: 'READ_ONLY' as const }
					: variant === 'ANALYST'
						? { role: 'ANALYST' as const }
						: variant === 'missing-permission'
							? { permissions: ['intake:read'] }
							: variant === 'workspace'
								? { workspaceId: randomUUID() }
								: {})
			};
			if (variant === 'team') dto.teamId = randomUUID();
			await expect(service.create(denied, dto)).rejects.toBeInstanceOf(
				ForbiddenException
			);
			expect(db.$transaction).not.toHaveBeenCalled();
		}
	);
	it.each(['OWNER', 'CRM_ADMIN', 'TEAM_LEAD', 'MANAGER'] as const)(
		'permits writable GRACE %s with current team',
		async role => {
			const { service } = setup();
			await expect(
				service.create(
					{ ...context, role, state: 'GRACE' },
					{ ...command(), teamId }
				)
			).resolves.toHaveProperty('import.teamId', teamId);
		}
	);
	it('binds command to actor, workspace, exact input and row order', async () => {
		const { service } = setup();
		const dto = command();
		dto.rows.push({ ...dto.rows[0], name: 'Борис' });
		await service.create(context, dto);
		for (const changed of [
			{ ...dto, label: 'other.csv' },
			{ ...dto, rows: [...dto.rows].reverse() },
			{
				...dto,
				rows: dto.rows.map(row => ({
					...row,
					email: row.email?.toLowerCase() ?? null
				}))
			}
		])
			await expect(
				service.create(context, changed)
			).rejects.toBeInstanceOf(ConflictException);
		await expect(
			service.create({ ...context, subject: 'other' }, dto)
		).rejects.toBeInstanceOf(ConflictException);
		const otherWorkspace = randomUUID();
		await expect(
			service.create(
				{ ...context, workspaceId: otherWorkspace },
				{ ...dto, workspaceId: otherWorkspace }
			)
		).rejects.toBeInstanceOf(ConflictException);
	});
	it.each(['OWN', 'TEAM', 'ALL'] as const)(
		'uses fresh %s scope for metadata reads including READ_ONLY',
		async dataScope => {
			const { service, tx } = setup();
			const dto = command();
			await service.create(context, dto);
			await service.get(
				{ ...context, dataScope, state: 'READ_ONLY' },
				workspaceId,
				dto.commandId
			);
			const scope =
				tx.csvImport.findFirst.mock.calls.at(-1)?.[0].where.AND[0];
			expect(scope).toEqual({
				workspaceId,
				...(dataScope === 'ALL'
					? {}
					: dataScope === 'OWN'
						? { createdBySubject: 'actor' }
						: {
								OR: [
									{ createdBySubject: 'actor' },
									{ teamId: { in: [teamId] } }
								]
							})
			});
			tx.csvImport.findFirst.mockResolvedValue(null);
			await expect(
				service.get({ ...context, dataScope }, workspaceId, dto.commandId)
			).rejects.toBeInstanceOf(NotFoundException);
		}
	);
	it('retries nonblocking lock contention then returns a safe retryable error', async () => {
		const { service, tx } = setup();
		tx.$queryRaw.mockResolvedValue([{ locked: false }]);
		await expect(
			service.create(context, command())
		).rejects.toBeInstanceOf(ServiceUnavailableException);
		expect(tx.$queryRaw).toHaveBeenCalledTimes(6);
		expect(tx.csvImport.create).not.toHaveBeenCalled();
	});
	it('does not expose unexpected database errors or input in API errors', async () => {
		const { service, tx } = setup();
		tx.intakeCommand.create.mockRejectedValue(
			new Error('private contact payload')
		);
		await expect(service.create(context, command())).rejects.toMatchObject(
			{ response: { code: 'crm_intake_import_unavailable' } }
		);
		expect(tx.inboxEntry.createMany).toHaveBeenCalledTimes(1);
	});
});

describe('CSV controller fresh authentication', () => {
	it('authenticates every replay and read, failing before service access', async () => {
		const authorization = {
			authorize: jest.fn().mockResolvedValue(context)
		};
		const service = { create: jest.fn(), get: jest.fn() };
		const controller = new IntakeCsvImportController(
			authorization as unknown as IntakeAuthorizationClient,
			service as unknown as IntakeCsvImportService
		);
		const dto = command();
		await expect(
			controller.create('Bearer token', 'wrong', dto)
		).rejects.toBeInstanceOf(BadRequestException);
		expect(authorization.authorize).not.toHaveBeenCalled();
		await controller.create('Bearer first', dto.commandId, dto);
		await controller.create('Bearer second', dto.commandId, dto);
		await controller.get('Bearer third', dto.commandId, { workspaceId });
		expect(authorization.authorize.mock.calls).toEqual([
			['Bearer first', workspaceId],
			['Bearer second', workspaceId],
			['Bearer third', workspaceId]
		]);
		authorization.authorize.mockRejectedValue(new ForbiddenException());
		await expect(
			controller.create('Bearer disabled', dto.commandId, dto)
		).rejects.toBeInstanceOf(ForbiddenException);
		expect(service.create).toHaveBeenCalledTimes(2);
	});
});
