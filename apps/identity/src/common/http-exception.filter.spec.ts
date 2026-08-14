import {
	INestApplication,
	UnauthorizedException,
	ValidationPipe
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AccessJwtService } from '../auth/access-jwt.service';
import { AuthController } from '../auth/auth.controller';
import { IdentityAuthGuard } from '../auth/auth.guard';
import { AuthRateLimitGuard } from '../auth/auth-rate-limit.guard';
import { AuthService } from '../auth/auth.service';
import { RecaptchaGuard } from '../auth/recaptcha.guard';
import { RefreshTokenService } from '../auth/refresh-token.service';
import { IdentityEventsService } from '../events/identity-events.service';
import { IdentityPrismaService } from '../prisma/identity-prisma.service';
import { IdentityHttpExceptionFilter } from './http-exception.filter';

describe('Identity public auth HTTP exception contract', () => {
	let app: INestApplication;
	const auth = {
		login: jest.fn()
	};
	const allow = { canActivate: jest.fn().mockReturnValue(true) };

	beforeAll(async () => {
		const builder = Test.createTestingModule({
			controllers: [AuthController],
			providers: [
				{ provide: AuthService, useValue: auth },
				{
					provide: AccessJwtService,
					useValue: { getPublicJwks: jest.fn() }
				},
				{
					provide: RefreshTokenService,
					useValue: new RefreshTokenService()
				},
				{ provide: IdentityPrismaService, useValue: {} },
				{ provide: IdentityEventsService, useValue: {} },
				{ provide: AuthRateLimitGuard, useValue: allow },
				{ provide: RecaptchaGuard, useValue: allow },
				{ provide: IdentityAuthGuard, useValue: allow }
			]
		});
		builder.overrideGuard(AuthRateLimitGuard).useValue(allow);
		builder.overrideGuard(RecaptchaGuard).useValue(allow);
		builder.overrideGuard(IdentityAuthGuard).useValue(allow);
		const module = await builder.compile();

		app = module.createNestApplication();
		app.setGlobalPrefix('api/v1');
		app.useGlobalPipes(
			new ValidationPipe({
				transform: true,
				whitelist: true
			})
		);
		app.useGlobalFilters(new IdentityHttpExceptionFilter());
		await app.init();
	});

	afterEach(() => {
		auth.login.mockReset();
	});

	afterAll(async () => {
		if (app) await app.close();
	});

	it('maps a representative auth failure to the frozen localized body and code', async () => {
		auth.login.mockRejectedValueOnce(
			new UnauthorizedException('Email or password invalid')
		);

		const response = await request(app.getHttpServer())
			.post('/api/v1/auth/login')
			.send({ email: 'user@example.com', password: 'Secure1' })
			.expect(401);

		expect(response.body).toEqual({
			statusCode: 401,
			message: 'Неверный логин или пароль.',
			error: 'Unauthorized',
			code: 'invalid_credentials'
		});
	});

	it('preserves the validation-error array shape', async () => {
		const response = await request(app.getHttpServer())
			.post('/api/v1/auth/login')
			.send({ email: 'invalid', password: 'weak' })
			.expect(400);

		expect(response.body).toEqual({
			statusCode: 400,
			message: expect.arrayContaining([
				'Please enter a valid email',
				'Min length should more 6 symbols. Contains 1 number 0-9, 1 Latin letter a-z, 1 Latin letter A-Z'
			]),
			error: 'Bad Request',
			code: 'validation_error'
		});
		expect(auth.login).not.toHaveBeenCalled();
	});

	it('maps the missing refresh cookie to the frozen public contract', async () => {
		const response = await request(app.getHttpServer())
			.post('/api/v1/auth/refresh')
			.expect(401);

		expect(response.body).toEqual({
			statusCode: 401,
			message: 'Refresh token не передан.',
			error: 'Unauthorized',
			code: 'refresh_token_not_passed'
		});
	});
});
