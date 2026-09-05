import {
	Body,
	Controller,
	Get,
	Header,
	Headers,
	HttpCode,
	Param,
	Post,
	Query
} from '@nestjs/common';
import { CrmBillingService } from './billing.service';
import { contextBody, query, workspace } from './billing.validation';

@Controller('crm/access/billing')
export class CrmBillingController {
	constructor(private readonly billing: CrmBillingService) {}
	@Get()
	@Header('Cache-Control', 'no-store')
	context(
		@Headers('authorization') auth: string | undefined,
		@Query() input: unknown
	) {
		return this.billing.context(auth, query(input).workspaceId);
	}
	@Post('quote')
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	quote(
		@Headers('authorization') auth: string | undefined,
		@Body() body: unknown
	) {
		return this.billing.quote(auth, body);
	}
	@Post('checkout')
	@HttpCode(202)
	@Header('Cache-Control', 'no-store')
	checkout(
		@Headers('authorization') auth: string | undefined,
		@Headers('idempotency-key') key: string | undefined,
		@Body() body: unknown
	) {
		return this.billing.command('WINCRM_CHECKOUT', auth, body, key);
	}
	@Post('seats')
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	seats(
		@Headers('authorization') auth: string | undefined,
		@Headers('idempotency-key') key: string | undefined,
		@Body() body: unknown
	) {
		return this.billing.command('WINCRM_SEAT_CHANGE', auth, body, key);
	}
	@Post('renewal/disable')
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	disable(
		@Headers('authorization') auth: string | undefined,
		@Headers('idempotency-key') key: string | undefined,
		@Body() body: unknown
	) {
		return this.billing.command('WINCRM_DISABLE_RENEWAL', auth, body, key);
	}
	@Post('renewal/confirm-price')
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	confirm(
		@Headers('authorization') auth: string | undefined,
		@Headers('idempotency-key') key: string | undefined,
		@Body() body: unknown
	) {
		return this.billing.command('WINCRM_CONFIRM_RENEWAL', auth, body, key);
	}
	@Get('orders/:id')
	@Header('Cache-Control', 'no-store')
	order(
		@Headers('authorization') auth: string | undefined,
		@Param('id') id: string,
		@Query() input: unknown
	) {
		return this.billing.order(
			auth,
			query(input).workspaceId,
			workspace(id)
		);
	}
	@Post('orders/verify')
	@HttpCode(202)
	@Header('Cache-Control', 'no-store')
	verify(
		@Headers('authorization') auth: string | undefined,
		@Headers('idempotency-key') key: string | undefined,
		@Body() body: unknown
	) {
		return this.billing.command('WINCRM_VERIFY_ORDER', auth, body, key);
	}
	@Get('history')
	@Header('Cache-Control', 'no-store')
	history(
		@Headers('authorization') auth: string | undefined,
		@Query() input: unknown
	) {
		const q = query(input, 'history');
		return this.billing.history(auth, q.workspaceId, q.page, q.pageSize);
	}
	@Get('operations/:id')
	@Header('Cache-Control', 'no-store')
	operation(
		@Headers('authorization') auth: string | undefined,
		@Param('id') id: string,
		@Query() input: unknown
	) {
		return this.billing.operation(
			auth,
			query(input).workspaceId,
			workspace(id)
		);
	}
	@Post('operations/:id/recover')
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	recover(
		@Headers('authorization') auth: string | undefined,
		@Param('id') id: string,
		@Body() input: unknown
	) {
		return this.billing.operation(
			auth,
			contextBody(input).workspaceId,
			workspace(id),
			true
		);
	}
}
