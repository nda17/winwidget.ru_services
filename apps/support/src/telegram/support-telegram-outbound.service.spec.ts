import {
	TelegramOutboundDeliveryStatus,
	TelegramOutboundMethod
} from '@prisma/support-client';
import { createHash } from 'node:crypto';
import type { SupportPrismaService } from '../prisma/support-prisma.service';
import type { SupportRuntimeService } from '../runtime/support-runtime.service';
import {
	canonicalSupportJson,
	SupportTelegramOutboundService
} from './support-telegram-outbound.service';
import {
	SupportTelegramError,
	type SupportTelegramTransport
} from './support-telegram.transport';

const inboxId = '11111111-1111-4111-8111-111111111111';
const sendRequest = { chatId: '100', text: 'hello' };
const sendRequestHash = createHash('sha256')
	.update(canonicalSupportJson(sendRequest))
	.digest('hex');

const delivery = (overrides: Record<string, unknown> = {}) => ({
	id: '22222222-2222-4222-8222-222222222222',
	inboxId,
	idempotencyKey: 'event:start',
	method: TelegramOutboundMethod.SEND_MESSAGE,
	requestHash: sendRequestHash,
	request: sendRequest,
	status: TelegramOutboundDeliveryStatus.PENDING,
	responseMessageId: null,
	...overrides
});

const setup = (record = delivery()) => {
	const prisma = {
		telegramOutboundDelivery: {
			createMany: jest.fn().mockResolvedValue({ count: 1 }),
			findUniqueOrThrow: jest.fn().mockResolvedValue(record),
			updateMany: jest
				.fn()
				.mockResolvedValueOnce({ count: 1 })
				.mockResolvedValueOnce({ count: 1 })
		}
	};
	const telegram = {
		sendMessage: jest.fn().mockResolvedValue({ messageId: 42 }),
		copyMessage: jest.fn()
	};
	const service = new SupportTelegramOutboundService(
		prisma as unknown as SupportPrismaService,
		{ inboxLeaseMs: 60_000 } as SupportRuntimeService,
		telegram as unknown as SupportTelegramTransport
	);
	return { service, prisma, telegram };
};

describe('SupportTelegramOutboundService', () => {
	it('uses canonical JSON independent of object key order', () => {
		expect(canonicalSupportJson({ text: 'hello', chatId: '100' })).toBe(
			canonicalSupportJson({ chatId: '100', text: 'hello' })
		);
	});

	it('claims before Telegram and persists the provider receipt by CAS', async () => {
		const { service, prisma, telegram } = setup();

		await expect(
			service.sendMessage(inboxId, 'event:start', {
				chatId: '100',
				text: 'hello'
			})
		).resolves.toEqual({ messageId: 42 });

		expect(
			prisma.telegramOutboundDelivery.createMany
		).toHaveBeenCalledWith(
			expect.objectContaining({ skipDuplicates: true })
		);
		expect(
			prisma.telegramOutboundDelivery.updateMany
		).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				where: expect.objectContaining({ OR: expect.any(Array) }),
				data: expect.objectContaining({
					status: TelegramOutboundDeliveryStatus.PROCESSING,
					leaseToken: expect.any(String)
				})
			})
		);
		expect(telegram.sendMessage).toHaveBeenCalledWith('100', 'hello', {
			replyToMessageId: undefined,
			messageThreadId: undefined
		});
		expect(
			prisma.telegramOutboundDelivery.updateMany
		).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				where: expect.objectContaining({
					status: TelegramOutboundDeliveryStatus.PROCESSING,
					leaseToken: expect.any(String)
				}),
				data: expect.objectContaining({
					status: TelegramOutboundDeliveryStatus.DELIVERED,
					responseMessageId: 42
				})
			})
		);
	});

	it('returns an already persisted receipt without calling Telegram again', async () => {
		const { service, telegram, prisma } = setup(
			delivery({
				status: TelegramOutboundDeliveryStatus.DELIVERED,
				responseMessageId: 73
			})
		);

		await expect(
			service.sendMessage(inboxId, 'event:start', {
				chatId: '100',
				text: 'hello'
			})
		).resolves.toEqual({ messageId: 73 });
		expect(telegram.sendMessage).not.toHaveBeenCalled();
		expect(
			prisma.telegramOutboundDelivery.updateMany
		).not.toHaveBeenCalled();
	});

	it('fails closed when an idempotency key is reused for another request', async () => {
		const { service, telegram } = setup(
			delivery({ requestHash: 'a'.repeat(64) })
		);

		await expect(
			service.sendMessage(inboxId, 'event:start', {
				chatId: '100',
				text: 'hello'
			})
		).rejects.toThrow('Support Telegram idempotency key was reused');
		expect(telegram.sendMessage).not.toHaveBeenCalled();
	});

	it('releases its lease after a retryable Telegram transport error', async () => {
		const { service, telegram, prisma } = setup();
		telegram.sendMessage.mockRejectedValueOnce(
			new SupportTelegramError('temporary', true)
		);

		await expect(
			service.sendMessage(inboxId, 'event:start', {
				chatId: '100',
				text: 'hello'
			})
		).rejects.toMatchObject({ retryable: true });
		expect(
			prisma.telegramOutboundDelivery.updateMany
		).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				data: expect.objectContaining({
					status: TelegramOutboundDeliveryStatus.PENDING,
					lastError: 'temporary'
				})
			})
		);
	});
});
