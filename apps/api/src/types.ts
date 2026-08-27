export interface ApiDatabase {
  exec(sql: string): Promise<unknown>;
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface SessionIdentity {
  sessionId: string;
  tokenHash: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    accessSession?: SessionIdentity;
  }
}
