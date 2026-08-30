import {
	ConflictException,
	type INestApplication,
	UnauthorizedException,
	UnprocessableEntityException
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createHash } from 'node:crypto';
import type { SupportConfigService } from '../config/support-config.service';
import type { SupportPrismaService } from '../prisma/support-prisma.service';
import { SupportWebhookController } from './support-webhook.controller';
import { SupportWebhookService } from './support-webhook.service';
import { SUPPORT_WEBHOOK_MAX_BYTES } from './support-telegram.types';

const supportJsonBody = (bytes: number): Buffer => {
	const prefix = '{"update_id":42,"padding":"';
	const suffix = '"}';
	return Buffer.from(
		`${prefix}${'a'.repeat(bytes - prefix.length - suffix.length)}${suffix}`
	);
};

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

	it('rejects raw webhook payloads above the service boundary', async () => {
		const { service } = setup();
		await expect(
			service.admit(
				supportJsonBody(SUPPORT_WEBHOOK_MAX_BYTES + 1),
				'valid-secret'
			)
		).rejects.toBeInstanceOf(UnprocessableEntityException);
	});
});

describe('Support raw-body HTTP transport contract', () => {
	let app: INestApplication;
	let baseUrl: string;
	const webhook = {
		admit: jest.fn((rawBody: Buffer | undefined) => ({
			length: rawBody?.length || 0
		}))
	};

	beforeAll(async () => {
		const module = await Test.createTestingModule({
			controllers: [SupportWebhookController],
			providers: [{ provide: SupportWebhookService, useValue: webhook }]
		}).compile();
		const expressApp =
			module.createNestApplication<NestExpressApplication>({
				rawBody: true
			});
		expressApp.useBodyParser('json', { limit: SUPPORT_WEBHOOK_MAX_BYTES });
		app = expressApp;
		await app.listen(0, '127.0.0.1');
		baseUrl = await app.getUrl();
	});

	afterAll(() => app.close());

	beforeEach(() => jest.clearAllMocks());

	it('preserves exact bytes at the 512 KiB boundary', async () => {
		const raw = supportJsonBody(SUPPORT_WEBHOOK_MAX_BYTES);
		const response = await fetch(
			`${baseUrl}/telegram-bot/support-webhook`,
			{
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'x-telegram-bot-api-secret-token': 'valid-secret'
				},
				body: raw.toString('utf8')
			}
		);
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			length: SUPPORT_WEBHOOK_MAX_BYTES
		});
		expect(webhook.admit).toHaveBeenCalledWith(raw, 'valid-secret');
	});

	it('rejects payloads above 512 KiB before the controller', async () => {
		const response = await fetch(
			`${baseUrl}/telegram-bot/support-webhook`,
			{
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'x-telegram-bot-api-secret-token': 'valid-secret'
				},
				body: supportJsonBody(SUPPORT_WEBHOOK_MAX_BYTES + 1).toString(
					'utf8'
				)
			}
		);
		expect(response.status).toBe(413);
		expect(webhook.admit).not.toHaveBeenCalled();
	});
});
