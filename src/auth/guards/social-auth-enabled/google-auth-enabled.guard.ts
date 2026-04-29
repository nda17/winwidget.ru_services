import { SiteSettingsService } from '@/site-settings/site-settings.service';
import {
	CanActivate,
	ForbiddenException,
	Injectable
} from '@nestjs/common';

@Injectable()
export class GoogleAuthEnabledGuard implements CanActivate {
	constructor(private readonly siteSettingsService: SiteSettingsService) {}

	async canActivate() {
		const settings = await this.siteSettingsService.get();
		if (settings.googleAuthEnabled) return true;

		throw new ForbiddenException('Google auth is disabled');
	}
}
