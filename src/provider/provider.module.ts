import { Module } from '@nestjs/common';
import { ProviderClient } from './provider-client.js';

@Module({
  providers: [ProviderClient],
  exports: [ProviderClient],
})
export class ProviderModule {}
