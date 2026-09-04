import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

const runtimeUrl = required('CRM_INTAKE_TEST_DATABASE_URL');
const migrationUrl = required('CRM_INTAKE_TEST_MIGRATION_DATABASE_URL');
const expectedRole = required('CRM_INTAKE_TEST_RUNTIME_ROLE');
if (process.env.CRM_INTAKE_INTEGRATION_ALLOW_MUTATION !== 'true')
	throw new Error(
		'CRM_INTAKE_INTEGRATION_ALLOW_MUTATION=true is required'
	);
assert.equal(
	local(runtimeUrl),
	local(migrationUrl),
	'Both roles must use the same isolated test database'
);

const { PrismaClient } = await import('@prisma/crm-intake-client');
const module = await import('../../dist/src/intake/intake.service.js');
const IntakeService = module.IntakeService || module.default.IntakeService;
const ingestionModule =
	await import('../../dist/src/intake/intake-ingestion.service.js');
const { IntakeIngestionService, IntakeIngestionRateLimiter } =
	ingestionModule.default || ingestionModule;
const runtime = new PrismaClient({
	datasources: { db: { url: runtimeUrl } }
});
const migrator = new PrismaClient({
	datasources: { db: { url: migrationUrl } }
});
const service = new IntakeService(runtime);
const workspaceIds = [randomUUID(), randomUUID(), randomUUID()];
const context = access(workspaceIds[0]);
const token = randomBytes(32).toString('base64url');
const peerIp = `fd00:${randomBytes(2).toString('hex')}:${randomBytes(2).toString('hex')}::1`;
const peerBucketKey = `ip:${createHash('sha256').update(peerIp).digest('hex')}`;

try {
	const [version] = await runtime.$queryRawUnsafe(
		"SELECT current_setting('server_version_num')::integer AS version"
	);
	assert.equal(Math.floor(version.version / 10000), 18);
	const [role] = await runtime.$queryRawUnsafe(
		'SELECT current_user AS name, NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolbypassrls AS restricted FROM pg_roles WHERE rolname = current_user'
	);
	assert.equal(role.name, expectedRole);
	assert.equal(role.restricted, true);
	for (const table of [
		'intake_commands',
		'intake_activities',
		'inbound_receipts'
	]) {
		await assert.rejects(
			runtime.$executeRawUnsafe(
				`UPDATE crm_intake.${table} SET workspace_id=workspace_id WHERE false`
			),
			sqlState('42501')
		);
		await assert.rejects(
			runtime.$executeRawUnsafe(
				`DELETE FROM crm_intake.${table} WHERE false`
			),
			sqlState('42501')
		);
	}
	for (const table of ['inbox_entries', 'intake_sources'])
		await assert.rejects(
			runtime.$executeRawUnsafe(
				`DELETE FROM crm_intake.${table} WHERE false`
			),
			sqlState('42501')
		);
	await assert.rejects(
		runtime.$queryRawUnsafe(
			'SELECT migration_name FROM crm_intake._prisma_migrations LIMIT 0'
		),
		sqlState('42501')
	);
	await assert.rejects(
		runtime.$executeRawUnsafe(
			'UPDATE crm_intake.service_identity SET service_name=service_name WHERE false'
		),
		sqlState('42501')
	);

	const create = command(context.workspaceId, {
		title: 'Ручное обращение',
		name: 'Анна',
		phone: '+79000000001',
		email: 'ANNA@EXAMPLE.TEST'
	});
	const first = await service.createManual(context, create);
	assert.equal(first.entry.status, 'NEW');
	assert.equal(first.entry.origin, 'MANUAL');
	assert.equal(first.entry.contactId, null);
	assert.equal(first.entry.dealId, null);
	assert.equal(first.entry.email, 'anna@example.test');
	assert.deepEqual(await service.createManual(context, create), first);
	assert.equal(
		await runtime.intakeActivity.count({
			where: { commandId: create.commandId }
		}),
		1
	);
	await assert.rejects(
		service.createManual(context, { ...create, title: 'Иное обращение' }),
		http(409)
	);
	await assert.rejects(
		service.createManual({ ...context, subject: 'other' }, create),
		http(409)
	);
	await assert.rejects(
		service.createManual(
			{ ...context, state: 'READ_ONLY' },
			command(context.workspaceId, { title: 'Нет', name: 'Нет' })
		),
		http(403)
	);
	assert.equal(
		(
			await service.get(
				{ ...context, state: 'READ_ONLY' },
				context.workspaceId,
				first.entry.id
			)
		).entry.id,
		first.entry.id
	);
	await assert.rejects(
		service.get(access(workspaceIds[1]), workspaceIds[1], first.entry.id),
		http(404)
	);
	await assert.rejects(
		service.get(
			{ ...context, subject: 'other', dataScope: 'OWN' },
			context.workspaceId,
			first.entry.id
		),
		http(404)
	);
	await assert.rejects(
		runtime.$executeRawUnsafe(
			'UPDATE crm_intake.inbox_entries SET status=$1 WHERE id=$2::uuid',
			'ACCEPTED',
			first.entry.id
		),
		sqlState('23514')
	);
	await assert.rejects(
		runtime.$executeRawUnsafe(
			'UPDATE crm_intake.inbox_entries SET origin=$1 WHERE id=$2::uuid',
			'API',
			first.entry.id
		),
		sqlState('23514')
	);

	const concurrent = command(context.workspaceId, {
		title: 'Параллельная команда',
		name: 'Тест'
	});
	const created = await Promise.all([
		service.createManual(context, concurrent),
		service.createManual(context, concurrent)
	]);
	assert.deepEqual(created[0], created[1]);
	const rejections = await Promise.allSettled([
		service.reject(
			context,
			first.entry.id,
			command(context.workspaceId, { expectedVersion: 1, reason: 'Дубль' })
		),
		service.reject(
			context,
			first.entry.id,
			command(context.workspaceId, {
				expectedVersion: 1,
				reason: 'Ошибочное обращение'
			})
		)
	]);
	assert.equal(
		rejections.filter(result => result.status === 'fulfilled').length,
		1
	);
	assert.equal(
		rejections.filter(
			result => result.status === 'rejected' && http(409)(result.reason)
		).length,
		1
	);
	const rejected = await service.get(
		context,
		context.workspaceId,
		first.entry.id
	);
	assert.equal(rejected.entry.status, 'REJECTED');
	assert.equal(rejected.entry.version, 2);
	assert.ok(rejected.entry.rejectionReason);
	assert.equal(
		(
			await service.list(context, {
				workspaceId: context.workspaceId,
				page: 1,
				pageSize: 1,
				status: 'REJECTED'
			})
		).total,
		1
	);
	assert.equal(
		(
			await service.activities(context, first.entry.id, {
				workspaceId: context.workspaceId,
				page: 1,
				pageSize: 25
			})
		).total,
		2
	);

	const teamId = randomUUID();
	const teamContext = {
		...context,
		subject: 'manager',
		dataScope: 'TEAM',
		teamIds: [teamId]
	};
	const teamEntry = await service.createManual(
		teamContext,
		command(context.workspaceId, {
			title: 'Команда',
			name: 'Клиент команды',
			teamId
		})
	);
	assert.equal(
		(
			await service.get(
				{ ...teamContext, subject: 'lead' },
				context.workspaceId,
				teamEntry.entry.id
			)
		).entry.id,
		teamEntry.entry.id
	);
	await assert.rejects(
		service.get(
			{ ...teamContext, subject: 'lead', teamIds: [] },
			context.workspaceId,
			teamEntry.entry.id
		),
		http(404)
	);

	const sourceCommand = command(context.workspaceId, {
		name: 'Форма сайта',
		token
	});
	const source = await service.createSource(context, sourceCommand);
	assert.deepEqual(
		await service.createSource(context, sourceCommand),
		source
	);
	for (const response of [
		source,
		await service.listSources(context, {
			workspaceId: context.workspaceId,
			page: 1,
			pageSize: 25
		}),
		await runtime.intakeCommand.findUnique({
			where: { commandId: sourceCommand.commandId }
		}),
		await runtime.intakeActivity.findUnique({
			where: { commandId: sourceCommand.commandId }
		})
	]) {
		assert.equal(JSON.stringify(response).includes(token), false);
	}
	assert.equal('tokenHash' in source.source, false);
	assert.equal('token' in source.source, false);
	await assert.rejects(
		service.createSource(
			context,
			command(context.workspaceId, { name: 'Другой источник', token })
		),
		http(409)
	);
	await assert.rejects(
		service.createSource(
			{ ...context, role: 'MANAGER' },
			command(context.workspaceId, {
				name: 'Источник',
				token: randomBytes(32).toString('base64url')
			})
		),
		http(403)
	);
	await assert.rejects(
		service.rotateSource(
			access(workspaceIds[1]),
			source.source.id,
			command(workspaceIds[1], {
				expectedVersion: 1,
				token: randomBytes(32).toString('base64url')
			})
		),
		http(404)
	);
	let sourceAuthority = context;
	let sourceChecks = 0;
	const authorization = {
		authorizeSource: async (workspaceId, subject) => {
			sourceChecks++;
			assert.equal(workspaceId, context.workspaceId);
			assert.equal(subject, context.subject);
			return sourceAuthority;
		}
	};
	const limits = new IntakeIngestionRateLimiter(runtime);
	const ingestion = new IntakeIngestionService(
		runtime,
		authorization,
		limits
	);
	const inboundKey = randomUUID();
	const inboundBody = {
		schemaVersion: 1,
		title: 'Форма API',
		name: 'Внешний клиент',
		phone: '+79000000002',
		email: 'API@EXAMPLE.TEST',
		message: 'Прислано через API'
	};
	const send = (
		key = inboundKey,
		body = inboundBody,
		sourceToken = token,
		sourceId = source.source.id
	) =>
		ingestion.ingest(sourceId, `Bearer ${sourceToken}`, key, body, peerIp);
	const received = await send();
	assert.deepEqual(Object.keys(received), [
		'schemaVersion',
		'entryId',
		'receivedAt'
	]);
	assert.deepEqual(await send(), received);
	assert.equal(sourceChecks, 2);
	const apiEntry = await runtime.inboxEntry.findUnique({
		where: { id: received.entryId }
	});
	assert.equal(apiEntry.origin, 'API');
	assert.equal(apiEntry.status, 'NEW');
	assert.equal(apiEntry.createdBySubject, context.subject);
	assert.equal(apiEntry.workspaceId, context.workspaceId);
	assert.equal(apiEntry.sourceId, source.source.id);
	assert.equal(apiEntry.email, 'api@example.test');
	await assert.rejects(
		send(inboundKey, { ...inboundBody, name: 'Changed' }),
		http(409)
	);
	await assert.rejects(
		send(inboundKey, inboundBody, randomBytes(32).toString('base64url')),
		http(401)
	);
	const concurrentKey = randomUUID();
	const concurrentResults = await Promise.all(
		Array.from({ length: 6 }, () => send(concurrentKey))
	);
	assert.ok(
		concurrentResults.every(
			result => result.entryId === concurrentResults[0].entryId
		)
	);
	assert.equal(
		await runtime.inboundReceipt.count({
			where: {
				sourceId: source.source.id,
				externalCommandId: concurrentKey
			}
		}),
		1
	);
	sourceAuthority = { ...context, state: 'READ_ONLY' };
	await assert.rejects(send(), http(403));
	sourceAuthority = { ...context, role: 'MANAGER' };
	await assert.rejects(send(), http(403));
	sourceAuthority = context;
	assert.deepEqual(await send(), received);
	const secondToken = randomBytes(32).toString('base64url');
	const secondSource = await service.createSource(
		context,
		command(context.workspaceId, {
			name: 'Вторая форма',
			token: secondToken
		})
	);
	const secondReceived = await send(
		inboundKey,
		inboundBody,
		secondToken,
		secondSource.source.id
	);
	assert.notEqual(secondReceived.entryId, received.entryId);
	const failInbound = new IntakeIngestionService(
		failDelegateCreate(runtime, 'inboundReceipt'),
		authorization,
		limits
	);
	const beforeFailure = await runtime.inboxEntry.count({
		where: { workspaceId: context.workspaceId }
	});
	const beforeActivityFailure = await runtime.intakeActivity.count({
		where: { workspaceId: context.workspaceId }
	});
	await assert.rejects(
		failInbound.ingest(
			source.source.id,
			`Bearer ${token}`,
			randomUUID(),
			inboundBody,
			peerIp
		),
		http(503)
	);
	assert.equal(
		await runtime.inboxEntry.count({
			where: { workspaceId: context.workspaceId }
		}),
		beforeFailure
	);
	assert.equal(
		await runtime.intakeActivity.count({
			where: { workspaceId: context.workspaceId }
		}),
		beforeActivityFailure
	);
	const raceToken = randomBytes(32).toString('base64url');
	const raceIngestion = new IntakeIngestionService(
		runtime,
		{
			authorizeSource: async () => {
				await service.rotateSource(
					context,
					secondSource.source.id,
					command(context.workspaceId, {
						expectedVersion: 1,
						token: raceToken
					})
				);
				return context;
			}
		},
		limits
	);
	await assert.rejects(
		raceIngestion.ingest(
			secondSource.source.id,
			`Bearer ${secondToken}`,
			randomUUID(),
			inboundBody,
			peerIp
		),
		http(401)
	);
	assert.deepEqual(
		await send(inboundKey, inboundBody, raceToken, secondSource.source.id),
		secondReceived
	);
	await runtime.$executeRawUnsafe(
		"INSERT INTO crm_intake.ingestion_rate_buckets (bucket_key, window_start, count) SELECT $1, date_trunc('minute', clock_timestamp() AT TIME ZONE 'UTC') + (offset_minutes * interval '1 minute'), 120 FROM generate_series(0, 1) offset_minutes ON CONFLICT (bucket_key, window_start) DO UPDATE SET count=120",
		`source:${secondSource.source.id}`
	);
	await assert.rejects(
		send(randomUUID(), inboundBody, raceToken, secondSource.source.id),
		http(429)
	);
	for (const receipt of await runtime.inboundReceipt.findMany({
		where: { workspaceId: context.workspaceId }
	})) {
		assert.equal(JSON.stringify(receipt).includes(token), false);
		assert.equal(
			JSON.stringify(receipt).includes(inboundBody.message),
			false
		);
		assert.equal(
			await runtime.intakeActivity.count({
				where: { commandId: receipt.auditCommandId }
			}),
			1
		);
	}
	const rotate = command(context.workspaceId, {
		expectedVersion: 1,
		token: randomBytes(32).toString('base64url')
	});
	const rotated = await service.rotateSource(
		context,
		source.source.id,
		rotate
	);
	assert.equal(rotated.source.tokenVersion, 2);
	assert.equal(rotated.source.version, 2);
	await assert.rejects(send(), http(401));
	assert.deepEqual(
		await send(inboundKey, inboundBody, rotate.token),
		received
	);
	assert.deepEqual(
		await service.rotateSource(context, source.source.id, rotate),
		rotated
	);
	const revoke = command(context.workspaceId, { expectedVersion: 2 });
	const revoked = await service.revokeSource(
		context,
		source.source.id,
		revoke
	);
	assert.ok(revoked.source.revokedAt);
	assert.equal(revoked.source.version, 3);
	await assert.rejects(
		send(inboundKey, inboundBody, rotate.token),
		http(401)
	);
	assert.deepEqual(
		await service.revokeSource(context, source.source.id, revoke),
		revoked
	);
	await assert.rejects(
		service.rotateSource(
			context,
			source.source.id,
			command(context.workspaceId, {
				expectedVersion: 3,
				token: randomBytes(32).toString('base64url')
			})
		),
		http(409)
	);
	assert.equal(
		(
			await service.listSources(
				{ ...context, state: 'READ_ONLY', permissions: ['intake:read'] },
				{ workspaceId: context.workspaceId, page: 1, pageSize: 25 }
			)
		).total,
		2
	);

	const failure = new IntakeService(
		new Proxy(runtime, {
			get(target, key) {
				if (key === '$transaction')
					return (callback, options) =>
						target.$transaction(
							tx =>
								callback(
									new Proxy(tx, {
										get(transaction, property) {
											if (property === 'intakeCommand')
												return {
													...transaction.intakeCommand,
													create: async () => {
														throw new Error(
															'forced intake receipt failure'
														);
													}
												};
											const value = Reflect.get(transaction, property);
											return typeof value === 'function'
												? value.bind(transaction)
												: value;
										}
									})
								),
							options
						);
				const value = Reflect.get(target, key);
				return typeof value === 'function' ? value.bind(target) : value;
			}
		})
	);
	await assert.rejects(
		failure.createManual(
			access(workspaceIds[2]),
			command(workspaceIds[2], { title: 'Rollback', name: 'Rollback' })
		),
		/forced intake receipt failure/
	);
	for (const delegate of ['inboxEntry', 'intakeCommand', 'intakeActivity'])
		assert.equal(
			await runtime[delegate].count({
				where: { workspaceId: workspaceIds[2] }
			}),
			0
		);
	console.log(
		'CRM Intake PostgreSQL 18 Inbox, CAS, replay, API ingestion, source authentication, rotation race, durable rate limits, rollback, tenant/team scope and append-only grants passed'
	);
} finally {
	try {
		await migrator.$transaction(async tx => {
			const where = { workspaceId: { in: workspaceIds } };
			const sources = await tx.intakeSource.findMany({
				where,
				select: { id: true }
			});
			await tx.ingestionRateBucket.deleteMany({
				where: {
					bucketKey: {
						in: [
							peerBucketKey,
							...sources.map(source => `source:${source.id}`)
						]
					}
				}
			});
			await tx.inboundReceipt.deleteMany({ where });
			await tx.intakeActivity.deleteMany({ where });
			await tx.intakeCommand.deleteMany({ where });
			await tx.inboxEntry.deleteMany({ where });
			await tx.intakeSource.deleteMany({ where });
		});
	} finally {
		await Promise.all([runtime.$disconnect(), migrator.$disconnect()]);
	}
}

function failDelegateCreate(client, delegate) {
	return new Proxy(client, {
		get(target, key) {
			if (key === '$transaction')
				return (callback, options) =>
					target.$transaction(
						tx =>
							callback(
								new Proxy(tx, {
									get(transaction, property) {
										if (property === delegate)
											return {
												...transaction[delegate],
												create: async () => {
													throw new Error(
														'forced isolated receipt failure'
													);
												}
											};
										const value = Reflect.get(transaction, property);
										return typeof value === 'function'
											? value.bind(transaction)
											: value;
									}
								})
							),
						options
					);
			const value = Reflect.get(target, key);
			return typeof value === 'function' ? value.bind(target) : value;
		}
	});
}

function access(workspaceId) {
	return {
		schemaVersion: 1,
		workspaceId,
		subject: 'owner',
		role: 'OWNER',
		state: 'ACTIVE',
		dataScope: 'ALL',
		teamIds: [],
		permissions: ['intake:read', 'intake:write', 'intake:manage-sources']
	};
}
function command(workspaceId, fields = {}) {
	return {
		schemaVersion: 1,
		workspaceId,
		commandId: randomUUID(),
		...fields
	};
}
function http(status) {
	return error => error?.getStatus?.() === status;
}
function sqlState(state) {
	return error => error?.meta?.code === state || error?.code === state;
}
function required(name) {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`${name} is required`);
	return value;
}
function local(value) {
	const url = new URL(value);
	if (
		!['postgres:', 'postgresql:'].includes(url.protocol) ||
		!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
		!/(?:_test|_ci)$/.test(url.pathname) ||
		url.searchParams.get('schema') !== 'crm_intake'
	)
		throw new Error(
			'Intake integration requires a loopback isolated _test/_ci database with crm_intake schema'
		);
	return `${url.hostname}:${url.port}${url.pathname}`;
}
