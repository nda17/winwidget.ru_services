import {
	BadRequestException,
	ForbiddenException,
	ServiceUnavailableException,
	ValidationPipe
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { SupportAttachmentStorageService } from './support-attachment-storage.service';
import {
	CreateSupportConversationDto,
	SupportNotificationSettingsDto
} from './support-web.dto';
import { parseSupportOutcome } from './support-outcome-worker.service';
import { assertSupportActor } from './support-web.util';

describe('Support web request and image boundaries', () => {
	const service = new SupportAttachmentStorageService(
		new ConfigService({})
	);
	const file = (buffer: Buffer, mimetype = 'image/png') =>
		({
			buffer,
			size: buffer.length,
			mimetype,
			originalname: 'screenshot.png'
		}) as Express.Multer.File;
	it('fully decodes a screenshot, rejects MIME spoofing/truncated data and removes appended data', async () => {
		const image = await sharp({
			create: { width: 4, height: 3, channels: 3, background: '#ff0000' }
		})
			.png()
			.toBuffer();
		const prepared = await service.prepare(
			file(
				Buffer.concat([image, Buffer.from('<script>not image</script>')])
			)
		);
		expect(prepared).toMatchObject({
			width: 4,
			height: 3,
			mediaType: 'image/png'
		});
		expect(prepared.body.includes(Buffer.from('<script>'))).toBe(false);
		await expect(
			service.prepare(file(image, 'image/jpeg'))
		).rejects.toBeInstanceOf(BadRequestException);
		await expect(
			service.prepare(file(image.subarray(0, 30)))
		).rejects.toBeInstanceOf(BadRequestException);
		await expect(
			service.prepare(file(Buffer.from('<svg/>'), 'image/svg+xml'))
		).rejects.toBeInstanceOf(BadRequestException);
	});
	it('admits at most two concurrent image decoders', async () => {
		const image = await sharp({
			create: { width: 4, height: 3, channels: 3, background: '#ff0000' }
		})
			.png()
			.toBuffer();
		const results = await Promise.allSettled([
			service.prepare(file(image)),
			service.prepare(file(image)),
			service.prepare(file(image))
		]);
		expect(results[0].status).toBe('fulfilled');
		expect(results[1].status).toBe('fulfilled');
		expect(results[2].status).toBe('rejected');
		if (results[2].status === 'rejected')
			expect(results[2].reason).toBeInstanceOf(
				ServiceUnavailableException
			);
	});
	it('rejects unknown DTO keys, null workspace and a positive Telegram destination', async () => {
		const pipe = new ValidationPipe({
			whitelist: true,
			forbidNonWhitelisted: true,
			transform: true
		});
		const input = {
			commandId: randomUUID(),
			expectedActorSubject: 'user',
			draftId: randomUUID(),
			subject: 'Question',
			text: 'Help',
			section: 'inbox',
			appVersion: '1.0.0',
			attachmentIds: []
		};
		await expect(
			pipe.transform(
				{ ...input, authorSubject: 'other' },
				{ type: 'body', metatype: CreateSupportConversationDto }
			)
		).rejects.toBeInstanceOf(BadRequestException);
		await expect(
			pipe.transform(
				{ ...input, workspaceId: null },
				{ type: 'body', metatype: CreateSupportConversationDto }
			)
		).rejects.toBeInstanceOf(BadRequestException);
		await expect(
			pipe.transform(
				{
					commandId: randomUUID(),
					expectedActorSubject: 'dev',
					expectedVersion: 0,
					enabled: true,
					emailEnabled: false,
					staffEmails: [],
					telegramEnabled: true,
					telegramChatId: '123',
					telegramThreadId: 1,
					clientEmailEnabled: false
				},
				{ type: 'body', metatype: SupportNotificationSettingsDto }
			)
		).rejects.toBeInstanceOf(BadRequestException);
	});
	it('binds mutation to the current actor and strictly rejects notification content in outcome events', () => {
		expect(() =>
			assertSupportActor(
				{
					active: true,
					subject: 'current',
					sessionId: 'session',
					roles: ['USER']
				},
				'previous'
			)
		).toThrow(ForbiddenException);
		const event = {
			schemaVersion: 1,
			eventId: randomUUID(),
			eventType: 'support.notification.delivery.outcome.v1',
			occurredAt: new Date().toISOString(),
			sourceEventId: randomUUID(),
			sourceKind: 'support-team-email',
			intentId: randomUUID(),
			status: 'DELIVERED',
			reason: null
		};
		expect(parseSupportOutcome(event)).toEqual(event);
		expect(() =>
			parseSupportOutcome({ ...event, text: 'private content' })
		).toThrow();
		expect(() =>
			parseSupportOutcome({
				...event,
				status: 'FAILED',
				reason: 'recipient@example.test failed'
			})
		).toThrow();
	});
});
