import { Auth } from '@/auth/decorators/auth.decorator';
import { CurrentUser } from '@/auth/decorators/user.decorator';
import { CreatePaymentDto } from '@/payment/dto/create-payment.dto';
import { PaymentService } from '@/payment/payment.service';
import {
	Body,
	Controller,
	Post,
	UsePipes,
	ValidationPipe
} from '@nestjs/common';

@Controller('payments')
export class PaymentController {
	constructor(private readonly paymentService: PaymentService) {}

	@Post('create')
	@Auth()
	@UsePipes(new ValidationPipe({ whitelist: true }))
	async createPayment(
		@CurrentUser('id') userId: string,
		@Body() dto: CreatePaymentDto
	) {
		return this.paymentService.createPayment(
			userId,
			dto.plan,
			dto.billingPeriod
		);
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
