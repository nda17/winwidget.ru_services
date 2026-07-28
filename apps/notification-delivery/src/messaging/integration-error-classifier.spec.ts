import { classifyIntegrationError } from './integration-error-classifier';

describe('notification delivery integration error classifier', () => {
	const unavailableTelegramDestination = Object.assign(
		new Error('Telegram destination failed'),
		{
			httpStatus: 400,
			description: 'Bad Request: chat not found'
		}
	);

	it.each(['telegram', 'payment-telegram', 'limit-telegram'] as const)(
		'classifies %s failures through the Telegram taxonomy',
		kind => {
			expect(
				classifyIntegrationError(kind, unavailableTelegramDestination)
			).toEqual(
				expect.objectContaining({
					category: 'PERMANENT',
					normalizedCode: 'TELEGRAM_CHAT_NOT_FOUND',
					retryable: false,
					mayDisableDestination: true
				})
			);
		}
	);

	it('classifies an explicit destination configuration error', () => {
		const error = Object.assign(new Error('Destination missing'), {
			code: 'DESTINATION_CONFIGURATION_MISSING'
		});

		expect(classifyIntegrationError('payment-telegram', error)).toEqual(
			expect.objectContaining({
				category: 'AUTH_CONFIGURATION',
				normalizedCode: 'DESTINATION_CONFIGURATION_MISSING',
				retryable: false,
				mayDisableDestination: false
			})
		);
	});
});
