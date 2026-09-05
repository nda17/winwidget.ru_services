import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let stage = 'guards';

function required(name) {
	const value = process.env[name]?.trim();
	assert.ok(value);
	return value;
}

function localDatabase(raw) {
	const url = new URL(raw);
	assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
	assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname));
	assert.match(url.pathname, /^\/winwidget_identity_test[a-z0-9_]*$/);
	assert.equal(url.hash, '');
	assert.deepEqual(url.searchParams.getAll('schema'), ['identity']);
	const allowed = new Set([
		'schema',
		'sslmode',
		'connection_limit',
		'connect_timeout',
		'pool_timeout'
	]);
	for (const [key, value] of url.searchParams) {
		assert.ok(allowed.has(key));
		assert.equal(url.searchParams.getAll(key).length, 1);
		if (key === 'sslmode') assert.equal(value, 'disable');
		else if (key !== 'schema') assert.match(value, /^[1-9][0-9]{0,3}$/);
	}
	const role = decodeURIComponent(url.username);
	assert.match(role, /^[a-z][a-z0-9_]{0,62}$/);
	return {
		role,
		database: url.pathname.slice(1),
		target: `${url.hostname}:${url.port || '5432'}${url.pathname}`
	};
}

function sqlState(error) {
	const code = error?.meta?.code || error?.code;
	return typeof code === 'string' &&
		/^[A-Z0-9]{5}$/.test(code) &&
		!/^P[0-9]{4}$/.test(code)
		? code
		: 'unknown';
}

async function rejectedSql(callback, expected) {
	let actual = null;
	try {
		await callback();
	} catch (error) {
		actual = sqlState(error);
	}
	assert.equal(actual, expected);
}

async function verifyRole(client, expected, database) {
	const [role] = await client.$queryRawUnsafe(`
		SELECT current_user AS name, current_database() AS database,
		 current_setting('server_version_num')::integer AS version,
		 NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolbypassrls
		 AND NOT rolinherit AND NOT rolreplication AND rolcanlogin AS restricted,
		 has_database_privilege(current_user,current_database(),'CREATE') AS database_create
		FROM pg_roles WHERE rolname=current_user
	`);
	assert.equal(role.name, expected);
	assert.equal(role.database, database);
	assert.equal(Math.floor(role.version / 10_000), 18);
	assert.equal(role.restricted, true);
	assert.equal(role.database_create, false);
}

async function main() {
	assert.equal(process.env.IDENTITY_INTEGRATION_ALLOW_MUTATION, 'true');
	const runtimeUrl = required('IDENTITY_TEST_DATABASE_URL');
	const migrationUrl = required('IDENTITY_TEST_MIGRATION_DATABASE_URL');
	const expectedRole = required('IDENTITY_TEST_RUNTIME_ROLE');
	const runtimeTarget = localDatabase(runtimeUrl);
	const migrationTarget = localDatabase(migrationUrl);
	assert.equal(runtimeTarget.target, migrationTarget.target);
	assert.equal(runtimeTarget.role, expectedRole);
	assert.notEqual(runtimeTarget.role, migrationTarget.role);

	require('reflect-metadata');
	const { PrismaClient } = require('@prisma/identity-client');
	const {
		IdentityInternalService
	} = require('../../dist/src/internal/internal.service.js');
	const client = url =>
		new PrismaClient({
			datasources: { db: { url } },
			errorFormat: 'minimal',
			log: []
		});
	const runtime = client(runtimeUrl);
	const writer = client(runtimeUrl);
	const migrator = client(migrationUrl);
	const users = Array.from(
		{ length: 4 },
		() => `identity-widget-pg18-${randomUUID()}`
	);
	const [owner, member, otherOwner, outsider] = users;
	const personal = randomUUID();
	const organization = randomUUID();
	const created = { users: [], workspaces: [], members: [] };
	let failure = null;
	let afterWorkspaceRead = null;
	let observedTransactions = 0;
	let dependencyCalls = 0;
	const unavailableDependency = new Proxy(
		{},
		{
			get() {
				dependencyCalls++;
				throw new Error('Unexpected external dependency');
			}
		}
	);
	const proxy = new Proxy(runtime, {
		get(target, key) {
			if (key === '$transaction')
				return (callback, options) => {
					assert.equal(options?.isolationLevel, 'RepeatableRead');
					assert.equal(options?.maxWait, 500);
					assert.equal(options?.timeout, 2000);
					return target.$transaction(
						tx =>
							callback(
								new Proxy(tx, {
									get(transaction, property) {
										if (property === 'workspace')
											return new Proxy(transaction.workspace, {
												get(model, method) {
													if (method === 'findFirst')
														return async args => {
															const result = await model.findFirst(args);
															const [settings] =
																await transaction.$queryRawUnsafe(`
										SELECT current_setting('transaction_read_only') AS read_only,
										 current_setting('transaction_isolation') AS isolation,
										 current_setting('statement_timeout') AS timeout, pg_backend_pid() AS pid
									`);
															assert.equal(settings.read_only, 'on');
															assert.equal(
																settings.isolation,
																'repeatable read'
															);
															assert.equal(settings.timeout, '1500ms');
															observedTransactions++;
															if (afterWorkspaceRead)
																await afterWorkspaceRead(
																	transaction,
																	settings
																);
															return result;
														};
													const value = Reflect.get(model, method);
													return typeof value === 'function'
														? value.bind(model)
														: value;
												}
											});
										const value = Reflect.get(transaction, property);
										return typeof value === 'function'
											? value.bind(transaction)
											: value;
									}
								})
							),
						options
					);
				};
			const value = Reflect.get(target, key);
			return typeof value === 'function' ? value.bind(target) : value;
		}
	});
	const service = new IdentityInternalService(
		proxy,
		unavailableDependency,
		unavailableDependency
	);
	const resolve = (workspaceId, subject) =>
		service.crmWidgetSourceContext(workspaceId, subject);
	const denied = async (workspaceId, subject) =>
		assert.deepEqual(await resolve(workspaceId, subject), {
			schemaVersion: 1,
			workspaceId,
			subject,
			membership: null,
			ownerSubject: null
		});
	const allowed = async (workspaceId, subject, membershipId, role) =>
		assert.deepEqual(await resolve(workspaceId, subject), {
			schemaVersion: 1,
			workspaceId,
			subject,
			membership: { membershipId, workspaceId, role },
			ownerSubject: owner
		});
	async function membership(workspaceId, userId, role) {
		const row = await runtime.workspaceMember.create({
			data: { id: randomUUID(), workspaceId, userId, role }
		});
		created.members.push(row.id);
		return row.id;
	}
	try {
		stage = 'roles';
		await verifyRole(runtime, runtimeTarget.role, runtimeTarget.database);
		await verifyRole(
			migrator,
			migrationTarget.role,
			migrationTarget.database
		);
		const [ownership] = await runtime.$queryRawUnsafe(
			`
			SELECT pg_get_userbyid(nspowner) AS owner,
			 has_schema_privilege(current_user,'identity','CREATE') AS schema_create,
			 has_schema_privilege(current_user,'foreign_service_guard','USAGE') AS foreign_usage,
			 pg_has_role(current_user,$1::text,'MEMBER') AS migration_membership
			FROM pg_namespace WHERE nspname='identity'
		`,
			migrationTarget.role
		);
		assert.equal(ownership.owner, migrationTarget.role);
		assert.equal(ownership.schema_create, false);
		assert.equal(ownership.foreign_usage, false);
		assert.equal(ownership.migration_membership, false);
		for (const table of ['users', 'workspaces', 'workspace_members']) {
			const [acl] = await runtime.$queryRawUnsafe(
				`
				SELECT has_table_privilege(current_user,$1::text,'SELECT') AS read,
				 has_table_privilege(current_user,$1::text,'INSERT') AS insert,
				 has_table_privilege(current_user,$1::text,'UPDATE') AS update,
				 has_table_privilege(current_user,$1::text,'TRUNCATE') AS truncate,
				 pg_get_userbyid(relowner)=current_user AS owned
				FROM pg_class WHERE oid=$1::regclass
			`,
				`identity.${table}`
			);
			assert.deepEqual(acl, {
				read: true,
				insert: true,
				update: true,
				truncate: false,
				owned: false
			});
		}
		// Existing Identity runtime may legitimately DELETE own business rows.
		// Only the migration role performs this script's exact-ID cleanup.
		await rejectedSql(
			() =>
				runtime.$queryRawUnsafe(
					'SELECT migration_name FROM identity._prisma_migrations LIMIT 0'
				),
			'42501'
		);
		await rejectedSql(
			() =>
				runtime.$queryRawUnsafe(
					'SELECT * FROM foreign_service_guard.sentinel LIMIT 0'
				),
			'42501'
		);
		console.log('PASS identity-widget-source roles');

		stage = 'seed';
		for (const id of users) {
			await runtime.user.create({
				data: {
					id,
					name: 'Local integration fixture',
					password: 'not-a-valid-login-hash',
					rights: ['USER']
				}
			});
			created.users.push(id);
		}
		for (const data of [
			{ id: personal, type: 'PERSONAL', personalOwnerUserId: owner },
			{ id: organization, type: 'ORGANIZATION', personalOwnerUserId: null }
		]) {
			await runtime.workspace.create({ data });
			created.workspaces.push(data.id);
		}
		const personalOwner = await membership(personal, owner, 'OWNER');
		const personalMember = await membership(personal, member, 'MEMBER');
		const organizationOwner = await membership(
			organization,
			owner,
			'OWNER'
		);
		const organizationMember = await membership(
			organization,
			member,
			'MEMBER'
		);

		stage = 'owner-binding';
		await allowed(personal, owner, personalOwner, 'OWNER');
		await allowed(personal, member, personalMember, 'MEMBER');
		await allowed(organization, owner, organizationOwner, 'OWNER');
		await allowed(organization, member, organizationMember, 'MEMBER');
		for (const workspaceId of [personal, organization])
			await denied(workspaceId, outsider);
		await denied(randomUUID(), member);
		await runtime.workspace.update({
			where: { id: personal },
			data: { personalOwnerUserId: otherOwner }
		});
		await denied(personal, member);
		await denied(personal, owner);
		await runtime.workspace.update({
			where: { id: personal },
			data: { personalOwnerUserId: owner }
		});
		for (const workspaceId of [personal, organization]) {
			const duplicate = await membership(workspaceId, otherOwner, 'OWNER');
			await denied(workspaceId, member);
			await denied(workspaceId, owner);
			await runtime.workspaceMember.update({
				where: { id: duplicate },
				data: { status: 'INACTIVE' }
			});
		}
		await allowed(organization, member, organizationMember, 'MEMBER');
		console.log('PASS identity-widget-source owner-binding');

		stage = 'revocation';
		for (const [id, patch, restore] of [
			[member, { status: 'DEACTIVATED' }, { status: 'ACTIVE' }],
			[member, { deletedAt: new Date() }, { deletedAt: null }],
			[owner, { status: 'DEACTIVATED' }, { status: 'ACTIVE' }],
			[owner, { deletedAt: new Date() }, { deletedAt: null }]
		]) {
			await runtime.user.update({ where: { id }, data: patch });
			await denied(personal, member);
			await denied(organization, member);
			await denied(organization, id);
			await runtime.user.update({ where: { id }, data: restore });
		}
		for (const id of [
			personalMember,
			organizationMember,
			personalOwner,
			organizationOwner
		]) {
			const workspaceId = [personalMember, personalOwner].includes(id)
				? personal
				: organization;
			await runtime.workspaceMember.update({
				where: { id },
				data: { status: 'INACTIVE' }
			});
			await denied(workspaceId, member);
			await runtime.workspaceMember.update({
				where: { id },
				data: { status: 'ACTIVE' }
			});
		}
		for (const id of [personal, organization]) {
			await runtime.workspace.update({
				where: { id },
				data: { status: 'INACTIVE' }
			});
			await denied(id, member);
			await denied(id, owner);
			await runtime.workspace.update({
				where: { id },
				data: { status: 'ACTIVE' }
			});
		}
		console.log('PASS identity-widget-source revocation');

		stage = 'repeatable-read-race';
		let raced = false;
		afterWorkspaceRead = async (_tx, settings) => {
			afterWorkspaceRead = null;
			await writer.$transaction(async tx => {
				const [peer] = await tx.$queryRawUnsafe(
					'SELECT pg_backend_pid() AS pid'
				);
				assert.notEqual(peer.pid, settings.pid);
				await tx.workspaceMember.update({
					where: { id: organizationOwner },
					data: { status: 'INACTIVE' }
				});
			});
			raced = true;
		};
		await allowed(organization, member, organizationMember, 'MEMBER');
		assert.equal(raced, true);
		assert.equal(
			(
				await runtime.workspaceMember.findUnique({
					where: { id: organizationOwner }
				})
			).status,
			'INACTIVE'
		);
		await denied(organization, member);
		await runtime.workspaceMember.update({
			where: { id: organizationOwner },
			data: { status: 'ACTIVE' }
		});
		console.log('PASS identity-widget-source repeatable-read-race');

		stage = 'transaction-fences';
		for (const [query, parameters, expected] of [
			[
				'UPDATE identity.users SET name=name WHERE id=$1',
				[owner],
				'25006'
			],
			['SELECT pg_sleep(2)', [], '57014']
		]) {
			let observed = null;
			afterWorkspaceRead = async tx => {
				afterWorkspaceRead = null;
				try {
					await tx.$queryRawUnsafe(query, ...parameters);
				} catch (error) {
					observed = sqlState(error);
					throw error;
				}
			};
			await assert.rejects(
				resolve(organization, member),
				error =>
					error?.getStatus?.() === 503 &&
					error?.message === 'Widget source identity is unavailable'
			);
			assert.equal(observed, expected);
		}
		assert.ok(observedTransactions > 30);
		assert.equal(dependencyCalls, 0);
		await allowed(organization, member, organizationMember, 'MEMBER');
		console.log('PASS identity-widget-source transaction-fences');
	} catch (error) {
		failure = { stage, sqlstate: sqlState(error) };
	} finally {
		afterWorkspaceRead = null;
		try {
			if (
				created.users.length ||
				created.workspaces.length ||
				created.members.length
			) {
				await migrator.$transaction(async tx => {
					await tx.workspaceMember.deleteMany({
						where: { id: { in: created.members } }
					});
					await tx.workspace.deleteMany({
						where: { id: { in: created.workspaces } }
					});
					await tx.user.deleteMany({
						where: { id: { in: created.users } }
					});
				});
				assert.equal(
					await migrator.user.count({
						where: { id: { in: created.users } }
					}),
					0
				);
				assert.equal(
					await migrator.workspace.count({
						where: { id: { in: created.workspaces } }
					}),
					0
				);
				assert.equal(
					await migrator.workspaceMember.count({
						where: { id: { in: created.members } }
					}),
					0
				);
			}
		} catch (error) {
			failure = { stage: 'cleanup', sqlstate: sqlState(error) };
		}
		const disconnected = await Promise.allSettled([
			runtime.$disconnect(),
			writer.$disconnect(),
			migrator.$disconnect()
		]);
		if (disconnected.some(result => result.status === 'rejected'))
			failure ??= { stage: 'disconnect', sqlstate: 'unknown' };
	}
	if (failure) {
		stage = failure.stage;
		throw Object.assign(new Error('Integration failed'), {
			code: failure.sqlstate
		});
	}
	console.log('PASS identity-widget-source cleanup');
	console.log('PASS identity-widget-source PostgreSQL18');
}

main().catch(error => {
	// Never print URL, user identifiers, assertion objects, Prisma messages or stack traces.
	console.error(
		`FAIL identity-widget-source stage=${stage} sqlstate=${sqlState(error)}`
	);
	process.exitCode = 1;
});
