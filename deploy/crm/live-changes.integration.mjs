import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { resolve } from 'node:path';

const app = process.env.DOMAIN_APP;
assert.ok(
	['crm-intake', 'crm-sales', 'crm-customers', 'support'].includes(app)
);
const schema = app.replaceAll('-', '_');
const url = new URL(process.env.DOMAIN_RUNTIME_URL);
assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname));
assert.match(url.pathname, /_ci$/);
assert.equal(url.searchParams.get('schema'), schema);
assert.equal(process.env.LIVE_TEST_ALLOW_MUTATION, 'true');
process.env[schema.toUpperCase() + '_DATABASE_URL'] = url.href;
const require = createRequire(resolve('apps', app, 'package.json'));
const { Client } = require('pg');
const {
	LiveChangesService
} = require('./dist/src/live/live-changes.service.js');
if (app !== 'support') {
	const {
		LiveChangesController
	} = require('./dist/src/live/live-changes.controller.js');
	const authority = {
		workspaceId: '11111111-1111-4111-8111-111111111111',
		subject: 'tests',
		role: 'OWNER',
		permissions: ['intake:read', 'sales:read', 'customers:read']
	};
	const controller = new LiveChangesController(
		{ authorize: async () => authority },
		{
			open: async (scope, subject, response, authorize) => {
				assert.equal(scope, authority.workspaceId);
				assert.equal(subject, authority.subject);
				await authorize();
			}
		}
	);
	await controller.events(
		'Bearer tests.access-token',
		authority.workspaceId,
		{}
	);
	await assert.rejects(
		controller.events('Bearer two tokens', authority.workspaceId, {}),
		error => error.getStatus() === 401
	);
}
const writer = new Client({ connectionString: url.href });
await writer.connect();
assert.equal(
	(
		await writer.query(
			'SELECT rolsuper FROM pg_roles WHERE rolname=current_user'
		)
	).rows[0].rolsuper,
	false
);
class Response extends EventEmitter {
	frames = [];
	destroyed = false;
	status() {
		return this;
	}
	set(value) {
		this.headers = value;
		return this;
	}
	flushHeaders() {}
	write(value) {
		this.frames.push(value);
		return true;
	}
	end() {
		this.destroyed = true;
		this.emit('finish');
	}
}
const scope = randomUUID();
const services = [new LiveChangesService(), new LiveChangesService()];
const responses = [new Response(), new Response(), new Response()];
let allowed = true;
const authorize = async () => {
	if (!allowed) throw new Error('Revoked');
};
const notify = () =>
	writer.query('SELECT pg_notify($1,$2)', ['crm_live_changes_v1', scope]);
const invalidations = response =>
	response.frames.filter(frame => frame.startsWith('event: invalidate'))
		.length;
try {
	await Promise.all([
		services[0].open(scope, 'user', responses[0], authorize),
		services[1].open(scope, 'user', responses[1], authorize),
		services[0].open(randomUUID(), 'other', responses[2], authorize)
	]);
	await delay(650);
	responses.forEach(response => assert.equal(invalidations(response), 1));
	assert.equal(responses[0].headers['X-Accel-Buffering'], 'no');
	await writer.query('BEGIN');
	await notify();
	await delay(650);
	assert.equal(
		invalidations(responses[0]),
		1,
		'Uncommitted signals must not escape'
	);
	await writer.query('ROLLBACK');
	await delay(650);
	assert.equal(
		invalidations(responses[0]),
		1,
		'Rolled back signals must not escape'
	);
	await writer.query('BEGIN');
	await notify();
	await writer.query('COMMIT');
	await delay(650);
	assert.equal(invalidations(responses[0]), 2);
	assert.equal(
		invalidations(responses[1]),
		2,
		'Every API instance receives committed changes'
	);
	assert.equal(
		invalidations(responses[2]),
		1,
		'Different scopes remain isolated'
	);
	allowed = false;
	await notify();
	await delay(650);
	for (const response of responses.slice(0, 2)) {
		assert.equal(response.destroyed, true);
		assert.ok(response.frames.includes('event: access\ndata: {}\n\n'));
		assert.equal(
			invalidations(response),
			2,
			'Revoked access emits no new data invalidation'
		);
	}
	allowed = true;
	const recovered = new Response();
	await services[0].open(scope, 'user', recovered, authorize);
	await delay(650);
	assert.equal(
		invalidations(recovered),
		1,
		'Reconnect always refreshes the HTTP snapshot'
	);
	recovered.end();
	console.log(
		app +
			': cross-process SSE, commit/rollback, scope, revocation and reconnect passed'
	);
} finally {
	responses.forEach(response => response.end());
	await Promise.all(
		services.map(service => service.onApplicationShutdown())
	);
	await writer.end();
}
