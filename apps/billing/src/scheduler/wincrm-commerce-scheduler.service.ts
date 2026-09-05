import {
	Injectable,
	Logger,
	OnApplicationShutdown,
	OnModuleInit
} from '@nestjs/common';
import { WincrmCommerceService } from '../domain/wincrm-commerce.service';
import { BillingRuntimeService } from '../runtime/billing-runtime.service';
import { wincrmProviderMessagingEnabled } from '../provider/wincrm-provider.config';

@Injectable()
export class WincrmCommerceSchedulerService
	implements OnModuleInit, OnApplicationShutdown
{
	private readonly logger = new Logger(
		WincrmCommerceSchedulerService.name
	);
	private timer: NodeJS.Timeout | null = null;
	private running = false;
	private stopping = false;
	constructor(
		private readonly runtime: BillingRuntimeService,
		private readonly commerce: WincrmCommerceService
	) {}

	onModuleInit() {
		if (
			!wincrmProviderMessagingEnabled() ||
			!this.runtime.schedulerEnabled
		)
			return;
		this.timer = setInterval(() => void this.tick(), 60_000);
		this.timer.unref();
		void this.tick();
	}

	async tick() {
		if (
			this.running ||
			this.stopping ||
			!wincrmProviderMessagingEnabled() ||
			!this.runtime.schedulerEnabled
		)
			return;
		this.running = true;
		try {
			// Each due period is reserved transactionally with its unique cycle and Outbox.
			// The scheduler never contacts YooKassa or publishes directly to RabbitMQ.
			// Already-paid scheduled periods still activate with new sales disabled;
			// the commerce service separately gates reservations of new charges.
			await this.commerce.advanceRenewals(new Date());
		} catch {
			this.logger.warn(
				'WinCRM renewal scheduling is temporarily unavailable'
			);
		} finally {
			this.running = false;
		}
	}

	isReady() {
		return (
			!this.stopping &&
			(!wincrmProviderMessagingEnabled() ||
				!this.runtime.schedulerEnabled ||
				this.timer !== null)
		);
	}

	onApplicationShutdown() {
		this.stopping = true;
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}
}
