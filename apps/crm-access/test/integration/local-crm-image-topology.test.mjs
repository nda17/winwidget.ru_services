import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	CRM_IMAGE_SERVICES,
	CRM_IMAGE_PROCESSES,
	runtimeGrants,
	databaseUrl,
	assertOwnedContainer,
	assertQuietQueues,
	serviceTokens
} from './local-crm-image-topology.mjs';

test('four service databases and twelve independent roles retain a 40-connection runtime budget', () => {
	assert.equal(CRM_IMAGE_SERVICES.length, 4);
	assert.equal(CRM_IMAGE_PROCESSES.length, 12);
	assert.equal(
		new Set(CRM_IMAGE_PROCESSES.map(item => item.port)).size,
		12
	);
	assert.deepEqual(
		CRM_IMAGE_SERVICES.map(service =>
			CRM_IMAGE_PROCESSES.filter(item => item.app === service.app).reduce(
				(sum, item) => sum + item.connections,
				0
			)
		),
		[10, 20, 5, 5]
	);
	assert.equal(
		CRM_IMAGE_PROCESSES.filter(item => item.role !== 'api').length,
		8
	);
	assert.ok(
		CRM_IMAGE_PROCESSES.every(
			item => item.role !== 'all' && Object.isFrozen(item)
		)
	);
	assert.ok(CRM_IMAGE_SERVICES.every(item => Object.isFrozen(item)));
});

for (const service of CRM_IMAGE_SERVICES) {
	test(`${service.app}: own schema grants exclude DDL and mutation of audit/command evidence`, () => {
		const grants = runtimeGrants(service.app);
		assert.ok(!/GRANT .*CREATE|GRANT ALL|TRUNCATE|EXECUTE/.test(grants));
		assert.ok(
			!CRM_IMAGE_SERVICES.filter(item => item !== service).some(item =>
				grants.includes(`${item.schema}.`)
			)
		);
		assert.match(
			grants,
			new RegExp(
				`REVOKE ALL ON ${service.schema}\\._prisma_migrations FROM image_runtime;`
			)
		);
		for (const statement of grants.split('\n')) {
			if (
				/command|audit|receipt|snapshot|timeline|operation_slot/.test(
					statement
				) &&
				!/outbox|deliveries|acceptances|jobs/.test(statement)
			)
				assert.ok(
					!/UPDATE|DELETE/.test(statement),
					'No mutable evidence shortcut'
				);
		}
	});
	test(`${service.app}: URL is only the owned loopback database with an explicit bounded pool`, () => {
		const url = new URL(
			databaseUrl(service.app, service.port, 'a'.repeat(48), 4)
		);
		assert.equal(url.hostname, '127.0.0.1');
		assert.equal(url.pathname, '/wincrm_image_test');
		assert.equal(url.searchParams.get('schema'), service.schema);
		assert.equal(url.searchParams.get('connection_limit'), '4');
		assert.throws(() =>
			databaseUrl(service.app, service.port + 1, 'a'.repeat(48))
		);
		assert.throws(() =>
			databaseUrl(service.app, service.port, 'a'.repeat(48), 6)
		);
		assert.throws(() =>
			databaseUrl(service.app, service.port, 'a'.repeat(48), 1, 'postgres')
		);
	});
}

test('cleanup rejects a foreign container, relabelled name or OOM outcome', () => {
	const item = {
		Id: 'a'.repeat(64),
		Name: '/wincrm-image-0123456789-crm-access-api',
		Config: { Labels: { 'winwidget.test': 'crm-image-0123456789' } },
		State: { OOMKilled: false }
	};
	assertOwnedContainer(item, item.Id, 'crm-image-0123456789');
	for (const change of [
		{ Id: 'b'.repeat(64) },
		{ Name: '/production-service' },
		{ Config: { Labels: { 'winwidget.test': 'other-project' } } },
		{ State: { OOMKilled: true } }
	])
		assert.throws(() =>
			assertOwnedContainer(
				{ ...item, ...change },
				item.Id,
				'crm-image-0123456789'
			)
		);
});

test('topology proof requires all queues, separate push consumers and no pending delivery', () => {
	const names = ['provision', 'acceptance', 'admission'].map(
		name => `winwidget.crm-access.team.${name}`
	);
	const main = [
		...names,
		'winwidget.crm-intake.acceptance.v1',
		'winwidget.crm-intake.widget-control.v1',
		'winwidget.crm-intake.widget-transfer.v1'
	];
	const rows = main
		.flatMap(name => [
			name,
			`${name}.dead-letter`,
			...(names.includes(name)
				? [1, 2, 3].map(index => `${name}.retry.${index}`)
				: [])
		])
		.map(name => ({
			name,
			messages_ready: 0,
			messages_unacknowledged: 0,
			consumers: main.includes(name) ? 1 : 0
		}));
	assertQuietQueues(rows, true);
	assertQuietQueues(
		rows.map(row => ({ ...row, consumers: 0 })),
		false
	);
	for (const field of [
		'messages_ready',
		'messages_unacknowledged',
		'consumers'
	]) {
		const changed = structuredClone(rows);
		changed[0][field] += 1;
		assert.throws(() => assertQuietQueues(changed, true));
	}
	assert.throws(() => assertQuietQueues(rows.slice(1), true));
	assert.throws(() => assertQuietQueues([...rows, rows[0]], true));
});

test('pairwise credentials stay in their owning service only', () => {
	const names = [
		'IDENTITY_CRM_ACCESS_TOKEN',
		'BILLING_CRM_ACCESS_TOKEN',
		'BILLING_CRM_ACCESS_COMMERCE_TOKEN',
		'CRM_SALES_CRM_ACCESS_TOKEN',
		'CRM_ACCESS_CRM_CUSTOMERS_TOKEN',
		'CRM_ACCESS_CRM_SALES_TOKEN',
		'CRM_ACCESS_CRM_INTAKE_TOKEN',
		'CRM_CUSTOMERS_CRM_INTAKE_TOKEN',
		'CRM_SALES_CRM_INTAKE_TOKEN',
		'CRM_CUSTOMERS_CRM_SALES_TOKEN',
		'WIDGETS_CRM_INTAKE_TOKEN'
	];
	const tokens = Object.fromEntries(
		names.map(name => [name, 'a'.repeat(48)])
	);
	for (const service of CRM_IMAGE_SERVICES) {
		const selected = serviceTokens(service.app, tokens);
		assert.ok(Object.keys(selected).length < names.length);
		assert.equal(
			Object.hasOwn(selected, 'IDENTITY_CRM_ACCESS_TOKEN'),
			service.app === 'crm-access'
		);
		assert.equal(
			Object.hasOwn(selected, 'WIDGETS_CRM_INTAKE_TOKEN'),
			service.app === 'crm-intake'
		);
		assert.throws(() => serviceTokens(service.app, {}));
	}
	assert.throws(() => serviceTokens('core', tokens));
	assert.throws(() => runtimeGrants('core'));
});
