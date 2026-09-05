import { ConfigService } from '@nestjs/config';
import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Role, UserStatus } from '@prisma/identity-client';
import type { Request, Response } from 'express';
import { hash, compare } from 'bcryptjs';
import request from 'supertest';
import { IdentityHttpExceptionFilter } from '../common/http-exception.filter';
import { sha256 } from '../common/identity.util';
import { LoginOtpController } from './login-otp.controller';
import { LoginOtpService, loginOtpIp } from './login-otp.service';
import { RefreshTokenService } from './refresh-token.service';
import { identityTrustProxy } from '../runtime/identity-http.config';

const token = 'A'.repeat(43);
const challengeId = '11111111-1111-4111-8111-111111111111';
const verifiedAt = new Date('2026-09-01T00:00:00Z');

function fixture() {
	const challenge = {
		id: challengeId,
		purpose: 'LOGIN_FALLBACK',
		channel: 'EMAIL',
		userId: 'user-id',
		authIdentityId: 'identity-id',
		identityVerifiedAt: verifiedAt,
		destinationHash: sha256('EMAIL:owner@example.test'),
		browserTokenHash: sha256(token),
		codeHash: '',
		attempts: 0,
		expiresAt: new Date(Date.now() + 300_000),
		consumedAt: null as Date | null
	};
	const user = {
		id: 'user-id',
		status: UserStatus.ACTIVE as UserStatus,
		deletedAt: null as Date | null,
		rights: [Role.USER],
		createdAt: new Date(),
		authIdentities: [
			{
				id: 'identity-id',
				type: 'EMAIL',
				value: 'owner@example.test',
				verifiedAt
			}
		],
		telegramNotificationChannel: null
	};
	const prisma = {
		$queryRaw: jest.fn().mockResolvedValue([{ count: 1 }]),
		loginOtpChallenge: {
			findUnique: jest.fn(async () => challenge),
			updateMany: jest.fn(async () => ({ count: 1 })),
			update: jest.fn(async () => {
				challenge.consumedAt = new Date();
			})
		},
		user: { findUnique: jest.fn(async () => user) },
		userSession: { create: jest.fn(async () => ({})) },
		$transaction: jest.fn()
	};
	prisma.$transaction.mockImplementation(async callback =>
		callback(prisma)
	);
	const transport = {
		isEmailConfigured: jest.fn(() => true),
		isSmsConfigured: jest.fn(() => false),
		loginCode: jest.fn()
	};
	const owners = { ensureTrial: jest.fn(async () => undefined) };
	const service = new LoginOtpService(
		prisma as never,
		new ConfigService({ IDENTITY_LOGIN_OTP_ENABLED: 'true' }),
		transport as never,
		{ issue: () => 'synthetic-access' } as never,
		new RefreshTokenService(),
		owners as never
	);
	return { service, prisma, transport, challenge, user, owners };
}

describe('independent login OTP service', () => {
	it('is unavailable without the explicit feature gate and never probes a provider', async () => {
		const transport = {
			isEmailConfigured: jest.fn(),
			isSmsConfigured: jest.fn()
		};
		const service = new LoginOtpService(
			{} as never,
			new ConfigService({}),
			transport as never,
			{} as never,
			{} as never,
			{} as never
		);
		expect(await service.capabilities()).toEqual({
			available: false,
			channels: [],
			codeLength: 6,
			expiresInSeconds: 300,
			resendAfterSeconds: 60
		});
		expect(transport.isEmailConfigured).not.toHaveBeenCalled();
	});
	it('publishes only configured channels and fails closed without its schema', async () => {
		const value = fixture();
		expect((await value.service.capabilities()).channels).toEqual([
			'EMAIL'
		]);
		value.prisma.$queryRaw.mockRejectedValueOnce(
			new Error('private SQL detail')
		);
		expect((await value.service.capabilities()).available).toBe(false);
	});
	it('ignores forged forwarding headers and uses Express trusted IP only', () => {
		expect(
			loginOtpIp({
				ip: '192.0.2.4',
				headers: { 'x-forwarded-for': '198.51.100.9' }
			} as unknown as Request)
		).toBe('192.0.2.4');
		expect(loginOtpIp({ ip: '::ffff:192.0.2.4' } as Request)).toBe(
			'192.0.2.4'
		);
	});
	it('binds the six-digit hash to the independent high-entropy browser token', async () => {
		const encoded = await hash(`${token}:123456`, 4);
		expect(await compare(`${token}:123456`, encoded)).toBe(true);
		expect(await compare(`${'B'.repeat(43)}:123456`, encoded)).toBe(false);
		expect(await compare('123456', encoded)).toBe(false);
	});
	it.each(['expired', 'consumed', 'attempts', 'purpose', 'token'])(
		'rejects %s challenge without a session or owner call',
		async kind => {
			const value = fixture();
			if (kind === 'expired') value.challenge.expiresAt = new Date(0);
			if (kind === 'consumed') value.challenge.consumedAt = new Date();
			if (kind === 'attempts') value.challenge.attempts = 5;
			if (kind === 'purpose') value.challenge.purpose = 'REGISTER';
			await expect(
				value.service.verify(
					{
						challengeId,
						browserToken: kind === 'token' ? 'B'.repeat(43) : token,
						code: '123456'
					},
					{ ip: '192.0.2.4' } as Request
				)
			).rejects.toMatchObject({ response: { code: 'login_otp_invalid' } });
			expect(value.owners.ensureTrial).not.toHaveBeenCalled();
			expect(value.prisma.userSession.create).not.toHaveBeenCalled();
		}
	);
	it('increments wrong attempts with an atomic bounded update, not snapshot equality', async () => {
		const value = fixture();
		value.challenge.codeHash = await hash(`${token}:123456`, 4);
		await expect(
			value.service.verify(
				{ challengeId, browserToken: token, code: '999999' },
				{ ip: '192.0.2.4' } as Request
			)
		).rejects.toMatchObject({ response: { code: 'login_otp_invalid' } });
		expect(value.prisma.loginOtpChallenge.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					attempts: { lt: 5 },
					consumedAt: null
				}),
				data: { attempts: { increment: 1 } }
			})
		);
	});
	it.each([
		'disabled',
		'deleted',
		'reverified',
		'changed-contact',
		'changed-identity'
	])('revalidates %s before atomic session creation', async kind => {
		const value = fixture();
		value.challenge.codeHash = await hash(`${token}:123456`, 4);
		if (kind === 'disabled') value.user.status = UserStatus.DEACTIVATED;
		if (kind === 'deleted') value.user.deletedAt = new Date();
		if (kind === 'reverified')
			value.user.authIdentities[0].verifiedAt = new Date();
		if (kind === 'changed-contact')
			value.user.authIdentities[0].value = 'other@example.test';
		if (kind === 'changed-identity')
			value.user.authIdentities[0].id = 'other-identity';
		await expect(
			value.service.verify(
				{ challengeId, browserToken: token, code: '123456' },
				{ ip: '192.0.2.4', get: () => undefined } as unknown as Request
			)
		).rejects.toMatchObject({ response: { code: 'login_otp_invalid' } });
		expect(value.prisma.userSession.create).not.toHaveBeenCalled();
		expect(value.prisma.loginOtpChallenge.update).not.toHaveBeenCalled();
	});
	it('does not send or bypass quota when the durable storage fails', async () => {
		const value = fixture();
		value.prisma.$transaction.mockRejectedValueOnce(
			new Error('private DB detail')
		);
		await expect(
			value.service.request(
				{ channel: 'EMAIL', destination: 'owner@example.test' },
				{ ip: '192.0.2.4' } as Request
			)
		).rejects.toMatchObject({
			response: { code: 'login_otp_unavailable' }
		});
		expect(value.transport.loginCode).not.toHaveBeenCalled();
	});

	it('commits local admission but never charges later global budgets after a contact denial', async () => {
		const value = fixture();
		value.prisma.$queryRaw
			.mockResolvedValueOnce([{ count: 1 }])
			.mockResolvedValueOnce([]);
		await expect(
			value.service.request(
				{ channel: 'EMAIL', destination: 'owner@example.test' },
				{ ip: '192.0.2.4' } as Request
			)
		).rejects.toMatchObject({
			response: { code: 'login_otp_rate_limited' }
		});
		expect(value.prisma.$queryRaw).toHaveBeenCalledTimes(2);
		expect(value.transport.loginCode).not.toHaveBeenCalled();
	});
});

describe('login OTP HTTP contract with legacy global validation', () => {
	it('keeps strict bodies, anonymous endpoints, no-store and refresh-cookie behavior', async () => {
		const observedIps: string[] = [];
		const otp = {
			capabilities: jest.fn(async () => ({
				available: false,
				channels: [],
				codeLength: 6,
				expiresInSeconds: 300,
				resendAfterSeconds: 60
			})),
			request: jest.fn(async (_dto: unknown, incoming: Request) => {
				observedIps.push(loginOtpIp(incoming));
				return {
					challengeId,
					browserToken: token,
					expiresAt: new Date(),
					resendAvailableAt: new Date()
				};
			}),
			verify: jest.fn(async () => ({
				user: { id: 'user-id' },
				accessToken: 'synthetic-access',
				refreshToken: 'synthetic-refresh'
			}))
		};
		const module = await Test.createTestingModule({
			controllers: [LoginOtpController],
			providers: [
				{ provide: LoginOtpService, useValue: otp },
				{
					provide: RefreshTokenService,
					useValue: {
						add: (response: Response, value: string) =>
							response.cookie('refreshToken', value, { httpOnly: true })
					}
				}
			]
		}).compile();
		const app = module.createNestApplication();
		app
			.getHttpAdapter()
			.getInstance()
			.set('trust proxy', identityTrustProxy(undefined));
		app.setGlobalPrefix('api/v1');
		app.useGlobalPipes(
			new ValidationPipe({ transform: true, whitelist: true })
		);
		app.useGlobalFilters(new IdentityHttpExceptionFilter());
		await app.listen(0, '127.0.0.1');
		try {
			await request(app.getHttpServer())
				.get('/api/v1/auth/login-otp/capabilities')
				.expect(200)
				.expect('Cache-Control', 'no-store');
			await request(app.getHttpServer())
				.post('/api/v1/auth/login-otp/request')
				.send({
					channel: 'EMAIL',
					destination: 'owner@example.test',
					outage: true
				})
				.expect(400);
			await request(app.getHttpServer())
				.post('/api/v1/auth/login-otp/request')
				.set('X-Forwarded-For', '198.51.100.22')
				.send({ channel: 'EMAIL', destination: 'owner@example.test' })
				.expect(202)
				.expect('Cache-Control', 'no-store');
			expect(observedIps.at(-1)).toBe('198.51.100.22');
			app.getHttpAdapter().getInstance().set('trust proxy', false);
			await request(app.getHttpServer())
				.post('/api/v1/auth/login-otp/request')
				.set('X-Forwarded-For', '198.51.100.99')
				.send({ channel: 'EMAIL', destination: 'owner@example.test' })
				.expect(202);
			expect(observedIps.at(-1)).toBe('127.0.0.1');
			await request(app.getHttpServer())
				.post('/api/v1/auth/login-otp/verify')
				.send({ challengeId, browserToken: token, code: '12345' })
				.expect(400);
			const result = await request(app.getHttpServer())
				.post('/api/v1/auth/login-otp/verify')
				.send({ challengeId, browserToken: token, code: '123456' })
				.expect(200);
			expect(result.body).toEqual({
				user: { id: 'user-id' },
				accessToken: 'synthetic-access'
			});
			expect(result.headers['set-cookie'][0]).toContain('HttpOnly');
		} finally {
			await app.close();
		}
	});
});
