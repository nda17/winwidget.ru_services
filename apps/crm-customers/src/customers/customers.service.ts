import {
	BadRequestException,
	ConflictException,
	ForbiddenException,
	Injectable,
	NotFoundException,
	ServiceUnavailableException
} from '@nestjs/common';
import { Company, Contact, Prisma } from '@prisma/crm-customers-client';
import { createHash } from 'node:crypto';
import { isTimeZone } from 'class-validator';
import {
	assertCustomersPermission,
	CustomersAuthorization
} from '../access/customers-authorization.client';
import { CrmCustomersPrismaService } from '../prisma/crm-customers-prisma.service';
import {
	ArchiveCustomerDto,
	ArchiveCompanyV2Dto,
	ArchiveContactV2Dto,
	CreateCompanyDto,
	CreateCompanyV2Dto,
	CreateContactDto,
	CreateContactV2Dto,
	CustomerDuplicateQuery,
	CustomerListQuery,
	UpdateCompanyDto,
	UpdateCompanyV2Dto,
	UpdateContactDto,
	UpdateContactV2Dto
} from './customers.dto';

export type CustomerKind = 'contact' | 'company';
export type CustomerViewVersion = 1 | 2;
type CustomerRow = Contact | Company;
type CustomerData =
	| CreateContactDto
	| CreateContactV2Dto
	| CreateCompanyDto
	| CreateCompanyV2Dto;
type CustomerWrite =
	| CustomerData
	| UpdateContactDto
	| UpdateContactV2Dto
	| UpdateCompanyDto
	| UpdateCompanyV2Dto
	| ArchiveCustomerDto
	| ArchiveCompanyV2Dto
	| ArchiveContactV2Dto;
type CustomerOperation = 'create' | 'update' | 'archive';

export function customerScope(
	context: CustomersAuthorization,
	includeArchived = false
): Prisma.ContactWhereInput {
	return {
		workspaceId: context.workspaceId,
		...(includeArchived ? {} : { archivedAt: null }),
		...(context.dataScope === 'ALL'
			? {}
			: context.dataScope === 'OWN'
				? { createdBySubject: context.subject }
				: {
						OR: [
							{ createdBySubject: context.subject },
							{ teamId: { in: context.teamIds } }
						]
					})
	};
}

export function customerView(
	kind: CustomerKind,
	row: CustomerRow,
	viewVersion: CustomerViewVersion = 1
) {
	const common = {
		id: row.id,
		workspaceId: row.workspaceId,
		name: row.name,
		notes: row.notes,
		createdBySubject: row.createdBySubject,
		teamId: row.teamId,
		version: row.version,
		archivedAt: row.archivedAt?.toISOString() ?? null,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString()
	};
	return kind === 'contact'
		? {
				...common,
				phone: (row as Contact).phone,
				email: (row as Contact).email,
				companyId: (row as Contact).companyId,
				...(viewVersion === 2
					? {
							timeZone: (row as Contact).timeZone,
							preferredCallStart: (row as Contact).preferredCallStart,
							preferredCallEnd: (row as Contact).preferredCallEnd
						}
					: {})
			}
		: {
				...common,
				inn: (row as Company).inn,
				website: (row as Company).website,
				...(viewVersion === 2
					? {
							legalName: (row as Company).legalName,
							kpp: (row as Company).kpp,
							ogrn: (row as Company).ogrn,
							legalAddress: (row as Company).legalAddress,
							entityType: (row as Company).entityType
						}
					: {})
			};
}

@Injectable()
export class CustomersService {
	constructor(private readonly prisma: CrmCustomersPrismaService) {}

	async list(
		kind: CustomerKind,
		context: CustomersAuthorization,
		query: CustomerListQuery,
		viewVersion: CustomerViewVersion = 1
	) {
		this.assertContext(context, query.workspaceId, 'customers:read');
		this.assertViewVersion(kind, viewVersion);
		const search = query.search?.trim();
		const where = {
			AND: [
				customerScope(context),
				...(search
					? [
							{
								OR:
									kind === 'contact'
										? [
												{
													name: { contains: search, mode: 'insensitive' }
												},
												{ phone: { contains: search } },
												{
													email: { contains: search, mode: 'insensitive' }
												}
											]
										: [
												{
													name: { contains: search, mode: 'insensitive' }
												},
												{ inn: { contains: search } }
											]
							}
						]
					: [])
			]
		};
		return this.page(
			kind,
			where as Prisma.ContactWhereInput,
			query,
			viewVersion
		);
	}

	async get(
		kind: CustomerKind,
		context: CustomersAuthorization,
		id: string,
		workspaceId: string,
		viewVersion: CustomerViewVersion = 1
	) {
		this.assertContext(context, workspaceId, 'customers:read');
		this.assertViewVersion(kind, viewVersion);
		const row = await this.find(this.prisma, kind, {
			AND: [customerScope(context), { id }]
		});
		if (!row) throw this.notFound();
		return this.response(kind, row, viewVersion);
	}

	async duplicates(
		context: CustomersAuthorization,
		query: CustomerDuplicateQuery,
		viewVersion: CustomerViewVersion = 1
	) {
		this.assertContext(context, query.workspaceId, 'customers:read');
		this.assertViewVersion('contact', viewVersion);
		if (!query.phone && !query.email)
			throw new BadRequestException('phone or email is required');
		const candidates: Prisma.ContactWhereInput[] = [];
		if (query.phone) candidates.push({ phone: query.phone });
		if (query.email)
			candidates.push({ email: query.email.trim().toLowerCase() });
		return this.page(
			'contact',
			{ AND: [customerScope(context), { OR: candidates }] },
			query,
			viewVersion
		);
	}

	async activities(
		kind: CustomerKind,
		context: CustomersAuthorization,
		id: string,
		query: CustomerListQuery,
		viewVersion: CustomerViewVersion = 1
	) {
		this.assertContext(context, query.workspaceId, 'customers:read');
		this.assertViewVersion(kind, viewVersion);
		const row = await this.find(this.prisma, kind, {
			AND: [customerScope(context, true), { id }]
		});
		if (!row) throw this.notFound();
		const where = {
			workspaceId: context.workspaceId,
			entityKind: kind,
			entityId: id
		};
		const [items, total] = await this.prisma.$transaction(
			[
				this.prisma.customerActivity.findMany({
					where,
					skip: (query.page - 1) * query.pageSize,
					take: query.pageSize,
					orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]
				}),
				this.prisma.customerActivity.count({ where })
			],
			{ isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }
		);
		return {
			schemaVersion: viewVersion,
			items: items.map(item => ({
				...item,
				createdAt: item.createdAt.toISOString()
			})),
			page: query.page,
			pageSize: query.pageSize,
			total
		};
	}

	async create(
		kind: CustomerKind,
		context: CustomersAuthorization,
		command: CustomerData
	) {
		return this.mutate(kind, 'create', context, command);
	}

	async update(
		kind: CustomerKind,
		context: CustomersAuthorization,
		id: string,
		command:
			| UpdateContactDto
			| UpdateContactV2Dto
			| UpdateCompanyDto
			| UpdateCompanyV2Dto
	) {
		return this.mutate(kind, 'update', context, command, id);
	}

	async archive(
		kind: CustomerKind,
		context: CustomersAuthorization,
		id: string,
		command: ArchiveCustomerDto | ArchiveCompanyV2Dto | ArchiveContactV2Dto
	) {
		return this.mutate(kind, 'archive', context, command, id);
	}

	private async page(
		kind: CustomerKind,
		where: Prisma.ContactWhereInput,
		query: { page: number; pageSize: number },
		viewVersion: CustomerViewVersion = 1
	) {
		const args = {
			where,
			skip: (query.page - 1) * query.pageSize,
			take: query.pageSize,
			orderBy: [{ createdAt: 'desc' as const }, { id: 'desc' as const }]
		};
		const [items, total] =
			kind === 'contact'
				? await this.prisma.$transaction(
						[
							this.prisma.contact.findMany(args),
							this.prisma.contact.count({ where })
						],
						{
							isolationLevel:
								Prisma.TransactionIsolationLevel.RepeatableRead
						}
					)
				: await this.prisma.$transaction(
						[
							this.prisma.company.findMany(
								args as Prisma.CompanyFindManyArgs
							),
							this.prisma.company.count({
								where: where as Prisma.CompanyWhereInput
							})
						],
						{
							isolationLevel:
								Prisma.TransactionIsolationLevel.RepeatableRead
						}
					);
		return {
			schemaVersion: viewVersion,
			items: items.map(row => customerView(kind, row, viewVersion)),
			page: query.page,
			pageSize: query.pageSize,
			total
		};
	}

	private async mutate(
		kind: CustomerKind,
		operation: CustomerOperation,
		context: CustomersAuthorization,
		command: CustomerWrite,
		id?: string
	) {
		this.assertContext(
			context,
			command.workspaceId,
			'customers:write',
			true
		);
		this.assertViewVersion(kind, command.schemaVersion);
		const data =
			operation === 'archive'
				? null
				: this.normalize(kind, command as CustomerData, operation);
		if (data?.teamId && !context.teamIds.includes(data.teamId))
			throw new ForbiddenException(
				'Customer team must belong to the authorized context'
			);
		const expectedVersion =
			'expectedVersion' in command ? command.expectedVersion : null;
		const requestHash = createHash('sha256')
			.update(
				JSON.stringify({
					schemaVersion: command.schemaVersion,
					kind,
					operation,
					workspaceId: command.workspaceId,
					actorSubject: context.subject,
					id: id ?? null,
					expectedVersion,
					data
				})
			)
			.digest('hex');

		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				return await this.prisma.$transaction(
					async tx => {
						await tx.$executeRaw(
							Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`crm-customers:command:${command.commandId}`}, 0))`
						);
						const receipt = await tx.customerCommand.findUnique({
							where: { commandId: command.commandId }
						});
						if (receipt) {
							if (
								receipt.requestHash !== requestHash ||
								receipt.actorSubject !== context.subject ||
								receipt.workspaceId !== context.workspaceId ||
								receipt.entityKind !== kind
							)
								throw new ConflictException({
									code: 'crm_customer_command_conflict',
									message:
										'Command ID was already used for another request'
								});
							const current = await this.find(tx, kind, {
								AND: [
									customerScope(context, true),
									{ id: receipt.entityId }
								]
							});
							if (!current) throw this.notFound();
							return receipt.response;
						}
						// One local lock prevents company archive racing contact linkage.
						await tx.$executeRaw(
							Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`crm-customers:workspace:${context.workspaceId}`}, 0))`
						);
						let prior: CustomerRow | null = null;
						if (operation !== 'create') {
							prior = await this.find(tx, kind, {
								AND: [customerScope(context), { id }]
							});
							if (!prior) throw this.notFound();
							if (prior.version !== expectedVersion)
								throw this.versionConflict();
						}
						if (kind === 'contact' && command.schemaVersion === 2 && data)
							this.assertContactCallPreferences({
								timeZone: (prior as Contact | null)?.timeZone ?? null,
								preferredCallStart:
									(prior as Contact | null)?.preferredCallStart ?? null,
								preferredCallEnd:
									(prior as Contact | null)?.preferredCallEnd ?? null,
								...data
							});
						if (
							kind === 'contact' &&
							data &&
							'companyId' in data &&
							data.companyId
						) {
							const company = await this.find(tx, 'company', {
								AND: [customerScope(context), { id: data.companyId }]
							});
							if (!company)
								throw new NotFoundException({
									code: 'crm_company_not_found',
									message: 'Company was not found'
								});
						}
						if (
							kind === 'company' &&
							operation === 'archive' &&
							(await tx.contact.count({
								where: {
									workspaceId: context.workspaceId,
									companyId: id,
									archivedAt: null
								}
							}))
						) {
							throw new ConflictException({
								code: 'crm_company_has_contacts',
								message: 'Unlink or archive company contacts first'
							});
						}
						let row: CustomerRow;
						if (operation === 'create' && data) {
							const common = {
								workspaceId: context.workspaceId,
								createdBySubject: context.subject,
								...data
							};
							row =
								kind === 'contact'
									? await tx.contact.create({
											data: common as Prisma.ContactUncheckedCreateInput
										})
									: await tx.company.create({
											data: common as Prisma.CompanyUncheckedCreateInput
										});
						} else {
							const update =
								operation === 'archive'
									? { archivedAt: new Date(), version: { increment: 1 } }
									: { ...data, version: { increment: 1 } };
							const where = {
								AND: [
									customerScope(context),
									{ id, version: expectedVersion! }
								]
							};
							const result =
								kind === 'contact'
									? await tx.contact.updateMany({
											where,
											data: update as Prisma.ContactUncheckedUpdateManyInput
										})
									: await tx.company.updateMany({
											where: where as Prisma.CompanyWhereInput,
											data: update as Prisma.CompanyUncheckedUpdateManyInput
										});
							if (result.count !== 1) throw this.versionConflict();
							const stored = await this.find(tx, kind, {
								workspaceId: context.workspaceId,
								id
							});
							if (!stored) throw this.notFound();
							row = stored;
						}
						const result = this.response(kind, row, command.schemaVersion);
						const changedFields =
							operation === 'archive'
								? ['archivedAt']
								: Object.keys(data!).filter(
										key =>
											!prior ||
											(prior as unknown as Record<string, unknown>)[
												key
											] !== (data as Record<string, unknown>)[key]
									);
						await tx.customerActivity.create({
							data: {
								workspaceId: context.workspaceId,
								entityId: row.id,
								entityKind: kind,
								commandId: command.commandId,
								actorSubject: context.subject,
								action:
									operation === 'create'
										? 'CREATED'
										: operation === 'update'
											? 'UPDATED'
											: 'ARCHIVED',
								entityVersion: row.version,
								changedFields
							}
						});
						await tx.customerCommand.create({
							data: {
								commandId: command.commandId,
								workspaceId: context.workspaceId,
								entityId: row.id,
								entityKind: kind,
								actorSubject: context.subject,
								requestHash,
								response: result as Prisma.InputJsonObject
							}
						});
						return result;
					},
					{ isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
				);
			} catch (error) {
				if (
					!(error instanceof Prisma.PrismaClientKnownRequestError) ||
					!['P2034', 'P2002'].includes(error.code)
				)
					throw error;
				if (attempt === 2)
					throw new ServiceUnavailableException({
						code: 'crm_customer_retry_required',
						message: 'Retry the same command'
					});
			}
		}
		throw new ServiceUnavailableException(
			'Customer command is unavailable'
		);
	}

	private normalize(
		kind: CustomerKind,
		dto: CustomerData,
		operation: 'create' | 'update'
	) {
		const common = {
			name: dto.name.trim(),
			notes: dto.notes?.trim() || null,
			teamId: dto.teamId ?? null
		};
		if (!common.name)
			throw new BadRequestException('Customer name is required');
		return kind === 'contact'
			? {
					...common,
					phone: (dto as CreateContactDto).phone ?? null,
					email:
						(dto as CreateContactDto).email?.trim().toLowerCase() || null,
					companyId: (dto as CreateContactDto).companyId ?? null,
					...(dto.schemaVersion === 2
						? this.normalizeContactCallPreferences(dto, operation)
						: {})
				}
			: {
					...common,
					inn: (dto as CreateCompanyDto).inn ?? null,
					website: (dto as CreateCompanyDto).website ?? null,
					...(dto.schemaVersion === 2
						? this.normalizeCompanyRequisites(dto, operation)
						: {})
				};
	}

	private normalizeCompanyRequisites(
		dto: CreateCompanyV2Dto,
		operation: 'create' | 'update'
	) {
		const data: Partial<
			Pick<
				Company,
				'legalName' | 'kpp' | 'ogrn' | 'legalAddress' | 'entityType'
			>
		> = {};
		for (const field of ['legalName', 'legalAddress'] as const) {
			if (operation === 'create' || dto[field] !== undefined)
				data[field] = dto[field]?.trim() || null;
		}
		for (const field of ['kpp', 'ogrn', 'entityType'] as const) {
			if (operation === 'create' || dto[field] !== undefined)
				data[field] = dto[field] ?? null;
		}
		return data;
	}

	private normalizeContactCallPreferences(
		dto: CreateContactV2Dto,
		operation: 'create' | 'update'
	) {
		const data: Partial<
			Pick<Contact, 'timeZone' | 'preferredCallStart' | 'preferredCallEnd'>
		> = {};
		for (const field of [
			'timeZone',
			'preferredCallStart',
			'preferredCallEnd'
		] as const) {
			if (operation === 'create' || dto[field] !== undefined)
				data[field] = dto[field] ?? null;
		}
		return data;
	}

	private assertContactCallPreferences(
		data: Pick<
			Contact,
			'timeZone' | 'preferredCallStart' | 'preferredCallEnd'
		>
	) {
		const {
			timeZone,
			preferredCallStart: start,
			preferredCallEnd: end
		} = data;
		const validZone =
			timeZone === null ||
			(typeof timeZone === 'string' &&
				timeZone.length <= 100 &&
				/^[A-Za-z][A-Za-z0-9._+\/-]*$/.test(timeZone) &&
				isTimeZone(timeZone));
		const hhmm = /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/;
		const validWindow =
			(start === null && end === null) ||
			(timeZone !== null &&
				start !== null &&
				end !== null &&
				hhmm.test(start) &&
				hhmm.test(end) &&
				start !== end);
		if (!validZone || !validWindow)
			throw new BadRequestException({
				code: 'crm_contact_call_preferences_invalid',
				message:
					'Use a valid time zone and either two different HH:mm values or no call window'
			});
	}

	private assertViewVersion(
		_kind: CustomerKind,
		viewVersion: CustomerViewVersion
	) {
		if (viewVersion !== 1 && viewVersion !== 2)
			throw new BadRequestException('Unsupported customer schema version');
	}

	private assertContext(
		context: CustomersAuthorization,
		workspaceId: string,
		permission: string,
		write = false
	) {
		if (context.workspaceId !== workspaceId)
			throw new ForbiddenException('Workspace scope mismatch');
		assertCustomersPermission(context, permission, write);
	}

	private find(
		tx: Prisma.TransactionClient,
		kind: CustomerKind,
		where: Prisma.ContactWhereInput
	): Promise<CustomerRow | null> {
		return kind === 'contact'
			? tx.contact.findFirst({ where })
			: tx.company.findFirst({ where: where as Prisma.CompanyWhereInput });
	}

	private response(
		kind: CustomerKind,
		row: CustomerRow,
		viewVersion: CustomerViewVersion = 1
	) {
		return {
			schemaVersion: viewVersion,
			[kind]: customerView(kind, row, viewVersion)
		};
	}

	private notFound() {
		return new NotFoundException({
			code: 'crm_customer_not_found',
			message: 'Customer record was not found'
		});
	}
	private versionConflict() {
		return new ConflictException({
			code: 'crm_customer_version_conflict',
			message: 'Customer record has changed; reload it before editing'
		});
	}
}
