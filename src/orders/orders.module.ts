import { Module } from '@nestjs/common';
import { OrdersController } from './orders.controller.js';
import { OrdersRepository } from './orders.repository.js';

@Module({
  controllers: [OrdersController],
  providers: [OrdersRepository],
})
export class OrdersModule {}
