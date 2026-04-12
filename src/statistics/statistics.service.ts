import { PrismaService } from '@/prisma.service';
import { Injectable } from '@nestjs/common';
import { Role } from '@prisma/client';
import * as dayjs from 'dayjs';

@Injectable()
export class StatisticsService {
	constructor(private prisma: PrismaService) {}

	async getUserRegistrationsByMonth() {
		const currentMonth = new Date().getMonth();
		const currentYear = new Date().getFullYear();
		const startDate = new Date(currentYear - 1, currentMonth + 1, 1);
		const endDate = new Date(currentYear, currentMonth + 1, 0);
		const allMonths = this.generateMonths(startDate, endDate);

		const registrations = await this.prisma.user.groupBy({
			by: ['createdAt'],
			_count: true,
			orderBy: {
				createdAt: 'asc'
			},
			where: {
				createdAt: {
					gte: startDate,
					lte: endDate
				}
			}
		});

		const registrationMap = new Map<string, number>();

		for (const reg of registrations) {
			const month = reg.createdAt.getMonth() + 1;
			const year = reg.createdAt.getFullYear();
			const key = `${year}-${month}`;
			registrationMap.set(
				key,
				(registrationMap.get(key) ?? 0) + reg._count
			);
		}

		return allMonths.map(({ month, year }) => {
			const key = `${year}-${month}`;
			const monthName = dayjs(new Date(year, month - 1)).format('MMMM');
			return {
				month: monthName,
				year,
				count: registrationMap.get(key) || 0
			};
		});
	}

	async getOverview() {
		const monthAgo = new Date(
			new Date().setDate(new Date().getDate() - 30)
		);
		const [
			totalUsers,
			activeUsers30d,
			newUsers30d,
			pendingEmailRegistrations,
			premiumUsers,
			adminUsers,
			managerUsers
		] = await Promise.all([
			this.prisma.user.count(),
			this.prisma.user.count({
				where: {
					updatedAt: { gte: monthAgo }
				}
			}),
			this.prisma.user.count({
				where: {
					createdAt: { gte: monthAgo }
				}
			}),
			this.prisma.pendingEmailRegistration.count(),
			this.prisma.user.count({
				where: {
					rights: { has: Role.PREMIUM }
				}
			}),
			this.prisma.user.count({
				where: {
					rights: { has: Role.ADMIN }
				}
			}),
			this.prisma.user.count({
				where: {
					rights: { has: Role.MANAGER }
				}
			})
		]);

		return {
			totalUsers,
			activeUsers30d,
			newUsers30d,
			unconfirmedUsers: pendingEmailRegistrations,
			premiumUsers,
			adminUsers,
			managerUsers
		};
	}

	private generateMonths(
		start: Date,
		end: Date
	): { month: number; year: number }[] {
		const current = new Date(start);
		const endMonth = new Date(end);
		const months = [];

		while (current < endMonth) {
			months.push({
				month: current.getMonth() + 1,
				year: current.getFullYear()
			});
			current.setMonth(current.getMonth() + 1);
		}

		months.push({
			month: endMonth.getMonth() + 1,
			year: endMonth.getFullYear()
		});

		return months;
	}
}
