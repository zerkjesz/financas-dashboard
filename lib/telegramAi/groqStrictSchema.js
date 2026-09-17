// ============================================================================
// Fase 7.0.3, item 3 — traduz o MESMO contrato Zod (financialIntentPlanSchema.js
// — fonte única de verdade, nunca duplicada por provider, item 5 do pedido)
// pro JSON Schema estrito que o Structured Outputs da Groq exige pra
// `openai/gpt-oss-120b`/`openai/gpt-oss-20b` (auditado em
// https://console.groq.com/docs/structured-outputs, 2026-09):
//
//   - TODA propriedade de todo objeto precisa estar em `required`
//     (mesmo as opcionais no Zod — viram union com null: {"anyOf":[schema,{"type":"null"}]});
//   - TODO objeto precisa de `additionalProperties: false`;
//   - streaming/tool-use não são suportados junto (não usamos nenhum dos dois aqui).
//
// zod-to-json-schema já gera `additionalProperties:false` (zod objects são
// estritos por padrão) mas só marca como `required` os campos que o PRÓPRIO
// Zod schema exige — os `.optional()` ficam de fora do array `required`,
// que é exatamente o que o modo estrito da Groq REJEITA. strictifyForGroq()
// faz só essa correção mecânica, recursivamente, sem reescrever nenhuma
// regra de negócio (a validação de negócio continua 100% no Zod — este
// arquivo só descreve a FORMA pro provider, nunca decide o que é válido).
// ============================================================================
import { zodToJsonSchema } from "zod-to-json-schema";
import { FinancialIntentPlanSchema } from "./financialIntentPlanSchema.js";

function strictifyNode(node) {
  if (Array.isArray(node)) {
    return node.map(strictifyNode);
  }
  if (node && typeof node === "object") {
    const out = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === "$schema") continue; // metadado do gerador, Groq não usa.
      out[key] = strictifyNode(value);
    }

    if (out.type === "object" && out.properties && typeof out.properties === "object") {
      const originalRequired = new Set(Array.isArray(out.required) ? out.required : []);
      const allKeys = Object.keys(out.properties);
      for (const key of allKeys) {
        if (!originalRequired.has(key)) {
          // Campo opcional no Zod -> torna nullable em vez de ausente (é
          // assim que o modo estrito da Groq representa "opcional": union
          // com null, mas SEMPRE presente em `required`).
          out.properties[key] = { anyOf: [out.properties[key], { type: "null" }] };
        }
      }
      out.required = allKeys;
      out.additionalProperties = false;
    }

    return out;
  }
  return node;
}

// Auto-checagem estrutural — roda toda vez que o schema é construído (nunca
// silenciosamente confia que a transformação funcionou). Se algum objeto
// escapar sem additionalProperties:false ou com required incompleto, isso é
// EXATAMENTE o tipo de coisa que causaria um 400 real da Groq — falha aqui,
// em vez de descobrir isso só na hora da chamada real.
function assertStrict(node, path = "root") {
  if (Array.isArray(node)) {
    node.forEach((item, i) => assertStrict(item, `${path}[${i}]`));
    return;
  }
  if (node && typeof node === "object") {
    if (node.type === "object" && node.properties) {
      if (node.additionalProperties !== false) {
        throw new Error(`groqStrictSchema: ${path} não tem additionalProperties:false`);
      }
      const propKeys = Object.keys(node.properties).sort();
      const reqKeys = [...(node.required || [])].sort();
      if (JSON.stringify(propKeys) !== JSON.stringify(reqKeys)) {
        throw new Error(`groqStrictSchema: ${path}.required (${reqKeys.join(",")}) não bate com properties (${propKeys.join(",")})`);
      }
    }
    for (const [key, value] of Object.entries(node)) {
      assertStrict(value, `${path}.${key}`);
    }
  }
}

let cachedSchema = null;

// Exportada pra permitir teste/inspeção sem gastar uma chamada real — o
// mesmo objeto que vai dentro de response_format.json_schema.schema.
export function buildGroqStrictSchema() {
  if (cachedSchema) return cachedSchema;
  const raw = zodToJsonSchema(FinancialIntentPlanSchema, { $refStrategy: "none", target: "jsonSchema7" });
  const strict = strictifyNode(raw);
  assertStrict(strict);
  cachedSchema = strict;
  return strict;
}

export function buildGroqResponseFormat() {
  return {
    type: "json_schema",
    json_schema: {
      name: "financial_intent_plan",
      strict: true,
      schema: buildGroqStrictSchema(),
    },
  };
}
