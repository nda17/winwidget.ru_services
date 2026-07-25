import {
	createMessagingHeaders,
	messagingContextMiddleware,
	runWithMessageContext
} from '@/messaging/messaging-context';
import type { ConsumeMessage } from 'amqplib';
import type { NextFunction, Request, Response } from 'express';

describe('messaging context', () => {
	it('propagates validated HTTP request context into Outbox headers', done => {
		const request = {
			headers: {
				'x-request-id': 'request-123',
				'x-correlation-id': 'correlation-456'
			}
		} as unknown as Request;
		const response = {
			setHeader: jest.fn()
		} as unknown as Response;
		const next = (() => {
			expect(
				createMessagingHeaders({
					messageId: 'event-1',
					causationId: 'command-1'
				})
			).toEqual({
				'x-correlation-id': 'correlation-456',
				'x-request-id': 'request-123',
				'x-causation-id': 'command-1'
			});
			done();
		}) as NextFunction;

		messagingContextMiddleware(request, response, next);
	});

	it('rejects unsafe incoming identifiers and creates a local context', done => {
		const request = {
			headers: {
				'x-correlation-id': 'invalid header\nvalue'
			}
		} as unknown as Request;
		const response = {
			setHeader: jest.fn()
		} as unknown as Response;

		messagingContextMiddleware(request, response, (() => {
			const headers = createMessagingHeaders({ messageId: 'event-1' });
			expect(headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/i);
			expect(headers['x-request-id']).toBe(headers['x-correlation-id']);
			done();
		}) as NextFunction);
	});

	it('continues the message context through derived events', async () => {
		const message = {
			properties: {
				messageId: 'event-1',
				correlationId: 'correlation-1',
				headers: {
					'x-request-id': 'request-1'
				}
			}
		} as unknown as ConsumeMessage;

		await runWithMessageContext(message, async () => {
			expect(
				createMessagingHeaders({
					messageId: 'retry-1'
				})
			).toEqual({
				'x-correlation-id': 'correlation-1',
				'x-request-id': 'request-1',
				'x-causation-id': 'event-1'
			});
		});
	});
});
