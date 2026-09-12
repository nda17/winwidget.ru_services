import { EmailVerificationService } from './email-verification.service';
import { hash } from 'bcryptjs';

jest.mock('../common/identity.util', () => ({
	...jest.requireActual('../common/identity.util'),
	PASSWORD_SALT_ROUNDS: 4
}));

function matches(row: any, where: any): boolean {
	return Object.entries(where || {}).every(
		([key, value]: [string, any]) => {
			if (key === 'OR')
				return value.some((item: any) => matches(row, item));
			if (key === 'type_purpose_value' || key === 'userId_type_purpose')
				return matches(row, value);
			if (value && typeof value === 'object' && !(value instanceof Date)) {
				return Object.entries(value).every(
					([operator, expected]: [string, any]) =>
						operator === 'gt'
							? row[key] > expected
							: operator === 'lte'
								? row[key] <= expected
								: operator === 'lt'
									? row[key] < expected
									: operator === 'not'
										? row[key] !== expected
										: false
				);
			}
			return row[key] === value;
		}
	);
}

function harness() {
	const state: { challenges: any[]; attempts: any[] } = {
		challenges: [],
		attempts: []
	};
	const table = (name: keyof typeof state) => ({
		findUnique: async ({ where }: any) =>
			structuredClone(
				state[name].find(row => matches(row, where)) || null
			),
		findFirst: async ({ where, orderBy }: any) =>
			structuredClone(
				state[name]
					.filter(row => matches(row, where))
					.sort((a, b) => (orderBy ? b.createdAt - a.createdAt : 0))[0] ||
					null
			),
		findMany: async ({ where, take }: any) =>
			structuredClone(
				state[name]
					.filter(row => matches(row, where))
					.sort((a, b) => b.createdAt - a.createdAt)
					.slice(0, take || 100)
			),
		count: async ({ where }: any) =>
			state[name].filter(row => matches(row, where)).length,
		create: async ({ data }: any) => {
			const row = {
				id: 'challenge',
				userId: null,
				attempts: 0,
				passwordHash: null,
				emailDeliveryManaged: false,
				deliveryLeaseToken: null,
				deliveryLeaseExpiresAt: null,
				lastSentAt: new Date(),
				createdAt: new Date(),
				...data
			};
			state[name].push(row);
			return structuredClone(row);
		},
		updateMany: async ({ where, data }: any) => {
			const rows = state[name].filter(row => matches(row, where));
			for (const row of rows)
				for (const [key, value] of Object.entries(data))
					row[key] =
						value && typeof value === 'object' && 'increment' in value
							? row[key] + (value as any).increment
							: value;
			return { count: rows.length };
		},
		delete: async ({ where }: any) => {
			state[name] = state[name].filter(row => !matches(row, where));
		},
		deleteMany: async ({ where }: any) => {
			const rows = state[name].filter(row => matches(row, where));
			state[name] = state[name].filter(row => !matches(row, where));
			if (name === 'challenges')
				state.attempts = state.attempts.filter(
					row => !rows.some(item => item.id === row.challengeId)
				);
			return { count: rows.length };
		}
	});
	let tail = Promise.resolve();
	let inTransaction = false;
	const prisma: any = {
		authIdentity: { findUnique: async () => null },
		verificationChallenge: table('challenges'),
		verificationEmailAttempt: table('attempts'),
		$queryRaw: async () => []
	};
	prisma.$transaction = async (callback: any) => {
		const previous = tail;
		let release!: () => void;
		tail = new Promise<void>(resolve => {
			release = resolve;
		});
		await previous;
		const snapshot = structuredClone(state);
		inTransaction = true;
		try {
			return await callback(prisma);
		} catch (error) {
			Object.assign(state, snapshot);
			throw error;
		} finally {
			inTransaction = false;
			release();
		}
	};
	const sent: { value: string; code: string; id: string }[] = [];
	const transport = {
		emailCode: jest.fn(async (value: string, code: string, id: string) => {
			expect(inTransaction).toBe(false);
			sent.push({ value, code, id });
		})
	};
	const service = new EmailVerificationService(prisma, transport as any);
	const allowResend = () => {
		state.challenges[0].emailResendAvailableAt = new Date(0);
	};
	return { state, prisma, sent, transport, service, allowResend };
}

const scope = {
	purpose: 'REGISTER' as const,
	value: 'recipient@example.test'
};

describe('email verification delivery history', () => {
	it('keeps old and possibly delivered new codes usable after an unknown result', async () => {
		const h = harness();
		await h.service.issue(scope, 'first-password-hash');
		h.allowResend();
		h.transport.emailCode.mockImplementationOnce(
			async (value, code, id) => {
				h.sent.push({ value, code, id });
				throw new Error('connection interrupted');
			}
		);
		await expect(
			h.service.issue(scope, 'second-password-hash')
		).rejects.toMatchObject({
			response: {
				code: 'email_delivery_unknown',
				expiresAt: expect.any(String),
				resendAvailableAt: expect.any(String)
			}
		});
		expect(
			(await h.service.validate(scope, h.sent[0].code)).passwordHash
		).toBe('first-password-hash');
		expect(
			(await h.service.validate(scope, h.sent[1].code)).passwordHash
		).toBe('second-password-hash');
	});

	it('preserves the prior delivered code after a definite failure and retries after its deadline', async () => {
		const h = harness();
		await h.service.issue(scope, 'password-hash');
		h.allowResend();
		h.transport.emailCode.mockRejectedValueOnce(
			Object.assign(new Error('synthetic'), { outcome: 'FAILED' })
		);
		await expect(h.service.issue(scope)).rejects.toMatchObject({
			response: { code: 'email_delivery_failed' }
		});
		expect(
			(await h.service.validate(scope, h.sent[0].code)).passwordHash
		).toBe('password-hash');
		expect(h.state.attempts[1].outcome).toBe('FAILED');
		await expect(h.service.issue(scope)).rejects.toMatchObject({
			response: { code: 'email_code_resend_cooldown' }
		});
		h.allowResend();
		await h.service.issue(scope);
		expect(h.sent).toHaveLength(2);
	});

	it('allows only one concurrent send for the same pending registration', async () => {
		const h = harness();
		let release!: () => void;
		const blocked = new Promise<void>(resolve => {
			release = resolve;
		});
		h.transport.emailCode.mockImplementationOnce(async () => blocked);
		const first = h.service.issue(scope, 'password');
		while (!h.transport.emailCode.mock.calls.length)
			await new Promise(resolve => setImmediate(resolve));
		await expect(
			h.service.issue(scope, 'other-password')
		).rejects.toMatchObject({
			response: { code: 'email_code_resend_cooldown' }
		});
		release();
		await first;
		expect(h.transport.emailCode).toHaveBeenCalledTimes(1);
	});

	it('counts concurrent wrong guesses atomically and never resets the shared budget on resend', async () => {
		const h = harness();
		await h.service.issue(scope, 'password');
		await Promise.allSettled(
			[1, 2, 3].map(() => h.service.validate(scope, '000000'))
		);
		expect(h.state.challenges[0].attempts).toBe(3);
		h.allowResend();
		await h.service.issue(scope);
		expect(h.state.challenges[0].attempts).toBe(3);
		await Promise.allSettled(
			[1, 2, 3, 4].map(() => h.service.validate(scope, '000000'))
		);
		expect(h.state.challenges[0].attempts).toBe(5);
		const deadline = h.state.challenges[0].expiresAt.toISOString();
		const exhausted = {
			response: {
				code: 'email_code_attempts_exceeded',
				message:
					'Лимит попыток исчерпан. Запросите новый код после завершения текущей проверки.',
				expiresAt: deadline,
				resendAvailableAt: deadline
			}
		};
		await expect(
			h.service.validate(scope, h.sent[0].code)
		).rejects.toMatchObject(exhausted);
		await expect(h.service.issue(scope)).rejects.toMatchObject(exhausted);
		expect(h.transport.emailCode).toHaveBeenCalledTimes(2);
	});

	it('returns the full wait deadline on the fifth incorrect guess', async () => {
		const h = harness();
		await h.service.issue(scope, 'password');
		h.state.challenges[0].attempts = 4;
		const deadline = h.state.challenges[0].expiresAt.toISOString();
		await expect(
			h.service.validate(scope, '000000')
		).rejects.toMatchObject({
			response: {
				code: 'email_code_attempts_exceeded',
				expiresAt: deadline,
				resendAvailableAt: deadline
			}
		});
		expect(h.state.challenges[0].attempts).toBe(5);
	});

	it('returns the deadline when concurrent wrong guesses exhaust a code already validated', async () => {
		const h = harness();
		await h.service.issue(scope, 'password');
		const verified = await h.service.validate(scope, h.sent[0].code);
		h.state.challenges[0].attempts = 5;
		const deadline = h.state.challenges[0].expiresAt.toISOString();
		await expect(
			h.prisma.$transaction((tx: any) => h.service.consume(tx, verified))
		).rejects.toMatchObject({
			response: {
				code: 'email_code_attempts_exceeded',
				expiresAt: deadline,
				resendAvailableAt: deadline
			}
		});
		expect(h.state.challenges).toHaveLength(1);
	});

	it('imports legacy codes without changing their original expiry or password', async () => {
		const h = harness();
		const expiresAt = new Date(Date.now() + 120_000);
		await h.prisma.verificationChallenge.create({
			data: {
				type: 'EMAIL',
				purpose: 'REGISTER',
				value: scope.value,
				codeHash: await hash('123456', 4),
				passwordHash: 'legacy-password',
				expiresAt,
				lastSentAt: new Date(Date.now() - 61_000)
			}
		});
		const legacy = await h.service.validate(scope, '123456');
		await h.service.issue(scope, 'new-password');
		expect((await h.service.validate(scope, '123456')).passwordHash).toBe(
			'legacy-password'
		);
		expect(h.state.attempts[0].expiresAt).toEqual(expiresAt);
		await h.prisma.$transaction((tx: any) =>
			h.service.consume(tx, legacy)
		);
		expect(h.state.challenges).toHaveLength(0);
		expect(h.state.attempts).toHaveLength(0);
	});

	it('keeps binding codes scoped to the email they actually verified', async () => {
		const h = harness();
		const first = {
			purpose: 'BIND_IDENTITY' as const,
			userId: 'user',
			value: 'first@example.test'
		};
		const next = { ...first, value: 'next@example.test' };
		await h.service.issue(first);
		h.allowResend();
		await h.service.issue(next);
		await expect(h.service.validate(next, h.sent[0].code)).rejects.toThrow(
			'invalid'
		);
		const verified = await h.service.validate(first, h.sent[0].code);
		await h.prisma.$transaction((tx: any) =>
			h.service.consume(tx, verified)
		);
		await expect(h.service.validate(next, h.sent[1].code)).rejects.toThrow(
			'not found'
		);
	});

	it('bounds delivery history even when explicit SMTP failures shorten the retry delay', async () => {
		const h = harness();
		h.transport.emailCode.mockRejectedValue(
			Object.assign(new Error('synthetic'), { outcome: 'FAILED' })
		);
		for (let index = 0; index < 10; index += 1) {
			await expect(
				h.service.issue(scope, 'password')
			).rejects.toMatchObject({
				response: { code: 'email_delivery_failed' }
			});
			h.allowResend();
		}
		await expect(h.service.issue(scope, 'password')).rejects.toMatchObject(
			{ response: { code: 'email_code_resend_cooldown' } }
		);
		expect(h.transport.emailCode).toHaveBeenCalledTimes(10);
	});
});
