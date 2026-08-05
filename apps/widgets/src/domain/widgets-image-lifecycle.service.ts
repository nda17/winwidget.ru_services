import { Injectable } from '@nestjs/common';
import { WidgetsDomainRepository } from './widgets-domain.repository';
import { asJsonObject, WidgetType } from './widgets-domain.types';
import { WidgetsImageService } from './widgets-image.service';

@Injectable()
export class WidgetsImageLifecycleService {
	constructor(
		private readonly repository: WidgetsDomainRepository,
		private readonly images: WidgetsImageService
	) {}

	async cleanupIfUnreferenced(
		type: WidgetType,
		widgetId: string,
		image: unknown
	): Promise<void> {
		if (!this.images.isManaged(image)) return;
		try {
			const [widget, revision] = await Promise.all([
				this.repository.findById(type, widgetId),
				this.repository.client().widgetConfigRevision.findFirst({
					where: {
						widgetType: type,
						widgetId,
						config: { path: ['buttonImageUrl'], equals: image }
					},
					select: { id: true }
				})
			]);
			if (
				widget &&
				[widget.config, widget.draftConfig].some(
					config => asJsonObject(config).buttonImageUrl === image
				)
			) {
				return;
			}
			if (revision) return;
			await this.images.delete(image);
		} catch {
			// Cleanup is best-effort and never changes an already committed mutation.
		}
	}
}
