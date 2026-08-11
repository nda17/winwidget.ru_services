import { BillingCoreStateService } from '@/billing-boundary/billing-core-state.service';
import { CanActivate, Injectable } from '@nestjs/common';

@Injectable()
export class BillingLegacyRouteGuard implements CanActivate {
	constructor(private readonly state: BillingCoreStateService) {}

	async canActivate(): Promise<boolean> {
		await this.state.assertLegacyRouteEnabled();
		return true;
	}
}
