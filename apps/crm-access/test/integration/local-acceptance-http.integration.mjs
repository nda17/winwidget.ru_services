import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';

// Integration-only driver: real Intake transaction/claim and real downstream HTTP,
// without claiming that a broker delivered the event. No Customers/Sales DB imports.
export async function verifyAcceptanceHttp({
	servicesRoot,
	apiUrl,
	account,
	managerAccount,
	prepareTeamFixtures,
	intakeDatabaseUrl,
	environment,
	registerSecret,
	log
}) {
	assert.equal(apiUrl, 'http://localhost:4100/api/v1');
	const dbUrl = new URL(intakeDatabaseUrl);
	assert.equal(dbUrl.hostname, '127.0.0.1');
	assert.equal(dbUrl.port, '55440');
	assert.match(
		dbUrl.pathname,
		/^\/winwidget_crm_intake_test_browser_[a-f0-9]{10}_test$/
	);
	assert.equal(dbUrl.searchParams.get('schema'), 'crm_intake');
	const require = createRequire(
		join(servicesRoot, 'apps/crm-intake/package.json')
	);
	require('reflect-metadata');
	const { PrismaClient } = require('@prisma/crm-intake-client');
	const { IntakeAuthorizationClient } = require(
		join(
			servicesRoot,
			'apps/crm-intake/dist/src/access/intake-authorization.client.js'
		)
	);
	const { AcceptanceOperationsClient } = require(
		join(
			servicesRoot,
			'apps/crm-intake/dist/src/acceptance/acceptance-operations.client.js'
		)
	);
	const { AcceptanceProcessor } = require(
		join(
			servicesRoot,
			'apps/crm-intake/dist/src/acceptance/acceptance.processor.js'
		)
	);
	const { acceptanceBinding } = require(
		join(
			servicesRoot,
			'apps/crm-intake/dist/src/acceptance/acceptance.service.js'
		)
	);
	const previous = new Map(
		Object.keys(environment).map(key => [key, process.env[key]])
	);
	for (const [key, value] of Object.entries(environment))
		process.env[key] = value;
	const prisma = new PrismaClient({
		datasources: { db: { url: intakeDatabaseUrl } }
	});
	const operations = new AcceptanceOperationsClient();
	const processor = new AcceptanceProcessor(
		prisma,
		new IntakeAuthorizationClient(),
		operations
	);
	const workspaceId = account.workspaceId;
	const command = fields => ({
		schemaVersion: 1,
		workspaceId,
		commandId: randomUUID(),
		...fields
	});
	async function request(
		path,
		method = 'GET',
		body,
		token,
		expected = 200,
		extraHeaders = {}
	) {
		const response = await fetch(`${apiUrl}${path}`, {
			method,
			redirect: 'error',
			signal: AbortSignal.timeout(20000),
			headers: {
				'content-type': 'application/json',
				...(token ? { authorization: `Bearer ${token}` } : {}),
				...(body?.commandId ? { 'Idempotency-Key': body.commandId } : {}),
				...extraHeaders
			},
			...(body ? { body: JSON.stringify(body) } : {})
		});
		if (response.status !== expected) {
			await response.body?.cancel();
			throw new Error(
				`HTTP acceptance ${method} ${path.split('?')[0]} expected ${expected}, received ${response.status}`
			);
		}
		const data = await response.json();
		return data;
	}
	async function login(value) {
		const data = await request('/auth/login', 'POST', {
			email: value.email,
			password: value.password
		});
		assert.equal(data.user.id, value.userId);
		assert.equal(typeof data.accessToken, 'string');
		registerSecret(data.accessToken);
		return data.accessToken;
	}
	async function eventFor(id, generation = 1) {
		const row = await prisma.acceptanceOutbox.findUnique({
			where: { deduplicationKey: `${id}:${generation}:initial` }
		});
		assert.ok(row);
		assert.equal(row.payload.workspaceId, workspaceId);
		return row.payload;
	}
	try {
		const token = await login(account);
		const initial = await request(
			'/crm/access/bootstrap',
			'GET',
			undefined,
			token
		);
		assert.equal(initial.state, 'NOT_ACTIVATED');
		await request('/crm/access/trial', 'POST', command(), token);
		await request(
			'/crm/access/onboarding/template',
			'POST',
			command({ templateKey: 'universal-sales', templateVersion: 1 }),
			token
		);
		await prepareTeamFixtures();
		// Public source authentication must cross the real Gateway. A successful
		// direct call to Intake alone does not prove opaque Bearer routing works.
		const sourceToken = randomBytes(32).toString('base64url');
		registerSecret(sourceToken);
		const source = await request(
			'/crm/intake/sources',
			'POST',
			command({
				name: 'Local HTTP source proof',
				token: sourceToken,
				teamId: null
			}),
			token
		);
		const sourcePath = `/crm/intake/ingest/${source.source.id}`;
		const incoming = {
			schemaVersion: 1,
			title: 'HTTP external API proof',
			name: 'Локальный клиент API',
			email: 'api-proof@example.com'
		};
		const incomingHeaders = { 'Idempotency-Key': randomUUID() };
		const received = await request(
			sourcePath,
			'POST',
			incoming,
			sourceToken,
			200,
			incomingHeaders
		);
		const repeated = await request(
			sourcePath,
			'POST',
			incoming,
			sourceToken,
			200,
			incomingHeaders
		);
		assert.equal(repeated.entryId, received.entryId);
		await request(
			sourcePath,
			'POST',
			incoming,
			token,
			401,
			incomingHeaders
		);
		await request(
			`/crm/intake/inbox?workspaceId=${workspaceId}`,
			'GET',
			undefined,
			sourceToken,
			401
		);
		const sourceEntry = await request(
			`/crm/intake/inbox/${received.entryId}?workspaceId=${workspaceId}`,
			'GET',
			undefined,
			token
		);
		assert.equal(sourceEntry.entry.origin, 'API');
		assert.equal(sourceEntry.entry.status, 'NEW');
		assert.equal(sourceEntry.entry.sourceId, source.source.id);
		await request(
			`/crm/intake/sources/${source.source.id}/revoke`,
			'POST',
			command({ expectedVersion: source.source.version }),
			token
		);
		await request(
			sourcePath,
			'POST',
			incoming,
			sourceToken,
			401,
			incomingHeaders
		);
		assert.equal(
			(
				await request(
					`/crm/intake/inbox/${received.entryId}?workspaceId=${workspaceId}`,
					'GET',
					undefined,
					token
				)
			).entry.id,
			received.entryId
		);
		log(
			'Real Gateway source Bearer, fresh Intake authorization, replay, user JWT separation and revoke checks passed'
		);

		const csv = command({
			label: 'Local HTTP CSV proof',
			teamId: null,
			rows: Array.from({ length: 3 }, (_, index) => ({
				title: `HTTP CSV proof ${index + 1}`,
				name: 'Локальный клиент CSV',
				phone: null,
				email: 'csv-proof@example.com',
				message: 'Строка 1\nСтрока 2'
			}))
		});
		const imported = await request(
			'/crm/intake/imports/csv',
			'POST',
			csv,
			token
		);
		assert.equal(imported.import.id, csv.commandId);
		assert.equal(imported.import.rowCount, csv.rows.length);
		const csvReplay = await request(
			'/crm/intake/imports/csv',
			'POST',
			csv,
			token
		);
		assert.equal(csvReplay.import.id, imported.import.id);
		const csvReceipt = await request(
			`/crm/intake/imports/${csv.commandId}?workspaceId=${workspaceId}`,
			'GET',
			undefined,
			token
		);
		assert.deepEqual(csvReceipt, imported);
		const csvEntries = await request(
			`/crm/intake/inbox?workspaceId=${workspaceId}&search=HTTP%20CSV%20proof&page=1&pageSize=25`,
			'GET',
			undefined,
			token
		);
		assert.equal(csvEntries.total, 3);
		assert.ok(
			csvEntries.items.every(
				value =>
					value.origin === 'CSV' &&
					value.status === 'NEW' &&
					value.contactId === null &&
					value.dealId === null
			)
		);
		log(
			'Real HTTP atomic CSV import, receipt read, exact replay and Inbox-only creation checks passed'
		);

		const pipelines = await request(
			`/crm/sales/pipelines?workspaceId=${workspaceId}`,
			'GET',
			undefined,
			token
		);
		const pipeline = pipelines.items[0];
		assert.ok(pipeline);
		const stage = pipeline.stages.find(value => value.state === 'OPEN');
		assert.ok(stage);
		const deal = {
			title: 'HTTP acceptance proof',
			currency: 'RUB',
			amountMinor: 149900,
			pipelineId: pipeline.id,
			stageId: stage.id,
			nextTask: {
				title: 'Связаться с клиентом',
				dueAt: '2026-09-01T09:00:00.000Z'
			}
		};
		async function intent(actorToken, label) {
			const create = command({
				title: label,
				name: 'Локальный HTTP контакт'
			});
			const { entry } = await request(
				'/crm/intake/inbox',
				'POST',
				create,
				actorToken
			);
			const accept = command({
				expectedVersion: entry.version,
				contact: { mode: 'CREATE_FROM_ENTRY' },
				deal: { ...deal, title: label }
			});
			const response = await request(
				`/crm/intake/inbox/${entry.id}/accept`,
				'POST',
				accept,
				actorToken,
				202
			);
			assert.equal(response.acceptance.status, 'QUEUED');
			const replay = await request(
				`/crm/intake/inbox/${entry.id}/accept`,
				'POST',
				accept,
				actorToken,
				202
			);
			assert.equal(replay.acceptance.id, response.acceptance.id);
			assert.equal(
				(
					await request(
						`/crm/intake/inbox/${entry.id}?workspaceId=${workspaceId}`,
						'GET',
						undefined,
						actorToken
					)
				).entry.status,
				'NEW'
			);
			return {
				entry,
				accept,
				response,
				event: await eventFor(response.acceptance.id)
			};
		}
		const first = await intent(token, 'HTTP completed workflow');
		const claimed = await processor.claim(first.event, 0);
		assert.equal(claimed.state, 'CLAIMED');
		await processor.run(first.event, claimed.token);
		const completed = await request(
			`/crm/intake/inbox/${first.entry.id}/acceptance?workspaceId=${workspaceId}`,
			'GET',
			undefined,
			token
		);
		assert.equal(completed.acceptance.status, 'COMPLETED');
		const entry = await request(
			`/crm/intake/inbox/${first.entry.id}?workspaceId=${workspaceId}`,
			'GET',
			undefined,
			token
		);
		assert.equal(entry.entry.status, 'ACCEPTED');
		const { contact } = await request(
			`/crm/customers/contacts/${completed.acceptance.contactId}?workspaceId=${workspaceId}`,
			'GET',
			undefined,
			token
		);
		const { deal: storedDeal } = await request(
			`/crm/sales/deals/${completed.acceptance.dealId}?workspaceId=${workspaceId}`,
			'GET',
			undefined,
			token
		);
		assert.equal(contact.id, storedDeal.contactId);
		assert.equal(storedDeal.nextTask.id, completed.acceptance.firstTaskId);
		assert.equal(storedDeal.nextTask.dueAt, deal.nextTask.dueAt);
		const tasks = await request(
			`/crm/sales/tasks?workspaceId=${workspaceId}&page=1&pageSize=25`,
			'GET',
			undefined,
			token
		);
		assert.ok(
			tasks.items.some(
				task => task.id === completed.acceptance.firstTaskId
			)
		);
		assert.equal((await processor.claim(first.event, 0)).state, 'DONE');
		assert.equal(
			(
				await request(
					`/crm/customers/contacts?workspaceId=${workspaceId}&page=1&pageSize=25`,
					'GET',
					undefined,
					token
				)
			).total,
			1
		);
		assert.equal(
			(
				await request(
					`/crm/sales/deals?workspaceId=${workspaceId}&page=1&pageSize=25`,
					'GET',
					undefined,
					token
				)
			).total,
			1
		);
		const firstRow = await prisma.acceptance.findUnique({
			where: { id: first.response.acceptance.id }
		});
		await assert.rejects(
			() =>
				operations.request('customers', 'read', {
					...acceptanceBinding(firstRow, 'customers'),
					actorSubject: 'unrelated-actor'
				}),
			error => error?.getStatus?.() === 409
		);
		log(
			'Real HTTP Intake -> Customers -> Sales contact/deal/first-task, exact binding and replay checks passed'
		);

		const managerToken = await login(managerAccount);
		for (const [domain, entity, expectedRows] of [
			['customers', 'contacts', 1],
			['customers', 'companies', 0],
			['sales', 'deals', 1],
			['sales', 'tasks', 1],
			['intake', 'inbox', 5]
		]) {
			const exportPath = `/crm/${domain}/exports/${entity}?workspaceId=${workspaceId}`;
			for (const format of ['json', 'csv']) {
				const response = await fetch(
					`${apiUrl}${exportPath}&format=${format}`,
					{
						headers: {
							authorization: `Bearer ${token}`,
							origin: 'http://localhost:3001'
						},
						redirect: 'error',
						signal: AbortSignal.timeout(15000)
					}
				);
				assert.equal(response.status, 200, `${entity} ${format} export`);
				assert.equal(response.headers.get('cache-control'), 'no-store');
				assert.equal(
					response.headers.get('x-content-type-options'),
					'nosniff'
				);
				assert.equal(
					response.headers.get('x-wincrm-export-entity'),
					entity
				);
				assert.equal(
					response.headers.get('x-wincrm-workspace-id'),
					workspaceId
				);
				assert.equal(response.headers.get('x-wincrm-export-schema'), '1');
				assert.equal(
					response.headers.get('x-wincrm-export-rows'),
					String(expectedRows)
				);
				assert.equal(
					response.headers.get('x-wincrm-export-actor-sha256'),
					createHash('sha256').update(account.userId).digest('hex')
				);
				assert.ok(
					response.headers
						.get('access-control-expose-headers')
						?.toLowerCase()
						.includes('x-wincrm-export-bytes')
				);
				const bytes = Buffer.from(await response.arrayBuffer());
				assert.equal(
					Number(response.headers.get('x-wincrm-export-bytes')),
					bytes.length
				);
				if (format === 'json') {
					const data = JSON.parse(bytes.toString('utf8'));
					assert.equal(data.workspaceId, workspaceId);
					assert.equal(data.entity, entity);
					assert.equal(data.items.length, expectedRows);
					assert.ok(
						data.items.every(item => item.workspaceId === workspaceId)
					);
				} else {
					assert.equal(bytes.subarray(0, 3).toString('hex'), 'efbbbf');
					assert.ok(bytes.toString('utf8').includes('"workspaceId"'));
				}
			}
			await request(
				`${exportPath}&format=json`,
				'GET',
				undefined,
				managerToken,
				403
			);
		}
		log(
			'Real Gateway HTTP exports passed for five entities in JSON/CSV; current MANAGER cannot export'
		);
		const blocked = await intent(
			managerToken,
			'HTTP revoke-before-write workflow'
		);
		const members = await request(
			`/crm/access/team/members?workspaceId=${workspaceId}&page=1&pageSize=25`,
			'GET',
			undefined,
			token
		);
		const member = members.items.find(
			item => item.id === managerAccount.workflowMemberId
		);
		assert.ok(member);
		await request(
			`/crm/access/team/members/${member.id}/disable`,
			'POST',
			command({ expectedVersion: member.version }),
			token
		);
		managerAccount.crmDisabled = true;
		const blockedClaim = await processor.claim(blocked.event, 0);
		assert.equal(blockedClaim.state, 'CLAIMED');
		let denied;
		try {
			await processor.run(blocked.event, blockedClaim.token);
		} catch (error) {
			denied = error;
		}
		assert.equal(denied?.getStatus?.(), 403);
		assert.equal(
			await processor.fail(blocked.event, blockedClaim.token, 0, denied),
			true
		);
		const failed = await request(
			`/crm/intake/inbox/${blocked.entry.id}/acceptance?workspaceId=${workspaceId}`,
			'GET',
			undefined,
			token
		);
		assert.equal(failed.acceptance.status, 'BLOCKED');
		assert.equal(failed.acceptance.contactId, null);
		assert.equal(failed.acceptance.dealId, null);
		await request(
			`/crm/intake/inbox/${blocked.entry.id}?workspaceId=${workspaceId}`,
			'GET',
			undefined,
			managerToken,
			403
		);
		const recovery = await request(
			`/crm/intake/inbox/${blocked.entry.id}/acceptance/recover`,
			'POST',
			command({ expectedVersion: failed.acceptance.version }),
			token,
			202
		);
		const recoveryEvent = await eventFor(recovery.acceptance.id, 2);
		const recoveryClaim = await processor.claim(recoveryEvent, 0);
		await processor.run(recoveryEvent, recoveryClaim.token);
		const cancelled = await request(
			`/crm/intake/inbox/${blocked.entry.id}/acceptance?workspaceId=${workspaceId}`,
			'GET',
			undefined,
			token
		);
		assert.equal(cancelled.acceptance.status, 'CANCELLED');
		const cancelledRow = await prisma.acceptance.findUnique({
			where: { id: cancelled.acceptance.id }
		});
		for (const target of ['customers', 'sales'])
			assert.equal(
				(
					await operations.request(
						target,
						'read',
						acceptanceBinding(cancelledRow, target)
					)
				).state,
				'CANCELLED'
			);
		assert.equal(
			(
				await request(
					`/crm/customers/contacts?workspaceId=${workspaceId}&page=1&pageSize=25`,
					'GET',
					undefined,
					token
				)
			).total,
			1
		);
		assert.equal(
			(
				await request(
					`/crm/sales/deals?workspaceId=${workspaceId}&page=1&pageSize=25`,
					'GET',
					undefined,
					token
				)
			).total,
			1
		);
		log(
			'Real HTTP fresh CRM-role revocation blocks new writes; administrator recovery closes both operation slots without deleting entities'
		);
		log(
			'HTTP workflow gate passed with a test-only claimed-event driver; RabbitMQ transport NOT exercised'
		);
	} finally {
		await prisma.$disconnect();
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}
