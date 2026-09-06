import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const servicesRoot = resolve(
	dirname(fileURLToPath(import.meta.url)),
	'../../../..'
);
const api = 'http://localhost:4100/api/v1';
const schemas = [
	'identity',
	'billing',
	'crm_access',
	'crm_intake',
	'crm_customers',
	'crm_sales'
];
const personas = ['owner', 'manager', 'teamLead'];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// This companion does not compose business classes, publish messages, mint JWTs
// or seed memberships. It exercises the existing --browser-team entrypoints.
// Browser personas are deliberately not touched: their UI proof stays separate.
export function validateTeamRuntimeFixture(fixture) {
	try {
		assert.match(fixture.runId, /^[a-f0-9]{10}$/);
		assert.equal(
			fixture.ownedMarker,
			`wincrm-local-stack:${fixture.runId}`
		);
		assert.equal(fixture.apiUrl, api);
		assert.equal(fixture.activatedOwner, false);
		assert.equal(fixture.browserTeam.backgroundReady, true);
		assert.equal(fixture.browserTeam.startupLoginRequests, 0);
		assert.equal(fixture.browserTeam.browserVerified, false);
		assert.equal(fixture.browserTeam.releaseImagesVerified, false);
		assert.deepEqual(fixture.browserTeam.personas, [
			'browserOwner',
			'browserInviteeA',
			'browserInviteeB'
		]);
		assert.deepEqual(
			fixture.databases.map(row => row.database).sort(),
			schemas
				.map(
					schema =>
						`winwidget_${schema}_test_browser_${fixture.runId}_test`
				)
				.sort()
		);
		for (const schema of schemas) {
			const row = fixture.databases.find(
				row =>
					row.database ===
					`winwidget_${schema}_test_browser_${fixture.runId}_test`
			);
			assert.equal(row.migrationRole, `wcrm_${schema}_m_${fixture.runId}`);
			assert.equal(row.runtimeRole, `wcrm_${schema}_r_${fixture.runId}`);
		}
		for (const name of personas) {
			const account = fixture.accounts[name];
			assert.equal(
				account.userId,
				`wincrm-local-${name}-${fixture.runId}`
			);
			assert.equal(
				account.email,
				`wincrm-${name.toLowerCase()}@example.test`
			);
			assert.match(account.workspaceId, /^[a-f0-9-]{36}$/);
			assert.ok(account.password.length >= 20);
		}
		assert.equal(
			new Set(personas.map(name => fixture.accounts[name].workspaceId))
				.size,
			3
		);
		for (const label of [
			'crm-access-worker',
			'crm-access-outbox-publisher',
			'identity-outbox-publisher'
		])
			assert.ok(
				Number.isInteger(fixture.children[label]) &&
					fixture.children[label] > 1
			);
		return fixture;
	} catch {
		throw new Error(
			'Team runtime fixture admission failed; values suppressed'
		);
	}
}

export function assertRuntimeHealth(body, service, runId) {
	assert.equal(body.status, 'ready', 'Actual runtime must be ready');
	assert.equal(body.service, service, 'Unexpected runtime service');
	assert.equal(
		body.revision,
		`local-browser-${runId}`,
		'Unexpected runtime revision'
	);
}

export async function readBoundedJson(response) {
	assert.ok(response.body, 'Empty HTTP response');
	const reader = response.body.getReader();
	const chunks = [];
	let length = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		length += value.length;
		if (length > 512 * 1024) {
			await reader.cancel();
			throw new Error('Team runtime response bound');
		}
		chunks.push(Buffer.from(value));
	}
	return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function verifyTeamRuntime(fixture, log = () => {}) {
	validateTeamRuntimeFixture(fixture);
	return verifyTeamWorkflow({
		runId: fixture.runId,
		accounts: fixture.accounts,
		foreignWorkspaceId: fixture.accounts.browserOwner.workspaceId,
		log,
		assertReady: async () => {
			for (const [port, service, label] of [
				[5301, 'crm-access', 'crm-access-worker'],
				[5302, 'crm-access', 'crm-access-outbox-publisher'],
				[4902, 'identity', 'identity-outbox-publisher']
			]) {
				process.kill(fixture.children[label], 0);
				const response = await fetch(
					`http://127.0.0.1:${port}/health/ready`,
					{ redirect: 'error', signal: AbortSignal.timeout(5000) }
				);
				assert.equal(response.status, 200);
				assertRuntimeHealth(
					await readBoundedJson(response),
					service,
					fixture.runId
				);
			}
		}
	});
}

// Both drivers use the same ordinary HTTP business commands. The image driver
// proves OCI ownership/readiness separately; this function never claims images.
export async function verifyTeamWorkflow({
	runId,
	accounts,
	foreignWorkspaceId,
	assertReady,
	log = () => {}
}) {
	assert.match(runId, /^[a-f0-9]{10}$/);
	assert.match(foreignWorkspaceId, /^[a-f0-9-]{36}$/);
	const workspaceId = accounts.owner.workspaceId;
	let phase = 'runtime readiness',
		accessDb,
		identityDb,
		barrier,
		releaseBarrier;
	const deadline = Date.now() + 180_000;
	const until = async check => {
		while (Date.now() < deadline) {
			const result = await check();
			if (result) return result;
			await delay(75);
		}
		throw new Error('Team runtime observation deadline');
	};
	const request = async (path, { token, body, expected = 200 } = {}) => {
		assert.ok(path.startsWith('/') && !path.startsWith('//'));
		const response = await fetch(api + path, {
			method: body ? 'POST' : 'GET',
			redirect: 'error',
			cache: 'no-store',
			signal: AbortSignal.timeout(15_000),
			headers: {
				'content-type': 'application/json',
				...(token ? { authorization: `Bearer ${token}` } : {}),
				...(body?.commandId ? { 'idempotency-key': body.commandId } : {})
			},
			...(body ? { body: JSON.stringify(body) } : {})
		});
		if (response.status !== expected) {
			await response.body?.cancel();
			const error = new Error('Unexpected team runtime HTTP status');
			error.httpStatus = response.status;
			throw error;
		}
		return readBoundedJson(response);
	};
	const command = data => ({
		schemaVersion: 1,
		commandId: randomUUID(),
		workspaceId,
		...data
	});
	try {
		await assertReady();
		const db = (app, schema, packageName) => {
			const require = createRequire(
				join(servicesRoot, 'apps', app, 'package.json')
			);
			return new (require(packageName).PrismaClient)({
				datasources: {
					db: {
						url: `postgresql://wcrm_${schema}_r_${runId}@127.0.0.1:55440/winwidget_${schema}_test_browser_${runId}_test?schema=${schema}&sslmode=disable&connection_limit=3`
					}
				},
				log: []
			});
		};
		accessDb = db('crm-access', 'crm_access', '@prisma/crm-access-client');
		identityDb = db('identity', 'identity', '@prisma/identity-client');
		assert.equal(
			await accessDb.crmWorkspaceAccess.count({ where: { workspaceId } }),
			0,
			'Only a fresh non-browser persona is allowed'
		);
		assert.equal(
			await accessDb.crmWorkspaceMember.count({ where: { workspaceId } }),
			0
		);
		assert.equal(
			await accessDb.crmAdmission.count({ where: { workspaceId } }),
			0
		);
		phase = 'normal Identity login';
		const tokens = {};
		for (const name of personas) {
			const session = await request('/auth/login', {
				body: {
					email: accounts[name].email,
					password: accounts[name].password
				}
			});
			assert.equal(session.user.id, accounts[name].userId);
			assert.ok(session.accessToken?.length > 100);
			tokens[name] = session.accessToken;
		}
		phase = 'Trial and template onboarding';
		const activation = command({});
		const trial = await request('/crm/access/trial', {
			token: tokens.owner,
			body: activation
		});
		assert.equal(trial.activated, true);
		assert.deepEqual(
			await request('/crm/access/trial', {
				token: tokens.owner,
				body: activation
			}),
			{ ...trial, activated: false }
		);
		await request('/crm/access/onboarding/template', {
			token: tokens.owner,
			body: command({ templateKey: 'universal-sales', templateVersion: 1 })
		});
		const roster = () =>
			request(
				`/crm/access/team/members?workspaceId=${workspaceId}&page=1&pageSize=100`,
				{ token: tokens.owner }
			);
		let members = await roster();
		assert.deepEqual(members.quota, {
			seatLimit: 2,
			usedSeats: 1,
			waitingCount: 0
		});
		assert.equal(members.total, 0);
		phase = 'HTTP invitations and actual publisher provisioning';
		const team = (
			await request('/crm/access/team/teams', {
				token: tokens.owner,
				body: command({ name: 'Runtime scope QA' })
			})
		).team;
		const invites = [];
		for (const name of ['manager', 'teamLead']) {
			const dto = command({
				email: accounts[name].email,
				role: 'MANAGER',
				teamIds: [team.id],
				ttlDays: 7
			});
			const result = await request('/crm/access/team/invitations', {
				token: tokens.owner,
				body: dto
			});
			assert.deepEqual(
				await request('/crm/access/team/invitations', {
					token: tokens.owner,
					body: dto
				}),
				result
			);
			invites.push({ name, id: result.invitation.id });
		}
		await until(
			async () =>
				(await accessDb.crmInvitationIntent.count({
					where: { workspaceId, status: 'INVITED' }
				})) === 2
		);
		assert.deepEqual((await roster()).quota, {
			seatLimit: 2,
			usedSeats: 1,
			waitingCount: 0
		});
		for (const invite of invites) {
			const preview = await request(
				`/workspace-invitations/${invite.id}`,
				{ token: tokens[invite.name] }
			);
			assert.equal(preview.invitation.status, 'PENDING');
			invite.command = {
				schemaVersion: 1,
				commandId: randomUUID(),
				expectedVersion: preview.invitation.version
			};
		}
		log(
			'Actual entrypoints: pending invitations preserve the second Trial seat.'
		);
		phase = 'concurrent actual consumers at PostgreSQL lock';
		let locked;
		const ready = new Promise(resolve => {
			locked = resolve;
		});
		const release = new Promise(resolve => {
			releaseBarrier = resolve;
		});
		// Observation barrier only: no business table mutation or processor replacement.
		barrier = accessDb.$transaction(
			async tx => {
				await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`wincrm-team:${workspaceId}`}, 0))`;
				locked();
				await release;
			},
			{ maxWait: 3000, timeout: 20_000 }
		);
		void barrier.catch(() => {});
		await Promise.race([
			ready,
			barrier.then(() => {
				throw new Error('Barrier ended before readiness');
			})
		]);
		const accepted = await Promise.all(
			invites.map(invite =>
				request(`/workspace-invitations/${invite.id}/accept`, {
					token: tokens[invite.name],
					body: invite.command
				})
			)
		);
		await Promise.race([
			until(async () => {
				const [row] = await accessDb.$queryRawUnsafe(
					"SELECT count(*)::integer AS waiting FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE l.locktype='advisory' AND NOT l.granted AND a.datname=current_database() AND a.usename=current_user"
				);
				return row.waiting >= 2;
			}),
			barrier.then(() => {
				throw new Error('Barrier ended before contention');
			})
		]);
		releaseBarrier();
		await barrier;
		barrier = null;
		releaseBarrier = null;
		phase = 'FIFO capacity and exact command replay';
		await until(async () => {
			const rows = await accessDb.crmAdmission.findMany({
				where: { workspaceId },
				orderBy: { position: 'asc' }
			});
			return (
				rows.length === 2 &&
				rows[0].status === 'ACTIVE' &&
				rows[1].status === 'WAITING'
			);
		});
		members = await roster();
		assert.deepEqual(members.quota, {
			seatLimit: 2,
			usedSeats: 2,
			waitingCount: 1
		});
		assert.equal(members.items.length, 1);
		let active = members.items[0];
		const activeName = personas.find(
			name => accounts[name].userId === active.subject
		);
		assert.ok(activeName && activeName !== 'owner');
		for (const [index, invite] of invites.entries())
			assert.deepEqual(
				await request(`/workspace-invitations/${invite.id}/accept`, {
					token: tokens[invite.name],
					body: invite.command
				}),
				accepted[index]
			);
		assert.equal(
			await accessDb.crmAdmission.count({ where: { workspaceId } }),
			2
		);
		log(
			'Actual push consumers contended: owner plus one active member, one FIFO waiter; acceptance replay is stable.'
		);
		phase = 'OWN scope, team scope and workspace isolation';
		const token = tokens[activeName];
		const permissions = () =>
			request(`/crm/access/permissions?workspaceId=${workspaceId}`, {
				token
			});
		assert.equal((await permissions()).dataScope, 'OWN');
		const paths = ['/crm/customers/contacts', '/crm/customers/companies'];
		const ownRecords = [],
			teamRecords = [],
			privateRecords = [];
		for (const path of paths) {
			ownRecords.push(
				await request(path, {
					token,
					body: command({ name: 'Own runtime record', teamId: team.id })
				})
			);
			teamRecords.push(
				await request(path, {
					token: tokens.owner,
					body: command({ name: 'Team runtime record', teamId: team.id })
				})
			);
			privateRecords.push(
				await request(path, {
					token: tokens.owner,
					body: command({ name: 'Private owner record' })
				})
			);
		}
		const list = (path, actor = token) =>
			request(`${path}?workspaceId=${workspaceId}&page=1&pageSize=100`, {
				token: actor
			});
		for (const [index, path] of paths.entries()) {
			const kind = index === 0 ? 'contact' : 'company';
			assert.equal((await list(path)).total, 1);
			await request(
				`${path}/${ownRecords[index][kind].id}?workspaceId=${workspaceId}`,
				{ token }
			);
			await request(
				`${path}/${teamRecords[index][kind].id}?workspaceId=${workspaceId}`,
				{ token, expected: 404 }
			);
			await request(
				`${path}/${privateRecords[index][kind].id}?workspaceId=${workspaceId}`,
				{ token, expected: 404 }
			);
		}
		const changeRole = async role => {
			const dto = command({ expectedVersion: active.version, role });
			const result = await request(
				`/crm/access/team/members/${active.id}/change-role`,
				{ token: tokens.owner, body: dto }
			);
			assert.deepEqual(
				await request(
					`/crm/access/team/members/${active.id}/change-role`,
					{ token: tokens.owner, body: dto }
				),
				result
			);
			await request(`/crm/access/team/members/${active.id}/change-role`, {
				token: tokens.owner,
				body: command({ expectedVersion: active.version, role }),
				expected: 409
			});
			active = result.member;
		};
		await changeRole('TEAM_LEAD');
		assert.equal((await permissions()).dataScope, 'TEAM');
		for (const [index, path] of paths.entries()) {
			const kind = index === 0 ? 'contact' : 'company';
			assert.equal((await list(path)).total, 2);
			await request(
				`${path}/${teamRecords[index][kind].id}?workspaceId=${workspaceId}`,
				{ token }
			);
			await request(
				`${path}/${privateRecords[index][kind].id}?workspaceId=${workspaceId}`,
				{ token, expected: 404 }
			);
		}
		for (const path of [
			...paths,
			'/crm/intake/inbox',
			'/crm/sales/deals',
			'/crm/sales/tasks'
		])
			await request(
				`${path}?workspaceId=${foreignWorkspaceId}&page=1&pageSize=25`,
				{ token, expected: 403 }
			);
		await request(
			`/crm/access/team/members?workspaceId=${workspaceId}&page=1&pageSize=25`,
			{ token, expected: 403 }
		);
		await changeRole('ANALYST');
		assert.deepEqual((await permissions()).permissions, [
			'sales:analytics'
		]);
		for (const path of [
			...paths,
			'/crm/intake/inbox',
			'/crm/sales/deals',
			'/crm/sales/tasks'
		])
			await request(
				`${path}?workspaceId=${workspaceId}&page=1&pageSize=25`,
				{ token, expected: 403 }
			);
		await request(`/crm/sales/analytics?workspaceId=${workspaceId}`, {
			token
		});
		await changeRole('CRM_ADMIN');
		assert.equal((await permissions()).dataScope, 'ALL');
		for (const path of paths) assert.equal((await list(path)).total, 3);
		await request(
			`/crm/access/team/members?workspaceId=${workspaceId}&page=1&pageSize=25`,
			{ token }
		);
		await changeRole('MANAGER');
		for (const path of paths) assert.equal((await list(path)).total, 1);
		log(
			'Actual HTTP reauthorization: OWN/TEAM/ALL, analyst PII denial, cross-workspace denial and version conflicts verified.'
		);
		phase = 'disable and FIFO promotion';
		const disable = command({ expectedVersion: active.version });
		const disabled = await request(
			`/crm/access/team/members/${active.id}/disable`,
			{ token: tokens.owner, body: disable }
		);
		assert.ok(disabled.member.disabledAt);
		members = await until(async () => {
			const value = await roster();
			return value.items.length === 2 &&
				value.quota.usedSeats === 2 &&
				value.quota.waitingCount === 0
				? value
				: false;
		});
		await request(`/crm/access/permissions?workspaceId=${workspaceId}`, {
			token,
			expected: 403
		});
		const next = members.items.find(member => member.id !== active.id);
		assert.equal(next.disabledAt, null);
		phase = 're-enable waits then consumes released slot';
		const enabling = await request(
			`/crm/access/team/members/${active.id}/enable`,
			{
				token: tokens.owner,
				body: command({ expectedVersion: disabled.member.version })
			}
		);
		assert.equal(enabling.admission.status, 'WAITING');
		assert.deepEqual((await roster()).quota, {
			seatLimit: 2,
			usedSeats: 2,
			waitingCount: 1
		});
		await request(`/crm/access/permissions?workspaceId=${workspaceId}`, {
			token,
			expected: 403
		});
		await request(`/crm/access/team/members/${next.id}/disable`, {
			token: tokens.owner,
			body: command({ expectedVersion: next.version })
		});
		await until(async () => {
			const value = await roster();
			return (
				value.quota.usedSeats === 2 &&
				value.quota.waitingCount === 0 &&
				value.items.find(member => member.id === active.id)?.disabledAt ===
					null
			);
		});
		assert.equal((await permissions()).dataScope, 'OWN');
		phase = 'durable terminal observations';
		await until(
			async () =>
				(await accessDb.crmTeamDelivery.count({
					where: { workspaceId, status: { not: 'DELIVERED' } }
				})) === 0
		);
		await until(
			async () =>
				(await accessDb.crmTeamOutbox.count({
					where: { status: { not: 'PUBLISHED' } }
				})) === 0
		);
		assert.equal(
			await accessDb.crmTeamDelivery.count({
				where: { workspaceId, consumer: 'acceptance', status: 'DELIVERED' }
			}),
			2
		);
		assert.equal(
			await accessDb.crmWorkspaceMember.count({
				where: { workspaceId, disabledAt: null }
			}),
			1
		);
		assert.equal(
			await identityDb.workspaceMember.count({
				where: { workspaceId, status: 'ACTIVE' }
			}),
			3
		);
		assert.equal(
			await identityDb.workspaceInvitation.count({
				where: {
					workspaceId,
					status: 'ACCEPTED',
					notificationEventId: null
				}
			}),
			2
		);
		const result = {
			runId,
			actualEntrypoints: true,
			concurrentBlockedConsumers: 2,
			seatLimit: 2,
			ownerIncluded: true,
			pendingConsumesSeat: false,
			disabledConsumesSeat: false,
			fifoVerified: true,
			commandReplayVerified: true,
			reenableVerified: true,
			rolesVerified: [
				'OWNER',
				'MANAGER',
				'TEAM_LEAD',
				'ANALYST',
				'CRM_ADMIN'
			],
			customerScopesVerified: ['OWN', 'TEAM', 'ALL'],
			crossWorkspaceDeniedServices: [
				'crm-customers',
				'crm-intake',
				'crm-sales'
			],
			browserVerified: false,
			releaseImagesVerified: false,
			emailDeliveryVerified: false,
			nativeWidgetSnapshotsVerified: false,
			resourceCleanupPending: true
		};
		log(
			'Actual team runtime proof PASS; browser, image, email and native-widget-snapshot proofs remain separate.'
		);
		return result;
	} catch (error) {
		const status = Number.isInteger(error?.httpStatus)
			? ` (HTTP ${error.httpStatus})`
			: '';
		throw new Error(
			`Team runtime proof failed during ${phase}${status}; values suppressed`
		);
	} finally {
		releaseBarrier?.();
		await barrier?.catch(() => {});
		await Promise.all([
			accessDb?.$disconnect(),
			identityDb?.$disconnect()
		]);
	}
}

async function main() {
	assert.equal(
		process.env.WINCRM_LOCAL_STACK_ALLOW_MUTATION,
		'true',
		'Explicit local mutation consent required'
	);
	assert.equal(
		process.argv.length,
		3,
		'Provide one exact private browser fixture'
	);
	const path = process.argv[2];
	assert.equal(basename(path), 'browser-fixture.json');
	assert.equal(path, await realpath(path), 'Symlinks forbidden');
	for (const entry of [dirname(path), path]) {
		const info = await lstat(entry);
		assert.equal(info.uid, process.getuid());
		assert.equal(info.mode & 0o077, 0, 'Private fixture required');
	}
	const fixture = validateTeamRuntimeFixture(
		JSON.parse(await readFile(path, 'utf8'))
	);
	// Never silently rerun partially completed mutations against the same personas.
	await writeFile(
		join(dirname(path), 'team-runtime-started.json'),
		JSON.stringify({
			runId: fixture.runId,
			startedAt: new Date().toISOString()
		}),
		{ mode: 0o600, flag: 'wx' }
	);
	const evidence = await verifyTeamRuntime(fixture, message =>
		console.log(`[team-runtime] ${message}`)
	);
	await writeFile(
		join(dirname(path), 'team-runtime-result.json'),
		JSON.stringify(evidence),
		{ mode: 0o600, flag: 'wx' }
	);
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	main().catch(error => {
		const safe =
			/^Team runtime proof failed during [A-Za-z0-9 ,/-]+(?: \(HTTP [0-9]{3}\))?; values suppressed$/.test(
				error?.message
			)
				? error.message
				: 'Failed; private fixture and owned resources preserved for review.';
		console.error(`[team-runtime] ${safe}`);
		process.exitCode = 1;
	});
}
