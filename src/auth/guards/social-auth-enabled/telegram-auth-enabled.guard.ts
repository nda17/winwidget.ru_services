import { SiteSettingsService } from '@/site-settings/site-settings.service';
import {
	CanActivate,
	ForbiddenException,
	Injectable
} from '@nestjs/common';

@Injectable()
export class TelegramAuthEnabledGuard implements CanActivate {
	constructor(private readonly siteSettingsService: SiteSettingsService) {}

	async canActivate() {
		const settings = await this.siteSettingsService.get();
		if (settings.telegramAuthEnabled) return true;

		throw new ForbiddenException('Telegram auth is disabled');
	}
}
