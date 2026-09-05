import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';

const require = createRequire(import.meta.url);
let stage = 'guards';

function target(name) {
	const raw = process.env[name]?.trim();
	assert.ok(raw, `Missing ${name}`);
	const url = new URL(raw);
	assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
	assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname));
	assert.match(url.pathname, /^\/winwidget_identity_test[a-z0-9_]*$/);
	assert.deepEqual(url.searchParams.getAll('schema'), ['identity']);
	assert.equal(url.hash, '');
	assert.match(decodeURIComponent(url.username), /^[a-z][a-z0-9_]{0,62}$/);
	return {
		raw,
		database: url.pathname,
		peer: `${url.hostname}:${url.port}`,
		role: decodeURIComponent(url.username)
	};
}

const digest = value => createHash('sha256').update(value).digest('hex');
const context = ip => ({
	ip,
	get: () => undefined,
	headers: { 'x-forwarded-for': '198.51.100.199' }
});

async function main() {
	assert.equal(process.env.IDENTITY_INTEGRATION_ALLOW_MUTATION, 'true');
	const runtimeTarget = target('IDENTITY_TEST_DATABASE_URL');
	const migrationTarget = target('IDENTITY_TEST_MIGRATION_DATABASE_URL');
	assert.equal(runtimeTarget.database, migrationTarget.database);
	assert.equal(runtimeTarget.peer, migrationTarget.peer);
	assert.notEqual(runtimeTarget.role, migrationTarget.role);
	require('reflect-metadata');
	const { PrismaClient } = require('@prisma/identity-client');
	const { ConfigService } = require('@nestjs/config');
	const { hash, compare } = require('bcryptjs');
	const {
		LoginOtpService,
		LOGIN_OTP_POLICY
	} = require('../../dist/src/auth/login-otp.service.js');
	const {
		RefreshTokenService
	} = require('../../dist/src/auth/refresh-token.service.js');
	const runtime = new PrismaClient({
		datasources: { db: { url: runtimeTarget.raw } },
		log: [],
		errorFormat: 'minimal'
	});
	const migrator = new PrismaClient({
		datasources: { db: { url: migrationTarget.raw } },
		log: [],
		errorFormat: 'minimal'
	});
	const marker = randomUUID();
	const users = [0, 1, 2].map(index => `otp-test-${marker}-${index}`);
	const emails = users.map(user => `${user}@example.test`);
	const identityIds = users.map(user => `identity-${user}`);
	const verifiedAt = new Date('2026-09-01T00:00:00.000Z');
	const delivered = [];
	let rejectDelivery = false;
	const transport = {
		isEmailConfigured: () => true,
		isSmsConfigured: () => true,
		loginCode: async (channel, destination, code, signal) => {
			assert.ok(signal instanceof AbortSignal);
			assert.equal(signal.aborted, false);
			assert.match(code, /^\d{6}$/);
			if (rejectDelivery) throw new Error('Synthetic transport failure');
			delivered.push({ channel, destination, code });
		}
	};
	const service = new LoginOtpService(
		runtime,
		new ConfigService({ IDENTITY_LOGIN_OTP_ENABLED: 'true' }),
		transport,
		{
			issue: (userId, _rights, sessionId) =>
				`synthetic:${userId}:${sessionId}`
		},
		new RefreshTokenService(),
		{ ensureTrial: async () => undefined }
	);
	let failure = null;
	try {
		stage = 'database-role';
		const [role] =
			await runtime.$queryRawUnsafe(`SELECT current_user AS name, current_setting('server_version_num')::integer AS version,
			NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolbypassrls AND NOT rolinherit AND NOT rolreplication AS restricted
			FROM pg_roles WHERE rolname=current_user`);
		assert.equal(role.name, runtimeTarget.role);
		assert.equal(Math.floor(role.version / 10_000), 18);
		assert.equal(role.restricted, true);
		await assert.rejects(
			runtime.$executeRawUnsafe(
				'CREATE TABLE identity.otp_forbidden_probe (id INTEGER)'
			)
		);
		for (let index = 0; index < users.length; index++) {
			await migrator.user.create({
				data: {
					id: users[index],
					password: 'synthetic-unused-password-hash',
					authIdentities: {
						create: {
							id: identityIds[index],
							type: 'EMAIL',
							value: emails[index],
							verifiedAt: index === 2 ? null : verifiedAt
						}
					}
				}
			});
		}
		assert.equal((await service.capabilities()).available, true);

		stage = 'request-and-decoy-envelope';
		const started = performance.now();
		const issued = await service.request(
			{ channel: 'EMAIL', destination: emails[0].toUpperCase() },
			context('192.0.2.10')
		);
		assert.ok(
			performance.now() - started >= LOGIN_OTP_POLICY.responseFloorMs - 20
		);
		assert.equal(delivered.length, 1);
		assert.equal(delivered[0].destination, emails[0]);
		const stored = await migrator.loginOtpChallenge.findUniqueOrThrow({
			where: { id: issued.challengeId }
		});
		assert.equal(stored.browserTokenHash, digest(issued.browserToken));
		assert.equal(stored.destinationHash, digest(`EMAIL:${emails[0]}`));
		assert.equal(stored.purpose, 'LOGIN_FALLBACK');
		assert.equal(stored.authIdentityId, identityIds[0]);
		assert.ok(
			await compare(
				`${issued.browserToken}:${delivered[0].code}`,
				stored.codeHash
			)
		);
		assert.equal(await compare(delivered[0].code, stored.codeHash), false);
		const fake = await service.request(
			{ channel: 'EMAIL', destination: `absent-${marker}@example.test` },
			context('192.0.2.11')
		);
		const unverified = await service.request(
			{ channel: 'EMAIL', destination: emails[2] },
			context('192.0.2.12')
		);
		assert.deepEqual(Object.keys(fake), Object.keys(issued));
		assert.deepEqual(Object.keys(unverified), Object.keys(issued));
		assert.equal(delivered.length, 1);
		assert.equal(
			(
				await migrator.loginOtpChallenge.findUniqueOrThrow({
					where: { id: fake.challengeId }
				})
			).userId,
			null
		);
		assert.equal(
			(
				await migrator.loginOtpChallenge.findUniqueOrThrow({
					where: { id: unverified.challengeId }
				})
			).userId,
			null
		);
		rejectDelivery = true;
		const failedSend = await service.request(
			{ channel: 'EMAIL', destination: emails[1] },
			context('192.0.2.13')
		);
		assert.deepEqual(Object.keys(failedSend), Object.keys(issued));
		assert.equal(
			(
				await migrator.loginOtpChallenge.findUniqueOrThrow({
					where: { id: issued.challengeId }
				})
			).consumedAt,
			null
		);
		rejectDelivery = false;

		stage = 'parallel-correct-single-session';
		const dto = {
			challengeId: issued.challengeId,
			browserToken: issued.browserToken,
			code: delivered[0].code
		};
		const attempts = await Promise.allSettled(
			Array.from({ length: 8 }, () =>
				service.verify(dto, context('192.0.2.20'))
			)
		);
		assert.equal(
			attempts.filter(item => item.status === 'fulfilled').length,
			1
		);
		assert.equal(
			await migrator.userSession.count({ where: { userId: users[0] } }),
			1
		);
		assert.ok(
			(
				await migrator.loginOtpChallenge.findUniqueOrThrow({
					where: { id: issued.challengeId }
				})
			).consumedAt
		);
		await assert.rejects(
			service.verify(dto, context('192.0.2.20')),
			error => error.getResponse().code === 'login_otp_invalid'
		);

		async function seed(index = 1) {
			const id = randomUUID();
			const browserToken = randomBytes(32).toString('base64url');
			const code = '654321';
			const now = new Date();
			await migrator.loginOtpChallenge.create({
				data: {
					id,
					channel: 'EMAIL',
					userId: users[index],
					authIdentityId: identityIds[index],
					identityVerifiedAt: verifiedAt,
					destinationHash: digest(`EMAIL:${emails[index]}`),
					browserTokenHash: digest(browserToken),
					codeHash: await hash(`${browserToken}:${code}`, 4),
					createdAt: now,
					expiresAt: new Date(now.getTime() + 300_000)
				}
			});
			return { challengeId: id, browserToken, code };
		}

		stage = 'parallel-wrong-attempt-cap';
		const wrong = await seed();
		const wrongAttempts = await Promise.allSettled(
			Array.from({ length: 16 }, () =>
				service.verify({ ...wrong, code: '111111' }, context('192.0.2.21'))
			)
		);
		assert.equal(
			wrongAttempts.filter(item => item.status === 'fulfilled').length,
			0
		);
		assert.equal(
			(
				await migrator.loginOtpChallenge.findUniqueOrThrow({
					where: { id: wrong.challengeId }
				})
			).attempts,
			5
		);
		await assert.rejects(
			service.verify(wrong, context('192.0.2.21')),
			error => error.getResponse().code === 'login_otp_invalid'
		);
		assert.equal(
			await migrator.userSession.count({ where: { userId: users[1] } }),
			0
		);

		stage = 'user-deactivation-and-contact-rebind';
		const revoked = await seed();
		await migrator.user.update({
			where: { id: users[1] },
			data: { status: 'DEACTIVATED' }
		});
		await assert.rejects(
			service.verify(revoked, context('192.0.2.22')),
			error => error.getResponse().code === 'login_otp_invalid'
		);
		await migrator.user.update({
			where: { id: users[1] },
			data: { status: 'ACTIVE' }
		});
		await migrator.authIdentity.update({
			where: { id: identityIds[1] },
			data: { verifiedAt: new Date() }
		});
		await assert.rejects(
			service.verify(revoked, context('192.0.2.22')),
			error => error.getResponse().code === 'login_otp_invalid'
		);
		await migrator.authIdentity.update({
			where: { id: identityIds[1] },
			data: { verifiedAt }
		});

		stage = 'rollback-preserves-unconsumed-code';
		const rollback = await seed();
		const proxy = new Proxy(runtime, {
			get(target, key) {
				if (key === '$transaction')
					return (callback, options) =>
						target.$transaction(
							transaction =>
								callback(
									new Proxy(transaction, {
										get(tx, property) {
											if (property === 'userSession')
												return {
													create: async () => {
														throw new Error(
															'Synthetic session insert failure'
														);
													}
												};
											const value = tx[property];
											return typeof value === 'function'
												? value.bind(tx)
												: value;
										}
									})
								),
							options
						);
				const value = target[key];
				return typeof value === 'function' ? value.bind(target) : value;
			}
		});
		const failing = new LoginOtpService(
			proxy,
			new ConfigService({ IDENTITY_LOGIN_OTP_ENABLED: 'true' }),
			transport,
			{ issue: () => 'synthetic' },
			new RefreshTokenService(),
			{ ensureTrial: async () => undefined }
		);
		await assert.rejects(failing.verify(rollback, context('192.0.2.23')));
		assert.equal(
			(
				await migrator.loginOtpChallenge.findUniqueOrThrow({
					where: { id: rollback.challengeId }
				})
			).consumedAt,
			null
		);
		await service.verify(rollback, context('192.0.2.23'));
		assert.equal(
			await migrator.userSession.count({ where: { userId: users[1] } }),
			1
		);

		stage = 'signing-failure-rolls-back';
		const signing = await seed();
		const brokenSigner = new LoginOtpService(
			runtime,
			new ConfigService({ IDENTITY_LOGIN_OTP_ENABLED: 'true' }),
			transport,
			{
				issue: () => {
					throw new Error('Synthetic signing failure');
				}
			},
			new RefreshTokenService(),
			{ ensureTrial: async () => undefined }
		);
		await assert.rejects(
			brokenSigner.verify(signing, context('192.0.2.24'))
		);
		assert.equal(
			(
				await migrator.loginOtpChallenge.findUniqueOrThrow({
					where: { id: signing.challengeId }
				})
			).consumedAt,
			null
		);
		assert.equal(
			await migrator.userSession.count({ where: { userId: users[1] } }),
			1
		);

		stage = 'contact-update-race';
		const racing = await seed();
		const previousContactChallenge = await seed();
		let signalLocked;
		let releaseLock;
		const locked = new Promise(resolve => {
			signalLocked = resolve;
		});
		const released = new Promise(resolve => {
			releaseLock = resolve;
		});
		const lockedRuntime = new Proxy(runtime, {
			get(target, key) {
				if (key === '$transaction')
					return (callback, options) =>
						target.$transaction(
							transaction =>
								callback(
									new Proxy(transaction, {
										get(tx, property) {
											if (property === '$queryRaw')
												return async (...args) => {
													const result = await tx.$queryRaw(...args);
													if (
														args[0]?.sql?.includes(
															'FROM identity.auth_identities'
														) &&
														args[0].sql.includes('FOR UPDATE')
													) {
														signalLocked();
														await released;
													}
													return result;
												};
											const value = tx[property];
											return typeof value === 'function'
												? value.bind(tx)
												: value;
										}
									})
								),
							options
						);
				const value = target[key];
				return typeof value === 'function' ? value.bind(target) : value;
			}
		});
		const lockingService = new LoginOtpService(
			lockedRuntime,
			new ConfigService({ IDENTITY_LOGIN_OTP_ENABLED: 'true' }),
			transport,
			{ issue: () => 'synthetic' },
			new RefreshTokenService(),
			{ ensureTrial: async () => undefined }
		);
		const login = lockingService.verify(racing, context('192.0.2.25'));
		let update;
		try {
			await Promise.race([
				locked,
				delay(3000, undefined, { ref: false }).then(() => {
					throw new Error('Contact lock was not acquired');
				})
			]);
			update = migrator.authIdentity
				.update({
					where: { id: identityIds[1] },
					data: { verifiedAt: new Date() }
				})
				.then(
					value => value,
					error => error
				);
			let observedLock = false;
			for (let attempt = 0; attempt < 50; attempt++) {
				const [state] = await migrator.$queryRawUnsafe(
					`SELECT count(*)::integer AS waiting FROM pg_stat_activity WHERE usename = current_user AND wait_event_type = 'Lock' AND query LIKE '%auth_identities%'`
				);
				if (state.waiting > 0) {
					observedLock = true;
					break;
				}
				await delay(20);
			}
			assert.equal(
				observedLock,
				true,
				'Contact writer must wait for the OTP row lock'
			);
		} finally {
			releaseLock();
		}
		await login;
		assert.ok(!((await update) instanceof Error));
		await assert.rejects(
			service.verify(previousContactChallenge, context('192.0.2.26')),
			error => error.getResponse().code === 'login_otp_invalid'
		);
		assert.equal(
			await migrator.userSession.count({ where: { userId: users[1] } }),
			2
		);

		stage = 'durable-cooldown-parallel-request';
		const globalKey = digest('LOGIN_FALLBACK:request:EMAIL:hour');
		const beforeGlobal = (
			await migrator.loginOtpRateLimit.findUniqueOrThrow({
				where: { key: globalKey }
			})
		).count;
		const limitedEmail = `limited-${marker}@example.test`;
		const sends = await Promise.allSettled(
			Array.from({ length: 8 }, () =>
				service.request(
					{ channel: 'EMAIL', destination: limitedEmail },
					context('192.0.2.30')
				)
			)
		);
		assert.equal(
			sends.filter(item => item.status === 'fulfilled').length,
			1
		);
		assert.ok(
			sends
				.filter(item => item.status === 'rejected')
				.every(
					item =>
						item.reason.getResponse().code === 'login_otp_rate_limited'
				)
		);
		const restarted = new LoginOtpService(
			runtime,
			new ConfigService({ IDENTITY_LOGIN_OTP_ENABLED: 'true' }),
			transport,
			{ issue: () => 'synthetic' },
			new RefreshTokenService(),
			{ ensureTrial: async () => undefined }
		);
		await assert.rejects(
			restarted.request(
				{ channel: 'EMAIL', destination: limitedEmail },
				context('192.0.2.31')
			),
			error => error.getResponse().code === 'login_otp_rate_limited'
		);
		assert.equal(
			(
				await migrator.loginOtpRateLimit.findUniqueOrThrow({
					where: { key: globalKey }
				})
			).count,
			beforeGlobal + 1
		);

		stage = 'constraints';
		await assert.rejects(
			migrator.loginOtpChallenge.update({
				where: { id: rollback.challengeId },
				data: { attempts: 6 }
			})
		);
		await assert.rejects(
			migrator.loginOtpChallenge.update({
				where: { id: rollback.challengeId },
				data: { purpose: 'REGISTER' }
			})
		);
		await assert.rejects(
			migrator.loginOtpChallenge.update({
				where: { id: rollback.challengeId },
				data: { expiresAt: new Date(Date.now() + 900_000) }
			})
		);
		stage = 'complete';
	} catch (error) {
		failure = error;
	} finally {
		// This fixture is a fresh dedicated test DB. Remove only its seeded users;
		// the owning test runner disposes its complete DB and rate counters.
		await migrator.user.deleteMany({ where: { id: { in: users } } });
		await Promise.allSettled([
			runtime.$disconnect(),
			migrator.$disconnect()
		]);
	}
	if (failure) {
		process.stderr.write(
			`Identity login OTP PostgreSQL18 gate failed at ${stage}; provider/credential data suppressed.\n`
		);
		process.exitCode = 1;
	} else
		process.stdout.write(
			'Identity login OTP PostgreSQL18 gate GREEN: restricted role, request decoys, single-use concurrency, attempt cap, rollback, durable quotas, contact revocation, constraints; synthetic delivery only.\n'
		);
}

await main().catch(() => {
	process.stderr.write(
		`Identity login OTP PostgreSQL18 bootstrap failed at ${stage}; details suppressed.\n`
	);
	process.exitCode = 1;
});
