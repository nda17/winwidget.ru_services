import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
	NATIVE_ACCEPTANCE_EVENT,
	NATIVE_ACCEPTANCE_QUEUE,
	NATIVE_IMAGE_ROLES
} from './local-native-images.mjs';

const command = (workspaceId, fields = {}) => ({
	schemaVersion: 1,
	workspaceId,
	commandId: randomUUID(),
	...fields
});

// Normal versioned HTTP commands; the separately declared synthetic membership
// fixture is not an invitation/admission or browser proof.
export async function changeNativeMember(
	request,
	workspaceId,
	memberId,
	fields
) {
	const roster = await request(
		`/crm/access/team/members?workspaceId=${workspaceId}&page=1&pageSize=100`
	);
	assert.deepEqual(roster.quota, {
		seatLimit: 2,
		usedSeats: 2,
		waitingCount: 0
	});
	const member = roster.items.find(item => item.id === memberId);
	assert.ok(member && member.disabledAt === null);
	const action = Object.hasOwn(fields, 'role')
		? 'change-role'
		: 'set-teams';
	return request(`/crm/access/team/members/${memberId}/${action}`, {
		body: command(workspaceId, {
			expectedVersion: member.version,
			...fields
		})
	});
}

export async function verifyNativeInboxScope({
	request,
	account,
	managerAccount,
	foreignAccount,
	managerToken,
	evidence,
	fixtures
}) {
	assert.equal(evidence.length, 6);
	assert.equal(fixtures.length, 6);
	const workspaceId = account.workspaceId;
	const suffix = `?workspaceId=${workspaceId}`;
	const own = new Set(
		fixtures
			.filter(item => item.creatorSubject === managerAccount.userId)
			.map(item => item.widgetType)
	);
	assert.equal(own.size, 3);
	const read = async (allowed, actorToken) => {
		const page = await request(
			'/crm/intake/inbox' + suffix + '&page=1&pageSize=25',
			{ actorToken }
		);
		for (const item of evidence) {
			const visible = allowed(item);
			assert.equal(
				page.items.some(row => row.id === item.entryId),
				visible
			);
			for (const tail of ['', '/widget-details']) {
				const reply = await request(
					'/crm/intake/inbox/' + item.entryId + tail + suffix,
					{
						actorToken,
						expected: visible ? 200 : 404
					}
				);
				if (visible && tail)
					assert.equal(reply.payload.widget.type, item.widgetType);
				if (visible && !tail) {
					assert.equal(reply.entry.origin, 'WIDGET');
					assert.equal(reply.entry.name, null);
					assert.equal(reply.entry.teamId, managerAccount.crmTeamId);
				}
			}
		}
	};
	await changeNativeMember(
		request,
		workspaceId,
		managerAccount.crmMemberId,
		{ role: 'MANAGER' }
	);
	await read(item => own.has(item.widgetType), managerToken);
	await changeNativeMember(
		request,
		workspaceId,
		managerAccount.crmMemberId,
		{ role: 'TEAM_LEAD' }
	);
	await read(() => true, managerToken);
	await changeNativeMember(
		request,
		workspaceId,
		managerAccount.crmMemberId,
		{ teamIds: [] }
	);
	// TEAM retains one's own records but must immediately lose another actor's
	// records from the removed team. An old access result cannot be reused.
	await read(item => own.has(item.widgetType), managerToken);
	await changeNativeMember(
		request,
		workspaceId,
		managerAccount.crmMemberId,
		{ teamIds: [managerAccount.crmTeamId] }
	);
	await read(() => true, managerToken);
	await changeNativeMember(
		request,
		workspaceId,
		managerAccount.crmMemberId,
		{ role: 'ANALYST' }
	);
	for (const item of evidence) {
		for (const tail of ['', '/widget-details'])
			await request('/crm/intake/inbox/' + item.entryId + tail + suffix, {
				actorToken: managerToken,
				expected: 403
			});
	}
	await changeNativeMember(
		request,
		workspaceId,
		managerAccount.crmMemberId,
		{ role: 'TEAM_LEAD' }
	);
	const session = await request('/auth/login', {
		anonymous: true,
		body: {
			email: foreignAccount.email,
			password: foreignAccount.password
		}
	});
	assert.equal(session.user.id, foreignAccount.userId);
	assert.ok(
		typeof session.accessToken === 'string' &&
			session.accessToken.length > 100
	);
	assert.notEqual(foreignAccount.workspaceId, workspaceId);
	await request('/crm/access/trial', {
		actorToken: session.accessToken,
		body: command(foreignAccount.workspaceId)
	});
	await request('/crm/access/onboarding/template', {
		actorToken: session.accessToken,
		body: command(foreignAccount.workspaceId, {
			templateKey: 'universal-sales',
			templateVersion: 1
		})
	});
	for (const item of evidence) {
		for (const tail of ['', '/widget-details']) {
			const path = '/crm/intake/inbox/' + item.entryId + tail;
			await request(path + suffix, {
				actorToken: session.accessToken,
				expected: 403
			});
			await request(path + '?workspaceId=' + foreignAccount.workspaceId, {
				actorToken: session.accessToken,
				expected: 404
			});
		}
	}
	return {
		nativeSnapshotScopesVerified: ['OWN', 'TEAM', 'ALL'],
		nativeSnapshotScopeWidgetTypes: evidence.map(item => item.widgetType),
		nativeTeamRevocationVerified: true,
		nativeCrossWorkspaceDenied: true,
		nativeAnalystPiiDenied: true,
		fixtureMembershipsSeeded: true,
		invitationAdmissionVerified: false
	};
}

export async function verifyNativeInboxAcceptance({
	runtime,
	request,
	intakeDb,
	workspaceId,
	evidence,
	serviceEnvironment,
	restart,
	existingSubmission
}) {
	const suffix = '?workspaceId=' + workspaceId;
	const pipelines = await request('/crm/sales/pipelines' + suffix);
	const pipeline = pipelines.items[0];
	const stage = pipeline?.stages.find(item => item.state === 'OPEN');
	assert.ok(stage);
	const workflows = [];
	const intents = new Map();
	const dueAt = new Date(Date.now() + 86400000).toISOString();
	const makeIntent = (entry, contact, title) =>
		command(workspaceId, {
			expectedVersion: entry.version,
			contact,
			deal: {
				title,
				currency: 'RUB',
				amountMinor: 149900,
				pipelineId: pipeline.id,
				stageId: stage.id,
				nextTask: { title: 'Связаться с клиентом', dueAt }
			}
		});
	for (const item of evidence) {
		const path = '/crm/intake/inbox/' + item.entryId;
		const { entry } = await request(path + suffix);
		assert.equal(entry.origin, 'WIDGET');
		assert.equal(entry.name, null);
		await request(path + '/accept', {
			body: makeIntent(
				entry,
				{ mode: 'CREATE_FROM_ENTRY' },
				'Missing contact name'
			),
			expected: 400
		});
		assert.equal(
			await intakeDb.acceptance.count({
				where: { workspaceId, entryId: item.entryId }
			}),
			0
		);
		const name = 'Подтверждённый клиент ' + item.widgetType;
		const intent = makeIntent(
			entry,
			{ mode: 'CREATE_FROM_ENTRY', name },
			'Native ' + item.widgetType
		);
		const queued = await request(path + '/accept', {
			body: intent,
			expected: 202
		});
		assert.equal(queued.acceptance.status, 'QUEUED');
		assert.deepEqual(
			await request(path + '/accept', { body: intent, expected: 202 }),
			queued
		);
		workflows.push({
			id: queued.acceptance.id,
			entryId: item.entryId,
			name,
			phone: entry.phone
		});
		intents.set(item.entryId, { intent, queued });
	}
	assert.equal(
		await intakeDb.acceptanceOutbox.count({
			where: { status: 'PENDING' }
		}),
		6
	);
	// Exercise the production retry interval with actual images. No clock changes,
	// direct receipt edits or in-process workers may stand in for broker delivery.
	await runtime.stop(runtime.processes.get('crm-customers').id);
	for (const spec of NATIVE_IMAGE_ROLES.filter(item =>
		item[0].includes('-acceptance-')
	))
		await runtime.startNativeRole(spec, serviceEnvironment(spec[1]));
	const ids = workflows.map(item => item.id);
	await runtime.wait(
		async () =>
			(await intakeDb.acceptance.count({
				where: { id: { in: ids }, status: 'RETRY_WAIT' }
			})) === 6,
		'Acceptance did not persist retry after Customers outage'
	);
	await runtime.wait(
		async () =>
			(await intakeDb.acceptanceOutbox.count({
				where: { retryAttempt: 0, status: 'PUBLISHED' }
			})) === 6,
		'Initial acceptance publications were not confirmed'
	);
	await runtime.stop(
		runtime.processes.get('crm-intake-acceptance-publisher').id
	);
	await runtime.stop(
		runtime.processes.get('crm-intake-acceptance-worker').id
	);
	const retries = await intakeDb.acceptanceOutbox.findMany({
		where: { retryAttempt: 1 }
	});
	assert.equal(retries.length, 6);
	for (const row of retries) {
		assert.equal(row.route, 'MAIN');
		assert.equal(row.status, 'PENDING');
		assert.ok(
			row.availableAt.getTime() - row.createdAt.getTime() >= 29000
		);
	}
	assert.equal(
		await intakeDb.acceptanceReceipt.count({
			where: {
				workflowId: { in: ids },
				status: 'RETRY_SCHEDULED',
				retryAttempt: 1
			}
		}),
		6
	);
	await runtime.stop(runtime.brokerId);
	await runtime.docker(['start', runtime.brokerId]);
	await runtime.wait(
		async () =>
			(
				await runtime.command('docker', [
					'--context',
					'colima',
					'exec',
					'--user=rabbitmq',
					runtime.brokerId,
					'rabbitmq-diagnostics',
					'-q',
					'check_port_connectivity'
				])
			).code === 0,
		'Acceptance broker recovery deadline'
	);
	await restart('crm-customers');
	await restart('crm-intake-acceptance-worker');
	await restart('crm-intake-acceptance-publisher');
	await runtime.wait(
		async () =>
			(await intakeDb.acceptance.count({
				where: { id: { in: ids }, status: 'COMPLETED' }
			})) === 6,
		'Acceptance retry did not complete after real process/broker restart',
		// Production retries are 30 seconds, then 5 minutes. Reconnection and
		// parallel downstream calls can legitimately need the second attempt.
		// Keep the actual schedule; a two-minute test deadline would cut it short.
		6 * 60_000
	);
	for (const original of retries) {
		const row = await intakeDb.acceptanceOutbox.findUniqueOrThrow({
			where: { id: original.id }
		});
		assert.equal(row.status, 'PUBLISHED');
		assert.equal(
			row.availableAt.getTime(),
			original.availableAt.getTime()
		);
		assert.ok(row.publishedAt.getTime() >= original.availableAt.getTime());
	}
	let existingContact;
	for (const item of workflows) {
		const path = '/crm/intake/inbox/' + item.entryId;
		const { acceptance } = await request(path + '/acceptance' + suffix);
		assert.equal(acceptance.status, 'COMPLETED');
		const { contact } = await request(
			'/crm/customers/contacts/' + acceptance.contactId + suffix
		);
		const { deal } = await request(
			'/crm/sales/deals/' + acceptance.dealId + suffix
		);
		assert.equal(contact.name, item.name);
		assert.equal(contact.phone, item.phone);
		assert.equal(deal.contactId, contact.id);
		assert.equal(deal.nextTask.id, acceptance.firstTaskId);
		assert.equal(deal.nextTask.dueAt, dueAt);
		const { entry } = await request(path + suffix);
		assert.equal(entry.status, 'ACCEPTED');
		assert.equal(
			entry.name,
			null,
			'Original unnamed entry must not be rewritten'
		);
		assert.equal(entry.contactId, contact.id);
		assert.equal(entry.dealId, deal.id);
		const saved = intents.get(item.entryId);
		assert.deepEqual(
			await request(path + '/accept', {
				body: saved.intent,
				expected: 202
			}),
			saved.queued
		);
		await request(path + '/accept', {
			body: { ...saved.intent, commandId: randomUUID() },
			expected: 409
		});
		existingContact ||= contact;
	}
	const transferred =
		await intakeDb.widgetTransferReceipt.findUniqueOrThrow({
			where: {
				eventId_consumer: {
					eventId: existingSubmission.intent.eventId,
					consumer: 'crm-intake.widget-transfer.v1'
				}
			}
		});
	const path = '/crm/intake/inbox/' + transferred.entryId;
	const { entry } = await request(path + suffix);
	assert.equal(entry.name, null);
	await request(path + '/accept', {
		body: makeIntent(
			entry,
			{
				mode: 'EXISTING',
				contactId: existingContact.id,
				name: 'Не переименовывать'
			},
			'Invalid rename'
		),
		expected: 400
	});
	const existingIntent = makeIntent(
		entry,
		{ mode: 'EXISTING', contactId: existingContact.id },
		'Existing contact from native Inbox'
	);
	const existingReply = await request(path + '/accept', {
		body: existingIntent,
		expected: 202
	});
	await runtime.wait(
		async () =>
			(
				await intakeDb.acceptance.findUniqueOrThrow({
					where: { id: existingReply.acceptance.id }
				})
			).status === 'COMPLETED',
		'Existing contact acceptance did not complete'
	);
	const existingFinal = await request(path + '/acceptance' + suffix);
	assert.equal(existingFinal.acceptance.contactId, existingContact.id);
	assert.deepEqual(
		(
			await request(
				'/crm/customers/contacts/' + existingContact.id + suffix
			)
		).contact,
		existingContact
	);
	assert.deepEqual(
		await request(path + '/accept', {
			body: existingIntent,
			expected: 202
		}),
		existingReply
	);
	await runtime.wait(
		async () =>
			(await intakeDb.acceptanceOutbox.count({
				where: { status: { not: 'PUBLISHED' } }
			})) === 0 &&
			(await intakeDb.acceptanceReceipt.count({
				where: { status: { not: 'DELIVERED' } }
			})) === 0,
		'Acceptance durable records did not drain'
	);
	assert.equal(await intakeDb.acceptance.count(), 7);
	assert.equal(await intakeDb.acceptanceReceipt.count(), 7);
	const events = await intakeDb.acceptanceOutbox.findMany({
		where: { retryAttempt: 0 }
	});
	assert.equal(events.length, 7);
	const connection = await runtime.amqp.connect(
		runtime.brokerUrls.get('crm-intake-acceptance-publisher')
	);
	connection.on('error', () => {});
	try {
		const channel = await connection.createConfirmChannel();
		let returned = false;
		channel.on('return', () => {
			returned = true;
		});
		for (const row of events) {
			assert.equal(row.payload.workspaceId, workspaceId);
			await new Promise((resolve, reject) =>
				channel.publish(
					'winwidget.crm-intake.events',
					NATIVE_ACCEPTANCE_EVENT,
					Buffer.from(JSON.stringify(row.payload)),
					{
						persistent: true,
						mandatory: true,
						contentType: 'application/json',
						type: NATIVE_ACCEPTANCE_EVENT,
						messageId: row.eventId,
						headers: { 'x-retry-attempt': 0 }
					},
					error => (error ? reject(error) : resolve())
				)
			);
		}
		await channel.close();
		assert.equal(returned, false);
	} finally {
		await connection.close();
	}
	const queues = await runtime.wait(async () => {
		const rows = JSON.parse(
			await runtime.ctl([
				'list_queues',
				'-p',
				runtime.vhost,
				'name',
				'messages_ready',
				'messages_unacknowledged',
				'consumers',
				'--formatter=json'
			])
		);
		const row = rows.find(item => item.name === NATIVE_ACCEPTANCE_QUEUE);
		return (
			row?.messages_ready === 0 &&
			row.messages_unacknowledged === 0 &&
			row.consumers === 1 &&
			rows
		);
	}, 'Acceptance redelivery was not acknowledged by its real consumer');
	for (const name of [
		NATIVE_ACCEPTANCE_QUEUE,
		NATIVE_ACCEPTANCE_QUEUE + '.dead-letter'
	]) {
		const queue = queues.find(item => item.name === name);
		assert.ok(queue);
		assert.equal(queue.messages_ready, 0);
		assert.equal(queue.messages_unacknowledged, 0);
	}
	assert.ok(
		queues.every(
			item => !item.name.startsWith(NATIVE_ACCEPTANCE_QUEUE + '.retry')
		)
	);
	assert.equal(await intakeDb.acceptance.count(), 7);
	assert.equal(await intakeDb.acceptanceReceipt.count(), 7);
	assert.equal(
		(
			await request(
				'/crm/customers/contacts' + suffix + '&page=1&pageSize=25'
			)
		).total,
		6
	);
	assert.equal(
		(await request('/crm/sales/deals' + suffix + '&page=1&pageSize=25'))
			.total,
		7
	);
	assert.equal(
		(await request('/crm/sales/tasks' + suffix + '&page=1&pageSize=25'))
			.total,
		7
	);
	return {
		unnamedWidgetAcceptanceVerified: true,
		nativeAcceptanceWidgetTypes: evidence.map(item => item.widgetType),
		existingContactNotRenamedVerified: true,
		acceptanceHttpReplayVerified: true,
		acceptanceBrokerReplayVerified: true,
		acceptanceDelayedRetryImagesVerified: true,
		acceptanceBrokerProcessRestartVerified: true,
		acceptanceWorkflowsCompleted: 7
	};
}
