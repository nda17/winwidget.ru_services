import { Auth } from '@/auth/decorators/auth.decorator';
import { CurrentUser } from '@/auth/decorators/user.decorator';
import { PaymentService } from '@/payment/payment.service';
import { Body, Controller, Post } from '@nestjs/common';

@Controller('payments')
export class PaymentController {
	constructor(private readonly paymentService: PaymentService) {}

	@Post('create')
	@Auth()
	async createPayment(@CurrentUser('id') userId: string) {
		return this.paymentService.createPremiumPayment(userId);
	}

	@Post('verify')
	@Auth()
	async verifyPayment(@CurrentUser('id') userId: string) {
		return this.paymentService.verifyLatestPayment(userId);
	}

	@Post('webhook')
	async webhook(@Body() body: any) {
		return this.paymentService.handleWebhook(body);
	}
}
