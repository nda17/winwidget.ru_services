import type { Request } from 'express';
import { WidgetType } from '../domain/widgets-domain.types';
import {
	isRuntimeEventDomainAllowed,
	runtimeCompletionMetadata
} from './widgets-telemetry.service';

const request = (origin: string) =>
	({ headers: { origin } }) as unknown as Request;

describe('Widgets telemetry AI contract', () => {
	it('requires the exact AI install hostname while preserving legacy registrable-domain matching', () => {
		const sibling = request('https://evil.example.com');

		expect(
			isRuntimeEventDomainAllowed(
				WidgetType.AI_CONSULTANT,
				'shop.example.com',
				sibling
			)
		).toBe(false);
		expect(
			isRuntimeEventDomainAllowed(
				WidgetType.AI_CONSULTANT,
				'shop.example.com',
				request('https://shop.example.com')
			)
		).toBe(true);
		expect(
			isRuntimeEventDomainAllowed(
				WidgetType.AI_CONSULTANT,
				'shop.example.com',
				request('https://winwidget.ru'),
				true
			)
		).toBe(true);
		expect(
			isRuntimeEventDomainAllowed(
				WidgetType.AI_CONSULTANT,
				'shop.example.com',
				request('https://winwidget.ru')
			)
		).toBe(false);
		expect(
			isRuntimeEventDomainAllowed(WidgetType.WHEEL, 'example.com', sibling)
		).toBe(true);
	});

	it('labels lead-free AI completions as completions rather than applications', () => {
		expect(
			runtimeCompletionMetadata(WidgetType.AI_CONSULTANT, {})
		).toEqual({
			submitAvailable: false,
			completionLabel: 'Завершения'
		});
		expect(runtimeCompletionMetadata(WidgetType.CALLBACK, {})).toEqual({
			submitAvailable: true,
			completionLabel: 'Заявки'
		});
	});
});
