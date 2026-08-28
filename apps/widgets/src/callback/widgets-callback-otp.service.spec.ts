import { ConfigService } from '@nestjs/config';
import { CallbackOtpChannel } from '@prisma/widgets-client';
import type { WidgetsPrismaService } from '../prisma/widgets-prisma.service';
import {
	CallbackOtpRateLimitException,
	WidgetsCallbackOtpService
} from './widgets-callback-otp.service';
import type { WidgetsCallbackOtpTransport } from './widgets-callback-otp.transport';

const config = (secret = 'callback-otp-secret-with-at-least-32-bytes') =>
	({
		get: (key: string) =>
			key === 'WIDGETS_CALLBACK_OTP_SECRET' ? secret : undefined
	}) as ConfigService;

describe('WidgetsCallbackOtpService', () => {
	it('requires a dedicated HMAC secret', () => {
		expect(
			() =>
				new WidgetsCallbackOtpService(
					{} as WidgetsPrismaService,
					config('short'),
					{} as WidgetsCallbackOtpTransport
				)
		).toThrow('WIDGETS_CALLBACK_OTP_SECRET');
	});

	it('persists only HMAC values and safely bounds consumed challenge replay', async () => {
		let challenge: Record<string, unknown> | null = null;
		let deliveredCode = '';
		let replayLead: Record<string, unknown> | null = null;
		const callbackOtpChallenge = {
			updateMany: jest.fn().mockImplementation(({ data }) => {
				if (challenge && data.sentAt) challenge.sentAt = data.sentAt;
				if (challenge && data.failedAt) challenge.failedAt = data.failedAt;
				if (challenge && data.consumedAt)
					challenge.consumedAt = data.consumedAt;
				return Promise.resolve({ count: challenge ? 1 : 0 });
			}),
			create: jest.fn().mockImplementation(({ data }) => {
				challenge = {
					...data,
					attempts: 0,
					sentAt: null,
					failedAt: null,
					revokedAt: null,
					consumedAt: null,
					createdAt: new Date(),
					updatedAt: new Date()
				};
				return Promise.resolve(challenge);
			}),
			findUnique: jest
				.fn()
				.mockImplementation(() => Promise.resolve(challenge)),
			update: jest.fn().mockImplementation(({ data }) => {
				if (challenge) Object.assign(challenge, data);
				return Promise.resolve(challenge);
			})
		};
		const transaction = {
			callbackOtpChallenge,
			callbackOtpRateBucket: { findUnique: jest.fn() },
			callbackLead: {
				findUnique: jest
					.fn()
					.mockImplementation(() => Promise.resolve(replayLead))
			},
			$queryRaw: jest.fn().mockImplementation(query => {
				const sql = (query as { strings: readonly string[] }).strings.join(
					' '
				);
				return Promise.resolve(
					sql.includes('SELECT "id"')
						? challenge
							? [{ id: challenge.id }]
							: []
						: [{ windowEndsAt: new Date(Date.now() + 60_000) }]
				);
			})
		};
		const prisma = {
			...transaction,
			$transaction: jest.fn(
				(callback: (client: typeof transaction) => Promise<unknown>) =>
					callback(transaction)
			)
		} as unknown as WidgetsPrismaService;
		const sendEmail = jest.fn().mockImplementation((_to, code) => {
			deliveredCode = code;
			return Promise.resolve();
		});
		const transport = {
			isEmailConfigured: () => true,
			isSmsConfigured: () => true,
			sendEmail,
			sendSms: jest.fn()
		} as unknown as WidgetsCallbackOtpTransport;
		const service = new WidgetsCallbackOtpService(
			prisma,
			config(),
			transport
		);

		const started = await service.start({
			callbackId: 'callback-1',
			ownerId: 'owner-1',
			publishedVersion: 3,
			channel: CallbackOtpChannel.EMAIL,
			destination: 'visitor@example.test',
			ip: '203.0.113.10'
		});
		expect(started).toMatchObject({
			challengeId: expect.any(String),
			expiresAt: expect.any(String),
			resendAvailableAt: expect.any(String),
			destinationHint: 'v•••@example.test'
		});
		expect(deliveredCode).toMatch(/^\d{6}$/);
		expect(sendEmail).toHaveBeenCalledTimes(1);
		expect(callbackOtpChallenge.updateMany).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				where: expect.objectContaining({ id: started.challengeId }),
				data: { sentAt: expect.any(Date) }
			})
		);
		expect(callbackOtpChallenge.updateMany).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				where: expect.objectContaining({
					id: { not: started.challengeId },
					callbackId: 'callback-1',
					channel: CallbackOtpChannel.EMAIL
				}),
				data: { revokedAt: expect.any(Date) }
			})
		);
		expect(sendEmail.mock.invocationCallOrder[0]).toBeLessThan(
			callbackOtpChallenge.updateMany.mock.invocationCallOrder[0]
		);
		const persisted = callbackOtpChallenge.create.mock.calls[0][0].data;
		expect(persisted.destinationHash).toMatch(/^[0-9a-f]{64}$/);
		expect(persisted.ipHash).toMatch(/^[0-9a-f]{64}$/);
		expect(persisted.codeHash).toMatch(/^[0-9a-f]{64}$/);
		const serialized = JSON.stringify(persisted);
		expect(serialized).not.toContain('visitor@example.test');
		expect(serialized).not.toContain('203.0.113.10');
		expect(serialized).not.toContain(deliveredCode);

		const identity = {
			callbackId: 'callback-1',
			ownerId: 'owner-1',
			publishedVersion: 3,
			channel: CallbackOtpChannel.EMAIL,
			challengeId: started.challengeId,
			code: deliveredCode,
			destination: 'visitor@example.test',
			payload: {
				phone: '+79990000000',
				timeSlot: '11:00–13:00',
				timezone: 'Europe/Moscow',
				url: 'https://example.test/callback'
			}
		};
		const wrongCode = deliveredCode === '000000' ? '111111' : '000000';
		await expect(
			service.precheckOrReplay({ ...identity, code: wrongCode })
		).rejects.toMatchObject({ status: 400 });
		expect((challenge as Record<string, unknown> | null)?.attempts).toBe(
			1
		);

		await expect(service.precheckOrReplay(identity)).resolves.toBeNull();
		await service.assertConsumable(transaction as never, identity);
		await service.consume(transaction as never, identity);
		replayLead = {
			id: 'lead-1',
			createdAt: new Date(),
			phone: '+79990000000',
			timeSlot: '11:00–13:00',
			timezone: 'Europe/Moscow',
			url: 'https://example.test/callback'
		};
		await expect(service.precheckOrReplay(identity)).resolves.toBe(
			replayLead
		);
		await expect(
			service.precheckOrReplay({
				...identity,
				destination: 'another@example.test'
			})
		).rejects.toMatchObject({ status: 400 });
		for (const payload of [
			{ ...identity.payload, phone: '+79991111111' },
			{ ...identity.payload, timeSlot: '13:00–15:00' },
			{ ...identity.payload, timezone: 'Europe/Samara' },
			{ ...identity.payload, url: 'https://example.test/other' }
		]) {
			await expect(
				service.precheckOrReplay({ ...identity, payload })
			).rejects.toMatchObject({ status: 400 });
		}
		(challenge as unknown as Record<string, unknown>).expiresAt = new Date(
			Date.now() - 1
		);
		await expect(service.precheckOrReplay(identity)).rejects.toMatchObject(
			{
				status: 400
			}
		);
	});

	it('returns a bounded Retry-After when an atomic PostgreSQL bucket is full', async () => {
		const windowEndsAt = new Date(Date.now() + 30_000);
		const transaction = {
			$queryRaw: jest.fn().mockResolvedValue([]),
			callbackOtpRateBucket: {
				findUnique: jest.fn().mockResolvedValue({ windowEndsAt })
			},
			callbackOtpChallenge: {
				updateMany: jest.fn(),
				create: jest.fn()
			}
		};
		const prisma = {
			$transaction: jest.fn(
				(callback: (client: typeof transaction) => Promise<unknown>) =>
					callback(transaction)
			)
		} as unknown as WidgetsPrismaService;
		const transport = {
			isEmailConfigured: () => false,
			isSmsConfigured: () => true,
			sendEmail: jest.fn(),
			sendSms: jest.fn()
		} as unknown as WidgetsCallbackOtpTransport;
		const service = new WidgetsCallbackOtpService(
			prisma,
			config(),
			transport
		);

		let caught: unknown;
		try {
			await service.start({
				callbackId: 'callback-1',
				ownerId: 'owner-1',
				publishedVersion: 1,
				channel: CallbackOtpChannel.SMS,
				destination: '+79991234567',
				ip: '203.0.113.10'
			});
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(CallbackOtpRateLimitException);
		expect(
			(caught as CallbackOtpRateLimitException).retryAfterSeconds
		).toBeGreaterThanOrEqual(1);
		expect(
			(caught as CallbackOtpRateLimitException).retryAfterSeconds
		).toBeLessThanOrEqual(30);
		expect(transport.sendSms).not.toHaveBeenCalled();
		expect(transaction.callbackOtpChallenge.create).not.toHaveBeenCalled();
	});

	it('keeps the previous sent challenge valid when resend delivery fails', async () => {
		const transactionUpdateMany = jest.fn();
		const markFailed = jest.fn().mockResolvedValue({ count: 1 });
		const transaction = {
			$queryRaw: jest
				.fn()
				.mockResolvedValue([
					{ windowEndsAt: new Date(Date.now() + 60_000) }
				]),
			callbackOtpRateBucket: { findUnique: jest.fn() },
			callbackOtpChallenge: {
				create: jest.fn().mockResolvedValue({ id: 'new-challenge' }),
				updateMany: transactionUpdateMany
			}
		};
		const prisma = {
			callbackOtpChallenge: { updateMany: markFailed },
			$transaction: jest.fn(
				(callback: (client: typeof transaction) => Promise<unknown>) =>
					callback(transaction)
			)
		} as unknown as WidgetsPrismaService;
		const transport = {
			isEmailConfigured: () => true,
			isSmsConfigured: () => false,
			sendEmail: jest
				.fn()
				.mockRejectedValue(new Error('ProviderUnavailable')),
			sendSms: jest.fn()
		} as unknown as WidgetsCallbackOtpTransport;
		const service = new WidgetsCallbackOtpService(
			prisma,
			config(),
			transport
		);

		await expect(
			service.start({
				callbackId: 'callback-1',
				ownerId: 'owner-1',
				publishedVersion: 1,
				channel: CallbackOtpChannel.EMAIL,
				destination: 'visitor@example.test',
				ip: '203.0.113.10'
			})
		).rejects.toMatchObject({ status: 503 });
		expect(transactionUpdateMany).not.toHaveBeenCalled();
		expect(markFailed).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					sentAt: null,
					failedAt: null
				}),
				data: { failedAt: expect.any(Date) }
			})
		);
	});
});
