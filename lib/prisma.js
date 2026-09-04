import { PrismaClient } from "@prisma/client";
import { PrismaNeon } from "@prisma/adapter-neon";

// Driver adapter (em vez do motor binário clássico do Prisma) — usa o driver
// serverless nativo da Neon direto. Evita carregar o binário Rust do query engine
// a cada cold start da function na Vercel, que é o principal custo de latência
// num app com pouco tráfego (a function "esfria" entre acessos).
const globalForPrisma = globalThis;

function createPrismaClient() {
  const adapter = new PrismaNeon({ connectionString: process.env.DATABASE_URL });
  return new PrismaClient({ adapter });
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
