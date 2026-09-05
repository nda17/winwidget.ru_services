import {
	BadRequestException,
	ForbiddenException,
	Injectable,
	ServiceUnavailableException
} from '@nestjs/common';
import { Prisma, type CrmAdmission } from '@prisma/crm-access-client';
import { CrmAuthorizationService } from '../authorization/crm-authorization.service';
import { getCrmAccessCorrelationId } from '../common/crm-access-request-context';
import { BillingEntitlementClient } from '../internal/billing-entitlement.client';
import { IdentityAuthContextClient } from '../internal/identity-auth-context.client';
import {
	IdentityInvitationClient,
	InvitationRejectedError,
	type IdentityInvitationAcceptance
} from '../internal/identity-invitation.client';
import { CrmAccessPrismaService } from '../prisma/crm-access-prisma.service';
import { CrmTeamService } from './team.service';
import {
	auditTeam,
	emitTeamEvent,
	serializable,
	workspaceLock,
	type TeamAuthority
} from './team.util';

export interface AcceptedInvitationEvent {
	schemaVersion: 1;
	eventId: string;
	eventType: 'identity.wincrm.invitation-accepted.v1';
	invitationId: string;
	invitationVersion: number;
	workspaceId: string;
	acceptanceId: string;
	subject: string;
	membershipId: string;
	occurredAt: string;
}

@Injectable()
export class CrmTeamAdmissionService {
	constructor(
		private readonly prisma: CrmAccessPrismaService,
		private readonly auth: CrmAuthorizationService,
		private readonly billing: BillingEntitlementClient,
		private readonly identity: IdentityAuthContextClient,
		private readonly invitations: IdentityInvitationClient,
		private readonly teams: CrmTeamService
	) {}

	async provision(workspaceId: string, invitationId: string) {
		const intent = await this.prisma.crmInvitationIntent.findFirst({
			where: { id: invitationId, workspaceId }
		});
		if (!intent) return;
		if (intent.status === 'REVOKED') {
			try {
				await this.invitations.revoke(intent);
			} catch (error) {
				if (!(error instanceof InvitationRejectedError)) throw error;
			}
			return;
		}
		if (intent.status !== 'REGISTERING') return;
		if (intent.expiresAt <= new Date()) {
			await this.prisma.crmInvitationIntent.updateMany({
				where: {
					id: intent.id,
					status: 'REGISTERING',
					version: intent.version
				},
				data: { status: 'EXPIRED', version: { increment: 1 } }
			});
			return;
		}
		const actor = await this.auth.authorizeSubject(
			workspaceId,
			intent.inviterSubject
		);
		this.requireManager(actor, intent.role);
		const registered = await this.invitations.create(intent);
		await serializable(this.prisma, async tx => {
			await workspaceLock(tx, workspaceId);
			await tx.crmInvitationIntent.updateMany({
				where: {
					id: intent.id,
					workspaceId,
					status: 'REGISTERING',
					version: intent.version
				},
				data: {
					status: 'INVITED',
					identityVersion: registered.version,
					version: { increment: 1 }
				}
			});
		});
		// A concurrent local revocation wins even if Identity registration already committed.
		const latest = await this.prisma.crmInvitationIntent.findUniqueOrThrow(
			{ where: { id: intent.id } }
		);
		if (latest.status === 'REVOKED') {
			try {
				await this.invitations.revoke(latest);
			} catch (error) {
				if (!(error instanceof InvitationRejectedError)) throw error;
			}
		}
	}

	async accept(event: AcceptedInvitationEvent) {
		const intent = await this.prisma.crmInvitationIntent.findFirst({
			where: { id: event.invitationId, workspaceId: event.workspaceId }
		});
		if (!intent || intent.status === 'REVOKED') return;
		let proof: IdentityInvitationAcceptance;
		try {
			proof = await this.invitations.acceptance(
				event.invitationId,
				event.workspaceId
			);
		} catch (error) {
			if (error instanceof InvitationRejectedError) return;
			throw error;
		}
		this.matchProof(proof, event);
		if (Date.parse(proof.acceptedAt) > intent.expiresAt.getTime())
			throw new Error('ACCEPTANCE_AFTER_INVITATION_EXPIRY');
		await serializable(this.prisma, async tx => {
			await workspaceLock(tx, event.workspaceId);
			const current = await tx.crmInvitationIntent.findUniqueOrThrow({
				where: { id: intent.id }
			});
			if (current.status === 'REVOKED') return;
			const prior = await tx.crmAdmission.findUnique({
				where: { intentId: intent.id }
			});
			if (prior) {
				if (
					prior.sourceAcceptanceId !== proof.id ||
					prior.subject !== proof.subject ||
					prior.membershipId !== proof.membershipId
				)
					throw new Error('ADMISSION_PROOF_CONFLICT');
				return;
			}
			const [existing, waiting] = await Promise.all([
				tx.crmWorkspaceMember.findUnique({
					where: {
						workspaceId_subject: {
							workspaceId: event.workspaceId,
							subject: proof.subject
						}
					}
				}),
				tx.crmAdmission.findFirst({
					where: {
						workspaceId: event.workspaceId,
						subject: proof.subject,
						status: 'WAITING'
					}
				})
			]);
			const admission = await tx.crmAdmission.create({
				data: {
					workspaceId: event.workspaceId,
					intentId: intent.id,
					sourceAcceptanceId: proof.id,
					subject: proof.subject,
					membershipId: proof.membershipId,
					requestedBySubject: current.inviterSubject,
					...(existing || waiting
						? {
								status: 'CANCELLED',
								cancellationCode: existing
									? 'ALREADY_CRM_MEMBER'
									: 'ALREADY_WAITING'
							}
						: {})
				}
			});
			await tx.crmInvitationIntent.update({
				where: { id: current.id },
				data: {
					status: 'ACCEPTED',
					identityVersion: proof.invitationVersion,
					version: { increment: 1 }
				}
			});
			if (admission.status === 'WAITING')
				await emitTeamEvent(tx, 'admission', event.workspaceId, proof.id);
			await auditTeam(
				tx,
				{
					workspaceId: event.workspaceId,
					subject: proof.subject,
					role: 'MEMBER',
					state: 'ACTIVE',
					permissions: []
				},
				proof.id,
				'INVITATION_ACCEPTED',
				intent.id,
				null,
				{ admissionId: admission.id, status: admission.status }
			);
		});
	}

	async admitNext(workspaceId: string) {
		const candidate = await this.prisma.crmAdmission.findFirst({
			where: { workspaceId, status: 'WAITING' },
			orderBy: { position: 'asc' }
		});
		if (!candidate) return;
		const intent = candidate.intentId
			? await this.prisma.crmInvitationIntent.findUnique({
					where: { id: candidate.intentId }
				})
			: null;
		if (candidate.intentId && (!intent || intent.status === 'REVOKED'))
			return this.cancel(candidate, 'INVITATION_REVOKED');

		let actor: TeamAuthority;
		try {
			actor = await this.auth.authorizeSubject(
				workspaceId,
				candidate.requestedBySubject
			);
		} catch (error) {
			if (error instanceof ForbiddenException)
				return this.cancel(candidate, 'INVITER_AUTHORITY_REVOKED');
			throw error;
		}
		if (actor.state === 'READ_ONLY') return; // Resumed by a later entitlement/admission wake, without reserving a seat.
		try {
			this.requireManager(actor, intent?.role);
		} catch (error) {
			if (error instanceof ForbiddenException)
				return this.cancel(candidate, 'INVITER_AUTHORITY_REVOKED');
			throw error;
		}
		const [billing, target] = await Promise.all([
			this.billing.get(workspaceId, getCrmAccessCorrelationId()),
			this.identity.sourceContext(
				workspaceId,
				candidate.subject,
				getCrmAccessCorrelationId()
			)
		]);
		if (
			!target.membership ||
			target.membership.membershipId !== candidate.membershipId ||
			target.membership.role !== 'MEMBER'
		)
			return this.cancel(candidate, 'MEMBERSHIP_UNAVAILABLE');
		if (intent) {
			try {
				const proof = await this.invitations.acceptance(
					intent.id,
					workspaceId
				);
				if (
					proof.id !== candidate.sourceAcceptanceId ||
					proof.subject !== candidate.subject ||
					proof.membershipId !== candidate.membershipId
				)
					throw new Error('ADMISSION_PROOF_CONFLICT');
			} catch (error) {
				if (error instanceof InvitationRejectedError)
					return this.cancel(candidate, 'INVITATION_UNAVAILABLE');
				throw error;
			}
		}
		const entitlement = billing.entitlement;
		if (!entitlement || !['ACTIVE', 'GRACE'].includes(billing.status))
			return;
		const seatLimit = entitlement.seatLimit;
		if (
			!Number.isSafeInteger(seatLimit) ||
			Number(seatLimit) < 2 ||
			Number(seatLimit) > 10000
		)
			throw new ServiceUnavailableException(
				'CRM admission seat policy is unavailable'
			);
		const writableUntil = new Date(
			entitlement.graceUntil ?? entitlement.effectiveUntil
		);
		await serializable(this.prisma, async tx => {
			await workspaceLock(tx, workspaceId);
			const first = await tx.crmAdmission.findFirst({
				where: { workspaceId, status: 'WAITING' },
				orderBy: { position: 'asc' }
			});
			if (!first || first.id !== candidate.id) return;
			const workspace = await tx.crmWorkspaceAccess.findUniqueOrThrow({
				where: { workspaceId }
			});
			if (
				workspace.billingEntitlementId !== entitlement.id ||
				workspace.lifecycle !== 'ACTIVE' ||
				writableUntil <= new Date()
			)
				return;
			if (candidate.subject === workspace.activatedBySubject)
				return this.cancelInTransaction(tx, first, 'OWNER_IMMUTABLE');
			if (actor.role !== 'OWNER') {
				const manager = await tx.crmWorkspaceMember.findUnique({
					where: {
						workspaceId_subject: { workspaceId, subject: actor.subject }
					}
				});
				if (!manager || manager.disabledAt || manager.role !== 'CRM_ADMIN')
					return this.cancelInTransaction(
						tx,
						first,
						'INVITER_AUTHORITY_REVOKED'
					);
			}
			const currentIntent = intent
				? await tx.crmInvitationIntent.findUnique({
						where: { id: intent.id }
					})
				: null;
			if (
				intent &&
				(!currentIntent || currentIntent.status !== 'ACCEPTED')
			)
				return this.cancelInTransaction(
					tx,
					first,
					'INVITATION_UNAVAILABLE'
				);
			const member = await tx.crmWorkspaceMember.findUnique({
				where: {
					workspaceId_subject: { workspaceId, subject: candidate.subject }
				},
				include: { teams: { select: { teamId: true } } }
			});
			if (intent && member)
				return this.cancelInTransaction(tx, first, 'ALREADY_CRM_MEMBER');
			if (
				!intent &&
				(!member ||
					member.id !== candidate.memberId ||
					!member.disabledAt ||
					member.version !== candidate.expectedMemberVersion ||
					member.membershipId !== candidate.membershipId)
			)
				return this.cancelInTransaction(
					tx,
					first,
					'MEMBER_VERSION_CHANGED'
				);
			const role = currentIntent?.role ?? member!.role;
			try {
				this.teams.manageRole(actor, role);
			} catch {
				return this.cancelInTransaction(
					tx,
					first,
					'INVITER_AUTHORITY_REVOKED'
				);
			}
			const teamIds =
				currentIntent?.teamIds ?? member!.teams.map(team => team.teamId);
			try {
				await this.teams.requireTeams(tx, workspaceId, teamIds);
			} catch (error) {
				if (!(error instanceof BadRequestException)) throw error;
				return this.cancelInTransaction(
					tx,
					first,
					'TEAM_ASSIGNMENTS_CHANGED'
				);
			}
			const enabled = await tx.crmWorkspaceMember.count({
				where: { workspaceId, disabledAt: null }
			});
			if (1 + enabled >= Number(seatLimit)) return;
			const activated = member
				? await tx.crmWorkspaceMember.update({
						where: { id: member.id },
						data: { disabledAt: null, version: { increment: 1 } }
					})
				: await tx.crmWorkspaceMember.create({
						data: {
							workspaceId,
							subject: candidate.subject,
							membershipId: candidate.membershipId,
							role
						}
					});
			if (!member && teamIds.length)
				await tx.crmMemberTeam.createMany({
					data: teamIds.map(teamId => ({
						workspaceId,
						memberId: activated.id,
						teamId
					}))
				});
			await tx.crmAdmission.update({
				where: { id: first.id },
				data: {
					status: 'ACTIVE',
					activatedAt: new Date(),
					memberId: activated.id
				}
			});
			await auditTeam(
				tx,
				actor,
				first.id,
				'MEMBER_ADMITTED',
				activated.id,
				{ usedSeats: 1 + enabled },
				{
					usedSeats: 2 + enabled,
					seatLimit,
					entitlementId: entitlement.id,
					policyVersion: entitlement.policyVersion,
					role,
					teamIds
				}
			);
			await emitTeamEvent(
				tx,
				'admission',
				workspaceId,
				`advance:${first.id}`
			);
		});
	}

	private requireManager(actor: TeamAuthority, role?: string) {
		if (
			!['OWNER', 'CRM_ADMIN'].includes(actor.role) ||
			actor.state === 'READ_ONLY' ||
			!actor.permissions.includes('access:manage-team')
		)
			throw new ForbiddenException(
				'Invitation manager authority is unavailable'
			);
		if (role) this.teams.manageRole(actor, role);
	}
	private matchProof(
		proof: IdentityInvitationAcceptance,
		event: AcceptedInvitationEvent
	) {
		if (
			proof.id !== event.acceptanceId ||
			proof.invitationId !== event.invitationId ||
			proof.invitationVersion !== event.invitationVersion ||
			proof.workspaceId !== event.workspaceId ||
			proof.subject !== event.subject ||
			proof.membershipId !== event.membershipId ||
			proof.acceptedAt !== event.occurredAt
		)
			throw new Error('ADMISSION_PROOF_CONFLICT');
	}
	private async cancel(candidate: CrmAdmission, code: string) {
		return serializable(this.prisma, async tx => {
			await workspaceLock(tx, candidate.workspaceId);
			await this.cancelInTransaction(tx, candidate, code);
		});
	}
	private async cancelInTransaction(
		tx: Prisma.TransactionClient,
		candidate: CrmAdmission,
		code: string
	) {
		const changed = await tx.crmAdmission.updateMany({
			where: {
				id: candidate.id,
				workspaceId: candidate.workspaceId,
				status: 'WAITING'
			},
			data: { status: 'CANCELLED', cancellationCode: code }
		});
		if (changed.count)
			await emitTeamEvent(
				tx,
				'admission',
				candidate.workspaceId,
				`advance:${candidate.id}`
			);
	}
}
