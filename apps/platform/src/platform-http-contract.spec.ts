import 'reflect-metadata';
import { RequestMethod, ValidationPipe } from '@nestjs/common';
import {
	GUARDS_METADATA,
	METHOD_METADATA,
	PATH_METADATA,
	PIPES_METADATA
} from '@nestjs/common/constants';
import {
	PLATFORM_REQUIRED_ROLES,
	PlatformAuthGuard
} from './auth/platform-auth.guard';
import { PlatformInternalGuard } from './auth/platform-internal.guard';
import { PlatformHomePageContentController } from './home-page-content/home-page-content.controller';
import {
	UpdateRawHomePageContentDto,
	UpdateStructuredHomePageContentDto
} from './home-page-content/home-page-content.dto';
import { PlatformLegalPagesController } from './legal-pages/legal-pages.controller';
import { UpdatePlatformLegalPageDto } from './legal-pages/legal-pages.dto';
import { PlatformInternalController } from './messaging/platform-internal.controller';
import { PLATFORM_GLOBAL_PREFIX_EXCLUDES } from './runtime/platform-http.config';
import { PlatformSiteSettingsController } from './site-settings/site-settings.controller';
import { UpdatePlatformSiteSettingsDto } from './site-settings/site-settings.dto';

type ControllerClass = { prototype: object };
type Handler = (...args: unknown[]) => unknown;

const contracts = [
	{
		controller: PlatformSiteSettingsController,
		handler: 'get',
		method: RequestMethod.GET,
		path: '/site-settings',
		roles: undefined
	},
	{
		controller: PlatformSiteSettingsController,
		handler: 'update',
		method: RequestMethod.PATCH,
		path: '/site-settings',
		roles: ['ADMIN', 'DEV'],
		dto: UpdatePlatformSiteSettingsDto
	},
	{
		controller: PlatformLegalPagesController,
		handler: 'getAll',
		method: RequestMethod.GET,
		path: '/legal-pages',
		roles: undefined
	},
	{
		controller: PlatformLegalPagesController,
		handler: 'getBySlug',
		method: RequestMethod.GET,
		path: '/legal-pages/:slug',
		roles: undefined
	},
	{
		controller: PlatformLegalPagesController,
		handler: 'update',
		method: RequestMethod.PATCH,
		path: '/legal-pages/:slug',
		roles: ['ADMIN', 'DEV'],
		dto: UpdatePlatformLegalPageDto,
		bodyIndex: 1
	},
	{
		controller: PlatformHomePageContentController,
		handler: 'get',
		method: RequestMethod.GET,
		path: '/home-page-content',
		roles: undefined
	},
	{
		controller: PlatformHomePageContentController,
		handler: 'updateStructured',
		method: RequestMethod.PATCH,
		path: '/home-page-content',
		roles: ['ADMIN', 'DEV'],
		dto: UpdateStructuredHomePageContentDto
	},
	{
		controller: PlatformHomePageContentController,
		handler: 'updateRaw',
		method: RequestMethod.PATCH,
		path: '/home-page-content/raw-code',
		roles: ['DEV'],
		dto: UpdateRawHomePageContentDto
	}
] as const;

function handlerFor(controller: ControllerClass, name: string): Handler {
	return Reflect.get(controller.prototype, name) as Handler;
}

function pathFor(controller: ControllerClass, handler: Handler): string {
	const controllerPath = String(
		Reflect.getMetadata(PATH_METADATA, controller) ?? ''
	);
	const handlerPath = String(
		Reflect.getMetadata(PATH_METADATA, handler) ?? ''
	);
	return `/${`${controllerPath}/${handlerPath}`
		.split('/')
		.filter(Boolean)
		.join('/')}`;
}

describe('Platform HTTP contract', () => {
	it('keeps the messaging overview on a loopback-only internal boundary', () => {
		const handler = handlerFor(PlatformInternalController, 'overview');
		expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(
			RequestMethod.GET
		);
		expect(pathFor(PlatformInternalController, handler)).toBe(
			'/internal/v1/platform/messaging/overview'
		);
		expect(
			Reflect.getMetadata(GUARDS_METADATA, PlatformInternalController)
		).toEqual([PlatformInternalGuard]);
		expect(
			Reflect.getMetadata(
				'platform-allow-inactive-ownership',
				PlatformInternalController
			)
		).toBeUndefined();
		expect(PLATFORM_GLOBAL_PREFIX_EXCLUDES).toEqual([
			{ path: 'health/live', method: RequestMethod.GET },
			{ path: 'health/ready', method: RequestMethod.GET },
			{
				path: 'internal/v1/platform/messaging/overview',
				method: RequestMethod.GET
			}
		]);
	});

	it.each(contracts)(
		'$method $path pins route and access matrix',
		contract => {
			const handler = handlerFor(contract.controller, contract.handler);
			expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(
				contract.method
			);
			expect(pathFor(contract.controller, handler)).toBe(contract.path);
			expect(
				Reflect.getMetadata(PLATFORM_REQUIRED_ROLES, handler)
			).toEqual(contract.roles);
			const guards = Reflect.getMetadata(GUARDS_METADATA, handler) ?? [];
			if (contract.roles) expect(guards).toEqual([PlatformAuthGuard]);
			else expect(guards).toEqual([]);
		}
	);

	it.each(contracts.filter(contract => 'dto' in contract))(
		'$path pins strict whitelist DTO',
		contract => {
			const handler = handlerFor(contract.controller, contract.handler);
			const parameterTypes = Reflect.getMetadata(
				'design:paramtypes',
				contract.controller.prototype,
				contract.handler
			) as unknown[];
			expect(
				parameterTypes['bodyIndex' in contract ? contract.bodyIndex : 0]
			).toBe(contract.dto);
			const pipes = Reflect.getMetadata(
				PIPES_METADATA,
				handler
			) as ValidationPipe[];
			expect(pipes).toHaveLength(1);
			const state = pipes[0] as unknown as {
				validatorOptions: {
					whitelist?: boolean;
					forbidNonWhitelisted?: boolean;
				};
			};
			expect(state.validatorOptions).toMatchObject({
				whitelist: true,
				forbidNonWhitelisted: true
			});
		}
	);
});
