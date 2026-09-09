import {
	CanActivate,
	ExecutionContext,
	HttpException,
	Injectable,
	NotFoundException
} from '@nestjs/common';
import { Prisma } from '@prisma/support-client';
import type { SupportRequest } from '../auth/support-request';
import { SupportPrismaService } from '../prisma/support-prisma.service';
import { hashSupport } from './support-web.util';
import { SupportRuntimeService } from '../runtime/support-runtime.service';

@Injectable()
export class SupportWebRateGuard implements CanActivate {
	constructor(
		private readonly prisma: SupportPrismaService,
		private readonly runtime: SupportRuntimeService
	) {}
	async canActivate(context: ExecutionContext): Promise<boolean> {
		const request = context.switchToHttp().getRequest<SupportRequest>();
		if (!this.runtime.webChatEnabled)
			throw new NotFoundException('Чат поддержки пока недоступен');
		const actor = request.supportActor;
		if (!actor) return false;
		const upload =
			request.method === 'POST' && request.path.endsWith('/attachments');
		const read = request.method === 'GET' || request.method === 'PUT';
		const scope = upload ? 'upload' : read ? 'read' : 'write';
		const limit = upload ? 20 : read ? 240 : 30;
		const key = hashSupport([actor.subject, scope]);
		const result = await this.prisma.$queryRaw<
			Array<{ count: number }>
		>(Prisma.sql`
   INSERT INTO support.web_rate_buckets (key,count,expires_at)
   VALUES (${key} || ':' || floor(extract(epoch from clock_timestamp())/60)::text,1,date_trunc('minute',clock_timestamp())+interval '2 minutes')
   ON CONFLICT (key) DO UPDATE SET count=web_rate_buckets.count+1 RETURNING count`);
		if (result[0].count > limit)
			throw new HttpException(
				{
					code: 'support_rate_limit',
					message: 'Слишком много запросов. Повторите через минуту.'
				},
				429
			);
		return true;
	}
}
