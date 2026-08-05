import { GoneException, Injectable } from '@nestjs/common';
import { Request, Response } from 'express';

const RETIRED_SNAPSHOT_MESSAGE =
	'Core Reporting projection snapshot was retired after Widgets ownership handoff';

/**
 * This endpoint was the one-time source snapshot used to bootstrap Reporting.
 * It cannot represent a transactionally consistent global snapshot after the
 * widget and lead streams moved to the Widgets database. Keeping a Core-only
 * success response with frozen widget/lead watermarks would be unsafe, so the
 * legacy endpoint now fails closed before touching any source table.
 */
@Injectable()
export class ReportingProjectionSnapshotService {
	async stream(request: Request, response: Response): Promise<never> {
		void request;
		void response;
		return this.retired();
	}

	retired(): never {
		throw new GoneException(RETIRED_SNAPSHOT_MESSAGE);
	}
}
