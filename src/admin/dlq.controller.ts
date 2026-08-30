import {
  BadRequestException,
  Controller,
  Get,
  InternalServerErrorException,
  NotFoundException,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { DlqRepository } from './dlq.repository.js';

@Controller('admin/dlq')
export class DlqController {
  constructor(private readonly dlqRepository: DlqRepository) {}

  @Get()
  async list(
    @Query('limit') limitParam?: string,
    @Query('offset') offsetParam?: string,
  ) {
    const limit = limitParam !== undefined ? parseInt(limitParam, 10) : 50;
    const offset = offsetParam !== undefined ? parseInt(offsetParam, 10) : 0;

    if (!Number.isFinite(limit) || limit < 1 || limit > 100) {
      throw new BadRequestException('limit must be between 1 and 100');
    }
    if (!Number.isFinite(offset) || offset < 0) {
      throw new BadRequestException('offset must be >= 0');
    }

    const { items, total } = await this.dlqRepository.list(limit, offset);

    return {
      items,
      total,
      limit,
      offset,
    };
  }

  @Post(':id/replay')
  async replay(
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!/^\d+$/.test(id)) {
      throw new BadRequestException('id must contain only digits');
    }

    let result;
    try {
      result = await this.dlqRepository.replay(id);
    } catch {
      throw new InternalServerErrorException('Database error during replay');
    }

    if (result === null || result === undefined) {
      throw new NotFoundException(`Event ${id} not found`);
    }

    if (result.result === 'REPLAYED') {
      res.status(202);
    } else {
      res.status(200);
    }

    return result;
  }
}
