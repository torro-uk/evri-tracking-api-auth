export class EvriError extends Error {
  constructor(code, message, { stage, status, upstreamCode } = {}) {
    super(message);
    this.name = 'EvriError';
    this.code = code;
    this.stage = stage;
    this.status = status;
    this.upstreamCode = upstreamCode;
  }
  toJSON() {
    return { error: this.code, message: this.message,
      ...(this.stage ? { stage: this.stage } : {}),
      ...(this.status !== undefined ? { status: this.status } : {}),
      ...(this.upstreamCode ? { upstreamCode: this.upstreamCode } : {}) };
  }
}

export function safeError(error) {
  if (error instanceof EvriError) return error.toJSON();
  return { error: 'INTERNAL_ERROR', message: 'Unexpected server error' };
}
