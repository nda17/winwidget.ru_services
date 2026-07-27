import type { ConsumeMessage } from 'amqplib';
import { createHash } from 'node:crypto';

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const toUuid = (digest: Buffer): string => {
	const bytes = Buffer.from(digest.subarray(0, 16));
	bytes[6] = (bytes[6] & 0x0f) | 0x80;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = bytes.toString('hex');
	return [
		hex.slice(0, 8),
		hex.slice(8, 12),
		hex.slice(12, 16),
		hex.slice(16, 20),
		hex.slice(20)
	].join('-');
};

export const getStableMessageId = (
	message: ConsumeMessage,
	namespace: string,
	fallback?: string | null
): string => {
	const messageId = message.properties.messageId;
	if (messageId && UUID_PATTERN.test(messageId)) return messageId;
	if (fallback && UUID_PATTERN.test(fallback)) return fallback;

	const metadata = JSON.stringify({
		namespace,
		messageId: messageId || null,
		correlationId: message.properties.correlationId || null,
		timestamp: message.properties.timestamp || null,
		type: message.properties.type || null,
		exchange: message.fields.exchange || null,
		routingKey: message.fields.routingKey || null
	});
	const digest = createHash('sha256')
		.update(metadata)
		.update('\0')
		.update(message.content)
		.digest();
	return toUuid(digest);
};
