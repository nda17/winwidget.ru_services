import { NotFoundException, PipeTransform } from '@nestjs/common';

const PUBLIC_WIDGET_KEY_PATTERN = /^[a-f0-9]{12}$/;

export class PublicWidgetKeyPipe implements PipeTransform<
	unknown,
	string
> {
	transform(value: unknown): string {
		if (
			typeof value !== 'string' ||
			!PUBLIC_WIDGET_KEY_PATTERN.test(value)
		) {
			throw new NotFoundException('Виджет не найден');
		}

		return value;
	}
}

export const publicWidgetKeyPipe = new PublicWidgetKeyPipe();
