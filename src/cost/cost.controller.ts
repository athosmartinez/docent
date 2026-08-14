import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  Query,
} from '@nestjs/common';

import type { CostReport } from './cost.repository';
import { CostRepository } from './cost.repository';
import { costsQuerySchema, type CostsQuery } from './dto/costs-query.dto';

export interface CostsResponse extends CostReport {
  /** ISO 8601, or null when the window is unbounded on that side. */
  from: string | null;
  to: string | null;
}

@Controller()
export class CostController {
  // See IngestionService's constructor for why this is explicitly
  // @Inject()-ed instead of left to implicit type-based resolution.
  constructor(
    @Inject(CostRepository) private readonly repository: CostRepository,
  ) {}

  @Get('costs')
  async costs(@Query() query: unknown): Promise<CostsResponse> {
    const { from, to } = this.parse(query);
    const report = await this.repository.report(from, to);

    return {
      from: from?.toISOString() ?? null,
      to: to?.toISOString() ?? null,
      ...report,
    };
  }

  private parse(query: unknown): CostsQuery {
    const parsed = costsQuerySchema.safeParse(query);

    if (!parsed.success) {
      throw new BadRequestException(
        parsed.error.issues.map(
          (issue) => `${issue.path.join('.')}: ${issue.message}`,
        ),
      );
    }

    return parsed.data;
  }
}
