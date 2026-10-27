import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'isPublic';

/** Marca uma rota (ou controller) como aberta: o AuthGuard não exige credenciais. */
export const Public = () => SetMetadata(IS_PUBLIC, true);
