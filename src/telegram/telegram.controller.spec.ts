import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { TelegramController } from './telegram.controller';
import { TelegramService } from './telegram.service';

describe('TelegramController', () => {
  let controller: TelegramController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [TelegramController],
      providers: [
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: TelegramService, useValue: { handleUpdate: jest.fn() } },
      ],
    }).compile();

    controller = module.get<TelegramController>(TelegramController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
