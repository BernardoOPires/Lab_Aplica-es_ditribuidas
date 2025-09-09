// errors/grpc.js
const grpc = require('@grpc/grpc-js');

class GrpcAppError extends Error {
  constructor(code, message, meta = null) {
    super(message);
    this.code = code;
    this.details = message;
    if (meta) {
      const md = new grpc.Metadata();
      md.add('app-error', JSON.stringify(meta));
      this.metadata = md;
    }
  }

  static invalidArgument(msg, meta) {
    return new GrpcAppError(grpc.status.INVALID_ARGUMENT, msg, meta);
  }
  static unauthenticated(msg = 'Token inválido') {
    return new GrpcAppError(grpc.status.UNAUTHENTICATED, msg);
  }
  static notFound(msg = 'Recurso não encontrado', meta) {
    return new GrpcAppError(grpc.status.NOT_FOUND, msg, meta);
  }
  static alreadyExists(msg = 'Já existe', meta) {
    return new GrpcAppError(grpc.status.ALREADY_EXISTS, msg, meta);
  }
  static permissionDenied(msg = 'Acesso negado', meta) {
    return new GrpcAppError(grpc.status.PERMISSION_DENIED, msg, meta);
  }
  static internal(msg = 'Erro interno', meta) {
    return new GrpcAppError(grpc.status.INTERNAL, msg, meta);
  }
}

function toServiceError(err) {
  if (err instanceof GrpcAppError) return err;
  const e = new Error(err?.message || 'Erro interno');
  e.code = grpc.status.INTERNAL;
  return e;
}

module.exports = { GrpcAppError, toServiceError };
