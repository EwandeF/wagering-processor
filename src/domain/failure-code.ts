export enum FailureCode {
  // REJECTED: violação de regra de negócio
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  ReversalWouldOverdraw = 'REVERSAL_WOULD_OVERDRAW',
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  InvalidReferenceKind = 'INVALID_REFERENCE_KIND',
  AlreadyReversed = 'ALREADY_REVERSED',
  ReversalAmountMismatch = 'REVERSAL_AMOUNT_MISMATCH',
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  // FAILED: erro permanente de infraestrutura
  ProcessingFailed = 'PROCESSING_FAILED',
}

/** O que o provedor deve fazer ao receber o código. */
export enum ProviderAction {
  /** Pode reenviar depois, com uma nova transação; a situação pode mudar. */
  RetryLater = 'RETRY_LATER',
  /** O payload está inconsistente; corrigir antes de reenviar. */
  FixPayload = 'FIX_PAYLOAD',
  /** Não adianta reenviar; a operação não pode ser aplicada. */
  GiveUp = 'GIVE_UP',
  /** Problema do nosso lado; contatar o suporte, com o id da transação. */
  ContactSupport = 'CONTACT_SUPPORT',
}

export const FAILURE_GUIDANCE: Readonly<Record<FailureCode, ProviderAction>> = {
  [FailureCode.InsufficientFunds]: ProviderAction.RetryLater,
  [FailureCode.ReversalWouldOverdraw]: ProviderAction.RetryLater,
  [FailureCode.ReferenceNotFound]: ProviderAction.FixPayload,
  [FailureCode.ReferenceMismatch]: ProviderAction.FixPayload,
  [FailureCode.ReferenceNotProcessed]: ProviderAction.GiveUp,
  [FailureCode.InvalidReferenceKind]: ProviderAction.FixPayload,
  [FailureCode.AlreadyReversed]: ProviderAction.GiveUp,
  [FailureCode.ReversalAmountMismatch]: ProviderAction.FixPayload,
  [FailureCode.CurrencyMismatch]: ProviderAction.FixPayload,
  [FailureCode.ProcessingFailed]: ProviderAction.ContactSupport,
};
