import type { NestExpressApplication } from '@nestjs/platform-express';
import { json, RequestHandler } from 'express';

export function configureCrmIntakeBodyParser(app: NestExpressApplication) {
	const csv = json({ limit: 1024 * 1024 });
	const scoped: RequestHandler = (request, response, next) => {
		if (
			request.method === 'POST' &&
			/^\/api\/v1\/crm\/intake\/imports\/csv\/?$/.test(request.path)
		)
			return csv(request, response, next);
		next();
	};
	app.use(scoped);
	// Already parsed exact CSV requests pass through; all other JSON stays 32 KiB.
	app.useBodyParser('json', { limit: '32kb' });
}
