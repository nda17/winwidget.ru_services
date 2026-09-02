import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const databaseUrl = process.env.IDENTITY_TEST_DATABASE_URL?.trim();
if (!databaseUrl) {
	throw new Error('IDENTITY_TEST_DATABASE_URL is required');
}
if (process.env.IDENTITY_INTEGRATION_ALLOW_MUTATION !== 'true') {
	throw new Error('IDENTITY_INTEGRATION_ALLOW_MUTATION=true is required');
}
assertLocalTestDatabase(databaseUrl, 'IDENTITY_TEST_DATABASE_URL');

const appRoot = new URL('../../', import.meta.url);
const migration = spawnSync('pnpm', ['run', 'prisma:migrate:deploy'], {
	cwd: appRoot,
	env: { ...process.env, IDENTITY_DATABASE_URL: databaseUrl },
	encoding: 'utf8',
	timeout: 120_000
});
if (migration.status !== 0) {
	throw new Error(
		`Identity migration failed:\n${migration.stdout}\n${migration.stderr}`
	);
}

const importedClient = await import('@prisma/identity-client');
const identityClient = importedClient.default || importedClient;
const { Prisma, PrismaClient, Role } = identityClient;
const importedEvents = await import(
	new URL(
		'../../dist/src/events/identity-events.service.js',
		import.meta.url
	)
);
const IdentityEventsService =
	importedEvents.IdentityEventsService ||
	importedEvents.default?.IdentityEventsService;
const importedWorkspaces = await import(
	new URL(
		'../../dist/src/workspaces/workspace-provisioning.service.js',
		import.meta.url
	)
);
const WorkspaceProvisioningService =
	importedWorkspaces.WorkspaceProvisioningService ||
	importedWorkspaces.default?.WorkspaceProvisioningService;
if (
	!Prisma ||
	!PrismaClient ||
	!Role ||
	!IdentityEventsService ||
	!WorkspaceProvisioningService
) {
	throw new Error(
		'Compiled Identity integration dependencies are unavailable'
	);
}

const prisma = new PrismaClient({
	datasources: { db: { url: databaseUrl } }
});
const userId = `identity-pg18-${randomUUID()}`;
const eventTypes = [
	'billing.identity.changed.v1',
	'identity.user.changed.v1'
];

try {
	await prisma.$transaction(
		async transaction => {
			await transaction.user.create({
				data: {
					id: userId,
					name: 'Identity PostgreSQL 18 integration',
					password: 'integration-only-hash',
					rights: [Role.USER]
				}
			});
			await new WorkspaceProvisioningService().provisionPersonalWorkspace(
				transaction,
				userId
			);
			await new IdentityEventsService().emitUserChanged(
				transaction,
				userId,
				'integration-correlation-id'
			);
		},
		{ isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
	);

	const outbox = await prisma.outboxEvent.findMany({
		where: { aggregateId: userId },
		orderBy: { eventType: 'asc' },
		select: {
			eventType: true,
			aggregateVersion: true,
			sourceSequence: true,
			payload: true
		}
	});
	assert.equal(outbox.length, 2);
	assert.deepEqual(
		outbox.map(event => event.eventType),
		eventTypes
	);
	for (const event of outbox) {
		assert.equal(event.aggregateVersion, 1n);
		assert.equal(typeof event.sourceSequence, 'bigint');
		assert.equal(event.payload.aggregateId, userId);
		assert.equal(event.payload.state.id, userId);
	}
	const workspace = await prisma.workspace.findUnique({
		where: { personalOwnerUserId: userId },
		include: { members: true }
	});
	assert.ok(workspace);
	assert.equal(workspace.type, 'PERSONAL');
	assert.equal(workspace.status, 'ACTIVE');
	assert.equal(workspace.members.length, 1);
	assert.equal(workspace.members[0].userId, userId);
	assert.equal(workspace.members[0].role, 'OWNER');
	assert.equal(workspace.members[0].status, 'ACTIVE');
	assert.notEqual(workspace.id, workspace.members[0].id);

	console.log(
		'Identity PostgreSQL 18 advisory-lock and workspace integration passed'
	);
} finally {
	await prisma
		.$transaction(async transaction => {
			await transaction.outboxEvent.deleteMany({
				where: { aggregateId: userId }
			});
			await transaction.aggregateVersion.deleteMany({
				where: { aggregateId: userId }
			});
			await transaction.user.deleteMany({ where: { id: userId } });
			await transaction.sourceSequence.deleteMany({
				where: { id: { in: eventTypes } }
			});
		})
		.catch(() => undefined);
	await prisma.$disconnect();
}

function assertLocalTestDatabase(rawValue, variableName) {
	const parsed = new URL(rawValue);
	const databaseName = decodeURIComponent(
		parsed.pathname.replace(/^\//, '')
	).toLowerCase();
	if (
		!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(
			parsed.hostname.toLowerCase()
		) ||
		!/(?:_ci|_test)$/.test(databaseName) ||
		parsed.searchParams.get('schema') !== 'identity'
	) {
		throw new Error(
			`${variableName} must point to the identity schema of a local test or CI database`
		);
	}
}
