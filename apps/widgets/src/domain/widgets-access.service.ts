import {
	ForbiddenException,
	Injectable,
	NotFoundException
} from '@nestjs/common';
import { OwnerStatus, Prisma } from '@prisma/widgets-client';
import {
	WidgetsDomainClient,
	WidgetsDomainRepository
} from './widgets-domain.repository';
import type { WidgetEntity } from './widgets-domain.types';
import { WidgetType } from './widgets-domain.types';

@Injectable()
export class WidgetsAccessService {
	constructor(private readonly repository: WidgetsDomainRepository) {}

	async owned(
		type: WidgetType,
		widgetId: string,
		userId: string,
		client: WidgetsDomainClient = this.repository.client()
	): Promise<WidgetEntity> {
		const widget = await this.require(type, widgetId, client);
		if (widget.userId !== userId) {
			throw new ForbiddenException('Нет доступа');
		}
		return widget;
	}

	async require(
		type: WidgetType,
		widgetId: string,
		client: WidgetsDomainClient = this.repository.client()
	): Promise<WidgetEntity> {
		const widget = await this.repository.findById(type, widgetId, client);
		if (!widget) throw new NotFoundException('Виджет не найден');
		return widget;
	}

	async assertOwnerCanModify(
		transaction: Prisma.TransactionClient,
		userId: string,
		admin: boolean,
		activating = false
	): Promise<void> {
		const owner = await transaction.widgetOwnerProjection.findUnique({
			where: { userId }
		});
		if (
			!owner ||
			owner.status === OwnerStatus.DELETED ||
			owner.tombstoned ||
			owner.deletedAt
		) {
			throw new ForbiddenException('Операция недоступна для пользователя');
		}
		if (owner.status !== OwnerStatus.ACTIVE && (!admin || activating)) {
			throw new ForbiddenException(
				activating
					? 'Сначала активируйте владельца виджета'
					: 'Операция недоступна для пользователя'
			);
		}
	}
}
