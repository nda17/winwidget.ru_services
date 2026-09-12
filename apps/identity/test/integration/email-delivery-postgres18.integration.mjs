import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// Deterministic, distinct fixture codes keep collision probability out of the
// concurrency assertions. Production code generation is covered by unit tests.
const crypto = require('node:crypto');
const originalRandomInt = crypto.randomInt;
let fixtureCode = 100_000;
crypto.randomInt = (min, max) =>
	min === 100_000 && max === 1_000_000
		? ++fixtureCode
		: originalRandomInt(min, max);
const fixtureUrl = name => {
	const raw = process.env[name];
	assert.ok(raw, `Missing ${name}`);
	const url = new URL(raw);
	assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
	assert.ok(['localhost', '127.0.0.1'].includes(url.hostname));
	assert.match(url.pathname, /^\/winwidget_identity_test[a-z0-9_]*$/);
	assert.deepEqual(url.searchParams.getAll('schema'), ['identity']);
	return {
		raw,
		peer: `${url.hostname}:${url.port}${url.pathname}`,
		role: url.username
	};
};
assert.equal(process.env.IDENTITY_INTEGRATION_ALLOW_MUTATION, 'true');
const target = fixtureUrl('IDENTITY_TEST_DATABASE_URL');
const migration = fixtureUrl('IDENTITY_TEST_MIGRATION_DATABASE_URL');
assert.equal(target.peer, migration.peer);
assert.notEqual(target.role, migration.role);
process.env.IDENTITY_DATABASE_URL = target.raw;
require('reflect-metadata');
const { PrismaClient } = require('@prisma/identity-client');
const { hash, compare } = require('bcryptjs');
const {
	EmailVerificationService
} = require('../../dist/src/auth/email-verification.service.js');
const {
	EmailPasswordRecoveryService
} = require('../../dist/src/auth/email-password-recovery.service.js');
const {
	EmailDeliveryException
} = require('../../dist/src/transports/verification-transport.service.js');
const runtime = new PrismaClient({
	datasources: { db: { url: target.raw } },
	log: [],
	errorFormat: 'minimal'
});
const admin = new PrismaClient({
	datasources: { db: { url: migration.raw } },
	log: [],
	errorFormat: 'minimal'
});
const marker = randomUUID();
const userId = `email-test-${marker}`;
const email = `${userId}@example.test`;
const values = new Set([email]);
const sent = [];
let outcome = 'ACCEPTED';
let entered;
let release;
const transport = {
	emailCode: async (value, code, attemptId) => {
		sent.push({ value, code, attemptId });
		if (entered) {
			entered();
			await new Promise(resolve => {
				release = resolve;
			});
		}
		if (outcome !== 'ACCEPTED')
			throw new EmailDeliveryException(outcome, attemptId);
	},
	newPassword: async (_email, _password, attemptId) => {
		if (outcome !== 'ACCEPTED')
			throw new EmailDeliveryException(outcome, attemptId);
	}
};
const codes = new EmailVerificationService(runtime, transport);
const recovery = new EmailPasswordRecoveryService(runtime, transport);
const scope = suffix => {
	const value = `email-${suffix}-${marker}@example.test`;
	values.add(value);
	return { purpose: 'REGISTER', value };
};
const expireCooldown = async current => {
	await admin.verificationChallenge.updateMany({
		where: { value: current.value },
		data: { emailResendAvailableAt: new Date(0) }
	});
};
const user = () =>
	runtime.user.findUnique({
		where: { id: userId },
		include: { authIdentities: true }
	});
let stage = 'connect';
try {
	await runtime.$connect();
	await admin.$connect();
	const [role] =
		await runtime.$queryRawUnsafe(`SELECT current_user AS name, current_setting('server_version_num')::int AS version,
		NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolbypassrls AND NOT rolinherit AND NOT rolreplication AS restricted
		FROM pg_roles WHERE rolname = current_user`);
	assert.equal(role.name, decodeURIComponent(target.role));
	assert.equal(Math.floor(role.version / 10000), 18);
	assert.equal(role.restricted, true);
	await assert.rejects(
		runtime.$executeRawUnsafe(
			'CREATE TABLE identity.email_forbidden_probe(id int)'
		)
	);
	const originalHash = await hash('OriginalPass1', 4);
	await admin.user.create({
		data: {
			id: userId,
			password: originalHash,
			authIdentities: {
				create: { type: 'EMAIL', value: email, verifiedAt: new Date() }
			}
		}
	});
	await admin.userSession.create({
		data: {
			id: randomUUID(),
			userId,
			refreshTokenHash: 'synthetic-only',
			expiresAt: new Date(Date.now() + 3600000)
		}
	});

	stage = 'parallel-issue';
	const concurrent = scope('parallel');
	const barrier = new Promise(resolve => {
		entered = resolve;
	});
	const first = codes.issue(concurrent, originalHash);
	await barrier;
	const before = sent.length;
	await assert.rejects(
		codes.issue(concurrent, originalHash),
		error => error.getStatus() === 400
	);
	assert.equal(
		sent.length,
		before,
		'Concurrent issuer must not reach SMTP'
	);
	entered = undefined;
	release();
	await first;
	const firstCode = sent.at(-1).code;
	const firstProof = await codes.validate(concurrent, firstCode);
	assert.equal(firstProof.passwordHash, originalHash);

	stage = 'failed-resend-preserves-code';
	await expireCooldown(concurrent);
	outcome = 'FAILED';
	await assert.rejects(
		codes.issue(concurrent),
		error => error.getResponse().code === 'email_delivery_failed'
	);
	await codes.validate(concurrent, firstCode);
	await assert.rejects(codes.validate(concurrent, sent.at(-1).code));

	stage = 'unknown-resend-preserves-both-and-password-snapshot';
	await expireCooldown(concurrent);
	outcome = 'UNKNOWN';
	const replacementHash = await hash('ReplacementPass2', 4);
	await assert.rejects(
		codes.issue(concurrent, replacementHash),
		error => error.getResponse().code === 'email_delivery_unknown'
	);
	const unknownCode = sent.at(-1).code;
	assert.equal(
		(await codes.validate(concurrent, firstCode)).passwordHash,
		originalHash
	);
	assert.equal(
		(await codes.validate(concurrent, unknownCode)).passwordHash,
		replacementHash
	);
	// The failed code guess above consumes the same parent budget as every generation.
	const parent = await runtime.verificationChallenge.findUnique({
		where: {
			type_purpose_value: {
				type: 'EMAIL',
				purpose: 'REGISTER',
				value: concurrent.value
			}
		}
	});
	assert.equal(parent.attempts, 1);

	stage = 'single-consumption';
	const proofA = await codes.validate(concurrent, firstCode);
	const proofB = await codes.validate(concurrent, unknownCode);
	const results = await Promise.allSettled([
		runtime.$transaction(tx => codes.consume(tx, proofA)),
		runtime.$transaction(tx => codes.consume(tx, proofB))
	]);
	assert.equal(
		results.filter(result => result.status === 'fulfilled').length,
		1
	);
	assert.equal(
		await admin.verificationEmailAttempt.count({
			where: { challengeId: parent.id }
		}),
		0
	);

	stage = 'legacy-code-preserves-expiry-and-password';
	const legacy = scope('legacy');
	const legacyExpiry = new Date(Date.now() + 240000);
	await admin.verificationChallenge.create({
		data: {
			type: 'EMAIL',
			purpose: 'REGISTER',
			value: legacy.value,
			codeHash: await hash('123456', 4),
			passwordHash: originalHash,
			expiresAt: legacyExpiry,
			lastSentAt: new Date(Date.now() - 61000)
		}
	});
	outcome = 'ACCEPTED';
	await codes.issue(legacy, replacementHash);
	const legacyProof = await codes.validate(legacy, '123456');
	assert.equal(legacyProof.passwordHash, originalHash);
	assert.equal(
		legacyProof.attempt.expiresAt.getTime(),
		legacyExpiry.getTime()
	);
	await admin.verificationEmailAttempt.updateMany({
		where: { id: legacyProof.attempt.id },
		data: { expiresAt: new Date(0) }
	});
	await assert.rejects(codes.validate(legacy, '123456'));

	stage = 'shared-guess-budget';
	const exhausted = scope('exhausted');
	await codes.issue(exhausted, originalHash);
	const validCode = sent.at(-1).code;
	await Promise.allSettled(
		Array.from({ length: 8 }, () => codes.validate(exhausted, '000000'))
	);
	const exhaustedRow = await admin.verificationChallenge.findUnique({
		where: {
			type_purpose_value: {
				type: 'EMAIL',
				purpose: 'REGISTER',
				value: exhausted.value
			}
		}
	});
	assert.equal(exhaustedRow.attempts, 5);
	await assert.rejects(codes.validate(exhausted, validCode));
	await expireCooldown(exhausted);
	await assert.rejects(
		codes.issue(exhausted),
		error =>
			error.getResponse().code === 'email_code_attempts_exceeded' &&
			error.getResponse().resendAvailableAt ===
				exhaustedRow.expiresAt.toISOString()
	);

	stage = 'binding-contact-scope';
	const binding = {
		purpose: 'BIND_IDENTITY',
		value: `bound-${marker}@example.test`,
		userId
	};
	await codes.issue(binding);
	const bindingCode = sent.at(-1).code;
	await assert.rejects(
		codes.validate(
			{ ...binding, value: `wrong-${marker}@example.test` },
			bindingCode
		)
	);
	await codes.validate(binding, bindingCode);

	stage = 'failed-recovery-keeps-password-and-sessions';
	outcome = 'FAILED';
	await assert.rejects(
		recovery.issue(userId, email, 'FailedTemp1'),
		error => error.getResponse().code === 'email_delivery_failed'
	);
	assert.equal((await user()).password, originalHash);
	assert.equal(
		await runtime.userSession.count({
			where: { userId, revokedAt: null }
		}),
		1
	);
	assert.equal(await recovery.match(await user(), 'FailedTemp1'), null);
	await admin.emailPasswordRecovery.updateMany({
		where: { userId },
		data: { createdAt: new Date(Date.now() - 61000) }
	});

	stage = 'unknown-recovery-activates-only-on-use';
	outcome = 'UNKNOWN';
	await assert.rejects(recovery.issue(userId, email, 'UnknownTemp1'));
	const beforeActivation = await user();
	assert.equal(beforeActivation.password, originalHash);
	const recovered = await recovery.match(beforeActivation, 'UnknownTemp1');
	assert.ok(recovered);
	await runtime.$transaction(async tx => {
		await tx.$queryRawUnsafe(
			'SELECT id FROM identity.users WHERE id = $1 FOR UPDATE',
			userId
		);
		const current = await tx.user.findUnique({
			where: { id: userId },
			include: { authIdentities: true }
		});
		await recovery.activate(tx, current, recovered);
	});
	assert.equal(
		await compare('UnknownTemp1', (await user()).password),
		true
	);
	assert.equal(
		await runtime.userSession.count({
			where: { userId, revokedAt: null }
		}),
		0
	);
	assert.equal(await recovery.match(await user(), 'UnknownTemp1'), null);

	stage = 'recovery-rejects-changed-password-snapshot';
	await admin.emailPasswordRecovery.updateMany({
		where: { userId },
		data: { createdAt: new Date(Date.now() - 61000) }
	});
	outcome = 'ACCEPTED';
	await recovery.issue(userId, email, 'LaterTemp2');
	await admin.user.update({
		where: { id: userId },
		data: { password: originalHash }
	});
	assert.equal(await recovery.match(await user(), 'LaterTemp2'), null);
	process.stdout.write(
		'Identity email delivery PostgreSQL18: passed concurrency, failure/unknown, legacy, consume, guesses, binding and recovery\n'
	);
} catch (error) {
	const diagnostic = String(error?.message || '').match(
		/permission denied for (?:table|schema|column) [a-z_]+|Failed to deserialize column of type '[a-z_]+'|Transaction API error: [A-Za-z ]+/i
	)?.[0];
	process.stderr.write(
		`Identity email delivery PostgreSQL18 failed at ${stage}: ${error?.name || 'Error'}${diagnostic ? ` (${diagnostic})` : ''}\n`
	);
	process.exitCode = 1;
} finally {
	crypto.randomInt = originalRandomInt;
	if (release) release();
	await admin.verificationChallenge
		.deleteMany({
			where: { OR: [{ value: { in: [...values] } }, { userId }] }
		})
		.catch(() => undefined);
	await admin.user
		.deleteMany({ where: { id: userId } })
		.catch(() => undefined);
	await Promise.all([runtime.$disconnect(), admin.$disconnect()]);
}
