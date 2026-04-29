import { SiteSettingsService } from '@/site-settings/site-settings.service';
import {
	CanActivate,
	ForbiddenException,
	Injectable
} from '@nestjs/common';

@Injectable()
export class YandexAuthEnabledGuard implements CanActivate {
	constructor(private readonly siteSettingsService: SiteSettingsService) {}

	async canActivate() {
		const settings = await this.siteSettingsService.get();
		if (settings.yandexAuthEnabled) return true;

		throw new ForbiddenException('Yandex auth is disabled');
	}
}
