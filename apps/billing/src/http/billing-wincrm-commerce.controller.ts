import {
	BadRequestException,
	Body,
	Controller,
	Header,
	Headers,
	HttpCode,
	Post,
	UseGuards,
	UsePipes,
	ValidationPipe
} from '@nestjs/common';
import { BillingCrmAccessGuard } from '../auth/billing-crm-access.guard';
import { WincrmCommerceService } from '../domain/wincrm-commerce.service';
import {
	WincrmCheckoutDto,
	WincrmCloseCommandDto,
	WincrmCommandStatusDto,
	WincrmCommerceContextDto,
	WincrmConfirmRenewalDto,
	WincrmDisableRenewalDto,
	WincrmHistoryDto,
	WincrmOrderDto,
	WincrmQuoteDto,
	WincrmSeatChangeDto,
	WincrmVerifyOrderDto
} from './billing-wincrm-commerce.dto';

@Controller('internal/v1/crm-access/billing/commerce')
@UseGuards(BillingCrmAccessGuard)
@UsePipes(
	new ValidationPipe({
		whitelist: true,
		forbidNonWhitelisted: true,
		transform: true
	})
)
export class BillingWincrmCommerceController {
	constructor(private readonly commerce: WincrmCommerceService) {}
	@Post('summary')
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	summary(@Body() dto: WincrmCommerceContextDto) {
		return this.commerce.summary(dto);
	}
	@Post('quote')
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	quote(@Body() dto: WincrmQuoteDto) {
		return this.commerce.quote(dto);
	}
	@Post('checkout')
	@HttpCode(202)
	@Header('Cache-Control', 'no-store')
	checkout(
		@Body() dto: WincrmCheckoutDto,
		@Headers('idempotency-key') key?: string
	) {
		this.commandKey(key, dto.commandId);
		return this.commerce.checkout(dto);
	}
	@Post('seats')
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	seats(
		@Body() dto: WincrmSeatChangeDto,
		@Headers('idempotency-key') key?: string
	) {
		this.commandKey(key, dto.commandId);
		return this.commerce.changeSeats(dto);
	}
	@Post('renewal/disable')
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	disable(
		@Body() dto: WincrmDisableRenewalDto,
		@Headers('idempotency-key') key?: string
	) {
		this.commandKey(key, dto.commandId);
		return this.commerce.disableRenewal(dto);
	}
	@Post('renewal/confirm-price')
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	confirm(
		@Body() dto: WincrmConfirmRenewalDto,
		@Headers('idempotency-key') key?: string
	) {
		this.commandKey(key, dto.commandId);
		return this.commerce.confirmRenewal(dto);
	}
	@Post('orders/get')
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	order(@Body() dto: WincrmOrderDto) {
		return this.commerce.order(dto);
	}
	@Post('orders/verify')
	@HttpCode(202)
	@Header('Cache-Control', 'no-store')
	verify(
		@Body() dto: WincrmVerifyOrderDto,
		@Headers('idempotency-key') key?: string
	) {
		this.commandKey(key, dto.commandId);
		return this.commerce.verifyOrder(dto);
	}
	@Post('history')
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	history(@Body() dto: WincrmHistoryDto) {
		return this.commerce.history(dto);
	}
	@Post('operations/get')
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	status(@Body() dto: WincrmCommandStatusDto) {
		return this.commerce.commandStatus(dto);
	}
	@Post('operations/close')
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	close(
		@Body() dto: WincrmCloseCommandDto,
		@Headers('idempotency-key') key?: string
	) {
		this.commandKey(key, dto.commandId);
		return this.commerce.closeCommand(dto);
	}
	private commandKey(header: string | undefined, commandId: string) {
		if (header !== commandId)
			throw new BadRequestException(
				'Idempotency-Key must match commandId'
			);
	}
}
