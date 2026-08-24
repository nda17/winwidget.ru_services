import {
	ConflictException,
	UnauthorizedException,
	UnprocessableEntityException
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { SupportConfigService } from '../config/support-config.service';
import type { SupportPrismaService } from '../prisma/support-prisma.service';
import { SupportWebhookService } from './support-webhook.service';

function setup(existing: { id: string; bodyHash: string } | null = null) {
	const transaction = {
		telegramWebhookInbox: {
			findUnique: jest.fn().mockResolvedValue(existing),
			create: jest.fn().mockResolvedValue({
				id: '11111111-1111-4111-8111-111111111111'
			})
		},
		outboxEvent: { create: jest.fn().mockResolvedValue({}) }
	};
	const prisma = {
		$transaction: jest.fn(async callback => callback(transaction)),
		telegramWebhookInbox: { findUnique: jest.fn() }
	} as unknown as SupportPrismaService;
	const config = {
		assertWebhookSecret: jest.fn((value?: string) => {
			if (value !== 'valid-secret') throw new Error('invalid');
		})
	} as unknown as SupportConfigService;
	return {
		service: new SupportWebhookService(config, prisma),
		transaction,
		prisma,
		config
	};
}

describe('SupportWebhookService', () => {
	it('commits exact raw bytes and an Outbox event before accepting', async () => {
		const { service, transaction } = setup();
		const raw = Buffer.from(
			'{"update_id":42,"message":{"text":"Привет"}}'
		);

		await expect(service.admit(raw, 'valid-secret')).resolves.toEqual({
			accepted: true,
			duplicate: false
		});
		const hash = createHash('sha256').update(raw).digest('hex');
		expect(transaction.telegramWebhookInbox.create).toHaveBeenCalledWith({
			data: {
				updateId: 42n,
				bodyHash: hash,
				rawPayload: raw
			}
		});
		expect(transaction.outboxEvent.create).toHaveBeenCalledTimes(1);
		const event = transaction.outboxEvent.create.mock.calls[0][0].data;
		expect(event.deduplicationKey).toBe('support-webhook:42');
		expect(event.payload).toMatchObject({
			eventType: 'support.telegram.webhook-admitted.v1',
			inboxId: '11111111-1111-4111-8111-111111111111',
			updateId: '42',
			bodyHash: hash
		});
	});

	it('treats the same update_id and raw-body hash as an idempotent duplicate', async () => {
		const raw = Buffer.from('{"update_id":42}');
		const hash = createHash('sha256').update(raw).digest('hex');
		const { service, transaction } = setup({
			id: 'inbox',
			bodyHash: hash
		});

		await expect(service.admit(raw, 'valid-secret')).resolves.toEqual({
			accepted: true,
			duplicate: true
		});
		expect(transaction.telegramWebhookInbox.create).not.toHaveBeenCalled();
		expect(transaction.outboxEvent.create).not.toHaveBeenCalled();
	});

	it('rejects update_id reuse with a different raw-body hash', async () => {
		const { service } = setup({ id: 'inbox', bodyHash: 'a'.repeat(64) });
		await expect(
			service.admit(Buffer.from('{"update_id":42}'), 'valid-secret')
		).rejects.toBeInstanceOf(ConflictException);
	});

	it('fails closed before admission when the webhook secret is absent', async () => {
		const { service, prisma } = setup();
		await expect(
			service.admit(Buffer.from('{"update_id":42}'), undefined)
		).rejects.toBeInstanceOf(UnauthorizedException);
		expect(prisma.$transaction).not.toHaveBeenCalled();
	});

	it.each([
		Buffer.from([0xc3, 0x28]),
		Buffer.from('not-json'),
		Buffer.from('{"update_id":9007199254740992}')
	])('rejects a non-canonical raw Telegram update', async raw => {
		const { service } = setup();
		await expect(
			service.admit(raw, 'valid-secret')
		).rejects.toBeInstanceOf(UnprocessableEntityException);
	});
});
