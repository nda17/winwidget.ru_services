import { AppModule } from '@/app.module';
import { GoogleRecaptchaExceptionFilter } from '@/filters/google-recaptcha-exception.filter';
import { RecaptchaDevLoggingInterceptor } from '@/interceptors/recaptcha-dev-logging.interceptor';
import { AppHttpExceptionFilter } from '@/filters/http-exception.filter';
import { RequestMethod } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import 'colors';
import * as cookieParser from 'cookie-parser';

export const bootstrap = async () => {
	const app = await NestFactory.create(AppModule);
	const httpAdapter = app.getHttpAdapter();
	const instance = httpAdapter.getInstance();
	if (typeof instance?.set === 'function') {
		instance.set('trust proxy', true);
	}

	app.setGlobalPrefix('api', {
		exclude: [
			{ path: 'auth/google', method: RequestMethod.GET },
			{ path: 'auth/google/redirect', method: RequestMethod.GET },
			{ path: 'auth/github', method: RequestMethod.GET },
			{ path: 'auth/github/redirect', method: RequestMethod.GET }
		]
	});

	if (process.env.MODE === 'development') {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		app.use(require('morgan')('dev'));
	}

	app.use(cookieParser());
	app.useGlobalInterceptors(new RecaptchaDevLoggingInterceptor());
	app.useGlobalFilters(
		new GoogleRecaptchaExceptionFilter(),
		new AppHttpExceptionFilter()
	);
	app.enableCors({
		origin: [process.env.PRODUCTION_HOST, process.env.DEVELOPMENT_HOST],
		credentials: true,
		exposedHeaders: 'set-cookie'
	});

	const port = process.env.PORT || 5000;

	await app.listen(port, () =>
		console.info(
			`🚀🚀🚀 Server running in ${process.env.MODE} mode at http://localhost:${port} 🚀🚀🚀`
				.bgRed.bold
		)
	);
};

bootstrap();
