import { SiteSettingsService } from '@/site-settings/site-settings.service';
import {
	CanActivate,
	ForbiddenException,
	Injectable
} from '@nestjs/common';

@Injectable()
export class GithubAuthEnabledGuard implements CanActivate {
	constructor(private readonly siteSettingsService: SiteSettingsService) {}

	async canActivate() {
		const settings = await this.siteSettingsService.get();
		if (settings.githubAuthEnabled) return true;

		throw new ForbiddenException('Github auth is disabled');
	}
}
