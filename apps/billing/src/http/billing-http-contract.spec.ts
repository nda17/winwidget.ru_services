import 'reflect-metadata';
import {
	BadRequestException,
	HttpStatus,
	RequestMethod,
	ValidationPipe
} from '@nestjs/common';
import {
	GUARDS_METADATA,
	HTTP_CODE_METADATA,
	METHOD_METADATA,
	PATH_METADATA,
	PIPES_METADATA
} from '@nestjs/common/constants';
import {
	BILLING_REQUIRED_ROLES,
	BillingAuthGuard
} from '../auth/billing-auth.guard';
import { AffiliateController } from './affiliate.controller';
import {
	AdminActivateSubscriptionDto,
	AdminAutoRenewalActionDto,
	AdminExtendSubscriptionDto,
	AdminPaymentCheckDto,
	CancelPaymentDto,
	CreatePaymentDto,
	DevResolveUnknownProviderPaymentDto,
	TariffPriceItemDto,
	UpdateAffiliateSettingsDto,
	UpdateTariffPricesDto,
	VerifyPaymentDto
} from './billing.dto';
import { PaymentController } from './payment.controller';
import { SubscriptionController } from './subscription.controller';
import { TariffPricesController } from './tariff-prices.controller';

type ControllerClass = { prototype: object };
type DtoClass = new (...args: never[]) => object;
type BillingRole = 'ADMIN' | 'DEV';
type RuntimeHandler = (...args: unknown[]) => unknown;

interface BodyContract {
	dto: DtoClass;
	parameterIndex: number;
	transform?: boolean;
	forbidNonWhitelisted?: boolean;
}

interface PublicRouteContract {
	controller: ControllerClass;
	handler: string;
	method: RequestMethod;
	path: string;
	status: number;
	roles?: readonly BillingRole[];
	body?: BodyContract;
}

const AUTHENTICATED = [] as const;
const ADMIN = ['ADMIN'] as const;
const ADMIN_OR_DEV = ['ADMIN', 'DEV'] as const;
const DEV = ['DEV'] as const;

// Canonical SHA-A public surface mirrored from the Core controllers.
const PUBLIC_ROUTES: readonly PublicRouteContract[] = [
	{
		controller: PaymentController,
		handler: 'create',
		method: RequestMethod.POST,
		path: '/payments/create',
		status: HttpStatus.CREATED,
		roles: AUTHENTICATED,
		body: { dto: CreatePaymentDto, parameterIndex: 0 }
	},
	{
		controller: PaymentController,
		handler: 'verify',
		method: RequestMethod.POST,
		path: '/payments/verify',
		status: HttpStatus.CREATED,
		roles: AUTHENTICATED,
		body: { dto: VerifyPaymentDto, parameterIndex: 1 }
	},
	{
		controller: PaymentController,
		handler: 'pending',
		method: RequestMethod.GET,
		path: '/payments/pending',
		status: HttpStatus.OK,
		roles: AUTHENTICATED
	},
	{
		controller: PaymentController,
		handler: 'cancelPending',
		method: RequestMethod.POST,
		path: '/payments/pending/cancel',
		status: HttpStatus.OK,
		roles: AUTHENTICATED,
		body: { dto: CancelPaymentDto, parameterIndex: 0 }
	},
	{
		controller: PaymentController,
		handler: 'history',
		method: RequestMethod.GET,
		path: '/payments/history',
		status: HttpStatus.OK,
		roles: AUTHENTICATED
	},
	{
		controller: PaymentController,
		handler: 'autoRenewal',
		method: RequestMethod.GET,
		path: '/payments/auto-renewal',
		status: HttpStatus.OK,
		roles: AUTHENTICATED
	},
	{
		controller: PaymentController,
		handler: 'disableAutoRenewal',
		method: RequestMethod.DELETE,
		path: '/payments/auto-renewal',
		status: HttpStatus.OK,
		roles: AUTHENTICATED
	},
	{
		controller: PaymentController,
		handler: 'confirmPrice',
		method: RequestMethod.POST,
		path: '/payments/auto-renewal/confirm-price',
		status: HttpStatus.OK,
		roles: AUTHENTICATED
	},
	{
		controller: PaymentController,
		handler: 'adminList',
		method: RequestMethod.GET,
		path: '/payments/admin/list',
		status: HttpStatus.OK,
		roles: ADMIN_OR_DEV
	},
	{
		controller: PaymentController,
		handler: 'adminCheck',
		method: RequestMethod.POST,
		path: '/payments/admin/check',
		status: HttpStatus.OK,
		roles: ADMIN_OR_DEV,
		body: { dto: AdminPaymentCheckDto, parameterIndex: 0 }
	},
	{
		controller: PaymentController,
		handler: 'runCleanup',
		method: RequestMethod.POST,
		path: '/payments/admin/run-cleanup',
		status: HttpStatus.OK,
		roles: ADMIN
	},
	{
		controller: PaymentController,
		handler: 'adminAutoRenewal',
		method: RequestMethod.GET,
		path: '/payments/admin/auto-renewals/:userId',
		status: HttpStatus.OK,
		roles: ADMIN_OR_DEV
	},
	{
		controller: PaymentController,
		handler: 'pause',
		method: RequestMethod.POST,
		path: '/payments/admin/auto-renewals/:userId/pause',
		status: HttpStatus.OK,
		roles: ADMIN_OR_DEV,
		body: { dto: AdminAutoRenewalActionDto, parameterIndex: 1 }
	},
	{
		controller: PaymentController,
		handler: 'resume',
		method: RequestMethod.POST,
		path: '/payments/admin/auto-renewals/:userId/resume',
		status: HttpStatus.OK,
		roles: ADMIN_OR_DEV,
		body: { dto: AdminAutoRenewalActionDto, parameterIndex: 1 }
	},
	{
		controller: PaymentController,
		handler: 'revoke',
		method: RequestMethod.POST,
		path: '/payments/admin/auto-renewals/:userId/revoke',
		status: HttpStatus.OK,
		roles: ADMIN_OR_DEV,
		body: { dto: AdminAutoRenewalActionDto, parameterIndex: 1 }
	},
	{
		controller: PaymentController,
		handler: 'reconcile',
		method: RequestMethod.POST,
		path: '/payments/dev/auto-renewals/:userId/reconcile',
		status: HttpStatus.OK,
		roles: DEV
	},
	{
		controller: PaymentController,
		handler: 'resumeTechnical',
		method: RequestMethod.POST,
		path: '/payments/dev/auto-renewals/:userId/resume-technical',
		status: HttpStatus.OK,
		roles: DEV,
		body: { dto: AdminAutoRenewalActionDto, parameterIndex: 1 }
	},
	{
		controller: PaymentController,
		handler: 'unknownProviderPaymentEvidence',
		method: RequestMethod.GET,
		path: '/payments/dev/unknown-provider/:paymentId/evidence',
		status: HttpStatus.OK,
		roles: DEV
	},
	{
		controller: PaymentController,
		handler: 'resolveUnknownProviderPayment',
		method: RequestMethod.POST,
		path: '/payments/dev/unknown-provider/resolve',
		status: HttpStatus.OK,
		roles: DEV,
		body: {
			dto: DevResolveUnknownProviderPaymentDto,
			parameterIndex: 0,
			transform: true,
			forbidNonWhitelisted: true
		}
	},
	{
		controller: PaymentController,
		handler: 'webhook',
		method: RequestMethod.POST,
		path: '/payments/webhook',
		status: HttpStatus.OK
	},
	{
		controller: SubscriptionController,
		handler: 'me',
		method: RequestMethod.GET,
		path: '/subscriptions/me',
		status: HttpStatus.OK,
		roles: AUTHENTICATED
	},
	{
		controller: SubscriptionController,
		handler: 'adminList',
		method: RequestMethod.GET,
		path: '/subscriptions/admin/list',
		status: HttpStatus.OK,
		roles: ADMIN
	},
	{
		controller: SubscriptionController,
		handler: 'history',
		method: RequestMethod.GET,
		path: '/subscriptions/admin/history',
		status: HttpStatus.OK,
		roles: ADMIN
	},
	{
		controller: SubscriptionController,
		handler: 'activate',
		method: RequestMethod.POST,
		path: '/subscriptions/admin/activate',
		status: HttpStatus.OK,
		roles: ADMIN,
		body: { dto: AdminActivateSubscriptionDto, parameterIndex: 0 }
	},
	{
		controller: SubscriptionController,
		handler: 'extend',
		method: RequestMethod.POST,
		path: '/subscriptions/admin/extend-days',
		status: HttpStatus.OK,
		roles: ADMIN,
		body: { dto: AdminExtendSubscriptionDto, parameterIndex: 0 }
	},
	{
		controller: SubscriptionController,
		handler: 'cancel',
		method: RequestMethod.PATCH,
		path: '/subscriptions/admin/:userId/cancel',
		status: HttpStatus.OK,
		roles: ADMIN
	},
	{
		controller: SubscriptionController,
		handler: 'runExpiry',
		method: RequestMethod.POST,
		path: '/subscriptions/admin/run-expiry-check',
		status: HttpStatus.OK,
		roles: ADMIN
	},
	{
		controller: TariffPricesController,
		handler: 'getAll',
		method: RequestMethod.GET,
		path: '/tariff-prices',
		status: HttpStatus.OK
	},
	{
		controller: TariffPricesController,
		handler: 'update',
		method: RequestMethod.PATCH,
		path: '/tariff-prices',
		status: HttpStatus.OK,
		roles: ADMIN,
		body: {
			dto: UpdateTariffPricesDto,
			parameterIndex: 0,
			transform: true
		}
	},
	{
		controller: AffiliateController,
		handler: 'settings',
		method: RequestMethod.GET,
		path: '/affiliate/public-settings',
		status: HttpStatus.OK
	},
	{
		controller: AffiliateController,
		handler: 'me',
		method: RequestMethod.GET,
		path: '/affiliate/me',
		status: HttpStatus.OK,
		roles: AUTHENTICATED
	},
	{
		controller: AffiliateController,
		handler: 'referrals',
		method: RequestMethod.GET,
		path: '/affiliate/admin/referrals',
		status: HttpStatus.OK,
		roles: ADMIN
	},
	{
		controller: AffiliateController,
		handler: 'adminSettings',
		method: RequestMethod.GET,
		path: '/affiliate/admin/settings',
		status: HttpStatus.OK,
		roles: ADMIN
	},
	{
		controller: AffiliateController,
		handler: 'update',
		method: RequestMethod.PATCH,
		path: '/affiliate/admin/settings',
		status: HttpStatus.OK,
		roles: ADMIN,
		body: { dto: UpdateAffiliateSettingsDto, parameterIndex: 0 }
	}
];

const CONTROLLERS = [
	PaymentController,
	SubscriptionController,
	TariffPricesController,
	AffiliateController
] as const;

const handlerFor = (route: PublicRouteContract): RuntimeHandler => {
	const handler = Reflect.get(
		route.controller.prototype,
		route.handler
	) as unknown;
	if (typeof handler !== 'function') {
		throw new Error(`Missing handler ${route.handler}`);
	}
	return handler as RuntimeHandler;
};

const normalizeRoutePath = (
	controller: ControllerClass,
	handler: RuntimeHandler
) => {
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
};

const effectiveStatus = (
	handler: RuntimeHandler,
	method: RequestMethod
): number =>
	Reflect.getMetadata(HTTP_CODE_METADATA, handler) ??
	(method === RequestMethod.POST ? HttpStatus.CREATED : HttpStatus.OK);

const pipesFor = (handler: RuntimeHandler): ValidationPipe[] =>
	Reflect.getMetadata(PIPES_METADATA, handler) ?? [];

const routeKey = (method: RequestMethod, path: string) =>
	`${RequestMethod[method]} ${path}`;

describe('Billing public HTTP compatibility contract', () => {
	it('pins the public provider webhook to POST /payments/webhook with HTTP 200', () => {
		const route = PUBLIC_ROUTES.find(
			item =>
				item.controller === PaymentController && item.handler === 'webhook'
		);
		expect(route).toEqual(
			expect.objectContaining({
				method: RequestMethod.POST,
				path: '/payments/webhook',
				status: HttpStatus.OK
			})
		);
		const handler = handlerFor(route!);
		expect(normalizeRoutePath(PaymentController, handler)).toBe(
			'/payments/webhook'
		);
		expect(effectiveStatus(handler, RequestMethod.POST)).toBe(
			HttpStatus.OK
		);
	});

	it('exposes exactly the legacy routes plus the DEV recovery route', () => {
		const discovered = CONTROLLERS.flatMap(controller =>
			Object.getOwnPropertyNames(controller.prototype)
				.filter(name => name !== 'constructor')
				.map(name => {
					const handler = Reflect.get(
						controller.prototype,
						name
					) as unknown;
					if (typeof handler !== 'function') return null;
					const method = Reflect.getMetadata(METHOD_METADATA, handler) as
						| RequestMethod
						| undefined;
					return method === undefined
						? null
						: routeKey(
								method,
								normalizeRoutePath(controller, handler as RuntimeHandler)
							);
				})
				.filter((value): value is string => value !== null)
		).sort();
		const expected = PUBLIC_ROUTES.map(route =>
			routeKey(route.method, route.path)
		).sort();

		expect(PUBLIC_ROUTES).toHaveLength(34);
		expect(discovered).toEqual(expected);
	});

	it.each(PUBLIC_ROUTES)(
		'$path pins method, effective status and authorization metadata',
		route => {
			const handler = handlerFor(route);
			const method = Reflect.getMetadata(
				METHOD_METADATA,
				handler
			) as RequestMethod;
			const roles = Reflect.getMetadata(
				BILLING_REQUIRED_ROLES,
				handler
			) as BillingRole[] | undefined;
			const guards = (Reflect.getMetadata(GUARDS_METADATA, handler) ??
				[]) as unknown[] | undefined;

			expect(method).toBe(route.method);
			expect(normalizeRoutePath(route.controller, handler)).toBe(
				route.path
			);
			expect(effectiveStatus(handler, method)).toBe(route.status);
			expect(roles).toEqual(route.roles);
			if (route.roles === undefined) {
				expect(guards ?? []).not.toContain(BillingAuthGuard);
			} else {
				expect(guards).toEqual([BillingAuthGuard]);
			}
		}
	);

	it.each(PUBLIC_ROUTES.filter(route => route.body))(
		'$path pins its DTO and whitelist pipe',
		route => {
			const handler = handlerFor(route);
			const body = route.body!;
			const parameterTypes = Reflect.getMetadata(
				'design:paramtypes',
				route.controller.prototype,
				route.handler
			) as unknown[];
			const pipes = pipesFor(handler);
			const pipeState = pipes[0] as unknown as {
				validatorOptions: {
					whitelist?: boolean;
					forbidNonWhitelisted?: boolean;
				};
				isTransformEnabled: boolean;
			};

			expect(parameterTypes[body.parameterIndex]).toBe(body.dto);
			expect(pipes).toHaveLength(1);
			expect(pipes[0]).toBeInstanceOf(ValidationPipe);
			expect(pipeState.validatorOptions.whitelist).toBe(true);
			expect(
				pipeState.validatorOptions.forbidNonWhitelisted ?? false
			).toBe(body.forbidNonWhitelisted ?? false);
			expect(pipeState.isTransformEnabled).toBe(body.transform ?? false);
		}
	);

	it('keeps the webhook public and accepts an absent body', () => {
		const webhook = jest.fn().mockReturnValue({ accepted: true });
		const controller = new PaymentController({ webhook } as never);

		expect(controller.webhook(undefined)).toEqual({ accepted: true });
		expect(webhook).toHaveBeenCalledWith(undefined);
		const handler = handlerFor(
			PUBLIC_ROUTES.find(route => route.handler === 'webhook')!
		);
		expect(
			Reflect.getMetadata(BILLING_REQUIRED_ROLES, handler)
		).toBeUndefined();
		expect(pipesFor(handler)).toEqual([]);
	});

	it('keeps verify authenticated while accepting an absent body', async () => {
		const verify = jest.fn().mockReturnValue({ status: 'pending' });
		const controller = new PaymentController({ verify } as never);
		const route = PUBLIC_ROUTES.find(
			item =>
				item.controller === PaymentController && item.handler === 'verify'
		)!;
		const pipe = pipesFor(handlerFor(route))[0];

		await expect(
			pipe.transform(undefined, {
				type: 'body',
				metatype: VerifyPaymentDto
			})
		).resolves.toBeUndefined();
		expect(
			controller.verify(
				{
					subject: 'user-1',
					roles: ['USER']
				} as never,
				undefined
			)
		).toEqual({ status: 'pending' });
		expect(verify).toHaveBeenCalledWith('user-1', undefined);
	});

	it('preserves the legacy client IP and user-agent consent context', () => {
		const create = jest.fn();
		const disableUserAutoRenewal = jest.fn();
		const confirmPrice = jest.fn();
		const controller = new PaymentController({
			create,
			disableUserAutoRenewal,
			confirmPrice
		} as never);
		const actor = { subject: 'user-1', roles: ['USER'] } as never;
		const request = {
			ip: '',
			socket: { remoteAddress: '203.0.113.7' },
			get: jest.fn().mockReturnValue('billing-contract-agent')
		} as never;
		const expectedContext = {
			ip: '203.0.113.7',
			userAgent: 'billing-contract-agent'
		};

		controller.create({ plan: 'EASY' } as never, actor, request);
		controller.disableAutoRenewal(actor, request);
		controller.confirmPrice(actor, request);

		expect(create).toHaveBeenCalledWith(
			'user-1',
			{ plan: 'EASY' },
			expectedContext
		);
		expect(disableUserAutoRenewal).toHaveBeenCalledWith(
			'user-1',
			expectedContext
		);
		expect(confirmPrice).toHaveBeenCalledWith('user-1', expectedContext);
	});
});

interface DtoBehaviorCase {
	name: string;
	controller: ControllerClass;
	handler: string;
	dto: DtoClass;
	valid: Record<string, unknown>;
	allowedKeys: string[];
	invalid: Record<string, unknown>[];
	nestedAllowedKeys?: string[];
}

const DTO_CASES: DtoBehaviorCase[] = [
	{
		name: 'CreatePaymentDto',
		controller: PaymentController,
		handler: 'create',
		dto: CreatePaymentDto,
		valid: {
			plan: 'EASY',
			billingPeriod: 'MONTHLY',
			expectedAmount: 100,
			autoRenew: true,
			consentVersion: 'v1'
		},
		allowedKeys: [
			'plan',
			'billingPeriod',
			'expectedAmount',
			'autoRenew',
			'consentVersion'
		],
		invalid: [
			{ plan: 'UNKNOWN', billingPeriod: 'MONTHLY', expectedAmount: 100 },
			{ plan: 'EASY', billingPeriod: 'WEEKLY', expectedAmount: 100 },
			{ plan: 'EASY', billingPeriod: 'MONTHLY', expectedAmount: 0 },
			{
				plan: 'EASY',
				billingPeriod: 'MONTHLY',
				expectedAmount: 100,
				autoRenew: 'true'
			},
			{
				plan: 'EASY',
				billingPeriod: 'MONTHLY',
				expectedAmount: 100,
				consentVersion: 'x'.repeat(101)
			}
		]
	},
	{
		name: 'VerifyPaymentDto',
		controller: PaymentController,
		handler: 'verify',
		dto: VerifyPaymentDto,
		valid: { paymentId: 'payment-1' },
		allowedKeys: ['paymentId'],
		invalid: [{ paymentId: 42 }]
	},
	{
		name: 'CancelPaymentDto',
		controller: PaymentController,
		handler: 'cancelPending',
		dto: CancelPaymentDto,
		valid: { paymentId: 'payment-1' },
		allowedKeys: ['paymentId'],
		invalid: [{ paymentId: '' }, { paymentId: 'x'.repeat(101) }]
	},
	{
		name: 'AdminPaymentCheckDto',
		controller: PaymentController,
		handler: 'adminCheck',
		dto: AdminPaymentCheckDto,
		valid: { paymentId: '' },
		allowedKeys: ['paymentId'],
		invalid: [{ paymentId: 42 }]
	},
	{
		name: 'DevResolveUnknownProviderPaymentDto',
		controller: PaymentController,
		handler: 'resolveUnknownProviderPayment',
		dto: DevResolveUnknownProviderPaymentDto,
		valid: {
			schemaVersion: 1,
			commandId: 'c7de40a7-b401-41d5-92ef-2c437180e201',
			paymentId: 'payment-1',
			resolution: 'PROVIDER_PAYMENT_NOT_FOUND',
			reason: 'Provider payment was not found after manual reconciliation',
			providerReconciliationConfirmed: true,
			checkedMetadataPaymentId: 'payment-1',
			checkedProviderIdempotencyKey: 'provider-command-1'
		},
		allowedKeys: [
			'schemaVersion',
			'commandId',
			'paymentId',
			'resolution',
			'reason',
			'providerReconciliationConfirmed',
			'checkedMetadataPaymentId',
			'checkedProviderIdempotencyKey'
		],
		invalid: [
			{
				schemaVersion: 2,
				commandId: 'c7de40a7-b401-41d5-92ef-2c437180e201',
				paymentId: 'payment-1',
				resolution: 'PROVIDER_PAYMENT_NOT_FOUND',
				reason: 'manual reconciliation',
				providerReconciliationConfirmed: true,
				checkedMetadataPaymentId: 'payment-1',
				checkedProviderIdempotencyKey: 'provider-command-1'
			},
			{
				schemaVersion: 1,
				commandId: 'not-a-uuid',
				paymentId: 'payment-1',
				resolution: 'PROVIDER_PAYMENT_NOT_FOUND',
				reason: 'manual reconciliation',
				providerReconciliationConfirmed: true,
				checkedMetadataPaymentId: 'payment-1',
				checkedProviderIdempotencyKey: 'provider-command-1'
			},
			{
				schemaVersion: 1,
				commandId: 'c7de40a7-b401-41d5-92ef-2c437180e201',
				paymentId: 'payment-1',
				resolution: 'SUCCEEDED',
				reason: 'manual reconciliation',
				providerReconciliationConfirmed: true,
				checkedMetadataPaymentId: 'payment-1',
				checkedProviderIdempotencyKey: 'provider-command-1'
			},
			{
				schemaVersion: 1,
				commandId: 'c7de40a7-b401-41d5-92ef-2c437180e201',
				paymentId: 'payment-1',
				resolution: 'PROVIDER_PAYMENT_NOT_FOUND',
				reason: 'manual reconciliation',
				providerReconciliationConfirmed: false,
				checkedMetadataPaymentId: 'payment-1',
				checkedProviderIdempotencyKey: 'provider-command-1'
			}
		]
	},
	{
		name: 'AdminAutoRenewalActionDto',
		controller: PaymentController,
		handler: 'pause',
		dto: AdminAutoRenewalActionDto,
		valid: { reason: 'abc' },
		allowedKeys: ['reason'],
		invalid: [{ reason: 'ab' }, { reason: 'x'.repeat(501) }]
	},
	{
		name: 'AdminActivateSubscriptionDto',
		controller: SubscriptionController,
		handler: 'activate',
		dto: AdminActivateSubscriptionDto,
		valid: {
			userId: 'user-1',
			plan: 'HARD',
			billingPeriod: 'YEARLY',
			startsAt: '2026-08-11T00:00:00.000Z',
			extendIfActive: true
		},
		allowedKeys: [
			'userId',
			'plan',
			'billingPeriod',
			'startsAt',
			'extendIfActive'
		],
		invalid: [
			{ userId: 1, plan: 'HARD' },
			{ userId: 'user-1', plan: 'UNKNOWN' },
			{ userId: 'user-1', plan: 'HARD', billingPeriod: 'WEEKLY' },
			{ userId: 'user-1', plan: 'HARD', startsAt: 'not-a-date' },
			{ userId: 'user-1', plan: 'HARD', extendIfActive: 'true' }
		]
	},
	{
		name: 'AdminExtendSubscriptionDto',
		controller: SubscriptionController,
		handler: 'extend',
		dto: AdminExtendSubscriptionDto,
		valid: { userId: 'user-1', audience: 'ALL', days: 1 },
		allowedKeys: ['userId', 'audience', 'days'],
		invalid: [
			{ userId: 1, days: 1 },
			{ audience: 'UNKNOWN', days: 1 },
			{ audience: 'ALL', days: 0 },
			{ audience: 'ALL', days: 3651 }
		]
	},
	{
		name: 'UpdateTariffPricesDto',
		controller: TariffPricesController,
		handler: 'update',
		dto: UpdateTariffPricesDto,
		valid: {
			prices: [
				{
					plan: 'EASY',
					billingPeriod: 'MONTHLY',
					amount: 100,
					unexpectedNested: true
				}
			]
		},
		allowedKeys: ['prices'],
		nestedAllowedKeys: ['plan', 'billingPeriod', 'amount'],
		invalid: [
			{ prices: 'not-an-array' },
			{
				prices: [
					{ plan: 'UNKNOWN', billingPeriod: 'MONTHLY', amount: 100 }
				]
			},
			{
				prices: [{ plan: 'EASY', billingPeriod: 'MONTHLY', amount: 0 }]
			},
			{
				prices: [
					{
						plan: 'EASY',
						billingPeriod: 'MONTHLY',
						amount: 10_000_001
					}
				]
			}
		]
	},
	{
		name: 'UpdateAffiliateSettingsDto',
		controller: AffiliateController,
		handler: 'update',
		dto: UpdateAffiliateSettingsDto,
		valid: { enabled: true, cashbackPercent: 1 },
		allowedKeys: ['enabled', 'cashbackPercent'],
		invalid: [
			{ enabled: 'true' },
			{ cashbackPercent: 0 },
			{ cashbackPercent: 51 }
		]
	}
];

describe('Billing public DTO compatibility contract', () => {
	it.each(DTO_CASES)(
		'$name accepts its valid shape with the route whitelist policy',
		async contract => {
			const route = PUBLIC_ROUTES.find(
				item =>
					item.controller === contract.controller &&
					item.handler === contract.handler
			)!;
			const pipe = pipesFor(handlerFor(route))[0];
			const input = route.body?.forbidNonWhitelisted
				? contract.valid
				: { ...contract.valid, unexpectedTopLevel: true };
			const result = (await pipe.transform(input, {
				type: 'body',
				metatype: contract.dto
			})) as Record<string, unknown>;

			expect(Object.keys(result).sort()).toEqual(
				[...contract.allowedKeys].sort()
			);
			if (contract.nestedAllowedKeys) {
				const nested = (result.prices as Record<string, unknown>[])[0];
				expect(Object.keys(nested).sort()).toEqual(
					[...contract.nestedAllowedKeys].sort()
				);
				expect(nested).toBeInstanceOf(TariffPriceItemDto);
			}
		}
	);

	it.each(DTO_CASES)(
		'$name rejects values rejected by the legacy DTO contract',
		async contract => {
			const route = PUBLIC_ROUTES.find(
				item =>
					item.controller === contract.controller &&
					item.handler === contract.handler
			)!;
			const pipe = pipesFor(handlerFor(route))[0];

			for (const invalid of contract.invalid) {
				await expect(
					pipe.transform(invalid, {
						type: 'body',
						metatype: contract.dto
					})
				).rejects.toBeInstanceOf(BadRequestException);
			}
		}
	);
});
