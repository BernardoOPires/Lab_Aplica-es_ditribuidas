const grpc = require('@grpc/grpc-js');
const jwt = require('jsonwebtoken');

function authInterceptor({ secret, publicMethods = [] } = {}) {
  const jwtSecret = secret || process.env.JWT_SECRET || 'secret';
  const open = new Set(publicMethods);

  // *** ASSINATURA CORRETA PARA INTERCEPTOR DE SERVIDOR ***
  return (call, methodDefinition, next) => {
    const path = methodDefinition.path || '';

    // Rotas públicas não exigem token
    if (open.has(path)) {
      return next(call);
    }

    // 1) tentar pegar do metadata: "authorization: Bearer <token>"
    let token;
    const md = call.metadata;
    if (md) {
      const values = md.get('authorization');
      if (values && values.length) {
        const raw = String(values[0]);
        token = raw.startsWith('Bearer ') ? raw.slice(7) : raw;
      }
    }

    // 2) fallback: aceitar token no body (call.request.token) para compatibilidade
    if (!token && call.request && call.request.token) {
      token = call.request.token;
    }

    if (!token) {
      return call.sendStatus({
        code: grpc.status.UNAUTHENTICATED,
        details: 'Token de autenticação ausente'
      });
    }

    try {
      const payload = jwt.verify(token, jwtSecret);
      // Deixe o usuário disponível para os handlers
      call.user = payload;
      return next(call);
    } catch {
      return call.sendStatus({
        code: grpc.status.UNAUTHENTICATED,
        details: 'Token inválido ou expirado'
      });
    }
  };
}

module.exports = authInterceptor;
