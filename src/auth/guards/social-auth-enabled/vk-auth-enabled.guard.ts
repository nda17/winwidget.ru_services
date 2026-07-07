import { SiteSettingsService } from '@/site-settings/site-settings.service';
import {
	CanActivate,
	ForbiddenException,
	Injectable
} from '@nestjs/common';

@Injectable()
export class VkAuthEnabledGuard implements CanActivate {
	constructor(private readonly siteSettingsService: SiteSettingsService) {}

	async canActivate() {
		const settings = await this.siteSettingsService.get();
		if (settings.vkAuthEnabled) return true;

		throw new ForbiddenException('VK auth is disabled');
	}
}
