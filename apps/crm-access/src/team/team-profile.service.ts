import {
	ConflictException,
	ForbiddenException,
	Injectable,
	NotFoundException
} from '@nestjs/common';
import type {
	CrmEmployeeProfile,
	Prisma
} from '@prisma/crm-access-client';
import { CrmAuthorizationService } from '../authorization/crm-authorization.service';
import { CrmAccessPrismaService } from '../prisma/crm-access-prisma.service';
import type {
	EmployeeProfileQueryDto,
	UpdateEmployeeProfileDto
} from './team.dto';
import { normalizeEmployeeName } from './team-profile.dto';
import { auditTeam, command, type TeamAuthority } from './team.util';

const profileDto = (profile: CrmEmployeeProfile) => ({
	id: profile.id,
	firstName: profile.firstName,
	lastName: profile.lastName,
	middleName: profile.middleName,
	version: profile.version,
	updatedAt: profile.updatedAt.toISOString()
});

@Injectable()
export class CrmEmployeeProfileService {
	constructor(
		private readonly prisma: CrmAccessPrismaService,
		private readonly auth: CrmAuthorizationService
	) {}

	async get(
		authorization: string | undefined,
		query: EmployeeProfileQueryDto
	) {
		const actor = await this.auth.authorize(
			authorization,
			query.workspaceId
		);
		const subject = query.subject ?? actor.subject;
		const target = await this.authorizeTarget(actor, subject, false);
		return this.prisma.$transaction(
			async tx => {
				await this.checkTarget(tx, target);
				const profile = await tx.crmEmployeeProfile.findUnique({
					where: {
						workspaceId_subject: {
							workspaceId: actor.workspaceId,
							subject
						}
					}
				});
				return this.response(actor, subject, profile);
			},
			{ isolationLevel: 'RepeatableRead' }
		);
	}

	async update(
		authorization: string | undefined,
		dto: UpdateEmployeeProfileDto
	) {
		const actor = await this.auth.authorize(
			authorization,
			dto.workspaceId
		);
		const target = await this.authorizeTarget(actor, dto.subject, true);
		const names = normalizeEmployeeName(dto.profile);
		return command(
			this.prisma,
			actor,
			dto.commandId,
			'employee.profile',
			{ ...dto, profile: names },
			async tx => {
				await this.checkTarget(tx, target);
				const where = {
					workspaceId_subject: {
						workspaceId: actor.workspaceId,
						subject: dto.subject
					}
				};
				const current = await tx.crmEmployeeProfile.findUnique({ where });
				if ((current?.version ?? 0) !== dto.expectedVersion)
					throw new ConflictException('Employee profile version changed');
				const updated = current
					? await tx.crmEmployeeProfile.update({
							where,
							data: { ...names, version: { increment: 1 } }
						})
					: await tx.crmEmployeeProfile.create({
							data: {
								workspaceId: actor.workspaceId,
								subject: dto.subject,
								...names
							}
						});
				// Do not retain additional copies of names in the audit record.
				await auditTeam(
					tx,
					actor,
					dto.commandId,
					'EMPLOYEE_PROFILE_UPDATED',
					updated.id,
					{ version: current?.version ?? 0 },
					{ version: updated.version }
				);
				return this.response(actor, dto.subject, updated);
			}
		);
	}

	private async authorizeTarget(
		actor: TeamAuthority,
		subject: string,
		write: boolean
	) {
		if (write && actor.state === 'READ_ONLY')
			throw new ForbiddenException('Employee profile is read-only');
		if (subject === actor.subject) return actor;
		if (
			!['OWNER', 'CRM_ADMIN'].includes(actor.role) ||
			!actor.permissions.includes(
				write ? 'access:manage-team' : 'access:read-team'
			)
		)
			throw new ForbiddenException(
				'Employee profile access is not permitted'
			);
		let target: TeamAuthority;
		try {
			target = await this.auth.authorizeSubject(
				actor.workspaceId,
				subject
			);
		} catch (error) {
			if (error instanceof ForbiddenException)
				throw new NotFoundException('Active CRM employee was not found');
			throw error;
		}
		if (write && target.state === 'READ_ONLY')
			throw new ForbiddenException('Employee profile is read-only');
		if (
			write &&
			actor.role !== 'OWNER' &&
			['OWNER', 'CRM_ADMIN'].includes(target.role)
		)
			throw new ForbiddenException(
				'Only the owner can manage this employee profile'
			);
		return target;
	}

	private async checkTarget(
		tx: Prisma.TransactionClient,
		target: TeamAuthority
	) {
		if (target.role === 'OWNER') return;
		const member = await tx.crmWorkspaceMember.findUnique({
			where: {
				workspaceId_subject: {
					workspaceId: target.workspaceId,
					subject: target.subject
				}
			}
		});
		if (!member || member.disabledAt || member.role !== target.role)
			throw new ForbiddenException('CRM employee access has changed');
	}

	private response(
		actor: TeamAuthority,
		subject: string,
		profile: CrmEmployeeProfile | null
	) {
		return {
			schemaVersion: 1 as const,
			workspaceId: actor.workspaceId,
			subject: actor.subject,
			targetSubject: subject,
			profile: profile ? profileDto(profile) : null
		};
	}
}
