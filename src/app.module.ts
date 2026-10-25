import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { DatabaseModule } from './infrastructure/database/database.module';
import { HealthController } from './interfaces/http/health.controller';
import { HttpErrorFilter } from './interfaces/http/http-error.filter';
import { WageringModule } from './wagering.module';

@Module({
  imports: [DatabaseModule, WageringModule],
  controllers: [HealthController],
  providers: [{ provide: APP_FILTER, useClass: HttpErrorFilter }],
})
export class AppModule {}
