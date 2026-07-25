import {
	MessagingHeartbeatService,
	parseMessagingHeartbeatMetadata
} from '@/messaging/messaging-heartbeat.service';
import type { PrismaService } from '@/prisma.service';
import type { ConfigService } from '@nestjs/config';

describe('MessagingHeartbeatService', () => {
	it('persists successful poll, publish and consume activity in metadata', async () => {
		const prisma = {
			messagingHeartbeat: {
				upsert: jest.fn().mockResolvedValue({}),
				deleteMany: jest.fn().mockResolvedValue({ count: 0 })
			}
		} as unknown as PrismaService;
		const configService = {
			get: jest.fn((key: string) =>
				key === 'MESSAGING_SERVICE_NAME' ? 'integration-worker' : undefined
			)
		} as unknown as ConfigService;
		const service = new MessagingHeartbeatService(prisma, configService);
		const pollAt = new Date('2026-07-25T10:00:00.000Z');
		const publishAt = new Date('2026-07-25T10:00:01.000Z');
		const consumeAt = new Date('2026-07-25T10:00:02.000Z');

		service.markSuccessfulPoll(pollAt);
		service.markSuccessfulPublish(publishAt);
		service.markSuccessfulConsume('webhook', consumeAt);
		await (service as any).touch();

		expect(prisma.messagingHeartbeat.upsert).toHaveBeenCalledWith(
			expect.objectContaining({
				create: expect.objectContaining({
					metadata: expect.objectContaining({
						lastSuccessfulPollAt: pollAt.toISOString(),
						lastSuccessfulPublishAt: publishAt.toISOString(),
						lastSuccessfulConsumeAt: consumeAt.toISOString(),
						lastSuccessfulConsumeKind: 'webhook'
					})
				}),
				update: expect.objectContaining({
					metadata: expect.objectContaining({
						lastSuccessfulPollAt: pollAt.toISOString(),
						lastSuccessfulPublishAt: publishAt.toISOString(),
						lastSuccessfulConsumeAt: consumeAt.toISOString()
					})
				})
			})
		);
	});

	it('ignores malformed heartbeat metadata', () => {
		expect(parseMessagingHeartbeatMetadata([])).toEqual({});
		expect(
			parseMessagingHeartbeatMetadata({
				pid: 'not-a-number',
				lastSuccessfulPollAt: 123
			})
		).toEqual({
			hostname: undefined,
			pid: undefined,
			lastSuccessfulPollAt: undefined,
			lastSuccessfulPublishAt: undefined,
			lastSuccessfulConsumeAt: undefined,
			lastSuccessfulConsumeKind: undefined
		});
	});
});
